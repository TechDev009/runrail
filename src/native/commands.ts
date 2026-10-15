import { createHash } from "node:crypto"
import { NATIVE_CONTRACT_VERSION, NativeContractError, boundedNativeCapability, boundedNativeId, boundedNativeOptionalText, boundedNativeReference, boundedNativeText, nativeInvalid, requireNativeInteger, requireNativeTimestamp } from "./errors.ts"

export type NativeCommandName =
  | "task.create"
  | "task.start"
  | "task.enqueue"
  | "task.steer"
  | "task.cancel"
  | "task.resume"
  | "task.branch"
  | "task.clone"
  | "task.compact"
  | "task.approve"
  | "task.reject"
  | "task.verify"
  | "task.share"
  | "task.revoke_share"
  | "package.install"
  | "package.activate"
  | "package.rollback"
  | "account.select"
  | "account.revoke"

export type NativeCommandStatus = "accepted" | "replayed" | "completed" | "rejected"

export interface NativeCommand {
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION
  readonly commandId: string
  readonly idempotencyKey: string
  readonly taskId: string
  readonly sessionId: string
  readonly name: NativeCommandName
  readonly requestedAt: number
  readonly capability?: string
  readonly approvalId?: string
  readonly timeoutMs: number
  readonly payload?: Readonly<Record<string, NativeCommandValue>>
}

export type NativeCommandValue = string | number | boolean | readonly string[]

export interface NativeCommandResult {
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION
  readonly commandId: string
  readonly idempotencyKey: string
  readonly status: NativeCommandStatus
  readonly acceptedAt: number
  readonly completedAt?: number
  readonly firstEventSeq?: number
  readonly lastEventSeq?: number
  readonly code?: string
  readonly digest?: string
}

export interface NativeCommandLedger {
  get(idempotencyKey: string): NativeCommandResult | undefined
  put(command: NativeCommand, result: NativeCommandResult): void
  clear(taskId: string): void
  /** The task and command a key was first used for; a key is replayed only for that same command. */
  owner?(idempotencyKey: string): NativeCommandOwner | undefined
}

export interface NativeCommandOwner {
  readonly taskId: string
  readonly fingerprint?: string
}

/**
 * What makes a retry the same command: its task, session, kind and inputs. A digest only, so the
 * ledger keeps no prompt text; the command id and timestamps differ between honest retries.
 */
export function nativeCommandFingerprint(command: NativeCommand): string {
  const payload = command.payload === undefined ? [] : Object.keys(command.payload).sort().map((key) => [key, command.payload?.[key]])
  return createHash("sha256").update(JSON.stringify([command.taskId, command.sessionId, command.name, command.capability ?? null, command.approvalId ?? null, payload])).digest("hex")
}

export class InMemoryNativeCommandLedger implements NativeCommandLedger {
  private readonly entries = new Map<string, NativeCommandResult>()
  private readonly taskKeys = new Map<string, Set<string>>()
  private readonly keyTasks = new Map<string, string>()
  private readonly fingerprints = new Map<string, string>()
  private readonly maxEntries: number

  constructor(options: { readonly maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? 8_192
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) throw new NativeContractError("NATIVE_LIMIT", "command ledger limit is invalid")
    this.maxEntries = maxEntries
  }

  get(idempotencyKey: string): NativeCommandResult | undefined {
    return this.entries.get(boundedNativeText(idempotencyKey, "idempotency key", 256))
  }

  owner(idempotencyKey: string): NativeCommandOwner | undefined {
    const key = boundedNativeText(idempotencyKey, "idempotency key", 256)
    const taskId = this.keyTasks.get(key)
    const fingerprint = this.fingerprints.get(key)
    return taskId === undefined ? undefined : { taskId, ...(fingerprint === undefined ? {} : { fingerprint }) }
  }

  put(command: NativeCommand, result: NativeCommandResult): void {
    const key = boundedNativeText(command.idempotencyKey, "idempotency key", 256)
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(result)) throw new NativeContractError("NATIVE_IDEMPOTENCY_CONFLICT", "idempotency key has a different result")
      return
    }
    if (this.entries.size >= this.maxEntries) {
      const first = this.entries.keys().next().value
      if (typeof first === "string") this.forget(first)
    }
    this.entries.set(key, result)
    this.keyTasks.set(key, command.taskId)
    this.fingerprints.set(key, nativeCommandFingerprint(command))
    const keys = this.taskKeys.get(command.taskId) ?? new Set<string>()
    keys.add(key)
    this.taskKeys.set(command.taskId, keys)
  }

  clear(taskId: string): void {
    const keys = this.taskKeys.get(taskId)
    if (keys === undefined) return
    for (const key of keys) {
      this.entries.delete(key)
      this.keyTasks.delete(key)
      this.fingerprints.delete(key)
    }
    this.taskKeys.delete(taskId)
  }

  /** How many tasks still have a result recorded. */
  get taskCount(): number {
    return this.taskKeys.size
  }

  private forget(key: string): void {
    this.entries.delete(key)
    this.fingerprints.delete(key)
    const taskId = this.keyTasks.get(key)
    this.keyTasks.delete(key)
    if (taskId === undefined) return
    const keys = this.taskKeys.get(taskId)
    keys?.delete(key)
    if (keys?.size === 0) this.taskKeys.delete(taskId)
  }
}

