import { filteredEnvironment } from "../workspace/policy.ts"
import { writeChildInput } from "./run.ts"

/**
 * Pull requests through the person's own `gh` sign-in, used only for a host they connected.
 * Runrail never reads gh's token: gh finds it in its own config or the keychain. Token variables
 * are not forwarded, so a sign-in kept only in GH_TOKEN reads as no sign-in. gh's own words can
 * name the account or host, so only the kind of failure leaves this module.
 */

export const GITHUB_CLI_MAX_PULL_REQUESTS = 100
const TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const MAX_CHECK_ITEMS = 20
const MAX_ROLLUP_ENTRIES = 500
const FORWARDED = [
  "GH_CONFIG_DIR", "XDG_CONFIG_HOME",
  "SSH_AUTH_SOCK",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY",
  "https_proxy", "http_proxy", "no_proxy", "all_proxy",
] as const
const STATUS_FIELDS = "number,url,title,state,isDraft,reviewDecision,mergeable,baseRefName,headRefName,headRepositoryOwner,author,mergedAt,closedAt,updatedAt,statusCheckRollup,headRefOid"

export type GitHubCliFailure = "unavailable" | "credentials" | "scope" | "not-found" | "rate-limited" | "timeout" | "failed"

export class GitHubCliError extends Error {
  constructor(readonly failure: GitHubCliFailure) {
    super(`gh ${failure}`)
    this.name = "GitHubCliError"
  }
}

export interface PullRequestChecks {
  readonly passed: number
  readonly failed: number
  readonly pending: number
  readonly skipped: number
  /** Failing first, at most 20. */
  readonly items: readonly { readonly name: string; readonly state: "passed" | "failed" | "pending" | "skipped"; readonly url?: string }[]
}

export interface PullRequestEntry {
  readonly number: number
  readonly url?: string
  readonly state: "open" | "closed" | "merged"
  readonly draft: boolean
  readonly merged: boolean
  readonly title?: string
  readonly head?: string
  /** The head branch's commit, read from gh only. */
  readonly headCommit?: string
  readonly base?: string
  readonly author?: string
  /** Milliseconds since the epoch. */
  readonly updatedAt?: number
  readonly mergedAt?: number
  readonly closedAt?: number
  readonly review?: "approved" | "changes-requested" | "required" | "none"
  readonly mergeable?: "yes" | "conflicts" | "unknown"
  readonly checks?: PullRequestChecks
}

export interface GitHubRepositoryTarget {
  readonly command: string
  readonly cwd: string
  readonly owner: string
  readonly repo: string
  /** Set for GitHub Enterprise; github.com is the default. */
  readonly host?: string
  readonly signal?: AbortSignal
}

export async function listPullRequestsWithCli(options: GitHubRepositoryTarget & { readonly limit: number }): Promise<readonly PullRequestEntry[]> {
  const output = await runGh(options, ["pr", "list", "--repo", repository(options), "--state", "open", "--limit", String(options.limit), "--json", "number,title,headRefName,baseRefName,author,isDraft,updatedAt,url"])
  return Object.freeze(parseArray(output).slice(0, options.limit).map(fromCli).filter((entry) => entry !== undefined))
}

/**
 * The pull requests whose head is `head`, newest first, with review, merge, and check state.
 * `gh pr list --head` cannot name the head's owner, so entries from another owner's fork of the
 * same branch name are dropped by `headOwner`.
 */
export async function pullRequestsForBranchWithCli(options: GitHubRepositoryTarget & { readonly head: string; readonly headOwner?: string; readonly state?: "open" | "closed" | "all"; readonly limit: number }): Promise<readonly PullRequestEntry[]> {
  const output = await runGh(options, ["pr", "list", "--repo", repository(options), "--head", options.head, "--state", options.state ?? "all", "--limit", String(options.limit), "--json", STATUS_FIELDS])
  const owner = options.headOwner?.toLowerCase()
  return Object.freeze(
    parseArray(output)
      .slice(0, options.limit)
      .filter((value) => owner === undefined || (isRecord(value) && isRecord(value.headRepositoryOwner) && typeof value.headRepositoryOwner.login === "string" && value.headRepositoryOwner.login.toLowerCase() === owner))
      .map(fromCli)
      .filter((entry) => entry !== undefined),
  )
}

