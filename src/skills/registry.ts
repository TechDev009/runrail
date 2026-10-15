import { readdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import type { ContextResource } from "../context/resources.ts"
import { createWorkspacePolicy, type WorkspacePolicy } from "../workspace/policy.ts"

export type SkillScope = "explicit" | "project" | "plugin" | "user"
/**
 * Conventional project skill folders. Each may be absent, and they are ranked so a skill kept in
 * two of them resolves to one instead of conflicting.
 */
export const DEFAULT_SKILL_SOURCES: readonly SkillSource[] = Object.freeze([
  Object.freeze({ path: ".agents/skills", scope: "project" as const, priority: 203, optional: true }),
  Object.freeze({ path: ".claude/skills", scope: "project" as const, priority: 202, optional: true }),
  Object.freeze({ path: ".codex/skills", scope: "project" as const, priority: 201, optional: true }),
  Object.freeze({ path: ".pi/skills", scope: "project" as const, priority: 200, optional: true }),
])

/**
 * User-wide skill folders other tools keep under the home directory, relative to it and ranked
 * like the project folders. They are read in place only when a caller opts in.
 */
export const USER_SKILL_FOLDERS: readonly string[] = Object.freeze([
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".pi/agent/skills",
  ".config/opencode/skills",
])

export interface SkillSource {
  readonly path: string
  readonly scope?: SkillScope
  readonly priority?: number
  /** An optional source may be absent; it then contributes no skills. */
  readonly optional?: boolean
  /**
   * Absolute folder `path` is resolved in instead of the workspace, for skills kept outside the
   * project. It is read through its own workspace policy rooted there, with the same path rules.
   */
  readonly root?: string
  /** A file here that is not a valid skill fails the load, even in a registry that skips invalid files. */
  readonly strict?: boolean
  /**
   * Follow the links at the top of this source's folder to the skill folders (holding a SKILL.md)
   * or Markdown files they point at, each read through a policy rooted beside its target. For the
   * user-wide folders, where installers link skills in from elsewhere.
   */
  readonly followLinks?: boolean
}

/** A skill a caller holds in memory, such as one a plugin contributes. */
export interface SuppliedSkill {
  readonly id: string
  readonly content: string
}

export interface SkillDescriptor {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly path: string
  readonly scope: SkillScope
  readonly priority: number
  readonly content: string
}

export interface SkillRegistryOptions {
  readonly sources?: readonly SkillSource[]
  readonly maxSkills?: number
  readonly maxSkillBytes?: number
  readonly maxFileBytes?: number
  /** Skill ids excluded from selection (RPC-managed toggles). Listed via excluded(). */
  readonly exclude?: readonly string[]
  /**
   * Leave out a file that is not a valid skill instead of failing the whole load. For folders other
   * tools also write to, where one stray file must not stop a session. Listed via skipped().
   */
  readonly skipInvalid?: boolean
  /** In-memory skills, ranked below project folders and above user-wide ones. Re-read at each load. */
  readonly supplied?: readonly SuppliedSkill[]
}

export interface DefaultSkillRegistryOptions extends SkillRegistryOptions {
  /** Home directory whose user-wide skill folders are read in place, below the project's own. */
  readonly userHome?: string
  /** Sources read on top of the conventional folders, such as skill paths a caller names. */
  readonly additionalSources?: readonly SkillSource[]
}

export interface SkippedSkillFile {
  readonly path: string
  readonly code: SkillRegistryErrorCode
}

export interface SkillCatalogLimits {
  readonly maxBytes?: number
  readonly maxEntries?: number
}

const FRONTMATTER_FIELDS: ReadonlySet<string> = new Set(["id", "name", "description"])
const MAX_FRONTMATTER_VALUE = 1_024
/** Entries read from one source folder, files and folders alike: a skill may carry scripts and assets. */
const MAX_SOURCE_ENTRIES = 2_048
const MAX_SKIPPED = 256
const MAX_SUPPLIED = 256
const MAX_LINKED_SKILLS = 256
const MAX_EXCLUDED = 512
const PLUGIN_PRIORITY = 150
/** Reference files listed for one skill, and how deep below its folder they are looked for. */
const MAX_SKILL_FILES = 64
const MAX_SKILL_FILE_DEPTH = 3
const MAX_CATALOG_DESCRIPTION = 240
/** A description clipped shorter than this says nothing useful, so it is left out instead. */
const MIN_CATALOG_DESCRIPTION = 24
const CATALOG_HEADER = "Installed skills, one per line as `id: description`. Their instructions are not loaded yet: when a task matches a skill, call `skill_read` with its id before you start, and follow what it returns."

export type SkillRegistryErrorCode = "SKILL_INVALID" | "SKILL_LIMIT" | "SKILL_CONFLICT" | "SKILL_SOURCE_FAILED" | "SKILL_NOT_FOUND"

export class SkillRegistryError extends Error {
  constructor(readonly code: SkillRegistryErrorCode, reason: string) {
    super(`skill registry: ${reason}`)
    this.name = "SkillRegistryError"
  }
}

/** Deterministic local skill discovery with explicit scope precedence and transactional reload. */
export class SkillRegistry {
  private readonly options: Required<Pick<SkillRegistryOptions, "maxSkills" | "maxSkillBytes" | "maxFileBytes">>
  private readonly sources: readonly SkillSource[]
  private skills: readonly SkillDescriptor[] = []
  private discovered: readonly SkillDescriptor[] = []
  private skippedFiles: readonly SkippedSkillFile[] = []
  /** The policy each skill from a rooted source was read through; the rest use the workspace's. */
  private policies = new WeakMap<SkillDescriptor, WorkspacePolicy>()
  private readonly skipInvalid: boolean
  private readonly supplied: readonly SuppliedSkill[]
  private excludedIds: Set<string>

  constructor(private readonly policy: WorkspacePolicy, options: SkillRegistryOptions = {}) {
    this.sources = normalizeSources(options.sources ?? [])
    this.supplied = normalizeSupplied(options.supplied)
    this.options = {
      maxSkills: options.maxSkills ?? 128,
      maxSkillBytes: options.maxSkillBytes ?? 256 * 1024,
      maxFileBytes: options.maxFileBytes ?? 256 * 1024,
    }
    assertBound(this.options.maxSkills, 1, 512, "maxSkills")
    assertBound(this.options.maxSkillBytes, 1, 4 * 1024 * 1024, "maxSkillBytes")
    assertBound(this.options.maxFileBytes, 1, 4 * 1024 * 1024, "maxFileBytes")
    this.excludedIds = new Set(normalizeExcluded(options.exclude))
    this.skipInvalid = options.skipInvalid === true
  }

  async reload(): Promise<readonly SkillDescriptor[]> {
    const discovered: SkillDescriptor[] = []
    const skipped: SkippedSkillFile[] = []
    const policies = new WeakMap<SkillDescriptor, WorkspacePolicy>()
    const skip = (path: string, code: SkillRegistryErrorCode): void => {
      if (skipped.length < MAX_SKIPPED) skipped.push(Object.freeze({ path, code }))
    }
    try {
      for (const source of this.sources) {
        const policy = await this.sourcePolicy(source)
        if (policy === undefined) continue
        const units = [{ policy, source }, ...(source.followLinks === true ? await linkedSources(policy, source, skip) : [])]
        for (const unit of units) {
          let files: readonly string[]
          try {
            files = await discoverFiles(unit.policy, unit.source)
          } catch (error) {
            // A shared folder that cannot be read (permissions, not a folder) is left out like a stray file.
            if (!this.skipInvalid || unit.source.optional !== true) throw error
            skip(unit.source.root ?? unit.source.path, error instanceof SkillRegistryError ? error.code : "SKILL_SOURCE_FAILED")
            continue
          }
          for (const path of files) {
            if (this.skipInvalid && discovered.length >= this.options.maxSkills * 4) {
              skip(path, "SKILL_LIMIT")
              continue
            }
            try {
              const content = await unit.policy.read(path, this.options.maxFileBytes)
              if (Buffer.byteLength(content, "utf8") > this.options.maxSkillBytes) throw new SkillRegistryError("SKILL_LIMIT", "skill exceeds its byte limit")
              const skill = parseSkill(path, unit.source, content)
              discovered.push(skill)
              if (unit.policy !== this.policy) policies.set(skill, unit.policy)
            } catch (error) {
              if (!this.skipInvalid || unit.source.strict === true) throw error
              skip(path, error instanceof SkillRegistryError ? error.code : "SKILL_SOURCE_FAILED")
            }
            if (discovered.length > this.options.maxSkills * 4) throw new SkillRegistryError("SKILL_LIMIT", "skill source contains too many files")
          }
        }
      }
      for (const supplied of this.supplied) {
        try {
          discovered.push(parseSupplied(supplied, this.options.maxSkillBytes))
        } catch (error) {
          if (!this.skipInvalid) throw error
          skip(`plugin:${supplied.id}`, error instanceof SkillRegistryError ? error.code : "SKILL_INVALID")
        }
      }
      const selected = selectSkills(discovered, this.options.maxSkills, this.skipInvalid ? skip : undefined)
      this.discovered = Object.freeze(discovered)
      this.skippedFiles = Object.freeze(skipped)
      this.policies = policies
      this.applyExclusions(selected)
      return this.skills
    } catch (error) {
      if (error instanceof SkillRegistryError) throw error
      throw new SkillRegistryError("SKILL_SOURCE_FAILED", error instanceof Error ? error.message : "skill source cannot be read")
    }
  }

  /** The workspace policy, or one rooted at the source's own folder. Undefined for an absent optional root. */
  private async sourcePolicy(source: SkillSource): Promise<WorkspacePolicy | undefined> {
    if (source.root === undefined) return this.policy
    try {
      return await createWorkspacePolicy(source.root)
    } catch (error) {
      if (source.optional === true) return undefined
      throw new SkillRegistryError("SKILL_SOURCE_FAILED", error instanceof Error ? error.message : "skill root cannot be read")
    }
  }

  list(query = ""): readonly SkillDescriptor[] {
    if (typeof query !== "string" || query.length > 256) throw new SkillRegistryError("SKILL_INVALID", "skill query is invalid")
    const normalized = query.toLowerCase()
    return Object.freeze(this.skills.filter((skill) => skill.id.toLowerCase().includes(normalized) || skill.name.toLowerCase().includes(normalized) || skill.description?.toLowerCase().includes(normalized) === true || skill.path.toLowerCase().includes(normalized)))
  }

  get(id: string): SkillDescriptor | undefined {
    if (!validId(id)) throw new SkillRegistryError("SKILL_INVALID", "skill id is invalid")
    return this.skills.find((skill) => skill.id === id)
  }

  isEnabled(id: string): boolean {
    if (!validId(id)) throw new SkillRegistryError("SKILL_INVALID", "skill id is invalid")
    return !this.excludedIds.has(id)
  }

  /** Skills excluded from selection, still listed for management UI. */
  excluded(): readonly SkillDescriptor[] {
    return Object.freeze(this.discovered.filter((skill) => this.excludedIds.has(skill.id)))
  }

  /** Files the last load left out because they are not valid skills. Empty unless skipInvalid is set. */
  skipped(): readonly SkippedSkillFile[] {
    return this.skippedFiles
  }

  setExcluded(ids: readonly string[]): readonly SkillDescriptor[] {
    const normalized = normalizeExcluded(ids)
    this.excludedIds = new Set(normalized)
    // The last load already recorded what it left out.
    this.applyExclusions(selectSkills(this.discovered, this.options.maxSkills, this.skipInvalid ? () => undefined : undefined))
    return this.skills
  }

  /** The enabled skill with this id. An excluded skill is refused like an unknown one. */
  read(id: string): SkillDescriptor {
    const skill = this.get(id)
    if (skill === undefined) throw new SkillRegistryError("SKILL_NOT_FOUND", "skill is not available")
    return skill
  }

  /** Reference files kept in an enabled skill's own folder, relative to it. Empty for a single-file skill. */
  async files(id: string): Promise<readonly string[]> {
    const { policy, folder } = this.locate(id)
    if (folder === undefined) return Object.freeze([])
    let entries: Awaited<ReturnType<WorkspacePolicy["list"]>>
    try {
      entries = await policy.list(folder, MAX_SKILL_FILE_DEPTH, MAX_SOURCE_ENTRIES)
    } catch {
      // A folder removed since the last load lists nothing; the skill's loaded body still stands.
      return Object.freeze([])
    }
    const prefix = folder === "." ? "" : `${folder}/`
    return Object.freeze(
      entries
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.path.replaceAll("\\", "/").slice(prefix.length))
        .filter((path) => !isSkillManifest(path) || path.includes("/"))
        .slice(0, MAX_SKILL_FILES),
    )
  }

  /**
   * One text file from an enabled skill's own folder, by a path relative to it. Paths that leave
   * the folder, through `..` or a link, and credential files are refused.
   */
  async readFile(id: string, file: string): Promise<string> {
    const { policy, folder } = this.locate(id)
    if (folder === undefined) throw new SkillRegistryError("SKILL_NOT_FOUND", "skill has no reference files")
    const path = folder === "." ? parseSkillFilePath(file) : `${folder}/${parseSkillFilePath(file)}`
    let content: string
    try {
      const inside = relative(await policy.resolveExisting(folder), await policy.resolveExisting(path))
      if (inside.length === 0 || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("skill file leaves its skill folder")
      content = await policy.read(path, this.options.maxFileBytes)
    } catch (error) {
      if (error instanceof RangeError) throw new SkillRegistryError("SKILL_LIMIT", "skill file exceeds its byte limit")
      throw new SkillRegistryError("SKILL_NOT_FOUND", "skill file is not available")
    }
    if (content.includes("\0")) throw new SkillRegistryError("SKILL_INVALID", "skill file is not text")
    return content
  }

  /**
   * The listing the model reads in place of skill bodies: one line per enabled skill, highest
   * priority first. Descriptions shrink to fit the byte budget and are left out when too short to
   * help; a skill that does not fit even by id is counted in a closing line. Undefined when no
   * skill is enabled.
   */
  catalog(limits: SkillCatalogLimits = {}): string | undefined {
    const maxBytes = limits.maxBytes ?? 16 * 1024
    const maxEntries = limits.maxEntries ?? 256
    assertBound(maxBytes, 1_024, 64 * 1024, "catalog maxBytes")
    assertBound(maxEntries, 1, 512, "catalog maxEntries")
    return renderCatalog(this.skills, maxBytes, maxEntries)
  }

  private locate(id: string): { readonly policy: WorkspacePolicy; readonly folder?: string } {
    const skill = this.read(id)
    const policy = this.policies.get(skill) ?? this.policy
    if (!isSkillManifest(skill.path)) return { policy }
    const slashed = skill.path.replaceAll("\\", "/")
    const cut = slashed.lastIndexOf("/")
    return { policy, folder: cut <= 0 ? "." : slashed.slice(0, cut) }
  }

  private applyExclusions(selected: readonly SkillDescriptor[]): void {
    this.skills = Object.freeze(selected.filter((skill) => !this.excludedIds.has(skill.id)))
  }

  resources(): readonly ContextResource[] {
    return Object.freeze(this.skills.map((skill) => Object.freeze({ id: `skill:${skill.id}`, kind: "skill" as const, path: skill.path, content: skill.content })))
  }

  snapshot(): readonly SkillDescriptor[] {
    return this.skills
  }
}

export async function createSkillRegistry(policy: WorkspacePolicy, options: SkillRegistryOptions = {}): Promise<SkillRegistry> {
  const registry = new SkillRegistry(policy, options)
  await registry.reload()
  return registry
}

/**
 * Skills from the conventional project folders. Those folders belong to other tools as well, so an
 * absent folder or a file that is not a valid skill is left out; explicit sources remain strict.
 * With `userHome`, the user-wide folders under it are read in place too, ranked below the project's.
 */
export async function createDefaultSkillRegistry(policy: WorkspacePolicy, options: DefaultSkillRegistryOptions = {}): Promise<SkillRegistry> {
  const { userHome, additionalSources, ...rest } = options
  const extra = [...(additionalSources ?? []), ...(userHome === undefined ? [] : userSkillSources(userHome))]
  if (rest.sources !== undefined) return createSkillRegistry(policy, extra.length === 0 ? rest : { ...rest, sources: [...rest.sources, ...extra] })
  // User-wide folders can hold hundreds of skills; only the listing the model reads is kept small.
  return createSkillRegistry(policy, { skipInvalid: true, ...(userHome === undefined ? {} : { maxSkills: 512 }), ...rest, sources: [...DEFAULT_SKILL_SOURCES, ...extra] })
}

/** Sources for the user-wide skill folders under `home`, each optional and ranked below every project folder. */
export function userSkillSources(home: string): readonly SkillSource[] {
  if (typeof home !== "string" || home.length === 0 || home.length > 4_096 || home.includes("\0") || !isAbsolute(home))
    throw new SkillRegistryError("SKILL_INVALID", "user home is invalid")
  return Object.freeze(USER_SKILL_FOLDERS.map((folder, index) => Object.freeze({ path: ".", root: join(home, folder), scope: "user" as const, priority: 104 - index, optional: true, followLinks: true })))
}

function normalizeSources(sources: readonly SkillSource[]): readonly SkillSource[] {
  if (!Array.isArray(sources) || sources.length > 64) throw new SkillRegistryError("SKILL_INVALID", "skill sources are invalid")
  const result = sources.map((source) => {
    if (source === null || typeof source !== "object" || typeof source.path !== "string" || source.path.length === 0 || source.path.length > 512)
      throw new SkillRegistryError("SKILL_INVALID", "skill source path is invalid")
    const scope = source.scope ?? "project"
    if (scope !== "explicit" && scope !== "project" && scope !== "plugin" && scope !== "user") throw new SkillRegistryError("SKILL_INVALID", "skill source scope is invalid")
    const priority = source.priority ?? scopePriority(scope)
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1_000) throw new SkillRegistryError("SKILL_INVALID", "skill source priority is invalid")
    if (source.root !== undefined && (typeof source.root !== "string" || source.root.length === 0 || source.root.length > 4_096 || source.root.includes("\0") || !isAbsolute(source.root)))
      throw new SkillRegistryError("SKILL_INVALID", "skill source root is invalid")
    return Object.freeze({
      path: source.path,
      scope,
      priority,
      ...(source.optional === true ? { optional: true } : {}),
      ...(source.root === undefined ? {} : { root: source.root }),
      ...(source.strict === true ? { strict: true } : {}),
      ...(source.followLinks === true ? { followLinks: true } : {}),
    })
  })
  return Object.freeze(result.sort((left, right) => right.priority - left.priority || left.path.localeCompare(right.path) || (left.root ?? "").localeCompare(right.root ?? "")))
}

