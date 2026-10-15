import { checksOf, GitHubCliError, runGitHubCli, type PullRequestChecks } from "./github-cli.ts"

/**
 * The person's pull requests across every repository, for the Reviews inbox, through their own
 * `gh` sign-in. Read only. Search groups follow GitHub's qualifiers: `user-review-requested:@me`
 * is a direct request, and `review-requested:@me` adds requests to the person's teams.
 */

export type ReviewGroup = "review-requested" | "authored" | "team"

export const REVIEW_SEARCH_MAX = 50
export const REVIEW_QUERY_MAX_CHARS = 200
const MAX_BODY_CHARS = 20_000
const MAX_FILES = 100
export const PULL_REQUEST_DIFF_MAX_BYTES = 2 * 1024 * 1024
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/

export interface GitHubCliTarget {
  readonly command: string
  readonly cwd: string
  /** Set for GitHub Enterprise; github.com is the default. */
  readonly host?: string
  readonly signal?: AbortSignal
}

export interface ReviewTeam {
  readonly org: string
  readonly slug: string
  readonly name?: string
}

export type ChecksState = "passed" | "failed" | "pending" | "none"
export type ReviewDecision = "approved" | "changes-requested" | "required" | "none"

export interface ReviewInboxEntry {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly url?: string
  readonly title?: string
  readonly author?: string
  readonly updatedAt?: number
  readonly draft: boolean
  readonly review: ReviewDecision
  readonly checks: ChecksState
}

export interface ReviewSearchResult {
  readonly total: number
  readonly pullRequests: readonly ReviewInboxEntry[]
}

export interface PullRequestFile {
  readonly path: string
  readonly additions: number
  readonly deletions: number
  readonly change: "added" | "deleted" | "modified" | "renamed" | "copied" | "changed"
}

export interface PullRequestReview {
  readonly author?: string
  readonly state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending"
  readonly submittedAt?: number
}

export type PullRequestRequest = { readonly kind: "user"; readonly login: string } | { readonly kind: "team"; readonly org: string; readonly slug: string }

export interface PullRequestDetail {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly url?: string
  readonly title?: string
  readonly body: string
  readonly bodyTruncated: boolean
  readonly state: "open" | "closed" | "merged"
  readonly draft: boolean
  readonly author?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly base?: string
  readonly head?: string
  readonly headCommit?: string
  /** `owner/repo` of the head when it lives in a fork. */
  readonly headRepository?: string
  readonly crossRepository: boolean
  readonly mergeable: "yes" | "conflicts" | "unknown"
  /** GitHub's merge state, lower case: clean, blocked, behind, dirty, draft, unstable, has-hooks, unknown. */
  readonly mergeState: string
  readonly review: ReviewDecision
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly files: readonly PullRequestFile[]
  readonly filesTruncated: boolean
  readonly reviews: readonly PullRequestReview[]
  readonly requested: readonly PullRequestRequest[]
  readonly checks: PullRequestChecks
  readonly checksState: ChecksState
  readonly mergeMethods: readonly ("merge" | "squash" | "rebase")[]
  /** The person's permission on the repository: admin, maintain, write, triage, read. */
  readonly permission?: string
}

export interface PullRequestDiff {
  readonly diff: string
  readonly truncated: boolean
  /** With `path`: whether that file is in the part of the diff that was read. */
  readonly found?: boolean
}

const SEARCH_QUERY = `query($q: String!, $n: Int!) {
  search(query: $q, type: ISSUE, first: $n) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt
        author { login }
        repository { name owner { login } }
        reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

const VIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerPermission
    pullRequest(number: $number) {
      number title url body state isDraft createdAt updatedAt
      author { login }
      baseRefName headRefName headRefOid isCrossRepository
      headRepository { nameWithOwner }
      mergeable mergeStateStatus reviewDecision
      additions deletions changedFiles
      files(first: ${String(MAX_FILES)}) { totalCount nodes { path additions deletions changeType } }
      latestOpinionatedReviews(first: 20) { nodes { author { login } state submittedAt } }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state targetUrl } } } } } } }
    }
  }
}`

/** The search string for an inbox group; `text` narrows it with the person's own words. */
export function reviewSearchQuery(group: ReviewGroup, options: { readonly team?: ReviewTeam; readonly text?: string } = {}): string {
  const who = group === "authored" ? "author:@me"
    : group === "review-requested" ? "user-review-requested:@me"
    : options.team !== undefined ? `team-review-requested:${options.team.org}/${options.team.slug}`
    : "review-requested:@me -user-review-requested:@me"
  const words = options.text?.trim() ?? ""
  return ["is:pr", "is:open", "archived:false", who, ...(words.length === 0 ? [] : [words]), "sort:updated-desc"].join(" ")
}

