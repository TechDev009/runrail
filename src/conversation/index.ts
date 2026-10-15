import type { AgentEvent } from "@nifrajs/agent-protocol"
import { API_RETRY, apiRetryFrame } from "../harness/api-retry.ts"
import { mayContinue } from "../harness/event-text.ts"
import { APPROVAL_REVIEWED, REVIEWER_NOTICE, oneLine, parseApprovalReview, parseReviewerNotice, type ReviewDecision, type ReviewRisk, type ReviewSource, type Reviewer } from "../harness/review.ts"
import { carriedAnswers, carriedQuestions, type ApprovalAnswers, type ApprovalQuestion } from "../harness/questions.ts"
import { describeToolCall, type ToolPresentation } from "../tools/presentation.ts"
import type { RunrailApiRetryFrame } from "../live/types.ts"

/**
 * Local conversation view for reopening a thread in a coding UI. It is rebuilt on demand from
 * the live session history or the local transcript store, is bounded, and is never exported as
 * evidence. Items carry user and assistant text, so they must stay on the authenticated
 * loopback control channel.
 */
export type ConversationItem =
  | ConversationUserItem
  | ConversationAssistantItem
  | ConversationToolItem
  | ConversationApprovalItem
  | ConversationReviewItem
  | ConversationNoticeItem

interface ConversationItemBase {
  /** Stable for one builder: rebuilding the same source yields the same ids. */
  readonly id: string
  /** Event sequence (or transcript record sequence) that opened the item. */
  readonly seq: number
  readonly at: number
  readonly turnId?: string
}

export interface ConversationUserItem extends ConversationItemBase {
  readonly kind: "user"
  readonly text: string
  readonly attachments?: number
  readonly truncated?: true
  /** Sent while a turn ran and read by the model at its next step. */
  readonly steer?: true
}

export interface ConversationAssistantItem extends ConversationItemBase {
  readonly kind: "assistant"
  readonly text: string
  /** True when only deltas were seen (the turn was interrupted or is still running). */
  readonly partial: boolean
  readonly truncated?: true
}

export interface ConversationToolItem extends ConversationItemBase {
  readonly kind: "tool"
  readonly callId: string
  readonly name: string
  readonly presentation: ToolPresentation
  readonly status: "running" | "ok" | "failed"
  readonly errorCode?: string
  /** Bounded output tail for shell and verification tools. */
  readonly output?: string
  /** Lines a file write added and removed, when the tool counted them. */
  readonly additions?: number
  readonly deletions?: number
  /** Whether a file write made a new file. */
  readonly created?: boolean
}

export interface ConversationApprovalItem extends ConversationItemBase {
  readonly kind: "approval"
  readonly approvalId: string
  readonly action: string
  readonly capability: string
  readonly reason?: string
  readonly status: "pending" | "approved" | "rejected"
  /** A question the coding tool asked, and the answers given (a secret's answer is never kept). */
  readonly questions?: readonly ApprovalQuestion[]
  readonly answers?: ApprovalAnswers
  /** The person may ask for more questions instead of answering them all, and did, with what they wrote. */
  readonly takesFollowUp?: true
  readonly followUp?: true
  readonly note?: string
  /** The coding tool took the request back before anyone answered it. */
  readonly withdrawn?: true
  /** Why it was denied, when the denial said: the person's note, or why Runrail declined it unasked. */
  readonly denial?: string
}

/** A call the coding tool's own reviewer, rules, or mode decided without asking the person. */
export interface ConversationReviewItem extends ConversationItemBase {
  readonly kind: "review"
  readonly reviewId: string
  readonly reviewer: Reviewer
  readonly decision: ReviewDecision
  readonly action: string
  readonly capability: string
  readonly risk?: ReviewRisk
  readonly source?: ReviewSource
  readonly detail?: string
  readonly rationale?: string
}

export interface ConversationNoticeItem extends ConversationItemBase {
  readonly kind: "notice"
  readonly level: "info" | "error"
  readonly code: string
  readonly name?: string
  /** The coding tool's own words, on one line. */
  readonly message?: string
  /** An import the coding tool continues from its own copy of the session. */
  readonly inTool?: true
  /** `session.refreshed`: how many turns the session gained in its tool since the import. */
  readonly turns?: number
  /** `api.retry`: the latest retry of one request; the tool's retries of it share the row. */
  readonly retry?: Omit<RunrailApiRetryFrame, "type" | "turnId" | "source">
}

