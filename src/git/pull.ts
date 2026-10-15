import { GitError } from "./errors.ts"
import { listGitRemotes } from "./remote.ts"
import { runGit, type GitRunOptions } from "./run.ts"
import { fetchOneRef } from "./sources.ts"
import type { GitRepository } from "./status.ts"

type Runner = (options: GitRunOptions) => ReturnType<typeof runGit>

const MERGE_TIMEOUT_MS = 120_000
const REF = /^refs\/[^\0-\x20\x7f~^:?*[\\]{1,250}$/

export interface GitPullOptions {
  readonly runHooks: boolean
  readonly signal?: AbortSignal
}

export interface GitPullResult {
  readonly remote: string
  /** The checked-out branch. */
  readonly branch: string
  /** The upstream as git shows it, `origin/main`. */
  readonly upstream: string
  readonly from: string
  readonly to: string
  readonly pulled: number
  readonly outcome: "fast-forwarded" | "up-to-date"
}

/**
 * Brings the checked-out branch up to its upstream, fast-forward only: the upstream's one ref is
 * fetched, then HEAD moves only when it has nothing of its own. A branch and upstream that have
 * both moved are refused with GIT_DIVERGED; nothing is merged or rebased.
 */
export async function pullGitBranch(repo: GitRepository, options: GitPullOptions, run: Runner = runGit): Promise<GitPullResult> {
  const signal = options.signal === undefined ? {} : { signal: options.signal }
  const head = await run({ cwd: repo.root, args: ["symbolic-ref", "-q", "HEAD"], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...signal })
  const headRef = head.stdout.trim()
  if (head.exitCode !== 0 || !headRef.startsWith("refs/heads/")) throw new GitError("GIT_CONFLICT", "check out a branch to pull")
  const branch = headRef.slice("refs/heads/".length)
  const tracking = await run({
    cwd: repo.root,
    args: ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(upstream:short)", headRef],
    maxOutputBytes: 4 * 1024,
    ...signal,
  })
  const [remote = "", remoteRef = "", upstreamRef = "", upstream = ""] = tracking.stdout.replace(/\n$/, "").split("\0")
  if (remote.length === 0 || upstreamRef.length === 0) throw new GitError("GIT_CONFLICT", "the branch has no upstream; publish it first")
  if (!REF.test(upstreamRef) || (remote !== "." && !REF.test(remoteRef))) throw new GitError("GIT_CONFLICT", "the branch's upstream is not a branch")
  if (remote !== ".") {
    const remotes = await listGitRemotes(repo, run, options.signal)
    if (!remotes.some((entry) => entry.name === remote)) throw new GitError("GIT_CONFLICT", "the branch's upstream is not a named remote")
    if (!upstreamRef.startsWith("refs/remotes/")) throw new GitError("GIT_CONFLICT", "the branch's upstream is not a remote-tracking branch")
    await fetchOneRef(repo, remote, remoteRef, upstreamRef, run, options.signal)
  }
  const from = await revision(repo, "HEAD", run, options.signal)
  const counts = await run({ cwd: repo.root, args: ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`], okExitCodes: [0, 128], maxOutputBytes: 1_024, ...signal })
  if (counts.exitCode !== 0) throw new GitError("GIT_NOT_FOUND", "the upstream branch was not found")
  const [ahead = Number.NaN, behind = Number.NaN] = counts.stdout.trim().split(/\s+/).map(Number)
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new GitError("GIT_FAILED", "git pull failed")
  const base = { remote, branch, upstream: upstream.length > 0 ? upstream : upstreamRef, from }
  if (behind === 0) return Object.freeze({ ...base, to: from, pulled: 0, outcome: "up-to-date" as const })
  if (ahead > 0) throw new GitError("GIT_DIVERGED", "the branch and its upstream have both changed")
  const merged = await run({
    cwd: repo.root,
    args: ["merge", "--ff-only", "--no-stat", "--no-edit", "--quiet", upstreamRef],
    okExitCodes: [0, 1, 128],
    runHooks: options.runHooks,
    timeoutMs: MERGE_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    overflow: "truncate",
    ...signal,
  })
  if (merged.exitCode !== 0) throw mergeError(merged.stderr)
  const to = await revision(repo, "HEAD", run, options.signal)
  return Object.freeze({ ...base, to, pulled: behind, outcome: "fast-forwarded" as const })
}

async function revision(repo: GitRepository, name: string, run: Runner, signal: AbortSignal | undefined): Promise<string> {
  const result = await run({ cwd: repo.root, args: ["rev-parse", "--verify", "-q", name], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...(signal === undefined ? {} : { signal }) })
  const commit = result.stdout.trim()
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError("GIT_CONFLICT", "the branch has no commit to pull onto")
  return commit
}

/** Reduces git's words to a fixed message, since they can name paths. */
function mergeError(stderr: string): GitError {
  if (/would be overwritten|local changes|untracked working tree files/i.test(stderr)) return new GitError("GIT_CONFLICT", "local changes would be overwritten; commit or stash them first")
  if (/not concluded your merge|unmerged files|unfinished|in the middle of|rebase/i.test(stderr)) return new GitError("GIT_CONFLICT", "finish the merge or rebase in progress first")
  if (/not possible to fast-forward|non-fast-forward|diverg/i.test(stderr)) return new GitError("GIT_DIVERGED", "the branch and its upstream have both changed")
  return new GitError("GIT_FAILED", "git pull failed")
}
