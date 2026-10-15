import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { GitError } from "./errors.ts"
import { RUNRAIL_RUNTIME_DIRS, isRunrailRuntimePath, stripPrefix } from "./paths.ts"
import { runGit, type GitRunOptions } from "./run.ts"
import { probeGitRepository, type GitRepository } from "./status.ts"

type Runner = (options: GitRunOptions) => ReturnType<typeof runGit>

export interface ThreadWorktree {
  readonly id: string
  /** Absolute work-tree root. */
  readonly path: string
  /** Absolute directory matching the source workspace position inside the work tree. */
  readonly cwd: string
  readonly head?: string
  readonly branch?: string
  readonly detached: boolean
  readonly locked: boolean
  readonly prunable: boolean
}

export interface ThreadWorktreeCreate {
  readonly id: string
  readonly revision?: string
  readonly branch?: string
}

export interface ThreadWorktreeApply {
  readonly id: string
  /** Commit the worktree forked from; the applied change set is everything after it. */
  readonly base: string
  /** Workspace-relative paths the change set touched. */
  readonly files: readonly string[]
  /** Workspace-relative paths left with conflict markers in the project checkout. */
  readonly conflicts: readonly string[]
}

export interface ThreadWorktreesOptions {
  /** Workspace root of the source session. */
  readonly root: string
  /** Directory that holds Runrail thread worktrees for every project. Kept outside repositories. */
  readonly baseDir: string
  readonly run?: Runner
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_APPLY_FILES = 10_000
const MAX_PATCH_BYTES = 64 * 1024 * 1024

/**
 * Persistent per-thread git worktrees. State lives in git itself (`git worktree list`), so the
 * listing survives control-server restarts. Only worktrees under this project's directory are
 * visible or removable.
 */
export class ThreadWorktrees {
  readonly #root: string
  readonly #baseDir: string
  readonly #run: Runner
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: ThreadWorktreesOptions) {
    this.#root = options.root
    this.#baseDir = options.baseDir
    this.#run = options.run ?? runGit
  }

