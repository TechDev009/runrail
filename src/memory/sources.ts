import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { fetchCheckingRedirects, isPrivateHost } from "../net/redirect.ts"
import { isSensitiveWorkspacePath } from "../workspace/policy.ts"
import type { LocalMemory } from "./local.ts"
import { MemoryError, type MemoryScope } from "./types.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"

/**
 * Sources: a folder of notes, a repository's GitHub issues, or a feed, indexed into local
 * memory. A sync keeps what changed and forgets what is gone; credential files are never read.
 */

export type SourceKind = "folder" | "github" | "feed"

export interface MemorySource {
  readonly id: string
  readonly kind: SourceKind
  readonly scope: MemoryScope
  readonly name: string
  /** A folder's absolute path, `owner/repo`, or a feed's URL. */
  readonly target: string
  readonly addedAt: number
  lastSync?: { readonly at: number; readonly ok: boolean; readonly error?: string; readonly added: number; readonly removed: number; readonly kept: number; readonly incomplete?: boolean }
  /** Issues: the newest `updatedAt` imported, where the next sync carries on. Feeds: validators for a conditional request. */
  cursor?: string
  etag?: string
  lastModified?: string
}

export interface SourcesOptions {
  readonly path: string
  readonly memory: LocalMemory
  /** Runs `gh` with these arguments and returns its output. */
  readonly gh?: (args: readonly string[]) => Promise<string>
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

const MAX_SOURCES = 50
const MAX_FILES = 2_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_CHUNK = 1_500
const MAX_CHUNKS_PER_FILE = 40
const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_FEED_ITEMS = 100
const NOTE_FILE = /\.(md|mdx|markdown|txt|rst|adoc|org)$/i
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "out", "vendor", "__pycache__"])
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const ISSUE_PAGE = 100
const MAX_ISSUE_PAGES = 10
// Whole seconds in UTC, so comparing the strings compares the times.
const ISSUE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

type SyncResult = { added: number; removed: number; kept: number; incomplete?: boolean }

