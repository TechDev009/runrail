import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-reviews-token-1234567890abcdef"
const cleanup: (() => Promise<void>)[] = []

setDefaultTimeout(30_000)

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(`/tmp/${prefix}`)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A stand-in `gh` that records each call's argv, then answers from files the test writes, keyed
 * by what was asked: `api-search`, `api-view`, `api-teams`, or `pr-diff`.
 */
async function fakeGitHubCli() {
  const dir = await tempDir("runrail-reviews-gh-")
  const script = join(dir, "gh")
  await mkdir(join(dir, "calls"))
  await mkdir(join(dir, "stdin"))
  await writeFile(script, [
    "#!/bin/sh",
    `dir='${dir}'`,
    `n=$(ls "$dir/calls" | wc -l | tr -d ' ')`,
    `printf '%s\\n' "$@" > "$dir/calls/$n.argv"`,
    `cat > "$dir/stdin/$n"`,
    `key="$1"`,
    `case "$1 $2" in`,
    `  "api graphql") if printf '%s\\n' "$@" | grep -q '^q='; then key=api-search; else key=api-view; fi ;;`,
    `  "api user/teams"*) key=api-teams ;;`,
    `  "pr diff") key=pr-diff ;;`,
    `  "pr merge") key=pr-merge ;;`,
    `  "run view") key="run-view-$4" ;;`,
    `  "api repos/"*) key=api-review ;;`,
    `esac`,
    `[ -f "$dir/stderr-$key" ] && cat "$dir/stderr-$key" >&2`,
    `[ -f "$dir/reply-$key" ] && cat "$dir/reply-$key"`,
    `code=0; [ -f "$dir/exit-$key" ] && code=$(cat "$dir/exit-$key")`,
    `exit $code`,
  ].join("\n"), "utf8")
  await chmod(script, 0o755)
  return {
    script,
    reply: async (key: string, output: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }) => {
      await writeFile(join(dir, `reply-${key}`), output.stdout ?? "", "utf8")
      await writeFile(join(dir, `stderr-${key}`), output.stderr ?? "", "utf8")
      await writeFile(join(dir, `exit-${key}`), String(output.exitCode ?? 0), "utf8")
    },
    stdin: async (index: number): Promise<string> => readFile(join(dir, "stdin", String(index)), "utf8"),
    calls: async (): Promise<string[][]> => {
      const names = (await readdir(join(dir, "calls"))).sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
      return Promise.all(names.map(async (name) => (await readFile(join(dir, "calls", name), "utf8")).replace(/\n$/, "").split("\n")))
    },
  }
}

