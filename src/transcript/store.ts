import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { writeFileAtomic } from "../runtime/atomic-write.ts"
import { containedPath, ensureContainedDirectory } from "../runtime/contained-path.ts"
import { BoundedReadError, readBoundedText } from "../runtime/bounded-read.ts"

export const RUNRAIL_TRANSCRIPT_VERSION = 1 as const

export interface TranscriptAppendInput {
  readonly id?: string
  readonly kind: string
  readonly payload: unknown
  readonly parentId?: string
}

export interface TranscriptRecord {
  readonly version: typeof RUNRAIL_TRANSCRIPT_VERSION
  readonly sessionId: string
  readonly seq: number
  readonly id: string
  readonly kind: string
  readonly payload: unknown
  readonly parentId?: string
  readonly at: number
}

export interface TranscriptReadOptions {
  readonly maxRecords?: number
  readonly afterSeq?: number
  readonly maxBytes?: number
}

export interface TranscriptCompactionOptions {
  readonly throughSeq: number
  readonly replacement: TranscriptAppendInput
}

export interface TranscriptCompactionResult {
  readonly sessionId: string
  readonly compacted: number
  readonly retained: number
}

export interface TranscriptBundle {
  readonly version: typeof RUNRAIL_TRANSCRIPT_VERSION
  readonly sessionId: string
  readonly records: readonly TranscriptRecord[]
}

export interface TranscriptImportResult {
  readonly sessionId: string
  readonly imported: number
}

export interface TranscriptRecoveryResult {
  readonly sessionId: string
  readonly retainedRecords: number
  readonly discardedBytes: number
}

export interface TranscriptStore {
  /** Payload-bearing storage is caller-owned and must be explicitly supplied. */
  append(sessionId: string, input: TranscriptAppendInput): Promise<TranscriptRecord>
  read(sessionId: string, options?: TranscriptReadOptions): Promise<readonly TranscriptRecord[]>
  branch(sessionId: string, targetSessionId?: string): Promise<string>
  compact(sessionId: string, options: TranscriptCompactionOptions): Promise<TranscriptCompactionResult>
  export(sessionId: string, options?: TranscriptReadOptions): Promise<string>
  import(source: string | TranscriptBundle, targetSessionId?: string): Promise<TranscriptImportResult>
  replay(sessionId: string, visitor: (record: TranscriptRecord) => void | PromiseLike<void>, options?: TranscriptReadOptions): Promise<number>
  migrate(source: string | TranscriptBundle): Promise<TranscriptBundle>
  /** Optional explicit recovery for a process interrupted during a final JSONL append. */
  recover?(sessionId: string): Promise<TranscriptRecoveryResult>
  /** Removes the record `beforeId` and every record after it, in one replace. */
  truncate?(sessionId: string, options: TranscriptTruncateOptions): Promise<TranscriptTruncateResult>
}

export interface TranscriptTruncateOptions {
  /** By id, not seq: a compaction renumbers records but keeps the ids of those it retains. */
  readonly beforeId: string
}

export interface TranscriptTruncateResult {
  readonly sessionId: string
  readonly removed: number
  readonly retained: number
}

export interface FileTranscriptStoreOptions {
  readonly root: string
  readonly maxEntryBytes?: number
  readonly maxRecords?: number
  readonly clock?: () => number
}

export type TranscriptStoreErrorCode =
  | "TRANSCRIPT_INVALID"
  | "TRANSCRIPT_LIMIT"
  | "TRANSCRIPT_IO"
  | "TRANSCRIPT_CONFLICT"
  | "TRANSCRIPT_MIGRATION_UNSUPPORTED"

export class TranscriptStoreError extends Error {
  constructor(readonly code: TranscriptStoreErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "TranscriptStoreError"
  }
}

interface TranscriptTail {
  size: number
  lastSeq: number | undefined
  count: number
  readonly ids: Set<string>
}

// Holds any one valid event: 256 KiB characters of text is up to 1.5 MiB of JSON once escaped.
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024

