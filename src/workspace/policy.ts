import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { wildcardMatch } from "./wildcard.ts"

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const MAX_VISITED_ENTRIES = 50_000
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
  list(path?: string, maxDepth?: number, maxEntries?: number): Promise<readonly WorkspaceEntry[]>
  find(path: string | undefined, pattern: string, maxDepth?: number, maxEntries?: number): Promise<readonly WorkspaceEntry[]>
  search(
    path: string | undefined,
    query: string,
    maxResults?: number,
    maxFileBytes?: number,
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
    async list(input = "", maxDepth, maxEntries) {
      const from = owner(input)
      return from === undefined ? primary.list(input, maxDepth, maxEntries) : absolute(from, await from.list(input, maxDepth, maxEntries))
    },
    async find(input = "", pattern, maxDepth, maxEntries) {
      const from = owner(input)
      return from === undefined ? primary.find(input, pattern, maxDepth, maxEntries) : absolute(from, await from.find(input, pattern, maxDepth, maxEntries))
    },
    async search(input = "", query, maxResults, maxFileBytes) {
      const from = owner(input)
      return from === undefined ? primary.search(input, query, maxResults, maxFileBytes) : absolute(from, await from.search(input, query, maxResults, maxFileBytes))
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
      const entry = await lstat(candidate)
      if (entry.isSymbolicLink()) throw new Error("workspace path escapes authorized root through an unauthorized symlink")
      const actual = await realpath(candidate)
      assertInside(root, actual)
      assertSafeFile(actual)
      return actual
    },
    async resolveForWrite(input) {
      const candidate = resolveInside(root, input)
      assertSafeFile(candidate)
      assertNotControlPath(root, candidate)
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
            assertSafeFile(actual)
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
      const entry = await lstat(path)
      if (!entry.isFile()) throw new TypeError("workspace path is not a regular file")
      const size = entry.size
      if (size > maxBytes) throw new RangeError("workspace read exceeds byte limit")
      const data = await readFile(path)
      return data.toString("utf8")
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
      await writeFile(finalPath, content, { encoding: "utf8", flag: "w" })
      return { path: relative(root, finalPath), bytes }
    },
    async list(input = "", maxDepth = 1, maxEntries = 256) {
      return walk(input, (path) => path.length > 0, maxDepth, maxEntries)
    },
    async find(input = "", pattern, maxDepth = 16, maxEntries = 256) {
      const matcher = globMatcher(pattern)
      return walk(input, matcher, maxDepth, maxEntries)
    },
    async search(input = "", query, maxResults = 128, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
      if (typeof query !== "string" || query.length === 0 || query.length > 512)
        throw new TypeError("workspace search query is invalid")
      assertPositiveBound(maxResults, 1, 512, "maxResults")
      assertPositiveBound(maxFileBytes, 1, DEFAULT_MAX_FILE_BYTES, "maxFileBytes")
      const entries = await walk(input, (path, type) => type === "file", 16, 2048)
      const matches: WorkspaceSearchMatch[] = []
      for (const entry of entries) {
        if (entry.type !== "file") continue
        if ((entry.bytes ?? 0) > maxFileBytes) continue
        let content: string
        try {
          content = await policy.read(entry.path, maxFileBytes)
        } catch {
          continue
        }
        if (content.includes("\0")) continue
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] as string
          if (!line.includes(query)) continue
          matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 1_024) })
          if (matches.length >= maxResults) return Object.freeze(matches)
        }
      }
      return Object.freeze(matches)
    },
  }
  return Object.freeze(policy)

  async function walk(
    input: string,
    include: (path: string, type: WorkspaceEntry["type"]) => boolean,
    maxDepth: number,
    maxEntries: number,
  ): Promise<readonly WorkspaceEntry[]> {
    assertPositiveBound(maxDepth, 0, 32, "maxDepth")
    assertPositiveBound(maxEntries, 1, 2_048, "maxEntries")
    const start = input.length === 0 ? root : await policy.resolveExisting(input)
    const startStat = await lstat(start)
    if (startStat.isSymbolicLink()) throw new Error("workspace path escapes authorized root through an unauthorized symlink")
    if (!startStat.isDirectory()) throw new TypeError("workspace path is not a directory")
    const result: WorkspaceEntry[] = []
    // Results bound what is returned; this bounds what is looked at, so a pattern that matches
    // nothing cannot walk a whole huge tree.
    let visited = 0
    const visit = async (directory: string, depth: number): Promise<void> => {
      const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )
      for (const child of children) {
        if (result.length >= maxEntries || visited >= MAX_VISITED_ENTRIES) return
        visited += 1
        if (child.isSymbolicLink()) continue
        const absolute = join(directory, child.name)
        const relativePath = relative(root, absolute)
        try {
          assertInside(root, absolute)
          assertSafeFile(absolute)
        } catch {
          continue
        }
        if (child.isDirectory()) {
          if (include(relativePath, "directory")) result.push({ path: relativePath, type: "directory" })
          if (depth < maxDepth) await visit(absolute, depth + 1)
          continue
        }
        if (!child.isFile() || !include(relativePath, "file")) continue
        result.push({ path: relativePath, type: "file", bytes: (await lstat(absolute)).size })
      }
    }
    await visit(start, 0)
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
    if (value !== undefined) result[name] = value
  }
  return result
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

/** True for credential-bearing file names that workspace and git tools never read or diff. */
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([".env", ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".pgpass", ".htpasswd", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json", ".dockercfg"])
/** Folders whose files are all credentials, such as `~/.aws` copied into a project. */
const SENSITIVE_FOLDERS: ReadonlySet<string> = new Set([".aws", ".ssh", ".gnupg", ".docker", ".kube", ".azure", ".config/gcloud"])

export function isSensitiveWorkspacePath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0)
  const name = (segments.at(-1) ?? "").toLowerCase()
  if (SENSITIVE_NAMES.has(name) || name.startsWith(".env.") || /\.(pem|key|p12|pfx|keystore|jks)$/.test(name)) return true
  const folders = segments.slice(0, -1).map((segment) => segment.toLowerCase())
  return folders.some((segment, index) => SENSITIVE_FOLDERS.has(segment) || SENSITIVE_FOLDERS.has(`${segment}/${folders[index + 1] ?? ""}`))
}

/**
 * Git's own files and the project's `.runrail` folder decide what runs later (hooks, filters,
 * plugins, setups), so an agent's file tools never write them; the person edits them.
 */
function assertNotControlPath(root: string, path: string): void {
  const segments = relative(root, path).split(/[\\/]/).map((segment) => segment.toLowerCase())
  if (segments.includes(".git") || segments[0] === ".runrail")
    throw new Error("workspace path is git's or Runrail's own configuration, which workspace tools never write")
}

function assertSafeFile(path: string): void {
  if (isSensitiveWorkspacePath(path))
    throw new Error("sensitive credential file is excluded from workspace tools")
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