/**
 * The links at the top of a followed folder, each as a source of its own: a target that is a skill
 * folder (it holds a SKILL.md) or a Markdown file, read through a policy rooted at its parent. Any
 * other target, a broken link, or one past the bound is reported through `skip`.
 */
async function linkedSources(
  policy: WorkspacePolicy,
  source: SkillSource,
  skip: (path: string, code: SkillRegistryErrorCode) => void,
): Promise<readonly { readonly policy: WorkspacePolicy; readonly source: SkillSource }[]> {
  let folder: string
  let links: string[]
  try {
    folder = await policy.resolveExisting(source.path)
    links = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name).sort()
  } catch {
    // The folder itself is reported by the regular read of this source.
    return Object.freeze([])
  }
  const result: { readonly policy: WorkspacePolicy; readonly source: SkillSource }[] = []
  for (const [index, name] of links.entries()) {
    if (index >= MAX_LINKED_SKILLS) {
      skip(name, "SKILL_LIMIT")
      continue
    }
    try {
      const target = await realpath(join(folder, name))
      const info = await stat(target)
      const manifest = info.isDirectory() ? (await readdir(target)).find((entry) => isSkillManifest(entry)) : undefined
      if (basename(target).length === 0 || !(manifest !== undefined || (info.isFile() && isSkillFile(target))))
        throw new SkillRegistryError("SKILL_INVALID", "linked entry is neither a skill folder nor a Markdown skill")
      // A folder is named by its SKILL.md, so the folder's other files stay its reference material.
      const path = manifest === undefined ? basename(target) : `${basename(target)}/${manifest}`
      result.push({
        policy: await createWorkspacePolicy(dirname(target)),
        source: Object.freeze({ path, scope: source.scope ?? "user", priority: source.priority ?? scopePriority(source.scope ?? "user"), optional: true }),
      })
    } catch (error) {
      skip(name, error instanceof SkillRegistryError ? error.code : "SKILL_SOURCE_FAILED")
    }
  }
  return Object.freeze(result)
}

