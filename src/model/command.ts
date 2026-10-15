import type {
  NativeModelChunk,
  NativeModelPort,
  NativeModelRequest,
  NativeModelResponse,
} from "@nifrajs/coding-agent"
import type { ModelCapability } from "./catalog.ts"
import type { RunrailContentModelPort } from "./content.ts"
import { filteredEnvironment } from "../workspace/policy.ts"
import { terminateProcessTree } from "../backend/process-tree.ts"

export interface CommandModelOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Capabilities declared by the caller-owned model process. */
  readonly capabilities?: readonly ModelCapability[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

export type CommandModelErrorCode = "MODEL_COMMAND_INVALID" | "MODEL_COMMAND_TIMEOUT" | "MODEL_COMMAND_CANCELLED" | "MODEL_COMMAND_OUTPUT_INVALID"

export class CommandModelError extends Error {
  constructor(readonly code: CommandModelErrorCode, reason: string) {
    super(`model command: ${reason}`)
    this.name = "CommandModelError"
  }
}

/** JSONL model process adapter. The process is caller-owned and receives no credential environment. */
export class CommandModelPort implements NativeModelPort {
  private readonly options: Required<Pick<CommandModelOptions, "timeoutMs" | "maxOutputBytes">>

  constructor(private readonly commandOptions: CommandModelOptions) {
    validateCommandOptions(commandOptions)
    this.options = {
      timeoutMs: commandOptions.timeoutMs ?? 120_000,
      maxOutputBytes: commandOptions.maxOutputBytes ?? 256 * 1024,
    }
  }

  async *complete(request: NativeModelRequest): AsyncGenerator<NativeModelChunk> {
    if (request.signal.aborted) throw new CommandModelError("MODEL_COMMAND_CANCELLED", "model process was cancelled")
    // Its own process group, ended whole and escalated to SIGKILL, so a timeout or cancel cannot
    // hang on a process that ignores SIGTERM and keeps its output open.
    const child = Bun.spawn([this.commandOptions.command, ...(this.commandOptions.args ?? [])], {
      cwd: request.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: filteredEnvironment(this.commandOptions.env),
      detached: true,
    })
    let exited = false
    void child.exited.then(() => { exited = true }, () => { exited = true })
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => (stopping ??= terminateProcessTree(child))
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      void stop()
    }, this.options.timeoutMs)
    const abort = (): void => {
      cancelled = true
      void stop()
    }
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      if (request.signal.aborted) { abort(); throw new CommandModelError("MODEL_COMMAND_CANCELLED", "model process was cancelled") }
      await child.stdin.write(`${JSON.stringify(wireRequest(request))}\n`)
      child.stdin.end()
      const decoder = new TextDecoder()
      let buffer = ""
      let outputBytes = 0
      for await (const chunk of child.stdout) {
        if (request.signal.aborted) throw new CommandModelError("MODEL_COMMAND_CANCELLED", "model process was cancelled")
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
        outputBytes += Buffer.byteLength(text, "utf8")
        if (outputBytes > this.options.maxOutputBytes) {
          throw new CommandModelError("MODEL_COMMAND_OUTPUT_INVALID", "model process exceeded output bounds")
        }
        buffer += text
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          if (request.signal.aborted) throw new CommandModelError("MODEL_COMMAND_CANCELLED", "model process was cancelled")
          if (line.trim().length > 0) yield parseCommandChunk(line)
        }
      }
      buffer += decoder.decode()
      if (request.signal.aborted) throw new CommandModelError("MODEL_COMMAND_CANCELLED", "model process was cancelled")
      if (buffer.trim().length > 0) yield parseCommandChunk(buffer.trim())
      const status = await child.exited
      if (timedOut) throw new CommandModelError("MODEL_COMMAND_TIMEOUT", "model process timed out")
      if (cancelled || request.signal.aborted) throw new CommandModelError("MODEL_COMMAND_CANCELLED", "model process was cancelled")
      if (status !== 0) throw new CommandModelError("MODEL_COMMAND_OUTPUT_INVALID", "model process failed")
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener("abort", abort)
      // Invalid output, an early return by the consumer, or a limit: the process is not left running.
      if (!exited || stopping !== undefined) await stop()
    }
  }
}

/** JSONL adapter variant that receives canonical transient content parts. */
export class CommandContentModelPort implements RunrailContentModelPort {
  private readonly inner: CommandModelPort

  constructor(options: CommandModelOptions) {
    this.inner = new CommandModelPort(options)
  }

  complete(request: Parameters<RunrailContentModelPort["complete"]>[0]) {
    return this.inner.complete(request)
  }
}

export function createCommandModelPort(options: CommandModelOptions): NativeModelPort {
  return new CommandModelPort(options)
}

export function createCommandContentModelPort(options: CommandModelOptions): RunrailContentModelPort {
  return new CommandContentModelPort(options)
}

function wireRequest(request: NativeModelRequest): Omit<NativeModelRequest, "signal"> {
  const { signal: _signal, ...wire } = request
  return wire
}

function parseCommandChunk(text: string): NativeModelChunk {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CommandModelError("MODEL_COMMAND_OUTPUT_INVALID", "model output is not valid JSONL")
  }
  if (!isRecord(value) || typeof value.type !== "string")
    throw new CommandModelError("MODEL_COMMAND_OUTPUT_INVALID", "model output shape is invalid")
  if (value.type === "text_delta" && typeof value.text === "string") return { type: "text_delta", text: value.text }
  if (value.type === "response" && isModelResponse(value.response)) return { type: "response", response: value.response }
  if (value.type === "text" && typeof value.text === "string") return { type: "response", response: { type: "text", text: value.text } }
  if (value.type === "tool" && typeof value.name === "string" && "input" in value)
    return { type: "response", response: { type: "tool", name: value.name, input: value.input } }
  throw new CommandModelError("MODEL_COMMAND_OUTPUT_INVALID", "model output event is unsupported")
}

function isModelResponse(value: unknown): value is NativeModelResponse {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "text") return typeof value.text === "string"
  return value.type === "tool" && typeof value.name === "string" && "input" in value
}

function validateCommandOptions(options: CommandModelOptions): void {
  if (typeof options.command !== "string" || options.command.length === 0 || options.command.length > 256 || /\s/.test(options.command) || options.command.startsWith("-"))
    throw new CommandModelError("MODEL_COMMAND_INVALID", "command must be one executable token")
  const args = options.args ?? []
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 4_096) || args.join("\0").length > 32 * 1024)
    throw new CommandModelError("MODEL_COMMAND_INVALID", "command arguments are invalid")
  const capabilities = options.capabilities ?? ["streaming", "tools"]
  if (!Array.isArray(capabilities) || capabilities.length > 16 || capabilities.some((capability) => capability !== "streaming" && capability !== "tools" && capability !== "multimodal" && capability !== "reasoning") || new Set(capabilities).size !== capabilities.length)
    throw new CommandModelError("MODEL_COMMAND_INVALID", "model capabilities are invalid")
  bounded(options.timeoutMs ?? 120_000, 1, 120_000, "timeoutMs")
  bounded(options.maxOutputBytes ?? 256 * 1024, 1, 4 * 1024 * 1024, "maxOutputBytes")
}

function bounded(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new CommandModelError("MODEL_COMMAND_INVALID", `${name} is invalid`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