async function startControl(githubCli: string | false) {
  const cwd = await tempDir("runrail-reviews-cwd-")
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    model: { complete: () => ({ type: "text", text: "done" }) },
    githubCli,
    nativeAccountsDir: await tempDir("runrail-reviews-accounts-"),
  })
  cleanup.push(() => running.handle.stop())
  const rpc = async (method: string, params: Readonly<Record<string, unknown>> = {}): Promise<{ readonly status: number; readonly body: any }> => {
    const response = await fetch(`${running.handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  return { rpc, health }
}

async function connected() {
  const gh = await fakeGitHubCli()
  const control = await startControl(gh.script)
  expect((await control.rpc("codehost.connect", { host: "github.com", via: "gh" })).status).toBe(200)
  return { gh, ...control }
}

const searchReply = {
  data: {
    search: {
      issueCount: 2,
      nodes: [
        {
          number: 68,
          title: "Add the settings page",
          url: "https://github.com/example-org/widgets/pull/68",
          isDraft: false,
          updatedAt: "2026-10-04T10:00:00Z",
          author: { login: "example-user" },
          repository: { name: "widgets", owner: { login: "example-org" } },
          reviewDecision: "REVIEW_REQUIRED",
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
        },
        { number: 3, title: "Not a pull request" },
        { title: "No number", repository: { name: "x", owner: { login: "y" } } },
      ],
    },
  },
}

const viewReply = {
  data: {
    repository: {
      mergeCommitAllowed: false,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerPermission: "WRITE",
      pullRequest: {
        number: 68,
        title: "Add the settings page",
        url: "https://github.com/example-org/widgets/pull/68",
        body: "Adds it.",
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-04T10:00:00Z",
        author: { login: "example-user" },
        baseRefName: "main",
        headRefName: "settings-page",
        headRefOid: "a".repeat(40),
        isCrossRepository: true,
        headRepository: { nameWithOwner: "example-user/widgets" },
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "CHANGES_REQUESTED",
        additions: 120,
        deletions: 4,
        changedFiles: 2,
        files: { totalCount: 2, nodes: [{ path: "src/host.ts", additions: 100, deletions: 4, changeType: "MODIFIED" }, { path: "src/new.ts", additions: 20, deletions: 0, changeType: "ADDED" }] },
        latestOpinionatedReviews: { nodes: [{ author: { login: "reviewer-1" }, state: "CHANGES_REQUESTED", submittedAt: "2026-10-03T10:00:00Z" }, { state: "WEIRD" }] },
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "someone" } }, { requestedReviewer: { __typename: "Team", slug: "dev", organization: { login: "example-org" } } }, { requestedReviewer: { __typename: "Mannequin" } }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/x", checkSuite: { workflowRun: { workflow: { name: "CI" } } } }, { __typename: "StatusContext", context: "ci/lint", state: "SUCCESS" }] } } } }] },
      },
    },
  },
}

const DIFF = [
  "diff --git a/src/host.ts b/src/host.ts",
  "index 1..2 100644",
  "--- a/src/host.ts",
  "+++ b/src/host.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n")

test("the inbox needs gh and a connected host, and says which is missing", async () => {
  const without = await startControl(false)
  expect(without.health.capabilityStatus["git.pr.reviews"]).toBe("unavailable")

  const gh = await fakeGitHubCli()
  const control = await startControl(gh.script)
  expect(control.health.capabilityStatus["git.pr.reviews"]).toBe("available")
  const refused = await control.rpc("git.pr.search", { group: "authored" })
  expect(refused.status).toBe(501)
  expect(refused.body.error.code).toBe("CONTROL_PR_NOT_CONNECTED")
  expect(await gh.calls()).toEqual([])
})

test("each group is one GitHub search with S1's qualifiers, and entries are parsed and bounded", async () => {
  const { gh, rpc } = await connected()
  await gh.reply("api-search", { stdout: JSON.stringify(searchReply) })

  const mine = await rpc("git.pr.search", { group: "review-requested" })
  expect(mine.status).toBe(200)
  expect(mine.body.result).toEqual({
    host: "github.com",
    group: "review-requested",
    total: 2,
    pullRequests: [{
      owner: "example-org",
      repo: "widgets",
      number: 68,
      url: "https://github.com/example-org/widgets/pull/68",
      title: "Add the settings page",
      author: "example-user",
      updatedAt: Date.parse("2026-10-04T10:00:00Z"),
      draft: false,
      review: "required",
      checks: "failed",
    }],
  })
  await rpc("git.pr.search", { group: "authored", limit: 5, query: "settings page" })
  await rpc("git.pr.search", { group: "team" })
  await rpc("git.pr.search", { group: "team", team: "example-org/dev" })

  const queries = (await gh.calls()).map((argv) => ({ q: argv.find((arg) => arg.startsWith("q=")), n: argv.find((arg) => arg.startsWith("n=")) }))
  expect(queries).toEqual([
    { q: "q=is:pr is:open archived:false user-review-requested:@me sort:updated-desc", n: "n=20" },
    { q: "q=is:pr is:open archived:false author:@me settings page sort:updated-desc", n: "n=5" },
    { q: "q=is:pr is:open archived:false review-requested:@me -user-review-requested:@me sort:updated-desc", n: "n=20" },
    { q: "q=is:pr is:open archived:false team-review-requested:example-org/dev sort:updated-desc", n: "n=20" },
  ])
})

test("bad inputs are refused before gh runs", async () => {
  const { gh, rpc } = await connected()
  const refusals: [string, Record<string, unknown>][] = [
    ["git.pr.search", {}],
    ["git.pr.search", { group: "everything" }],
    ["git.pr.search", { group: "authored", team: "example-org/dev" }],
    ["git.pr.search", { group: "team", team: "example-org" }],
    ["git.pr.search", { group: "team", team: "example-org/dev/x" }],
    ["git.pr.search", { group: "authored", limit: 0 }],
    ["git.pr.search", { group: "authored", limit: 51 }],
    ["git.pr.search", { group: "authored", query: "one\ntwo" }],
    ["git.pr.search", { group: "authored", query: "x".repeat(201) }],
    ["git.pr.search", { group: "authored", host: "not a host" }],
    ["git.pr.view", { owner: "example-org", repo: "widgets" }],
    ["git.pr.view", { owner: "example-org", repo: "widgets", number: 0 }],
    ["git.pr.view", { owner: "-example-org", repo: "widgets", number: 1 }],
    ["git.pr.view", { owner: "example-org", repo: "../etc", number: 1 }],
    ["git.pr.diff", { owner: "example-org", repo: "widgets", number: 1, path: "a\nb" }],
    ["git.pr.diff", { owner: "example-org", repo: "widgets", number: 1.5 }],
    ["git.pr.checks.logs", { owner: "example-org", repo: "widgets" }],
    ["git.pr.checks.logs", { owner: "example-org", repo: "../etc", number: 1 }],
  ]
  for (const [method, params] of refusals) {
    const answer = await rpc(method, params)
    expect({ method, params, status: answer.status, code: answer.body.error?.code }).toEqual({ method, params, status: 400, code: "CONTROL_INVALID_INPUT" })
  }
  expect(await gh.calls()).toEqual([])
})

test("teams are listed, and a sign-in without read:org gets its own code without gh's words", async () => {
  const { gh, rpc } = await connected()
  await gh.reply("api-teams", { stdout: JSON.stringify([{ slug: "dev", name: "Dev", organization: { login: "example-org" } }, { slug: "bad slug", organization: { login: "x" } }]) })
  const teams = await rpc("git.pr.teams")
  expect(teams.body.result).toEqual({ host: "github.com", teams: [{ org: "example-org", slug: "dev", name: "Dev" }] })

  await gh.reply("api-teams", { stderr: 'gh: This API operation needs the "read:org" scope. To request it, run:  gh auth refresh -h github.com -s read:org\nsecret-account-name', exitCode: 1 })
  const missing = await rpc("git.pr.teams")
  expect(missing.status).toBe(403)
  expect(missing.body.error.code).toBe("CONTROL_PR_SCOPE_MISSING")
  expect(JSON.stringify(missing.body)).not.toContain("secret-account-name")

  await gh.reply("api-teams", { stderr: "gh auth login required", exitCode: 4 })
  expect((await rpc("git.pr.teams")).body.error.code).toBe("CONTROL_PR_CREDENTIALS")
})

test("a pull request is read in full: files, reviews, requests, checks, and the merge methods allowed", async () => {
  const { gh, rpc } = await connected()
  await gh.reply("api-view", { stdout: JSON.stringify(viewReply) })
  const view = await rpc("git.pr.view", { owner: "example-org", repo: "widgets", number: 68 })
  expect(view.status).toBe(200)
  const detail = view.body.result
  expect(detail).toMatchObject({
    owner: "example-org",
    repo: "widgets",
    number: 68,
    body: "Adds it.",
    bodyTruncated: false,
    state: "open",
    base: "main",
    head: "settings-page",
    headCommit: "a".repeat(40),
    headRepository: "example-user/widgets",
    crossRepository: true,
    mergeable: "yes",
    mergeState: "blocked",
    review: "changes-requested",
    changedFiles: 2,
    filesTruncated: false,
    checksState: "failed",
    mergeMethods: ["squash", "rebase"],
    permission: "write",
  })
  expect(detail.files).toEqual([{ path: "src/host.ts", additions: 100, deletions: 4, change: "modified" }, { path: "src/new.ts", additions: 20, deletions: 0, change: "added" }])
  expect(detail.reviews).toEqual([{ author: "reviewer-1", state: "changes-requested", submittedAt: Date.parse("2026-10-03T10:00:00Z") }])
  expect(detail.requested).toEqual([{ kind: "user", login: "someone" }, { kind: "team", org: "example-org", slug: "dev" }])
  expect(detail.checks).toMatchObject({ passed: 1, failed: 1, pending: 0, skipped: 0 })
  expect(detail.checks.items[0]).toEqual({ name: "CI / test", state: "failed", url: "https://github.com/x" })
  const argv = (await gh.calls())[0] ?? []
  expect(argv).toContain("owner=example-org")
  expect(argv).toContain("name=widgets")
  expect(argv).toContain("number=68")
})

test("a long body and a missing pull request", async () => {
  const { gh, rpc } = await connected()
  const long = structuredClone(viewReply)
  long.data.repository.pullRequest.body = "x".repeat(25_000)
  await gh.reply("api-view", { stdout: JSON.stringify(long) })
  const view = (await rpc("git.pr.view", { owner: "example-org", repo: "widgets", number: 68 })).body.result
  expect(view.body.length).toBe(20_000)
  expect(view.bodyTruncated).toBe(true)

  await gh.reply("api-view", { stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) })
  const empty = await rpc("git.pr.view", { owner: "example-org", repo: "widgets", number: 9 })
  expect(empty.status).toBe(404)
  expect(empty.body.error.code).toBe("CONTROL_PR_NOT_FOUND")

  await gh.reply("api-view", { stderr: "GraphQL: Could not resolve to a PullRequest with the number of 9. (repository.pullRequest)", exitCode: 1 })
  expect((await rpc("git.pr.view", { owner: "example-org", repo: "widgets", number: 9 })).body.error.code).toBe("CONTROL_PR_NOT_FOUND")

  await gh.reply("api-view", { stdout: "not json" })
  expect((await rpc("git.pr.view", { owner: "example-org", repo: "widgets", number: 9 })).body.error.code).toBe("CONTROL_PR_FAILED")
})

test("the diff is read whole or for one file, and cut at its bound instead of failing", async () => {
  const { gh, rpc } = await connected()
  await gh.reply("pr-diff", { stdout: DIFF })
  expect((await rpc("git.pr.diff", { owner: "example-org", repo: "widgets", number: 68 })).body.result).toEqual({ diff: DIFF, truncated: false })
  const one = (await rpc("git.pr.diff", { owner: "example-org", repo: "widgets", number: 68, path: "src/new.ts" })).body.result
  expect(one.found).toBe(true)
  expect(one.diff.startsWith("diff --git a/src/new.ts b/src/new.ts")).toBe(true)
  expect(one.diff).not.toContain("src/host.ts")
  expect((await rpc("git.pr.diff", { owner: "example-org", repo: "widgets", number: 68, path: "src/gone.ts" })).body.result).toEqual({ diff: "", truncated: false, found: false })
  expect((await gh.calls())[0]).toEqual(["pr", "diff", "68", "--repo", "example-org/widgets", "--color", "never"])

  await gh.reply("pr-diff", { stdout: `${DIFF}${"+".repeat(2 * 1024 * 1024)}` })
  const cut = (await rpc("git.pr.diff", { owner: "example-org", repo: "widgets", number: 68 })).body.result
  expect(cut.truncated).toBe(true)
  expect(cut.diff.length).toBe(2 * 1024 * 1024)
})

const HEAD = "a".repeat(40)

test("writes need the person's confirmation and well-formed input before gh runs", async () => {
  const { gh, rpc } = await connected()
  const where = { owner: "example-org", repo: "widgets", number: 68 }
  const refusals: [string, Record<string, unknown>, number][] = [
    ["git.pr.review.post", { ...where, commit: HEAD, body: "x" }, 428],
    ["git.pr.merge", { ...where, method: "squash", headCommit: HEAD }, 428],
    ["git.pr.review.post", { ...where, confirm: true, commit: "abc", body: "x" }, 400],
    ["git.pr.review.post", { ...where, confirm: true, commit: HEAD, body: "" }, 400],
    ["git.pr.review.post", { ...where, confirm: true, commit: HEAD, body: "x", comments: Array.from({ length: 51 }, () => ({ path: "a.ts", line: 1, body: "y" })) }, 400],
    ["git.pr.review.post", { ...where, confirm: true, commit: HEAD, body: "x", comments: [{ path: "a.ts", body: "y" }] }, 400],
    ["git.pr.review.post", { ...where, confirm: true, commit: HEAD, body: "x", comments: [{ path: "a.ts", line: 1, side: "UP", body: "y" }] }, 400],
    ["git.pr.review.post", { ...where, confirm: true, commit: HEAD, body: "x", comments: [{ path: "a\nb", line: 1, body: "y" }] }, 400],
    ["git.pr.merge", { ...where, confirm: true, method: "fast-forward", headCommit: HEAD }, 400],
    ["git.pr.merge", { ...where, confirm: true, method: "squash" }, 400],
    ["git.pr.merge", { ...where, confirm: true, method: "squash", headCommit: HEAD, subject: "one\ntwo" }, 400],
  ]
  for (const [method, params, status] of refusals) {
    const answer = await rpc(method, params)
    expect({ method, params, status: answer.status }).toEqual({ method, params, status })
  }
  expect(await gh.calls()).toEqual([])
})

test("a review is one comment-kind review with its line comments, sent on stdin", async () => {
  const { gh, rpc, health } = await connected()
  expect(health.capabilityStatus["git.pr.review.post"]).toBe("available")
  await gh.reply("api-review", { stdout: JSON.stringify({ id: 99, html_url: "https://github.com/example-org/widgets/pull/68#pullrequestreview-99", state: "COMMENTED" }) })
  const posted = await rpc("git.pr.review.post", {
    owner: "example-org", repo: "widgets", number: 68, confirm: true, commit: HEAD,
    body: "Two findings from Runrail.",
    comments: [{ path: "src/host.ts", line: 12, body: "This can throw." }, { path: "src/old.ts", line: 3, side: "LEFT", body: "Removed too soon." }],
  })
  expect(posted.status).toBe(200)
  expect(posted.body.result).toEqual({ host: "github.com", id: 99, url: "https://github.com/example-org/widgets/pull/68#pullrequestreview-99", comments: 2 })
  expect((await gh.calls())[0]).toEqual(["api", "repos/example-org/widgets/pulls/68/reviews", "--method", "POST", "--input", "-"])
  expect(JSON.parse(await gh.stdin(0))).toEqual({
    commit_id: HEAD,
    body: "Two findings from Runrail.",
    event: "COMMENT",
    comments: [{ path: "src/host.ts", line: 12, side: "RIGHT", body: "This can throw." }, { path: "src/old.ts", line: 3, side: "LEFT", body: "Removed too soon." }],
  })

  await gh.reply("api-review", { stderr: "gh: Validation Failed (HTTP 422) Pull request review thread line must be part of the diff", exitCode: 1 })
  const refused = await rpc("git.pr.review.post", { owner: "example-org", repo: "widgets", number: 68, confirm: true, commit: HEAD, body: "x", comments: [{ path: "a.ts", line: 900, body: "y" }] })
  expect(refused.body.error.code).toBe("CONTROL_PR_FAILED")
  expect(JSON.stringify(refused.body)).not.toContain("thread line")
})

test("a merge is refused in Runrail's words for a method the repository forbids, a draft, or a head that moved", async () => {
  const { gh, rpc } = await connected()
  await gh.reply("api-view", { stdout: JSON.stringify(viewReply) })
  const where = { owner: "example-org", repo: "widgets", number: 68, confirm: true }
  const forbidden = await rpc("git.pr.merge", { ...where, method: "merge", headCommit: HEAD })
  expect([forbidden.status, forbidden.body.error.code]).toEqual([409, "CONTROL_PR_MERGE_REFUSED"])
  const moved = await rpc("git.pr.merge", { ...where, method: "squash", headCommit: "b".repeat(40) })
  expect(moved.body.error.code).toBe("CONTROL_PR_HEAD_MOVED")
  const draft = structuredClone(viewReply)
  draft.data.repository.pullRequest.isDraft = true
  await gh.reply("api-view", { stdout: JSON.stringify(draft) })
  expect((await rpc("git.pr.merge", { ...where, method: "squash", headCommit: HEAD })).body.error.code).toBe("CONTROL_PR_MERGE_REFUSED")
  expect((await gh.calls()).some((argv) => argv[0] === "pr")).toBe(false)
})

test("a merge names the head it saw and sends the commit body on stdin", async () => {
  const { gh, rpc } = await connected()
  await gh.reply("api-view", { stdout: JSON.stringify(viewReply) })
  await gh.reply("pr-merge", { stdout: "" })
  const merged = await rpc("git.pr.merge", { owner: "example-org", repo: "widgets", number: 68, confirm: true, method: "squash", headCommit: HEAD, subject: "Add the settings page (#68)", body: "Squashed.", deleteBranch: true })
  expect(merged.status).toBe(200)
  expect(merged.body.result).toEqual({ host: "github.com", merged: true, method: "squash", url: "https://github.com/example-org/widgets/pull/68" })
  const calls = await gh.calls()
  expect(calls[1]).toEqual(["pr", "merge", "68", "--repo", "example-org/widgets", "--squash", "--match-head-commit", HEAD, "--subject", "Add the settings page (#68)", "--body-file", "-", "--delete-branch"])
  expect(await gh.stdin(1)).toBe("Squashed.")

  await gh.reply("pr-merge", { stderr: "X Pull request example-org/widgets#68 is not mergeable: the base branch policy prohibits the merge.", exitCode: 1 })
  const refused = await rpc("git.pr.merge", { owner: "example-org", repo: "widgets", number: 68, confirm: true, method: "squash", headCommit: HEAD })
  expect(refused.body.error.code).toBe("CONTROL_PR_FAILED")
  expect(JSON.stringify(refused.body)).not.toContain("policy")
})

test("auto-merge is turned on with the head it saw, and is not a merge", async () => {
  const { gh, rpc, health } = await connected()
  expect(health.capabilityStatus["git.pr.checks"]).toBe("available")
  await gh.reply("api-view", { stdout: JSON.stringify(viewReply) })
  await gh.reply("pr-merge", { stdout: "" })
  expect((await rpc("git.pr.merge", { owner: "example-org", repo: "widgets", number: 68, method: "squash", headCommit: HEAD, auto: true })).status).toBe(428)
  const auto = await rpc("git.pr.merge", { owner: "example-org", repo: "widgets", number: 68, confirm: true, method: "squash", headCommit: HEAD, auto: true })
  expect(auto.body.result).toEqual({ host: "github.com", merged: false, auto: true, method: "squash", url: "https://github.com/example-org/widgets/pull/68" })
  expect((await gh.calls())[1]).toEqual(["pr", "merge", "68", "--repo", "example-org/widgets", "--squash", "--match-head-commit", HEAD, "--auto"])
})

const ESC = "\u001b"

test("failing checks come with the end of each Actions job's failed steps, and others by name", async () => {
  const { gh, rpc } = await connected()
  const failing = structuredClone(viewReply) as any
  failing.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/example-org/widgets/actions/runs/7/job/1" },
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/example-org/widgets/actions/runs/7/job/22" },
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://github.com/example-org/widgets/actions/runs/7/job/33" },
    { __typename: "StatusContext", context: "ci/external", state: "FAILURE", targetUrl: "https://ci.example.com/b/9" },
  ]
  await gh.reply("api-view", { stdout: JSON.stringify(failing) })
  await gh.reply("run-view-22", { stdout: [
    `test\tSet up job\t2026-10-10T10:00:00.0000000Z Runner ready`,
    `test\tRun bun test\t2026-10-10T10:00:01.1234567Z ${ESC}[31mFAIL${ESC}[0m test/a.test.ts`,
    `test\tRun bun test\t2026-10-10T10:00:01.2Z expected 2, got 3`,
    "",
  ].join("\n") })
  await gh.reply("run-view-33", { stderr: "HTTP 404: Not Found", exitCode: 1 })
  const answer = await rpc("git.pr.checks.logs", { owner: "example-org", repo: "widgets", number: 68 })
  expect(answer.status).toBe(200)
  expect(answer.body.result).toEqual({
    host: "github.com",
    number: 68,
    headCommit: HEAD,
    failed: 3,
    checks: [
      { name: "test", url: "https://github.com/example-org/widgets/actions/runs/7/job/22", log: "## Set up job\nRunner ready\n## Run bun test\nFAIL test/a.test.ts\nexpected 2, got 3" },
      { name: "build", url: "https://github.com/example-org/widgets/actions/runs/7/job/33" },
      { name: "ci/external", url: "https://ci.example.com/b/9" },
    ],
  })
  const runs = (await gh.calls()).filter((argv) => argv[0] === "run")
  expect(runs).toEqual([
    ["run", "view", "--job", "22", "--log-failed", "--repo", "example-org/widgets"],
    ["run", "view", "--job", "33", "--log-failed", "--repo", "example-org/widgets"],
  ])
})

test("a long job log keeps its end, from a line start", async () => {
  const { gh, rpc } = await connected()
  const failing = structuredClone(viewReply) as any
  failing.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/example-org/widgets/actions/runs/7/job/22" },
  ]
  await gh.reply("api-view", { stdout: JSON.stringify(failing) })
  // Past the 2 MB read as well, so the end comes from reading on rather than from the start.
  const line = `test\tRun bun test\t2026-10-10T10:00:01Z ${"x".repeat(200)}`
  await gh.reply("run-view-22", { stdout: `${Array.from({ length: 12_000 }, () => line).join("\n")}\ntest\tRun bun test\t2026-10-10T10:00:02Z the real failure\n` })
  const check = (await rpc("git.pr.checks.logs", { owner: "example-org", repo: "widgets", number: 68 })).body.result.checks[0]
  expect(check.cut).toBe(true)
  expect(check.log.length).toBeLessThanOrEqual(12_000)
  expect(check.log.endsWith("the real failure")).toBe(true)
  expect(check.log.split("\n").slice(0, -1).every((text: string) => text === "x".repeat(200))).toBe(true)
})