/** A small opt-in local reference store. It is intentionally not Runrail evidence storage. */
export class FileTranscriptStore implements TranscriptStore {
  readonly root: string
  private readonly maxEntryBytes: number
  private readonly maxRecords: number
  private readonly clock: () => number
  private readonly locks = new Map<string, Promise<void>>()
  /** What an append needs of each file it last wrote, so it does not re-read the whole file each time. */
  private readonly tails = new Map<string, TranscriptTail>()

  constructor(options: FileTranscriptStoreOptions) {
    this.root = resolve(options.root)
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.maxRecords = options.maxRecords ?? 16_384
    this.clock = options.clock ?? (() => Date.now())
    if (!Number.isSafeInteger(this.maxEntryBytes) || this.maxEntryBytes < 1_024 || this.maxEntryBytes > 16 * 1024 * 1024)
      throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "entry byte limit is invalid")
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 1_000_000)
      throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "record limit is invalid")
  }

  async append(sessionId: string, input: TranscriptAppendInput): Promise<TranscriptRecord> {
    const safeSessionId = validateSessionId(sessionId)
    validateAppendInput(input)
    return this.withLock(safeSessionId, async () => {
      const tail = await this.tailOf(safeSessionId)
      if (tail.count >= this.maxRecords) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "record limit reached")
      const seq = tail.lastSeq === undefined ? 0 : tail.lastSeq + 1
      const id = input.id ?? `${safeSessionId}:${seq}`
      const record = createRecord(safeSessionId, seq, id, input, this.now())
      ensureJsonBound(record, this.maxEntryBytes)
      if (tail.ids.has(record.id)) throw new TranscriptStoreError("TRANSCRIPT_CONFLICT", "record id already exists")
      const line = `${JSON.stringify(record)}\n`
      try {
        await this.appendLine(safeSessionId, line)
      } catch (error) {
        this.tails.delete(safeSessionId)
        throw error
      }
      tail.size += Buffer.byteLength(line, "utf8")
      tail.lastSeq = seq
      tail.count += 1
      tail.ids.add(record.id)
      return record
    })
  }

  /** The cached tail while the file is the size this store left it; otherwise the file is read again. */
  private async tailOf(sessionId: string): Promise<TranscriptTail> {
    let size: number
    try {
      const entry = await lstat(await this.pathFor(sessionId))
      if (!entry.isFile()) throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript is not a regular file")
      size = entry.size
      if (size > this.byteLimit()) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript exceeds the configured size")
    } catch (error) {
      if (error instanceof TranscriptStoreError) throw error
      if (!isNotFound(error)) throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript cannot be read")
      size = 0
    }
    const cached = this.tails.get(sessionId)
    if (cached !== undefined && cached.size === size) return cached
    const records = await this.readInternal(sessionId)
    const tail: TranscriptTail = { size, lastSeq: records.at(-1)?.seq, count: records.length, ids: new Set(records.map((record) => record.id)) }
    this.tails.set(sessionId, tail)
    return tail
  }

  async read(sessionId: string, options: TranscriptReadOptions = {}): Promise<readonly TranscriptRecord[]> {
    const safeSessionId = validateSessionId(sessionId)
    const { maxRecords, maxBytes } = validateReadOptions(options, this.maxRecords)
    const records = await this.readInternal(safeSessionId)
    const afterSeq = options.afterSeq ?? -1
    const selected: TranscriptRecord[] = []
    let bytes = 0
    for (const record of records) {
      if (record.seq <= afterSeq) continue
      if (selected.length >= maxRecords) break
      const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8")
      if (maxBytes !== undefined && bytes + recordBytes > maxBytes) {
        if (selected.length === 0) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript read exceeds the byte limit")
        break
      }
      selected.push(record)
      bytes += recordBytes
    }
    return Object.freeze(selected)
  }

  async recover(sessionId: string): Promise<TranscriptRecoveryResult> {
    const safeSessionId = validateSessionId(sessionId)
    return this.withLock(safeSessionId, async () => {
      let text: string
      try {
        text = await readTranscriptText(await this.pathFor(safeSessionId), this.byteLimit())
      } catch (error) {
        if (isNotFound(error)) return Object.freeze({ sessionId: safeSessionId, retainedRecords: 0, discardedBytes: 0 })
        if (error instanceof TranscriptStoreError) throw error
        throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript cannot be read")
      }
      let fullRecords: TranscriptRecord[] | undefined
      let parseError: unknown
      try {
        fullRecords = parseTranscriptText(safeSessionId, text, this.maxEntryBytes, this.maxRecords)
      } catch (error) {
        parseError = error
      }
      if (fullRecords !== undefined) {
        if (!text.endsWith("\n")) await this.writeRecords(safeSessionId, fullRecords)
        return Object.freeze({ sessionId: safeSessionId, retainedRecords: fullRecords.length, discardedBytes: 0 })
      }
      if (text.endsWith("\n")) throw parseError
      const lastNewline = text.lastIndexOf("\n")
      if (lastNewline < 0) throw parseError
      const tail = text.slice(lastNewline + 1)
      if (!isIncompleteJsonTail(tail)) throw parseError
      const prefix = text.slice(0, lastNewline + 1)
      const retained = parseTranscriptText(safeSessionId, prefix, this.maxEntryBytes, this.maxRecords)
      const discardedBytes = Buffer.byteLength(tail, "utf8")
      await this.writeRecords(safeSessionId, retained)
      return Object.freeze({ sessionId: safeSessionId, retainedRecords: retained.length, discardedBytes })
    })
  }

  async branch(sessionId: string, targetSessionId?: string): Promise<string> {
    const sourceId = validateSessionId(sessionId)
    const requestedTarget = targetSessionId === undefined ? undefined : validateSessionId(targetSessionId)
    if (requestedTarget === sourceId) throw new TranscriptStoreError("TRANSCRIPT_CONFLICT", "branch target must differ from source")
    // Both locks are taken in sorted order, so branch(a, b) and branch(b, a) cannot wait on each other.
    // A generated target starts with the source id, so it already sorts after it.
    if (requestedTarget === undefined) {
      return this.withLock(sourceId, async () => {
        const target = await this.nextBranchId(sourceId)
        return this.withLock(target, () => this.copyBranch(sourceId, target))
      })
    }
    const [first, second] = [sourceId, requestedTarget].sort()
    return this.withLock(first!, () => this.withLock(second!, () => this.copyBranch(sourceId, requestedTarget)))
  }

  private async copyBranch(sourceId: string, target: string): Promise<string> {
    const source = await this.readInternal(sourceId)
    if ((await this.readInternal(target)).length > 0) throw new TranscriptStoreError("TRANSCRIPT_CONFLICT", "branch target already exists")
    const records = source.map((record, index) => createRecord(target, index, `${target}:${index}`, {
      kind: record.kind,
      payload: record.payload,
      ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
    }, record.at))
    await this.writeRecords(target, records)
    return target
  }

  async compact(sessionId: string, options: TranscriptCompactionOptions): Promise<TranscriptCompactionResult> {
    const safeSessionId = validateSessionId(sessionId)
    validateAppendInput(options.replacement)
    if (!Number.isSafeInteger(options.throughSeq) || options.throughSeq < 0) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "compaction sequence is invalid")
    return this.withLock(safeSessionId, async () => {
      const records = await this.readInternal(safeSessionId)
      const compacted = records.filter((record) => record.seq <= options.throughSeq).length
      if (compacted === 0) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "compaction sequence is outside the transcript")
      const retained = records.filter((record) => record.seq > options.throughSeq)
      const replacement = createRecord(safeSessionId, 0, `${safeSessionId}:compact:${options.throughSeq}`, options.replacement, this.now())
      const next = [replacement, ...retained.map((record, index) => createRecord(safeSessionId, index + 1, record.id, {
        kind: record.kind,
        payload: record.payload,
        ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
      }, record.at))]
      await this.writeRecords(safeSessionId, next)
      return Object.freeze({ sessionId: safeSessionId, compacted, retained: retained.length })
    })
  }

  async truncate(sessionId: string, options: TranscriptTruncateOptions): Promise<TranscriptTruncateResult> {
    const safeSessionId = validateSessionId(sessionId)
    if (typeof options.beforeId !== "string" || options.beforeId.length === 0) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "truncation record id is invalid")
    return this.withLock(safeSessionId, async () => {
      const records = await this.readInternal(safeSessionId)
      const at = records.findIndex((record) => record.id === options.beforeId)
      if (at < 0) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "truncation record is not in the transcript")
      await this.writeRecords(safeSessionId, records.slice(0, at))
      return Object.freeze({ sessionId: safeSessionId, removed: records.length - at, retained: at })
    })
  }

  async export(sessionId: string, options: TranscriptReadOptions = {}): Promise<string> {
    const safeSessionId = validateSessionId(sessionId)
    const records = await this.read(safeSessionId, options)
    return JSON.stringify({ version: RUNRAIL_TRANSCRIPT_VERSION, sessionId: safeSessionId, records })
  }

  async import(source: string | TranscriptBundle, targetSessionId?: string): Promise<TranscriptImportResult> {
    const bundle = await this.migrate(source)
    const target = validateSessionId(targetSessionId ?? bundle.sessionId)
    return this.withLock(target, async () => {
      const existing = await this.readInternal(target)
      const staged = [...existing]
      const existingIds = new Set(existing.map((record) => record.id))
      let imported = 0
      for (const record of bundle.records) {
        const id = target === bundle.sessionId ? record.id : `${target}:import:${record.seq}`
        if (existingIds.has(id)) continue
        if (staged.length >= this.maxRecords) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "record limit reached")
        const next = createRecord(target, staged.length, id, {
          kind: record.kind,
          payload: record.payload,
          ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
        }, record.at)
        ensureJsonBound(next, this.maxEntryBytes)
        staged.push(next)
        existingIds.add(id)
        imported += 1
      }
      if (imported > 0) await this.writeRecords(target, staged)
      return Object.freeze({ sessionId: target, imported })
    })
  }

  async replay(sessionId: string, visitor: (record: TranscriptRecord) => void | PromiseLike<void>, options: TranscriptReadOptions = {}): Promise<number> {
    if (typeof visitor !== "function") throw new TranscriptStoreError("TRANSCRIPT_INVALID", "replay visitor is invalid")
    const records = await this.read(sessionId, options)
    for (const record of records) await visitor(record)
    return records.length
  }

  async migrate(source: string | TranscriptBundle): Promise<TranscriptBundle> {
    return parseTranscriptBundle(source)
  }

  private async readInternal(sessionId: string): Promise<TranscriptRecord[]> {
    let text: string
    try {
      text = await readTranscriptText(await this.pathFor(sessionId), this.byteLimit())
    } catch (error) {
      if (isNotFound(error)) return []
      if (error instanceof TranscriptStoreError) throw error
      throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript cannot be read")
    }
    return parseTranscriptText(sessionId, text, this.maxEntryBytes, this.maxRecords)
  }

  private async writeRecords(sessionId: string, records: readonly TranscriptRecord[]): Promise<void> {
    this.tails.delete(sessionId)
    if (records.length > this.maxRecords) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript has too many records")
    for (const record of records) ensureJsonBound(record, this.maxEntryBytes)
    const content = records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    if (Buffer.byteLength(content, "utf8") > this.byteLimit()) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript exceeds the configured size")
    try {
      await ensureContainedDirectory(this.root, this.root)
      const path = await this.pathFor(sessionId)
      await writeFileAtomic(path, content, 0o600)
    } catch (error) {
      if (error instanceof TranscriptStoreError) throw error
      throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript cannot be written")
    }
  }

  private async nextBranchId(sourceId: string): Promise<string> {
    for (let index = 1; index <= 1_024; index += 1) {
      const candidate = `${sourceId}:branch:${index}`
      if ((await this.readInternal(candidate)).length === 0) return candidate
    }
    throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "branch count exceeds the configured limit")
  }

  private async pathFor(sessionId: string): Promise<string> {
    try {
      return await containedPath(this.root, join(this.root, `${sessionId}.jsonl`))
    } catch {
      throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript path is not safe")
    }
  }

  private byteLimit(): number {
    return transcriptByteLimit(this.maxEntryBytes, this.maxRecords)
  }

  private async appendLine(sessionId: string, line: string): Promise<void> {
    try {
      await ensureContainedDirectory(this.root, this.root)
      const path = await this.pathFor(sessionId)
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
      try {
        const entry = await handle.stat()
        if (!entry.isFile() || entry.nlink !== 1) throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript is not a private regular file")
        if (entry.size + Buffer.byteLength(line, "utf8") > this.byteLimit()) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript exceeds the configured size")
        await handle.chmod(0o600)
        await handle.writeFile(line, "utf8")
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof TranscriptStoreError) throw error
      throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript cannot be appended")
    }
  }

  private now(): number {
    const value = this.clock()
    if (!Number.isSafeInteger(value) || value < 0) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "clock returned an invalid timestamp")
    return value
  }

  private async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolveLock) => { release = resolveLock })
    this.locks.set(sessionId, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId)
    }
  }
}

