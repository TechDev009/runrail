import { lstat, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { RUNRAIL_TRANSCRIPT_VERSION, type TranscriptBundle } from "../transcript/index.ts"
import {
  boundInput,
  clip,
  entries,
  EVERYWHERE,
  forEachLine,
  headAndTail,
  ID_PATTERN,
  isInjected,
  isRecord,
  MAX_FILE_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_TEXT_CHARS,
  oneLine,
  parseArguments,
  partsText,
  RecordSink,
  safeJson,
  tailText,
  TooLarge,
  within,
  type ExternalReader,
  type ListedSession,
  type Workspace,
} from "./external/common.ts"
import { copilotReader } from "./external/copilot.ts"
import { geminiReader } from "./external/gemini.ts"
import { gooseReader } from "./external/goose.ts"
import { openCodeReader } from "./external/opencode.ts"

/**
 * Read-only access to sessions other coding agents stored on this machine, so a thread can
 * continue one. Listing reads only a bounded head and tail of each file. Importing converts
 * user text, assistant text, and bounded tool calls into Runrail transcript records; images,
 * reasoning, and injected instructions are dropped. Nothing here logs or persists content: the
 * caller writes the converted records to the thread's own local transcript.
 */
export const EXTERNAL_SESSION_SOURCES = Object.freeze(["claude-code", "codex", "pi", "opencode", "gemini", "goose", "copilot"] as const)
export type ExternalSessionSource = (typeof EXTERNAL_SESSION_SOURCES)[number]

/** Where each tool keeps its sessions. A host that passes its own roots and leaves one of the later four out skips that tool. */
export interface ExternalSessionRoots {
  readonly claudeCode: string
  readonly codex: string
  readonly pi: string
  /** OpenCode's data folder, holding `opencode.db`. */
  readonly opencode?: string
  /** Gemini CLI's `tmp` folder, one folder in it per project. */
  readonly gemini?: string
  /** Goose's sessions folder, holding `sessions.db`. */
  readonly goose?: string
  /** Copilot CLI's `session-state` folder, one folder in it per session. */
  readonly copilot?: string
}

export interface ExternalSessionSummary {
  readonly source: ExternalSessionSource
  readonly id: string
  readonly title?: string
  readonly updatedAt: number
  /** The session file's size; a tool that keeps its sessions in a database gives `messages` instead. */
  readonly bytes?: number
  readonly messages?: number
  readonly branch?: string
  /** The folder the tool recorded the session in. */
  readonly cwd?: string
  /** Listing every folder: that folder no longer exists, so no project can hold the session. */
  readonly missing?: true
}

export interface ExternalSessionList {
  readonly sessions: readonly ExternalSessionSummary[]
  readonly truncated?: true
}

export interface ExternalSessionTranscript {
  readonly source: ExternalSessionSource
  readonly id: string
  readonly title?: string
  readonly bundle: TranscriptBundle
  /** True when the oldest messages were dropped to stay within the record bound. */
  readonly truncated: boolean
  /** How the session ends, for a later refresh: every record converted, and a digest of the last ones. */
  readonly mark: ExternalSessionMark
  /** Where in the session the bundle's first record is. */
  readonly first: number
  /** Read `after` a mark: whether the session still starts as it did then, so only what follows is new. */
  readonly grew?: boolean
}

export interface ExternalSessionMark {
  readonly records: number
  readonly digest: string
}

export type ExternalSessionErrorCode = "EXTERNAL_INVALID" | "EXTERNAL_NOT_FOUND" | "EXTERNAL_LIMIT"

export class ExternalSessionError extends Error {
  constructor(readonly code: ExternalSessionErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "ExternalSessionError"
  }
}

export const EXTERNAL_SOURCE_LABELS: Readonly<Record<ExternalSessionSource, string>> = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  goose: "Goose",
  copilot: "Copilot CLI",
})