async function discoverFiles(policy: WorkspacePolicy, source: SkillSource): Promise<readonly string[]> {
  try {
    const entries = await policy.list(source.path, 4, MAX_SOURCE_ENTRIES)
    const files = entries.filter((entry) => entry.type === "file" && isSkillFile(entry.path)).map((entry) => entry.path)
    // Listed paths are relative to the policy root, so the source folder is put in the same form (`./x`, `x/`).
    const folder = relative(policy.root, await policy.resolveExisting(source.path))
    return Object.freeze([...skillEntryFiles(files, folder, source.scope === "explicit")].sort())
  } catch {
    let resolved: string
    try {
      resolved = await policy.resolveExisting(source.path)
    } catch (error) {
      if (source.optional === true) return Object.freeze([])
      throw error
    }
    const name = resolved.split(/[\\/]/).pop() ?? ""
    if (!isSkillFile(name)) throw new SkillRegistryError("SKILL_SOURCE_FAILED", "skill source is neither a directory nor a Markdown skill file")
    return Object.freeze([source.path])
  }
}

/**
 * A folder that holds a SKILL.md is one skill: the other Markdown files in it are that skill's own
 * reference material, not skills. Markdown files outside such a folder are each a skill. A SKILL.md
 * at the top of a collection folder does not make the collection one skill, unless the folder was
 * named explicitly: then it is that one skill's folder.
 */
