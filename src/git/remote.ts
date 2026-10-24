import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { GitError } from "./errors.ts"
import { protectedGitCommandLine, runGit, type GitRunOptions } from "./run.ts"
import type { GitRepository } from "./status.ts"

type Runner = (options: GitRunOptions) => ReturnType<typeof runGit>

const MAX_REMOTES = 64
const MAX_PREVIEW_COMMITS = 50
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/

export type GitService = "github" | "gitlab" | "bitbucket" | "unknown"
/** How the service was known: the host itself, the URL's shape, the host's name, a CI file, or the person's answer. */
export type GitServiceSource = "host" | "path" | "name" | "ci" | "user"

export const GIT_SERVICES: readonly GitService[] = Object.freeze(["github", "gitlab", "bitbucket", "unknown"])

export interface GitRemoteHints {
  /** The person's answers, by lowercase host (`git.corp.com`, or `git.corp.com:8443`). */
  readonly services?: ReadonlyMap<string, GitService>
}

export interface GitRemote {
  readonly name: string
  /** Fetch URL with any user info removed. */
  readonly url: string
  readonly host?: string
  /** Repository owner and name when the URL has the `host/owner/repo` shape. */
  readonly owner?: string
  readonly repo?: string
  /** The repository's full path, nested groups included (`group/sub/repo`). */
  readonly path?: string
  /** Set for every remote that is not a local path. */
  readonly service?: GitService
  readonly serviceFrom?: GitServiceSource
}

export interface GitPushTarget {
  readonly remote?: string
  readonly branch?: string
}

export interface GitPushCommit {
  readonly commit: string
  readonly shortCommit: string
  readonly summary: string
}

export interface GitPushPreview {
  readonly remote: string
  /** Where the push goes after pushurl and URL rewrites, credentials removed. */
  readonly pushUrls: readonly string[]
  readonly branch: string
  readonly localBranch: string
  readonly head: string
  /** Last known remote commit from the local tracking ref; no network request is made. */
  readonly remoteHead?: string
  readonly newBranch: boolean
  readonly setUpstream: boolean
  readonly ahead: number
  readonly commits: readonly GitPushCommit[]
  readonly commitsTruncated: boolean
  /** Opaque token binding this preview to the push; a push with a stale token is refused. */
  readonly confirmation: string
}

export interface GitPushResult {
  readonly remote: string
  readonly branch: string
  readonly commit: string
  readonly outcome: "pushed" | "created" | "up-to-date"
  readonly upstreamSet: boolean
}

export interface GitPushOptions extends GitPushTarget {
  readonly confirmation: string
  readonly runHooks: boolean
  readonly signal?: AbortSignal
}

/** Lists configured remotes with credentials stripped from their URLs, each with the service it is on. */
export async function listGitRemotes(repo: GitRepository, run: Runner = runGit, signal?: AbortSignal, hints: GitRemoteHints = {}): Promise<readonly GitRemote[]> {
  const remotes = (await readRemoteConfig(repo, undefined, run, signal)).remotes
  const ci = remotes.some((remote) => remote.service === "unknown") ? await ciService(repo.toplevel) : undefined
  return Object.freeze(remotes.map((remote) => withHints(remote, hints, ci)))
}

/** A remote as parsed, with the URL's port, which only service detection uses. */
type ParsedRemote = GitRemote & { readonly port?: number }

function withHints(remote: ParsedRemote, hints: GitRemoteHints, ci: GitService | undefined): GitRemote {
  const { port, ...shown } = remote
  if (shown.host === undefined) return Object.freeze(shown)
  const host = shown.host.toLowerCase()
  const answer = (port === undefined ? undefined : hints.services?.get(`${host}:${String(port)}`)) ?? hints.services?.get(host)
  if (answer !== undefined) return Object.freeze({ ...shown, service: answer, serviceFrom: "user" as const })
  if (remote.service === "unknown" && ci !== undefined) return Object.freeze({ ...shown, service: ci, serviceFrom: "ci" as const })
  return Object.freeze(shown)
}

/** The service a CI file points at, when exactly one kind is present at the work-tree root. */
async function ciService(toplevel: string): Promise<GitService | undefined> {
  const exists = async (path: string): Promise<boolean> => stat(join(toplevel, path)).then(() => true, () => false)
  const [github, gitlab, bitbucket] = await Promise.all([exists(".github/workflows"), exists(".gitlab-ci.yml"), exists("bitbucket-pipelines.yml")])
  const found = [github && "github", gitlab && "gitlab", bitbucket && "bitbucket"].filter((entry): entry is GitService => typeof entry === "string")
  return found.length === 1 ? found[0] : undefined
}

