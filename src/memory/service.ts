import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { FileLockError, withFileLock } from "../auth/lock.ts"
import { MAX_EMBED_BATCH, meaningFloor, NOISE_TEXTS, type Embed, type EmbeddingChoice } from "./embeddings.ts"
import { LocalMemory, type SimilarHit } from "./local.ts"
import { McpMemory, parseMcpMemoryConfig, SERVER_MEMORY_PRESET, type McpMemoryConfig } from "./mcp.ts"
import { MemorySources } from "./sources.ts"
import { MemoryError, type Memory, type MemoryProvider, type MemoryScope, type RecallHit } from "./types.ts"
import { GitError } from "../git/errors.ts"
import { runGit } from "../git/run.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"

/**
 * Memory for one engine: the person's memories and this project's, local by default or
 * in the external server the person chose. Every engine shares `~/.runrail/memory/`.
 */

export type ScopeName = "project" | "person"

export interface MemoryServiceOptions {
  /** `~/.runrail/memory`. */
  readonly dir: string
  /** The project's root, or undefined for an engine with no project. */
  readonly root?: string
  readonly gh?: (args: readonly string[]) => Promise<string>
  readonly fetch?: typeof fetch
  readonly connect?: ConstructorParameters<typeof McpMemory>[1]
  /** Asks the person's chosen embedding model; without it, recall is by keyword only. */
  readonly embed?: Embed
}

export interface MemorySettings {
  readonly provider: "local" | McpMemoryConfig
  /** The embedding model local memories are also recalled by meaning with; none means keyword only. */
  readonly embeddings?: EmbeddingSettings
}

export interface EmbeddingSettings extends EmbeddingChoice {
  /** The similarity a memory must reach, measured on this model when it was picked. */
  readonly floor?: number
}

export interface SemanticStatus extends EmbeddingSettings {
  readonly indexed: number
  readonly pending: number
  readonly indexing: boolean
  /** Why the last embedding call failed; recall falls back to keywords meanwhile. */
  readonly problem?: string
}

export interface RecallResult {
  readonly hits: readonly (RecallHit & { readonly from: "local" | "mcp" })[]
  /** The external server failed and local memory answered instead. */
  readonly fellBack?: string
}

/** Recall keeps hits with at least this score (`recallScore`, D14). */
export const RECALL_FLOOR = 0.34
/** Recall by meaning keeps hits at least this similar to the query (cosine of unit vectors). Not yet calibrated per model. */
/** The floor for a model picked before floors were measured per model. */
export const MEANING_FLOOR = 0.5
// Reciprocal rank fusion's constant: a hit's weight from one ranking is 1 / (k + rank).
const RRF_K = 60
const MAX_QUERY_EMBED_CHARS = 4_000
const QUERY_EMBED_MS = 2_500
const CHECK_EMBED_MS = 30_000
const BATCH_EMBED_MS = 60_000
const INDEX_START_MS = 2_000
const INDEX_BUSY_MS = 30_000
const INDEX_RETRY_MS = 60_000
const INDEX_RETRY_MAX_MS = 30 * 60_000
const MESSAGE_RECALL = 3
// Searched deeper than kept, so third-party hits left out do not crowd out the person's own.
const RECALL_SEARCH = 10
const THIRD_PARTY: ReadonlySet<string> = new Set(["github", "feed"])

export function projectScope(root: string): MemoryScope {
  return `project:${createHash("sha256").update(projectKey(root)).digest("hex").slice(0, 16)}`
}

const PROJECT_KEY_ARGS = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"] as const
const PROJECT_KEY_TIMEOUT_MS = 5_000
const PROJECT_KEY_MAX_BYTES = 16 * 1024

/**
 * The project a folder belongs to: a thread's worktree counts as the checkout it came from, at the
 * same place inside it, so its thread recalls the project's memories. Each folder is asked once per
 * process; a folder git cannot answer for in time (or at all) is its own project.
 */
