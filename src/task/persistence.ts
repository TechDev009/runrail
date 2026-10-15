import { randomBytes } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NativeContractError, boundedNativeId, boundedNativeText } from "../native/errors.ts"
import { nativeCommandFingerprint, parseNativeCommandResult, type NativeCommand, type NativeCommandLedger, type NativeCommandOwner, type NativeCommandResult } from "../native/commands.ts"
import { parseNativeEvent, type NativeEvent, type NativeEventInput, type NativeEventJournal } from "../native/events.ts"

/**
 * File-backed metadata journal for native task events.
 *
 * The journal intentionally stores only parsed NativeEvent values. It is not a
 * transcript store and therefore cannot accidentally persist prompt or tool
 * payloads.
 *
 * Each event is appended as one line, so an event costs its own bytes rather than a rewrite of
 * the whole file. The file is rewritten from memory only when it outgrows its limit or a task is
 * cleared; then the oldest events are dropped until what is kept fits in three quarters of it.
 */
export class FileNativeEventJournal implements NativeEventJournal {
  private readonly root: string
  private readonly path: string
  private readonly maxEventsPerTask: number
  private readonly maxBytes: number
  private readonly events = new Map<string, NativeEvent[]>()
  private fileBytes = 0

  constructor(options: { readonly root: string; readonly maxEventsPerTask?: number; readonly maxBytes?: number }) {
    this.root = absoluteRoot(options.root)
    this.path = join(this.root, "events.jsonl")
    this.maxEventsPerTask = boundedLimit(options.maxEventsPerTask ?? 8_192, 1, 1_000_000, "event journal limit")
    this.maxBytes = boundedLimit(options.maxBytes ?? 16 * 1024 * 1024, 1_024, 128 * 1024 * 1024, "event journal byte limit")
    this.load()
  }

