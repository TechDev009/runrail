import { GitError } from "./errors.ts"
import { listGitRemotes, parseRemoteName, type GitRemoteHints } from "./remote.ts"
import { runGit, type GitRunOptions } from "./run.ts"
import type { GitRepository } from "./status.ts"

/** Where a new worktree can start: the repository's branches, and a branch or pull request fetched from a remote. */

type Runner = (options: GitRunOptions) => ReturnType<typeof runGit>

export const GIT_MAX_BRANCHES = 500
export const GIT_MAX_PULL_REQUEST = 1_000_000_000
const FETCH_TIMEOUT_MS = 120_000
/** Pull request heads are fetched here, apart from remote-tracking refs, so no real branch is overwritten. */
export const GIT_PULL_NAMESPACE = "refs/runrail/pull"

export interface GitBranch {
  readonly name: string
  readonly commit: string
  /** Committer time of the branch's tip, in milliseconds. */
  readonly updatedAt: number
  readonly upstream?: string
}

export interface GitRemoteBranch {
  readonly remote: string
  readonly name: string
  readonly commit: string
  readonly updatedAt: number
}

export interface GitBranches {
  readonly current?: string
  /** Newest first, by the tip's committer time. */
  readonly local: readonly GitBranch[]
  readonly remote: readonly GitRemoteBranch[]
  readonly truncated: boolean
}

export type GitFetchSource = { readonly remote?: string } & ({ readonly branch: string; readonly pullRequest?: undefined } | { readonly pullRequest: number; readonly branch?: undefined })

export interface GitFetchResult {
  readonly remote: string
  /** A full ref name to start a worktree from (`worktree.create` `revision`). */
  readonly revision: string
  readonly commit: string
  readonly branch?: string
  readonly pullRequest?: number
}

/** Local and remote-tracking branches from the refs on disk, up to `maxBranches` of each; no network request is made. */
export async function listGitBranches(repo: GitRepository, maxBranches: number, run: Runner = runGit, signal?: AbortSignal): Promise<GitBranches> {
  const options = signal === undefined ? {} : { signal }
  const [refs, head] = await Promise.all([
    run({
      cwd: repo.root,
      args: ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)%00%(symref)", "refs/heads", "refs/remotes"],
      maxOutputBytes: 2 * 1024 * 1024,
      overflow: "truncate",
      ...options,
    }),
    run({ cwd: repo.root, args: ["symbolic-ref", "-q", "HEAD"], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...options }),
  ])
  const local: GitBranch[] = []
  const remote: GitRemoteBranch[] = []
  let truncated = refs.truncated
  const lines = refs.stdout.split("\n")
  if (refs.truncated) lines.pop()
  for (const line of lines) {
    const [ref = "", commit = "", time = "", upstream = "", symref = ""] = line.split("\0")
    // A remote's HEAD only points at one of its branches.
    if (symref.length > 0 || !/^[0-9a-f]{40,64}$/.test(commit)) continue
    const isLocal = ref.startsWith("refs/heads/")
    if ((isLocal ? local : remote).length >= maxBranches) {
      truncated = true
      continue
    }
    const updatedAt = Number(time) * 1_000
    if (isLocal) {
      const name = branchName(ref.slice("refs/heads/".length))
      if (name !== undefined) local.push(Object.freeze({ name, commit, updatedAt, ...(upstream.length > 0 && upstream.length <= 384 ? { upstream } : {}) }))
      continue
    }
    const rest = ref.slice("refs/remotes/".length)
    const slash = rest.indexOf("/")
    const remoteName = slash > 0 ? remoteNameOf(rest.slice(0, slash)) : undefined
    const name = slash > 0 ? branchName(rest.slice(slash + 1)) : undefined
    if (remoteName !== undefined && name !== undefined) remote.push(Object.freeze({ remote: remoteName, name, commit, updatedAt }))
  }
  const ref = head.stdout.trim()
  const current = head.exitCode === 0 && ref.startsWith("refs/heads/") ? branchName(ref.slice("refs/heads/".length)) : undefined
  return Object.freeze({ ...(current === undefined ? {} : { current }), local: Object.freeze(local), remote: Object.freeze(remote), truncated })
}

/**
 * Fetches one branch, or one pull or merge request's head, so a worktree can start from it. Only
 * the named ref is fetched, with no tags; the person's own git credentials reach the remote and
 * nothing prompts, so no connector is needed. A branch updates its remote-tracking ref as
 * `git fetch` would; a review lands under `refs/runrail/pull/<remote>/<number>`. The review ref
 * follows the remote's service: GitHub `refs/pull/<n>/head`, GitLab
 * `refs/merge-requests/<n>/head`, an unknown host both in that order. Bitbucket Cloud publishes
 * no such ref, so there the source branch is the way in.
 */
