import type { NativeMessage } from "@nifrajs/coding-agent"

/**
 * The native loop keeps a tool result as `{ role: "tool", name, text }` and drops the call that
 * produced it. Hosted APIs reject a tool result that does not answer a recorded call, so each
 * provider port remembers the calls it returned and replays them in its own wire shape.
 *
 * A call is keyed by its position among the tool results of the conversation: the result of the
 * call returned for a request holding N tool results is tool result N of every later request, and
 * it sits where that request ended. A result at any other position came from a call this port
 * did not make (a rewound or restored conversation) and is not paired.
 * Memory is per port and in-process only; it never reaches a transcript or a log.
 */
export class ToolCallMemory<Call> {
  private readonly calls = new Map<number, { readonly name: string; readonly at: number; readonly call: Call }>()

  constructor(private readonly limit = 512) {}

  /** Record the call a port is about to return for `messages`. */
  remember(messages: readonly NativeMessage[], name: string, call: Call): void {
    const ordinal = messages.reduce((count, message) => (message.role === "tool" ? count + 1 : count), 0)
    this.calls.delete(ordinal)
    this.calls.set(ordinal, { name, at: messages.length, call })
    while (this.calls.size > this.limit) {
      const oldest = this.calls.keys().next()
      if (oldest.done === true) break
      this.calls.delete(oldest.value)
    }
  }

  /** The call behind tool result `ordinal` at message `index`, when this port returned it and the tool name agrees. */
  recall(ordinal: number, name: string, index: number): Call | undefined {
    const entry = this.calls.get(ordinal)
    return entry !== undefined && entry.name === name && entry.at === index ? entry.call : undefined
  }
}

/** A tool result whose call is not remembered (new port, restored history) is sent as plain text. */
export function toolResultText(name: string, text: string): string {
  return `[result of tool ${name}]\n${text}`
}

// ---------------------------------------------------------------------------------------------
// Calls restored from the local transcript

/**
 * A tool result rebuilt from the local transcript (after a restart, a model change, or an import)
 * carries the call that produced it, so a port can replay the pair in its own wire shape instead of
 * flattening it to text. `text` is what the model said before the call.
 */
export interface RestoredToolCall {
  readonly input: unknown
  readonly text?: string
}

export type RestoredToolMessage = NativeMessage & { readonly role: "tool"; readonly call: RestoredToolCall }

export function restoredToolCall(message: NativeMessage): RestoredToolCall | undefined {
  const call = (message as { readonly call?: unknown }).call
  if (message.role !== "tool" || call === null || typeof call !== "object" || Array.isArray(call) || !("input" in call)) return undefined
  const text = (call as { readonly text?: unknown }).text
  return { input: (call as { readonly input: unknown }).input, ...(typeof text === "string" && text.length > 0 ? { text } : {}) }
}

// ---------------------------------------------------------------------------------------------
// Keeping a long conversation inside the model's window

/** What replaces a tool result that was shortened. The call stays, so the model still sees what it did. */
export const SHORTENED_TOOL_RESULT = "[This tool result was removed to keep the conversation within the model's context. Run the tool again if it is needed.]"
const SHORTENED_TEXT_CHARS = 2_000
const SHORTENED_STRING_CHARS = 400
/** The newest messages are never shortened: they are what the model is working on. */
const KEEP_RECENT_MESSAGES = 6

export interface ConversationEntry {
  readonly role: NativeMessage["role"]
  /** Characters this message costs when sent in full: its text plus the arguments of its call. */
  readonly chars: number
}

/**
 * Decides how much of the oldest conversation is sent shortened. Everything before the returned
 * index is: tool results replaced by a note, call arguments and old text clipped. The index only
 * moves forward and moves in large steps, so the start of the request stays the same from one
 * request to the next and a provider's prompt cache keeps matching.
 */
export class ConversationWindow {
  private readonly boundaries = new Map<string, number>()

  constructor(private readonly maxChars: number) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1_000) throw new RangeError("conversation window is invalid")
  }

  boundary(sessionId: string, entries: readonly ConversationEntry[]): number {
    const limit = Math.max(0, entries.length - KEEP_RECENT_MESSAGES)
    let boundary = Math.min(this.boundaries.get(sessionId) ?? 0, limit)
    let total = 0
    for (const [index, entry] of entries.entries()) total += index < boundary ? shortenedChars(entry) : entry.chars
    if (total > this.maxChars) {
      // Well under the limit, so the next several requests fit without moving the boundary again.
      const target = Math.floor(this.maxChars * 0.6)
      while (boundary < limit && total > target) {
        const entry = entries[boundary]!
        total -= entry.chars - shortenedChars(entry)
        boundary += 1
      }
    }
    if (this.boundaries.size >= 64 && !this.boundaries.has(sessionId)) this.boundaries.delete(this.boundaries.keys().next().value as string)
    this.boundaries.set(sessionId, boundary)
    return boundary
  }
}

function shortenedChars(entry: ConversationEntry): number {
  return entry.role === "tool" ? Math.min(entry.chars, SHORTENED_TOOL_RESULT.length + SHORTENED_STRING_CHARS) : Math.min(entry.chars, SHORTENED_TEXT_CHARS)
}

/** Characters of conversation a model with `contextTokens` takes, leaving room for instructions, tools, and the answer. */
export function conversationChars(contextTokens: number | undefined): number {
  const tokens = contextTokens === undefined || !Number.isSafeInteger(contextTokens) || contextTokens < 1 ? 128_000 : contextTokens
  // About three characters a token for code, and two thirds of the window for the conversation.
  return Math.max(24_000, Math.min(1_500_000, tokens * 2))
}

export function shortenText(text: string): string {
  return text.length <= SHORTENED_TEXT_CHARS ? text : `${clipString(text, SHORTENED_TEXT_CHARS)}\n[...]`
}

/** Call arguments with every long string clipped. The shape stays, so the call still reads as the call it was. */
export function shortenToolInput(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return input.length <= SHORTENED_STRING_CHARS ? input : `${clipString(input, SHORTENED_STRING_CHARS)} [...]`
  if (input === null || typeof input !== "object") return input
  if (depth >= 6) return Array.isArray(input) ? [] : {}
  if (Array.isArray(input)) return input.slice(0, 32).map((item) => shortenToolInput(item, depth + 1))
  return Object.fromEntries(Object.entries(input).slice(0, 64).map(([key, value]) => [key, shortenToolInput(value, depth + 1)]))
}

function clipString(value: string, max: number): string {
  let end = max
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}
