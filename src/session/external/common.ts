import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { failureWords } from "../../harness/failure-words.ts"
import { RUNRAIL_TRANSCRIPT_VERSION, type TranscriptRecord } from "../../transcript/index.ts"

/**
 * What every reader of another tool's sessions shares: the workspace a listing is limited
 * to, bounded reads, the conversion into Runrail transcript records, and the trace of what was read.
 */

export const HEAD_BYTES = 128 * 1024
export const TAIL_BYTES = 64 * 1024
export const MAX_FILE_BYTES = 256 * 1024 * 1024
export const MAX_TEXT_CHARS = 32 * 1024
export const MAX_INPUT_BYTES = 16 * 1024
export const MAX_INPUT_FIELD_CHARS = 4 * 1024
export const MAX_OUTPUT_CHARS = 8 * 1024
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface Workspace {
  readonly roots: readonly string[]
}

/** Every folder the tools recorded, for a listing that is not limited to one workspace. */
export const EVERYWHERE: Workspace = Object.freeze({ roots: Object.freeze([]) })

/** Whether `cwd` is an absolute path in the workspace; every absolute path is, listing every folder. */
export function within(workspace: Workspace, cwd: unknown): boolean {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return false
  if (workspace === EVERYWHERE) return true
  const target = resolve(cwd)
  return workspace.roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
}

/** One session as a reader lists it; `external.ts` bounds its title and branch. */
export interface ListedSession {
  readonly id: string
  readonly cwd: string
  readonly title?: string
  readonly branch?: string
  readonly updatedAt: number
  readonly bytes?: number
  readonly messages?: number
}

/**
 * A tool whose sessions can be listed and read. A reader opens only that tool's session store,
 * never its credentials, and reports each path it opens to `traceRead`.
 */
export interface ExternalReader {
  /** Sessions recorded in the workspace or every folder's, newest first, at most `limit`. */
  list(workspace: Workspace, limit: number): Promise<{ readonly sessions: readonly ListedSession[]; readonly truncated: boolean }>
  /** Converts one session recorded in the workspace into `sink`; undefined when there is none. */
  read(id: string, workspace: Workspace, sink: RecordSink): Promise<ListedSession | undefined>
}

/** A session or store past the bounds a reader will read whole. */
export class TooLarge extends Error {
  constructor() {
    super("session is too large to import")
    this.name = "TooLarge"
  }
}

let observer: ((path: string, detail?: string) => void) | undefined

/**
 * Tests watch every path a reader opens, how much of it ("head" or "whole"), and every query it
 * runs, to prove no credential is read and a listing reads only bounded slices.
 */
export function observeReads(watch: ((path: string, detail?: string) => void) | undefined): void {
  observer = watch
}

export function traceRead(path: string, detail?: string): void {
  observer?.(path, detail)
}

