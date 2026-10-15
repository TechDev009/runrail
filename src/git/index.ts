import { readGitDiff, type GitDiff, type GitDiffOptions } from "./diff.ts"
import { listGitRemotes, previewGitPush, pushGitBranch, readRemoteBranch, type GitPushOptions, type GitPushPreview, type GitPushResult, type GitPushTarget, type GitRemote, type GitRemoteHints } from "./remote.ts"
import { runGit, type GitRunOptions } from "./run.ts"
import { pullGitBranch, type GitPullOptions, type GitPullResult } from "./pull.ts"
import { fetchGitSource, listGitBranches, type GitBranches, type GitFetchResult, type GitFetchSource } from "./sources.ts"
import { probeGitRepository, readGitHead, readGitStatus, type GitHead, type GitRepository, type GitStatusSnapshot } from "./status.ts"
import {
  commitGitChanges,
  discardGitPaths,
  stageGitPaths,
  unstageGitPaths,
  type GitCommitOptions,
  type GitCommitResult,
  type GitDiscardResult,
} from "./write.ts"

export { GitError, type GitErrorCode } from "./errors.ts"
export { GIT_MAX_PATHS, parseGitPath, parseGitPaths, parseOptionalGitPaths } from "./paths.ts"
export { GIT_MAX_COMMIT_MESSAGE_BYTES, parseCommitMessage } from "./write.ts"
export type { GitChange, GitHead, GitRepository, GitStatusEntry, GitStatusSnapshot } from "./status.ts"
export { outsideWorkTree } from "./status.ts"
export type { GitDiff, GitDiffFile, GitDiffOptions, GitDiffScope, GitPatchOmission } from "./diff.ts"
export type { GitCommitOptions, GitCommitResult, GitDiscardResult } from "./write.ts"
export { describeRemote, GIT_SERVICES, knownHostService, parseBranchName, parseRemoteName } from "./remote.ts"
export { CodeHostError, CodeHostStore, MAX_CODE_HOSTS, parseCodeHost, parseGitService, type CodeHostConnection, type CodeHostListing, type CodeHostRecord } from "./codehosts.ts"
export type { GitPushCommit, GitPushOptions, GitPushPreview, GitPushResult, GitPushTarget, GitRemote, GitRemoteHints, GitService, GitServiceSource } from "./remote.ts"
export { GIT_MAX_BRANCHES, GIT_PULL_NAMESPACE, parseFetchSource } from "./sources.ts"
export type { GitBranch, GitBranches, GitFetchResult, GitFetchSource, GitRemoteBranch } from "./sources.ts"
export type { GitPullOptions, GitPullResult } from "./pull.ts"
export { ThreadWorktrees, parseWorktreeId, type ThreadWorktree, type ThreadWorktreeApply, type ThreadWorktreeCreate, type ThreadWorktreesOptions } from "./worktrees.ts"

export interface GitLogEntry {
  readonly commit: string
  readonly shortCommit: string
  readonly authorName: string
  readonly authoredAt: number
  readonly summary: string
}

export interface GitLogOptions {
  readonly limit: number
  readonly skip: number
  readonly paths?: readonly string[]
  readonly signal?: AbortSignal
}

export interface GitWorkspaceOptions {
  readonly root: string
  /** Test seam: replaces the process runner. */
  readonly run?: (options: GitRunOptions) => ReturnType<typeof runGit>
  /** The person's answers on which service a host is, read on each call. */
  readonly hints?: () => Promise<GitRemoteHints>
}

/**
 * Git review surface for one workspace root. Every call re-probes the repository so a workspace
 * that becomes (or stops being) a work tree is reported accurately. Writes are serialized.
 */
export class GitWorkspace {
  readonly root: string
  readonly #run: (options: GitRunOptions) => ReturnType<typeof runGit>
  readonly #hints: () => Promise<GitRemoteHints>
  #writeQueue: Promise<unknown> = Promise.resolve()

  constructor(options: GitWorkspaceOptions) {
    this.root = options.root
    this.#run = options.run ?? runGit
    this.#hints = options.hints ?? (async () => ({}))
  }