  append(input: NativeEventInput): NativeEvent {
    const event = parseNativeEvent({ ...input, contractVersion: 1, at: input.at ?? Date.now() })
    const list = this.events.get(event.taskId) ?? []
    const previous = list[list.length - 1]
    if (previous !== undefined) {
      if (event.seq <= previous.seq) throw new NativeContractError("NATIVE_STATE_CONFLICT", "event sequence is not monotonic")
      if (event.eventId === previous.eventId) throw new NativeContractError("NATIVE_DUPLICATE", "event identity is duplicated")
    }
    const line = `${JSON.stringify(event)}\n`
    const bytes = Buffer.byteLength(line, "utf8")
    if (bytes > this.maxBytes / 4) throw new NativeContractError("NATIVE_LIMIT", "event is too large for the journal")
    // Memory changes only once the event is on disk, so a failed write leaves both as they were.
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 })
    this.fileBytes += bytes
    list.push(event)
    const trimmed = list.length > this.maxEventsPerTask
    if (trimmed) list.splice(0, list.length - this.maxEventsPerTask)
    this.events.set(event.taskId, list)
    if (this.fileBytes > this.maxBytes) this.compact()
    return event
  }

  read(taskId: string, afterSeq = -1, maxEvents = 512): readonly NativeEvent[] {
    const id = boundedNativeId(taskId, "task id")
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || afterSeq > 2_000_000_000) throw new NativeContractError("NATIVE_LIMIT", "event cursor is invalid")
    const limit = boundedLimit(maxEvents, 1, 65_536, "event limit")
    const list = this.events.get(id) ?? []
    const first = list[0]
    if (first !== undefined && afterSeq < first.seq - 1) throw new NativeContractError("NATIVE_CURSOR_EXPIRED", "event cursor has expired")
    return Object.freeze(list.filter((event) => event.seq > afterSeq).slice(0, limit))
  }

  cursor(taskId: string, afterSeq = -1) {
    const id = boundedNativeId(taskId, "task id")
    const events = this.read(id, afterSeq, 65_536)
    const last = events.at(-1)
    return Object.freeze({ taskId: id, afterSeq, nextSeq: last === undefined ? Math.max(0, afterSeq + 1) : last.seq + 1 })
  }

  clear(taskId: string): void {
    const id = boundedNativeId(taskId, "task id")
    if (!this.events.delete(id)) return
    this.compact()
  }

  private load(): void {
    const text = readOptional(this.path)
    if (text !== undefined) {
      if (Buffer.byteLength(text, "utf8") > this.maxBytes * 2) throw new NativeContractError("NATIVE_LIMIT", "event journal is too large")
      const lines = text.split("\n")
      for (const [index, line] of lines.entries()) {
        if (line.length === 0) continue
        let item: unknown
        try {
          item = JSON.parse(line)
        } catch {
          // Only the last line can be torn, by a write cut short; anything earlier is corruption.
          if (index === lines.length - 1) break
          throw new NativeContractError("NATIVE_INVALID", "event journal JSON is invalid")
        }
        this.restore(parseNativeEvent(item))
      }
      this.fileBytes = Buffer.byteLength(text, "utf8")
    }
    if (this.fileBytes > this.maxBytes || (text !== undefined && !text.endsWith("\n") && text.length > 0)) this.compact()
  }

  private restore(event: NativeEvent): void {
    const list = this.events.get(event.taskId) ?? []
    const previous = list.at(-1)
    if (previous !== undefined && (event.seq <= previous.seq || event.eventId === previous.eventId)) throw new NativeContractError("NATIVE_STATE_CONFLICT", "event journal sequence is invalid")
    list.push(event)
    if (list.length > this.maxEventsPerTask) list.splice(0, list.length - this.maxEventsPerTask)
    this.events.set(event.taskId, list)
  }

  /** Rewrites the file from memory, first dropping the oldest events until they fit in 3/4 of the limit. */
  private compact(): void {
    const budget = Math.floor(this.maxBytes * 0.75)
    const size = (event: NativeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8") + 1
    let total = 0
    for (const list of this.events.values()) for (const event of list) total += size(event)
    while (total > budget) {
      // Each task's events stay in order, so only a task's first event can go; the oldest of those goes first.
      let oldest: NativeEvent[] | undefined
      for (const list of this.events.values()) if (list[0] !== undefined && (oldest === undefined || list[0].at < oldest[0]!.at)) oldest = list
      const dropped = oldest?.shift()
      if (oldest === undefined || dropped === undefined) break
      total -= size(dropped)
      if (oldest.length === 0) this.events.delete(dropped.taskId)
    }
    const values = [...this.events.values()].flatMap((list) => list).sort((left, right) => left.taskId.localeCompare(right.taskId) || left.seq - right.seq)
    writeAtomic(this.root, this.path, values.map((event) => `${JSON.stringify(event)}\n`).join(""))
    this.fileBytes = total
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw new NativeContractError("NATIVE_STATE_CONFLICT", "event journal cannot be read")
  }
}

interface PersistedCommand {
  readonly taskId: string
  /** Absent in ledgers written before commands were fingerprinted. */
  readonly fingerprint?: string
  readonly result: NativeCommandResult
}

/** File-backed idempotency ledger containing command results and task ownership only. */
export class FileNativeCommandLedger implements NativeCommandLedger {
  private readonly root: string
  private readonly path: string
  private readonly maxEntries: number
  private readonly maxBytes: number
  private entries = new Map<string, PersistedCommand>()

  constructor(options: { readonly root: string; readonly maxEntries?: number; readonly maxBytes?: number }) {
    this.root = absoluteRoot(options.root)
    this.path = join(this.root, "commands.json")
    this.maxEntries = boundedLimit(options.maxEntries ?? 8_192, 1, 1_000_000, "command ledger limit")
    this.maxBytes = boundedLimit(options.maxBytes ?? 8 * 1024 * 1024, 1_024, 64 * 1024 * 1024, "command ledger byte limit")
    this.load()
  }