function skillEntryFiles(files: readonly string[], folder: string, explicit: boolean): readonly string[] {
  const slashed = (path: string): string => path.replaceAll("\\", "/")
  const root = folder.length === 0 ? "" : `${slashed(folder).replace(/\/+$/, "")}/`
  const folders = files
    .filter(isSkillManifest)
    .map((path) => slashed(path).slice(0, slashed(path).lastIndexOf("/") + 1))
    .filter((candidate) => candidate !== root || explicit)
  return files.filter((path) => isSkillManifest(path) || !folders.some((folder) => slashed(path).startsWith(folder)))
}

function parseSkill(path: string, source: SkillSource, raw: string): SkillDescriptor {
  const parsed = parseFrontmatter(raw)
  const derived = deriveId(path)
  const id = parsed.id ?? derived
  if (!validId(id)) throw new SkillRegistryError("SKILL_INVALID", "skill id is invalid")
  const name = parsed.name ?? id
  if (name.length === 0 || name.length > 256) throw new SkillRegistryError("SKILL_INVALID", "skill name is invalid")
  const content = parsed.body
  if (content.length === 0) throw new SkillRegistryError("SKILL_INVALID", "skill content is empty")
  return Object.freeze({ id, name, ...(parsed.description === undefined ? {} : { description: parsed.description }), path, scope: source.scope ?? "project", priority: source.priority ?? scopePriority(source.scope ?? "project"), content })
}

