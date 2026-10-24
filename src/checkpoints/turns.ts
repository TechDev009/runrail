import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { GitError } from "../git/errors.ts"
import { RUNRAIL_RUNTIME_DIRS, isRunrailRuntimePath, parseGitPath, stripPrefix } from "../git/paths.ts"
import { runGit, type GitRunOptions, type GitRunResult } from "../git/run.ts"
import { outsideWorkTree, probeGitRepository, type GitRepository } from "../git/status.ts"
import { SENSITIVE_IGNORE_PATTERNS } from "../workspace/policy.ts"

/**
 * The work tree before each turn, so a rewind can put files back. Every
 * snapshot goes into a shadow repository in the session's own folder whose work tree is the
 * workspace, so nothing is written into the person's folder or their repository, and the snapshots
 * go when the thread's folder does. Untracked files are included; ignored files, Runrail's runtime
 * folders and likely secrets are left out. Changes made by commands are caught as well as the
 * agent's edits.
 *
 * In a git repository the shadow borrows the repository's objects (alternates), its excludes, and,
 * once, its index: the copied index keeps git's stat cache, so only changed files are hashed. After
 * that the shadow's index is its own and is written in place each turn.
 */

export const MAX_CHECKPOINTS = 50
export const MAX_CHECKPOINT_PATHS = 5_000
export const MAX_CHECKPOINT_UNTRACKED_BYTES = 200 * 1024 * 1024
const SNAPSHOT_TIMEOUT_MS = 60_000
/** A folder with no git has no stat cache to start from: a walk that takes this long is a folder too large to keep. */
const FIRST_STATUS_TIMEOUT_MS = 15_000
const LIST_FILE = "checkpoints.json"
const SHADOW_DIR = "shadow.git"
const OBJECT_ID = /^[0-9a-f]{40,64}$/
/**
 * Left out of every snapshot as an exclude file would leave them out: folders a project regenerates,
 * and every file the workspace tools treat as a credential, which should not be copied into the
 * session's folder. Key backups (`id_rsa.old`) are left out too.
 */
const SHADOW_EXCLUDES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".DS_Store",
  ...RUNRAIL_RUNTIME_DIRS.map((dir) => `/${dir}/`),
  ...SENSITIVE_IGNORE_PATTERNS,
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
]

export type CheckpointSkip = "too-large" | "failed"

export interface VendorMark {
  readonly session: string
  readonly at: string
}

const VENDOR_MARK_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function isVendorMark(value: unknown): value is VendorMark {
  if (typeof value !== "object" || value === null) return false
  const { session, at } = value as Record<string, unknown>
  return typeof session === "string" && VENDOR_MARK_PART.test(session) && typeof at === "string" && VENDOR_MARK_PART.test(at)
}

export interface TurnCheckpoint {
  readonly n: number
  readonly at: number
  /** The transcript seq of the turn's user message when it was recorded. */
  readonly userSeq?: number
  /** That message's transcript record id: a rewind drops it and everything after, and ids survive a compaction. */
  readonly userId?: string
  readonly turnId?: string
  /**
   * Where the coding tool's own conversation stood once this turn ended: its
   * conversation id and a mark only that tool reads (Claude Code's last message, Codex's turn).
   */
  readonly vendor?: VendorMark
  /** The work tree before the turn; absent when the snapshot was skipped. */
  readonly tree?: string
  readonly skipped?: CheckpointSkip
}

/**
 * Which turn a caller means. A coding tool numbers its turns per process (`turn-1` again after a
 * restart), so a turn id names only a turn taken since this list was opened; a message's record id
 * names any.
 */
export type CheckpointTarget = { readonly turnId: string } | { readonly userId: string }

export interface CheckpointChange {
  /** Workspace-relative. */
  readonly path: string
  /** What happened to it since the checkpoint: putting it back undoes this. */
  readonly change: "modified" | "added" | "deleted"
}

export interface CheckpointRestore {
  readonly restored: readonly string[]
  readonly failed: readonly { readonly path: string; readonly reason: string }[]
}