/** A folder's entries; none when it cannot be read. */
export async function entries(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** A plain file's time and size. Links are skipped so a session folder cannot point a reader at another file. */
export async function fileAt(path: string): Promise<{ readonly mtime: number; readonly bytes: number } | undefined> {
  const info = await lstat(path).catch(() => undefined)
  return info === undefined || !info.isFile() ? undefined : { mtime: Math.floor(info.mtimeMs), bytes: info.size }
}

/** The first `max` bytes of a file as text. */
export async function readHead(path: string, max: number): Promise<string> {
  traceRead(path, "head")
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(max)
    const { bytesRead } = await handle.read(buffer, 0, max, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

export async function headAndTail(path: string, size: number): Promise<{ head: Record<string, unknown>[]; tail: Record<string, unknown>[] }> {
  traceRead(path, "head")
  const handle = await open(path, "r")
  try {
    const headLength = Math.min(size, HEAD_BYTES)
    const headBuffer = Buffer.alloc(headLength)
    await handle.read(headBuffer, 0, headLength, 0)
    const head = jsonLines(headBuffer.toString("utf8"), false, headLength < size)
    if (size <= HEAD_BYTES) return { head, tail: [] }
    const tailLength = Math.min(size - HEAD_BYTES, TAIL_BYTES)
    const tailBuffer = Buffer.alloc(tailLength)
    await handle.read(tailBuffer, 0, tailLength, size - tailLength)
    return { head, tail: jsonLines(tailBuffer.toString("utf8"), true, false) }
  } finally {
    await handle.close()
  }
}

export function jsonLines(text: string, dropFirst: boolean, dropLast: boolean): Record<string, unknown>[] {
  const lines = text.split("\n")
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  const result: Record<string, unknown>[] = []
  for (const line of lines) {
    const value = parseLine(line)
    if (value !== undefined) result.push(value)
  }
  return result
}

export function parseLine(line: string): Record<string, unknown> | undefined {
  if (line.length === 0 || line.charCodeAt(0) !== 123) return undefined
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

export async function forEachLine(path: string, visit: (line: Record<string, unknown>) => void): Promise<void> {
  traceRead(path, "whole")
  const stream = createReadStream(path, { encoding: "utf8" })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const value = parseLine(line)
      if (value !== undefined) visit(value)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

/** Collects converted records, keeping the newest `max` and synthesizing one turn per prompt. */
export class RecordSink {
  truncated = false
  readonly #max: number
  readonly #from: number

  get max(): number {
    return this.#max
  }

  /** Every record converted, kept or not. */
  get total(): number {
    return this.#count
  }

  /** Where in the session the kept records start. */
  get first(): number {
    return this.#count - Math.min(this.#items.length, this.#max)
  }

  readonly #items: SinkItem[] = []
  /** The last records before `from`, to check that the session still starts as it did. */
  readonly #before: SinkItem[] = []
  readonly #toolNames = new Map<string, string>()
  #count = 0
  #turn = 0
  #at: number

  /** `from` skips the records a reader already brought in; everything is still converted, so turns number the same. */
  constructor(max: number, fallbackAt: number, from = 0) {
    this.#max = max
    this.#at = fallbackAt
    this.#from = from
  }

  time(value: unknown): number {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN
    if (Number.isFinite(parsed) && parsed > 0) this.#at = Math.floor(parsed)
    return this.#at
  }

  user(text: string, at: number): void {
    this.#turn += 1
    this.#push("message.user", { text: clip(text, MAX_TEXT_CHARS) }, at)
  }

  assistant(text: string, at: number): void {
    if (text.trim().length === 0) return
    this.#push("assistant.message", { type: "assistant.message", turnId: this.#turnId(), text: clip(text, MAX_TEXT_CHARS), at }, at)
  }

  toolStarted(callId: string, name: string, input: unknown, at: number): void {
    const call = clip(callId, 256)
    const tool = clip(name, 128)
    this.#toolNames.set(call, tool)
    const bounded = boundInput(input)
    this.#push("tool.started", { type: "tool.started", turnId: this.#turnId(), callId: call, name: tool, ...(bounded === undefined ? {} : { input: bounded }), at }, at)
  }

  toolCompleted(callId: string, name: string | undefined, ok: boolean, output: string | undefined, at: number): void {
    const call = clip(callId, 256)
    const tool = name === undefined ? this.#toolNames.get(call) : clip(name, 128)
    this.#toolNames.delete(call)
    if (tool === undefined) return
    this.#push("tool.completed", {
      type: "tool.completed",
      turnId: this.#turnId(),
      callId: call,
      name: tool,
      ok,
      ...(output === undefined || output.length === 0 ? {} : { output: tailText(output, MAX_OUTPUT_CHARS) }),
      // The event protocol needs a message; the tool's own last words say why, where it left any.
      ...(ok ? {} : { error: { code: "TOOL_FAILED", message: (output === undefined ? undefined : failureWords(output)) ?? "The tool call failed" } }),
      at,
    }, at)
  }

  records(sessionId: string): readonly TranscriptRecord[] {
    return Object.freeze(this.#items.slice(-this.#max).map((item, seq) => Object.freeze({
      version: RUNRAIL_TRANSCRIPT_VERSION,
      sessionId,
      seq,
      id: `${sessionId}:${seq}`,
      kind: item.kind,
      payload: item.payload,
      at: item.at,
    })))
  }

  /** A digest of the last records up to the end of the session. */
  digest(): string {
    return digestOf([...this.#before, ...this.#items].slice(-CHECKED))
  }

  /** A digest of the last records before `from`, matching what `digest` gave when the session ended there. */
  digestBefore(): string {
    return digestOf(this.#before)
  }

  #turnId(): string {
    return `import-${this.#turn}`
  }

  #push(kind: string, payload: unknown, at: number): void {
    const index = this.#count
    this.#count += 1
    if (index < this.#from) {
      this.#before.push({ kind, payload, at })
      if (this.#before.length > CHECKED) this.#before.shift()
      return
    }
    this.#items.push({ kind, payload, at })
    if (this.#items.length > this.#max) {
      this.truncated = true
      // Trimmed in batches: shifting a long array on every push makes a long session quadratic.
      if (this.#items.length >= this.#max * 2) this.#items.splice(0, this.#items.length - this.#max)
    }
  }
}

interface SinkItem {
  readonly kind: string
  readonly payload: unknown
  readonly at: number
}

/** How many records a refresh compares to tell that a session grew rather than changed. */
const CHECKED = 8

/** Times are left out: a record without one is stamped when it is read. */
function digestOf(items: readonly SinkItem[]): string {
  const hash = createHash("sha256")
  for (const item of items) {
    const { at: _at, ...payload } = isRecord(item.payload) ? item.payload : { value: item.payload }
    hash.update(`${item.kind}\0${JSON.stringify(payload)}\n`)
  }
  return hash.digest("hex").slice(0, 32)
}

/** Context another agent injected as a user message (environment, instructions, command echoes). */
export function isInjected(text: string): boolean {
  const value = text.trim()
  if (value.length === 0) return true
  if (value.startsWith("<command-") || value.startsWith("<local-command-") || value.startsWith("# AGENTS.md instructions")) return true
  return /^<([A-Za-z][A-Za-z0-9_ -]{0,63})>[\s\S]*<\/\1>$/.test(value)
}

export function partsText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim().length === 0 ? undefined : content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
  return text.trim().length === 0 ? undefined : text
}

export function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (value.length > MAX_INPUT_BYTES * 4) return undefined
  return safeJson(value)
}

/** Keeps small tool inputs whole; for larger ones keeps short scalar fields only. */
export function boundInput(input: unknown): unknown {
  if (input === undefined || input === null) return undefined
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(input)
  } catch {
    return undefined
  }
  if (encoded === undefined) return undefined
  if (Buffer.byteLength(encoded, "utf8") <= MAX_INPUT_BYTES) return input
  if (!isRecord(input)) return undefined
  const result: Record<string, unknown> = {}
  let bytes = 0
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    const kept = typeof value === "string" ? clip(value, MAX_INPUT_FIELD_CHARS) : typeof value === "number" || typeof value === "boolean" ? value : undefined
    if (kept === undefined) continue
    bytes += key.length + (typeof kept === "string" ? kept.length : 8)
    if (bytes > MAX_INPUT_BYTES) break
    result[key] = kept
  }
  return result
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function oneLine(value: string, max: number): string {
  return clip(value.replace(/\s+/g, " ").trim(), max)
}

export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}

export function tailText(value: string, max: number): string {
  if (value.length <= max) return value
  let start = value.length - max
  const code = value.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return value.slice(start)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