/**
 * Reads the fields this registry uses. Skill files are shared with other tools, so fields it does
 * not use (license, allowed-tools, metadata and the like) and their nested lines are passed over.
 */
function parseFrontmatter(raw: string): { readonly id?: string; readonly name?: string; readonly description?: string; readonly body: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return { body: raw }
  const start = raw.indexOf("\n") + 1
  const end = raw.indexOf("\n---", start - 1)
  if (end < 0 || end > 16 * 1024) throw new SkillRegistryError("SKILL_INVALID", "skill frontmatter is invalid")
  const fields = new Map<string, string>()
  // The field whose value continues on the indented lines below it, when it is one this registry reads.
  let open: string | undefined
  for (const line of raw.slice(start, Math.max(start, end)).split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue
    if (/^[ \t]/.test(line) || line.startsWith("- ")) {
      if (open !== undefined) fields.set(open, `${fields.get(open) ?? ""} ${line.trim()}`.trim())
      continue
    }
    const separator = line.indexOf(":")
    if (separator <= 0) throw new SkillRegistryError("SKILL_INVALID", "skill frontmatter entry is invalid")
    const key = line.slice(0, separator).trim()
    const value = unquote(line.slice(separator + 1).trim())
    open = undefined
    if (!FRONTMATTER_FIELDS.has(key)) continue
    const block = value.length === 0 || /^[>|][+-]?$/.test(value)
    if (block) open = key
    fields.set(key, block ? "" : value)
  }
  for (const value of fields.values()) if (value.length > MAX_FRONTMATTER_VALUE) throw new SkillRegistryError("SKILL_LIMIT", "skill frontmatter value is too large")
  const field = (key: string): string | undefined => (fields.get(key) === undefined || fields.get(key) === "" ? undefined : fields.get(key))
  const id = field("id")
  const name = field("name")
  const description = field("description")
  return { ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), body: raw.slice(end + 4).replace(/^\r?\n/, "") }
}

