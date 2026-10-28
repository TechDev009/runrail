import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { wildcardMatch } from "./wildcard.ts"

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const MAX_VISITED_ENTRIES = 50_000
/** Files a search looks in; a bigger tree is reported as partial rather than read as empty. */
const MAX_SEARCH_FILES = 8_192
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 64 * 1024

export interface WorkspaceEntry {
  readonly path: string
  readonly type: "file" | "directory"
  readonly bytes?: number
}

export interface WorkspaceSearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

/** Filled by a listing or search that had to stop early, so the caller can say the answer is partial. */
export interface WorkspaceReport {
  /** The walk stopped at its entry or visit limit before it had looked everywhere. */
  truncated: boolean
  /** Files a search could not read or that were over its size limit. */
  skipped: number
}

export interface WorkspacePolicy {
  readonly root: string
  /**
   * Related folders the person added to the project, real paths. A path inside
   * one is reached by its absolute path; relative paths stay in `root`.
   */
  readonly folders: readonly string[]
  resolveExisting(path: string): Promise<string>
  resolveForWrite(path: string): Promise<string>
  read(path: string, maxBytes?: number): Promise<string>
  write(path: string, content: string, maxBytes?: number): Promise<{ readonly path: string; readonly bytes: number }>
  list(path?: string, maxDepth?: number, maxEntries?: number, report?: WorkspaceReport): Promise<readonly WorkspaceEntry[]>
  find(path: string | undefined, pattern: string, maxDepth?: number, maxEntries?: number, report?: WorkspaceReport): Promise<readonly WorkspaceEntry[]>
  search(
    path: string | undefined,
    query: string,
    maxResults?: number,
    maxFileBytes?: number,
    report?: WorkspaceReport,
  ): Promise<readonly WorkspaceSearchMatch[]>
}

export const MAX_WORKSPACE_FOLDERS = 8

type RootPolicy = Omit<WorkspacePolicy, "folders">

export async function createWorkspacePolicy(rootInput: string, foldersInput: readonly string[] = []): Promise<WorkspacePolicy> {
  if (rootInput.length === 0) throw new TypeError("workspace root is required")
  const root = await realpath(resolve(rootInput))
  const primary = rootPolicy(root)
  const folders = await relatedFolders(root, foldersInput)
  if (folders.length === 0) return Object.freeze({ ...primary, folders: Object.freeze([]) })
  const others = folders.map(rootPolicy)
  const owner = (input: unknown): RootPolicy | undefined => (typeof input === "string" && isAbsolute(input) && !input.includes("\0") ? others.find((other) => !escapes(other.root, resolve(input))) : undefined)
  // What a related folder answers is named by absolute path, so it is never read as a path in `root`.
  const absolute = <T extends { readonly path: string }>(from: RootPolicy, entries: readonly T[]): readonly T[] => Object.freeze(entries.map((entry) => ({ ...entry, path: join(from.root, entry.path) })))
  const policy: WorkspacePolicy = {
    root,
    folders,
    resolveExisting: (input) => (owner(input) ?? primary).resolveExisting(input),
    resolveForWrite: (input) => (owner(input) ?? primary).resolveForWrite(input),
    read: (input, maxBytes) => (owner(input) ?? primary).read(input, maxBytes),
    async write(input, content, maxBytes) {
      const from = owner(input)
      if (from === undefined) return primary.write(input, content, maxBytes)
      const written = await from.write(input, content, maxBytes)
      return { path: join(from.root, written.path), bytes: written.bytes }
    },
    async list(input = "", maxDepth, maxEntries, report) {
      const from = owner(input)
      return from === undefined ? primary.list(input, maxDepth, maxEntries, report) : absolute(from, await from.list(input, maxDepth, maxEntries, report))
    },
    async find(input = "", pattern, maxDepth, maxEntries, report) {
      const from = owner(input)
      return from === undefined ? primary.find(input, pattern, maxDepth, maxEntries, report) : absolute(from, await from.find(input, pattern, maxDepth, maxEntries, report))
    },
    async search(input = "", query, maxResults, maxFileBytes, report) {
      const from = owner(input)
      return from === undefined ? primary.search(input, query, maxResults, maxFileBytes, report) : absolute(from, await from.search(input, query, maxResults, maxFileBytes, report))
    },
  }
  return Object.freeze(policy)
}