function invalid(message: string): never {
  throw new MemoryError("MEMORY_INVALID", message)
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export class MemorySources {
  readonly #now: () => number
  #syncing = new Set<string>()
  /** Sources removed while a sync of theirs ran; that sync writes nothing more. */
  #removed = new Set<string>()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: SourcesOptions) {
    this.#now = options.now ?? Date.now
  }

  async list(scopes?: readonly MemoryScope[]): Promise<readonly (MemorySource & { readonly entries: number })[]> {
    return (await this.#read()).filter((source) => scopes === undefined || scopes.includes(source.scope)).map((source) => ({ ...source, entries: this.options.memory.sourceCount(source.id) }))
  }

  async add(input: { readonly kind: unknown; readonly scope: MemoryScope; readonly target: unknown; readonly name?: unknown }): Promise<MemorySource> {
    const kind = input.kind === "folder" || input.kind === "github" || input.kind === "feed" ? input.kind : invalid("kind must be folder, github or feed")
    const target = await parseTarget(kind, input.target)
    const name = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim().slice(0, 80) : defaultName(kind, target)
    return this.#change(async (sources) => {
      if (sources.length >= MAX_SOURCES) throw new MemoryError("MEMORY_LIMIT", `memory keeps at most ${String(MAX_SOURCES)} sources`)
      if (sources.some((source) => source.kind === kind && source.target === target && source.scope === input.scope)) invalid("that source is already added")
      const source: MemorySource = { id: `src-${randomUUID()}`, kind, scope: input.scope, name, target, addedAt: this.#now() }
      return { sources: [...sources, source], result: source }
    })
  }

  /** Removes the source and every memory it added. */
  async remove(id: string): Promise<{ readonly removed: boolean; readonly forgotten: number }> {
    const removed = await this.#change(async (sources) => {
      const kept = sources.filter((source) => source.id !== id)
      if (kept.length === sources.length) return { result: false }
      if (this.#syncing.has(id)) this.#removed.add(id)
      return { sources: kept, result: true }
    })
    return removed ? { removed: true, forgotten: this.options.memory.forgetSource(id) } : { removed: false, forgotten: 0 }
  }

  async sync(id: string): Promise<MemorySource & { readonly entries: number }> {
    const source = (await this.#read()).find((entry) => entry.id === id)
    if (source === undefined) throw new MemoryError("MEMORY_NOT_FOUND", "no source has that id")
    if (this.#syncing.has(id)) throw new MemoryError("MEMORY_LIMIT", "that source is already syncing")
    this.#syncing.add(id)
    try {
      let result: SyncResult
      try {
        result = source.kind === "folder" ? await this.#folder(source) : source.kind === "github" ? await this.#github(source) : await this.#feed(source)
        source.lastSync = { at: this.#now(), ok: true, ...result }
      } catch (error) {
        source.lastSync = { at: this.#now(), ok: false, error: error instanceof MemoryError ? error.message : "the source could not be read", added: 0, removed: 0, kept: 0 }
      }
      // Written back by id: a source removed while it synced stays removed, along with anything it wrote.
      const gone = await this.#change(async (now) => {
        if (!now.some((entry) => entry.id === id)) return { result: true }
        return { sources: now.map((entry) => (entry.id === id ? { ...entry, ...pick(source) } : entry)), result: false }
      })
      if (gone) this.options.memory.forgetSource(id)
      return { ...source, entries: this.options.memory.sourceCount(id) }
    } finally {
      this.#syncing.delete(id)
      this.#removed.delete(id)
    }
  }

  /** Every write a sync makes goes through here, so a removed source gets none after its removal. */
  #replace(source: MemorySource, ref: string, hash: string, texts: readonly string[]): void {
    this.#live(source.id)
    this.options.memory.replaceRef(source.scope, { kind: source.kind, id: source.id, ref }, hash, texts)
  }

  #live(id: string): void {
    if (this.#removed.has(id)) throw new MemoryError("MEMORY_NOT_FOUND", "the source was removed while it synced")
  }

  async #folder(source: MemorySource): Promise<SyncResult> {
    const info = await stat(source.target).catch(() => undefined)
    if (info?.isDirectory() !== true) throw new MemoryError("MEMORY_SOURCE_FAILED", "the folder is gone")
    const files = await notesIn(source.target)
    const before = this.options.memory.sourceRefs(source.id)
    let added = 0
    let kept = 0
    for (const path of files) {
      const ref = relative(source.target, path).split(sep).join("/")
      const text = await readFile(path, "utf8").catch(() => undefined)
      if (text === undefined) continue
      const hash = sha(text)
      if (before.get(ref) === hash) {
        kept += 1
        continue
      }
      this.#replace(source, ref, hash, chunks(text))
      added += 1
    }
    const seen = new Set(files.map((path) => relative(source.target, path).split(sep).join("/")))
    let removed = 0
    for (const ref of before.keys()) {
      if (seen.has(ref)) continue
      this.#live(source.id)
      this.options.memory.forgetSource(source.id, ref)
      removed += 1
    }
    return { added, removed, kept }
  }

  /**
   * The first sync keeps the newest issues. Later ones walk forward from the cursor, oldest change
   * first, so a busy stretch is caught up over pages and syncs instead of being skipped.
   */
  async #github(source: MemorySource): Promise<SyncResult> {
    const gh = this.options.gh
    if (gh === undefined) throw new MemoryError("MEMORY_SOURCE_FAILED", "install the GitHub CLI (gh) to read issues")
    const before = new Map(this.options.memory.sourceRefs(source.id))
    let added = 0
    let kept = 0
    for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
      const since = source.cursor !== undefined && ISSUE_TIME.test(source.cursor) ? source.cursor : undefined
      const search = since === undefined ? "sort:updated-desc" : `sort:updated-asc updated:>=${since.replace(/Z$/, "+00:00")}`
      const issues = await listIssues(gh, source.target, search)
      let cursor = since
      for (const issue of issues) {
        const text = `#${String(issue.number)} ${issue.title}\n\n${issue.body}`.trim().slice(0, 3_900)
        const ref = `#${String(issue.number)}`
        const hash = sha(text)
        if (issue.updatedAt !== undefined && (cursor === undefined || issue.updatedAt > cursor)) cursor = issue.updatedAt
        if (before.get(ref) === hash) {
          kept += 1
          continue
        }
        this.#replace(source, ref, hash, [text])
        before.set(ref, hash)
        added += 1
      }
      const advanced = cursor !== undefined && cursor !== since
      if (cursor !== undefined) source.cursor = cursor
      // A short page is the end; a full one whose changes all share the cursor's second cannot move it.
      if (since === undefined || issues.length < ISSUE_PAGE) return { added, removed: 0, kept }
      if (!advanced) return { added, removed: 0, kept, incomplete: true }
    }
    return { added, removed: 0, kept, incomplete: true }
  }

  async #feed(source: MemorySource): Promise<SyncResult> {
    const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" }
    if (source.etag !== undefined) headers["if-none-match"] = source.etag
    if (source.lastModified !== undefined) headers["if-modified-since"] = source.lastModified
    let response: Response
    try {
      // A public feed never redirects the engine to an address on this machine or its network.
      response = await fetchCheckingRedirects(source.target, { headers, signal: AbortSignal.timeout(20_000) }, (next, from) => isPrivateHost(from.hostname) || !isPrivateHost(next.hostname), { maxHops: 5, ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }) })
    } catch {
      throw new MemoryError("MEMORY_SOURCE_FAILED", "the feed did not answer")
    }
    if (response.status === 304) return { added: 0, removed: 0, kept: this.options.memory.sourceRefs(source.id).size }
    if (!response.ok) throw new MemoryError("MEMORY_SOURCE_FAILED", `the feed answered ${String(response.status)}`)
    const text = await boundedText(response, MAX_FEED_BYTES)
    const items = feedItems(text).slice(0, MAX_FEED_ITEMS)
    if (items.length === 0) throw new MemoryError("MEMORY_SOURCE_FAILED", "the page is not an RSS or Atom feed")
    const before = this.options.memory.sourceRefs(source.id)
    let added = 0
    let kept = 0
    for (const item of items) {
      const body = `${item.title}\n\n${item.summary}`.trim().slice(0, 3_900)
      const hash = sha(body)
      if (before.get(item.ref) === hash) {
        kept += 1
        continue
      }
      this.#replace(source, item.ref, hash, [body])
      added += 1
    }
    const etag = response.headers.get("etag")
    const modified = response.headers.get("last-modified")
    if (etag !== null && etag.length <= 256) source.etag = etag
    if (modified !== null && modified.length <= 64) source.lastModified = modified
    return { added, removed: 0, kept }
  }

  #read(): Promise<MemorySource[]> {
    return readSources(this.options.path)
  }

  /** Each read-modify-write of the sources file waits for the one before it. */
  #change<T>(work: (sources: MemorySource[]) => Promise<{ readonly sources?: readonly MemorySource[]; readonly result: T }>): Promise<T> {
    const next = this.#queue.then(async () => {
      const { sources, result } = await work(await this.#read())
      if (sources !== undefined) await this.#write(sources)
      return result
    })
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #write(sources: readonly MemorySource[]): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.options.path, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`)
  }
}