  async list(): Promise<readonly ThreadWorktree[]> {
    const repo = await probeGitRepository(this.#root, this.#run)
    const projectDir = await this.#projectDir(repo, false)
    if (projectDir === undefined) return Object.freeze([])
    return this.#listIn(repo, projectDir)
  }

  create(input: ThreadWorktreeCreate): Promise<ThreadWorktree> {
    return this.#serial(async () => {
      const id = parseWorktreeId(input.id)
      const revision = parseRevision(input.revision ?? "HEAD")
      const repo = await probeGitRepository(this.#root, this.#run)
      if (input.branch !== undefined) await this.#assertNewBranch(repo, input.branch)
      const resolved = await this.#run({ cwd: repo.root, args: ["rev-parse", "--verify", "-q", `${revision}^{commit}`], okExitCodes: [0, 1, 128], maxOutputBytes: 1_024 })
      const commit = resolved.stdout.trim()
      if (resolved.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
        if (revision === "HEAD") throw new GitError("GIT_CONFLICT", "repository has no commit to branch from")
        throw new GitError("GIT_NOT_FOUND", "revision was not found")
      }
      const projectDir = await this.#projectDir(repo, true)
      if (projectDir === undefined) throw new GitError("GIT_FAILED", "worktree directory is unavailable")
      const path = join(projectDir, id)
      if (await exists(path)) throw new GitError("GIT_CONFLICT", "worktree already exists")
      await this.#run({
        cwd: repo.root,
        args: ["worktree", "add", "--quiet", ...(input.branch === undefined ? ["--detach"] : ["-b", input.branch]), path, commit],
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
        overflow: "truncate",
      })
      const created = (await this.#listIn(repo, projectDir)).find((entry) => entry.id === id)
      if (created === undefined) throw new GitError("GIT_FAILED", "worktree was not registered")
      return created
    })
  }

  /**
   * `deleteBranch` also deletes the worktree's branch, but only when git considers it merged into
   * the project: a branch holding commits of its own is kept so the work stays reachable.
   */
  remove(idValue: unknown, force: boolean, deleteBranch = false): Promise<{ readonly id: string; readonly removed: true; readonly branchDeleted?: boolean }> {
    return this.#serial(async () => {
      const id = parseWorktreeId(idValue)
      const repo = await probeGitRepository(this.#root, this.#run)
      const projectDir = await this.#projectDir(repo, false)
      const entry = projectDir === undefined ? undefined : (await this.#listIn(repo, projectDir)).find((candidate) => candidate.id === id)
      if (entry === undefined) throw new GitError("GIT_NOT_FOUND", "worktree was not found")
      if (!force && !entry.prunable) {
        const dirty = await this.#run({ cwd: entry.path, args: ["status", "--porcelain", "-z", "--untracked-files=normal"], maxOutputBytes: 1_024, overflow: "truncate" })
        if (dirty.stdout.length > 0) throw new GitError("GIT_CONFLICT", "worktree has uncommitted changes")
      }
      await this.#run({ cwd: repo.root, args: ["worktree", "remove", ...(force ? ["--force"] : []), entry.path], timeoutMs: 120_000, maxOutputBytes: 64 * 1024, overflow: "truncate" })
      if (!deleteBranch) return Object.freeze({ id, removed: true as const })
      const deleted = entry.branch === undefined
        ? undefined
        : await this.#run({ cwd: repo.root, args: ["branch", "-d", "--", entry.branch], okExitCodes: [0, 1], maxOutputBytes: 8 * 1024, overflow: "truncate" })
      return Object.freeze({ id, removed: true as const, branchDeleted: deleted?.exitCode === 0 })
    })
  }

  /**
   * Applies everything the worktree changed since it forked (commits, edits, and new files) to the
   * project checkout as a three-way merge. Results are staged so they show up for review; paths
   * that do not merge cleanly are left with conflict markers. Only the session's workspace scope
   * is applied, and Runrail's runtime state never is. Nothing in either checkout's own index is
   * touched until the final apply, which git performs atomically when it cannot merge.
   */
  apply(idValue: unknown): Promise<ThreadWorktreeApply> {
    return this.#serial(async () => {
      const id = parseWorktreeId(idValue)
      const repo = await probeGitRepository(this.#root, this.#run)
      const projectDir = await this.#projectDir(repo, false)
      const entry = projectDir === undefined ? undefined : (await this.#listIn(repo, projectDir)).find((candidate) => candidate.id === id)
      if (entry === undefined || entry.prunable) throw new GitError("GIT_NOT_FOUND", "worktree was not found")
      const scope = repo.prefix.length === 0 ? [] : ["--", repo.prefix.slice(0, -1)]
      if ((await this.#unmerged(repo.toplevel, scope)).length > 0) throw new GitError("GIT_CONFLICT", "project has unresolved conflicts")
      const base = await this.#forkPoint(entry.path, repo.toplevel)
      const scratch = await mkdtemp(join(tmpdir(), "runrail-apply-"))
      try {
        const indexFile = join(scratch, "index")
        const snapshot = { cwd: entry.path, indexFile, maxOutputBytes: 64 * 1024, overflow: "truncate" as const }
        await this.#run({ ...snapshot, args: ["read-tree", "HEAD"] })
        await this.#run({ ...snapshot, args: ["add", "-A"], timeoutMs: 120_000 })
        await this.#run({ ...snapshot, args: ["reset", "-q", base, "--", ...RUNRAIL_RUNTIME_DIRS.map((dir) => `${repo.prefix}${dir}`)] })
        const tree = (await this.#run({ ...snapshot, args: ["write-tree"] })).stdout.trim()
        if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError("GIT_FAILED", "worktree snapshot failed")
        const names = await this.#run({ cwd: entry.path, args: ["diff-tree", "-r", "-z", "--name-only", "--no-renames", base, tree, ...scope], maxOutputBytes: 4 * 1024 * 1024 })
        const changed = names.stdout.split("\0").filter((path) => path.length > 0 && !isRunrailRuntimePath(stripPrefix(path, repo.prefix) ?? path))
        if (changed.length > MAX_APPLY_FILES) throw new GitError("GIT_LIMIT", "change set has too many files")
        const files = workspacePaths(changed, repo.prefix)
        if (files.length === 0) return Object.freeze({ id, base, files, conflicts: Object.freeze([]) })
        const patch = join(scratch, "change.patch")
        await this.#run({
          cwd: entry.path,
          args: ["diff-tree", "-r", "-p", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", `--output=${patch}`, base, tree, ...scope],
          timeoutMs: 120_000,
          maxOutputBytes: 1_024,
        })
        if ((await stat(patch)).size > MAX_PATCH_BYTES) throw new GitError("GIT_LIMIT", "change set exceeds its byte limit")
        const applied = await this.#run({
          cwd: repo.toplevel,
          args: ["apply", "--3way", "--whitespace=nowarn", patch],
          okExitCodes: [0, 1],
          timeoutMs: 120_000,
          maxOutputBytes: 64 * 1024,
          overflow: "truncate",
        })
        const conflicts = workspacePaths(await this.#unmerged(repo.toplevel, scope), repo.prefix)
        if (applied.exitCode !== 0 && conflicts.length === 0)
          throw new GitError("GIT_CONFLICT", "project has local changes in files the worktree changed; commit or stash them first")
        return Object.freeze({ id, base, files, conflicts })
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })
  }

  async #forkPoint(worktree: string, toplevel: string): Promise<string> {
    const head = (await this.#run({ cwd: worktree, args: ["rev-parse", "--verify", "HEAD"], maxOutputBytes: 1_024 })).stdout.trim()
    const source = await this.#run({ cwd: toplevel, args: ["rev-parse", "--verify", "-q", "HEAD"], okExitCodes: [0, 1], maxOutputBytes: 1_024 })
    if (source.exitCode !== 0) throw new GitError("GIT_CONFLICT", "project has no commit to apply onto")
    const base = await this.#run({ cwd: worktree, args: ["merge-base", head, source.stdout.trim()], okExitCodes: [0, 1], maxOutputBytes: 1_024 })
    const commit = base.stdout.trim()
    if (base.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError("GIT_CONFLICT", "worktree shares no history with the project")
    return commit
  }

  async #unmerged(toplevel: string, scope: readonly string[]): Promise<readonly string[]> {
    const result = await this.#run({ cwd: toplevel, args: ["diff", "--name-only", "-z", "--diff-filter=U", "--no-ext-diff", ...scope], maxOutputBytes: 4 * 1024 * 1024 })
    return [...new Set(result.stdout.split("\0").filter((path) => path.length > 0))]
  }

  async #listIn(repo: GitRepository, projectDir: string): Promise<readonly ThreadWorktree[]> {
    let result = await this.#run({ cwd: repo.root, args: ["worktree", "list", "--porcelain", "-z"], okExitCodes: [0, 129], maxOutputBytes: 1024 * 1024 })
    let listed = result.stdout
    // Git before 2.36 (Ubuntu 22.04 has 2.34) lacks `-z`; its line form only breaks on a path with
    // a newline, and the worktrees kept here are named by ID_PATTERN.
    if (result.exitCode === 129) {
      result = await this.#run({ cwd: repo.root, args: ["worktree", "list", "--porcelain"], maxOutputBytes: 1024 * 1024 })
      listed = result.stdout.replaceAll("\n", "\0")
    }
    const worktrees: ThreadWorktree[] = []
    for (const record of parseWorktreeList(listed)) {
      if (dirname(record.path) !== projectDir || !ID_PATTERN.test(basename(record.path))) continue
      worktrees.push(Object.freeze({
        id: basename(record.path),
        path: record.path,
        cwd: repo.prefix.length === 0 ? record.path : join(record.path, repo.prefix),
        ...(record.head === undefined ? {} : { head: record.head }),
        ...(record.branch === undefined ? {} : { branch: record.branch }),
        detached: record.detached,
        locked: record.locked,
        prunable: record.prunable,
      }))
    }
    return Object.freeze(worktrees)
  }

  async #projectDir(repo: GitRepository, create: boolean): Promise<string | undefined> {
    const common = await this.#run({ cwd: repo.root, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], maxOutputBytes: 8 * 1024 })
    const commonDir = common.stdout.trim()
    if (commonDir.length === 0) throw new GitError("GIT_FAILED", "repository location is unavailable")
    const canonical = await realpath(commonDir).catch(() => commonDir)
    const name = basename(dirname(canonical)).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "repo"
    const key = `${name}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`
    const projectDir = join(this.#baseDir, key)
    if (create) await mkdir(projectDir, { recursive: true, mode: 0o700 })
    else if (!(await exists(projectDir))) return undefined
    const resolved = await realpath(projectDir)
    if (isInside(resolved, repo.toplevel)) throw new GitError("GIT_FORBIDDEN", "worktree directory must be outside the repository")
    return resolved
  }

  async #assertNewBranch(repo: GitRepository, branch: string): Promise<void> {
    if (branch.length === 0 || branch.length > 200 || branch.startsWith("-") || /[\0\r\n]/.test(branch))
      throw new GitError("GIT_INVALID", "branch is invalid")
    const format = await this.#run({ cwd: repo.root, args: ["check-ref-format", "--branch", branch], okExitCodes: [0, 1, 128], maxOutputBytes: 1_024 })
    if (format.exitCode !== 0) throw new GitError("GIT_INVALID", "branch is invalid")
    const existing = await this.#run({ cwd: repo.root, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], okExitCodes: [0, 1], maxOutputBytes: 1_024 })
    if (existing.exitCode === 0) throw new GitError("GIT_CONFLICT", "branch already exists")
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.catch(() => undefined)
    return next
  }
}