/** Reads every remote URL and, given `branch`, that branch's upstream in one `git config` call. */
async function readRemoteConfig(
  repo: GitRepository,
  branch: string | undefined,
  run: Runner,
  signal?: AbortSignal,
): Promise<{ readonly remotes: readonly ParsedRemote[]; readonly upstream?: { readonly remote: string; readonly branch: string } }> {
  const keys = branch === undefined ? "remote\\..*\\.url" : `remote\\..*\\.url|branch\\.${escapeRegExp(branch)}\\.(remote|merge)`
  const result = await run({
    cwd: repo.root,
    args: ["config", "-z", "--get-regexp", `^(${keys})$`],
    okExitCodes: [0, 1],
    maxOutputBytes: 256 * 1024,
    ...(signal === undefined ? {} : { signal }),
  })
  const remotes: ParsedRemote[] = []
  // `git config --get` semantics: the last value of a repeated key wins.
  let upstreamRemote = ""
  let mergeRef = ""
  for (const record of result.stdout.split("\0")) {
    const newline = record.indexOf("\n")
    if (newline < 0) continue
    const key = record.slice(0, newline)
    const value = record.slice(newline + 1)
    if (branch !== undefined && key === `branch.${branch}.remote`) upstreamRemote = value.trim()
    else if (branch !== undefined && key === `branch.${branch}.merge`) mergeRef = value.trim()
    else {
      const name = key.slice("remote.".length, -".url".length)
      if (remotes.length >= MAX_REMOTES || !REMOTE_NAME.test(name) || remotes.some((remote) => remote.name === name)) continue
      remotes.push(describeRemote(name, value))
    }
  }
  const sorted = Object.freeze(remotes.sort((left, right) => left.name.localeCompare(right.name)))
  if (!REMOTE_NAME.test(upstreamRemote) || !mergeRef.startsWith("refs/heads/")) return { remotes: sorted }
  const upstreamBranch = mergeRef.slice("refs/heads/".length)
  return BRANCH_NAME.test(upstreamBranch) ? { remotes: sorted, upstream: { remote: upstreamRemote, branch: upstreamBranch } } : { remotes: sorted }
}

/** Escapes a ref name for git's POSIX extended regular expressions. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Parses a remote URL into a redacted form, `host/owner/repo` when it has that shape, the full
 * repository path, and the service it is on as far as the URL alone tells. `listGitRemotes`
 * adds the person's answers and CI-file hints.
 */
export function describeRemote(name: string, rawUrl: string): ParsedRemote {
  const url = rawUrl.trim()
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/)([^\s]+)$/.exec(url)
  if (scp !== null && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    const host = scp[1] ?? ""
    const path = scp[2] ?? ""
    return Object.freeze({ name, url: `${host}:${path}`, host, ...repositoryOf(host, undefined, path) })
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") return Object.freeze({ name, url: "local" })
    parsed.username = ""
    parsed.password = ""
    parsed.search = ""
    parsed.hash = ""
    const port = parsed.port.length === 0 ? undefined : Number(parsed.port)
    return Object.freeze({ name, url: parsed.toString(), host: parsed.hostname, ...(port === undefined ? {} : { port }), ...repositoryOf(parsed.hostname, port, decodeURIComponent(parsed.pathname)) })
  } catch {
    return Object.freeze({ name, url: url.startsWith("/") || url.startsWith(".") ? "local" : "unknown" })
  }
}

const PATH_SEGMENT = /^~?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const KNOWN_HOSTS: ReadonlyMap<string, GitService> = new Map([["github.com", "github"], ["gitlab.com", "gitlab"], ["bitbucket.org", "bitbucket"]])

/** The service of github.com, gitlab.com, or bitbucket.org, which is certain; undefined for any other host. */
export function knownHostService(host: string): GitService | undefined {
  return KNOWN_HOSTS.get(host.toLowerCase())
}

