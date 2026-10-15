import { terminateProcessTree } from "../backend/process-tree.ts"
import { filteredEnvironment } from "../workspace/policy.ts"

/**
 * A check the person typed: one shell command run in a worktree, its process
 * tree killed on timeout or stop, its exit code, time, the end of its output, and pass and fail
 * counts when a known test runner printed them.
 */

export type CheckRunner = "bun" | "vitest" | "jest" | "pytest" | "cargo"

export interface CheckCounts {
  readonly runner: CheckRunner
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly total: number
}

export interface CheckResult {
  readonly id: string
  /** Absent when the process was killed by a signal (timeout, stop) or could not report one. */
  readonly exitCode?: number
  readonly passed: boolean
  readonly timedOut: boolean
  readonly stopped: boolean
  readonly durationMs: number
  /** The last `CHECK_TAIL_LINES` lines of stdout and stderr, in the order they arrived. */
  readonly tail: string
  /** Earlier output was left out of `tail`. */
  readonly truncated: boolean
  readonly counts?: CheckCounts
}

export interface CheckRunInput {
  readonly id: string
  readonly cwd: string
  readonly command: string
  readonly timeoutMs: number
}

export class CheckError extends Error {
  constructor(
    readonly code: "CHECK_RUNNING" | "CHECK_LIMIT" | "CHECK_NOT_FOUND" | "CHECK_START_FAILED" | "CHECK_CLOSED",
    message: string,
  ) {
    super(message)
    this.name = "CheckError"
  }
}

export const CHECK_TAIL_LINES = 200
export const CHECK_MAX_RUNNING = 8
export const CHECK_DEFAULT_TIMEOUT_MS = 10 * 60_000
export const CHECK_MAX_TIMEOUT_MS = 60 * 60_000
/** Enough of the end of the output for a runner's summary, and for cargo's one line per test binary. */
const KEPT_CHARS = 512 * 1024
const TAIL_CHARS = 64 * 1024
const STOP_GRACE_MS = 3_000

interface Running {
  readonly child: ReturnType<typeof Bun.spawn>
  stopped: boolean
  timedOut: boolean
  stopping?: Promise<void>
}

export class CheckRuns {
  readonly #running = new Map<string, Running>()
  #closed = false

  async run(input: CheckRunInput): Promise<CheckResult> {
    if (this.#closed) throw new CheckError("CHECK_CLOSED", "the engine is stopping")
    if (this.#running.has(input.id)) throw new CheckError("CHECK_RUNNING", "a check with this id is already running")
    if (this.#running.size >= CHECK_MAX_RUNNING) throw new CheckError("CHECK_LIMIT", `at most ${String(CHECK_MAX_RUNNING)} checks run at once`)
    const started = performance.now()
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn(shellCommand(input.command), { cwd: input.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: checkEnvironment(), detached: true })
    } catch {
      throw new CheckError("CHECK_START_FAILED", "the check command could not start")
    }
    const entry: Running = { child, stopped: false, timedOut: false }
    this.#running.set(input.id, entry)
    const output = new OutputTail()
    const timer = setTimeout(() => {
      entry.timedOut = true
      entry.stopping ??= terminateProcessTree(child, STOP_GRACE_MS)
    }, input.timeoutMs)
    try {
      const reads = [output.read(child.stdout as ReadableStream<Uint8Array>), output.read(child.stderr as ReadableStream<Uint8Array>)]
      const code = await child.exited.then(
        (value) => value,
        () => undefined,
      )
      clearTimeout(timer)
      // A foreground check owns its helpers too, even after its shell exited successfully.
      const drained = await Promise.race([Promise.all(reads).then(() => true), delay(1_000).then(() => false)])
      entry.stopping ??= terminateProcessTree(child, drained ? 250 : STOP_GRACE_MS)
      await entry.stopping
      await Promise.all(reads)
      const killed = entry.timedOut || entry.stopped
      const text = output.text()
      const counts = parseCheckCounts(text)
      const exitCode = killed || code === undefined || code < 0 ? undefined : code
      return {
        id: input.id,
        ...(exitCode === undefined ? {} : { exitCode }),
        passed: exitCode === 0,
        timedOut: entry.timedOut,
        stopped: entry.stopped,
        durationMs: Math.round(performance.now() - started),
        ...tailOf(text, output.dropped > 0),
        ...(counts === undefined ? {} : { counts }),
      }
    } finally {
      clearTimeout(timer)
      this.#running.delete(input.id)
    }
  }

  /** Stops a running check; its `run` call answers with `stopped: true`. */
  async stop(id: string): Promise<boolean> {
    const entry = this.#running.get(id)
    if (entry === undefined) return false
    entry.stopped = true
    entry.stopping ??= terminateProcessTree(entry.child, STOP_GRACE_MS)
    await entry.stopping
    return true
  }

  async close(): Promise<void> {
    this.#closed = true
    await Promise.all([...this.#running.keys()].map((id) => this.stop(id)))
  }
}

function shellCommand(command: string): string[] {
  return process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command]
}

/** The agent's command environment, plus the temp folder test runners write to. No credentials. */
function checkEnvironment(): Record<string, string> {
  const env = filteredEnvironment()
  if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR
  // Runners print plain counts when nothing asks for color.
  env.NO_COLOR = "1"
  return env
}

class OutputTail {
  #text = ""
  #cut = 0

  get dropped(): number {
    return this.#cut + Math.max(0, this.#text.length - KEPT_CHARS)
  }

  async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stream) this.#append(decoder.decode(chunk, { stream: true }))
      this.#append(decoder.decode())
    } catch {
      // The stream ends with the process.
    }
  }