/** Real, existing directories, none inside another or the root, so every path has one owner. */
async function relatedFolders(root: string, inputs: readonly string[]): Promise<readonly string[]> {
  if (!Array.isArray(inputs) || inputs.length > MAX_WORKSPACE_FOLDERS) throw new TypeError("workspace folders are invalid")
  const folders: string[] = []
  for (const input of inputs) {
    if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0") || input.length > 4_096) throw new TypeError("workspace folder is invalid")
    const folder = await realpath(input)
    if (!(await lstat(folder)).isDirectory()) throw new TypeError("workspace folder is not a directory")
    if ([root, ...folders].some((other) => !escapes(other, folder) || !escapes(folder, other))) throw new TypeError("workspace folders overlap")
    folders.push(folder)
  }
  return Object.freeze(folders)
}

function escapes(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function rootPolicy(root: string): RootPolicy {
  const policy: RootPolicy = {
    root,
    async resolveExisting(input) {
      const candidate = resolveInside(root, input)
      // By name first, as writes do, so `.GIT/config` is refused on a case-sensitive disk too.
      assertSafeFile(root, candidate)
      const entry = await lstat(candidate)
      if (entry.isSymbolicLink()) throw new Error("workspace path escapes authorized root through an unauthorized symlink")
      const actual = await realpath(candidate)
      assertInside(root, actual)
      assertSafeFile(root, actual)
      return actual
    },
    async resolveForWrite(input) {
      const candidate = resolveInside(root, input)
      assertNotControlPath(root, candidate)
      assertSafeFile(root, candidate)
      let parentCandidate = dirname(candidate)
      for (;;) {
        try {
          const parent = await realpath(parentCandidate)
          assertInside(root, parent)
          assertNotControlPath(root, join(parent, relative(parentCandidate, candidate)))
          try {
            const entry = await lstat(candidate)
            if (entry.isSymbolicLink()) throw new Error("workspace path escapes authorized root through an unauthorized symlink")
            const actual = await realpath(candidate)
            assertInside(root, actual)
            assertSafeFile(root, actual)
          } catch (error) {
            if (!isNotFound(error)) throw error
          }
          return join(parent, relative(parentCandidate, candidate))
        } catch (error) {
          if (!isNotFound(error) || parentCandidate === root) throw error
          parentCandidate = dirname(parentCandidate)
        }
      }
    },
    async read(input, maxBytes = DEFAULT_MAX_FILE_BYTES) {
      const path = await policy.resolveExisting(input)
      // Opened without following a link and checked on the open file, so a swap after the checks above reads nothing out of the workspace.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const entry = await handle.stat()
        if (!entry.isFile()) throw new TypeError("workspace path is not a regular file")
        if (entry.size > maxBytes) throw new RangeError("workspace read exceeds byte limit")
        return (await handle.readFile()).toString("utf8")
      } finally {
        await handle.close()
      }
    },
    async write(input, content, maxBytes = DEFAULT_MAX_FILE_BYTES) {
      const bytes = Buffer.byteLength(content, "utf8")
      if (bytes > maxBytes) throw new RangeError("workspace write exceeds byte limit")
      const path = await policy.resolveForWrite(input)
      await mkdir(dirname(path), { recursive: true })
      const parent = await realpath(dirname(path))
      assertInside(root, parent)
      const finalPath = join(parent, basename(path))
      try {
        const entry = await lstat(finalPath)
        if (entry.isSymbolicLink()) throw new Error("workspace path escapes authorized root through an unauthorized symlink")
        if (!entry.isFile()) throw new TypeError("workspace path is not a regular file")
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      // Opened without following a link and without truncating, checked on the open file, then truncated:
      // a link swapped in after the checks above is refused, and a device or pipe is never emptied.
      const handle = await open(finalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666)
      try {
        if (!(await handle.stat()).isFile()) throw new TypeError("workspace path is not a regular file")
        await handle.truncate(0)
        await handle.writeFile(content, "utf8")
      } finally {
        await handle.close()
      }
      return { path: relative(root, finalPath), bytes }
    },
    async list(input = "", maxDepth = 1, maxEntries = 256, report) {
      return walk(input, (path) => path.length > 0, maxDepth, maxEntries, undefined, report)
    },
    async find(input = "", pattern, maxDepth = 16, maxEntries = 256, report) {
      const matcher = globMatcher(pattern)
      const named = pattern.toLowerCase()
      // A pattern that names a generated folder (`node_modules/**/package.json`) is looked for there.
      return walk(input, matcher, maxDepth, maxEntries, (name) => !GENERATED_FOLDERS.has(name.toLowerCase()) || named.includes(name.toLowerCase()), report)
    },
    async search(input = "", query, maxResults = 128, maxFileBytes = DEFAULT_MAX_FILE_BYTES, report) {
      if (typeof query !== "string" || query.length === 0 || query.length > 512)
        throw new TypeError("workspace search query is invalid")
      assertPositiveBound(maxResults, 1, 512, "maxResults")
      assertPositiveBound(maxFileBytes, 1, DEFAULT_MAX_FILE_BYTES, "maxFileBytes")
      const entries = await walk(input, (path, type) => type === "file", 16, MAX_SEARCH_FILES, (name) => !GENERATED_FOLDERS.has(name.toLowerCase()), report)
      const matches: WorkspaceSearchMatch[] = []
      for (const entry of entries) {
        if (entry.type !== "file") continue
        if ((entry.bytes ?? 0) > maxFileBytes) {
          if (report !== undefined) report.skipped += 1
          continue
        }
        let content: string
        try {
          content = await policy.read(entry.path, maxFileBytes)
        } catch {
          if (report !== undefined) report.skipped += 1
          continue
        }
        if (content.includes("\0")) continue
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] as string
          if (!line.includes(query)) continue
          matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 1_024) })
          if (matches.length >= maxResults) {
            if (report !== undefined) report.truncated = true
            return Object.freeze(matches)
          }
        }
      }
      return Object.freeze(matches)
    },
  }
  return Object.freeze(policy)

  /**
   * Breadth first, so one large folder early in name order cannot spend the budget before the
   * project's own files are reached. `descend` is not asked below a start inside a generated
   * folder: the caller asked to look there.
   */
  async function walk(
    input: string,
    include: (path: string, type: WorkspaceEntry["type"]) => boolean,
    maxDepth: number,
    maxEntries: number,
    descend: (name: string) => boolean = () => true,
    report?: WorkspaceReport,
  ): Promise<readonly WorkspaceEntry[]> {
    assertPositiveBound(maxDepth, 0, 32, "maxDepth")
    assertPositiveBound(maxEntries, 1, MAX_SEARCH_FILES, "maxEntries")
    const start = input.length === 0 ? root : await policy.resolveExisting(input)
    const startStat = await lstat(start)
    if (startStat.isSymbolicLink()) throw new Error("workspace path escapes authorized root through an unauthorized symlink")
    if (!startStat.isDirectory()) throw new TypeError("workspace path is not a directory")
    const insideGenerated = relative(root, start).split(sep).some((segment) => GENERATED_FOLDERS.has(segment.toLowerCase()))
    const result: WorkspaceEntry[] = []
    // Results bound what is returned; this bounds what is looked at, so a pattern that matches
    // nothing cannot walk a whole huge tree.
    let visited = 0
    let level = [start]
    for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
      const next: string[] = []
      for (const directory of level) {
        const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )
        for (const child of children) {
          if (result.length >= maxEntries || visited >= MAX_VISITED_ENTRIES) {
            if (report !== undefined) report.truncated = true
            return Object.freeze(result)
          }
          visited += 1
          if (child.isSymbolicLink()) continue
          const absolute = join(directory, child.name)
          const relativePath = relative(root, absolute)
          try {
            assertInside(root, absolute)
            assertSafeFile(root, absolute)
          } catch {
            continue
          }
          if (child.isDirectory()) {
            if (include(relativePath, "directory")) result.push({ path: relativePath, type: "directory" })
            if (depth < maxDepth && (insideGenerated || descend(child.name))) next.push(absolute)
            continue
          }
          if (!child.isFile() || !include(relativePath, "file")) continue
          result.push({ path: relativePath, type: "file", bytes: (await lstat(absolute)).size })
        }
      }
      level = next
    }
    return Object.freeze(result)
  }
}