/** One source entry: a user input (transcript sequence) or a recorded AgentEvent (event sequence). */
export type ConversationEntry =
  | { readonly kind: "message.user"; readonly seq: number; readonly at: number; readonly payload: unknown }
  | { readonly kind: "event"; readonly seq: number; readonly at: number; readonly event: AgentEvent }

export interface ConversationBuilderOptions {
  readonly maxItems?: number
  readonly maxTextBytes?: number
  /** The workspace, so tool paths inside it read relative to it. */
  readonly root?: string
}

const DEFAULT_MAX_ITEMS = 512
const MAX_ITEMS = 4_096
const DEFAULT_TEXT_BYTES = 64 * 1024
const MAX_TEXT_BYTES = 256 * 1024
const OUTPUT_BYTES = 8 * 1024
const MAX_LINE_COUNT = 10_000_000
const MAX_CODE = 128
const MAX_REASON = 1_024
/** A request a coding tool made that Runrail refused for the person; a live frame, never in a transcript. */
const REQUEST_REFUSED = "request.refused"
/** Transcript record kind that marks where history imported from another agent ends. */
export const SESSION_IMPORTED = "session.imported"
/** Notice code for a later import marker that brought in what the session gained since. */
export const SESSION_REFRESHED = "session.refreshed"
/** Transcript record kind that marks where history copied from another thread ends: the thread continues here. */
export const SESSION_CONTINUED = "session.continued"
/** Transcript record kind that marks where a rewind cut the thread: the turns after were removed. */
export const SESSION_REWOUND = "session.rewound"

// Items are built as open records and frozen into the public union when read.
type MutableItem = { kind: ConversationItem["kind"]; id: string; seq: number; at: number; turnId?: string } & Record<string, unknown>

/**
 * Incremental builder. Feed entries in order; `items()` returns the newest `maxItems`
 * items. Tool completions and approval resolutions update earlier items in place.
 */
export class ConversationBuilder {
  private readonly maxItems: number
  private readonly maxTextBytes: number
  private readonly root: string | undefined
  private readonly list: MutableItem[] = []
  private readonly tools = new Map<string, MutableItem>()
  private readonly approvals = new Map<string, MutableItem>()
  private readonly reviews = new Map<string, MutableItem>()
  private readonly openAssistant = new Map<string, MutableItem>()
  /** A reply whose last message may be one piece of a longer reply that the next message continues. */
  private continuing: MutableItem | undefined
  private userSinceTurn = false
  /** The message the next turn answers, which takes that turn's id: a rewind names a message by it. */
  private prompted: MutableItem | undefined
  private dropped = 0
  private ordinal = 0
  private lastSeq = -1

  constructor(options: ConversationBuilderOptions = {}) {
    this.maxItems = bounded(options.maxItems, DEFAULT_MAX_ITEMS, 1, MAX_ITEMS, "maxItems")
    this.maxTextBytes = bounded(options.maxTextBytes, DEFAULT_TEXT_BYTES, 1_024, MAX_TEXT_BYTES, "maxTextBytes")
    this.root = options.root
  }

  get truncated(): boolean {
    return this.dropped > 0
  }

  get size(): number {
    return this.list.length
  }

  /** Sequence of the last event fed in; an event stream can resume after it. */
  get lastSequence(): number {
    return this.lastSeq
  }