/** Opens a pull request; the body goes to gh on stdin, never in argv. Returns its number and URL. */
export async function createPullRequestWithCli(options: GitHubRepositoryTarget & { readonly head: string; readonly headOwner: string; readonly base: string; readonly title: string; readonly body?: string; readonly draft?: boolean }): Promise<{ readonly number: number; readonly url: string }> {
  const args = ["pr", "create", "--repo", repository(options), "--head", `${options.headOwner}:${options.head}`, "--base", options.base, "--title", options.title, "--body-file", "-", ...(options.draft === true ? ["--draft"] : [])]
  const output = await runGh(options, args, new TextEncoder().encode(options.body ?? ""))
  const url = output.trim().split(/\s+/).find((word) => /^https:\/\/\S+\/pull\/\d{1,10}$/.test(word))
  const number = url === undefined ? Number.NaN : Number(url.slice(url.lastIndexOf("/") + 1))
  if (url === undefined || !Number.isSafeInteger(number) || number < 1) throw new GitHubCliError("failed")
  return Object.freeze({ number, url })
}

/** Who `gh` is signed in as on `host`: the login only, or why there is none. */
export async function gitHubCliLogin(options: { readonly command: string; readonly cwd: string; readonly host: string; readonly signal?: AbortSignal }): Promise<{ readonly state: "ready"; readonly login: string } | { readonly state: "signed-out" } | { readonly state: "missing" }> {
  try {
    const output = await runGh(options, ["api", "--hostname", options.host, "user"], undefined, 64 * 1024)
    const parsed = JSON.parse(output) as unknown
    const login = isRecord(parsed) ? parsed.login : undefined
    if (typeof login !== "string" || !LOGIN.test(login)) return { state: "signed-out" }
    return { state: "ready", login }
  } catch (error) {
    if (error instanceof GitHubCliError && error.failure === "unavailable") return { state: "missing" }
    if (error instanceof GitHubCliError && error.failure === "credentials") return { state: "signed-out" }
    throw error
  }
}

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/

function repository(options: GitHubRepositoryTarget): string {
  return options.host === undefined || options.host === "github.com" ? `${options.owner}/${options.repo}` : `${options.host}/${options.owner}/${options.repo}`
}

async function runGh(options: { readonly command: string; readonly cwd: string; readonly signal?: AbortSignal }, args: readonly string[], stdin?: Uint8Array, maxOutput = MAX_OUTPUT_BYTES): Promise<string> {
  const { text } = await runGitHubCli(options, args, { ...(stdin === undefined ? {} : { stdin }), maxOutput })
  return text
}

/**
 * Runs `gh` with token variables stripped. Output past `maxOutput` fails the call, or with
 * `truncate` ends the read there and reports it; with `tail` as well, the read goes on to the end
 * and keeps the last `maxOutput` bytes instead.
 */
export async function runGitHubCli(
  options: { readonly command: string; readonly cwd: string; readonly signal?: AbortSignal },
  args: readonly string[],
  read: { readonly stdin?: Uint8Array; readonly maxOutput?: number; readonly truncate?: boolean; readonly tail?: boolean; readonly notFound?: boolean } = {},
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const stdin = read.stdin
  const maxOutput = read.maxOutput ?? MAX_OUTPUT_BYTES
  let child: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">
  try {
    child = Bun.spawn([options.command, ...args], { cwd: options.cwd, env: cliEnvironment(), stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
  } catch {
    throw new GitHubCliError("unavailable")
  }
  let timedOut = false
  const kill = (): void => {
    try { child.kill() } catch { /* already exited */ }
  }
  const timer = setTimeout(() => { timedOut = true; kill() }, TIMEOUT_MS)
  options.signal?.addEventListener("abort", kill, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([read.truncate === true && read.tail === true ? readTail(child.stdout, maxOutput) : readBounded(child.stdout, maxOutput, kill), readBounded(child.stderr, MAX_STDERR_BYTES, () => {}), child.exited, writeChildInput(child.stdin, stdin)])
    if (timedOut || options.signal?.aborted === true) throw new GitHubCliError("timeout")
    if (stdout.overflow && read.truncate === true) return { text: stdout.text, truncated: true }
    if (stdout.overflow) throw new GitHubCliError("failed")
    if (exitCode !== 0) throw new GitHubCliError(classify(stderr.text, read.notFound === true))
    return { text: stdout.text, truncated: false }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", kill)
  }
}

/** `notFound` is the caller's opt-in; older calls keep answering a missing repository as a failure. */
function classify(stderr: string, notFound: boolean): GitHubCliFailure {
  if (/rate limit/i.test(stderr)) return "rate-limited"
  // gh names the scope an API call needs ("needs the \"read:org\" scope") when the token lacks it.
  if (/needs the "[a-z:_]+" scope|missing required scopes?/i.test(stderr)) return "scope"
  if (notFound && /Could not resolve to a|HTTP 404/i.test(stderr)) return "not-found"
  if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(stderr)) return "credentials"
  return "failed"
}

function cliEnvironment(): Record<string, string> {
  const env = filteredEnvironment()
  for (const name of FORWARDED) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  env.GH_PROMPT_DISABLED = "1"
  env.GH_NO_UPDATE_NOTIFIER = "1"
  env.GH_NO_EXTENSION_UPDATE_NOTIFIER = "1"
  env.NO_COLOR = "1"
  env.GIT_TERMINAL_PROMPT = "0"
  return env
}

/** Reads up to `max` bytes; past that it calls `onOverflow` once and keeps the first `max` bytes. */
async function readBounded(stream: ReadableStream<Uint8Array>, max: number, onOverflow: () => void): Promise<{ readonly text: string; readonly overflow: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let overflow = false
  for await (const chunk of stream) {
    if (overflow) continue
    if (size + chunk.byteLength > max) {
      chunks.push(chunk.subarray(0, max - size))
      size = max
      overflow = true
      onOverflow()
      continue
    }
    size += chunk.byteLength
    chunks.push(chunk)
  }
  // A cut can split a multi-byte character; the decoder replaces the partial tail.
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), overflow }
}