interface Issue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly updatedAt?: string
}

async function listIssues(gh: (args: readonly string[]) => Promise<string>, repo: string, search: string): Promise<readonly Issue[]> {
  let output: string
  try {
    output = await gh(["issue", "list", "--repo", repo, "--state", "all", "--limit", String(ISSUE_PAGE), "--search", search, "--json", "number,title,body,updatedAt,url"])
  } catch {
    throw new MemoryError("MEMORY_SOURCE_FAILED", "gh could not list the repository's issues")
  }
  let issues: unknown
  try {
    issues = JSON.parse(output)
  } catch {
    throw new MemoryError("MEMORY_SOURCE_FAILED", "gh's answer was not JSON")
  }
  if (!Array.isArray(issues)) throw new MemoryError("MEMORY_SOURCE_FAILED", "gh's answer was not a list")
  return issues.slice(0, ISSUE_PAGE).flatMap((value): Issue[] => {
    const issue = value as { number?: unknown; title?: unknown; body?: unknown; updatedAt?: unknown }
    if (typeof issue.number !== "number" || typeof issue.title !== "string") return []
    return [{ number: issue.number, title: issue.title, body: typeof issue.body === "string" ? issue.body : "", ...(typeof issue.updatedAt === "string" && ISSUE_TIME.test(issue.updatedAt) ? { updatedAt: issue.updatedAt } : {}) }]
  })
}