const MAX_LIST = 1_000
const MAX_CANDIDATES = 5_000
const MAX_HEAD_READS = 1_500
const DEFAULT_MAX_RECORDS = 4_000
const MAX_TITLE_CHARS = 120
const MAX_BRANCH_CHARS = 128
const MAX_CWD_CHARS = 4_096
const CODEX_FILE = /^rollout-.+-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/
const PI_FILE = /^.+_([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/

/** Default session folders, honoring each tool's own home-directory override when absolute. */
export function defaultExternalSessionRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): ExternalSessionRoots {
  const dir = (value: string | undefined, fallback: string) => value !== undefined && isAbsolute(value) ? value : fallback
  const data = dir(env.XDG_DATA_HOME, join(home, ".local", "share"))
  return Object.freeze({
    claudeCode: join(dir(env.CLAUDE_CONFIG_DIR, join(home, ".claude")), "projects"),
    codex: join(dir(env.CODEX_HOME, join(home, ".codex")), "sessions"),
    pi: join(dir(env.PI_CODING_AGENT_DIR, join(home, ".pi", "agent")), "sessions"),
    opencode: join(data, "opencode"),
    gemini: join(home, ".gemini", "tmp"),
    goose: join(data, "goose", "sessions"),
    copilot: join(home, ".copilot", "session-state"),
  })
}

export function parseExternalSource(value: unknown): ExternalSessionSource {
  if (typeof value === "string" && (EXTERNAL_SESSION_SOURCES as readonly string[]).includes(value)) return value as ExternalSessionSource
  throw new ExternalSessionError("EXTERNAL_INVALID", `source must be one of ${EXTERNAL_SESSION_SOURCES.join(", ")}`)
}

export function parseExternalId(value: unknown): string {
  if (typeof value === "string" && ID_PATTERN.test(value)) return value
  throw new ExternalSessionError("EXTERNAL_INVALID", "session id is invalid")
}

interface Candidate {
  readonly source: ExternalSessionSource
  readonly id: string
  readonly path: string
  readonly mtime: number
  readonly bytes: number
}

/**
 * Lists sessions recorded in `cwd` or below it, newest first. With `everywhere`, lists every
 * folder's sessions instead, each with its folder; reading one still needs a workspace
 * that holds it, so a folder that is not a project must become one first.
 */
export async function listExternalSessions(options: {
  readonly cwd: string
  readonly everywhere?: boolean
  readonly roots?: ExternalSessionRoots
  readonly limit?: number
}): Promise<ExternalSessionList> {
  const limit = options.limit ?? 200
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST) throw new ExternalSessionError("EXTERNAL_INVALID", `limit must be an integer from 1 to ${MAX_LIST}`)
  const roots = options.roots ?? defaultExternalSessionRoots()
  const workspace = options.everywhere === true ? EVERYWHERE : await workspaceOf(options.cwd)
  const found = await Promise.all([
    claudeCandidates(roots.claudeCode, workspace),
    codexCandidates(roots.codex),
    piCandidates(roots.pi, workspace),
  ])
  const candidates = found.flat().sort((a, b) => b.mtime - a.mtime)
  const sessions: ExternalSessionSummary[] = []
  let reads = 0
  let index = 0
  for (; index < candidates.length && sessions.length < limit && reads < MAX_HEAD_READS; index += 1) {
    const candidate = candidates[index]
    if (candidate === undefined) continue
    reads += 1
    const summary = await summarize(candidate, workspace).catch(() => undefined)
    if (summary !== undefined) sessions.push(summary)
  }
  const others = await Promise.all(
    readersOf(roots).map(([source, reader]) =>
      reader.list(workspace, limit).then(
        (result) => ({ sessions: result.sessions.map((session) => summaryOf(source, session)), truncated: result.truncated }),
        // A store that cannot be read lists nothing rather than failing every other tool's list.
        () => ({ sessions: [], truncated: false }),
      ),
    ),
  )
  const merged = [...sessions, ...others.flatMap((other) => other.sessions)].sort((a, b) => b.updatedAt - a.updatedAt)
  const truncated = index < candidates.length || found.some((list) => list.length >= MAX_CANDIDATES) || others.some((other) => other.truncated) || merged.length > limit
  const kept = merged.slice(0, limit)
  const listed = workspace === EVERYWHERE ? await markMissing(kept) : kept
  return Object.freeze({ sessions: Object.freeze(listed), ...(truncated ? { truncated: true as const } : {}) })
}

type ReaderSource = Exclude<ExternalSessionSource, "claude-code" | "codex" | "pi">