function parseSupplied(skill: SuppliedSkill, maxBytes: number): SkillDescriptor {
  if (Buffer.byteLength(skill.content, "utf8") > maxBytes) throw new SkillRegistryError("SKILL_LIMIT", "skill exceeds its byte limit")
  const parsed = parseFrontmatter(skill.content)
  const name = parsed.name ?? skill.id
  if (name.length === 0 || name.length > 256) throw new SkillRegistryError("SKILL_INVALID", "skill name is invalid")
  if (parsed.body.trim().length === 0) throw new SkillRegistryError("SKILL_INVALID", "skill content is empty")
  return Object.freeze({
    id: skill.id,
    name,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    path: `plugin:${skill.id}`,
    scope: "plugin" as const,
    priority: PLUGIN_PRIORITY,
    content: parsed.body,
  })
}

function normalizeSupplied(skills: readonly SuppliedSkill[] | undefined): readonly SuppliedSkill[] {
  if (skills === undefined) return Object.freeze([])
  if (!Array.isArray(skills) || skills.length > MAX_SUPPLIED) throw new SkillRegistryError("SKILL_INVALID", "supplied skills are invalid")
  return Object.freeze(skills.map((skill: unknown) => {
    if (!isRecord(skill) || !validId(skill.id) || typeof skill.content !== "string") throw new SkillRegistryError("SKILL_INVALID", "supplied skill is invalid")
    return Object.freeze({ id: skill.id, content: skill.content })
  }))
}

