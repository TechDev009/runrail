import type { NativeMessage, NativeModelPort, NativeModelRequest } from "@nifrajs/coding-agent"
import { mayContinue } from "../harness/event-text.ts"
import type { TranscriptRecord } from "../transcript/index.ts"

/**
 * Earlier turns of a thread for a model that starts without them. The native loop keeps its
 * conversation in memory only, so after a restart, a backend switch, or an import the model
 * would otherwise see just the new prompt. The history is rebuilt from the local transcript (the
 * record of the conversation, never the evidence journal), kept in memory, bounded, and never
 * written anywhere.
 */
export interface ModelHistoryOptions {
  readonly maxMessages?: number
  readonly maxChars?: number
  readonly maxMessageChars?: number
}

const DEFAULT_MAX_MESSAGES = 200
const DEFAULT_MAX_CHARS = 120_000
const DEFAULT_MAX_MESSAGE_CHARS = 8_000
/** What the model said before a call, kept with the call. */
const MAX_SPOKEN_CHARS = 2_000
const MAX_INPUT_STRING_CHARS = 4_000
const MAX_OPEN_CALLS = 256
export const MODEL_HISTORY_HEADER = "[Earlier conversation in this thread]"

export class ModelHistory {
  #sessionId: string | undefined
  #messages: readonly NativeMessage[] = Object.freeze([])

  /** Messages to place before the live conversation of `sessionId`; empty for other sessions. */
  for(sessionId: string): readonly NativeMessage[] {
    return sessionId === this.#sessionId ? this.#messages : Object.freeze([])
  }

  get size(): number {
    return this.#messages.length
  }

  set(sessionId: string, messages: readonly NativeMessage[]): void {
    this.#sessionId = sessionId
    this.#messages = Object.freeze([...messages])
  }

  clear(): void {
    this.#sessionId = undefined
    this.#messages = Object.freeze([])
  }
}

/** Prepends the thread's earlier turns to every request of the session they belong to. */
export function createHistoryModelPort(inner: NativeModelPort, history: ModelHistory): NativeModelPort & { takeUsage(): unknown } {
  return {
    complete(request: NativeModelRequest) {
      const earlier = history.for(request.sessionId)
      if (earlier.length === 0) return inner.complete(request)
      return inner.complete({ ...request, messages: Object.freeze([...earlier, ...request.messages]) })
    },
    takeUsage(): unknown {
      const source = inner as { takeUsage?: unknown }
      return typeof source.takeUsage === "function" ? (source.takeUsage as () => unknown).call(inner) : undefined
    },
  }
}

/**
 * Turns transcript records back into the conversation: the user's messages, the model's answers,
 * and each tool call with its result. A tool result carries the call that produced it (`call`), so a
 * provider port replays the pair in its own wire shape. Long texts, results, and call arguments are
 * clipped; the newest messages are kept when the bounds are reached.
 */