/** The tools read through a reader of their own, for the roots the host gave. */
function readersOf(roots: ExternalSessionRoots): readonly (readonly [ReaderSource, ExternalReader])[] {
  return [
    ...(roots.opencode === undefined ? [] : [["opencode", openCodeReader(roots.opencode)] as const]),
    ...(roots.gemini === undefined ? [] : [["gemini", geminiReader(roots.gemini)] as const]),
    ...(roots.goose === undefined ? [] : [["goose", gooseReader(roots.goose)] as const]),
    ...(roots.copilot === undefined ? [] : [["copilot", copilotReader(roots.copilot)] as const]),
  ]
}

function summaryOf(source: ExternalSessionSource, session: ListedSession): ExternalSessionSummary {
  const title = session.title === undefined ? undefined : oneLine(session.title, MAX_TITLE_CHARS)
  const branch = session.branch === undefined ? undefined : oneLine(session.branch, MAX_BRANCH_CHARS)
  const cwd = resolve(session.cwd)
  return Object.freeze({
    source,
    id: session.id,
    ...(title === undefined || title.length === 0 ? {} : { title }),
    updatedAt: session.updatedAt,
    ...(session.bytes === undefined ? {} : { bytes: session.bytes }),
    ...(session.messages === undefined ? {} : { messages: session.messages }),
    ...(branch === undefined || branch.length === 0 ? {} : { branch }),
    ...(cwd.length > MAX_CWD_CHARS ? {} : { cwd }),
  })
}

/** Each distinct folder is looked at once. */
async function markMissing(sessions: readonly ExternalSessionSummary[]): Promise<ExternalSessionSummary[]> {
  const folders = new Map<string, Promise<boolean>>()
  const exists = (cwd: string): Promise<boolean> => {
    let known = folders.get(cwd)
    if (known === undefined) {
      known = stat(cwd).then((info) => info.isDirectory(), () => false)
      folders.set(cwd, known)
    }
    return known
  }
  return Promise.all(sessions.map(async (session) => (session.cwd === undefined || (await exists(session.cwd)) ? session : Object.freeze({ ...session, missing: true as const }))))
}

/**
 * Reads one session and converts it to a transcript bundle. A session recorded outside `cwd`
 * is reported as not found, the same as a missing one.
 */
export async function readExternalSession(options: {
  readonly cwd: string
  readonly source: ExternalSessionSource
  readonly id: string
  readonly roots?: ExternalSessionRoots
  readonly maxRecords?: number
  /** Only the records after this mark; the bound then counts those alone. */
  readonly after?: ExternalSessionMark
}): Promise<ExternalSessionTranscript> {
  const source = parseExternalSource(options.source)
  const id = parseExternalId(options.id)
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 16_384) throw new ExternalSessionError("EXTERNAL_INVALID", "record bound is invalid")
  const roots = options.roots ?? defaultExternalSessionRoots()
  const after = options.after
  if (after !== undefined && (!Number.isSafeInteger(after.records) || after.records < 1 || !/^[0-9a-f]{32}$/.test(after.digest))) throw new ExternalSessionError("EXTERNAL_INVALID", "session mark is invalid")
  const workspace = await workspaceOf(options.cwd)
  const reader = readersOf(roots).find(([name]) => name === source)?.[1]
  if (reader !== undefined) return readThrough(reader, source, id, workspace, new RecordSink(maxRecords, Date.now(), after?.records), after)
  if (source !== "claude-code" && source !== "codex" && source !== "pi") throw new ExternalSessionError("EXTERNAL_NOT_FOUND", "session was not found for this workspace")
  const candidate = await locate(source, id, roots, workspace)
  const summary = candidate === undefined ? undefined : await summarize(candidate, workspace).catch(() => undefined)
  if (candidate === undefined || summary === undefined) throw new ExternalSessionError("EXTERNAL_NOT_FOUND", "session was not found for this workspace")
  if (candidate.bytes > MAX_FILE_BYTES) throw new ExternalSessionError("EXTERNAL_LIMIT", "session file is too large to import")
  const sink = new RecordSink(maxRecords, candidate.mtime, after?.records)
  if (source === "claude-code") await forEachLine(candidate.path, (line) => claudeRecord(line, sink))
  else if (source === "codex") await forEachLine(candidate.path, (line) => codexRecord(line, sink))
  else await piRecords(candidate.path, sink)
  return transcriptOf(source, id, summary.title, sink, after)
}

