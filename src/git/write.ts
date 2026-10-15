import { GitError } from "./errors.ts"
import { isRunrailRuntimePath, pathWithin } from "./paths.ts"
import { runGit, type GitRunOptions } from "./run.ts"
import { readGitStatus, type GitRepository, type GitStatusEntry } from "./status.ts"
import { isSensitiveWorkspacePath } from "../workspace/policy.ts"

type Runner = (options: GitRunOptions) => ReturnType<typeof runGit>

export const GIT_MAX_COMMIT_MESSAGE_BYTES = 16 * 1024
const MAX_WRITE_TARGETS = 4_096

export interface GitDiscardResult {
  readonly restored: readonly string[]
  readonly removed: readonly string[]
  readonly skippedUntracked: number
  readonly skippedConflicted: number
}

export interface GitCommitOptions {
  readonly message: string
  readonly paths?: readonly string[]
  readonly runHooks: boolean
  readonly signal?: AbortSignal
}

export interface GitCommitResult {
  readonly commit: string
  readonly shortCommit: string
  readonly summary: string
}

/** Stages changed and untracked files under `paths`. Returns the files staged. */
export async function stageGitPaths(repo: GitRepository, paths: readonly string[], run: Runner = runGit): Promise<readonly string[]> {
  const targets = await expandTargets(repo, paths, (entry) => entry.unstaged || entry.untracked, run)
  if (targets.length > 0) await run({ cwd: repo.root, args: ["add", "--all", "--", ...targets], timeoutMs: 60_000 })
  return targets
}

/** Unstages staged files under `paths`, including both sides of a staged rename. */
export async function unstageGitPaths(repo: GitRepository, paths: readonly string[], run: Runner = runGit): Promise<readonly string[]> {
  const targets = await expandTargets(repo, paths, (entry) => entry.staged, run)
  if (targets.length > 0) await run({ cwd: repo.root, args: ["reset", "-q", "--", ...targets], timeoutMs: 60_000 })
  return targets
}

/**
 * Resolves caller paths (files or directories) to the concrete changed files under them, so git
 * commands receive explicit file lists. Runrail runtime state is skipped unless a caller path
 * points inside it; untracked credential files are skipped unless named exactly.
 */
async function expandTargets(
  repo: GitRepository,
  paths: readonly string[],
  select: (entry: GitStatusEntry) => boolean,
  run: Runner,
): Promise<string[]> {
  const includeRuntime = paths.some(isRunrailRuntimePath)
  const status = await readGitStatus(repo, MAX_WRITE_TARGETS + 1, run, undefined, includeRuntime)
  if (status.truncated) throw new GitError("GIT_LIMIT", "too many changed paths to update safely")
  const targets: string[] = []
  for (const entry of status.entries) {
    if (entry.conflicted || !select(entry)) continue
    const requested = paths.filter((scope) => pathWithin(entry.path, scope))
    if (requested.length === 0) continue
    if (isRunrailRuntimePath(entry.path) && !requested.some(isRunrailRuntimePath)) continue
    // A new credential file is only staged when named exactly, never through a directory.
    if (entry.untracked && entry.sensitive && !requested.includes(entry.path)) continue
    if (!targets.includes(entry.path)) targets.push(entry.path)
    if (entry.originalPath !== undefined && !entry.originalPath.startsWith("../") && !targets.includes(entry.originalPath))
      targets.push(entry.originalPath)
  }
  return targets
}

/**
 * Discards changes under `paths`. `unstaged` restores the work tree from the index; `all` also
 * resets the index to HEAD. Untracked files are deleted only with `includeUntracked`. Conflicted
 * paths are never touched.
 */