export function historyFromTranscript(records: readonly TranscriptRecord[], options: ModelHistoryOptions = {}): readonly NativeMessage[] {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS
  const all: NativeMessage[] = []
  const started = new Map<string, { readonly name: string; readonly input: unknown; readonly text: string }>()
  let spoken = ""
  // A reply past one event's text was recorded as consecutive messages; the model said it as one.
  let continuing = false
  const push = (message: NativeMessage): void => {
    const last = all[all.length - 1]
    // Two user messages in a row (a message sent while nothing answered) read as one.
    // Bounded again as one message, keeping the newest words: many unanswered turns must not add up past every limit.
    if (message.role === "user" && last !== undefined && last.role === "user") all[all.length - 1] = { role: "user", text: clipKeepingEnd(`${last.text}\n\n${message.text}`, maxMessageChars) }
    else all.push(message)
  }
  for (const record of records) {
    if (record.kind === "message.user") {
      const text = userText(record.payload)
      if (text !== undefined) push({ role: "user", text: clip(text, maxMessageChars) })
      spoken = ""
      continue
    }
    const event = eventOf(record)
    if (event === undefined) continue
    const continues = continuing
    continuing = false
    if (event.type === "assistant.delta" && typeof event.text === "string") {
      if (spoken.length < MAX_SPOKEN_CHARS) spoken += event.text
    } else if (event.type === "assistant.message" && typeof event.text === "string") {
      spoken = ""
      const last = all[all.length - 1]
      if (continues && last !== undefined && last.role === "assistant") all[all.length - 1] = { role: "assistant", text: clip(`${last.text}${event.text}`, maxMessageChars) }
      else if (event.text.trim().length > 0) push({ role: "assistant", text: clip(event.text, maxMessageChars) })
      continuing = mayContinue(event.text)
    } else if (event.type === "tool.started" && typeof event.callId === "string" && typeof event.name === "string") {
      if (started.size < MAX_OPEN_CALLS) started.set(event.callId, { name: event.name, input: clipInput(event.input), text: clip(spoken.trim(), MAX_SPOKEN_CHARS) })
      spoken = ""
    } else if (event.type === "tool.completed" && typeof event.callId === "string" && typeof event.name === "string") {
      const call = started.get(event.callId)
      started.delete(event.callId)
      const text = clip(toolOutput(event), maxMessageChars)
      push(call === undefined || call.name !== event.name
        ? { role: "tool", name: event.name, text }
        : ({ role: "tool", name: event.name, text, call: { input: call.input, ...(call.text.length === 0 ? {} : { text: call.text }) } } as NativeMessage))
    }
  }
  const messages: NativeMessage[] = []
  let total = 0
  for (let index = all.length - 1; index >= 0 && messages.length < maxMessages; index -= 1) {
    const message = all[index]!
    const size = message.text.length + callSize(message)
    if (total + size > maxChars) break
    total += size
    messages.push(message)
  }
  if (messages.length === 0) return Object.freeze([])
  messages.reverse()
  // A leading user message marks where restored history ends and keeps the first role a user.
  const first = messages[0]
  if (first !== undefined && first.role === "user") messages[0] = { role: "user", text: `${MODEL_HISTORY_HEADER}\n${first.text}` }
  else messages.unshift({ role: "user", text: MODEL_HISTORY_HEADER })
  return Object.freeze(messages.map((message) => Object.freeze(message)))
}

/** What the model saw from a tool: its output, or the code and message of its failure. */
function toolOutput(event: Record<string, unknown>): string {
  if (event.ok !== false) return typeof event.output === "string" ? event.output : event.output === undefined ? "" : safeJson(event.output)
  const error = event.error
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const { code, message } = error as { readonly code?: unknown; readonly message?: unknown }
    return [typeof code === "string" ? code : undefined, typeof message === "string" ? message : undefined].filter((part) => part !== undefined).join(": ") || "tool failed"
  }
  return "tool failed"
}

function callSize(message: NativeMessage): number {
  const call = (message as { readonly call?: { readonly input?: unknown; readonly text?: string } }).call
  return call === undefined ? 0 : safeJson(call.input ?? {}).length + (call.text?.length ?? 0)
}

/** Call arguments with long strings clipped, so a restored call cannot outweigh its conversation. */
function clipInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clip(value, MAX_INPUT_STRING_CHARS)
  if (value === null || typeof value !== "object") return value
  if (depth >= 8) return Array.isArray(value) ? [] : {}
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => clipInput(item, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key, clipInput(item, depth + 1)]))
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function userText(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload.trim().length === 0 ? undefined : payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const text = (payload as { text?: unknown }).text
  return typeof text === "string" && text.trim().length > 0 ? text : undefined
}

function eventOf(record: TranscriptRecord): Record<string, unknown> | undefined {
  const payload = record.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const event = payload as Record<string, unknown>
  return event.type === record.kind ? event : undefined
}

function clipKeepingEnd(value: string, max: number): string {
  if (value.length <= max) return value
  let start = value.length - max
  const code = value.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return `[...]\n${value.slice(start)}`
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${value.slice(0, end)}\n[...]`
}