async function readSources(path: string): Promise<MemorySource[]> {
  const text = await readFile(path, "utf8").catch(() => undefined)
  if (text === undefined) return []
  try {
    const parsed = JSON.parse(text) as { sources?: unknown }
    return Array.isArray(parsed.sources) ? (parsed.sources.filter((entry) => typeof entry === "object" && entry !== null && typeof (entry as MemorySource).id === "string") as MemorySource[]) : []
  } catch {
    return []
  }
}

/** How many sources have not synced within `every`; the wake service only reads. */
export async function staleSourceCount(path: string, now: number, every: number): Promise<number> {
  const at = (source: MemorySource): number | undefined => (typeof source.lastSync?.at === "number" && Number.isFinite(source.lastSync.at) ? source.lastSync.at : undefined)
  return (await readSources(path)).slice(0, MAX_SOURCES).filter((source) => {
    const last = at(source)
    return last === undefined || now - last >= every
  }).length
}

function pick(source: MemorySource): Partial<MemorySource> {
  return { ...(source.lastSync === undefined ? {} : { lastSync: source.lastSync }), ...(source.cursor === undefined ? {} : { cursor: source.cursor }), ...(source.etag === undefined ? {} : { etag: source.etag }), ...(source.lastModified === undefined ? {} : { lastModified: source.lastModified }) }
}

async function parseTarget(kind: SourceKind, value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4_096 || value.includes("\0")) invalid("target is required")
  const target = value.trim()
  if (kind === "folder") {
    if (!isAbsolute(target)) invalid("a folder must be an absolute path")
    const info = await stat(target).catch(() => undefined)
    if (info?.isDirectory() !== true) invalid("that folder does not exist")
    return target
  }
  if (kind === "github") {
    if (!REPO.test(target)) invalid("a repository is owner/name")
    return target
  }
  let url: URL
  try {
    url = new URL(target)
  } catch {
    invalid("a feed is a URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") invalid("a feed is an http or https URL")
  if (url.username !== "" || url.password !== "") invalid("a feed URL cannot carry a sign-in")
  return url.toString()
}

function defaultName(kind: SourceKind, target: string): string {
  if (kind === "folder") return target.split(/[\\/]/).filter(Boolean).pop() ?? target
  if (kind === "github") return `${target} issues`
  return new URL(target).hostname
}

/** Note files under a folder: no dot entries (so no `.env`), no dependency or build folders, no credential files. */
async function notesIn(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || found.length >= MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES || entry.name.startsWith(".")) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path, depth + 1)
      } else if (entry.isFile() && NOTE_FILE.test(entry.name) && !isSensitiveWorkspacePath(path)) {
        const info = await stat(path).catch(() => undefined)
        if (info !== undefined && info.size <= MAX_FILE_BYTES) found.push(path)
      }
    }
  }
  await walk(root, 0)
  return found
}

/** Paragraph-aligned pieces of at most 1500 characters. */
export function chunks(text: string): readonly string[] {
  const pieces: string[] = []
  let current = ""
  for (const paragraph of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (trimmed.length === 0) continue
    for (let start = 0; start < trimmed.length; start += MAX_CHUNK) {
      const part = trimmed.slice(start, start + MAX_CHUNK)
      if (current.length > 0 && current.length + part.length + 2 > MAX_CHUNK) {
        pieces.push(current)
        current = ""
      }
      current = current.length === 0 ? part : `${current}\n\n${part}`
    }
    if (pieces.length >= MAX_CHUNKS_PER_FILE) break
  }
  if (current.length > 0) pieces.push(current)
  return pieces.slice(0, MAX_CHUNKS_PER_FILE)
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ""
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new MemoryError("MEMORY_SOURCE_FAILED", "the feed is larger than 2 MiB")
    }
    parts.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}