export async function searchPullRequestsWithCli(target: GitHubCliTarget & { readonly group: ReviewGroup; readonly team?: ReviewTeam; readonly text?: string; readonly limit: number }): Promise<ReviewSearchResult> {
  const query = reviewSearchQuery(target.group, { ...(target.team === undefined ? {} : { team: target.team }), ...(target.text === undefined ? {} : { text: target.text }) })
  const output = await gh(target, ["api", "graphql", ...hostname(target), "-f", `query=${SEARCH_QUERY}`, "-f", `q=${query}`, "-F", `n=${String(target.limit)}`])
  return parseSearch(json(output), target.limit)
}

export async function listTeamsWithCli(target: GitHubCliTarget): Promise<readonly ReviewTeam[]> {
  return parseTeams(json(await gh(target, ["api", "user/teams?per_page=100", ...hostname(target)])))
}

export async function viewPullRequestWithCli(target: GitHubCliTarget & { readonly owner: string; readonly repo: string; readonly number: number }): Promise<PullRequestDetail> {
  const output = await gh(target, ["api", "graphql", ...hostname(target), "-f", `query=${VIEW_QUERY}`, "-f", `owner=${target.owner}`, "-f", `name=${target.repo}`, "-F", `number=${String(target.number)}`])
  const detail = parseDetail(json(output), target.owner, target.repo)
  if (detail === undefined) throw new GitHubCliError("not-found")
  return detail
}

export async function pullRequestDiffWithCli(target: GitHubCliTarget & { readonly owner: string; readonly repo: string; readonly number: number; readonly path?: string }): Promise<PullRequestDiff> {
  const repository = target.host === undefined || target.host === "github.com" ? `${target.owner}/${target.repo}` : `${target.host}/${target.owner}/${target.repo}`
  const { text: diff, truncated } = await runGitHubCli(target, ["pr", "diff", String(target.number), "--repo", repository, "--color", "never"], { maxOutput: PULL_REQUEST_DIFF_MAX_BYTES, truncate: true, notFound: true })
  if (target.path === undefined) return { diff, truncated }
  const section = diffSection(diff, target.path)
  return { diff: section ?? "", truncated, found: section !== undefined }
}

/** One file's part of a unified diff, from its `diff --git` line to the next. */
export function diffSection(diff: string, path: string): string | undefined {
  return diff.split(/^(?=diff --git )/m).find((part) => {
    const header = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(part)
    return header !== null && (header[1] === path || header[2] === path)
  })
}

export function parseSearch(value: unknown, limit: number): ReviewSearchResult {
  const search = record(record(record(value)?.data)?.search)
  const nodes = search?.nodes
  if (!Array.isArray(nodes)) throw new GitHubCliError("failed")
  const pullRequests = nodes.slice(0, limit).map(inboxEntry).filter((entry) => entry !== undefined)
  const total = search?.issueCount
  return Object.freeze({ total: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : pullRequests.length, pullRequests: Object.freeze(pullRequests) })
}

export function parseTeams(value: unknown): readonly ReviewTeam[] {
  if (!Array.isArray(value)) throw new GitHubCliError("failed")
  const teams: ReviewTeam[] = []
  for (const item of value.slice(0, 100)) {
    const team = record(item)
    const org = record(team?.organization)?.login
    const slug = team?.slug
    if (typeof org !== "string" || !SEGMENT.test(org) || typeof slug !== "string" || !SEGMENT.test(slug)) continue
    const name = text(team?.name, 120)
    teams.push(Object.freeze({ org, slug, ...(name === undefined ? {} : { name }) }))
  }
  return Object.freeze(teams)
}

