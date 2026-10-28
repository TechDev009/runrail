import { lstat } from "node:fs/promises"
import { readBoundedText } from "@nifrajs/coding-agent"
import type { NativeTool } from "@nifrajs/coding-agent"
import { BackgroundCommandError, type NativeBackgroundCommands } from "../background/native-commands.ts"
import { terminateProcessTree } from "../backend/process-tree.ts"
import type { WorkspacePolicy } from "../workspace/policy.ts"
import { DEFAULT_MAX_TOOL_OUTPUT_BYTES, filteredEnvironment } from "../workspace/policy.ts"

export interface RunCommandInput {
  readonly program: string
  readonly args?: readonly string[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly background?: boolean
  /** A folder inside the workspace or a related folder; the workspace root when absent. */
  readonly cwd?: string
}

/** With `background`, the tool can also start a command that outlives the call, such as a dev server. */
export function createRunCommandTool(policy: WorkspacePolicy, background?: NativeBackgroundCommands): NativeTool {
  return {
    name: "run_command",
    description: background === undefined
      ? "Run one explicit-argv local process in the workspace with bounded output."
      : "Run one explicit-argv local process in the workspace with bounded output, or start it in the background (dev servers, watchers) and get its id.",
    capabilities: ["process.exec"],
    requiresApproval: true,
    execute: async (input, context) => {
      const parsed = parseRunCommandInput(input)
      if (parsed.background !== true) return runCommand(policy, parsed, context.signal)
      if (background === undefined) throw new TypeError("background commands are not available in this session")
      if (parsed.cwd !== undefined) throw new TypeError("a background command runs in the working folder; leave out cwd")
      return startInBackground(background, parsed)
    },
  }
}

/** Reads what a background command printed. */
export function createCommandOutputTool(background: NativeBackgroundCommands): NativeTool {
  return {
    name: "command_output",
    description: "Read the output of a background command started with run_command, and whether it is still running.",
    capabilities: ["process.exec"],
    requiresApproval: false,
    execute: async (input) => {
      const value = commandInput(input, "command_output")
      const afterSeq = value.afterSeq === undefined ? 0 : bounded(value.afterSeq, 0, Number.MAX_SAFE_INTEGER, "afterSeq")
      return background.output(value.id, afterSeq)
    },
  }
}

/** Ends a background command and its child processes. */
export function createCommandStopTool(background: NativeBackgroundCommands): NativeTool {
  return {
    name: "command_stop",
    description: "Stop a background command started with run_command, with every process it started.",
    capabilities: ["process.exec"],
    requiresApproval: false,
    execute: async (input) => {
      const { id } = commandInput(input, "command_stop")
      await background.stop(id)
      return background.output(id, Number.MAX_SAFE_INTEGER)
    },
  }
}

function commandInput(input: unknown, tool: string): { readonly id: string; readonly afterSeq?: unknown } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${tool} input is invalid`)
  const value = input as { id?: unknown; afterSeq?: unknown }
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64) throw new TypeError(`${tool} needs the id run_command returned`)
  return { id: value.id, ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq }) }
}

function startInBackground(background: NativeBackgroundCommands, input: RunCommandInput) {
  try {
    const { id } = background.start(input.program, input.args ?? [], [input.program, ...(input.args ?? [])].join(" "))
    return { ok: true, background: true, id, program: input.program, args: Object.freeze([...(input.args ?? [])]), note: "Running in the background. Read it with command_output and end it with command_stop." }
  } catch (error) {
    if (error instanceof BackgroundCommandError) return { ok: false, background: true, error: error.code, message: error.message }
    throw error
  }
}

async function runCommand(
  policy: WorkspacePolicy,
  input: RunCommandInput,
  signal: AbortSignal,
): Promise<{
  readonly ok: boolean
  readonly status: number
  readonly program: string
  readonly args: readonly string[]
  readonly stdout?: string
  readonly stderr?: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly cancelled: boolean
}> {
  if (signal.aborted) throw new Error("run_command cancelled before start")
  // Its own process group, so a timeout or cancel ends every process it started, not just this one.
  const cwd = input.cwd === undefined ? policy.root : await commandFolder(policy, input.cwd)
  const child = Bun.spawn([input.program, ...(input.args ?? [])], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: filteredEnvironment(),
    detached: true,
  })
  let timedOut = false
  let cancelled = false
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => (stopping ??= terminateProcessTree(child))
  const timer = setTimeout(() => {
    timedOut = true
    void stop()
  }, input.timeoutMs ?? 120_000)
  const abort = (): void => {
    cancelled = true
    void stop()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    const perStream = Math.max(1, Math.floor((input.maxOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES) / 2))
    const reading = Promise.all([readBoundedText(child.stdout, perStream), readBoundedText(child.stderr, perStream)])
    const status = await child.exited
    // A helper the command left behind can hold its output open; it ends with the command.
    if (!(await Promise.race([reading.then(() => true), delay(OUTPUT_DRAIN_MS).then(() => false)]))) await stop()
    const [stdout, stderr] = await reading
    const output = `${stdout.text}${stderr.text}`
    // `ok` and `status` lead: the backend reads them from the head of the result text, which the loop may cut short.
    return {
      ok: !timedOut && !cancelled && status === 0,
      status,
      program: input.program,
      args: Object.freeze([...(input.args ?? [])]),
      ...(stdout.text.length === 0 ? {} : { stdout: stdout.text }),
      ...(stderr.text.length === 0 ? {} : { stderr: stderr.text }),
      truncated: stdout.truncated || stderr.truncated || output.length > (input.maxOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES),
      timedOut,
      cancelled,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

const OUTPUT_DRAIN_MS = 1_000
const RUN_COMMAND_KEYS: ReadonlySet<string> = new Set(["program", "args", "timeoutMs", "maxOutputBytes", "background", "cwd"])

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRunCommandInput(input: unknown): RunCommandInput {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("run_command input is invalid")
  // Approval rules read the input by its keys; a key the tool ignores must not be able to rename the call.
  const unknown = Object.keys(input).find((key) => !RUN_COMMAND_KEYS.has(key))
  if (unknown !== undefined) throw new TypeError(`run_command input has an unknown field: ${unknown.slice(0, 64)}`)
  const value = input as { program?: unknown; args?: unknown; timeoutMs?: unknown; maxOutputBytes?: unknown; background?: unknown; cwd?: unknown }
  if (
    typeof value.program !== "string" ||
    value.program.length === 0 ||
    value.program.length > 256 ||
    /\s/.test(value.program) ||
    value.program.startsWith("-")
  )
    throw new TypeError("run_command program must be one executable token")
  const args = value.args === undefined ? [] : value.args
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.length > 4_096) ||
    args.join("\0").length > 32 * 1024
  )
    throw new TypeError("run_command args are invalid")
  if (value.background !== undefined && typeof value.background !== "boolean") throw new TypeError("run_command background must be true or false")
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0 || value.cwd.length > 4_096)) throw new TypeError("run_command cwd is invalid")
  const timeoutMs = bounded(value.timeoutMs ?? 120_000, 1, 120_000, "timeoutMs")
  const maxOutputBytes = bounded(
    value.maxOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES,
    1,
    DEFAULT_MAX_TOOL_OUTPUT_BYTES,
    "maxOutputBytes",
  )
  return {
    program: value.program,
    args: Object.freeze([...args] as string[]),
    timeoutMs,
    maxOutputBytes,
    ...(value.background === true ? { background: true } : {}),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }),
  }
}

function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max}`)
  return value
}

/** A folder the policy reaches: inside the workspace, or inside a related folder by absolute path. */
async function commandFolder(policy: WorkspacePolicy, input: string): Promise<string> {
  const folder = input === "." ? policy.root : await policy.resolveExisting(input)
  if (!(await lstat(folder)).isDirectory()) throw new TypeError("run_command cwd is not a folder")
  return folder
}