export async function discardGitPaths(
  repo: GitRepository,
  paths: readonly string[],
  scope: "unstaged" | "all",
  includeUntracked: boolean,
  run: Runner = runGit,
): Promise<GitDiscardResult> {
  const status = await readGitStatus(repo, MAX_WRITE_TARGETS + 1, run)
  if (status.truncated) throw new GitError("GIT_LIMIT", "too many changed paths to discard safely")
  const targets = status.entries.filter((entry) => paths.some((scopePath) => pathWithin(entry.path, scopePath)))
  const conflicted = targets.filter((entry) => entry.conflicted)
  const untracked = targets.filter((entry) => entry.untracked)
  const tracked = targets.filter((entry) => !entry.untracked && !entry.conflicted && (scope === "all" ? entry.staged || entry.unstaged : entry.unstaged))
  if (scope === "all" && status.initial && tracked.some((entry) => entry.staged))
    throw new GitError("GIT_CONFLICT", "repository has no commit to restore staged paths from")
  const restored = restoreTargets(tracked, scope)
  if (restored.length > 0) {
    const args = scope === "all"
      ? ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...restored]
      : ["restore", "--worktree", "--", ...restored]
    await run({ cwd: repo.root, args, timeoutMs: 60_000 })
  }
  // A credential file such as `.env` is deleted only when it is named itself, never as part of a folder.
  const kept = untracked.filter((entry) => isSensitiveWorkspacePath(entry.path) && !paths.includes(entry.path))
  const removed = includeUntracked ? untracked.filter((entry) => !kept.includes(entry)).map((entry) => entry.path) : []
  if (removed.length > 0) await run({ cwd: repo.root, args: ["clean", "-f", "-q", "--", ...removed], timeoutMs: 60_000 })
  return Object.freeze({
    restored: Object.freeze(restored),
    removed: Object.freeze(removed),
    skippedUntracked: includeUntracked ? kept.length : untracked.length,
    skippedConflicted: conflicted.length,
  })
}

function restoreTargets(entries: readonly GitStatusEntry[], scope: "unstaged" | "all"): string[] {
  const result: string[] = []
  for (const entry of entries) {
    if (!result.includes(entry.path)) result.push(entry.path)
    if (scope === "all" && entry.originalPath !== undefined && !entry.originalPath.startsWith("../") && !result.includes(entry.originalPath))
      result.push(entry.originalPath)
  }
  return result
}

export function parseCommitMessage(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > GIT_MAX_COMMIT_MESSAGE_BYTES)
    throw new GitError("GIT_INVALID", "commit message is invalid")
  const message = value.trim()
  if (message.length === 0) throw new GitError("GIT_INVALID", "commit message is required")
  return message
}

export async function commitGitChanges(repo: GitRepository, options: GitCommitOptions, run: Runner = runGit): Promise<GitCommitResult> {
  const signal = options.signal === undefined ? {} : { signal: options.signal }
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const identity = await run({ cwd: repo.root, args: ["var", variable], okExitCodes: [0, 128], maxOutputBytes: 4_096, ...signal })
    if (identity.exitCode !== 0) throw new GitError("GIT_IDENTITY_REQUIRED", "git user.name and user.email must be configured")
  }
  const conflicts = await run({ cwd: repo.root, args: ["diff", "--name-only", "--diff-filter=U", "-z"], maxOutputBytes: 64 * 1024, overflow: "truncate", ...signal })
  if (conflicts.stdout.length > 0) throw new GitError("GIT_CONFLICT", "resolve merge conflicts before committing")
  let only: readonly string[] | undefined
  if (options.paths !== undefined) {
    only = await expandTargets(repo, options.paths, (entry) => entry.staged || entry.unstaged || entry.untracked, run)
    if (only.length === 0) throw new GitError("GIT_NOTHING_TO_COMMIT", "nothing to commit under the selected paths")
    await run({ cwd: repo.root, args: ["add", "--all", "--", ...only], timeoutMs: 60_000, ...signal })
  } else {
    const staged = await run({ cwd: repo.root, args: ["diff", "--cached", "--quiet", "--no-ext-diff"], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...signal })
    if (staged.exitCode === 0) throw new GitError("GIT_NOTHING_TO_COMMIT", "nothing is staged to commit")
  }
  const committed = await run({
    cwd: repo.root,
    args: ["commit", "--quiet", "--cleanup=whitespace", "--file=-", ...(only === undefined ? [] : ["--only", "--", ...only])],
    stdin: new TextEncoder().encode(options.message),
    runHooks: options.runHooks,
    signing: true,
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
    overflow: "truncate",
    // Identity, conflicts and an empty index are ruled out above; with hooks on, exit 1 is a hook saying no.
    okExitCodes: options.runHooks ? [0, 1] : [0],
    ...signal,
  })
  if (committed.exitCode === 1) throw new GitError("GIT_HOOK_REJECTED", "a git hook stopped the commit")
  const head = await run({ cwd: repo.root, args: ["log", "-1", "--format=%H%x00%h%x00%s"], maxOutputBytes: 4_096, ...signal })
  const [commit = "", shortCommit = "", summary = ""] = head.stdout.replace(/\n$/, "").split("\0")
  return Object.freeze({ commit, shortCommit, summary })
}