/**
 * Reads a transcript file another process may be appending to, without changing it: no recovery,
 * no write, no lock. A last line still being written is left out.
 */
export async function peekTranscript(path: string, sessionId: string, options: { readonly maxEntryBytes?: number; readonly maxRecords?: number } = {}): Promise<readonly TranscriptRecord[]> {
  const safeSessionId = validateSessionId(sessionId)
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
  const maxRecords = options.maxRecords ?? 16_384
  const maxBytes = transcriptByteLimit(maxEntryBytes, maxRecords)
  let text: string
  try {
    text = await readTranscriptText(await containedPath(dirname(path), path), maxBytes)
  } catch (error) {
    if (isNotFound(error)) return Object.freeze([])
    if (error instanceof TranscriptStoreError) throw error
    throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript cannot be read")
  }
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1)
  return Object.freeze(parseTranscriptText(safeSessionId, complete, maxEntryBytes, maxRecords))
}

function transcriptByteLimit(maxEntryBytes: number, maxRecords: number): number {
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1024 || maxEntryBytes > 16 * 1024 * 1024 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000)
    throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript limits are invalid")
  return Math.min(maxEntryBytes * maxRecords, MAX_TRANSCRIPT_BYTES)
}

async function readTranscriptText(path: string, maxBytes: number): Promise<string> {
  try {
    return await readBoundedText(path, maxBytes, { noFollow: true })
  } catch (error) {
    if (isNotFound(error)) throw error
    if (error instanceof BoundedReadError) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript exceeds the configured size")
    throw new TranscriptStoreError("TRANSCRIPT_IO", "transcript cannot be read")
  }
}

