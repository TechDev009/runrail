import { NativeContractError, boundedNativeId, boundedNativeText, boundedNativeReference, requireNativeTimestamp } from "../native/errors.ts"
import { InMemoryNativeEventJournal, parseNativeEvent, type NativeEvent, type NativeEventJournal } from "../native/events.ts"
import { InMemoryNativeCommandLedger, nativeCommandFingerprint, parseNativeCommandResult, type NativeCommand, type NativeCommandLedger, type NativeCommandResult } from "../native/commands.ts"
import { parseNativeTaskRecord, validateTaskTransition, type NativeTaskInput, type NativeTaskKernel, type NativeTaskKernelOptions, type NativeTaskOperation, type NativeTaskRecord, type NativeTaskStore } from "./types.ts"
import { InMemoryNativeTaskStore } from "./store.ts"

export class NativeTaskKernelImpl implements NativeTaskKernel {
  private readonly store: NativeTaskStore
  private readonly journal: NativeEventJournal
  private readonly ledger: NativeCommandLedger
  private readonly maxTasks: number
  private readonly now: () => number
  private readonly taskLocks = new Map<string, Promise<void>>()
  /** Keys whose command is running; task locks are per task, so one key could otherwise run twice at once. */
  private readonly runningKeys = new Set<string>()

  constructor(options: NativeTaskKernelOptions & { readonly store?: NativeTaskStore; readonly journal?: NativeEventJournal; readonly ledger?: NativeCommandLedger } = {}) {
    this.store = options.store ?? new InMemoryNativeTaskStore({ maxTasks: options.maxTasks })
    this.journal = options.journal ?? new InMemoryNativeEventJournal({ maxEventsPerTask: options.maxEventsPerTask })
    this.ledger = options.ledger ?? new InMemoryNativeCommandLedger()
    this.maxTasks = options.maxTasks ?? 4_096
    this.now = options.now ?? (() => Date.now())
    if (!Number.isSafeInteger(this.maxTasks) || this.maxTasks < 1 || this.maxTasks > 65_536) throw new NativeContractError("NATIVE_LIMIT", "task kernel limit is invalid")
  }

  async create(input: NativeTaskInput): Promise<NativeTaskRecord> {
    const taskId = boundedNativeId(input.taskId, "task id")
    const projectId = boundedNativeId(input.projectId, "project id")
    const sessionId = boundedNativeReference(input.sessionId, "session id", 256)
    const title = boundedNativeText(input.title, "task title", 256)
    const existing = await this.store.get(taskId)
    if (existing !== undefined) throw new NativeContractError("NATIVE_DUPLICATE", "task already exists")
    const listed = await this.store.list()
    if (listed.length >= this.maxTasks) throw new NativeContractError("NATIVE_LIMIT", "task kernel is full")
    const now = input.now ?? this.now()
    requireNativeTimestamp(now, "task timestamp")
    const parentTaskId = input.parentTaskId === undefined ? undefined : boundedNativeId(input.parentTaskId, "parent task id")
    const task = parseNativeTaskRecord({
      contractVersion: 1,
      taskId,
      projectId,
      sessionId,
      title,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      revision: 0,
      lastEventSeq: -1,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
    })
    const event = this.journal.append({ eventId: `${taskId}:0:task.created`, taskId, sessionId, seq: 0, at: now, type: "task.created" })
    const created = parseNativeTaskRecord({ ...task, lastEventSeq: event.seq })
    await this.store.put(created)
    return created
  }

  async snapshot(taskId: string): Promise<NativeTaskRecord> {
    const task = await this.store.get(boundedNativeId(taskId, "task id"))
    if (task === undefined) throw new NativeContractError("NATIVE_NOT_FOUND", "task was not found")
    return task
  }

  async list(projectId?: string): Promise<readonly NativeTaskRecord[]> {
    return Object.freeze([...(await this.store.list(projectId))])
  }

  async execute(command: NativeCommand, operation: NativeTaskOperation, signal?: AbortSignal): Promise<NativeCommandResult> {
    const taskId = boundedNativeId(command.taskId, "task id")
    return this.withTaskLock(taskId, () => this.executeLocked(command, operation, signal))
  }

