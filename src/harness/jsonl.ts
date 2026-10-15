import { isAgentEvent, type AgentEvent } from "@nifrajs/agent-protocol"

export interface JsonlHarnessDecoderOptions {
  readonly maxLineBytes?: number
  readonly maxEvents?: number
  readonly maxStreamBytes?: number
  readonly sessionId?: string
}

export type HarnessJsonlErrorCode = "HARNESS_JSONL_INVALID" | "HARNESS_JSONL_LIMIT" | "HARNESS_JSONL_TERMINAL"

export class HarnessJsonlError extends Error {
  constructor(readonly code: HarnessJsonlErrorCode, reason: string) {
    super(`harness JSONL: ${reason}`)
    this.name = "HarnessJsonlError"
  }
}

/** Strictly decode normalized agent protocol events from a bounded JSONL stream. */
export async function* decodeHarnessJsonl(
  source: AsyncIterable<Uint8Array | string>,
  options: JsonlHarnessDecoderOptions = {},
): AsyncGenerator<AgentEvent> {
  const maxLineBytes = bound(options.maxLineBytes ?? 256 * 1024, 1, 4 * 1024 * 1024)
  const maxEvents = bound(options.maxEvents ?? 4_096, 1, 65_536)
  const maxStreamBytes = bound(options.maxStreamBytes ?? 8 * 1024 * 1024, 1, 64 * 1024 * 1024)
  const decoder = new TextDecoder()
  let buffer = ""
  let bytes = 0
  let count = 0
  let lastSeq = -1
  let terminal = false
  for await (const chunk of source) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    bytes += Buffer.byteLength(text, "utf8")
    if (bytes > maxStreamBytes) throw new HarnessJsonlError("HARNESS_JSONL_LIMIT", "harness stream exceeds its byte limit")
    buffer += text
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      const event = parseLine(line, maxLineBytes, options.sessionId, lastSeq, terminal)
      lastSeq = event.seq
      terminal = isTerminal(event)
      count += 1
      if (count > maxEvents) throw new HarnessJsonlError("HARNESS_JSONL_LIMIT", "harness stream has too many events")
      yield event
    }
    if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) throw new HarnessJsonlError("HARNESS_JSONL_LIMIT", "harness JSONL line exceeds its byte limit")
  }
  buffer += decoder.decode()
  if (buffer.trim().length > 0) {
    const event = parseLine(buffer.trim(), maxLineBytes, options.sessionId, lastSeq, terminal)
    count += 1
    if (count > maxEvents) throw new HarnessJsonlError("HARNESS_JSONL_LIMIT", "harness stream has too many events")
    yield event
    terminal = isTerminal(event)
  }
  if (count > 0 && !terminal) throw new HarnessJsonlError("HARNESS_JSONL_TERMINAL", "harness stream has no terminal event")
}

export function parseHarnessJsonlEvent(value: unknown, options: { readonly sessionId?: string; readonly lastSeq?: number; readonly terminal?: boolean } = {}): AgentEvent {
  if (!isAgentEvent(value)) throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness event is invalid")
  if (options.sessionId !== undefined && value.sessionId !== options.sessionId) throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness event session does not match")
  if (value.seq <= (options.lastSeq ?? -1)) throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness event sequence is not increasing")
  if (options.terminal === true) throw new HarnessJsonlError("HARNESS_JSONL_TERMINAL", "harness emitted an event after terminal state")
  return value
}

/** Normalize a vendor event through a caller-supplied mapper, rejecting unknown records. */
export function mapHarnessJsonlEvent<T>(value: unknown, mapper: (value: unknown) => T): T {
  if (typeof mapper !== "function") throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness event mapper is invalid")
  try {
    return mapper(value)
  } catch (error) {
    if (error instanceof HarnessJsonlError) throw error
    throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness event is unsupported")
  }
}

export interface JsonlHarnessCommandOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly maxLineBytes?: number
  readonly maxEvents?: number
  readonly maxStreamBytes?: number
}

export function validateJsonlHarnessCommand(options: JsonlHarnessCommandOptions): void {
  if (options === null || typeof options !== "object" || typeof options.command !== "string" || options.command.length === 0 || options.command.length > 256 || /\s/.test(options.command) || options.command.startsWith("-")) throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness command is invalid")
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.length > 128 || options.args.some((arg) => typeof arg !== "string" || arg.length > 4_096))) throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness arguments are invalid")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness timeout is invalid")
}

function parseLine(line: string, maxLineBytes: number, sessionId: string | undefined, lastSeq: number, terminal: boolean): AgentEvent {
  if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new HarnessJsonlError("HARNESS_JSONL_LIMIT", "harness JSONL line exceeds its byte limit")
  let value: unknown
  try { value = JSON.parse(line) as unknown } catch { throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness JSONL is not valid JSON") }
  return parseHarnessJsonlEvent(value, { sessionId, lastSeq, terminal })
}

function isTerminal(event: AgentEvent): boolean {
  return event.type === "session.completed" || event.type === "session.failed" || event.type === "session.stopped"
}

function bound(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HarnessJsonlError("HARNESS_JSONL_INVALID", "harness limit is invalid")
  return value
}