export function filteredEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  // USER and LOGNAME name the account, not a secret; Claude Code's macOS Keychain lookup fails without them.
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "CI"])
  const result: Record<string, string> = {}
  for (const name of allowed) {
    const value = overrides[name] ?? process.env[name]
    if (value !== undefined) result[name] = name === "PATH" ? absolutePathEntries(value) : value
  }
  return result
}

/** A relative or empty PATH entry is the current folder, where a repository's own files could stand in for system programs. */
function absolutePathEntries(value: string): string {
  return value.split(delimiter).filter((entry) => isAbsolute(entry)).join(delimiter)
}

function resolveInside(root: string, input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0"))
    throw new TypeError("workspace path is invalid")
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input)
  assertInside(root, candidate)
  return candidate
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("workspace path escapes the authorized root")
}

/** Credential-bearing file names that workspace and git tools never read or diff. */
const SENSITIVE_NAMES: readonly string[] = [".env", ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".pgpass", ".htpasswd", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json", ".dockercfg"]
const SENSITIVE_NAME_PREFIXES: readonly string[] = [".env."]
const SENSITIVE_EXTENSIONS: readonly string[] = ["pem", "key", "p12", "pfx", "keystore", "jks"]
/** Folders whose files are all credentials, such as `~/.aws` copied into a project. */
const SENSITIVE_FOLDERS: readonly string[] = [".aws", ".ssh", ".gnupg", ".docker", ".kube", ".azure", ".config/gcloud"]
const SENSITIVE_NAME_SET: ReadonlySet<string> = new Set(SENSITIVE_NAMES)
const SENSITIVE_FOLDER_SET: ReadonlySet<string> = new Set(SENSITIVE_FOLDERS)
/** `.env.example` and its kin hold placeholders and are meant to be read and edited. */
const ENV_TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/
const SENSITIVE_EXTENSION = new RegExp(`\\.(${SENSITIVE_EXTENSIONS.join("|")})$`)

export function isSensitiveWorkspacePath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  const name = (segments.at(-1) ?? "").toLowerCase()
  if (SENSITIVE_NAME_SET.has(name) || (SENSITIVE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)) && !ENV_TEMPLATE_SUFFIX.test(name)) || SENSITIVE_EXTENSION.test(name)) return true
  const folders = segments.slice(0, -1).map((segment) => segment.toLowerCase())
  return folders.some((segment, index) => SENSITIVE_FOLDER_SET.has(segment) || SENSITIVE_FOLDER_SET.has(`${segment}/${folders[index + 1] ?? ""}`))
}