export function parseDetail(value: unknown, owner: string, repo: string): PullRequestDetail | undefined {
  const repository = record(record(record(value)?.data)?.repository)
  const pr = record(repository?.pullRequest)
  if (repository === undefined || pr === undefined || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number < 1) return undefined
  const body = typeof pr.body === "string" ? pr.body : ""
  const files = record(pr.files)
  const fileNodes = Array.isArray(files?.nodes) ? files.nodes : []
  const fileTotal = typeof files?.totalCount === "number" ? files.totalCount : fileNodes.length
  const rollup = record(record(record(lastNode(record(pr.commits)?.nodes))?.commit)?.statusCheckRollup)
  const contexts = record(rollup?.contexts)?.nodes
  const forkName = record(pr.headRepository)?.nameWithOwner
  const methods: ("merge" | "squash" | "rebase")[] = []
  if (repository.mergeCommitAllowed === true) methods.push("merge")
  if (repository.squashMergeAllowed === true) methods.push("squash")
  if (repository.rebaseMergeAllowed === true) methods.push("rebase")
  const title = text(pr.title, 256)
  const url = httpsUrl(pr.url)
  const author = login(record(pr.author)?.login)
  const createdAt = time(pr.createdAt)
  const updatedAt = time(pr.updatedAt)
  const base = branch(pr.baseRefName)
  const head = branch(pr.headRefName)
  const headCommit = typeof pr.headRefOid === "string" && /^[0-9a-f]{40}$/.test(pr.headRefOid) ? pr.headRefOid : undefined
  const headRepository = pr.isCrossRepository === true && typeof forkName === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(forkName) ? forkName : undefined
  const permission = typeof repository.viewerPermission === "string" && /^[A-Z]{1,20}$/.test(repository.viewerPermission) ? repository.viewerPermission.toLowerCase() : undefined
  return Object.freeze({
    owner,
    repo,
    number: pr.number,
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    body: body.slice(0, MAX_BODY_CHARS),
    bodyTruncated: body.length > MAX_BODY_CHARS,
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    draft: pr.isDraft === true,
    ...(author === undefined ? {} : { author }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(base === undefined ? {} : { base }),
    ...(head === undefined ? {} : { head }),
    ...(headCommit === undefined ? {} : { headCommit }),
    ...(headRepository === undefined ? {} : { headRepository }),
    crossRepository: pr.isCrossRepository === true,
    mergeable: pr.mergeable === "MERGEABLE" ? "yes" : pr.mergeable === "CONFLICTING" ? "conflicts" : "unknown",
    mergeState: typeof pr.mergeStateStatus === "string" && /^[A-Z_]{1,30}$/.test(pr.mergeStateStatus) ? pr.mergeStateStatus.toLowerCase().replace(/_/g, "-") : "unknown",
    review: decision(pr.reviewDecision),
    additions: count(pr.additions),
    deletions: count(pr.deletions),
    changedFiles: count(pr.changedFiles),
    files: Object.freeze(fileNodes.slice(0, MAX_FILES).map(fileOf).filter((file) => file !== undefined)),
    filesTruncated: fileTotal > Math.min(fileNodes.length, MAX_FILES),
    reviews: Object.freeze(nodesOf(pr.latestOpinionatedReviews).slice(0, 20).map(reviewOf).filter((review) => review !== undefined)),
    requested: Object.freeze(nodesOf(pr.reviewRequests).slice(0, 20).map(requestOf).filter((request) => request !== undefined)),
    checks: checksOf(Array.isArray(contexts) ? contexts : []),
    checksState: checksState(rollup?.state),
    mergeMethods: Object.freeze(methods),
    ...(permission === undefined ? {} : { permission }),
  })
}

function inboxEntry(value: unknown): ReviewInboxEntry | undefined {
  const node = record(value)
  const repository = record(node?.repository)
  const owner = record(repository?.owner)?.login
  const repo = repository?.name
  if (node === undefined || typeof node.number !== "number" || !Number.isSafeInteger(node.number) || node.number < 1) return undefined
  if (typeof owner !== "string" || !SEGMENT.test(owner) || typeof repo !== "string" || !SEGMENT.test(repo)) return undefined
  const url = httpsUrl(node.url)
  const title = text(node.title, 256)
  const author = login(record(node.author)?.login)
  const updatedAt = time(node.updatedAt)
  const rollup = record(record(record(lastNode(record(node.commits)?.nodes))?.commit)?.statusCheckRollup)
  return Object.freeze({
    owner,
    repo,
    number: node.number,
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    draft: node.isDraft === true,
    review: decision(node.reviewDecision),
    checks: checksState(rollup?.state),
  })
}

function fileOf(value: unknown): PullRequestFile | undefined {
  const file = record(value)
  const path = file?.path
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.includes("\0")) return undefined
  const change = typeof file?.changeType === "string" ? file.changeType.toLowerCase() : ""
  return Object.freeze({
    path,
    additions: count(file?.additions),
    deletions: count(file?.deletions),
    change: (["added", "deleted", "modified", "renamed", "copied"] as const).find((kind) => kind === change) ?? "changed",
  })
}