function parseTranscriptText(sessionId: string, text: string, maxEntryBytes: number, maxRecords: number): TranscriptRecord[] {
  const records: TranscriptRecord[] = []
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript JSON is malformed")
      }
      const record = parseRecord(value, maxEntryBytes)
      if (record.sessionId !== sessionId || record.seq !== records.length) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript sequence is not contiguous")
      records.push(record)
      if (records.length > maxRecords) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript has too many records")
    }
    return records
  }

function isIncompleteJsonTail(value: string): boolean {
  const text = value.trim()
  if (text.length === 0) return false
  try {
    JSON.parse(text)
    return false
  } catch {
    // Continue with a structural check so a complete but invalid JSON record
    // fails closed while an interrupted object/string can be discarded.
  }
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        inString = false
      } else if (character.charCodeAt(0) < 0x20) {
        return false
      }
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === "{" || character === "[") {
      stack.push(character)
      continue
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "["
      if (stack.pop() !== expected) return false
    }
  }
  return inString || stack.length > 0
}

export function parseTranscriptBundle(source: string | TranscriptBundle): TranscriptBundle {
  let value: unknown = source
  if (typeof source === "string") {
    if (source.length === 0 || source.length > 64 * 1024 * 1024) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript bundle is too large")
    try {
      value = JSON.parse(source)
    } catch {
      throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript bundle JSON is malformed")
    }
  }
  if (!isRecord(value)) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript bundle must be an object")
  requireKnownKeys(value, ["version", "sessionId", "records"])
  if (value.version !== RUNRAIL_TRANSCRIPT_VERSION) throw new TranscriptStoreError("TRANSCRIPT_MIGRATION_UNSUPPORTED", "transcript version is unsupported")
  const sessionId = validateSessionId(readText(value.sessionId, "session id"))
  if (!Array.isArray(value.records) || value.records.length > 1_000_000) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "transcript records are invalid")
  const records = value.records.map((entry, index) => {
    const record = parseRecord(entry, 16 * 1024 * 1024)
    if (record.sessionId !== sessionId || record.seq !== index) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript bundle sequence is invalid")
    return record
  })
  return Object.freeze({ version: RUNRAIL_TRANSCRIPT_VERSION, sessionId, records: Object.freeze(records) })
}

