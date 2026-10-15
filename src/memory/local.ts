import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { MemoryError, memoryText, queryTerms, recallScore, type Memory, type MemoryAdd, type MemoryListInput, type MemoryProvider, type MemoryScope, type RecallHit } from "./types.ts"

/**
 * Memories in one SQLite file (`~/.runrail/memory/memory.db`), searched with FTS5. Every project's
 * engine opens the same file, so it runs in WAL mode and waits briefly on a lock.
 */

const MAX_MEMORIES = 50_000
const CANDIDATES = 25

interface Row {
  readonly id: string
  readonly scope: string
  readonly text: string
  readonly source_kind: Memory["source"]["kind"]
  readonly source_id: string | null
  readonly source_ref: string | null
  readonly created_at: number
  readonly updated_at: number
}

function toMemory(row: Row): Memory {
  return {
    id: row.id,
    scope: row.scope,
    text: row.text,
    source: { kind: row.source_kind, ...(row.source_id === null ? {} : { id: row.source_id }), ...(row.source_ref === null ? {} : { ref: row.source_ref }) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class LocalMemory implements MemoryProvider {
  readonly kind = "local"
  readonly #db: Database
  readonly #now: () => number
  readonly #max: number

  constructor(path: string, options: { readonly now?: () => number; readonly maxMemories?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.#db = new Database(path, { create: true })
    this.#now = options.now ?? Date.now
    this.#max = options.maxMemories ?? MAX_MEMORIES
    this.#db.run("PRAGMA journal_mode = WAL")
    this.#db.run("PRAGMA busy_timeout = 5000")
    this.#db.run(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      source_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    this.#db.run("CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope, updated_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS memories_source ON memories (source_id, source_ref)")
    this.#db.run("CREATE TABLE IF NOT EXISTS source_refs (source_id TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (source_id, ref))")
    this.#db.run("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='rowid', tokenize='porter unicode61')")
    this.#db.run("CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text); END")
    this.#db.run("CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END")
    this.#db.run("CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text); END")
  }

  /** The memories sharing the most of the query's words; ties go to the better FTS5 rank. */
  async recall(query: string, scopes: readonly MemoryScope[], limit: number): Promise<readonly RecallHit[]> {
    const terms = queryTerms(query)
    if (terms.length === 0 || scopes.length === 0) return []
    const marks = scopes.map(() => "?").join(", ")
    const match = terms.map((term) => `"${term}"`).join(" OR ")
    const candidates = this.#db
      .query<Row & { readonly rowid: number }, (string | number)[]>(
        `SELECT m.rowid, m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND m.scope IN (${marks}) ORDER BY bm25(memories_fts) LIMIT ${String(CANDIDATES)}`,
      )
      .all(match, ...scopes)
    if (candidates.length === 0) return []
    const ids = candidates.map((row) => row.rowid)
    const idMarks = ids.map(() => "?").join(", ")
    const matched = new Map<number, number>()
    for (const term of terms) {
      for (const row of this.#db.query<{ readonly rowid: number }, (string | number)[]>(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? AND rowid IN (${idMarks})`).all(`"${term}"`, ...ids)) matched.set(row.rowid, (matched.get(row.rowid) ?? 0) + 1)
    }
    return candidates
      .map((row, rank) => ({ hit: { ...toMemory(row), score: recallScore(matched.get(row.rowid) ?? 0, terms.length) }, rank }))
      .sort((a, b) => b.hit.score - a.hit.score || a.rank - b.rank)
      .slice(0, limit)
      .map((entry) => entry.hit)
  }

  async add(input: MemoryAdd): Promise<Memory> {
    const text = memoryText(input.text)
    const now = this.#now()
    const source = input.source ?? { kind: "manual" as const }
    const id = `mem-${randomUUID()}`
    // Immediate, so another engine on the same file cannot count the same free slot.
    this.#db.transaction(() => {
      this.#admit(1)
      this.#db.query("INSERT INTO memories (id, scope, text, source_kind, source_id, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.scope, text, source.kind, source.id ?? null, source.ref ?? null, now, now)
    }).immediate()
    return { id, scope: input.scope, text, source, createdAt: now, updatedAt: now }
  }

  #admit(adding: number): void {
    const count = this.#db.query<{ readonly n: number }, []>("SELECT count(*) AS n FROM memories").get()?.n ?? 0
    if (count + adding > this.#max) throw new MemoryError("MEMORY_LIMIT", `memory holds at most ${String(this.#max)} entries; forget some first`)
  }

  async update(id: string, value: string): Promise<Memory> {
    const text = memoryText(value)
    const changed = this.#db.query("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?").run(text, this.#now(), id)
    if (changed.changes === 0) throw new MemoryError("MEMORY_NOT_FOUND", "no memory has that id")
    return this.#get(id)
  }

  async forget(id: string): Promise<boolean> {
    return this.#db.query("DELETE FROM memories WHERE id = ?").run(id).changes > 0
  }

  async list(input: MemoryListInput): Promise<readonly Memory[]> {
    const where: string[] = []
    const values: (string | number)[] = []
    if (input.scopes !== undefined) {
      where.push(`scope IN (${input.scopes.map(() => "?").join(", ") || "NULL"})`)
      values.push(...input.scopes)
    }
    if (input.sourceId !== undefined) {
      where.push("source_id = ?")
      values.push(input.sourceId)
    }
    if (input.before !== undefined) {
      where.push("updated_at < ?")
      values.push(input.before)
    }
    const terms = input.query === undefined ? [] : queryTerms(input.query)
    if (terms.length > 0) {
      where.push("rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)")
      values.push(terms.map((term) => `"${term}"`).join(" AND "))
    }
    const sql = `SELECT * FROM memories ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ORDER BY updated_at DESC LIMIT ${String(Math.min(Math.max(1, input.limit), 500))}`
    return this.#db.query<Row, (string | number)[]>(sql).all(...values).map(toMemory)
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    const count = this.#db.query<{ readonly n: number }, []>("SELECT count(*) AS n FROM memories").get()?.n ?? 0
    return { ok: true, detail: `${String(count)} memories` }
  }

  async close(): Promise<void> {
    this.#db.close()
  }

  /** Counts per scope, for the Memory view. */
  counts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#db.query<{ readonly scope: string; readonly n: number }, []>("SELECT scope, count(*) AS n FROM memories GROUP BY scope").all().map((row) => [row.scope, row.n]))
  }

  /** What a source last kept, by ref (a file, an issue, a feed item), with the hash it was kept at. */
  sourceRefs(sourceId: string): ReadonlyMap<string, string> {
    return new Map(this.#db.query<{ readonly ref: string; readonly hash: string }, [string]>("SELECT ref, hash FROM source_refs WHERE source_id = ?").all(sourceId).map((row) => [row.ref, row.hash]))
  }

  /** Replaces what a source keeps under one ref, in one transaction; over the quota, the old entries stay. */
  replaceRef(scope: MemoryScope, source: Memory["source"] & { readonly id: string; readonly ref: string }, hash: string, texts: readonly string[]): void {
    const now = this.#now()
    this.#db.transaction(() => {
      this.#db.query("DELETE FROM memories WHERE source_id = ? AND source_ref = ?").run(source.id, source.ref)
      this.#admit(texts.length)
      const insert = this.#db.query("INSERT INTO memories (id, scope, text, source_kind, source_id, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      for (const text of texts) insert.run(`mem-${randomUUID()}`, scope, text, source.kind, source.id, source.ref, now, now)
      this.#db.query("INSERT OR REPLACE INTO source_refs (source_id, ref, hash) VALUES (?, ?, ?)").run(source.id, source.ref, hash)
    }).immediate()
  }

  /** Forgets one ref of a source, or the whole source. Returns the memories removed. */
  forgetSource(sourceId: string, ref?: string): number {
    // Counted first: `changes` also counts the FTS trigger's writes.
    return this.#db.transaction(() => {
      if (ref === undefined) {
        const count = this.sourceCount(sourceId)
        this.#db.query("DELETE FROM source_refs WHERE source_id = ?").run(sourceId)
        this.#db.query("DELETE FROM memories WHERE source_id = ?").run(sourceId)
        return count
      }
      const count = this.#db.query<{ readonly n: number }, [string, string]>("SELECT count(*) AS n FROM memories WHERE source_id = ? AND source_ref = ?").get(sourceId, ref)?.n ?? 0
      this.#db.query("DELETE FROM source_refs WHERE source_id = ? AND ref = ?").run(sourceId, ref)
      this.#db.query("DELETE FROM memories WHERE source_id = ? AND source_ref = ?").run(sourceId, ref)
      return count
    })()
  }

  sourceCount(sourceId: string): number {
    return this.#db.query<{ readonly n: number }, [string]>("SELECT count(*) AS n FROM memories WHERE source_id = ?").get(sourceId)?.n ?? 0
  }

  #get(id: string): Memory {
    const row = this.#db.query<Row, [string]>("SELECT * FROM memories WHERE id = ?").get(id)
    if (row === null) throw new MemoryError("MEMORY_NOT_FOUND", "no memory has that id")
    return toMemory(row)
  }
}