async function readThrough(reader: ExternalReader, source: ExternalSessionSource, id: string, workspace: Workspace, sink: RecordSink, after: ExternalSessionMark | undefined): Promise<ExternalSessionTranscript> {
  let found: ListedSession | undefined
  try {
    found = await reader.read(id, workspace, sink)
  } catch (error) {
    if (error instanceof TooLarge) throw new ExternalSessionError("EXTERNAL_LIMIT", "session is too large to import")
    throw error
  }
  if (found === undefined) throw new ExternalSessionError("EXTERNAL_NOT_FOUND", "session was not found for this workspace")
  return transcriptOf(source, id, summaryOf(source, found).title, sink, after)
}

function transcriptOf(source: ExternalSessionSource, id: string, title: string | undefined, sink: RecordSink, after: ExternalSessionMark | undefined): ExternalSessionTranscript {
  const sessionId = `import-${source}-${id}`.slice(0, 200)
  return Object.freeze({
    source,
    id,
    ...(title === undefined ? {} : { title }),
    bundle: Object.freeze({ version: RUNRAIL_TRANSCRIPT_VERSION, sessionId, records: sink.records(sessionId) }),
    truncated: sink.truncated,
    mark: Object.freeze({ records: sink.total, digest: sink.digest() }),
    first: sink.first,
    ...(after === undefined ? {} : { grew: sink.total >= after.records && sink.digestBefore() === after.digest }),
  })
}

// ---------------------------------------------------------------------------------------------
// Discovery

async function workspaceOf(cwd: string): Promise<Workspace> {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new ExternalSessionError("EXTERNAL_INVALID", "workspace must be an absolute path")
  const resolved = resolve(cwd)
  const real = await realpath(resolved).catch(() => resolved)
  return { roots: resolved === real ? [resolved] : [resolved, real] }
}

/** Claude Code names a project folder after its path with every non-alphanumeric turned into "-". */
function claudeFolders(workspace: Workspace): readonly string[] {
  return workspace.roots.map((root) => root.replace(/[^A-Za-z0-9]/g, "-"))
}

/** Pi names a session folder `--<path without the leading slash, separators as "-">--`. */
function piFolders(workspace: Workspace): readonly string[] {
  return workspace.roots.map((root) => root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-"))
}

async function claudeCandidates(root: string, workspace: Workspace): Promise<Candidate[]> {
  const prefixes = claudeFolders(workspace)
  const folders = (await entries(root)).filter((entry) => entry.isDirectory() && (workspace === EVERYWHERE || prefixes.some((prefix) => entry.name === prefix || entry.name.startsWith(`${prefix}-`))))
  const result: Candidate[] = []
  for (const folder of folders) {
    for (const file of await entries(join(root, folder.name))) {
      if (result.length >= MAX_CANDIDATES) return result
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue
      const id = file.name.slice(0, -".jsonl".length)
      if (!ID_PATTERN.test(id)) continue
      const candidate = await candidateAt("claude-code", id, join(root, folder.name, file.name))
      if (candidate !== undefined) result.push(candidate)
    }
  }
  return result
}

async function codexCandidates(root: string): Promise<Candidate[]> {
  const result: Candidate[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    const list = (await entries(dir)).sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of list) {
      if (result.length >= MAX_CANDIDATES) return
      if (depth < 3 && entry.isDirectory() && /^\d{1,4}$/.test(entry.name)) await walk(join(dir, entry.name), depth + 1)
      else if (entry.isFile()) {
        const match = CODEX_FILE.exec(entry.name)
        const id = match?.[1]
        if (id === undefined) continue
        const candidate = await candidateAt("codex", id, join(dir, entry.name))
        if (candidate !== undefined) result.push(candidate)
      }
    }
  }
  await walk(root, 0)
  return result
}

async function piCandidates(root: string, workspace: Workspace): Promise<Candidate[]> {
  const encoded = piFolders(workspace)
  const folders = (await entries(root)).filter((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith("--") || !entry.name.endsWith("--")) return false
    const inner = entry.name.slice(2, -2)
    return workspace === EVERYWHERE || encoded.some((name) => inner === name || inner.startsWith(`${name}-`))
  })
  const result: Candidate[] = []
  for (const folder of folders) {
    for (const file of await entries(join(root, folder.name))) {
      if (result.length >= MAX_CANDIDATES) return result
      const id = file.isFile() ? PI_FILE.exec(file.name)?.[1] : undefined
      if (id === undefined) continue
      const candidate = await candidateAt("pi", id, join(root, folder.name, file.name))
      if (candidate !== undefined) result.push(candidate)
    }
  }
  return result
}

