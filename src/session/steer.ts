import type { NativeMessage, NativeModelChunk, NativeModelPort, NativeModelRequest, NativeModelResponse } from "@nifrajs/coding-agent"

/**
 * Guidance sent while a turn runs. The native loop takes no input mid-turn and cannot be changed
 * from here, so the message joins at the model port instead: the next request the loop makes
 * carries it as a user message after the latest tool results, and every later request of the
 * session keeps it in the same place. The loop's own memory never holds it, so it is placed again
 * on each request. A message that arrives after the model's last step of the turn is never taken
 * and runs as the next turn.
 */

export const MAX_STEER_CHARS = 64 * 1024
/** Messages that may wait for the next step. */
const MAX_PENDING = 16
/** Steers remembered per session, oldest dropped first. */
const MAX_PLACED = 64
const MAX_SESSIONS = 8

interface PlacedSteer {
  /** The message the steer follows; undefined for the very start. */
  readonly after: NativeMessage | undefined
  readonly text: string
}

/**
 * `toolResults` counts the tool results among the loop's messages when the steer was taken: the
 * steer follows the last of them, so a record of it belongs after that many completed calls.
 */
export type SteerDelivered = (sessionId: string, text: string, toolResults: number) => Promise<void> | void

export class SteeringModelPort implements NativeModelPort {
  #pending: string[] = []
  readonly #placed = new Map<string, PlacedSteer[]>()
  /** Called before the request that first carries a steer goes out, so the transcript records it in place. */
  onDelivered: SteerDelivered | undefined

  constructor(private readonly inner: NativeModelPort) {}

  /** Queues guidance for the next step. False when it is empty, too long, or too many are waiting. */
  push(text: string): boolean {
    if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_STEER_CHARS || text.includes("\0")) return false
    if (this.#pending.length >= MAX_PENDING) return false
    this.#pending.push(text)
    return true
  }

  /** Guidance no step has taken: what arrived after the model's last step. The caller runs it as the next turn. */
  takeUndelivered(): readonly string[] {
    const left = this.#pending
    this.#pending = []
    return Object.freeze(left)
  }

  complete(request: NativeModelRequest): NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk> {
    const taken = this.#pending
    const placed = this.#placed.get(request.sessionId)
    if (taken.length === 0 && (placed === undefined || placed.length === 0)) return this.inner.complete(request)
    this.#pending = []
    return this.#steered(request, taken)
  }

  async *#steered(request: NativeModelRequest, taken: readonly string[]): AsyncGenerator<NativeModelChunk> {
    if (taken.length > 0) {
      const placed = this.#sessionSteers(request.sessionId)
      const after = request.messages[request.messages.length - 1]
      const toolResults = request.messages.filter((message) => message.role === "tool").length
      for (const text of taken) {
        placed.push({ after, text })
        if (placed.length > MAX_PLACED) placed.shift()
        try {
          await this.onDelivered?.(request.sessionId, text, toolResults)
        } catch {
          // The model still reads it; the record of it is best-effort.
        }
      }
    }
    const messages = place(request.messages, this.#placed.get(request.sessionId) ?? [])
    const result = this.inner.complete({ ...request, messages })
    if (isAsyncIterable(result)) {
      yield* result
      return
    }
    yield { type: "response", response: await result }
  }

  #sessionSteers(sessionId: string): PlacedSteer[] {
    const existing = this.#placed.get(sessionId)
    if (existing !== undefined) return existing
    if (this.#placed.size >= MAX_SESSIONS) {
      const oldest = this.#placed.keys().next().value
      if (oldest !== undefined) this.#placed.delete(oldest)
    }
    const created: PlacedSteer[] = []
    this.#placed.set(sessionId, created)
    return created
  }
}

/** The loop's messages with each steer after the message it followed. A steer whose message is gone (compacted) is left out. */
export function place(messages: readonly NativeMessage[], steers: readonly PlacedSteer[]): readonly NativeMessage[] {
  if (steers.length === 0) return messages
  const after = new Map<number, string[]>()
  for (const steer of steers) {
    const index = steer.after === undefined ? -1 : anchorIndex(messages, steer.after)
    if (index === undefined) continue
    const list = after.get(index) ?? []
    list.push(steer.text)
    after.set(index, list)
  }
  if (after.size === 0) return messages
  const out: NativeMessage[] = []
  for (const text of after.get(-1) ?? []) out.push(steerMessage(text))
  messages.forEach((message, index) => {
    out.push(message)
    for (const text of after.get(index) ?? []) out.push(steerMessage(text))
  })
  return Object.freeze(out)
}

/** A user message marked as a steer, so the turn's attachments are not put on it. */
function steerMessage(text: string): NativeMessage {
  return Object.freeze({ role: "user", text, steer: true } as NativeMessage)
}

function anchorIndex(messages: readonly NativeMessage[], anchor: NativeMessage): number | undefined {
  const exact = messages.lastIndexOf(anchor)
  if (exact >= 0) return exact
  // The loop may hand over copies; the same role, name, and text is the same message.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === anchor.role && message.text === anchor.text && (message as { readonly name?: string }).name === (anchor as { readonly name?: string }).name) return index
  }
  return undefined
}

function isAsyncIterable(value: unknown): value is AsyncIterable<NativeModelChunk> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value
}