export async function fetchGitSource(repo: GitRepository, source: GitFetchSource, run: Runner = runGit, signal?: AbortSignal, hints: GitRemoteHints = {}): Promise<GitFetchResult> {
  const options = signal === undefined ? {} : { signal }
  const remotes = await listGitRemotes(repo, run, signal, hints)
  const remote = source.remote ?? (remotes.some((entry) => entry.name === "origin") ? "origin" : remotes.length === 1 ? remotes[0]?.name : undefined)
  const entry = remotes.find((candidate) => candidate.name === remote)
  if (remote === undefined || entry === undefined) throw new GitError("GIT_NOT_FOUND", "remote is not configured")
  if (source.branch !== undefined) {
    await fetchOneRef(repo, remote, `refs/heads/${source.branch}`, `refs/remotes/${remote}/${source.branch}`, run, signal)
  } else {
    if (entry.service === "bitbucket") throw new GitError("GIT_INVALID", "Bitbucket has no pull request refs; start from the pull request's source branch")
    const refs = entry.service === "github" ? ["pull"] : entry.service === "gitlab" ? ["merge-requests"] : ["pull", "merge-requests"]
    const target = `${GIT_PULL_NAMESPACE}/${remote}/${String(source.pullRequest)}`
    for (const [index, kind] of refs.entries()) {
      try {
        await fetchOneRef(repo, remote, `refs/${kind}/${String(source.pullRequest)}/head`, target, run, signal)
        break
      } catch (error) {
        if (!(error instanceof GitError) || error.code !== "GIT_NOT_FOUND" || index === refs.length - 1) throw error
      }
    }
  }
  const target = source.branch === undefined ? `${GIT_PULL_NAMESPACE}/${remote}/${String(source.pullRequest)}` : `refs/remotes/${remote}/${source.branch}`
  const resolved = await run({ cwd: repo.root, args: ["rev-parse", "--verify", "-q", `${target}^{commit}`], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...options })
  const commit = resolved.stdout.trim()
  if (resolved.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError("GIT_NOT_FOUND", "the remote has no such branch or pull request")
  return Object.freeze({
    remote,
    revision: target,
    commit,
    ...(source.branch === undefined ? { pullRequest: source.pullRequest } : { branch: source.branch }),
  })
}

/** Fetches `from` on `remote` into `target` and nothing else: no tags, submodules, or FETCH_HEAD. */
export async function fetchOneRef(repo: GitRepository, remote: string, from: string, target: string, run: Runner = runGit, signal?: AbortSignal): Promise<void> {
  const fetched = await run({
    cwd: repo.root,
    args: ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--quiet", "--", remote, `+${from}:${target}`],
    okExitCodes: [0, 1, 128],
    network: true,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    overflow: "truncate",
    ...(signal === undefined ? {} : { signal }),
  })
  if (fetched.exitCode !== 0) throw fetchError(fetched.stderr)
}

/** What git said, reduced to a fixed message; its own words can name hosts, paths, or users. */
function fetchError(stderr: string): GitError {
  if (/couldn't find remote ref|no such ref|not our ref|unknown revision/i.test(stderr)) return new GitError("GIT_NOT_FOUND", "the remote has no such branch or pull request")
  if (/authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|access denied|403|401/i.test(stderr))
    return new GitError("GIT_FORBIDDEN", "the remote refused the fetch; sign in to it with git first")
  return new GitError("GIT_FAILED", "git fetch failed; check the remote and its credentials")
}

/** Parses `git.fetch` params: a remote, and exactly one of a branch or a pull request number. */
export function parseFetchSource(params: Readonly<Record<string, unknown>>): GitFetchSource {
  const remote = parseRemoteName(params.remote)
  const branch = params.branch
  const pullRequest = params.pullRequest
  if ((branch === undefined) === (pullRequest === undefined)) throw new GitError("GIT_INVALID", "pass exactly one of branch or pullRequest")
  const base = remote === undefined ? {} : { remote }
  if (branch !== undefined) {
    if (typeof branch !== "string" || !isBranchName(branch)) throw new GitError("GIT_INVALID", "branch is invalid")
    return { ...base, branch }
  }
  if (typeof pullRequest !== "number" || !Number.isSafeInteger(pullRequest) || pullRequest < 1 || pullRequest > GIT_MAX_PULL_REQUEST)
    throw new GitError("GIT_INVALID", `pullRequest must be an integer from 1 to ${String(GIT_MAX_PULL_REQUEST)}`)
  return { ...base, pullRequest }
}

/**
 * Git's own branch-name rules (`git check-ref-format --branch`), so a branch such as `feat+x`
 * is listed and fetched. Nothing here can read as an option, a refspec separator, or a pattern.
 */
export function isBranchName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\0-\x20\x7f~^:?*[\\]/.test(value) && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/")
    && !value.endsWith(".") && !value.endsWith(".lock") && !value.includes("..") && !value.includes("//") && !value.includes("@{") && value !== "@" && !/(^|\/)\./.test(value)
}

function branchName(value: string): string | undefined {
  return isBranchName(value) ? value : undefined
}

function remoteNameOf(value: string): string | undefined {
  try {
    return parseRemoteName(value)
  } catch {
    return undefined
  }
}