async function locate(source: ExternalSessionSource, id: string, roots: ExternalSessionRoots, workspace: Workspace): Promise<Candidate | undefined> {
  const list = source === "claude-code"
    ? await claudeCandidates(roots.claudeCode, workspace)
    : source === "codex"
      ? await codexCandidates(roots.codex)
      : await piCandidates(roots.pi, workspace)
  return list.find((candidate) => candidate.id === id)
}

async function candidateAt(source: ExternalSessionSource, id: string, path: string): Promise<Candidate | undefined> {
  // Symlinks are skipped so a session folder cannot point the reader at another file.
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  return { source, id, path, mtime: Math.floor(info.mtimeMs), bytes: info.size }
}


// ---------------------------------------------------------------------------------------------
// Summaries

async function summarize(candidate: Candidate, workspace: Workspace): Promise<ExternalSessionSummary | undefined> {
  const meta = await metaOf(candidate)
  if (meta === undefined || !within(workspace, meta.cwd)) return undefined
  const title = meta.title === undefined ? undefined : oneLine(meta.title, MAX_TITLE_CHARS)
  const branch = meta.branch === undefined ? undefined : oneLine(meta.branch, MAX_BRANCH_CHARS)
  // `within` has checked it is an absolute path.
  const cwd = resolve(meta.cwd as string)
  return Object.freeze({
    source: candidate.source,
    id: candidate.id,
    ...(title === undefined || title.length === 0 ? {} : { title }),
    updatedAt: candidate.mtime,
    bytes: candidate.bytes,
    ...(branch === undefined || branch.length === 0 ? {} : { branch }),
    ...(cwd.length > MAX_CWD_CHARS ? {} : { cwd }),
  })
}

interface Meta {
  readonly cwd?: unknown
  readonly title?: string
  readonly branch?: string
}

// Codex keeps every project's sessions in one tree, so each listing would otherwise re-read
// thousands of heads only to drop those recorded elsewhere. A file that has not changed is not read again.
const MAX_META_CACHE = 8_192
const metaCache = new Map<string, { readonly source: ExternalSessionSource; readonly mtime: number; readonly bytes: number; readonly meta: Meta | undefined }>()

async function metaOf(candidate: Candidate): Promise<Meta | undefined> {
  const cached = metaCache.get(candidate.path)
  if (cached !== undefined && cached.source === candidate.source && cached.mtime === candidate.mtime && cached.bytes === candidate.bytes) return cached.meta
  const { head, tail } = await headAndTail(candidate.path, candidate.bytes)
  const meta = candidate.source === "claude-code"
    ? claudeMeta(head, tail)
    : candidate.source === "codex"
      ? codexMeta(head, candidate.id)
      : piMeta(head, tail, candidate.id)
  metaCache.delete(candidate.path)
  metaCache.set(candidate.path, { source: candidate.source, mtime: candidate.mtime, bytes: candidate.bytes, meta })
  if (metaCache.size > MAX_META_CACHE) metaCache.delete(metaCache.keys().next().value!)
  return meta
}

function claudeMeta(head: readonly Record<string, unknown>[], tail: readonly Record<string, unknown>[]): Meta | undefined {
  let cwd: unknown
  let branch: string | undefined
  let firstPrompt: string | undefined
  let named: string | undefined
  for (const line of [...head, ...tail]) {
    if (line.type === "custom-title" && typeof line.customTitle === "string") named = line.customTitle
    else if (line.type === "summary" && typeof line.summary === "string" && named === undefined) named = line.summary
  }
  for (const line of head) {
    if (cwd === undefined && typeof line.cwd === "string") cwd = line.cwd
    if (branch === undefined && typeof line.gitBranch === "string" && line.gitBranch.length > 0) branch = line.gitBranch
    if (firstPrompt === undefined && line.type === "user" && line.isMeta !== true && line.isSidechain !== true) firstPrompt = claudeUserText(line)
  }
  if (cwd === undefined) return undefined
  const title = named ?? firstPrompt
  return { cwd, ...(title === undefined ? {} : { title }), ...(branch === undefined ? {} : { branch }) }
}