type Runner = (options: GitRunOptions) => Promise<GitRunResult>

/** The shadow repository: its git folder, and the work tree and workspace prefix it snapshots. */
interface Shadow {
  readonly gitDir: string
  readonly toplevel: string
  readonly prefix: string
  /** The folder is a git repository of its own, so its stat cache was borrowed. */
  readonly borrowed: boolean
}

export interface TurnCheckpointsOptions {
  /** The workspace root the session runs in. */
  readonly root: string
  /** The session's own folder; the list and the shadow repository are kept here. */
  readonly dir: string
  readonly run?: Runner
  readonly clock?: () => number
  readonly limits?: { readonly maxPaths?: number; readonly maxUntrackedBytes?: number; readonly maxCheckpoints?: number }
}

export class TurnCheckpoints {
  readonly #root: string
  readonly #dir: string
  readonly #run: Runner
  readonly #clock: () => number
  readonly #maxPaths: number
  readonly #maxUntrackedBytes: number
  readonly #maxCheckpoints: number
  #list: TurnCheckpoint[] | undefined
  /** The checkpoints this instance took, the only ones a turn id can name. */
  readonly #mine = new Set<number>()
  #shadow: Shadow | undefined
  #tooLarge = false
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: TurnCheckpointsOptions) {
    this.#root = options.root
    this.#dir = options.dir
    this.#run = options.run ?? runGit
    this.#clock = options.clock ?? Date.now
    this.#maxPaths = options.limits?.maxPaths ?? MAX_CHECKPOINT_PATHS
    this.#maxUntrackedBytes = options.limits?.maxUntrackedBytes ?? MAX_CHECKPOINT_UNTRACKED_BYTES
    this.#maxCheckpoints = options.limits?.maxCheckpoints ?? MAX_CHECKPOINTS
  }

  /** Snapshots the work tree now, as the next checkpoint; a folder that cannot be snapshotted records why. */
  capture(): Promise<TurnCheckpoint> {
    return this.#serial(async () => {
      const list = await this.#load()
      const n = (list.at(-1)?.n ?? 0) + 1
      const snapshot = await this.#snapshot(n).catch((): { readonly skipped: CheckpointSkip } => ({ skipped: "failed" }))
      const checkpoint: TurnCheckpoint = Object.freeze({ n, at: this.#clock(), ...snapshot })
      list.push(checkpoint)
      this.#mine.add(n)
      await this.#prune(list)
      await this.#save(list)
      return checkpoint
    })
  }

  /** Adds what became known after the snapshot: the user message's transcript seq, the turn's id. */
  note(n: number, fields: { readonly userSeq?: number; readonly userId?: string; readonly turnId?: string; readonly vendor?: VendorMark }): Promise<void> {
    return this.#serial(async () => {
      const list = await this.#load()
      const index = list.findIndex((checkpoint) => checkpoint.n === n)
      const current = list[index]
      if (current === undefined) return
      list[index] = Object.freeze({
        ...current,
        ...(fields.userSeq === undefined ? {} : { userSeq: fields.userSeq }),
        ...(fields.userId === undefined ? {} : { userId: fields.userId }),
        ...(fields.turnId === undefined ? {} : { turnId: fields.turnId }),
        ...(fields.vendor === undefined || !isVendorMark(fields.vendor) ? {} : { vendor: Object.freeze({ session: fields.vendor.session, at: fields.vendor.at }) }),
      })
      await this.#save(list)
    })
  }

  list(): Promise<readonly TurnCheckpoint[]> {
    return this.#serial(async () => Object.freeze([...(await this.#load())]))
  }

  /** The checkpoint taken before the turn `target` names. */
  find(target: CheckpointTarget): Promise<TurnCheckpoint> {
    return this.#serial(async () => {
      const list = await this.#load()
      const found = "turnId" in target ? [...list].reverse().find((item) => item.turnId === target.turnId && this.#mine.has(item.n)) : list.find((item) => item.userId === target.userId)
      if (found === undefined) throw new GitError("GIT_NOT_FOUND", "that turn has no checkpoint")
      return found
    })
  }

  /** The files that differ now from the work tree before checkpoint `n`. */
  changes(n: number): Promise<{ readonly checkpoint: TurnCheckpoint; readonly files: readonly CheckpointChange[] }> {
    return this.#serial(async () => {
      const checkpoint = await this.#find(n)
      if (checkpoint.tree === undefined) return Object.freeze({ checkpoint, files: Object.freeze([]) })
      return Object.freeze({ checkpoint, files: await this.#changesSince(await this.#open(), checkpoint.tree) })
    })
  }

  /**
   * Puts `paths` back as they were at checkpoint `n`: a changed or deleted file gets its old content,
   * a file added since is removed. Only paths that changed since are touched.
   */
  restore(n: number, paths: readonly string[]): Promise<CheckpointRestore> {
    return this.#serial(async () => {
      const checkpoint = await this.#find(n)
      if (checkpoint.tree === undefined) throw new GitError("GIT_NOT_FOUND", "that turn has no snapshot to restore")
      const wanted = new Set(paths.map((path) => parseGitPath(path)))
      const shadow = await this.#open()
      const changes = (await this.#changesSince(shadow, checkpoint.tree)).filter((entry) => wanted.has(entry.path))
      const failed: { path: string; reason: string }[] = []
      const restored: string[] = []
      for (const path of wanted) if (!changes.some((entry) => entry.path === path)) failed.push({ path, reason: "unchanged since then" })
      const back = changes.filter((entry) => entry.change !== "added")
      if (back.length > 0) {
        const scratch = await mkdtemp(join(tmpdir(), "runrail-rewind-"))
        try {
          const indexFile = join(scratch, "index")
          await this.#git(shadow, { indexFile, args: ["read-tree", checkpoint.tree] })
          const input = new TextEncoder().encode(back.map((entry) => `${shadow.prefix}${entry.path}\0`).join(""))
          const result = await this.#git(shadow, { indexFile, args: ["checkout-index", "-f", "-z", "--stdin"], stdin: input, okExitCodes: [0, 1], timeoutMs: SNAPSHOT_TIMEOUT_MS })
          if (result.exitCode === 0) restored.push(...back.map((entry) => entry.path))
          else for (const entry of back) failed.push({ path: entry.path, reason: "could not be written" })
        } finally {
          await rm(scratch, { recursive: true, force: true })
        }
      }
      for (const entry of changes.filter((item) => item.change === "added")) {
        const target = inside(shadow, entry.path)
        try {
          await rm(target, { force: true })
          await removeEmptyParents(dirname(target), resolve(shadow.toplevel, shadow.prefix))
          restored.push(entry.path)
        } catch {
          failed.push({ path: entry.path, reason: "could not be removed" })
        }
      }
      return Object.freeze({ restored: Object.freeze(restored.sort()), failed: Object.freeze(failed) })
    })
  }

  /** Drops checkpoint `n` and every later one, as a rewind removes those turns. */
  dropFrom(n: number): Promise<void> {
    return this.#serial(async () => {
      const list = await this.#load()
      const at = list.findIndex((checkpoint) => checkpoint.n === n)
      if (at < 0) return
      const dropped = list.splice(at)
      await this.#deleteRefs(dropped.map((checkpoint) => ref(checkpoint.n)))
      await this.#save(list)
    })
  }

  /** Deletes every checkpoint of this session: the list and the shadow repository. */
  forget(): Promise<void> {
    return this.#serial(async () => {
      this.#list = []
      this.#shadow = undefined
      await rm(join(this.#dir, LIST_FILE), { force: true })
      await rm(join(this.#dir, SHADOW_DIR), { recursive: true, force: true })
    })
  }

  async #snapshot(n: number): Promise<{ readonly tree: string } | { readonly skipped: CheckpointSkip }> {
    if (this.#tooLarge) return { skipped: "too-large" }
    const shadow = await this.#open()
    if (!(await this.#small(shadow))) {
      // Without a repository's stat cache a large folder is walked in full each time: it is not tried again this session.
      if (!shadow.borrowed) this.#tooLarge = true
      return { skipped: "too-large" }
    }
    const tree = await snapshotTree(shadow, (options) => this.#git(shadow, options))
    const stored = tree === undefined ? undefined : await this.#git(shadow, { args: ["update-ref", ref(n), tree], okExitCodes: [0, 1, 128] }).catch(() => undefined)
    if (tree === undefined || stored?.exitCode !== 0) {
      // The next turn finds the folder again and hashes every file, in case the index names an
      // object the repository has since pruned.
      this.#shadow = undefined
      await rm(join(shadow.gitDir, "index"), { force: true })
      return { skipped: "failed" }
    }
    return { tree }
  }

  /**
   * The shadow repository, made on first use. For a git repository it borrows the objects, takes
   * the excludes each time a session opens it (the person may have changed them), and starts from
   * a copy of the index.
   */
  async #open(): Promise<Shadow> {
    if (this.#shadow !== undefined) return this.#shadow
    const gitDir = join(this.#dir, SHADOW_DIR)
    const repo = await probeGitRepository(this.#root, this.#run).catch((error: unknown) => {
      if (outsideWorkTree(error)) return undefined
      throw error
    })
    const shadow: Shadow = Object.freeze({ gitDir, toplevel: repo?.toplevel ?? (await realpath(this.#root)), prefix: repo?.prefix ?? "", borrowed: repo !== undefined })
    const fresh = !(await present(join(gitDir, "HEAD")))
    if (fresh) {
      await mkdir(gitDir, { recursive: true, mode: 0o700 })
      // No template: the person's init.templateDir has no business in Runrail's own repository.
      await this.#git(shadow, { args: ["init", "-q", "--template="] })
    }
    let excludes = ""
    if (repo !== undefined) {
      const paths = await this.#borrowed(repo)
      await mkdir(join(gitDir, "objects", "info"), { recursive: true })
      await writeFile(join(gitDir, "objects", "info", "alternates"), `${paths.objects}\n`)
      excludes = await readFile(paths.exclude, "utf8").catch(() => "")
      if (fresh) await copyIndex(paths.index, join(gitDir, "index"))
    }
    await mkdir(join(gitDir, "info"), { recursive: true })
    await writeFile(join(gitDir, "info", "exclude"), `${excludes}${excludes.length === 0 || excludes.endsWith("\n") ? "" : "\n"}${SHADOW_EXCLUDES.join("\n")}\n`)
    this.#shadow = shadow
    return shadow
  }

  /** Where the person's repository keeps its objects, excludes and index; a linked worktree's are found too. */
  async #borrowed(repo: GitRepository): Promise<{ readonly objects: string; readonly exclude: string; readonly index: string }> {
    const result = await this.#run({ cwd: repo.toplevel, args: ["rev-parse", "--git-path", "objects", "--git-path", "info/exclude", "--git-path", "index"], maxOutputBytes: 16 * 1024 })
    const [objects = "", exclude = "", index = ""] = result.stdout.split("\n").map((line) => line.trim())
    if (objects.length === 0 || exclude.length === 0 || index.length === 0) throw new GitError("GIT_FAILED", "the repository's folders could not be found")
    return { objects: resolve(repo.toplevel, objects), exclude: resolve(repo.toplevel, exclude), index: resolve(repo.toplevel, index) }
  }

  /** Few enough paths to hash, and untracked files small enough to keep, before every turn. */
  async #small(shadow: Shadow): Promise<boolean> {
    const first = !(await present(join(shadow.gitDir, "index")))
    const status = await this.#git(shadow, {
      args: ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", scopeOf(shadow)],
      maxOutputBytes: 2 * 1024 * 1024,
      overflow: "truncate",
      timeoutMs: first ? FIRST_STATUS_TIMEOUT_MS : SNAPSHOT_TIMEOUT_MS,
    }).catch((error: unknown) => {
      if (error instanceof GitError && error.code === "GIT_TIMEOUT") return undefined
      throw error
    })
    if (status === undefined || status.truncated) return false
    // Only work-tree changes and untracked files are hashed; the shadow has no commit, so everything else reads as staged.
    const entries = status.stdout.split("\0").filter((entry) => entry.length > 3 && entry[1] !== " ")
    if (entries.length > this.#maxPaths) return false
    let untracked = 0
    for (const entry of entries) {
      if (!entry.startsWith("??")) continue
      const path = stripPrefix(entry.slice(3), shadow.prefix)
      if (path === undefined || isRunrailRuntimePath(path)) continue
      untracked += await lstat(join(shadow.toplevel, entry.slice(3))).then((info) => info.size, () => 0)
      if (untracked > this.#maxUntrackedBytes) return false
    }
    return true
  }

  async #changesSince(shadow: Shadow, tree: string): Promise<readonly CheckpointChange[]> {
    const now = await snapshotTree(shadow, (options) => this.#git(shadow, options))
    if (now === undefined) throw new GitError("GIT_FAILED", "the work tree could not be read")
    const scope = shadow.prefix.length === 0 ? [] : ["--", shadow.prefix.slice(0, -1)]
    const names = await this.#git(shadow, { args: ["diff-tree", "-r", "-z", "--name-status", "--no-renames", tree, now, ...scope], maxOutputBytes: 8 * 1024 * 1024 })
    const fields = names.stdout.split("\0")
    const changes: CheckpointChange[] = []
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index] ?? ""
      const path = stripPrefix(fields[index + 1] ?? "", shadow.prefix)
      if (path === undefined || path.length === 0 || isRunrailRuntimePath(path)) continue
      // diff-tree reads old to new: `A` is a file added since, `D` one deleted since.
      changes.push(Object.freeze({ path, change: status === "A" ? "added" : status === "D" ? "deleted" : "modified" }))
    }
    return Object.freeze(changes.sort((left, right) => left.path.localeCompare(right.path)))
  }

  async #find(n: number): Promise<TurnCheckpoint> {
    const checkpoint = (await this.#load()).find((item) => item.n === n)
    if (checkpoint === undefined) throw new GitError("GIT_NOT_FOUND", "that turn has no checkpoint")
    return checkpoint
  }

  async #prune(list: TurnCheckpoint[]): Promise<void> {
    if (list.length <= this.#maxCheckpoints) return
    const old = list.splice(0, list.length - this.#maxCheckpoints)
    await this.#deleteRefs(old.map((checkpoint) => ref(checkpoint.n)))
  }

  async #deleteRefs(refs: readonly string[]): Promise<void> {
    if (refs.length === 0) return
    const shadow = await this.#open().catch(() => undefined)
    if (shadow === undefined) return
    const input = new TextEncoder().encode(refs.map((name) => `delete ${name}\n`).join(""))
    await this.#git(shadow, { args: ["update-ref", "--stdin"], stdin: input, okExitCodes: [0, 1, 128] }).catch(() => undefined)
  }

  async #load(): Promise<TurnCheckpoint[]> {
    if (this.#list !== undefined) return this.#list
    const text = await readFile(join(this.#dir, LIST_FILE), "utf8").catch(() => undefined)
    this.#list = text === undefined ? [] : parseList(text)
    return this.#list
  }

  async #save(list: readonly TurnCheckpoint[]): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    const file = join(this.#dir, LIST_FILE)
    const staged = `${file}.${String(process.pid)}.tmp`
    await writeFile(staged, `${JSON.stringify({ version: 1, checkpoints: list })}\n`, { mode: 0o600 })
    await rename(staged, file)
  }

  /** Git in the shadow repository, its work tree the workspace's repository (or the folder itself). */
  #git(shadow: Shadow, options: Omit<GitRunOptions, "cwd">): Promise<GitRunResult> {
    return this.#run({ maxOutputBytes: 64 * 1024, ...options, cwd: shadow.toplevel, args: ["--git-dir", shadow.gitDir, "--work-tree", shadow.toplevel, ...options.args] })
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }
}

/** The work tree as a tree object, through the shadow's own index; undefined when git fails. */
async function snapshotTree(shadow: Shadow, git: (options: Omit<GitRunOptions, "cwd">) => Promise<GitRunResult>): Promise<string | undefined> {
  try {
    await git({ args: ["add", "-A", "--", scopeOf(shadow)], timeoutMs: SNAPSHOT_TIMEOUT_MS, maxOutputBytes: 64 * 1024, overflow: "truncate" })
    // Runrail's git calls take pathspecs literally, so its runtime folders are taken out after, and only when they exist.
    const runtime = await existing(RUNRAIL_RUNTIME_DIRS.map((dir) => `${shadow.prefix}${dir}`), shadow.toplevel)
    if (runtime.length > 0) await git({ args: ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...runtime], maxOutputBytes: 64 * 1024, overflow: "truncate" })
    const tree = (await git({ args: ["write-tree"], maxOutputBytes: 4_096 })).stdout.trim()
    return OBJECT_ID.test(tree) ? tree : undefined
  } catch {
    return undefined
  }
}

/**
 * Starts the shadow's index from the repository's, keeping the index's own time: git takes a file
 * written in the same second as the index as possibly changed ("racily clean"), and a newer copy
 * would hide an edit of the same size. Without one the first snapshot hashes every file.
 */
async function copyIndex(from: string, to: string): Promise<void> {
  await copyFile(from, to).then(
    async () => {
      const info = await stat(from)
      await utimes(to, info.atime, info.mtime)
    },
    () => undefined,
  )
}

function scopeOf(shadow: Shadow): string {
  return shadow.prefix.length === 0 ? "." : shadow.prefix.slice(0, -1)
}

function ref(n: number): string {
  return `refs/runrail/checkpoints/${String(n)}`
}

function inside(shadow: Shadow, path: string): string {
  const target = resolve(shadow.toplevel, `${shadow.prefix}${path}`)
  // The repository's own path for the workspace: the session's root may reach it through a symlink.
  const root = resolve(shadow.toplevel, shadow.prefix)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new GitError("GIT_FORBIDDEN", "path escapes the workspace")
  return target
}

function parseList(text: string): TurnCheckpoint[] {
  try {
    const value = JSON.parse(text) as { readonly checkpoints?: unknown }
    if (!Array.isArray(value.checkpoints)) return []
    return value.checkpoints.flatMap((item: unknown): TurnCheckpoint[] => {
      if (typeof item !== "object" || item === null) return []
      const entry = item as Record<string, unknown>
      if (!Number.isSafeInteger(entry.n) || !Number.isFinite(entry.at)) return []
      const tree = typeof entry.tree === "string" && OBJECT_ID.test(entry.tree) ? entry.tree : undefined
      return [
        Object.freeze({
          n: entry.n as number,
          at: entry.at as number,
          ...(Number.isSafeInteger(entry.userSeq) ? { userSeq: entry.userSeq as number } : {}),
          ...(typeof entry.userId === "string" && entry.userId.length > 0 && entry.userId.length <= 512 ? { userId: entry.userId } : {}),
          ...(typeof entry.turnId === "string" && entry.turnId.length > 0 && entry.turnId.length <= 256 ? { turnId: entry.turnId } : {}),
          ...(isVendorMark(entry.vendor) ? { vendor: Object.freeze({ session: entry.vendor.session, at: entry.vendor.at }) } : {}),
          ...(tree === undefined ? { skipped: entry.skipped === "too-large" ? ("too-large" as const) : ("failed" as const) } : { tree }),
        }),
      ]
    })
  } catch {
    return []
  }
}

function present(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

async function existing(paths: readonly string[], base: string): Promise<readonly string[]> {
  const found = await Promise.all(paths.map(async (path) => ((await present(join(base, path))) ? [path] : [])))
  return found.flat()
}

/** Removes `dir` and its parents while they are empty, never `stop` or above it. */
async function removeEmptyParents(dir: string, stop: string): Promise<void> {
  let current = dir
  while (current !== stop && !relative(stop, current).startsWith("..") && current.startsWith(stop)) {
    const removed = await rmdir(current).then(() => true, () => false)
    if (!removed) return
    current = dirname(current)
  }
}