  private async executeLocked(command: NativeCommand, operation: NativeTaskOperation, signal?: AbortSignal): Promise<NativeCommandResult> {
    const task = await this.snapshot(command.taskId)
    if (task.sessionId !== command.sessionId) throw new NativeContractError("NATIVE_STATE_CONFLICT", "command session does not own the task")
    const previous = this.ledger.get(command.idempotencyKey)
    if (previous !== undefined) {
      const owner = this.ledger.owner?.(command.idempotencyKey)
      if (owner !== undefined && (owner.taskId !== command.taskId || (owner.fingerprint !== undefined && owner.fingerprint !== nativeCommandFingerprint(command))))
        throw new NativeContractError("NATIVE_IDEMPOTENCY_CONFLICT", "idempotency key was used for a different command")
      return Object.freeze({ ...previous, status: "replayed" })
    }
    if (this.runningKeys.has(command.idempotencyKey)) throw new NativeContractError("NATIVE_IDEMPOTENCY_CONFLICT", "idempotency key is in use by a running command")
    if (signal?.aborted === true) throw new NativeContractError("NATIVE_CANCELLED", "task command was cancelled")
    this.runningKeys.add(command.idempotencyKey)
    try {
      return await this.run(this.reconciled(task), command, operation, signal)
    } finally {
      this.runningKeys.delete(command.idempotencyKey)
    }
  }

  /** A journal that ran ahead of its task (a write that failed after the append) sets where the next events go. */
  private reconciled(task: NativeTaskRecord): NativeTaskRecord {
    const last = this.journal.read(task.taskId, task.lastEventSeq, 65_536).at(-1)?.seq
    return last === undefined ? task : { ...task, lastEventSeq: last }
  }

  private async run(task: NativeTaskRecord, command: NativeCommand, operation: NativeTaskOperation, signal?: AbortSignal): Promise<NativeCommandResult> {
    const acceptedAt = this.now()
    let operationResult: Awaited<ReturnType<NativeTaskOperation>>
    try {
      operationResult = await operation(task, signal ?? new AbortController().signal)
      if (!Array.isArray(operationResult.events) || operationResult.events.length > 256) throw new NativeContractError("NATIVE_LIMIT", "task operation returned too many events")
    } catch (error) {
      const code = error instanceof NativeContractError ? error.code : "NATIVE_OPERATION_FAILED"
      const failed = await this.commitFailure(task, command, acceptedAt, code)
      this.ledger.put(command, failed)
      return failed
    }
    let nextStatus = task.status
    for (const item of operationResult.events) {
      const candidate = statusFromEvents(nextStatus, [item])
      // An approval answered inside the same operation resumed the work before it finished.
      if (nextStatus === "waiting" && candidate === "completed") nextStatus = "running"
      validateTaskTransition(nextStatus, candidate)
      nextStatus = candidate
    }
    if (operationResult.status !== undefined) {
      if (nextStatus === "waiting" && operationResult.status === "completed") nextStatus = "running"
      validateTaskTransition(nextStatus, operationResult.status)
      nextStatus = operationResult.status
    }
    // Everything is checked before the first append, so a bad last event cannot leave the first ones journaled.
    const pending: NativeEvent[] = []
    let nextSeq = task.lastEventSeq + 1
    for (const item of operationResult.events) {
      pending.push(parseNativeEvent({
        contractVersion: 1,
        eventId: `${task.taskId}:${nextSeq}:${item.type}`,
        taskId: task.taskId,
        sessionId: task.sessionId,
        seq: nextSeq,
        at: this.now(),
        type: item.type,
        ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
        ...(item.terminal === undefined ? {} : { terminal: item.terminal }),
        ...(item.code === undefined ? {} : { code: item.code }),
        ...(item.digest === undefined ? {} : { digest: item.digest }),
        ...(item.capability === undefined ? {} : { capability: item.capability }),
        ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
      }))
      nextSeq += 1
    }
    const updatedAt = operationResult.completedAt ?? this.now()
    requireNativeTimestamp(updatedAt, "task update timestamp")
    const updated = parseNativeTaskRecord({
      ...task,
      status: nextStatus,
      updatedAt,
      revision: task.revision + 1,
      lastEventSeq: pending.at(-1)?.seq ?? task.lastEventSeq,
      ...(nextStatus === "failed" || nextStatus === "cancelled" ? { terminalCode: operationResult.events.at(-1)?.code ?? "NATIVE_OPERATION_FAILED" } : {}),
      ...(operationResult.digest === undefined ? {} : { digest: operationResult.digest }),
    })
    const events = pending.map((event) => this.journal.append(event))
    await this.store.put(updated)
    const result = parseNativeCommandResult({
      contractVersion: 1,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      status: "completed",
      acceptedAt,
      completedAt: updatedAt,
      ...(events.length === 0 ? {} : { firstEventSeq: events[0]!.seq, lastEventSeq: events.at(-1)!.seq }),
      ...(operationResult.digest === undefined ? {} : { digest: operationResult.digest }),
    })
    this.ledger.put(command, result)
    return result
  }