function codexMeta(head: readonly Record<string, unknown>[], id: string): Meta | undefined {
  const first = head[0]
  const payload = isRecord(first) && first.type === "session_meta" && isRecord(first.payload) ? first.payload : undefined
  if (payload === undefined || (payload.id !== undefined && payload.id !== id)) return undefined
  // Sessions a subagent ran are part of their parent's session, not threads of their own.
  if (isRecord(payload.source)) return undefined
  const branch = isRecord(payload.git) && typeof payload.git.branch === "string" ? payload.git.branch : undefined
  let title: string | undefined
  for (const line of head) {
    const item = isRecord(line.payload) ? line.payload : undefined
    if (line.type !== "response_item" || item?.type !== "message" || item.role !== "user") continue
    title = codexText(item.content)
    if (title !== undefined) break
  }
  return { cwd: payload.cwd, ...(title === undefined ? {} : { title }), ...(branch === undefined ? {} : { branch }) }
}

function piMeta(head: readonly Record<string, unknown>[], tail: readonly Record<string, unknown>[], id: string): Meta | undefined {
  const first = head[0]
  if (!isRecord(first) || first.type !== "session" || (first.id !== undefined && first.id !== id)) return undefined
  let named: string | undefined
  for (const line of [...head, ...tail]) if (line.type === "session_info" && typeof line.name === "string" && line.name.trim().length > 0) named = line.name
  let firstPrompt: string | undefined
  for (const line of head) {
    const message = line.type === "message" && isRecord(line.message) ? line.message : undefined
    if (message?.role !== "user") continue
    firstPrompt = partsText(message.content)
    if (firstPrompt !== undefined) break
  }
  const title = named ?? firstPrompt
  return { cwd: first.cwd, ...(title === undefined ? {} : { title }) }
}

// ---------------------------------------------------------------------------------------------
// Conversion

function claudeRecord(line: Record<string, unknown>, sink: RecordSink): void {
  if ((line.type !== "user" && line.type !== "assistant") || line.isSidechain === true || line.isMeta === true || line.isApiErrorMessage === true || line.isCompactSummary === true) return
  const message = isRecord(line.message) ? line.message : undefined
  if (message === undefined) return
  const at = sink.time(line.timestamp)
  if (line.type === "user") {
    const content = message.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue
        sink.toolCompleted(part.tool_use_id, undefined, part.is_error !== true, typeof part.content === "string" ? part.content : partsText(part.content), at)
      }
    }
    const text = claudeUserText(line)
    if (text !== undefined) sink.user(text, at)
    return
  }
  const content = message.content
  if (typeof content === "string") {
    sink.assistant(content, at)
    return
  }
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === "text" && typeof part.text === "string") sink.assistant(part.text, at)
    else if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") sink.toolStarted(part.id, part.name, part.input, at)
  }
}

function claudeUserText(line: Record<string, unknown>): string | undefined {
  const message = isRecord(line.message) ? line.message : undefined
  const content = message?.content
  const text = typeof content === "string" ? content : partsText(content)
  if (text === undefined || isInjected(text)) return undefined
  return text
}

function codexRecord(line: Record<string, unknown>, sink: RecordSink): void {
  if (line.type !== "response_item" || !isRecord(line.payload)) return
  const item = line.payload
  const at = sink.time(line.timestamp)
  switch (item.type) {
    case "message": {
      const text = codexText(item.content)
      if (text === undefined) return
      if (item.role === "user") sink.user(text, at)
      else if (item.role === "assistant") sink.assistant(text, at)
      return
    }
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call": {
      const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined
      if (callId === undefined) return
      const name = typeof item.name === "string" ? item.name : item.type === "local_shell_call" ? "local_shell" : undefined
      if (name === undefined) return
      const input = item.type === "function_call"
        ? parseArguments(item.arguments)
        : item.type === "custom_tool_call"
          ? (typeof item.input === "string" ? { input: item.input } : item.input)
          : item.action
      sink.toolStarted(callId, name, input, at)
      return
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      if (typeof item.call_id !== "string") return
      const { text, ok } = codexOutput(item.output)
      sink.toolCompleted(item.call_id, undefined, ok, text, at)
      return
    }
    default:
      return
  }
}

