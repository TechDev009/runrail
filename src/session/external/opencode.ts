import { join } from "node:path"
import { isInjected, MAX_OUTPUT_CHARS, MAX_TEXT_CHARS, parseArguments, within, type ExternalReader, type ListedSession, type RecordSink, type Workspace } from "./common.ts"
import { inWorkspace, readStore, type Store } from "./sqlite.ts"

/**
 * OpenCode's sessions: one SQLite store, `opencode.db`, in its data folder. Only the
 * session, message and part tables are read; `auth.json` beside it and the store's account and
 * credential tables never are. A subagent's session is part of its parent's and is not listed.
 * The older `storage/` JSON layout is not read.
 */

interface SessionRow {
  readonly id: string
  readonly cwd: string
  readonly title: string | null
  readonly updatedAt: number
  readonly messages: number
}

interface PartRow {
  readonly message: string
  readonly role: string | null
  readonly at: number
  readonly type: string | null
  readonly text: string | null
  readonly synthetic: number | null
  readonly ignored: number | null
  readonly tool: string | null
  readonly callId: string | null
  readonly status: string | null
  readonly input: string | null
  readonly output: string | null
  readonly error: string | null
}

const SESSION_COLUMNS = `s.id AS id, s.directory AS cwd, s.title AS title, s.time_updated AS updatedAt,
  (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS messages`

export function openCodeReader(root: string): ExternalReader {
  const db = join(root, "opencode.db")
  return {
    async list(workspace: Workspace, limit: number) {
      const where = inWorkspace("s.directory", workspace)
      const rows = await readStore(db, (store) =>
        store.all<SessionRow>(
          `SELECT ${SESSION_COLUMNS} FROM session s WHERE s.parent_id IS NULL AND s.time_archived IS NULL AND ${where.sql} ORDER BY s.time_updated DESC LIMIT ?`,
          ...where.params,
          limit + 1,
        ),
      )
      const sessions = (rows ?? []).filter((row) => within(workspace, row.cwd)).map(listed)
      return { sessions: sessions.slice(0, limit), truncated: sessions.length > limit }
    },

    async read(id: string, workspace: Workspace, sink: RecordSink) {
      return readStore(db, (store) => {
        const row = store.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM session s WHERE s.id = ? AND s.parent_id IS NULL`, id)
        if (row === undefined || !within(workspace, row.cwd)) return undefined
        convert(store, id, sink)
        return listed(row)
      })
    },
  }
}

function listed(row: SessionRow): ListedSession {
  return { id: row.id, cwd: row.cwd, ...(row.title === null || row.title.length === 0 ? {} : { title: row.title }), updatedAt: row.updatedAt, messages: row.messages }
}

/** The newest messages the sink can keep, each message's parts in order, with text and outputs bounded in SQL. */
function convert(store: Store, id: string, sink: RecordSink): void {
  const total = store.get<{ readonly count: number }>("SELECT count(*) AS count FROM message WHERE session_id = ?", id)?.count ?? 0
  if (total > sink.max) sink.truncated = true
  const rows = store.all<PartRow>(
    `SELECT p.message_id AS message, json_extract(m.data, '$.role') AS role, m.time_created AS at,
      json_extract(p.data, '$.type') AS type,
      substr(json_extract(p.data, '$.text'), 1, ${String(MAX_TEXT_CHARS)}) AS text,
      json_extract(p.data, '$.synthetic') AS synthetic, json_extract(p.data, '$.ignored') AS ignored,
      json_extract(p.data, '$.tool') AS tool, json_extract(p.data, '$.callID') AS callId,
      json_extract(p.data, '$.state.status') AS status,
      json_extract(p.data, '$.state.input') AS input,
      substr(json_extract(p.data, '$.state.output'), -${String(MAX_OUTPUT_CHARS)}) AS output,
      substr(json_extract(p.data, '$.state.error'), 1, ${String(MAX_OUTPUT_CHARS)}) AS error
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ? AND m.id IN (SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?)
    ORDER BY m.time_created, m.id, p.id`,
    id,
    id,
    sink.max,
  )
  // A user message's text parts are one prompt; parts the tool added itself are not the person's.
  let prompt: { message: string; at: number; texts: string[] } | undefined
  const flush = (): void => {
    const text = prompt?.texts.join("\n")
    if (prompt !== undefined && text !== undefined && !isInjected(text)) sink.user(text, prompt.at)
    prompt = undefined
  }
  for (const row of rows) {
    if (prompt !== undefined && prompt.message !== row.message) flush()
    const at = sink.time(row.at)
    if (row.type === "text" && row.text !== null && row.synthetic !== 1 && row.ignored !== 1) {
      if (row.role === "user") {
        prompt ??= { message: row.message, at, texts: [] }
        prompt.texts.push(row.text)
      } else if (row.role === "assistant") sink.assistant(row.text, at)
    } else if (row.type === "tool" && row.role === "assistant" && row.tool !== null && row.callId !== null) {
      sink.toolStarted(row.callId, row.tool, parseArguments(row.input ?? undefined), at)
      if (row.status === "completed") sink.toolCompleted(row.callId, row.tool, true, row.output ?? undefined, at)
      else if (row.status === "error") sink.toolCompleted(row.callId, row.tool, false, row.error ?? undefined, at)
    }
  }
  flush()
}
