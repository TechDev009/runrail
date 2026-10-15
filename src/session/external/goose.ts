import { join } from "node:path"
import { isInjected, isRecord, safeJson, within, type ExternalReader, type ListedSession, type RecordSink, type Workspace } from "./common.ts"
import { inWorkspace, readStore, type Store } from "./sqlite.ts"

/**
 * Goose's sessions: one SQLite store, `sessions.db`. Only its sessions and messages
 * tables are read. A session Goose ran for itself (a subagent, a hidden or archived one) is not
 * listed. Older stores lack some columns, so the filters use only the columns the store has.
 */

interface SessionRow {
  readonly id: string
  readonly cwd: string
  readonly name: string | null
  readonly description: string | null
  readonly updatedAt: string | number | null
  readonly messages: number
}

interface MessageRow {
  readonly role: string
  readonly content: string | null
  readonly at: number | null
  readonly metadata: string | null
}

/** A message's content is read whole, so one far larger than any conversation's is skipped. */
const MAX_CONTENT_BYTES = 1024 * 1024

export function gooseReader(root: string): ExternalReader {
  const db = join(root, "sessions.db")
  return {
    async list(workspace: Workspace, limit: number) {
      const rows = await readStore(db, (store) => {
        const where = inWorkspace("s.working_dir", workspace)
        const found = store.all<SessionRow>(`${sessionQuery(store)} AND ${where.sql} ORDER BY s.updated_at DESC LIMIT ?`, ...where.params, limit + 1)
        return found.filter((row) => within(workspace, row.cwd)).map((row) => listed(store, row))
      })
      const sessions = rows ?? []
      return { sessions: sessions.slice(0, limit), truncated: sessions.length > limit }
    },

    async read(id: string, workspace: Workspace, sink: RecordSink) {
      return readStore(db, (store) => {
        const row = store.get<SessionRow>(`${sessionQuery(store)} AND s.id = ?`, id)
        if (row === undefined || !within(workspace, row.cwd)) return undefined
        const total = store.get<{ readonly count: number }>("SELECT count(*) AS count FROM messages WHERE session_id = ?", id)?.count ?? 0
        if (total > sink.max) sink.truncated = true
        const messages = store.all<MessageRow>(
          `SELECT role, CASE WHEN length(content_json) <= ${String(MAX_CONTENT_BYTES)} THEN content_json END AS content, created_timestamp AS at, metadata_json AS metadata
          FROM messages WHERE session_id = ? AND id IN (SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`,
          id,
          id,
          sink.max,
        )
        for (const message of messages) convert(message, sink)
        return listed(store, row)
      })
    },
  }
}

/** The person's own sessions, with the conditions this store's columns allow. */
function sessionQuery(store: Store): string {
  const columns = new Set(store.all<{ readonly name: string }>("PRAGMA table_info(sessions)").map((column) => column.name))
  const conditions = [
    ...(columns.has("session_type") ? ["s.session_type = 'user'"] : []),
    ...(columns.has("archived_at") ? ["s.archived_at IS NULL"] : []),
    ...(columns.has("parent_session_id") ? ["s.parent_session_id IS NULL"] : []),
  ]
  return `SELECT s.id AS id, s.working_dir AS cwd, s.name AS name, s.description AS description, s.updated_at AS updatedAt,
    (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS messages
    FROM sessions s WHERE ${conditions.length === 0 ? "1" : conditions.join(" AND ")}`
}

function listed(store: Store, row: SessionRow): ListedSession {
  const named = [row.name, row.description].find((value) => value !== null && value.trim().length > 0) ?? firstPrompt(store, row.id)
  return { id: row.id, cwd: row.cwd, ...(named === undefined || named === null ? {} : { title: named }), updatedAt: timeOf(row.updatedAt), messages: row.messages }
}

function firstPrompt(store: Store, id: string): string | undefined {
  for (const row of store.all<{ readonly content: string | null }>(`SELECT CASE WHEN length(content_json) <= ${String(MAX_CONTENT_BYTES)} THEN content_json END AS content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 3`, id)) {
    const text = textOf(row.content === null ? undefined : safeJson(row.content))
    if (text !== undefined && !isInjected(text)) return text
  }
  return undefined
}

/** SQLite's own timestamps are UTC without a zone; Goose may also write RFC 3339 or epoch seconds. */
function timeOf(value: string | number | null): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value
  if (value === null) return 0
  const plain = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value
  const parsed = Date.parse(plain)
  return Number.isFinite(parsed) ? parsed : 0
}

function convert(row: MessageRow, sink: RecordSink): void {
  const metadata = row.metadata === null ? undefined : safeJson(row.metadata)
  // What Goose kept from the person's view, such as a summary it made for itself.
  if (isRecord(metadata) && metadata.userVisible === false) return
  const content = row.content === null ? undefined : safeJson(row.content)
  if (!Array.isArray(content)) return
  const at = sink.time(row.at === null ? undefined : row.at < 1e12 ? row.at * 1000 : row.at)
  const texts: string[] = []
  const flush = (): void => {
    const text = texts.splice(0).join("\n")
    if (text.trim().length === 0) return
    if (row.role === "user") {
      if (!isInjected(text)) sink.user(text, at)
    } else if (row.role === "assistant") sink.assistant(text, at)
  }
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text)
    else if (item.type === "toolRequest" && typeof item.id === "string") {
      flush()
      const call = isRecord(item.toolCall) && isRecord(item.toolCall.value) ? item.toolCall.value : undefined
      if (typeof call?.name === "string") sink.toolStarted(item.id, call.name, call.arguments, at)
    } else if (item.type === "toolResponse" && typeof item.id === "string") {
      flush()
      const result = isRecord(item.toolResult) ? item.toolResult : undefined
      const value = result?.value
      const ok = result?.status === "success" && !(isRecord(value) && value.isError === true)
      sink.toolCompleted(item.id, undefined, ok, textOf(isRecord(value) && Array.isArray(value.content) ? value.content : value) ?? (typeof result?.error === "string" ? result.error : undefined), at)
    }
  }
  flush()
}

/** The text items of a content list. */
function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : undefined))
    .filter((item): item is string => item !== undefined)
    .join("\n")
  return text.trim().length === 0 ? undefined : text
}