  text(): string {
    return this.#text.length <= KEPT_CHARS ? this.#text : this.#text.slice(-KEPT_CHARS)
  }

  #append(text: string): void {
    this.#text += text
    // Trimmed only at twice the kept size, so a chatty run does not copy the whole tail per chunk.
    if (this.#text.length <= KEPT_CHARS * 2) return
    const cut = this.#text.length - KEPT_CHARS
    this.#text = this.#text.slice(cut)
    this.#cut += cut
  }
}

function tailOf(text: string, dropped: boolean): { readonly tail: string; readonly truncated: boolean } {
  const plain = stripAnsi(text).replace(/\r\n?/g, "\n").replace(/\n+$/, "")
  const lines = plain.split("\n")
  let tail = lines.slice(-CHECK_TAIL_LINES).join("\n")
  let truncated = dropped || lines.length > CHECK_TAIL_LINES
  if (tail.length > TAIL_CHARS) {
    tail = tail.slice(-TAIL_CHARS)
    truncated = true
  }
  return { tail, truncated }
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, "")
}

/** Pass and fail counts from the summary a known runner prints last; undefined for any other output. */
export function parseCheckCounts(output: string): CheckCounts | undefined {
  const text = stripAnsi(output)
  const tail = summaryTail(text)
  return cargoCounts(text) ?? pytestCounts(tail) ?? jestCounts(tail) ?? vitestCounts(tail) ?? bunCounts(text)
}

const SUMMARY_LINES = 200
const SUMMARY_LINE_CHARS = 300

/**
 * The short lines at the end of the output, where pytest, Jest, and Vitest print their summary.
 * Their patterns backtrack, so a long line from the code under test must never reach them.
 */
function summaryTail(text: string): string {
  return text.split("\n").slice(-SUMMARY_LINES).filter((line) => line.length <= SUMMARY_LINE_CHARS).join("\n")
}

function cargoCounts(text: string): CheckCounts | undefined {
  const results = [...text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)]
  if (results.length === 0) return undefined
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const result of results) {
    passed += Number(result[1])
    failed += Number(result[2])
    skipped += Number(result[3])
  }
  return { runner: "cargo", passed, failed, skipped, total: passed + failed + skipped }
}

function pytestCounts(text: string): CheckCounts | undefined {
  const lines = [...text.matchAll(/^=+ (.*\b(?:passed|failed|error|errors|skipped|no tests ran)\b.*) in [\d.]+s(?: \([^)]*\))? =+$/gm)]
  const summary = lines[lines.length - 1]?.[1]
  if (summary === undefined) return undefined
  const passed = count(summary, /(\d+) passed/)
  const failed = count(summary, /(\d+) failed/) + count(summary, /(\d+) errors?\b/)
  const skipped = count(summary, /(\d+) skipped/) + count(summary, /(\d+) xfailed/)
  return { runner: "pytest", passed, failed, skipped, total: passed + failed + skipped }
}

function jestCounts(text: string): CheckCounts | undefined {
  const lines = [...text.matchAll(/^Tests:\s+(.*\b(\d+) total)\s*$/gm)]
  const summary = lines[lines.length - 1]
  if (summary?.[1] === undefined) return undefined
  const passed = count(summary[1], /(\d+) passed/)
  const failed = count(summary[1], /(\d+) failed/)
  const total = Number(summary[2])
  return { runner: "jest", passed, failed, skipped: Math.max(0, total - passed - failed), total }
}

function vitestCounts(text: string): CheckCounts | undefined {
  const lines = [...text.matchAll(/^\s*Tests\s+(.*?)\s*\((\d+)\)\s*$/gm)]
  const summary = lines[lines.length - 1]
  if (summary?.[1] === undefined) return undefined
  const passed = count(summary[1], /(\d+) passed/)
  const failed = count(summary[1], /(\d+) failed/)
  const total = Number(summary[2])
  return { runner: "vitest", passed, failed, skipped: Math.max(0, total - passed - failed), total }
}

function bunCounts(text: string): CheckCounts | undefined {
  const ran = [...text.matchAll(/^Ran (\d+) tests? across \d+ files?\./gm)]
  const last = ran[ran.length - 1]
  if (last === undefined) return undefined
  // The counts come just before the "Ran" line that closes the run.
  const before = text.slice(0, last.index)
  const passed = lastCount(before, /^\s*(\d+) pass$/gm)
  const failed = lastCount(before, /^\s*(\d+) fail$/gm)
  const skipped = lastCount(before, /^\s*(\d+) skip$/gm) + lastCount(before, /^\s*(\d+) todo$/gm)
  return { runner: "bun", passed, failed, skipped, total: Number(last[1]) }
}

function count(text: string, pattern: RegExp): number {
  const match = pattern.exec(text)
  return match?.[1] === undefined ? 0 : Number(match[1])
}

function lastCount(text: string, pattern: RegExp): number {
  const matches = [...text.matchAll(pattern)]
  const value = matches[matches.length - 1]?.[1]
  return value === undefined ? 0 : Number(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