export function parseNativeCommand(value: unknown): NativeCommand {
  const record = object(value, "native command must be an object")
  knownKeys(record, [
    "contractVersion", "commandId", "idempotencyKey", "taskId", "sessionId", "name", "requestedAt", "capability", "approvalId", "timeoutMs", "payload",
  ])
  if (record.contractVersion !== NATIVE_CONTRACT_VERSION) throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "native command contract version is unsupported")
  const commandId = boundedNativeId(record.commandId, "command id", 256)
  const idempotencyKey = boundedNativeText(record.idempotencyKey, "idempotency key", 256)
  const taskId = boundedNativeId(record.taskId, "task id")
  const sessionId = boundedNativeReference(record.sessionId, "session id", 256)
  if (!isCommandName(record.name)) nativeInvalid("command name is unsupported")
  const requestedAt = requireNativeTimestamp(record.requestedAt, "requestedAt")
  const capability = record.capability === undefined ? undefined : boundedNativeCapability(record.capability)
  const approvalId = record.approvalId === undefined ? undefined : boundedNativeId(record.approvalId, "approval id", 256)
  const timeoutMs = requireNativeInteger(record.timeoutMs, "timeoutMs", 1, 120_000)
  const payload = parsePayload(record.payload)
  return Object.freeze({
    contractVersion: NATIVE_CONTRACT_VERSION,
    commandId,
    idempotencyKey,
    taskId,
    sessionId,
    name: record.name,
    requestedAt,
    ...(capability === undefined ? {} : { capability }),
    ...(approvalId === undefined ? {} : { approvalId }),
    timeoutMs,
    ...(payload === undefined ? {} : { payload }),
  })
}

export function parseNativeCommandResult(value: unknown): NativeCommandResult {
  const record = object(value, "native command result must be an object")
  knownKeys(record, ["contractVersion", "commandId", "idempotencyKey", "status", "acceptedAt", "completedAt", "firstEventSeq", "lastEventSeq", "code", "digest"])
  if (record.contractVersion !== NATIVE_CONTRACT_VERSION) throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "native command result version is unsupported")
  const commandId = boundedNativeId(record.commandId, "command id", 256)
  const idempotencyKey = boundedNativeText(record.idempotencyKey, "idempotency key", 256)
  if (record.status !== "accepted" && record.status !== "replayed" && record.status !== "completed" && record.status !== "rejected") nativeInvalid("command result status is invalid")
  const acceptedAt = requireNativeTimestamp(record.acceptedAt, "acceptedAt")
  const completedAt = record.completedAt === undefined ? undefined : requireNativeTimestamp(record.completedAt, "completedAt")
  const firstEventSeq = record.firstEventSeq === undefined ? undefined : requireNativeInteger(record.firstEventSeq, "firstEventSeq", 0, 2_000_000_000)
  const lastEventSeq = record.lastEventSeq === undefined ? undefined : requireNativeInteger(record.lastEventSeq, "lastEventSeq", 0, 2_000_000_000)
  if (firstEventSeq !== undefined && lastEventSeq !== undefined && lastEventSeq < firstEventSeq) nativeInvalid("command result event range is invalid")
  const code = boundedNativeOptionalText(record.code, "result code", 128)
  const digest = boundedNativeOptionalText(record.digest, "result digest", 128)
  return Object.freeze({
    contractVersion: NATIVE_CONTRACT_VERSION,
    commandId,
    idempotencyKey,
    status: record.status,
    acceptedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(firstEventSeq === undefined ? {} : { firstEventSeq }),
    ...(lastEventSeq === undefined ? {} : { lastEventSeq }),
    ...(code === undefined ? {} : { code }),
    ...(digest === undefined ? {} : { digest }),
  })
}

function parsePayload(value: unknown): Readonly<Record<string, NativeCommandValue>> | undefined {
  if (value === undefined) return undefined
  const record = object(value, "command payload is invalid")
  const keys = Object.keys(record)
  if (keys.length > 64) throw new NativeContractError("NATIVE_LIMIT", "command payload has too many fields")
  const output: Record<string, NativeCommandValue> = {}
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(key)) nativeInvalid("command payload key is invalid")
    const item = record[key]
    if (typeof item === "string") output[key] = boundedNativeText(item, `payload '${key}'`, 64 * 1024)
    else if (typeof item === "number") {
      if (!Number.isFinite(item) || Math.abs(item) > 1_000_000_000_000) nativeInvalid("command payload number is invalid")
      output[key] = item
    } else if (typeof item === "boolean") output[key] = item
    else if (Array.isArray(item) && item.length <= 64 && item.every((entry) => typeof entry === "string" && entry.length <= 512)) output[key] = Object.freeze([...item])
    else nativeInvalid(`command payload '${key}' is invalid`)
  }
  return Object.freeze(output)
}

function isCommandName(value: unknown): value is NativeCommandName {
  return typeof value === "string" && COMMAND_NAMES.has(value as NativeCommandName)
}

const COMMAND_NAMES = new Set<NativeCommandName>([
  "task.create", "task.start", "task.enqueue", "task.steer", "task.cancel", "task.resume", "task.branch", "task.clone", "task.compact", "task.approve", "task.reject", "task.verify", "task.share", "task.revoke_share", "package.install", "package.activate", "package.rollback", "account.select", "account.revoke",
])

function object(value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeContractError("NATIVE_INVALID", reason)
  return value as Record<string, unknown>
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new NativeContractError("NATIVE_INVALID", "native command contains unknown fields")
}