function repositoryOf(host: string, port: number | undefined, rawPath: string): Pick<GitRemote, "owner" | "repo" | "path" | "service" | "serviceFrom"> {
  let parts = rawPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/")
  // Bitbucket Data Center serves HTTP clones under `/scm/<project>/<repo>`.
  const dataCenter = parts[0] === "scm" && parts.length === 3
  if (dataCenter) parts = parts.slice(1)
  const valid = parts.length >= 2 && parts.length <= 20 && parts.every((part) => PATH_SEGMENT.test(part))
  const path = valid ? parts.join("/") : undefined
  const pair = valid && parts.length === 2 && !dataCenter && parts.every((part) => !part.startsWith("~")) ? { owner: parts[0] ?? "", repo: parts[1] ?? "" } : {}
  const known = knownHostService(host)
  const service: { readonly service: GitService; readonly serviceFrom?: GitServiceSource } =
    known !== undefined ? { service: known, serviceFrom: "host" }
    : dataCenter || port === 7999 ? { service: "bitbucket", serviceFrom: "path" }
    : valid && parts.length >= 3 ? { service: "gitlab", serviceFrom: "path" }
    : /gitlab/i.test(host) ? { service: "gitlab", serviceFrom: "name" }
    : /github/i.test(host) ? { service: "github", serviceFrom: "name" }
    : /bitbucket/i.test(host) ? { service: "bitbucket", serviceFrom: "name" }
    : { service: "unknown" }
  return { ...pair, ...(path === undefined ? {} : { path }), ...service }
}

export function parseRemoteName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !REMOTE_NAME.test(value)) throw new GitError("GIT_INVALID", "remote is invalid")
  return value
}

export function parseBranchName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !BRANCH_NAME.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock") || value.endsWith("."))
    throw new GitError("GIT_INVALID", "branch is invalid")
  return value
}

/**
 * Describes what a push would send without touching the network. The returned `confirmation`
 * must be passed back to `pushGitBranch`; it changes when HEAD, the target, or the remote
 * tracking ref changes, so a user always confirms the exact commits that leave the machine.
 */
export async function previewGitPush(repo: GitRepository, target: GitPushTarget, run: Runner = runGit, signal?: AbortSignal): Promise<GitPushPreview> {
  const options = signal === undefined ? {} : { signal }
  const localBranch = await currentBranch(repo, run, options)
  const { remotes, upstream } = await readRemoteConfig(repo, localBranch, run, signal)
  const remote = target.remote ?? upstream?.remote ?? (remotes.some((entry) => entry.name === "origin") ? "origin" : remotes.length === 1 ? remotes[0]?.name : undefined)
  if (remote === undefined) throw new GitError("GIT_NOT_FOUND", "no remote is configured")
  if (!remotes.some((entry) => entry.name === remote)) throw new GitError("GIT_NOT_FOUND", "remote is not configured")
  const branch = target.branch ?? (upstream !== undefined && upstream.remote === remote ? upstream.branch : localBranch)
  await checkBranchName(repo, branch, run, options)
  const destinations = await pushDestinations(repo, remote, run, options)
  const [head, remoteHead] = await resolveRevisions(repo, ["HEAD", `refs/remotes/${remote}/${branch}`], run, options)
  if (head === undefined) throw new GitError("GIT_CONFLICT", "the branch has no commits to push")
  // The confirmed head, not HEAD, so the listed commits are exactly the ones the confirmation binds.
  const range = remoteHead === undefined ? [head, "--not", `--remotes=${remote}`] : [`${remoteHead}..${head}`]
  // One record past the shown limit says whether the list is complete; only longer pushes pay for a count.
  const log = await run({
    cwd: repo.root,
    args: ["log", "-z", `--max-count=${MAX_PREVIEW_COMMITS + 1}`, "--format=%H%x1f%h%x1f%s", ...range, "--"],
    maxOutputBytes: 512 * 1024,
    overflow: "truncate",
    ...options,
  })
  const records = log.stdout.split("\0")
  if (log.truncated) records.pop()
  const commits: GitPushCommit[] = []
  for (const record of records) {
    const [commit, shortCommit, summary] = record.replace(/^\n/, "").split("\x1f")
    if (commit === undefined || shortCommit === undefined || summary === undefined || commit.length === 0) continue
    commits.push(Object.freeze({ commit, shortCommit, summary: summary.slice(0, 512) }))
  }
  const complete = !log.truncated && commits.length <= MAX_PREVIEW_COMMITS
  let ahead = commits.length
  if (!complete) {
    const count = await run({ cwd: repo.root, args: ["rev-list", "--count", ...range, "--"], maxOutputBytes: 1_024, ...options })
    const counted = Number.parseInt(count.stdout.trim(), 10)
    if (Number.isSafeInteger(counted)) ahead = counted
  }
  const setUpstream = upstream === undefined || upstream.remote !== remote || upstream.branch !== branch
  const confirmation = createHash("sha256")
    .update(JSON.stringify([repo.toplevel, remote, destinations, branch, localBranch, head, remoteHead ?? "", setUpstream]))
    .digest("hex")
    .slice(0, 32)
  return Object.freeze({
    remote,
    pushUrls: Object.freeze(destinations.map((url) => describeRemote(remote, url).url)),
    branch,
    localBranch,
    head,
    ...(remoteHead === undefined ? {} : { remoteHead }),
    newBranch: remoteHead === undefined,
    setUpstream,
    ahead,
    commits: Object.freeze(commits.slice(0, MAX_PREVIEW_COMMITS)),
    commitsTruncated: !complete,
    confirmation,
  })
}

