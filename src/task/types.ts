import type { NativeCommand, NativeCommandResult } from "../native/commands.ts"
import type { NativeEvent, NativeEventJournal } from "../native/events.ts"
import { NATIVE_CONTRACT_VERSION, NativeContractError, boundedNativeId, boundedNativeOptionalText, boundedNativeReference, boundedNativeText, requireNativeInteger, requireNativeTimestamp } from "../native/errors.ts"

export type NativeTaskStatus = "draft" | "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled"

export interface NativeTaskRecord {
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION
  readonly taskId: string
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
  readonly status: NativeTaskStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
  readonly lastEventSeq: number
  readonly parentTaskId?: string
  readonly terminalCode?: string
  readonly digest?: string
}

export interface NativeTaskInput {
  readonly taskId: string
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
  readonly parentTaskId?: string
  readonly now?: number
}

export interface NativeTaskStore {
  get(taskId: string): Promise<NativeTaskRecord | undefined> | NativeTaskRecord | undefined
  put(task: NativeTaskRecord): Promise<void> | void
  delete(taskId: string): Promise<void> | void
  list(projectId?: string): Promise<readonly NativeTaskRecord[]> | readonly NativeTaskRecord[]
}

export interface NativeTaskOperationEvent {
  readonly type: NativeEvent["type"]
  readonly turnId?: string
  readonly terminal?: NativeEvent["terminal"]
  readonly code?: string
  readonly digest?: string
  readonly capability?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

export interface NativeTaskOperationResult {
  readonly status?: NativeTaskStatus
  readonly events: readonly NativeTaskOperationEvent[]
  readonly completedAt?: number
  readonly digest?: string
}

export type NativeTaskOperation = (task: NativeTaskRecord, signal: AbortSignal) => NativeTaskOperationResult | PromiseLike<NativeTaskOperationResult>

export interface NativeTaskKernelOptions {
  readonly maxTasks?: number
  readonly maxEventsPerTask?: number
  readonly now?: () => number
}

export interface NativeTaskKernel {
  create(input: NativeTaskInput): Promise<NativeTaskRecord>
  snapshot(taskId: string): Promise<NativeTaskRecord>
  list(projectId?: string): Promise<readonly NativeTaskRecord[]>
  execute(command: NativeCommand, operation: NativeTaskOperation, signal?: AbortSignal): Promise<NativeCommandResult>
  events(taskId: string, afterSeq?: number, maxEvents?: number): readonly NativeEvent[]
  /** Replace the display title. Titles are user labels, not evidence, so no journal event is added. */
  rename(taskId: string, title: string): Promise<NativeTaskRecord>
  remove(taskId: string): Promise<void>
}

export function parseNativeTaskRecord(value: unknown): NativeTaskRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeContractError("NATIVE_INVALID", "task record is invalid")
  const record = value as Record<string, unknown>
  const contractVersion = record.contractVersion
  if (contractVersion !== NATIVE_CONTRACT_VERSION) throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "task record version is unsupported")
  const taskId = boundedNativeId(record.taskId, "task id")
  const projectId = boundedNativeId(record.projectId, "project id")
  const sessionId = boundedNativeReference(record.sessionId, "session id", 256)
  const title = boundedNativeText(record.title, "task title", 256)
  const status = parseStatus(record.status)
  const createdAt = requireNativeTimestamp(record.createdAt, "task createdAt")
  const updatedAt = requireNativeTimestamp(record.updatedAt, "task updatedAt")
  const revision = requireNativeInteger(record.revision, "task revision", 0, 2_000_000_000)
  const lastEventSeq = requireNativeInteger(record.lastEventSeq, "task event sequence", -1, 2_000_000_000)
  if (updatedAt < createdAt) throw new NativeContractError("NATIVE_INVALID", "task timestamps are invalid")
  const parentTaskId = record.parentTaskId === undefined ? undefined : boundedNativeId(record.parentTaskId, "parent task id")
  const terminalCode = boundedNativeOptionalText(record.terminalCode, "terminal code", 128)
  const digest = boundedNativeOptionalText(record.digest, "task digest", 128)
  return Object.freeze({
    contractVersion: NATIVE_CONTRACT_VERSION,
    taskId,
    projectId,
    sessionId,
    title,
    status,
    createdAt,
    updatedAt,
    revision,
    lastEventSeq,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(terminalCode === undefined ? {} : { terminalCode }),
    ...(digest === undefined ? {} : { digest }),
  })
}

export function validateTaskTransition(from: NativeTaskStatus, to: NativeTaskStatus): void {
  if (from === to) return
  const allowed: Readonly<Record<NativeTaskStatus, readonly NativeTaskStatus[]>> = {
    draft: ["queued", "running", "cancelled", "failed"],
    queued: ["running", "cancelled", "failed"],
    running: ["waiting", "paused", "completed", "failed", "cancelled"],
    waiting: ["running", "paused", "failed", "cancelled"],
    paused: ["running", "cancelled", "failed"],
    completed: ["queued", "running"],
    failed: ["queued", "running"],
    cancelled: ["queued", "running"],
  }
  if (!allowed[from].includes(to)) throw new NativeContractError("NATIVE_STATE_CONFLICT", `task cannot transition from ${from} to ${to}`)
}

export function taskEventJournal(journal: NativeEventJournal, taskId: string, afterSeq = -1, maxEvents = 512): readonly NativeEvent[] {
  return journal.read(boundedNativeId(taskId, "task id"), afterSeq, maxEvents)
}

function parseStatus(value: unknown): NativeTaskStatus {
  if (value === "draft" || value === "queued" || value === "running" || value === "waiting" || value === "paused" || value === "completed" || value === "failed" || value === "cancelled") return value
  throw new NativeContractError("NATIVE_INVALID", "task status is invalid")
}