/** RSS `<item>`s or Atom `<entry>`s: a title, a short text, and a stable ref. */
export function feedItems(xml: string): readonly { readonly ref: string; readonly title: string; readonly summary: string }[] {
  return feedBlocks(xml).flatMap((block) => {
    const lower = asciiLower(block)
    const title = plain(tag(block, lower, "title") ?? "")
    const summary = plain(tag(block, lower, "content:encoded") ?? tag(block, lower, "content") ?? tag(block, lower, "description") ?? tag(block, lower, "summary") ?? "")
    const link = tag(block, lower, "link") ?? linkHref(block, lower)
    const ref = plain(tag(block, lower, "guid") ?? tag(block, lower, "id") ?? link ?? title).slice(0, 512)
    return title.length === 0 && summary.length === 0 ? [] : [{ ref: ref.length > 0 ? ref : sha(block).slice(0, 16), title, summary: summary.slice(0, 3_500) }]
  })
}

// The feed comes from anywhere, so every scan below only moves forward: a feed of unclosed tags
// costs one pass, not one pass per tag, which a lazy regex retried at each tag would.

/** Every complete `<item>` or `<entry>`, in document order. */
function feedBlocks(xml: string): readonly string[] {
  const lower = asciiLower(xml)
  const blocks: string[] = []
  const next = new Map<string, number>([["item", -1], ["entry", -1]])
  let from = 0
  for (;;) {
    let name: string | undefined
    let start = -1
    for (const [candidate, known] of next) {
      const at = known >= from ? known : openTagAt(lower, candidate, from)
      next.set(candidate, at)
      if (at < 0) next.delete(candidate)
      else if (start < 0 || at < start) [name, start] = [candidate, at]
    }
    if (name === undefined) return blocks
    const close = lower.indexOf(`</${name}>`, start + name.length + 2)
    // Nothing of that name closes past here, so no later one of it can either.
    if (close < 0) {
      next.delete(name)
      continue
    }
    from = close + name.length + 3
    blocks.push(xml.slice(start, from))
  }
}

/** Where the next `<name` followed by space or `>` starts, or -1. */
function openTagAt(lower: string, name: string, from: number): number {
  for (let at = lower.indexOf(`<${name}`, from); at >= 0; at = lower.indexOf(`<${name}`, at + 1)) {
    const after = lower[at + name.length + 1]
    if (after === ">" || (after !== undefined && /\s/.test(after))) return at
  }
  return -1
}

function tag(block: string, lower: string, name: string): string | undefined {
  const at = openTagAt(lower, name, 0)
  if (at < 0) return undefined
  const end = lower.indexOf(">", at + name.length + 1)
  if (end < 0) return undefined
  const close = lower.indexOf(`</${name}>`, end + 1)
  return close < 0 ? undefined : block.slice(end + 1, close)
}

/** An Atom `<link href="...">`. */
function linkHref(block: string, lower: string): string | undefined {
  let href = -1
  for (let at = lower.indexOf("<link"); at >= 0;) {
    const end = lower.indexOf(">", at)
    if (href < at) href = lower.indexOf('href="', at)
    if (href < 0) return undefined
    if (end < 0 || href < end) {
      const close = block.indexOf('"', href + 6)
      if (close < 0) return undefined
      if (close > href + 6) return block.slice(href + 6, close)
    }
    if (end < 0) return undefined
    at = lower.indexOf("<link", end)
  }
  return undefined
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

function plain(value: string): string {
  return stripTags(unwrapCdata(value))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : "\ufffd")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

function unwrapCdata(value: string): string {
  let out = ""
  let from = 0
  for (;;) {
    const start = value.indexOf("<![CDATA[", from)
    const end = start < 0 ? -1 : value.indexOf("]]>", start + 9)
    if (end < 0) return out + value.slice(from)
    out += value.slice(from, start) + value.slice(start + 9, end)
    from = end + 3
  }
}

function stripTags(value: string): string {
  let out = ""
  let from = 0
  for (let start = value.indexOf("<"); start >= 0; start = value.indexOf("<", from)) {
    const end = value.indexOf(">", start + 1)
    if (end < 0) break
    if (end === start + 1) {
      out += value.slice(from, end)
      from = end
      continue
    }
    out += `${value.slice(from, start)} `
    from = end + 1
  }
  return out + value.slice(from)
}