/** The URLs a push to `remote` reaches, as git resolves them: every pushurl, else the url, after insteadOf rewrites. */
async function pushDestinations(repo: GitRepository, remote: string, run: Runner, options: { readonly signal?: AbortSignal }): Promise<readonly string[]> {
  const result = await run({ cwd: repo.root, args: ["remote", "get-url", "--push", "--all", remote], maxOutputBytes: 64 * 1024, ...options })
  const urls = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  if (urls.length === 0) throw new GitError("GIT_NOT_FOUND", "remote has no push destination")
  return urls
}

/**
 * `--receive-pack` for a push to a repository on this computer, whose receive-pack git starts
 * without the `-c` settings that keep that repository's hooks and programs from running.
 */
async function localReceivePack(repo: GitRepository, destinations: readonly string[], runHooks: boolean): Promise<readonly string[]> {
  const local = destinations.map((url) => localRemotePath(repo.root, url))
  const path = local[0]
  if (local.every((entry) => entry === undefined)) return []
  // One receive-pack serves every destination, and a remote machine's must not carry this one's settings.
  if (local.length > 1 || path === undefined) throw new GitError("GIT_INVALID", "a remote that pushes to a folder on this computer must push only there")
  return [`--receive-pack=${await protectedGitCommandLine("receive-pack", runHooks, await receivingGitDir(path))}`]
}