function unquote(value: string): string {
  const quote = value[0]
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value
}

/**
 * One skill per id, the higher priority winning. With `skip`, the load is lenient: a same-priority
 * conflict keeps the first path and a count past the limit drops the lowest-priority skills, each
 * reported through `skip`; without it, either fails the load.
 */
function selectSkills(skills: readonly SkillDescriptor[], maxSkills: number, skip?: (path: string, code: SkillRegistryErrorCode) => void): readonly SkillDescriptor[] {
  const selected = new Map<string, SkillDescriptor>()
  for (const skill of skills) {
    const existing = selected.get(skill.id)
    if (existing === undefined) {
      selected.set(skill.id, skill)
      continue
    }
    if (existing.priority === skill.priority && existing.content !== skill.content) {
      if (skip === undefined) throw new SkillRegistryError("SKILL_CONFLICT", `skill '${skill.id}' has conflicting sources`)
      skip(skill.path < existing.path ? existing.path : skill.path, "SKILL_CONFLICT")
    }
    if (skill.priority > existing.priority || (skill.priority === existing.priority && skill.path < existing.path)) selected.set(skill.id, skill)
  }
  let chosen = [...selected.values()]
  if (chosen.length > maxSkills) {
    if (skip === undefined) throw new SkillRegistryError("SKILL_LIMIT", "skill count exceeds its limit")
    chosen.sort(byPriority)
    for (const skill of chosen.slice(maxSkills)) skip(skill.path, "SKILL_LIMIT")
    chosen = chosen.slice(0, maxSkills)
  }
  return Object.freeze(chosen.sort((left, right) => left.id.localeCompare(right.id)))
}

function byPriority(left: SkillDescriptor, right: SkillDescriptor): number {
  return right.priority - left.priority || left.id.localeCompare(right.id)
}