  add(entry: ConversationEntry): void {
    if (entry.kind === "event") this.lastSeq = entry.seq
    if (entry.kind === "message.user") {
      const input = userInput(entry.payload)
      if (input === undefined) return
      // A steer lands inside a running turn; it does not stand in for the next turn's prompt.
      if (input.steer !== true) this.userSinceTurn = true
      const item: MutableItem = { kind: "user", id: this.nextId("u"), seq: entry.seq, at: entry.at, ...this.text(input.text), ...(input.attachments > 0 ? { attachments: input.attachments } : {}), ...(input.steer === true ? { steer: true } : {}) }
      if (input.steer !== true) this.prompted = item
      this.push(item)
      return
    }
    // Written by an import after the converted history; not an agent protocol event.
    const imported = entry.event as { readonly type: string; readonly name?: unknown; readonly inTool?: unknown; readonly refreshed?: unknown; readonly turns?: unknown }
    if (imported.type === SESSION_IMPORTED) {
      this.closeTurn()
      const name = typeof imported.name === "string" ? imported.name.slice(0, MAX_CODE) : undefined
      const turns = imported.refreshed === true && Number.isSafeInteger(imported.turns) && (imported.turns as number) > 0 ? (imported.turns as number) : undefined
      this.push({
        kind: "notice",
        id: this.nextId("n"),
        seq: entry.seq,
        at: entry.at,
        level: "info",
        code: imported.refreshed === true ? SESSION_REFRESHED : SESSION_IMPORTED,
        ...(name === undefined ? {} : { name }),
        ...(imported.inTool === true ? { inTool: true } : {}),
        ...(turns === undefined ? {} : { turns }),
      })
      return
    }
    if (imported.type === SESSION_CONTINUED || imported.type === SESSION_REWOUND) {
      this.closeTurn()
      this.push({ kind: "notice", id: this.nextId("n"), seq: entry.seq, at: entry.at, level: "info", code: imported.type })
      return
    }
    if (imported.type === APPROVAL_REVIEWED) {
      this.addReview(entry.event, entry.seq, entry.at)
      return
    }
    if (imported.type === REVIEWER_NOTICE) {
      const notice = parseReviewerNotice(entry.event)
      if (notice !== undefined) this.push({ kind: "notice", id: this.nextId("n"), seq: entry.seq, at: entry.at, ...(notice.turnId === undefined ? {} : { turnId: notice.turnId }), level: "info", code: `reviewer.${notice.notice}`, name: notice.reviewer, ...(notice.message === undefined ? {} : { message: notice.message }) })
      return
    }
    if (imported.type === API_RETRY) {
      this.addRetry(entry.event, entry.seq, entry.at)
      return
    }
    if (imported.type === REQUEST_REFUSED) {
      const refusal = entry.event as { readonly turnId?: unknown; readonly source?: unknown; readonly message?: unknown }
      const message = oneLine(refusal.message, MAX_REASON)
      const turnId = typeof refusal.turnId === "string" && refusal.turnId.length > 0 && refusal.turnId.length <= MAX_CODE ? refusal.turnId : undefined
      if (message !== undefined && (refusal.source === "codex" || refusal.source === "claude-code")) this.push({ kind: "notice", id: this.nextId("n"), seq: entry.seq, at: entry.at, ...(turnId === undefined ? {} : { turnId }), level: "info", code: REQUEST_REFUSED, name: refusal.source, message })
      return
    }
    this.addEvent(entry.event, entry.seq, entry.at)
  }

  /** Newest items first trimmed to `maxItems`, oldest first in the result. */
  items(maxItems = this.maxItems): readonly ConversationItem[] {
    return Object.freeze(this.list.slice(-maxItems).map((item) => Object.freeze({ ...item }) as unknown as ConversationItem))
  }

  private nextId(prefix: string): string {
    this.ordinal += 1
    return `${prefix}${String(this.ordinal)}`
  }

