import { Database, type SQLQueryBindings } from "bun:sqlite"
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, sep } from "node:path"
import { EVERYWHERE, MAX_FILE_BYTES, TooLarge, traceRead, type Workspace } from "./common.ts"

/**
 * Another tool's SQLite store, opened read-only. When the tool holds it locked, or it cannot
 * be opened in place, a copy in a temporary folder is read instead and deleted straight after.
 * Every statement is reported to `traceRead`, so tests can show no other table is read.
 */
export interface Store {
  all<Row>(sql: string, ...params: SQLQueryBindings[]): Row[]
  get<Row>(sql: string, ...params: SQLQueryBindings[]): Row | undefined
}

/** Runs `use` on the store at `path`; undefined when there is no store there. */
export async function readStore<T>(path: string, use: (store: Store) => T): Promise<T | undefined> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  traceRead(path)
  try {
    return opened(path, true, use)
  } catch (error) {
    if (!lockedOrUnopenable(error)) throw error
  }
  if (info.size > MAX_FILE_BYTES) throw new TooLarge()
  const folder = await mkdtemp(join(tmpdir(), "runrail-import-"))
  try {
    const copy = join(folder, basename(path))
    await copyFile(path, copy)
    // The write-ahead log holds what the tool wrote last; without it the copy would miss it.
    await copyFile(`${path}-wal`, `${copy}-wal`).catch(() => undefined)
    return opened(copy, false, use)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

function opened<T>(path: string, readonly: boolean, use: (store: Store) => T): T {
  // A copy opens writable so SQLite can replay its log; it is deleted afterwards either way.
  const db = new Database(path, readonly ? { readonly: true } : { readwrite: true, create: false })
  try {
    db.exec("PRAGMA busy_timeout = 250")
    return use({
      all: <Row>(sql: string, ...params: SQLQueryBindings[]) => {
        traceRead(path, sql)
        return db.query(sql).all(...params) as Row[]
      },
      get: <Row>(sql: string, ...params: SQLQueryBindings[]) => {
        traceRead(path, sql)
        return (db.query(sql).get(...params) ?? undefined) as Row | undefined
      },
    })
  } finally {
    db.close()
  }
}

function lockedOrUnopenable(error: unknown): boolean {
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : ""
  return /^SQLITE_(BUSY|LOCKED|CANTOPEN|READONLY)/.test(code)
}

/** A WHERE clause for `column` holding a folder in the workspace, with its parameters. */
export function inWorkspace(column: string, workspace: Workspace): { readonly sql: string; readonly params: readonly string[] } {
  if (workspace === EVERYWHERE) return { sql: "1", params: [] }
  const escape = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`)
  return {
    sql: `(${workspace.roots.map(() => `${column} = ? OR ${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    params: workspace.roots.flatMap((root) => [root, `${escape(root.endsWith(sep) ? root : `${root}${sep}`)}%`]),
  }
}