/** The files `isSensitiveWorkspacePath` names, as gitignore patterns matching in any case as it does. */
export const SENSITIVE_IGNORE_PATTERNS: readonly string[] = Object.freeze([
  ...SENSITIVE_NAMES.map(anyCase),
  ...SENSITIVE_NAME_PREFIXES.map((prefix) => `${anyCase(prefix)}*`),
  ...SENSITIVE_EXTENSIONS.map((extension) => `*.${anyCase(extension)}`),
  ...SENSITIVE_FOLDERS.map((folder) => `**/${anyCase(folder)}/`),
])

function anyCase(text: string): string {
  return text.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)
}

/** Version control data, which its own commands read; it can hold credentials (remote URLs with tokens). */
const VCS_FOLDERS: ReadonlySet<string> = new Set([".git", ".hg", ".svn"])
/**
 * Folders a project regenerates. Find and search do not go into them unless the walk starts inside
 * one, so the project's own files are reached within the walk budget.
 */
const GENERATED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__", ".venv", "venv", ".next"])

/**
 * Git's own files, the project's `.runrail` folder, and the Nifra extensions the engine imports
 * decide what runs later (hooks, filters, plugins, setups, extension code), so an agent's file
 * tools never write them; the person edits them.
 */
function assertNotControlPath(root: string, path: string): void {
  const segments = relative(root, path).split(/[\\/]/).map((segment) => segment.toLowerCase())
  if (segments.includes(".git") || segments[0] === ".runrail")
    throw new Error("workspace path is git's or Runrail's own configuration, which workspace tools never write")
  if (segments[0] === ".nifra" && segments[1] === "extensions")
    throw new Error("workspace path is a Nifra extension, which the engine imports and runs; workspace tools never write it")
  if (isToolConfigPath(segments))
    throw new Error("workspace path is a coding tool's or hook runner's configuration, which can run commands later; workspace tools never write it")
}

/** Files other coding tools and git hook runners read and execute from, which a repo's own commands then run. */
export function isToolConfigPath(segments: readonly string[]): boolean {
  const [first = "", second = ""] = segments
  if (segments.length === 1 && (first === ".mcp.json" || first === ".opencode.json")) return true
  if (first === ".husky" || first === ".githooks" || first === ".codex") return true
  if (first === ".claude") return second === "hooks" || second.startsWith("settings")
  if (first === ".vscode") return second === "tasks.json"
  return false
}

function assertSafeFile(root: string, path: string): void {
  // Judged below the root, so a project that lives under `~/.config/gcloud` or `.ssh` is not itself off limits.
  if (isSensitiveWorkspacePath(relative(root, path)))
    throw new Error("sensitive credential file is excluded from workspace tools")
  if (relative(root, path).split(/[\\/]/).some((segment) => VCS_FOLDERS.has(segment.toLowerCase())))
    throw new Error("version control data (.git, .hg, .svn) is excluded from workspace tools; use git commands such as git status, git log, or git show instead")
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function assertPositiveBound(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max}`)
}

function globMatcher(pattern: string): (path: string) => boolean {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 256)
    throw new TypeError("workspace find pattern is invalid")
  return (path) => wildcardMatch(pattern, path)
}