  private addEvent(event: AgentEvent, seq: number, at: number): void {
    const continued = this.continuing
    this.continuing = undefined
    // A coding tool that reports no turn start names its turn on its first reply or tool call.
    const turnId = (event as { readonly turnId?: unknown }).turnId
    if (this.prompted !== undefined && typeof turnId === "string") {
      if (this.prompted.turnId === undefined) this.prompted.turnId = turnId
      this.prompted = undefined
    }
    switch (event.type) {
      case "turn.started": {
        if (!this.userSinceTurn && event.prompt.trim().length > 0)
          this.push({ kind: "user", id: this.nextId("u"), seq, at, turnId: event.turnId, ...this.text(event.prompt) })
        this.userSinceTurn = false
        return
      }
      case "assistant.delta": {
        if (event.text.length === 0) return
        const open = this.openAssistant.get(event.turnId)
        if (open !== undefined) {
          Object.assign(open, this.text(`${String(open.text)}${event.text}`))
          return
        }
        const item: MutableItem = { kind: "assistant", id: this.nextId("a"), seq, at, turnId: event.turnId, partial: true, ...this.text(event.text) }
        this.openAssistant.set(event.turnId, item)
        this.push(item)
        return
      }
      case "assistant.message": {
        if (continued !== undefined && continued.turnId === event.turnId && this.list.at(-1) === continued) {
          if (continued.truncated !== true) Object.assign(continued, this.text(`${String(continued.text)}${event.text}`))
          if (mayContinue(event.text)) this.continuing = continued
          return
        }
        const open = this.openAssistant.get(event.turnId)
        this.openAssistant.delete(event.turnId)
        if (open !== undefined) {
          delete open.truncated
          Object.assign(open, { partial: false }, this.text(event.text.length > 0 ? event.text : String(open.text)))
          if (mayContinue(event.text)) this.continuing = open
          return
        }
        if (event.text.length === 0) return
        const item: MutableItem = { kind: "assistant", id: this.nextId("a"), seq, at, turnId: event.turnId, partial: false, ...this.text(event.text) }
        this.push(item)
        if (mayContinue(event.text)) this.continuing = item
        return
      }
      case "tool.started": {
        this.openAssistant.delete(event.turnId)
        const item: MutableItem = { kind: "tool", id: this.nextId("t"), seq, at, turnId: event.turnId, callId: event.callId, name: event.name, presentation: describeToolCall(event.name, event.input, { root: this.root }), status: "running" }
        this.tools.set(event.callId, item)
        this.push(item)
        return
      }
      case "tool.delta": {
        const item = this.tools.get(event.callId)
        if (item !== undefined && showsOutput(item)) item.output = tail(`${typeof item.output === "string" ? item.output : ""}${event.text}`, OUTPUT_BYTES)
        return
      }
      case "tool.completed": {
        let item = this.tools.get(event.callId)
        if (item === undefined) {
          item = { kind: "tool", id: this.nextId("t"), seq, at, turnId: event.turnId, callId: event.callId, name: event.name, presentation: describeToolCall(event.name, undefined), status: "running" }
          this.push(item)
        }
        this.tools.delete(event.callId)
        item.status = event.ok ? "ok" : "failed"
        const code = event.error?.code
        if (!event.ok && typeof code === "string") item.errorCode = code.slice(0, MAX_CODE)
        if (showsOutput(item)) {
          const output = outputText(event.output)
          if (output !== undefined) item.output = tail(output, OUTPUT_BYTES)
        }
        if (event.ok) Object.assign(item, writeCounts(event.output))
        return
      }
      case "approval.required": {
        const questions = carriedQuestions((event as { readonly questions?: unknown }).questions)
        const takesFollowUp = questions !== undefined && (event as { readonly takesFollowUp?: unknown }).takesFollowUp === true
        const item: MutableItem = { kind: "approval", id: this.nextId("p"), seq, at, turnId: event.turnId, approvalId: event.approvalId, action: event.action.slice(0, MAX_REASON), capability: event.capability.slice(0, MAX_CODE), status: "pending", ...(event.reason === undefined ? {} : { reason: event.reason.slice(0, MAX_REASON) }), ...(questions === undefined ? {} : { questions }), ...(takesFollowUp ? { takesFollowUp: true } : {}) }
        this.approvals.set(event.approvalId, item)
        this.push(item)
        return
      }
      case "approval.resolved": {
        const item = this.approvals.get(event.approvalId)
        this.approvals.delete(event.approvalId)
        if (item !== undefined) item.status = event.approved ? "approved" : "rejected"
        const answers = carriedAnswers((event as { readonly answers?: unknown }).answers)
        if (item !== undefined && answers !== undefined) item.answers = answers
        if (item !== undefined && event.approved && (event as { readonly followUp?: unknown }).followUp === true) {
          item.followUp = true
          const note = (event as { readonly note?: unknown }).note
          if (typeof note === "string" && note.length > 0) item.note = note.slice(0, MAX_REASON)
        }
        if (item !== undefined && !event.approved && (event as { readonly withdrawn?: unknown }).withdrawn === true) item.withdrawn = true
        else if (item !== undefined && !event.approved && event.reason !== undefined) item.denial = event.reason.slice(0, MAX_REASON)
        return
      }
      case "session.failed":
        this.closeTurn()
        this.push({ kind: "notice", id: this.nextId("n"), seq, at, level: "error", code: event.error.code.slice(0, MAX_CODE) })
        return
      case "session.stopped":
        this.closeTurn()
        this.push({ kind: "notice", id: this.nextId("n"), seq, at, level: "info", code: "stopped" })
        return
      case "session.completed":
        this.closeTurn()
        return
      case "memory.compacted":
        this.push({ kind: "notice", id: this.nextId("n"), seq, at, level: "info", code: "compacted" })
        return
      case "verification.completed":
        this.push({ kind: "notice", id: this.nextId("n"), seq, at, level: event.ok ? "info" : "error", code: event.ok ? "verification.passed" : "verification.failed", name: event.name.slice(0, MAX_CODE) })
        return
      default:
        return
    }
  }