  events(taskId: string, afterSeq = -1, maxEvents = 512): readonly NativeEvent[] {
    return this.journal.read(boundedNativeId(taskId, "task id"), afterSeq, maxEvents)
  }

  async rename(taskId: string, title: string): Promise<NativeTaskRecord> {
    const id = boundedNativeId(taskId, "task id")
    const nextTitle = boundedNativeText(title, "task title", 256)
    return this.withTaskLock(id, async () => {
      const task = await this.snapshot(id)
      if (task.title === nextTitle) return task
      const updatedAt = Math.max(task.updatedAt, this.now())
      requireNativeTimestamp(updatedAt, "task update timestamp")
      const renamed = parseNativeTaskRecord({ ...task, title: nextTitle, updatedAt, revision: task.revision + 1 })
      await this.store.put(renamed)
      return renamed
    })
  }

  async remove(taskId: string): Promise<void> {
    const id = boundedNativeId(taskId, "task id")
    await this.withTaskLock(id, async () => {
      await this.store.delete(id)
      this.journal.clear(id)
      this.ledger.clear(id)
    })
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId)
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.taskLocks.set(taskId, current)
    if (previous !== undefined) await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.taskLocks.get(taskId) === current) this.taskLocks.delete(taskId)
    }
  }

  private async commitFailure(task: NativeTaskRecord, command: NativeCommand, acceptedAt: number, code: string): Promise<NativeCommandResult> {
    // A finished task keeps its outcome; the command alone is rejected.
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
      return parseNativeCommandResult({ contractVersion: 1, commandId: command.commandId, idempotencyKey: command.idempotencyKey, status: "rejected", acceptedAt, completedAt: Math.max(acceptedAt, this.now()), code })
    validateTaskTransition(task.status, "failed")
    const event = this.journal.append({ eventId: `${task.taskId}:${task.lastEventSeq + 1}:task.failed`, taskId: task.taskId, sessionId: task.sessionId, seq: task.lastEventSeq + 1, at: this.now(), type: "task.failed", terminal: "failed", code })
    const updated = parseNativeTaskRecord({ ...task, status: "failed", updatedAt: this.now(), revision: task.revision + 1, lastEventSeq: event.seq, terminalCode: code })
    await this.store.put(updated)
    return parseNativeCommandResult({ contractVersion: 1, commandId: command.commandId, idempotencyKey: command.idempotencyKey, status: "rejected", acceptedAt, completedAt: updated.updatedAt, firstEventSeq: event.seq, lastEventSeq: event.seq, code })
  }
}

export function createNativeTaskKernel(options: NativeTaskKernelOptions & { readonly store?: NativeTaskStore; readonly journal?: NativeEventJournal; readonly ledger?: NativeCommandLedger } = {}): NativeTaskKernel {
  return new NativeTaskKernelImpl(options)
}

function statusFromEvents(current: NativeTaskRecord["status"], events: readonly { readonly type: NativeEvent["type"]; readonly terminal?: NativeEvent["terminal"] }[]): NativeTaskRecord["status"] {
  const last = events.at(-1)
  if (last?.terminal === "completed" || last?.type === "task.completed") return "completed"
  if (last?.terminal === "failed" || last?.type === "task.failed") return "failed"
  if (last?.terminal === "cancelled" || last?.type === "task.cancelled") return "cancelled"
  if (last?.type === "approval.required" || last?.type === "task.waiting") return "waiting"
  if (last?.type === "task.started" || last?.type === "turn.started") return "running"
  return current
}
