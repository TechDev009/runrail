import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { ConversationBuilder, SESSION_CONTINUED, transcriptEntry, type ConversationItem } from "./conversation/index.ts"
import { writeFileAtomic } from "./runtime/atomic-write.ts"
import { readBoundedText } from "./runtime/bounded-read.ts"
import { containedPath, ensureContainedDirectory } from "./runtime/contained-path.ts"
import { continueTranscript } from "./session/carryover.ts"
import { FileTranscriptStore } from "./transcript/store.ts"

/**
 * The sessions `run` and `console` keep: one folder each under `~/.runrail/sessions`, laid out as
 * the desktop lays out a thread (`session.json` beside `transcript/<id>.jsonl`), so a later run can
 * continue, resume, or fork one. Prompts and replies are kept there, readable by this user only.
 */

const META_FILE = "session.json"
const MAX_META_BYTES = 64 * 1024
const MAX_SESSIONS_READ = 10_000
const MAX_ROUTE_ARGS = 64
const TITLE_SCAN_BYTES = 64 * 1024
const MAX_TITLE_CHARS = 80
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID_PREFIX = /^[0-9a-f][0-9a-f-]{3,35}$/

/** The flags that pick where a run goes; a continued session reuses them unless new ones are given. */
const ROUTE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--backend", "--model", "--model-command", "--model-command-arg", "--model-capability", "--requires-model-capability", "--quality", "--thinking", "--provider", "--provider-model", "--provider-endpoint", "--provider-protocol", "--provider-credential-env",
  "--connection", "--tool-connection", "--harness-command", "--harness-arg", "--harness-protocol", "--harness-effort", "--harness-permission-mode", "--harness-auth", "--harness-credential-env",
])
const ROUTE_SWITCHES: ReadonlySet<string> = new Set(["--provider-allow-remote", "--provider-allow-insecure-remote", "--harness-persistent"])

export interface CliSession {
  readonly version: 1
  readonly id: string
  readonly cwd: string
  readonly createdAt: number
  /** The routing flags the session started with. Names and ids only: a key never travels on a command line. */
  readonly route: readonly string[]
  readonly forkedFrom?: string
}

export interface CliSessionSummary extends CliSession {
  readonly updatedAt: number
  readonly title?: string
}

/** What `run` or `console` does with saved sessions, decided before its arguments are parsed. */
export interface CliSessionPlan {
  /** The arguments to parse: the session flags taken out, the saved folder and route filled in. */
  readonly argv: readonly string[]
  readonly kind: "none" | "new" | "resume" | "fork"
  /** The session resumed, or the one forked from. */
  readonly session?: CliSession
}

export interface OpenCliSession {
  readonly id: string
  readonly dir: string
  readonly transcriptStore: FileTranscriptStore
}

export function resolveSessionsRoot(value: unknown = process.env.RUNRAIL_SESSIONS_DIR ?? join(homedir(), ".runrail", "sessions")): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\0-\x1f\x7f]/.test(value)) throw new Error("sessions directory is invalid")
  return resolve(value)
}

/** The routing flags in `argv`, in order. */
export function routeArgs(argv: readonly string[]): readonly string[] {
  const route: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (ROUTE_SWITCHES.has(arg)) route.push(arg)
    else if (ROUTE_VALUE_FLAGS.has(arg) && argv[index + 1] !== undefined) {
      route.push(arg, argv[index + 1]!)
      index += 1
    }
  }
  return Object.freeze(route)
}

