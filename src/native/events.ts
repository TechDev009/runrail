import {
  NATIVE_CONTRACT_VERSION,
  NativeContractError,
  boundedNativeCapability,
  boundedNativeId,
  boundedNativeList,
  boundedNativeOptionalText,
  boundedNativeReference,
  boundedNativeText,
  nativeInvalid,
  requireNativeInteger,
  requireNativeTimestamp,
} from "./errors.ts"

export type NativeEventType =
  | "task.created"
  | "task.started"
  | "task.waiting"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "turn.started"
  | "turn.completed"
  | "tool.started"
  | "tool.completed"
  | "approval.required"
  | "approval.resolved"
  | "plan.step"
  | "agent.run"
  | "verification.completed"
  | "repair.attempt"
  | "budget.updated"
  | "package.activated"
  | "package.rolled_back"
  | "account.updated"
  | "share.updated"

export type NativeEventTerminal = "completed" | "failed" | "cancelled"

export type NativeMetadataValue = string | number | boolean

export interface NativeEvent {
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION
  readonly eventId: string
  readonly taskId: string
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly type: NativeEventType
  readonly turnId?: string
  readonly terminal?: NativeEventTerminal
  readonly code?: string
  readonly digest?: string
  readonly capability?: string
  readonly metadata?: Readonly<Record<string, NativeMetadataValue>>
}

export interface NativeEventInput {
  readonly eventId: string
  readonly taskId: string
  readonly sessionId: string
  readonly seq: number
  readonly at?: number
  readonly type: NativeEventType
  readonly turnId?: string
  readonly terminal?: NativeEventTerminal
  readonly code?: string
  readonly digest?: string
  readonly capability?: string
  readonly metadata?: Readonly<Record<string, NativeMetadataValue>>
}

export interface NativeEventCursor {
  readonly taskId: string
  readonly afterSeq: number
  readonly nextSeq: number
}

export interface NativeEventJournal {
  append(event: NativeEventInput): NativeEvent
  read(taskId: string, afterSeq?: number, maxEvents?: number): readonly NativeEvent[]
  cursor(taskId: string, afterSeq?: number): NativeEventCursor
  clear(taskId: string): void
}

export class InMemoryNativeEventJournal implements NativeEventJournal {
  private readonly events = new Map<string, NativeEvent[]>()
  private readonly maxEventsPerTask: number

  constructor(options: { readonly maxEventsPerTask?: number } = {}) {
    const max = options.maxEventsPerTask ?? 8_192
    if (!Number.isSafeInteger(max) || max < 1 || max > 1_000_000) throw new NativeContractError("NATIVE_LIMIT", "event journal limit is invalid")
    this.maxEventsPerTask = max
  }

  append(input: NativeEventInput): NativeEvent {
    const event = parseNativeEvent({ ...input, contractVersion: NATIVE_CONTRACT_VERSION, at: input.at ?? Date.now() })
    const list = this.events.get(event.taskId) ?? []
    const previous = list[list.length - 1]
    if (previous !== undefined) {
      if (event.seq <= previous.seq) throw new NativeContractError("NATIVE_STATE_CONFLICT", "event sequence is not monotonic")
      if (event.eventId === previous.eventId) throw new NativeContractError("NATIVE_DUPLICATE", "event identity is duplicated")
    }
    list.push(event)
    if (list.length > this.maxEventsPerTask) list.splice(0, list.length - this.maxEventsPerTask)
    this.events.set(event.taskId, list)
    return event
  }

  read(taskId: string, afterSeq = -1, maxEvents = 512): readonly NativeEvent[] {
    const id = boundedNativeId(taskId, "task id")
    const after = requireNativeInteger(afterSeq, "event cursor", -1, 2_000_000_000)
    const limit = requireNativeInteger(maxEvents, "event limit", 1, 65_536)
    const list = this.events.get(id) ?? []
    const first = list[0]
    if (first !== undefined && after < first.seq - 1) throw new NativeContractError("NATIVE_CURSOR_EXPIRED", "event cursor has expired")
    return Object.freeze(list.filter((event) => event.seq > after).slice(0, limit))
  }