  /** A review's decision updates the row its start opened. */
  private addReview(event: unknown, seq: number, at: number): void {
    const review = parseApprovalReview(event)
    if (review === undefined) return
    const { turnId, ...fields } = review
    const open = this.reviews.get(review.reviewId)
    if (open !== undefined) {
      // A late start never takes back a decision.
      if (review.decision !== "reviewing") Object.assign(open, fields)
      return
    }
    const item: MutableItem = { kind: "review", id: this.nextId("r"), seq, at, ...(turnId === undefined ? {} : { turnId }), ...fields }
    this.reviews.set(review.reviewId, item)
    this.push(item)
  }

  private closeTurn(): void {
    this.openAssistant.clear()
    for (const item of this.tools.values()) if (item.status === "running") item.status = "failed"
    this.tools.clear()
    for (const item of this.reviews.values()) if (item.decision === "reviewing") item.decision = "aborted"
    this.reviews.clear()
  }

  private text(value: string): { text: string; truncated?: true } {
    const clipped = clip(value, this.maxTextBytes)
    return clipped === value ? { text: value } : { text: clipped, truncated: true }
  }

  private addRetry(event: unknown, seq: number, at: number): void {
    const frame = apiRetryFrame(event)
    if (frame === undefined) return
    const { type: _type, turnId, source, ...retry } = frame
    const last = this.list.at(-1)
    // The retries of one request count up in one row; a lower attempt starts another request's.
    const counting = last?.kind === "notice" && last.code === API_RETRY && last.turnId === turnId && (last.retry as { readonly attempt: number }).attempt < retry.attempt ? last : undefined
    const item: MutableItem = { kind: "notice", id: counting?.id ?? this.nextId("n"), seq, at, ...(turnId === undefined ? {} : { turnId }), level: "info", code: API_RETRY, name: source, retry }
    if (counting === undefined) this.push(item)
    else this.list[this.list.length - 1] = item
  }

  private push(item: MutableItem): void {
    this.list.push(item)
    while (this.list.length > this.maxItems) {
      const removed = this.list.shift()
      this.dropped += 1
      if (removed?.kind === "tool") this.tools.delete(String(removed.callId))
      if (removed?.kind === "approval") this.approvals.delete(String(removed.approvalId))
      if (removed?.kind === "review") this.reviews.delete(String(removed.reviewId))
    }
  }
}

export interface BoundedConversation {
  readonly items: readonly ConversationItem[]
  readonly truncated: boolean
}

/** Drop the oldest items until the encoded list fits `maxBytes`. */
export function boundConversationItems(items: readonly ConversationItem[], maxBytes: number): BoundedConversation {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("conversation maxBytes is invalid")
  const sizes = items.map((item) => Buffer.byteLength(JSON.stringify(item), "utf8") + 1)
  let total = sizes.reduce((sum, size) => sum + size, 2)
  let start = 0
  while (start < items.length && total > maxBytes) {
    total -= sizes[start] ?? 0
    start += 1
  }
  return Object.freeze({ items: Object.freeze(items.slice(start)), truncated: start > 0 })
}