  get(idempotencyKey: string): NativeCommandResult | undefined {
    return this.entries.get(boundedNativeText(idempotencyKey, "idempotency key", 256))?.result
  }

  owner(idempotencyKey: string): NativeCommandOwner | undefined {
    const entry = this.entries.get(boundedNativeText(idempotencyKey, "idempotency key", 256))
    return entry === undefined ? undefined : { taskId: entry.taskId, ...(entry.fingerprint === undefined ? {} : { fingerprint: entry.fingerprint }) }
  }

  put(command: NativeCommand, result: NativeCommandResult): void {
    const key = boundedNativeText(command.idempotencyKey, "idempotency key", 256)
    const parsed = parseNativeCommandResult(result)
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      if (JSON.stringify(existing.result) !== JSON.stringify(parsed)) throw new NativeContractError("NATIVE_IDEMPOTENCY_CONFLICT", "idempotency key has a different result")
      return
    }
    const staged = new Map(this.entries)
    if (staged.size >= this.maxEntries) {
      const first = staged.keys().next().value
      if (typeof first === "string") staged.delete(first)
    }
    staged.set(key, Object.freeze({ taskId: boundedNativeId(command.taskId, "task id"), fingerprint: nativeCommandFingerprint(command), result: parsed }))
    this.flush(staged)
    this.entries = staged
  }

  clear(taskId: string): void {
    const id = boundedNativeId(taskId, "task id")
    const staged = new Map(this.entries)
    for (const [key, entry] of staged) {
      if (entry.taskId === id) staged.delete(key)
    }
    if (staged.size !== this.entries.size) {
      this.flush(staged)
      this.entries = staged
    }
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, "utf8")
    } catch (error) {
      if (isNotFound(error)) return
      throw new NativeContractError("NATIVE_STATE_CONFLICT", "command ledger cannot be read")
    }
    if (Buffer.byteLength(text, "utf8") > this.maxBytes) throw new NativeContractError("NATIVE_LIMIT", "command ledger is too large")
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new NativeContractError("NATIVE_INVALID", "command ledger JSON is invalid")
    }
    if (!Array.isArray(value) || value.length > this.maxEntries) throw new NativeContractError("NATIVE_INVALID", "command ledger shape is invalid")
    for (const item of value) {
      if (!isRecord(item) || typeof item.taskId !== "string" || !isRecord(item.result) || (item.fingerprint !== undefined && (typeof item.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(item.fingerprint)))) throw new NativeContractError("NATIVE_INVALID", "command ledger entry is invalid")
      const taskId = boundedNativeId(item.taskId, "task id")
      const result = parseNativeCommandResult(item.result)
      const key = result.idempotencyKey
      if (this.entries.has(key)) throw new NativeContractError("NATIVE_DUPLICATE", "command ledger key is duplicated")
      this.entries.set(key, Object.freeze({ taskId, ...(typeof item.fingerprint === "string" ? { fingerprint: item.fingerprint } : {}), result }))
    }
  }

  private flush(staged: ReadonlyMap<string, PersistedCommand>): void {
    const data = JSON.stringify([...staged.values()])
    if (Buffer.byteLength(data, "utf8") > this.maxBytes) throw new NativeContractError("NATIVE_LIMIT", "command ledger is too large")
    writeAtomic(this.root, this.path, data)
  }
}

function absoluteRoot(value: string): string {
  const root = boundedNativeText(value, "native state root", 4_096)
  if (!root.startsWith("/")) throw new NativeContractError("NATIVE_INVALID", "native state root must be absolute")
  return root
}

function boundedLimit(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new NativeContractError("NATIVE_LIMIT", `${name} is invalid`)
  return value
}

function writeAtomic(root: string, path: string, data: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
  try {
    writeFileSync(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" })
    renameSync(temporary, path)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* nothing was written */ }
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && String((error as { readonly code: unknown }).code) === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