function renderCatalog(skills: readonly SkillDescriptor[], maxBytes: number, maxEntries: number): string | undefined {
  if (skills.length === 0) return undefined
  const ordered = [...skills].sort(byPriority)
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8")
  // Room kept for the closing line that counts skills left out.
  let budget = maxBytes - bytes(CATALOG_HEADER) - 1 - 96
  const listed: SkillDescriptor[] = []
  for (const skill of ordered) {
    const line = bytes(`- ${skill.id}`) + 1
    if (listed.length >= maxEntries || line > budget) break
    listed.push(skill)
    budget -= line
  }
  // Short descriptions are kept whole and the rest share what is left evenly.
  const allowance = new Map<SkillDescriptor, number>()
  const wanted = listed
    .map((skill) => ({ skill, text: catalogDescription(skill) }))
    .filter((entry): entry is { skill: SkillDescriptor; text: string } => entry.text !== undefined)
    .sort((left, right) => bytes(left.text) - bytes(right.text))
  wanted.forEach((entry, index) => {
    const share = Math.floor(budget / (wanted.length - index))
    const take = Math.min(bytes(entry.text) + 2, share)
    allowance.set(entry.skill, take - 2)
    budget -= take
  })
  const lines = listed.map((skill) => {
    const description = clip(catalogDescription(skill), allowance.get(skill) ?? 0)
    return description === undefined ? `- ${skill.id}` : `- ${skill.id}: ${description}`
  })
  const left = ordered.length - listed.length
  if (left > 0) lines.push(`- ${left} more ${left === 1 ? "skill is" : "skills are"} installed but not listed here.`)
  return [CATALOG_HEADER, ...lines].join("\n")
}

/** The description, else a name distinct from the id, else the body's first line: many plain Markdown skills have no frontmatter. */
function catalogDescription(skill: SkillDescriptor): string | undefined {
  const firstLine = (): string | undefined => skill.content.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line.length > 0)
  const text = (skill.description ?? (skill.name === skill.id ? firstLine() : skill.name) ?? "").replace(/\s+/g, " ").trim()
  return text.length === 0 ? undefined : text.slice(0, MAX_CATALOG_DESCRIPTION)
}

/** The text cut to at most `maxBytes` UTF-8 bytes, marked when cut, or undefined when too little would remain. */
function clip(text: string | undefined, maxBytes: number): string | undefined {
  if (text === undefined) return undefined
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  if (maxBytes < MIN_CATALOG_DESCRIPTION) return undefined
  let cut = ""
  let used = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8")
    if (used + size > maxBytes - 3) break
    cut += character
    used += size
  }
  return `${cut.trimEnd()}...`
}

function deriveId(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean)
  const file = parts.at(-1) ?? "skill"
  if (file.toLowerCase() === "skill.md" && parts.length > 1) return parts.at(-2) ?? "skill"
  return file.replace(/\.md$/i, "")
}

function isSkillManifest(path: string): boolean {
  return /(?:^|[\\/])SKILL\.md$/i.test(path)
}

/** A path relative to a skill's folder: no root, drive, backslash, empty, `.` or `..` part. */
function parseSkillFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
    throw new SkillRegistryError("SKILL_INVALID", "skill file path is invalid")
  if (value.split("/").some((part) => part.length === 0 || part === "." || part === ".."))
    throw new SkillRegistryError("SKILL_INVALID", "skill file path is invalid")
  return value
}

function isSkillFile(path: string): boolean {
  return /(?:^|\/)SKILL\.md$/i.test(path) || /\.skill\.md$/i.test(path) || /\.md$/i.test(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[a-z][a-z0-9._:-]{0,127}$/i.test(value)
}

function normalizeExcluded(ids: readonly string[] | undefined): readonly string[] {
  if (ids === undefined) return Object.freeze([])
  if (!Array.isArray(ids) || ids.length > MAX_EXCLUDED || ids.some((id) => !validId(id))) {
    throw new SkillRegistryError("SKILL_INVALID", "excluded skills are invalid")
  }
  return Object.freeze([...new Set(ids)])
}

function scopePriority(scope: SkillScope): number {
  return scope === "explicit" ? 300 : scope === "project" ? 200 : 100
}

function assertBound(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new SkillRegistryError("SKILL_INVALID", `${name} is invalid`)
}