  repository(signal?: AbortSignal): Promise<GitRepository> {
    return probeGitRepository(this.root, this.#run, signal)
  }

  async available(): Promise<boolean> {
    try {
      await this.repository()
      return true
    } catch {
      return false
    }
  }

  async status(maxEntries: number, signal?: AbortSignal): Promise<GitStatusSnapshot> {
    return readGitStatus(await this.repository(signal), maxEntries, this.#run, signal)
  }

  async head(signal?: AbortSignal): Promise<GitHead> {
    return readGitHead(await this.repository(signal), this.#run, signal)
  }

  async diff(options: GitDiffOptions): Promise<GitDiff> {
    return readGitDiff(await this.repository(options.signal), options, this.#run)
  }

  stage(paths: readonly string[]): Promise<readonly string[]> {
    return this.#serial(async () => stageGitPaths(await this.repository(), paths, this.#run))
  }

  unstage(paths: readonly string[]): Promise<readonly string[]> {
    return this.#serial(async () => unstageGitPaths(await this.repository(), paths, this.#run))
  }

  discard(paths: readonly string[], scope: "unstaged" | "all", includeUntracked: boolean): Promise<GitDiscardResult> {
    return this.#serial(async () => discardGitPaths(await this.repository(), paths, scope, includeUntracked, this.#run))
  }

  commit(options: GitCommitOptions): Promise<GitCommitResult> {
    return this.#serial(async () => commitGitChanges(await this.repository(options.signal), options, this.#run))
  }

  async remotes(signal?: AbortSignal): Promise<readonly GitRemote[]> {
    return listGitRemotes(await this.repository(signal), this.#run, signal, await this.#hints())
  }

  async pushPreview(target: GitPushTarget, signal?: AbortSignal): Promise<GitPushPreview> {
    return previewGitPush(await this.repository(signal), target, this.#run, signal)
  }

  async remoteBranch(remote: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
    return readRemoteBranch(await this.repository(signal), remote, branch, this.#run, signal)
  }

  /** Pushes after re-checking the confirmation from `pushPreview`. Serialized with other writes. */
  push(options: GitPushOptions): Promise<GitPushResult> {
    return this.#serial(async () => pushGitBranch(await this.repository(options.signal), options, this.#run))
  }

  async branches(maxBranches: number, signal?: AbortSignal): Promise<GitBranches> {
    return listGitBranches(await this.repository(signal), maxBranches, this.#run, signal)
  }

  /** Fetches one branch or pull request head. Serialized with other writes, since it moves refs. */
  fetch(source: GitFetchSource, signal?: AbortSignal): Promise<GitFetchResult> {
    return this.#serial(async () => fetchGitSource(await this.repository(signal), source, this.#run, signal, await this.#hints()))
  }

  /** Fast-forwards the checked-out branch to its upstream. Serialized with other writes. */
  pull(options: GitPullOptions): Promise<GitPullResult> {
    return this.#serial(async () => pullGitBranch(await this.repository(options.signal), options, this.#run))
  }

  async log(options: GitLogOptions): Promise<readonly GitLogEntry[]> {
    const repo = await this.repository(options.signal)
    const signal = options.signal === undefined ? {} : { signal: options.signal }
    const head = await this.#run({ cwd: repo.root, args: ["rev-parse", "--verify", "-q", "HEAD"], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...signal })
    if (head.exitCode !== 0) return Object.freeze([])
    const result = await this.#run({
      cwd: repo.root,
      args: ["log", "-z", `--max-count=${options.limit}`, `--skip=${options.skip}`, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s", "--", ...(options.paths ?? ["."])],
      maxOutputBytes: 2 * 1024 * 1024,
      overflow: "truncate",
      ...signal,
    })
    const records = result.stdout.split("\0")
    if (result.truncated) records.pop()
    const entries: GitLogEntry[] = []
    for (const record of records) {
      const [commit, shortCommit, authorName, authoredAt, summary] = record.replace(/^\n/, "").split("\x1f")
      if (commit === undefined || shortCommit === undefined || authorName === undefined || authoredAt === undefined || summary === undefined) continue
      entries.push(Object.freeze({ commit, shortCommit, authorName, authoredAt: Number(authoredAt) * 1_000, summary }))
    }
    return Object.freeze(entries)
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#writeQueue.then(operation, operation)
    this.#writeQueue = next.catch(() => undefined)
    return next
  }
}
