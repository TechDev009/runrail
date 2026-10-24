import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { LocalMemory } from "./local.ts"
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
}

export interface MemorySettings {
  readonly provider: "local" | McpMemoryConfig
}

export interface RecallResult {
  readonly hits: readonly (RecallHit & { readonly from: "local" | "mcp" })[]
  /** The external server failed and local memory answered instead. */
  readonly fellBack?: string
}

/** Recall keeps hits with at least this score (`recallScore`, D14). */
export const RECALL_FLOOR = 0.34
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

  constructor(private readonly options: MemoryServiceOptions) {
    this.local = new LocalMemory(join(options.dir, "memory.db"))
    this.sources = new MemorySources({ path: join(options.dir, "sources.json"), memory: this.local, ...(options.gh === undefined ? {} : { gh: options.gh }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
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
    try {
      const parsed = JSON.parse(text) as { provider?: unknown }
      return { provider: parsed.provider === undefined || parsed.provider === "local" ? "local" : parseMcpMemoryConfig(parsed.provider) }
    } catch {
      return { provider: "local" }
    }
  }

  async saveSettings(value: unknown): Promise<MemorySettings> {
    const input = typeof value === "object" && value !== null ? (value as { provider?: unknown }) : invalid("settings must be an object")
    const provider = input.provider === "local" ? "local" : input.provider === "server-memory" ? SERVER_MEMORY_PRESET : parseMcpMemoryConfig(input.provider)
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
    const path = join(this.options.dir, "settings.json")
    await writeFileAtomic(path, `${JSON.stringify({ version: 1, provider }, null, 2)}\n`)
    return { provider }
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
   * D14: the memories sharing the most of the query's words, above the floor. With an external
   * server, sources (always local) are searched too; a failing server falls back to local, and says so.
   */
  async recall(query: string, scopes: readonly MemoryScope[], limit: number): Promise<RecallResult> {
    const provider = await this.provider()
    const local = async (): Promise<RecallResult["hits"]> => (await this.local.recall(query, scopes, limit)).map((hit) => ({ ...hit, from: "local" as const }))
    if (provider.kind === "local") return { hits: (await local()).filter((hit) => hit.score >= RECALL_FLOOR) }
    let external: RecallResult["hits"]
    try {
      external = (await provider.recall(query, scopes, limit)).map((hit) => ({ ...hit, from: "mcp" as const }))
    } catch (error) {
      return { hits: (await local()).filter((hit) => hit.score >= RECALL_FLOOR), fellBack: error instanceof MemoryError ? error.message : "the memory server failed" }
    }
    const hits = [...external, ...(await local())].filter((hit) => hit.score >= RECALL_FLOOR).sort((a, b) => b.score - a.score)
    return { hits: hits.slice(0, limit) }
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
    return {
      provider: provider.kind === "local" ? { kind: "local" } : { kind: "mcp", name: (provider as McpMemory).config.name },
      health: await provider.health(),
      counts: { project: this.projectScope === undefined ? 0 : (counts[this.projectScope] ?? 0), person: counts.person ?? 0 },
    }
  }

  async close(): Promise<void> {
    await this.#dropExternal()
    await this.local.close()
  }

  async #dropExternal(): Promise<void> {
    const external = this.#external
    this.#external = undefined
    await external?.provider.close()
  }
}

function invalid(message: string): never {
  throw new MemoryError("MEMORY_INVALID", message)
}

export type { Memory }