function codexText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter((part): part is Record<string, unknown> => isRecord(part) && (part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string")
    .map((part) => String(part.text))
    .filter((text) => !isInjected(text))
  const text = parts.join("\n").trim()
  return text.length === 0 ? undefined : text
}

function codexOutput(output: unknown): { readonly text: string | undefined; readonly ok: boolean } {
  let value = output
  if (typeof output === "string") {
    const parsed = output.startsWith("{") ? safeJson(output) : undefined
    if (!isRecord(parsed)) return { text: output, ok: true }
    value = parsed
  }
  if (!isRecord(value)) return { text: undefined, ok: true }
  const metadata = isRecord(value.metadata) ? value.metadata : undefined
  const exit = metadata?.exit_code
  const ok = value.success === false ? false : typeof exit === "number" ? exit === 0 : true
  const text = typeof value.output === "string" ? value.output : typeof value.content === "string" ? value.content : undefined
  return { text, ok }
}

type PiOp =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "result"; readonly id: string; readonly name?: string; readonly ok: boolean; readonly output?: string }

/** One message entry, already cut to what the sink keeps, so the branch is never held at full size. */
interface PiStep {
  readonly timestamp: unknown
  readonly ops: readonly PiOp[]
}

async function piRecords(path: string, sink: RecordSink): Promise<void> {
  // Pi stores a tree; the conversation is the path from the newest entry back to the root. The
  // first pass keeps only ids, so a large file is not held in memory to find that path.
  const parents = new Map<string, string | undefined>()
  const messages = new Set<string>()
  let leaf: string | undefined
  await forEachLine(path, (line) => {
    if (line.type === "session" || typeof line.id !== "string") return
    parents.set(line.id, typeof line.parentId === "string" ? line.parentId : undefined)
    if (line.type === "message") messages.add(line.id)
    leaf = line.id
  })
  const ids: string[] = []
  const seen = new Set<string>()
  for (let id = leaf; id !== undefined && !seen.has(id) && parents.has(id); id = parents.get(id)) {
    seen.add(id)
    ids.push(id)
  }
  ids.reverse()
  // The sink keeps the newest records only, so messages older than twice that many are never read.
  let first = ids.length
  for (let kept = 0; first > 0 && kept < sink.max * 2; first -= 1) if (messages.has(ids[first - 1]!)) kept += 1
  if (first > 0) sink.truncated = true
  const position = new Map(ids.slice(first).map((id, index) => [id, index]))
  const chain: (PiStep | undefined)[] = new Array(ids.length - first)
  await forEachLine(path, (line) => {
    if (line.type === "session" || typeof line.id !== "string") return
    const index = position.get(line.id)
    if (index !== undefined) chain[index] = piStep(line)
  })
  for (const step of chain) {
    if (step === undefined) continue
    const at = sink.time(step.timestamp)
    for (const op of step.ops) {
      if (op.kind === "user") sink.user(op.text, at)
      else if (op.kind === "assistant") sink.assistant(op.text, at)
      else if (op.kind === "tool") sink.toolStarted(op.id, op.name, op.input, at)
      else sink.toolCompleted(op.id, op.name, op.ok, op.output, at)
    }
  }
}

function piStep(entry: Record<string, unknown>): PiStep | undefined {
  const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined
  if (message === undefined) return undefined
  const ops: PiOp[] = []
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content : partsText(message.content)
    if (text !== undefined) ops.push({ kind: "user", text: clip(text, MAX_TEXT_CHARS) })
  } else if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part)) continue
      if (part.type === "text" && typeof part.text === "string") ops.push({ kind: "assistant", text: clip(part.text, MAX_TEXT_CHARS) })
      else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") ops.push({ kind: "tool", id: clip(part.id, 256), name: clip(part.name, 128), input: boundInput(part.arguments) })
    }
  } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    const output = partsText(message.content)
    ops.push({
      kind: "result",
      id: clip(message.toolCallId, 256),
      ...(typeof message.toolName === "string" ? { name: clip(message.toolName, 128) } : {}),
      ok: message.isError !== true,
      ...(output === undefined ? {} : { output: tailText(output, MAX_OUTPUT_CHARS) }),
    })
  }
  return { timestamp: entry.timestamp, ops }
}

// ---------------------------------------------------------------------------------------------
// Helpers