  cursor(taskId: string, afterSeq = -1): NativeEventCursor {
    const id = boundedNativeId(taskId, "task id")
    const events = this.read(id, afterSeq, 65_536)
    const last = events[events.length - 1]
    const nextSeq = last === undefined ? Math.max(0, afterSeq + 1) : last.seq + 1
    return Object.freeze({ taskId: id, afterSeq, nextSeq })
  }

  clear(taskId: string): void {
    this.events.delete(boundedNativeId(taskId, "task id"))
  }
}

export function parseNativeEvent(value: unknown): NativeEvent {
  const record = object(value, "native event must be an object")
  knownKeys(record, [
    "contractVersion", "eventId", "taskId", "sessionId", "seq", "at", "type", "turnId", "terminal", "code", "digest", "capability", "metadata",
  ])
  if (record.contractVersion !== NATIVE_CONTRACT_VERSION) throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "native event contract version is unsupported")
  const eventId = boundedNativeId(record.eventId, "event id", 256)
  const taskId = boundedNativeId(record.taskId, "task id")
  const sessionId = boundedNativeReference(record.sessionId, "session id", 256)
  const seq = requireNativeInteger(record.seq, "event sequence", 0, 2_000_000_000)
  const at = requireNativeTimestamp(record.at, "event timestamp")
  if (!isEventType(record.type)) nativeInvalid("event type is unsupported")
  const turnId = boundedNativeOptionalText(record.turnId, "turn id", 256)
  const terminal = record.terminal === undefined ? undefined : parseTerminal(record.terminal)
  const code = boundedNativeOptionalText(record.code, "event code", 128)
  const digest = boundedNativeOptionalText(record.digest, "event digest", 128)
  const capability = record.capability === undefined ? undefined : boundedNativeCapability(record.capability)
  const metadata = parseMetadata(record.metadata)
  return Object.freeze({
    contractVersion: NATIVE_CONTRACT_VERSION,
    eventId,
    taskId,
    sessionId,
    seq,
    at,
    type: record.type,
    ...(turnId === undefined ? {} : { turnId }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(code === undefined ? {} : { code }),
    ...(digest === undefined ? {} : { digest }),
    ...(capability === undefined ? {} : { capability }),
    ...(metadata === undefined ? {} : { metadata }),
  })
}

function parseMetadata(value: unknown): Readonly<Record<string, NativeMetadataValue>> | undefined {
  if (value === undefined) return undefined
  const record = object(value, "event metadata is invalid")
  const keys = Object.keys(record)
  if (keys.length > 32) throw new NativeContractError("NATIVE_LIMIT", "event metadata has too many fields")
  const output: Record<string, NativeMetadataValue> = {}
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(key)) nativeInvalid("event metadata key is invalid")
    const item = record[key]
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") nativeInvalid("event metadata value is invalid")
    if (typeof item === "string") boundedNativeText(item, `event metadata '${key}'`, 512)
    if (typeof item === "number" && (!Number.isFinite(item) || Math.abs(item) > 1_000_000_000_000)) nativeInvalid("event metadata number is invalid")
    output[key] = item
  }
  return Object.freeze(output)
}

function parseTerminal(value: unknown): NativeEventTerminal {
  if (value !== "completed" && value !== "failed" && value !== "cancelled") nativeInvalid("event terminal state is invalid")
  return value
}

function isEventType(value: unknown): value is NativeEventType {
  return typeof value === "string" && EVENT_TYPES.has(value as NativeEventType)
}

const EVENT_TYPES = new Set<NativeEventType>([
  "task.created", "task.started", "task.waiting", "task.completed", "task.failed", "task.cancelled", "turn.started", "turn.completed",
  "tool.started", "tool.completed", "approval.required", "approval.resolved", "plan.step", "agent.run", "verification.completed", "repair.attempt",
  "budget.updated", "package.activated", "package.rolled_back", "account.updated", "share.updated",
])

function object(value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeContractError("NATIVE_INVALID", reason)
  return value as Record<string, unknown>
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new NativeContractError("NATIVE_INVALID", "native event contains unknown fields")
}