const REVIEW_STATES: Readonly<Record<string, PullRequestReview["state"]>> = { APPROVED: "approved", CHANGES_REQUESTED: "changes-requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" }

function reviewOf(value: unknown): PullRequestReview | undefined {
  const review = record(value)
  const state = typeof review?.state === "string" ? REVIEW_STATES[review.state] : undefined
  if (state === undefined) return undefined
  const author = login(record(review?.author)?.login)
  const submittedAt = time(review?.submittedAt)
  return Object.freeze({ ...(author === undefined ? {} : { author }), state, ...(submittedAt === undefined ? {} : { submittedAt }) })
}

function requestOf(value: unknown): PullRequestRequest | undefined {
  const reviewer = record(record(value)?.requestedReviewer)
  if (reviewer?.__typename === "User") {
    const name = login(reviewer.login)
    return name === undefined ? undefined : Object.freeze({ kind: "user", login: name })
  }
  if (reviewer?.__typename !== "Team") return undefined
  const org = record(reviewer.organization)?.login
  const slug = reviewer.slug
  return typeof org === "string" && SEGMENT.test(org) && typeof slug === "string" && SEGMENT.test(slug) ? Object.freeze({ kind: "team", org, slug }) : undefined
}

function checksState(value: unknown): ChecksState {
  if (value === "SUCCESS") return "passed"
  if (value === "FAILURE" || value === "ERROR") return "failed"
  if (value === "PENDING" || value === "EXPECTED") return "pending"
  return "none"
}

function decision(value: unknown): ReviewDecision {
  if (value === "APPROVED") return "approved"
  if (value === "CHANGES_REQUESTED") return "changes-requested"
  if (value === "REVIEW_REQUIRED") return "required"
  return "none"
}

async function gh(target: GitHubCliTarget, args: readonly string[]): Promise<string> {
  return (await runGitHubCli(target, args, { notFound: true })).text
}

function hostname(target: GitHubCliTarget): readonly string[] {
  return target.host === undefined || target.host === "github.com" ? [] : ["--hostname", target.host]
}

function json(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new GitHubCliError("failed")
  }
}

function nodesOf(connection: unknown): readonly unknown[] {
  const nodes = record(connection)?.nodes
  return Array.isArray(nodes) ? nodes : []
}

function lastNode(nodes: unknown): unknown {
  return Array.isArray(nodes) ? nodes[nodes.length - 1] : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined
}

function login(value: unknown): string | undefined {
  return typeof value === "string" && LOGIN.test(value) ? value : undefined
}

function branch(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/[^\s]{1,2040}$/.test(value) ? value : undefined
}

function time(value: unknown): number | undefined {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? at : undefined
}

export interface ReviewComment {
  readonly path: string
  readonly line: number
  readonly side: "RIGHT" | "LEFT"
  readonly body: string
}

/**
 * One GitHub review, always the "comment" kind: it neither approves nor blocks. The payload goes to
 * gh on stdin. Returns the review's id and link.
 */
export async function postReviewWithCli(target: GitHubCliTarget & { readonly owner: string; readonly repo: string; readonly number: number; readonly commit: string; readonly body: string; readonly comments: readonly ReviewComment[] }): Promise<{ readonly id: number; readonly url?: string; readonly comments: number }> {
  const payload = { commit_id: target.commit, body: target.body, event: "COMMENT", comments: target.comments.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body })) }
  const { text: output } = await runGitHubCli(target, ["api", `repos/${target.owner}/${target.repo}/pulls/${String(target.number)}/reviews`, ...hostname(target), "--method", "POST", "--input", "-"], { stdin: new TextEncoder().encode(JSON.stringify(payload)), notFound: true })
  const review = record(json(output))
  const id = review?.id
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new GitHubCliError("failed")
  const url = httpsUrl(review?.html_url)
  return Object.freeze({ id, ...(url === undefined ? {} : { url }), comments: target.comments.length })
}

/**
 * Merges with `--match-head-commit`, so a push after the person looked makes GitHub refuse it.
 * With `auto`, GitHub merges once the required checks pass. The commit body goes
 * to gh on stdin.
 */