export async function resolveProjectKey(root: string, options: { readonly gitCommand?: string; readonly timeoutMs?: number } = {}): Promise<string> {
  const known = projectKeys.get(root)
  if (known !== undefined) return known
  let answer: string | undefined
  try {
    answer = (await runGit({ cwd: root, args: PROJECT_KEY_ARGS, timeoutMs: options.timeoutMs ?? PROJECT_KEY_TIMEOUT_MS, maxOutputBytes: PROJECT_KEY_MAX_BYTES, ...(options.gitCommand === undefined ? {} : { gitCommand: options.gitCommand }) })).stdout
  } catch (error) {
    if (!(error instanceof GitError)) throw error
  }
  const real = answer === undefined ? undefined : await realpath(root).catch(() => undefined)
  return rememberProjectKey(root, answer === undefined || real === undefined ? root : keyFromGit(root, answer, real))
}

/** `resolveProjectKey` for a caller that cannot wait: git runs synchronously, with the same bounds. */
export function projectKey(root: string): string {
  const known = projectKeys.get(root)
  if (known !== undefined) return known
  let key = root
  try {
    const result = Bun.spawnSync(["git", ...PROJECT_KEY_ARGS], { cwd: root, stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "" }, timeout: PROJECT_KEY_TIMEOUT_MS, maxBuffer: PROJECT_KEY_MAX_BYTES })
    if (result.exitCode === 0 && result.exitedDueToTimeout !== true && result.exitedDueToMaxBuffer !== true) key = keyFromGit(root, result.stdout.toString(), realpathSync(root))
  } catch {
    // No git, or the folder is gone: it is its own project, as when git has no answer.
  }
  return rememberProjectKey(root, key)
}

const projectKeys = new Map<string, string>()

function rememberProjectKey(root: string, key: string): string {
  if (projectKeys.size >= 256) projectKeys.clear()
  projectKeys.set(root, key)
  return key
}

function keyFromGit(root: string, answer: string, real: string): string {
  const [top, common] = answer.trim().split("\n")
  if (top === undefined || common === undefined || basename(common) !== ".git") return root
  // git answers with real paths; the root may come through a symlink (`/var` on macOS).
  const inside = relative(top, real)
  return inside.startsWith("..") ? root : join(dirname(common), inside)
}

export class MemoryService {
  readonly local: LocalMemory
  readonly sources: MemorySources
  #external: { readonly key: string; readonly provider: McpMemory } | undefined
  #projectScope: MemoryScope | undefined
  #indexing: Promise<void> | undefined
  #indexAgain = false
  #indexTimer: ReturnType<typeof setTimeout> | undefined
  #retryMs = INDEX_RETRY_MS
  #problem: string | undefined
  #closed = false
  readonly #stop = new AbortController()