/** Convert a transcript record (`message.user` or an event-kind record) into an entry. */
export function transcriptEntry(record: { readonly kind: string; readonly seq: number; readonly at: number; readonly payload: unknown }): ConversationEntry | undefined {
  if (record.kind === "message.user") return { kind: "message.user", seq: record.seq, at: record.at, payload: record.payload }
  const payload = record.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const event = payload as Partial<AgentEvent>
  if (typeof event.type !== "string" || event.type !== record.kind) return undefined
  if (!isWellFormed(event)) return undefined
  // A recorded live frame (a coding tool's review) has no seq of its own: it sits after the event it followed.
  const afterSeq = (payload as { readonly afterSeq?: unknown }).afterSeq
  const seq = typeof event.seq === "number" && Number.isSafeInteger(event.seq) ? event.seq : typeof afterSeq === "number" && Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : record.seq
  const at = typeof event.at === "number" && Number.isFinite(event.at) ? event.at : record.at
  return { kind: "event", seq, at, event: event as AgentEvent }
}

function isWellFormed(event: Record<string, unknown>): boolean {
  switch (event.type) {
    case "turn.started": return typeof event.turnId === "string" && typeof event.prompt === "string"
    case "assistant.delta":
    case "assistant.message": return typeof event.turnId === "string" && typeof event.text === "string"
    case "tool.started": return typeof event.turnId === "string" && typeof event.callId === "string" && typeof event.name === "string"
    case "tool.delta": return typeof event.callId === "string" && typeof event.text === "string"
    case "tool.completed": return typeof event.callId === "string" && typeof event.name === "string" && typeof event.ok === "boolean"
    case "approval.required": return typeof event.approvalId === "string" && typeof event.action === "string" && typeof event.capability === "string"
    case "approval.resolved": return typeof event.approvalId === "string" && typeof event.approved === "boolean"
    case "session.failed": return event.error !== null && typeof event.error === "object" && typeof (event.error as { code?: unknown }).code === "string"
    case "verification.completed": return typeof event.name === "string" && typeof event.ok === "boolean"
    default: return true
  }
}

function userInput(payload: unknown): { readonly text: string; readonly attachments: number; readonly steer?: true } | undefined {
  if (typeof payload === "string") return payload.length === 0 ? undefined : { text: payload, attachments: 0 }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const value = payload as { text?: unknown; attachments?: unknown; parts?: unknown; steer?: unknown }
  if (typeof value.text !== "string") return undefined
  const attachments = (Array.isArray(value.attachments) ? value.attachments.length : 0)
    + (Array.isArray(value.parts) ? value.parts.filter((part) => part !== null && typeof part === "object" && (part as { kind?: unknown }).kind !== "text").length : 0)
  return { text: value.text, attachments, ...(value.steer === true ? { steer: true as const } : {}) }
}

function showsOutput(item: MutableItem): boolean {
  const presentation = item.presentation as ToolPresentation | undefined
  return presentation?.kind === "shell" || presentation?.kind === "verify"
}

/**
 * The line counts and new-file flag a write reports; nothing when either count is missing or out
 * of range. The native loop hands a tool's result over as JSON text, so a short object in text counts.
 */
function writeCounts(result: unknown): { additions?: number; deletions?: number; created?: boolean } {
  const output = typeof result === "string" ? smallJson(result) : result
  if (output === null || typeof output !== "object" || Array.isArray(output)) return {}
  const value = output as { additions?: unknown; deletions?: unknown; created?: unknown }
  const count = (entry: unknown): entry is number => Number.isSafeInteger(entry) && (entry as number) >= 0 && (entry as number) <= MAX_LINE_COUNT
  if (!count(value.additions) || !count(value.deletions)) return {}
  return { additions: value.additions, deletions: value.deletions, ...(typeof value.created === "boolean" ? { created: value.created } : {}) }
}

function smallJson(text: string): unknown {
  if (text.length > 1_024 || !text.startsWith("{")) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined
  const value = output as { stdout?: unknown; stderr?: unknown; output?: unknown; text?: unknown }
  const parts = [value.stdout, value.stderr, value.output, value.text].filter((part): part is string => typeof part === "string" && part.length > 0)
  return parts.length === 0 ? undefined : parts.join("\n")
}

function clip(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end = Math.floor(end * 0.9)
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let start = Math.max(0, value.length - maxBytes)
  while (start < value.length && Buffer.byteLength(value.slice(start), "utf8") > maxBytes) start += Math.max(1, Math.floor((value.length - start) * 0.1))
  const code = value.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return value.slice(start)
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`conversation ${name} is invalid`)
  return value
}