/** The last `max` bytes of the stream, read to its end. */
async function readTail(stream: ReadableStream<Uint8Array>, max: number): Promise<{ readonly text: string; readonly overflow: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let total = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    size += chunk.byteLength
    total += chunk.byteLength
    while (size - (chunks[0]?.byteLength ?? 0) >= max) size -= (chunks.shift() as Uint8Array).byteLength
  }
  const joined = Buffer.concat(chunks)
  // A cut can split a multi-byte character; the decoder replaces the partial head.
  return { text: new TextDecoder().decode(joined.subarray(Math.max(joined.byteLength - max, 0))), overflow: total > max }
}

function parseArray(output: string): readonly unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new GitHubCliError("failed")
  }
  if (!Array.isArray(parsed)) throw new GitHubCliError("failed")
  return parsed
}

function fromCli(value: unknown): PullRequestEntry | undefined {
  if (!isRecord(value)) return undefined
  const state = value.state === "MERGED" ? "merged" : value.state === "CLOSED" ? "closed" : "open"
  return entry({
    number: value.number,
    url: value.url,
    state,
    draft: value.isDraft === true,
    merged: state === "merged",
    title: value.title,
    head: value.headRefName,
    headCommit: value.headRefOid,
    base: value.baseRefName,
    author: isRecord(value.author) ? value.author.login : undefined,
    updatedAt: value.updatedAt,
    mergedAt: value.mergedAt,
    closedAt: value.closedAt,
    ...("reviewDecision" in value ? { review: reviewOf(value.reviewDecision) } : {}),
    ...("mergeable" in value ? { mergeable: value.mergeable === "MERGEABLE" ? "yes" : value.mergeable === "CONFLICTING" ? "conflicts" : "unknown" } : {}),
    ...("statusCheckRollup" in value ? { checks: checksOf(value.statusCheckRollup) } : {}),
  })
}

function reviewOf(value: unknown): PullRequestEntry["review"] {
  if (value === "APPROVED") return "approved"
  if (value === "CHANGES_REQUESTED") return "changes-requested"
  if (value === "REVIEW_REQUIRED") return "required"
  return "none"
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])