function createRecord(sessionId: string, seq: number, id: string, input: TranscriptAppendInput, at: number): TranscriptRecord {
  const safeId = validateToken(input.id ?? id, "record id")
  const safeKind = validateKind(input.kind)
  if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(at) || at < 0) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "record metadata is invalid")
  const record = {
    version: RUNRAIL_TRANSCRIPT_VERSION,
    sessionId,
    seq,
    id: safeId,
    kind: safeKind,
    payload: input.payload,
    ...(input.parentId === undefined ? {} : { parentId: validateToken(input.parentId, "parent id") }),
    at,
  }
  ensureJsonBound(record, 16 * 1024 * 1024)
  return Object.freeze(record)
}

function parseRecord(value: unknown, maxBytes: number): TranscriptRecord {
  if (!isRecord(value)) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript record must be an object")
  requireKnownKeys(value, ["version", "sessionId", "seq", "id", "kind", "payload", "parentId", "at"])
  if (value.version !== RUNRAIL_TRANSCRIPT_VERSION || !Object.prototype.hasOwnProperty.call(value, "payload")) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript record version or payload is invalid")
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0 || typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0)
    throw new TranscriptStoreError("TRANSCRIPT_INVALID", "transcript record metadata is invalid")
  const record = Object.freeze({
    version: RUNRAIL_TRANSCRIPT_VERSION,
    sessionId: validateSessionId(readText(value.sessionId, "session id")),
    seq: value.seq,
    id: validateToken(readText(value.id, "record id"), "record id"),
    kind: validateKind(readText(value.kind, "record kind")),
    payload: value.payload,
    ...(value.parentId === undefined ? {} : { parentId: validateToken(readText(value.parentId, "parent id"), "parent id") }),
    at: value.at,
  })
  ensureJsonBound(record, maxBytes)
  return record
}

