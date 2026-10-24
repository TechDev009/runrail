import { constants, type BigIntStats } from "node:fs"
import { access, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { readBoundedText } from "../runtime/bounded-read.ts"
import { GitError } from "./errors.ts"

/**
 * Settings that make git run a program. A repository's own config (`.git/config`, its includes,
 * a worktree's config) can be written by an agent or arrive with a downloaded folder, so for each
 * one it sets, Runrail's git calls take the person's own value instead, or a value that runs
 * nothing new. The person's global and system settings (Git LFS, credential helpers) still apply.
 */
const PROGRAM_KEYS = "^(filter\\..+\\.(clean|smudge|process|required)|diff\\..+\\.(textconv|command)|merge\\..+\\.driver|core\\.(sshcommand|askpass|gitproxy|alternaterefscommand)|credential(\\..+)?\\.helper|gpg(\\..+)?\\.program|gpg\\..+\\.defaultkeycommand|diff\\.external|remote\\..+\\.(uploadpack|receivepack))$"
const PROGRAM_KEY = new RegExp(PROGRAM_KEYS, "i")
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"])
const MAX_CONFIG_BYTES = 256 * 1024
const CONFIG_TIMEOUT_MS = 5_000
const CACHE_TTL_MS = 5_000
const CACHE_MAX_ENTRIES = 64
/** A file changed this recently could change again within one timestamp tick (a second on some file systems) unseen. */
const SETTLED_MS = 2_000
/** Any other GIT_* variable could point git at other files, so nothing is kept for it. */
const KNOWN_GIT_ENVIRONMENT: ReadonlySet<string> = new Set(["GIT_DIR", "GIT_INDEX_FILE", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"])
/** Entries whose appearance in a folder, or change, makes git take it (or a `.git` in it) as a repository. */
const REPOSITORY_MARKERS = [".git", "HEAD", "commondir", "objects", "refs"] as const
/** What git reads in a git folder to accept it and to read its config, the folder included. */
const GIT_DIR_ENTRIES = ["", "HEAD", "commondir", "config", "config.worktree", "objects", "refs"] as const

interface ConfigEntry {
  readonly scope: string
  readonly key: string
  readonly value: string
}

interface RepositoryLayout {
  readonly gitDir: string
  readonly commonDir: string
}

interface Fingerprint {
  readonly at: number
  readonly stamp: string
  readonly settled: boolean
}

type CacheEntry =
  | { readonly kind: "kept"; readonly at: number; readonly paths: readonly string[]; readonly stamp: string; readonly overrides: readonly string[] }
  | { readonly kind: "skip"; readonly until: number }

const cache = new Map<string, CacheEntry>()
const systemConfigPaths = new Map<string, Promise<string | undefined>>()

/**
 * `-c` arguments that replace every program a repository's own config names. An answer is reused
 * only while nothing git would read to give it has changed (see `readAndKeep`).
 */
export async function repositoryProgramOverrides(gitCommand: string, cwd: string, env: Record<string, string>): Promise<readonly string[]> {
  const key = cacheKey(gitCommand, cwd, env)
  const entry = key === undefined ? undefined : cache.get(key)
  if (key === undefined || (entry?.kind === "skip" && Date.now() < entry.until)) return overridesFor(await readProgramSettings(gitCommand, cwd, env))
  if (entry?.kind === "kept" && Date.now() - entry.at < CACHE_TTL_MS && (await fingerprint(entry.paths))?.stamp === entry.stamp) return entry.overrides
  cache.delete(key)
  return readAndKeep(key, gitCommand, cwd, env)
}

/**
 * Reads the overrides between two fingerprints of every file git reads for them (config files, and
 * the files that decide which repository the folder is in), and keeps them only when nothing
 * changed in between, the repository is still the same one, every file has settled, and its config
 * has no includes (their targets are not watched). Otherwise this folder is just read for a while.
 */
async function readAndKeep(key: string, gitCommand: string, cwd: string, env: Record<string, string>): Promise<readonly string[]> {
  const [layout, system] = await Promise.all([repositoryLayout(gitCommand, cwd, env), systemConfigPath(gitCommand, env)])
  const paths = layout === undefined || system === undefined ? undefined : watchedPaths(resolve(cwd), layout, system, env)
  const before = paths === undefined ? undefined : await fingerprint(paths)
  const unincluded = layout !== undefined && before?.settled === true && !(await mayInclude(layout))
  const overrides = overridesFor(await readProgramSettings(gitCommand, cwd, env))
  if (unincluded && paths !== undefined && before !== undefined) {
    const after = await fingerprint(paths)
    const again = await repositoryLayout(gitCommand, cwd, env)
    if (after?.stamp === before.stamp && again?.gitDir === layout.gitDir && again.commonDir === layout.commonDir) {
      remember(key, { kind: "kept", at: before.at, paths, stamp: before.stamp, overrides })
      return overrides
    }
  }
  remember(key, { kind: "skip", until: Date.now() + (before?.settled === false ? SETTLED_MS : CACHE_TTL_MS) })
  return overrides
}

function overridesFor(entries: readonly ConfigEntry[]): readonly string[] {
  const repositoryKeys = new Set(entries.filter((entry) => REPOSITORY_SCOPES.has(entry.scope)).map((entry) => entry.key))
  const overrides: string[] = []
  for (const key of repositoryKeys) {
    const own = entries.filter((entry) => entry.key === key && !REPOSITORY_SCOPES.has(entry.scope) && entry.scope !== "command").map((entry) => entry.value)
    if (/\.helper$/i.test(key)) {
      // An empty helper clears the list; the person's own helpers are then added back in order.
      overrides.push("-c", `${key}=`, ...own.flatMap((value) => ["-c", `${key}=${value}`]))
    } else {
      overrides.push("-c", `${key}=${own.at(-1) ?? neutralValue(key)}`)
    }
  }
  return Object.freeze(overrides)
}

function cacheKey(gitCommand: string, cwd: string, env: Record<string, string>): string | undefined {
  if (!isAbsolute(cwd)) return undefined
  const names = Object.keys(env).filter((name) => name !== "GIT_INDEX_FILE").sort()
  if (names.some((name) => name.startsWith("GIT_") && !KNOWN_GIT_ENVIRONMENT.has(name))) return undefined
  return JSON.stringify([gitCommand, cwd, names.map((name) => [name, env[name]])])
}

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key)
  const oldest = cache.keys().next()
  if (cache.size >= CACHE_MAX_ENTRIES && oldest.done !== true) cache.delete(oldest.value)
  cache.set(key, entry)
}

async function repositoryLayout(gitCommand: string, cwd: string, env: Record<string, string>): Promise<RepositoryLayout | undefined> {
  const result = await runText(gitCommand, cwd, env, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
  const lines = result.text.split("\n").filter((line) => line.length > 0)
  const [gitDir, commonDir] = lines
  if (result.exitCode !== 0 || lines.length !== 2 || gitDir === undefined || commonDir === undefined || !isAbsolute(gitDir) || !isAbsolute(commonDir)) return undefined
  return { gitDir, commonDir }
}

/** Where this git keeps its system config, fixed when it was built; undefined for a git too old to say. */
function systemConfigPath(gitCommand: string, env: Record<string, string>): Promise<string | undefined> {
  const key = JSON.stringify([gitCommand, env.PATH])
  let path = systemConfigPaths.get(key)
  if (path === undefined) {
    if (systemConfigPaths.size >= 16) systemConfigPaths.clear()
    path = runText(gitCommand, "/", env, ["var", "GIT_CONFIG_SYSTEM"]).then(
      (result) => (result.exitCode === 0 && isAbsolute(result.text.trim()) ? result.text.trim() : undefined),
      () => undefined,
    )
    systemConfigPaths.set(key, path)
  }
  return path
}

/** The person's config, and from `cwd` up every folder and its repository markers, and the repository's git folders. */
function watchedPaths(cwd: string, layout: RepositoryLayout, system: string, env: Record<string, string>): readonly string[] {
  const paths = new Set<string>([system])
  // GIT_DIR may name a `gitdir:` file rather than the folder it points to.
  if (env.GIT_DIR !== undefined) paths.add(resolve(cwd, env.GIT_DIR))
  if (env.HOME !== undefined) paths.add(join(env.HOME, ".gitconfig")).add(join(env.XDG_CONFIG_HOME ?? join(env.HOME, ".config"), "git", "config"))
  for (let folder = cwd; ; folder = dirname(folder)) {
    paths.add(folder)
    for (const name of REPOSITORY_MARKERS) paths.add(join(folder, name))
    if (dirname(folder) === folder) break
  }
  for (const dir of [layout.gitDir, layout.commonDir]) for (const name of GIT_DIR_ENTRIES) paths.add(join(dir, name))
  return Object.freeze([...paths])
}

/**
 * A file by identity, owner, size and times; a folder by identity, owner, mode, and whether it can
 * be entered (all git checks of one, ACLs included), since its times move with every file in it.
 */
async function fingerprint(paths: readonly string[]): Promise<Fingerprint | undefined> {
  const at = Date.now()
  const settledBefore = BigInt(at - SETTLED_MS)
  let settled = true
  const look = async (path: string): Promise<string | undefined> => {
    let info: BigIntStats
    try {
      info = await stat(path, { bigint: true })
    } catch (error) {
      return isMissing(error) ? "-" : undefined
    }
    if (info.isDirectory()) {
      const open = await access(path, constants.R_OK | constants.X_OK).then(() => "open", () => "shut")
      return `d${info.dev}:${info.ino}:${info.mode}:${info.uid}:${open}`
    }
    if (info.ctimeMs >= settledBefore || info.mtimeMs >= settledBefore) settled = false
    return `f${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  }
  const parts = await Promise.all(paths.map(look))
  if (parts.some((part) => part === undefined)) return undefined
  return { at, stamp: parts.join("\n"), settled }
}

/** Whether the repository's own config may include another file; one that cannot be read may. */
async function mayInclude(layout: RepositoryLayout): Promise<boolean> {
  for (const path of new Set([join(layout.commonDir, "config"), join(layout.commonDir, "config.worktree"), join(layout.gitDir, "config.worktree")])) {
    let text: string
    try {
      text = await readBoundedText(path, MAX_CONFIG_BYTES)
    } catch (error) {
      if (isMissing(error)) continue
      return true
    }
    if (/include/i.test(text)) return true
  }
  return false
}

function isMissing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

function neutralValue(key: string): string {
  const name = key.toLowerCase()
  if (/^filter\..+\.required$/.test(name) || /^merge\..+\.driver$/.test(name)) return "false"
  if (name === "core.sshcommand") return "ssh"
  // Any value, even an empty one, is run through the shell; `true` lists no alternate refs.
  if (name === "core.alternaterefscommand") return "true"
  if (name === "gpg.ssh.program") return "ssh-keygen"
  if (name === "gpg.x509.program") return "gpgsm"
  if (/^gpg\.(openpgp\.)?program$/.test(name)) return "gpg"
  if (name.endsWith(".uploadpack")) return "git-upload-pack"
  if (name.endsWith(".receivepack")) return "git-receive-pack"
  return ""
}

async function readProgramSettings(gitCommand: string, cwd: string, env: Record<string, string>): Promise<readonly ConfigEntry[]> {
  const scoped = await runText(gitCommand, cwd, env, ["config", "--show-scope", "--includes", "--null", "--get-regexp", PROGRAM_KEYS])
  if (scoped.exitCode === 0) return parseScoped(scoped.text)
  if (scoped.exitCode === 1) return []
  // Git older than 2.26 has no --show-scope: only the repository's own file is read, and every
  // program it names is replaced with a value that runs nothing new.
  if (scoped.exitCode === 129) {
    const local = await runText(gitCommand, cwd, env, ["config", "--local", "--includes", "--null", "--get-regexp", PROGRAM_KEYS])
    if (local.exitCode === 0) return parseUnscoped(local.text)
    if (local.exitCode === 1 || local.exitCode === 128) return []
  }
  throw new GitError("GIT_FAILED", "the repository's git configuration could not be read")
}

async function runText(gitCommand: string, cwd: string, env: Record<string, string>, args: readonly string[]): Promise<{ readonly exitCode: number; readonly text: string }> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    child = Bun.spawn([gitCommand, "--no-pager", "-c", "core.fsmonitor=false", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  } catch {
    throw new GitError("GIT_UNAVAILABLE", "git is not available")
  }
  const timer = setTimeout(() => child.kill(), CONFIG_TIMEOUT_MS)
  try {
    const [text, exitCode] = await Promise.all([boundedText(child), child.exited])
    return { exitCode, text }
  } finally {
    clearTimeout(timer)
  }
}

async function boundedText(child: Bun.Subprocess<"ignore", "pipe", "ignore">): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of child.stdout) {
    total += chunk.byteLength
    if (total > MAX_CONFIG_BYTES) {
      child.kill()
      throw new GitError("GIT_LIMIT", "the repository's git configuration is too large")
    }
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function parseScoped(text: string): readonly ConfigEntry[] {
  const fields = text.split("\0")
  const entries: ConfigEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const entry = keyValue(fields[index + 1] ?? "")
    if (entry !== undefined) entries.push({ scope: fields[index] ?? "", ...entry })
  }
  return entries
}

function parseUnscoped(text: string): readonly ConfigEntry[] {
  return text.split("\0").flatMap((field) => {
    const entry = keyValue(field)
    return entry === undefined ? [] : [{ scope: "local", ...entry }]
  })
}

function keyValue(field: string): { readonly key: string; readonly value: string } | undefined {
  const newline = field.indexOf("\n")
  const key = newline < 0 ? field : field.slice(0, newline)
  if (!PROGRAM_KEY.test(key)) return undefined
  return { key, value: newline < 0 ? "" : field.slice(newline + 1) }
}