  constructor(private readonly options: MemoryServiceOptions) {
    this.local = new LocalMemory(join(options.dir, "memory.db"), { onChange: () => this.#scheduleIndex() })
    this.sources = new MemorySources({ path: join(options.dir, "sources.json"), memory: this.local, ...(options.gh === undefined ? {} : { gh: options.gh }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
    // Memories added while no engine was indexing, or before a model was picked, catch up here.
    this.#scheduleIndex(INDEX_START_MS)
  }

  get projectScope(): MemoryScope | undefined {
    if (this.options.root === undefined) return undefined
    this.#projectScope ??= projectScope(this.options.root)
    return this.#projectScope
  }

  scope(name: unknown): MemoryScope {
    if (name === "person") return "person"
    if (name === "project") return this.projectScope ?? invalid("this engine has no project")
    return invalid("scope must be project or person")
  }

  scopes(names: unknown): readonly MemoryScope[] {
    if (names === undefined) return this.projectScope === undefined ? ["person"] : [this.projectScope, "person"]
    if (!Array.isArray(names) || names.length === 0 || names.length > 2) invalid("scopes must list project, person, or both")
    return [...new Set(names.map((name) => this.scope(name)))]
  }

  /** `project` or `person` for a stored scope; another project's scope reads as `other`. */
  scopeName(scope: MemoryScope): ScopeName | "other" | "external" {
    return scope === "person" ? "person" : scope === this.projectScope ? "project" : scope === "external" ? "external" : "other"
  }

  async settings(): Promise<MemorySettings> {
    const text = await readFile(join(this.options.dir, "settings.json"), "utf8").catch(() => undefined)
    if (text === undefined) return { provider: "local" }
    let parsed: { provider?: unknown; embeddings?: unknown }
    try {
      parsed = JSON.parse(text) as { provider?: unknown; embeddings?: unknown }
    } catch {
      return { provider: "local" }
    }
    let provider: MemorySettings["provider"] = "local"
    try {
      provider = parsed.provider === undefined || parsed.provider === "local" ? "local" : parseMcpMemoryConfig(parsed.provider)
    } catch {
      // An external server that no longer reads as valid leaves memory local.
    }
    const embeddings = storedEmbeddings(parsed.embeddings)
    return { provider, ...(embeddings === undefined ? {} : { embeddings }) }
  }

  /**
   * Changes the provider, the embedding model, or both; what is left out stays. `embeddings: null`
   * turns recall by meaning off. A new embedding model must answer one request before it is kept.
   */
  async saveSettings(value: unknown): Promise<MemorySettings> {
    const input = typeof value === "object" && value !== null ? (value as { provider?: unknown; embeddings?: unknown }) : invalid("settings must be an object")
    if (input.provider === undefined && input.embeddings === undefined) invalid("settings must name a provider or an embedding model")
    const current = await this.settings()
    const provider = input.provider === undefined ? current.provider : input.provider === "local" ? "local" : input.provider === "server-memory" ? SERVER_MEMORY_PRESET : parseMcpMemoryConfig(input.provider)
    const picked = input.embeddings === undefined || input.embeddings === null ? undefined : embeddingChoice(input.embeddings) ?? invalid("the embedding model must name a connection and a model")
    const changedModel = input.embeddings !== undefined && (picked?.connectionId !== current.embeddings?.connectionId || picked?.model !== current.embeddings?.model)
    let embeddings: EmbeddingSettings | undefined = input.embeddings === undefined || !changedModel ? current.embeddings : picked
    if (embeddings !== undefined && changedModel) {
      if (this.options.embed === undefined) throw new MemoryError("MEMORY_UNAVAILABLE", "this engine cannot ask an embedding model")
      // The check doubles as the measure of this model's noise, which sets its floor.
      embeddings = { ...embeddings, floor: meaningFloor(await this.options.embed(embeddings, NOISE_TEXTS, AbortSignal.timeout(CHECK_EMBED_MS))) }
    }
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
    const path = join(this.options.dir, "settings.json")
    await writeFileAtomic(path, `${JSON.stringify({ version: 1, provider, ...(embeddings === undefined ? {} : { embeddings }) }, null, 2)}\n`)
    if (changedModel) {
      // Vectors from another model cannot be compared with this one's.
      this.local.dropVectorsExcept(embeddings?.model)
      this.#problem = undefined
      this.#retryMs = INDEX_RETRY_MS
      this.#scheduleIndex()
    }
    return { provider, ...(embeddings === undefined ? {} : { embeddings }) }
  }

  /** The provider memories are written to: local, or the external server. */
  async provider(): Promise<MemoryProvider> {
    const { provider } = await this.settings()
    if (provider === "local") {
      await this.#dropExternal()
      return this.local
    }
    const key = JSON.stringify(provider)
    if (this.#external?.key !== key) {
      await this.#dropExternal()
      this.#external = { key, provider: new McpMemory(provider, this.options.connect) }
    }
    return this.#external.provider
  }

  /**
   * D14: the memories sharing the most of the query's words, above the floor, and, with an
   * embedding model picked, the local memories closest in meaning, fused by rank. With an external
   * server, sources (always local) are searched too; a failing server falls back to local, and says so.
   */
  async recall(query: string, scopes: readonly MemoryScope[], limit: number): Promise<RecallResult> {
    const provider = await this.provider()
    if (provider.kind === "local") return { hits: await this.#localRecall(query, scopes, limit) }
    let external: RecallResult["hits"]
    try {
      external = (await provider.recall(query, scopes, limit)).map((hit) => ({ ...hit, from: "mcp" as const }))
    } catch (error) {
      return { hits: await this.#localRecall(query, scopes, limit), fellBack: error instanceof MemoryError ? error.message : "the memory server failed" }
    }
    const hits = [...external.filter((hit) => hit.score >= RECALL_FLOOR), ...(await this.#localRecall(query, scopes, limit))].sort((a, b) => b.score - a.score)
    return { hits: hits.slice(0, limit) }
  }

  async #localRecall(query: string, scopes: readonly MemoryScope[], limit: number): Promise<RecallResult["hits"]> {
    const keyword = await this.local.recall(query, scopes, limit)
    const choice = (await this.settings()).embeddings
    const meaning = await this.#meaning(choice, query, scopes, limit)
    return fuse(keyword, meaning, limit, choice?.floor ?? MEANING_FLOOR)
  }

  /** The local memories closest in meaning, or nothing when no model is picked or it does not answer in time. */
  async #meaning(choice: EmbeddingSettings | undefined, query: string, scopes: readonly MemoryScope[], limit: number): Promise<readonly SimilarHit[]> {
    if (choice === undefined || this.options.embed === undefined) return []
    try {
      const [vector] = await this.options.embed(choice, [query.slice(0, MAX_QUERY_EMBED_CHARS)], AbortSignal.any([AbortSignal.timeout(QUERY_EMBED_MS), this.#stop.signal]))
      return vector === undefined ? [] : this.local.similar(choice.model, vector, scopes, limit)
    } catch (error) {
      this.#problem = problemOf(error)
      return []
    }
  }

  /**
   * Recall for a message about to be sent: never slower than `waitMs`, local memory after that.
   * Text from an issue or a feed anyone can write never joins a message by itself; `recall` still finds it.
   */
  async recallForMessage(query: string, waitMs = 4_000): Promise<RecallResult> {
    const scopes = this.scopes(undefined)
    const own = (result: RecallResult): RecallResult => ({ ...result, hits: result.hits.filter((hit) => !THIRD_PARTY.has(hit.source.kind)).slice(0, MESSAGE_RECALL) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<RecallResult>((resolve) => {
      timer = setTimeout(() => void this.local.recall(query, scopes, RECALL_SEARCH).then(
        (hits) => resolve({ hits: hits.filter((hit) => hit.score >= RECALL_FLOOR).map((hit) => ({ ...hit, from: "local" as const })), fellBack: "it took too long" }),
        () => resolve({ hits: [], fellBack: "it took too long" }),
      ), waitMs)
    })
    try {
      return own(await Promise.race([this.recall(query, scopes, RECALL_SEARCH), late]))
    } finally {
      clearTimeout(timer)
    }
  }

  async status(): Promise<{
    readonly provider: { readonly kind: "local" | "mcp"; readonly name?: string }
    readonly health: { readonly ok: boolean; readonly detail?: string }
    readonly counts: Readonly<Record<ScopeName, number>>
  }> {
    const provider = await this.provider()
    const counts = this.local.counts()
    const semantic = await this.semanticStatus()
    return {
      provider: provider.kind === "local" ? { kind: "local" } : { kind: "mcp", name: (provider as McpMemory).config.name },
      health: await provider.health(),
      counts: { project: this.projectScope === undefined ? 0 : (counts[this.projectScope] ?? 0), person: counts.person ?? 0 },
      ...(semantic === undefined ? {} : { semantic }),
    }
  }

  /** How far recall by meaning has come: memories with a vector from the picked model, and those still without one. */
  async semanticStatus(): Promise<SemanticStatus | undefined> {
    const choice = (await this.settings()).embeddings
    if (choice === undefined) return undefined
    const counts = this.local.embedded(choice.model)
    if (counts.pending > 0) this.#scheduleIndex()
    return { ...choice, ...counts, indexing: this.#indexing !== undefined, ...(this.#problem === undefined ? {} : { problem: this.#problem }) }
  }

  async close(): Promise<void> {
    this.#closed = true
    clearTimeout(this.#indexTimer)
    this.#stop.abort()
    await this.#indexing
    await this.#dropExternal()
    await this.local.close()
  }

  #scheduleIndex(delayMs = 0): void {
    if (this.options.embed === undefined || this.#closed) return
    if (this.#indexing !== undefined) {
      this.#indexAgain = true
      return
    }
    clearTimeout(this.#indexTimer)
    this.#indexTimer = setTimeout(() => {
      this.#indexTimer = undefined
      this.#indexing = this.#index().finally(() => {
        this.#indexing = undefined
        if (this.#indexAgain) {
          this.#indexAgain = false
          this.#scheduleIndex()
        }
      })
    }, delayMs)
    ;(this.#indexTimer as { unref?: () => void }).unref?.()
  }

  /**
   * Embeds every memory the picked model has no vector for, a batch at a time. Every engine shares
   * the file, so one indexes at a time; another that finds the lock taken tries again later.
   */
  async #index(): Promise<void> {
    const embed = this.options.embed
    const choice = (await this.settings()).embeddings
    if (embed === undefined || choice === undefined || this.#closed) return
    try {
      await withFileLock(join(this.options.dir, "index.lock"), async () => {
        while (!this.#closed) {
          const latest = (await this.settings()).embeddings
          if (latest?.connectionId !== choice.connectionId || latest.model !== choice.model) return
          const batch = this.local.unembedded(choice.model, MAX_EMBED_BATCH)
          if (batch.length === 0) return
          const vectors = await embed(choice, batch.map((entry) => entry.text), AbortSignal.any([AbortSignal.timeout(BATCH_EMBED_MS), this.#stop.signal]))
          const stored = this.local.storeVectors(choice.model, batch.flatMap((entry, index) => {
            const vector = vectors[index]
            return vector === undefined ? [] : [{ ...entry, vector }]
          }))
          // Nothing kept means every text changed meanwhile; the next run starts from what is there then.
          if (stored === 0) return
        }
      }, { timeoutMs: 1_000, signal: this.#stop.signal })
      this.#problem = undefined
      this.#retryMs = INDEX_RETRY_MS
    } catch (error) {
      if (this.#closed) return
      if (error instanceof FileLockError) {
        this.#scheduleIndex(INDEX_BUSY_MS)
        return
      }
      this.#problem = problemOf(error)
      this.#scheduleIndex(this.#retryMs)
      this.#retryMs = Math.min(this.#retryMs * 2, INDEX_RETRY_MAX_MS)
    }
  }

  async #dropExternal(): Promise<void> {
    const external = this.#external
    this.#external = undefined
    await external?.provider.close()
  }
}

/**
 * Reciprocal rank fusion of the keyword and meaning rankings, each cut at its own floor. A memory
 * both find ranks above one only one finds; its score is the better of the two.
 */
function fuse(keyword: readonly RecallHit[], meaning: readonly SimilarHit[], limit: number, floor: number): RecallResult["hits"] {
  const found = new Map<string, { readonly memory: Memory; weight: number; keyword?: number; similarity?: number }>()
  keyword.forEach((hit, rank) => {
    if (hit.score < RECALL_FLOOR) return
    const { score, ...memory } = hit
    found.set(hit.id, { memory, weight: 1 / (RRF_K + rank + 1), keyword: score })
  })
  meaning.forEach((hit, rank) => {
    if (hit.similarity < floor) return
    const entry = found.get(hit.memory.id)
    if (entry === undefined) found.set(hit.memory.id, { memory: hit.memory, weight: 1 / (RRF_K + rank + 1), similarity: hit.similarity })
    else {
      entry.weight += 1 / (RRF_K + rank + 1)
      entry.similarity = hit.similarity
    }
  })
  return [...found.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.memory,
      score: Math.max(entry.keyword ?? 0, entry.similarity ?? 0),
      from: "local" as const,
      match: entry.keyword !== undefined && entry.similarity !== undefined ? "both" as const : entry.keyword !== undefined ? "keyword" as const : "meaning" as const,
    }))
}

function storedEmbeddings(value: unknown): EmbeddingSettings | undefined {
  const choice = embeddingChoice(value)
  if (choice === undefined) return undefined
  const floor = (value as { floor?: unknown }).floor
  return typeof floor === "number" && floor > 0 && floor < 1 ? { ...choice, floor } : choice
}

function embeddingChoice(value: unknown): EmbeddingChoice | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const { connectionId, model } = value as { connectionId?: unknown; model?: unknown }
  if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.length > 256 || /[\0-\x1f\x7f]/.test(connectionId)) return undefined
  if (typeof model !== "string" || model.length === 0 || model.length > 256 || /[\0-\x1f\x7f]/.test(model)) return undefined
  return { connectionId, model }
}

/** A reason fit to show the person: Runrail's own words, never what a provider wrote back. */
function problemOf(error: unknown): string {
  if (error instanceof MemoryError) return error.message
  if (error instanceof Error && error.name === "TimeoutError") return "The embedding model did not answer in time."
  return "The embedding model could not answer."
}

function invalid(message: string): never {
  throw new MemoryError("MEMORY_INVALID", message)
}

export type { Memory }