/** Reads both shapes GitHub mixes in the rollup: check runs and commit statuses. */
export function checksOf(rollup: unknown): PullRequestChecks {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 }
  const items: { name: string; state: keyof typeof counts; url?: string }[] = []
  for (const value of Array.isArray(rollup) ? rollup.slice(0, MAX_ROLLUP_ENTRIES) : []) {
    if (!isRecord(value)) continue
    const run = value.__typename === "CheckRun" || ("conclusion" in value && !("context" in value))
    const job = text(run ? value.name : value.context, 120) ?? "check"
    // Two workflows can run same-named jobs (CodeQL and CodeQL - Code Quality); GitHub labels them "workflow / job".
    const workflow = run ? text(workflowNameOf(value), 120) : undefined
    const name = workflow === undefined ? job : `${workflow} / ${job}`.slice(0, 120)
    const url = httpsUrl(run ? value.detailsUrl : value.targetUrl)
    let state: keyof typeof counts
    if (run) {
      const conclusion = value.conclusion
      state = value.status !== "COMPLETED" ? "pending"
        : conclusion === "SUCCESS" ? "passed"
        : conclusion === "SKIPPED" || conclusion === "NEUTRAL" ? "skipped"
        : typeof conclusion === "string" && FAILED.has(conclusion) ? "failed"
        : "pending"
    } else {
      state = value.state === "SUCCESS" ? "passed" : value.state === "FAILURE" || value.state === "ERROR" ? "failed" : "pending"
    }
    counts[state] += 1
    items.push({ name, state, ...(url === undefined ? {} : { url }) })
  }
  const order = { failed: 0, pending: 1, passed: 2, skipped: 3 }
  const shown = items.map((item, index) => ({ item, index })).sort((a, b) => order[a.item.state] - order[b.item.state] || a.index - b.index).slice(0, MAX_CHECK_ITEMS).map(({ item }) => Object.freeze(item))
  return Object.freeze({ ...counts, items: Object.freeze(shown) })
}

/** gh's JSON flattens it to `workflowName`; the GraphQL review query nests it under the check suite. */
function workflowNameOf(run: Record<string, unknown>): unknown {
  if ("workflowName" in run) return run.workflowName
  const suite = isRecord(run.checkSuite) ? run.checkSuite : undefined
  const workflowRun = isRecord(suite?.workflowRun) ? suite.workflowRun : undefined
  return isRecord(workflowRun?.workflow) ? workflowRun.workflow.name : undefined
}

/** The GitHub REST shape, as the bundled `github` connector returns it. */
export function pullRequestFromRest(value: unknown): PullRequestEntry | undefined {
  if (!isRecord(value)) return undefined
  const ref = (side: unknown): unknown => (isRecord(side) ? side.ref : undefined)
  const merged = typeof value.merged_at === "string"
  return entry({
    number: value.number,
    url: value.html_url,
    state: merged ? "merged" : value.state === "closed" ? "closed" : "open",
    draft: value.draft === true,
    merged,
    title: value.title,
    head: ref(value.head),
    base: ref(value.base),
    author: isRecord(value.user) ? value.user.login : undefined,
    updatedAt: value.updated_at,
    mergedAt: value.merged_at,
    closedAt: value.closed_at,
  })
}

interface RawEntry {
  readonly number: unknown
  readonly url: unknown
  readonly state: PullRequestEntry["state"]
  readonly draft: boolean
  readonly merged: boolean
  readonly title: unknown
  readonly head: unknown
  readonly headCommit?: unknown
  readonly base: unknown
  readonly author: unknown
  readonly updatedAt: unknown
  readonly mergedAt?: unknown
  readonly closedAt?: unknown
  readonly review?: PullRequestEntry["review"]
  readonly mergeable?: PullRequestEntry["mergeable"]
  readonly checks?: PullRequestChecks
}

function entry(raw: RawEntry): PullRequestEntry | undefined {
  if (typeof raw.number !== "number" || !Number.isSafeInteger(raw.number) || raw.number < 1) return undefined
  const url = httpsUrl(raw.url)
  const branch = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined)
  const login = typeof raw.author === "string" && LOGIN.test(raw.author) ? raw.author : undefined
  const title = text(raw.title, 256)
  const head = branch(raw.head)
  const headCommit = typeof raw.headCommit === "string" && /^[0-9a-f]{40}$/.test(raw.headCommit) ? raw.headCommit : undefined
  const base = branch(raw.base)
  const updatedAt = time(raw.updatedAt)
  const mergedAt = time(raw.mergedAt)
  const closedAt = time(raw.closedAt)
  return Object.freeze({
    number: raw.number,
    ...(url === undefined ? {} : { url }),
    state: raw.state,
    draft: raw.draft,
    merged: raw.merged,
    ...(title === undefined ? {} : { title }),
    ...(head === undefined ? {} : { head }),
    ...(headCommit === undefined ? {} : { headCommit }),
    ...(base === undefined ? {} : { base }),
    ...(login === undefined ? {} : { author: login }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(raw.review === undefined ? {} : { review: raw.review }),
    ...(raw.mergeable === undefined ? {} : { mergeable: raw.mergeable }),
    ...(raw.checks === undefined ? {} : { checks: raw.checks }),
  })
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/[^\s]{1,2040}$/.test(value) ? value : undefined
}

function time(value: unknown): number | undefined {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? at : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