interface WorktreeRecord {
  readonly path: string
  readonly head?: string
  readonly branch?: string
  readonly detached: boolean
  readonly locked: boolean
  readonly prunable: boolean
}

/** Parses `git worktree list --porcelain -z`. Records are separated by an empty field. */
export function parseWorktreeList(output: string): readonly WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let current: { path?: string; head?: string; branch?: string; detached: boolean; locked: boolean; prunable: boolean } = { detached: false, locked: false, prunable: false }
  const flush = (): void => {
    if (current.path !== undefined) records.push(Object.freeze({ ...current, path: current.path }))
    current = { detached: false, locked: false, prunable: false }
  }
  for (const field of output.split("\0")) {
    if (field.length === 0) {
      flush()
      continue
    }
    const space = field.indexOf(" ")
    const key = space < 0 ? field : field.slice(0, space)
    const value = space < 0 ? "" : field.slice(space + 1)
    if (key === "worktree") current.path = value
    else if (key === "HEAD") current.head = value
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "")
    else if (key === "detached") current.detached = true
    else if (key === "locked") current.locked = true
    else if (key === "prunable") current.prunable = true
  }
  flush()
  return Object.freeze(records)
}

export function parseWorktreeId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new GitError("GIT_INVALID", "worktree id is invalid")
  return value
}

function parseRevision(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.startsWith("-") || /[\0\r\n\s]/.test(value))
    throw new GitError("GIT_INVALID", "revision is invalid")
  return value
}

function workspacePaths(paths: readonly string[], prefix: string): readonly string[] {
  return Object.freeze(paths.map((path) => stripPrefix(path, prefix) ?? path))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}