/** The folder a remote URL names when git reaches it as a local path (git's `url_is_local_not_ssh`). */
function localRemotePath(root: string, url: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return undefined
  if (/^file:\/\//i.test(url)) {
    try {
      return fileURLToPath(url)
    } catch {
      throw new GitError("GIT_INVALID", "the remote's file address is not on this computer")
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return undefined
  const colon = url.indexOf(":")
  const slash = url.indexOf("/")
  if (colon >= 0 && (slash < 0 || colon < slash)) return undefined
  if (url === "~" || url.startsWith("~/")) return join(homedir(), url.slice(2))
  if (url.startsWith("~")) throw new GitError("GIT_INVALID", "a remote in another user's home folder is not pushed to")
  return resolve(root, url)
}

/** The git directory receive-pack enters for `path`, tried in git's own order (`enter_repo`). */
async function receivingGitDir(path: string): Promise<string | undefined> {
  for (const suffix of ["/.git", "", ".git/.git", ".git"]) {
    const candidate = `${path}${suffix}`
    const found = await stat(candidate).catch(() => undefined)
    if (found?.isFile() === true) return candidate
    if (found?.isDirectory() === true && await stat(join(candidate, "HEAD")).then(() => true, () => false)) return candidate
  }
  return undefined
}

/** Last known commit of `<remote>/<branch>` from the local tracking ref, without a fetch. */
export async function readRemoteBranch(repo: GitRepository, remote: string, branch: string, run: Runner = runGit, signal?: AbortSignal): Promise<string | undefined> {
  parseRemoteName(remote)
  parseBranchName(branch)
  const result = await run({ cwd: repo.root, args: ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}`], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...(signal === undefined ? {} : { signal }) })
  const commit = result.stdout.trim()
  return result.exitCode === 0 && commit.length > 0 ? commit : undefined
}

/** Pushes the current branch after re-checking the confirmed preview. Never forces. */
export async function pushGitBranch(repo: GitRepository, options: GitPushOptions, run: Runner = runGit): Promise<GitPushResult> {
  const preview = await previewGitPush(repo, options, run, options.signal)
  if (preview.confirmation !== options.confirmation) throw new GitError("GIT_CONFLICT", "push preview is stale; preview the push again")
  if (!preview.newBranch && preview.ahead === 0 && !preview.setUpstream)
    return Object.freeze({ remote: preview.remote, branch: preview.branch, commit: preview.head, outcome: "up-to-date", upstreamSet: false })
  const destinations = await pushDestinations(repo, preview.remote, run, options.signal === undefined ? {} : { signal: options.signal })
  const receivePack = await localReceivePack(repo, destinations, options.runHooks)
  let result: Awaited<ReturnType<Runner>>
  try {
    result = await run({
      cwd: repo.root,
      args: [
        "push",
        "--porcelain",
        // A submodule's own config would run its programs; this push sends one commit and nothing else.
        "--no-recurse-submodules",
        ...receivePack,
        "--",
        preview.remote,
        // The confirmed commit, not the branch: a commit made since the preview is never published.
        `${preview.head}:refs/heads/${preview.branch}`,
      ],
      okExitCodes: [0, 1],
      runHooks: options.runHooks,
      network: true,
      timeoutMs: 180_000,
      maxOutputBytes: 64 * 1024,
      overflow: "truncate",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    if (error instanceof GitError && error.code === "GIT_FAILED") throw new GitError("GIT_FAILED", "git push failed; check the remote and its credentials")
    throw error
  }
  const flag = porcelainFlag(result.stdout, preview.branch)
  if (flag === "!" || (result.exitCode !== 0 && flag === undefined)) throw new GitError("GIT_CONFLICT", "the remote rejected the push; pull or rebase first")
  if (result.exitCode !== 0) throw new GitError("GIT_FAILED", "git push failed; check the remote and its credentials")
  // `--set-upstream` needs a branch as the source, so the upstream is set once the commit is there.
  const upstreamSet = preview.setUpstream && (await run({
    cwd: repo.root,
    args: ["branch", `--set-upstream-to=${preview.remote}/${preview.branch}`, "--", preview.localBranch],
    okExitCodes: [0, 1, 128],
    maxOutputBytes: 4_096,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })).exitCode === 0
  return Object.freeze({
    remote: preview.remote,
    branch: preview.branch,
    commit: preview.head,
    outcome: flag === "*" ? "created" : flag === "=" ? "up-to-date" : "pushed",
    upstreamSet,
  })
}

/** Reads the `<flag>\t<from>:<to>\t<summary>` line for the pushed ref. */
function porcelainFlag(stdout: string, branch: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const [head, refs] = line.split("\t")
    if (head === undefined || refs === undefined || head.length !== 1) continue
    if (refs.endsWith(`:refs/heads/${branch}`)) return head
  }
  return undefined
}

async function currentBranch(repo: GitRepository, run: Runner, options: { readonly signal?: AbortSignal }): Promise<string> {
  // The full name: `--short` prints `heads/main` when a tag `main` also exists.
  const result = await run({ cwd: repo.root, args: ["symbolic-ref", "-q", "HEAD"], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...options })
  const ref = result.stdout.trim()
  if (result.exitCode !== 0 || !ref.startsWith("refs/heads/") || ref.length === "refs/heads/".length)
    throw new GitError("GIT_CONFLICT", "check out a branch before pushing")
  return ref.slice("refs/heads/".length)
}

/** Resolves revisions in one `git cat-file` call; a missing one comes back undefined. */
async function resolveRevisions(repo: GitRepository, revisions: readonly string[], run: Runner, options: { readonly signal?: AbortSignal }): Promise<(string | undefined)[]> {
  const result = await run({
    cwd: repo.root,
    args: ["cat-file", "--batch-check=%(objectname)"],
    stdin: new TextEncoder().encode(revisions.map((revision) => `${revision}\n`).join("")),
    maxOutputBytes: 16 * 1024,
    ...options,
  })
  const lines = result.stdout.split("\n")
  return revisions.map((_, index) => {
    const line = lines[index] ?? ""
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line) ? line : undefined
  })
}

async function checkBranchName(repo: GitRepository, branch: string, run: Runner, options: { readonly signal?: AbortSignal }): Promise<void> {
  parseBranchName(branch)
  const check = await run({ cwd: repo.root, args: ["check-ref-format", `refs/heads/${branch}`], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...options })
  if (check.exitCode !== 0) throw new GitError("GIT_INVALID", "branch is invalid")
}