export async function mergePullRequestWithCli(target: GitHubCliTarget & { readonly owner: string; readonly repo: string; readonly number: number; readonly method: "merge" | "squash" | "rebase"; readonly headCommit: string; readonly subject?: string; readonly body?: string; readonly deleteBranch: boolean; readonly auto?: boolean }): Promise<void> {
  const repository = target.host === undefined || target.host === "github.com" ? `${target.owner}/${target.repo}` : `${target.host}/${target.owner}/${target.repo}`
  const args = [
    "pr", "merge", String(target.number), "--repo", repository, `--${target.method}`, "--match-head-commit", target.headCommit,
    ...(target.auto === true ? ["--auto"] : []),
    ...(target.subject === undefined ? [] : ["--subject", target.subject]),
    ...(target.body === undefined ? [] : ["--body-file", "-"]),
    ...(target.deleteBranch ? ["--delete-branch"] : []),
  ]
  await runGitHubCli(target, args, { ...(target.body === undefined ? {} : { stdin: new TextEncoder().encode(target.body) }), notFound: true })
}

const MAX_FAILED_JOBS = 4
const JOB_LOG_READ_BYTES = 2 * 1024 * 1024
export const JOB_LOG_CHARS = 12_000
const ACTIONS_JOB = /\/actions\/runs\/(\d{1,20})\/job\/(\d{1,20})(?:[/?#]|$)/
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/

export interface FailedCheck {
  readonly name: string
  readonly url?: string
  /** The end of what the failed steps printed, GitHub Actions jobs only. */
  readonly log?: string
  /** The log was longer and only its end is here. */
  readonly cut?: boolean
}

export interface FailedChecks {
  readonly number: number
  readonly headCommit?: string
  /** Every failing check; `checks` holds the first few. */
  readonly failed: number
  readonly checks: readonly FailedCheck[]
}

/**
 * `gh run view --log-failed` prints `job<TAB>step<TAB>time text`; this keeps the step as a heading
 * and the text, without colors or times, and the last `JOB_LOG_CHARS` of it, from a line start.
 */
export function failedStepLog(raw: string, max = JOB_LOG_CHARS): { readonly log: string; readonly cut: boolean } {
  const out: string[] = []
  let step: string | undefined
  for (const line of raw.replace(ANSI, "").split(/\r?\n/)) {
    const parts = line.split("\t")
    const text = (parts.length >= 3 ? parts.slice(2).join("\t") : line).replace(STAMP, "")
    if (parts.length >= 3 && parts[1] !== step) {
      step = parts[1]
      out.push(`## ${step ?? ""}`)
    }
    out.push(text)
  }
  const log = out.join("\n").trim()
  if (log.length <= max) return { log, cut: false }
  const tail = log.slice(-max)
  const start = tail.indexOf("\n")
  return { log: start < 0 ? tail : tail.slice(start + 1), cut: true }
}

/** What failed on the pull request's head, with the end of each GitHub Actions job's failed steps. */
export async function failedChecksWithCli(target: GitHubCliTarget & { readonly owner: string; readonly repo: string; readonly number: number }): Promise<FailedChecks> {
  const detail = await viewPullRequestWithCli(target)
  const failed = detail.checks.items.filter((item) => item.state === "failed")
  const repository = target.host === undefined || target.host === "github.com" ? `${target.owner}/${target.repo}` : `${target.host}/${target.owner}/${target.repo}`
  const checks: FailedCheck[] = []
  for (const item of failed.slice(0, MAX_FAILED_JOBS)) {
    const job = item.url === undefined ? null : ACTIONS_JOB.exec(item.url)
    const base = { name: item.name, ...(item.url === undefined ? {} : { url: item.url }) }
    if (job === null) {
      checks.push(Object.freeze(base))
      continue
    }
    try {
      const { text, truncated } = await runGitHubCli(target, ["run", "view", "--job", job[2] as string, "--log-failed", "--repo", repository], { maxOutput: JOB_LOG_READ_BYTES, truncate: true, tail: true, notFound: true })
      const { log, cut } = failedStepLog(text)
      checks.push(Object.freeze({ ...base, ...(log.length === 0 ? {} : { log }), ...(cut || truncated ? { cut: true } : {}) }))
    } catch {
      // Logs GitHub no longer keeps, or a run the person cannot read: the check is still named.
      checks.push(Object.freeze(base))
    }
  }
  return Object.freeze({ number: target.number, ...(detail.headCommit === undefined ? {} : { headCommit: detail.headCommit }), failed: failed.length, checks: Object.freeze(checks) })
}