function validateAppendInput(value: TranscriptAppendInput): void {
  if (!isRecord(value) || typeof value.kind !== "string" || value.kind.length === 0 || !Object.prototype.hasOwnProperty.call(value, "payload"))
    throw new TranscriptStoreError("TRANSCRIPT_INVALID", "append input is invalid")
  validateKind(value.kind)
  if (value.id !== undefined) validateToken(value.id, "record id")
  if (value.parentId !== undefined) validateToken(value.parentId, "parent id")
  ensureJsonBound(value.payload, 16 * 1024 * 1024)
}

function validateReadOptions(options: TranscriptReadOptions, maxRecords: number): { readonly maxRecords: number; readonly maxBytes?: number } {
  const limit = options.maxRecords ?? maxRecords
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRecords) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "read limit is invalid")
  if (options.afterSeq !== undefined && (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < -1)) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "read cursor is invalid")
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 16 * 1024 * 1024)) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "read byte limit is invalid")
  return { maxRecords: limit, ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }
}

function validateSessionId(value: string): string {
  return validateToken(value, "session id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
}

function validateKind(value: string): string {
  return validateToken(value, "record kind", /^[a-z][a-z0-9._:-]{0,127}$/)
}

function validateToken(value: string, field: string, pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/): string {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("\0")) throw new TranscriptStoreError("TRANSCRIPT_INVALID", `${field} is invalid`)
  return value
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TranscriptStoreError("TRANSCRIPT_INVALID", `${field} is invalid`)
  return value
}

function ensureJsonBound(value: unknown, maxBytes: number): void {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new TranscriptStoreError("TRANSCRIPT_INVALID", "payload is not JSON-serializable")
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) throw new TranscriptStoreError("TRANSCRIPT_LIMIT", "payload exceeds the configured size")
}

function requireKnownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "unknown transcript fields are not permitted")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}