export async function prepareCliSession(argv: readonly string[], root: string = resolveSessionsRoot()): Promise<CliSessionPlan> {
  const command = argv[0]
  if (command !== "run" && command !== "console") return { argv, kind: "none" }
  const rest: string[] = []
  let asked: { readonly kind: "continue" } | { readonly kind: "resume" | "fork"; readonly ref: string } | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    const next = argv[index + 1]
    if (arg === "--continue" || arg === "--resume" || arg === "--fork") {
      if (asked !== undefined) throw new Error("use one of --continue, --resume and --fork")
      if (arg === "--continue") asked = { kind: "continue" }
      else {
        if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a session id (runrail sessions lists them)`)
        asked = { kind: arg === "--resume" ? "resume" : "fork", ref: next }
        index += 1
      }
      continue
    }
    rest.push(arg)
  }
  const unsaved = rest.includes("--no-session")
  const ownFolder = rest.includes("--session-dir") || rest.includes("--session-id")
  if (asked === undefined) return { argv: [command, ...rest], kind: unsaved || ownFolder ? "none" : "new" }
  if (unsaved) throw new Error("--no-session cannot be combined with --continue, --resume or --fork")
  if (ownFolder) throw new Error("--session-dir and --session-id cannot be combined with --continue, --resume or --fork")
  const cwdAt = rest.indexOf("--cwd")
  const cwd = cwdAt < 0 || rest[cwdAt + 1] === undefined ? undefined : resolve(rest[cwdAt + 1]!)
  let session: CliSession
  if (asked.kind === "continue") {
    if (cwd === undefined) throw new Error("--continue requires --cwd: it continues the latest session in that folder")
    const latest = (await listCliSessions(root, { cwd, limit: 1 }))[0]
    if (latest === undefined) throw new Error(`no saved session for ${cwd}`)
    session = latest
  } else session = await findCliSession(root, asked.ref)
  if (asked.kind !== "fork" && cwd !== undefined && cwd !== session.cwd)
    throw new Error(`session ${shortId(session.id)} belongs to ${session.cwd}; resume it there, or --fork it to work in another folder`)
  const filled = [
    ...(routeArgs([command, ...rest]).length === 0 ? session.route : []),
    ...(cwd === undefined ? ["--cwd", session.cwd] : []),
    ...rest,
  ]
  return { argv: [command, ...filled], kind: asked.kind === "fork" ? "fork" : "resume", session }
}

/** Opens the session the plan names, making the folder for a new one or a fork. */
export async function openCliSession(plan: CliSessionPlan, start: { readonly cwd: string; readonly backend: string; readonly route: readonly string[] }, root: string = resolveSessionsRoot()): Promise<OpenCliSession | undefined> {
  if (plan.kind === "none") return undefined
  if (start.route.length > MAX_ROUTE_ARGS) throw new Error("too many routing flags to save with the session")
  if (plan.kind === "resume" && plan.session !== undefined) {
    const resumed = await opened(root, plan.session.id)
    // New routing flags become the session's own, so the next resume takes them too.
    if (start.route.join("\0") !== plan.session.route.join("\0")) await writeSession(resumed.dir, { ...plan.session, route: Object.freeze([...start.route]) })
    // Pi runs here without a conversation of its own, and another backend never saw this one: both start from a recap.
    if ((start.backend === "pi" || start.backend !== routeBackend(plan.session.route)) && (await resumed.transcriptStore.read(plan.session.id, { maxRecords: 1 })).length > 0)
      await resumed.transcriptStore.append(plan.session.id, { kind: SESSION_CONTINUED, payload: { type: SESSION_CONTINUED } })
    return resumed
  }
  const session: CliSession = Object.freeze({
    version: 1,
    id: newSessionId(),
    cwd: resolve(start.cwd),
    createdAt: Date.now(),
    route: Object.freeze([...start.route]),
    ...(plan.kind === "fork" && plan.session !== undefined ? { forkedFrom: plan.session.id } : {}),
  })
  await ensureContainedDirectory(root, root)
  const dir = await ensureContainedDirectory(root, join(root, session.id))
  await writeSession(dir, session)
  const created = await opened(root, session.id)
  if (plan.kind === "fork" && plan.session !== undefined) {
    const source = await opened(root, plan.session.id)
    await continueTranscript(source.transcriptStore, plan.session.id, created.transcriptStore, session.id)
  }
  return created
}

export async function listCliSessions(root: string, options: { readonly cwd?: string; readonly limit?: number } = {}): Promise<readonly CliSessionSummary[]> {
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && ID.test(entry.name)).map((entry) => entry.name).slice(0, MAX_SESSIONS_READ)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const cwd = options.cwd === undefined ? undefined : resolve(options.cwd)
  const sessions = (await Promise.all(names.map((name) => readSession(root, name).catch(() => undefined))))
    .filter((session): session is CliSession => session !== undefined && (cwd === undefined || session.cwd === cwd))
  // A run that failed before its first message leaves nothing to pick up.
  const summaries = (await Promise.all(sessions.map((session) => summarize(root, session)))).filter((summary): summary is CliSessionSummary => summary.updatedAt !== undefined)
  summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return Object.freeze(options.limit === undefined ? summaries : summaries.slice(0, options.limit))
}

/** A session by its id or a prefix of it that names one session. */
export async function findCliSession(root: string, ref: string): Promise<CliSession> {
  const wanted = ref.toLowerCase()
  if (!ID_PREFIX.test(wanted)) throw new Error("a session id is the id runrail sessions lists, or at least its first four characters")
  if (ID.test(wanted)) {
    try {
      return await readSession(root, wanted)
    } catch {
      throw new Error(`no saved session ${wanted}`)
    }
  }
  const matches = (await listCliSessions(root)).filter((session) => session.id.startsWith(wanted))
  if (matches.length === 0) throw new Error(`no saved session ${wanted}`)
  if (matches.length > 1) throw new Error(`${wanted} matches ${matches.length} sessions; give more of the id`)
  return matches[0]!
}

export async function exportCliSession(root: string, ref: string, format: "json" | "markdown"): Promise<string> {
  const session = await findCliSession(root, ref)
  const { transcriptStore } = await opened(root, session.id)
  if (format === "json") return `${await transcriptStore.export(session.id)}\n`
  const builder = new ConversationBuilder({ root: session.cwd, maxItems: 4_096 })
  for (const record of await transcriptStore.read(session.id)) {
    const entry = transcriptEntry(record)
    if (entry !== undefined) builder.add(entry)
  }
  const summary = await summarize(root, session)
  return conversationMarkdown({ ...summary, updatedAt: summary.updatedAt ?? session.createdAt }, builder.items())
}

/** The backend a route runs on. */
export function routeBackend(route: readonly string[]): string {
  const at = route.indexOf("--backend")
  return at < 0 ? "native" : route[at + 1] ?? "native"
}

/** A UUID whose first character is a letter: the coding-tool backends refuse an id that starts with a digit. */
export function newSessionId(): string {
  const id = randomUUID()
  return `${"abcdef"[Number.parseInt(id[0]!, 16) % 6]}${id.slice(1)}`
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

function conversationMarkdown(session: CliSessionSummary, items: readonly ConversationItem[]): string {
  const lines = [
    `# ${session.title ?? "Runrail session"}`,
    "",
    `- Session: ${session.id}`,
    `- Folder: ${session.cwd}`,
    `- Started: ${new Date(session.createdAt).toISOString()}`,
    ...(session.forkedFrom === undefined ? [] : [`- Forked from: ${session.forkedFrom}`]),
  ]
  for (const item of items) {
    if (item.kind === "user") lines.push("", item.steer === true ? "## You (while it ran)" : "## You", "", item.text)
    else if (item.kind === "assistant" && item.text.trim().length > 0) lines.push("", "## Assistant", "", item.text)
    else if (item.kind === "tool") lines.push("", `- ${item.presentation.title}${item.status === "failed" ? ` (failed${item.errorCode === undefined ? "" : `: ${item.errorCode}`})` : ""}`)
    else if (item.kind === "approval") lines.push("", `- Approval for ${item.action}: ${item.status}`)
    else if (item.kind === "notice" && item.level === "error") lines.push("", `- Error ${item.code}${item.message === undefined ? "" : `: ${item.message}`}`)
  }
  return `${lines.join("\n")}\n`
}

async function opened(root: string, id: string): Promise<OpenCliSession> {
  const dir = await containedPath(root, join(root, id))
  return { id, dir, transcriptStore: new FileTranscriptStore({ root: join(dir, "transcript") }) }
}

async function writeSession(dir: string, session: CliSession): Promise<void> {
  await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(session, null, 2)}\n`)
}

async function readSession(root: string, id: string): Promise<CliSession> {
  const path = await containedPath(root, join(root, id, META_FILE))
  const value: unknown = JSON.parse(await readBoundedText(path, MAX_META_BYTES, { noFollow: true }))
  if (!isRecord(value) || value.version !== 1 || value.id !== id || typeof value.cwd !== "string" || value.cwd.length === 0 || value.cwd.length > 4_096) throw new Error("session file is invalid")
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) throw new Error("session file is invalid")
  if (!Array.isArray(value.route) || value.route.length > MAX_ROUTE_ARGS || value.route.some((arg) => typeof arg !== "string" || arg.length > 4_096 || arg.includes("\0"))) throw new Error("session file is invalid")
  if (value.forkedFrom !== undefined && (typeof value.forkedFrom !== "string" || !ID.test(value.forkedFrom))) throw new Error("session file is invalid")
  return Object.freeze({
    version: 1,
    id,
    cwd: value.cwd,
    createdAt: value.createdAt,
    route: Object.freeze([...(value.route as string[])]),
    ...(value.forkedFrom === undefined ? {} : { forkedFrom: value.forkedFrom as string }),
  })
}

async function summarize(root: string, session: CliSession): Promise<Omit<CliSessionSummary, "updatedAt"> & { readonly updatedAt: number | undefined }> {
  const transcript = join(root, session.id, "transcript", `${session.id}.jsonl`)
  const updatedAt = await stat(transcript).then((entry) => entry.mtimeMs, () => undefined)
  const title = await firstMessage(transcript).catch(() => undefined)
  return Object.freeze({ ...session, updatedAt, ...(title === undefined ? {} : { title }) })
}

/** The first line of the first message, read from the start of the transcript only. */
async function firstMessage(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let text: string
  try {
    const buffer = Buffer.alloc(TITLE_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    text = buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
  const lines = text.split("\n")
  // The last piece may be cut off at the scan limit.
  for (const line of lines.slice(0, -1)) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(record) || record.kind !== "message.user") continue
    // A prompt is kept as its text; a steer or a message with attachments as an object.
    const payload = record.payload
    const text = typeof payload === "string" ? payload : isRecord(payload) && typeof payload.text === "string" && payload.steer !== true ? payload.text : undefined
    if (text === undefined) continue
    const first = text.trim().split("\n")[0]!.trim()
    if (first.length === 0) continue
    return first.length <= MAX_TITLE_CHARS ? first : `${first.slice(0, MAX_TITLE_CHARS - 1)}…`
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
