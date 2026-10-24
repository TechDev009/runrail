import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createCallerConnectorCredentialResolver, createConnectorRegistry, createGitHubConnector } from "../../src/connectors/index.ts"

const token = "control-codehosts-token-1234567890abcdef"
const cleanup: (() => Promise<void>)[] = []

setDefaultTimeout(30_000)

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(`/tmp/${prefix}`)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A repository on branch `feature` with one commit and the given remotes. */
async function repoWith(remotes: Record<string, string>): Promise<string> {
  const repo = await tempDir("runrail-codehosts-repo-")
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Runrail Test")
  git(repo, "config", "user.email", "test@runrail.invalid")
  git(repo, "config", "commit.gpgsign", "false")
  await writeFile(join(repo, "a.txt"), "one\n", "utf8")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", "one")
  git(repo, "checkout", "-q", "-b", "feature")
  for (const [name, url] of Object.entries(remotes)) git(repo, "remote", "add", name, url)
  return repo
}

interface Call {
  readonly argv: readonly string[]
  readonly stdin: string
}

/**
 * A stand-in `gh` that records each call's argv and stdin, then answers by subcommand
 * (`api`, `pr-list`, `pr-create`) from files the test writes.
 */
async function fakeGitHubCli() {
  const dir = await tempDir("runrail-codehosts-gh-")
  const script = join(dir, "gh")
  await mkdir(join(dir, "calls"))
  await writeFile(script, [
    "#!/bin/sh",
    `dir='${dir}'`,
    `n=$(ls "$dir/calls" | wc -l | tr -d ' ')`,
    `printf '%s\\n' "$@" > "$dir/calls/$n.argv"`,
    `cat > "$dir/calls/$n.stdin"`,
    `key="$1"; [ "$1" = pr ] && key="pr-$2"`,
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
    calls: async (): Promise<Call[]> => {
      const names = (await readdir(join(dir, "calls"))).filter((name) => name.endsWith(".argv")).sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
      return Promise.all(names.map(async (name) => ({
        argv: (await readFile(join(dir, "calls", name), "utf8")).replace(/\n$/, "").split("\n"),
        stdin: await readFile(join(dir, "calls", name.replace(".argv", ".stdin")), "utf8"),
      })))
    },
  }
}

async function startControl(cwd: string, extra: { readonly githubCli?: string | false; readonly accountsDir?: string; readonly connectorRegistry?: ReturnType<typeof createConnectorRegistry> } = {}) {
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    model: { complete: () => ({ type: "text", text: "done" }) },
    githubCli: extra.githubCli ?? false,
    nativeAccountsDir: extra.accountsDir ?? await tempDir("runrail-codehosts-accounts-"),
    ...(extra.connectorRegistry === undefined ? {} : { connectorRegistry: extra.connectorRegistry }),
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

test("codehost answers and connections live in one file every engine on the accounts folder shares", async () => {
  const accountsDir = await tempDir("runrail-codehosts-shared-")
  const gh = await fakeGitHubCli()
  const repo = await repoWith({ origin: "ssh://git@git.corp.example:8443/example-org/widgets.git" })
  const first = await startControl(repo, { accountsDir, githubCli: gh.script })
  const second = await startControl(repo, { accountsDir, githubCli: gh.script })
  expect(first.health.capabilityStatus.codehosts).toBe("available")

  expect((await first.rpc("codehost.list")).body.result).toEqual({ hosts: [] })
  const answered = await first.rpc("codehost.set", { host: "Git.Corp.Example:8443", service: "gitlab" })
  expect(answered.status).toBe(200)
  expect(answered.body.result).toEqual({ host: "git.corp.example:8443", service: "gitlab" })
  expect((await second.rpc("codehost.list")).body.result.hosts).toEqual([{ host: "git.corp.example:8443", service: "gitlab" }])
  expect((await second.rpc("git.remote.list")).body.result.remotes).toMatchObject([{ name: "origin", service: "gitlab", serviceFrom: "user" }])

  const connected = await first.rpc("codehost.connect", { host: "github.com", via: "gh" })
  expect(connected.status).toBe(200)
  expect(connected.body.result).toMatchObject({ host: "github.com", connection: { via: "gh", enabled: true } })
  expect(typeof connected.body.result.connection.addedAt).toBe("number")
  expect((await second.rpc("codehost.list")).body.result.hosts).toHaveLength(2)
  expect((await stat(join(accountsDir, "codehosts.json"))).mode & 0o777).toBe(0o600)

  const disconnected = await second.rpc("codehost.disconnect", { host: "github.com" })
  expect(disconnected.body.result).toEqual({ host: "github.com" })
  expect((await first.rpc("codehost.list")).body.result.hosts).toEqual([{ host: "git.corp.example:8443", service: "gitlab" }])
  // Neither connecting nor disconnecting runs gh: no sign-in is checked, made, or ended.
  expect(await gh.calls()).toEqual([])
})

test("codehost methods refuse bad input, other services, a missing gh, and a full store", async () => {
  const accountsDir = await tempDir("runrail-codehosts-refuse-")
  const gh = await fakeGitHubCli()
  const repo = await repoWith({})
  const { rpc } = await startControl(repo, { accountsDir, githubCli: gh.script })
  for (const params of [{ host: "bad host", service: "gitlab" }, { host: "x.example", service: "svn" }, { host: "x.example:70000", service: "github" }, { host: 7, service: "github" }, { host: "-x.example", service: "github" }]) {
    const refused = await rpc("codehost.set", params)
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe("CONTROL_INVALID_INPUT")
  }
  expect((await rpc("codehost.connect", { host: "github.com", via: "token" })).status).toBe(400)
  const gitlab = await rpc("codehost.connect", { host: "gitlab.com", via: "gh" })
  expect(gitlab.status).toBe(501)
  expect(gitlab.body.error).toMatchObject({ code: "CONTROL_PR_UNAVAILABLE", message: "pull requests for GitLab need a GitLab connector" })
  await rpc("codehost.set", { host: "code.corp.example", service: "bitbucket" })
  expect((await rpc("codehost.connect", { host: "code.corp.example", via: "gh" })).body.error.code).toBe("CONTROL_PR_UNAVAILABLE")

  const noGh = await startControl(repo, { accountsDir, githubCli: false })
  const missing = await noGh.rpc("codehost.connect", { host: "github.com", via: "gh" })
  expect(missing.status).toBe(501)
  expect(missing.body.error).toMatchObject({ code: "CONTROL_PR_UNAVAILABLE", message: "install the GitHub CLI (gh) first" })

  await writeFile(join(accountsDir, "codehosts.json"), "{ not json", "utf8")
  expect((await rpc("codehost.list")).body.result).toEqual({ hosts: [], problem: "CODEHOST_STORE_INVALID" })

  const full = Array.from({ length: 64 }, (_, index) => ({ host: `h${String(index)}.example`, service: "gitlab" }))
  await writeFile(join(accountsDir, "codehosts.json"), JSON.stringify({ version: 1, hosts: full }), "utf8")
  const over = await rpc("codehost.set", { host: "one-more.example", service: "github" })
  expect(over.status).toBe(409)
  expect(over.body.error.code).toBe("CONTROL_CODEHOST_LIMIT")
  expect((await rpc("codehost.set", { host: "h3.example", service: "github" })).status).toBe(200)
})

test("codehost.remotes reads a project folder's remotes with no thread there, offline, with credentials removed", async () => {
  const accountsDir = await tempDir("runrail-codehosts-remotes-")
  const repo = await repoWith({ origin: "https://octo:secret-token-123@github.com/example-org/web.git", mirror: "git@git.corp.example:group/sub/web.git" })
  await mkdir(join(repo, "packages", "app"), { recursive: true })
  const elsewhere = await tempDir("runrail-codehosts-elsewhere-")
  const engine = await startControl(elsewhere, { accountsDir })
  expect(engine.health.capabilityStatus["codehost.remotes"]).toBe("available")

  const read = await engine.rpc("codehost.remotes", { path: repo })
  expect(read.status).toBe(200)
  expect(read.body.result).toMatchObject({
    git: true,
    branch: "feature",
    detached: false,
    initial: false,
    remotes: [
      { name: "mirror", url: "git.corp.example:group/sub/web.git", host: "git.corp.example", path: "group/sub/web", service: "gitlab", serviceFrom: "path" },
      { name: "origin", url: "https://github.com/example-org/web.git", host: "github.com", owner: "example-org", repo: "web", service: "github", serviceFrom: "host" },
    ],
  })
  expect(JSON.stringify(read.body)).not.toContain("secret-token")
  expect((await engine.rpc("codehost.remotes", { path: join(repo, "packages", "app") })).body.result.remotes).toHaveLength(2)

  await engine.rpc("codehost.set", { host: "git.corp.example", service: "bitbucket" })
  expect((await engine.rpc("codehost.remotes", { path: repo })).body.result.remotes[0]).toMatchObject({ name: "mirror", service: "bitbucket", serviceFrom: "user" })
  expect((await engine.rpc("codehost.remotes", { path: elsewhere })).body.result).toEqual({ git: false })

  git(repo, "checkout", "-q", "--detach")
  expect((await engine.rpc("codehost.remotes", { path: repo })).body.result).toMatchObject({ detached: true, initial: false })
  expect((await engine.rpc("codehost.remotes", { path: repo })).body.result.branch).toBeUndefined()
  const fresh = await tempDir("runrail-codehosts-fresh-")
  git(fresh, "init", "-q", "-b", "trunk")
  expect((await engine.rpc("codehost.remotes", { path: fresh })).body.result).toEqual({ git: true, remotes: [], branch: "trunk", detached: false, initial: true })
})

test("codehost.remotes refuses a relative path, a missing folder, a file, and a NUL", async () => {
  const repo = await repoWith({ origin: "https://github.com/example-org/web.git" })
  const { rpc } = await startControl(repo)
  for (const path of ["relative/dir", "", join(repo, "missing"), join(repo, "a.txt"), `${repo}\0x`, 42, "/".repeat(4_097)]) {
    const refused = await rpc("codehost.remotes", { path })
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe("CONTROL_INVALID_INPUT")
  }
  expect((await rpc("codehost.remotes", {})).body.error.code).toBe("CONTROL_INVALID_INPUT")
})

test("codehost.status reports gh's sign-in as a login only", async () => {
  const gh = await fakeGitHubCli()
  const repo = await repoWith({})
  const { rpc } = await startControl(repo, { githubCli: gh.script })

  await gh.reply("api", { stdout: JSON.stringify({ login: "octo-cat", id: 1, email: "private@example.com", name: "Octo" }) })
  const ready = await rpc("codehost.status", { host: "github.com" })
  expect(ready.body.result).toEqual({ state: "ready", login: "octo-cat" })
  expect((await gh.calls())[0]?.argv).toEqual(["api", "--hostname", "github.com", "user"])

  await gh.reply("api", { stderr: "To get started with GitHub CLI, please run:  gh auth login (private-host)", exitCode: 4 })
  const signedOut = await rpc("codehost.status", { host: "github.com" })
  expect(signedOut.body.result).toEqual({ state: "signed-out" })

  await gh.reply("api", { stderr: "connection refused to private-host", exitCode: 1 })
  const failed = await rpc("codehost.status", { host: "ghe.corp.example" })
  expect(failed.status).toBe(502)
  expect(JSON.stringify(failed.body)).not.toContain("private-host")

  expect((await rpc("codehost.status", { host: "a b" })).status).toBe(400)
  expect((await rpc("codehost.status", { host: "bitbucket.org" })).body.error.code).toBe("CONTROL_PR_UNAVAILABLE")
  const noGh = await startControl(repo, { githubCli: false })
  expect((await noGh.rpc("codehost.status", { host: "github.com" })).body.result).toEqual({ state: "missing" })
})

test("without a connection no gh runs; a certain GitLab remote is refused, a guessed one is not", async () => {
  const gh = await fakeGitHubCli()
  const accountsDir = await tempDir("runrail-codehosts-rule-")
  const github = await startControl(await repoWith({ origin: "git@github.com:example-org/widgets.git" }), { accountsDir, githubCli: gh.script })
  for (const method of ["git.pr.status", "git.pr.list"]) {
    const refused = await github.rpc(method)
    expect(refused.status).toBe(501)
    expect(refused.body.error).toMatchObject({ code: "CONTROL_PR_NOT_CONNECTED", message: "GitHub is not connected for github.com" })
  }
  expect(await gh.calls()).toEqual([])

  const gitlab = await startControl(await repoWith({ origin: "git@gitlab.com:group/sub/widgets.git" }), { accountsDir, githubCli: gh.script })
  const certain = await gitlab.rpc("git.pr.status")
  expect(certain.status).toBe(501)
  expect(certain.body.error).toMatchObject({ code: "CONTROL_PR_UNAVAILABLE", message: "pull requests for GitLab need a GitLab connector" })

  const guessed = await startControl(await repoWith({ origin: "https://gitlab.corp.example/example-org/widgets.git" }), { accountsDir, githubCli: gh.script })
  expect((await guessed.rpc("git.pr.status")).body.error.code).toBe("CONTROL_PR_NOT_CONNECTED")
  await guessed.rpc("codehost.set", { host: "gitlab.corp.example", service: "gitlab" })
  expect((await guessed.rpc("git.pr.status")).body.error.code).toBe("CONTROL_PR_UNAVAILABLE")
  expect(await gh.calls()).toEqual([])
})

const rollup = [
  { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci.example/build" },
  { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://ci.example/test" },
  { __typename: "StatusContext", context: "deploy", state: "FAILURE", targetUrl: "https://ci.example/deploy" },
  { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" },
  { __typename: "CheckRun", name: "slow", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "javascript:alert(1)" },
  { __typename: "StatusContext", context: "c".repeat(200), state: "PENDING" },
]

function pr(number: number, owner: string, fields: Record<string, unknown>) {
  return { number, url: `https://github.com/example-org/widgets/pull/${String(number)}`, title: `PR ${String(number)}`, state: "OPEN", isDraft: false, reviewDecision: "", mergeable: "UNKNOWN", baseRefName: "main", headRefName: "feature", headRepositoryOwner: { login: owner }, author: { login: owner }, updatedAt: "2026-10-04T10:00:00Z", mergedAt: null, closedAt: null, statusCheckRollup: [], ...fields }
}

test("git.pr.status through gh reads review, merge, and both check shapes, and drops another owner's branch", async () => {
  const gh = await fakeGitHubCli()
  const { rpc } = await startControl(await repoWith({ origin: "git@github.com:example-org/widgets.git" }), { githubCli: gh.script })
  await rpc("codehost.connect", { host: "github.com", via: "gh" })
  await gh.reply("pr-list", {
    stdout: JSON.stringify([
      pr(12, "example-org", { reviewDecision: "APPROVED", mergeable: "MERGEABLE", statusCheckRollup: rollup, headRefOid: "c".repeat(40) }),
      pr(11, "example-org", { headRefOid: "not a commit", state: "MERGED", reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", mergedAt: "2026-10-03T09:00:00Z", closedAt: "2026-10-03T09:00:00Z" }),
      pr(10, "someone", { isDraft: true }),
      pr(9, "EXAMPLE-ORG", { state: "CLOSED", isDraft: true, reviewDecision: "REVIEW_REQUIRED", closedAt: "2026-10-02T09:00:00Z" }),
    ]),
  })
  const status = await rpc("git.pr.status")
  expect(status.status).toBe(200)
  const result = status.body.result
  expect(result).toMatchObject({ owner: "example-org", repo: "widgets", remote: "origin", head: "feature", source: "gh" })
  expect(result.pullRequests.map((entry: { number: number }) => entry.number)).toEqual([12, 11, 9])
  expect(result.pullRequests[0]).toMatchObject({ state: "open", draft: false, review: "approved", mergeable: "yes", headCommit: "c".repeat(40) })
  expect(result.pullRequests[1].headCommit).toBeUndefined()
  expect(result.pullRequests[0].checks).toEqual({
    passed: 1,
    failed: 2,
    pending: 2,
    skipped: 2,
    items: [
      { name: "deploy", state: "failed", url: "https://ci.example/deploy" },
      { name: "slow", state: "failed" },
      { name: "test", state: "pending", url: "https://ci.example/test" },
      { name: "c".repeat(120), state: "pending" },
      { name: "CI / build", state: "passed", url: "https://ci.example/build" },
      { name: "docs", state: "skipped" },
      { name: "lint", state: "skipped" },
    ],
  })
  expect(result.pullRequests[1]).toMatchObject({ state: "merged", merged: true, review: "changes-requested", mergeable: "conflicts", mergedAt: Date.parse("2026-10-03T09:00:00Z") })
  expect(result.pullRequests[2]).toMatchObject({ state: "closed", draft: true, review: "required", mergeable: "unknown", closedAt: Date.parse("2026-10-02T09:00:00Z") })
  const argv = (await gh.calls())[0]?.argv ?? []
  expect(argv.slice(0, 11)).toEqual(["pr", "list", "--repo", "example-org/widgets", "--head", "feature", "--state", "all", "--limit", "10", "--json"])
  expect(argv[11]).toContain("statusCheckRollup")

  await rpc("git.pr.status", { state: "open" })
  expect((await gh.calls())[1]?.argv.slice(6, 8)).toEqual(["--state", "open"])
  expect((await rpc("git.pr.status", { state: "merged" })).status).toBe(400)

  await gh.reply("pr-list", { stdout: `[${"0,".repeat(600_000)}0]` })
  const oversized = await rpc("git.pr.status")
  expect(oversized.status).toBe(502)
  expect(oversized.body.error.code).toBe("CONTROL_PR_FAILED")

  await gh.reply("pr-list", { stderr: "GraphQL: Could not resolve to a Repository with the name 'example-org/private-name'", exitCode: 1 })
  const failed = await rpc("git.pr.status")
  expect(failed.status).toBe(502)
  expect(JSON.stringify(failed.body)).not.toContain("private-name")
})

test("on a fork, pull requests live on upstream and the head belongs to the fork's owner", async () => {
  const gh = await fakeGitHubCli()
  const repo = await repoWith({ origin: "git@github.com:me/widgets.git", upstream: "https://github.com/example-org/widgets.git" })
  const { rpc } = await startControl(repo, { githubCli: gh.script })
  await rpc("codehost.connect", { host: "github.com", via: "gh" })
  await gh.reply("pr-list", { stdout: JSON.stringify([pr(5, "me", {}), pr(4, "example-org", {})]) })
  const status = await rpc("git.pr.status")
  expect(status.body.result).toMatchObject({ owner: "example-org", repo: "widgets", remote: "upstream", pullRequests: [{ number: 5 }] })
  expect(status.body.result.pullRequests).toHaveLength(1)

  git(repo, "update-ref", "refs/remotes/origin/feature", "HEAD")
  await gh.reply("pr-create", { stdout: "https://github.com/example-org/widgets/pull/5\n" })
  const opened = await rpc("git.pr.create", { base: "main", title: "From my fork", confirm: true })
  expect(opened.status).toBe(200)
  const create = (await gh.calls()).find((call) => call.argv[1] === "create")
  expect(create?.argv.slice(0, 6)).toEqual(["pr", "create", "--repo", "example-org/widgets", "--head", "me:feature"])
})

test("git.pr.create through gh sends the body on stdin, never in argv, and reads the new pull request back", async () => {
  const gh = await fakeGitHubCli()
  const repo = await repoWith({ origin: "git@github.com:example-org/widgets.git" })
  const { rpc } = await startControl(repo, { githubCli: gh.script })
  await rpc("codehost.connect", { host: "github.com", via: "gh" })
  const body = "Private notes line one\n\nline two"

  expect((await rpc("git.pr.create", { base: "main", title: "Add widget", body })).status).toBe(428)
  const unpushed = await rpc("git.pr.create", { base: "main", title: "Add widget", body, confirm: true })
  expect(unpushed.status).toBe(409)
  expect(await gh.calls()).toEqual([])

  git(repo, "update-ref", "refs/remotes/origin/feature", "HEAD")
  await gh.reply("pr-create", { stdout: "Creating pull request for feature into main in example-org/widgets\n\nhttps://github.com/example-org/widgets/pull/42\n" })
  await gh.reply("pr-list", { stdout: JSON.stringify([pr(42, "example-org", { isDraft: true, title: "Add widget" })]) })
  const opened = await rpc("git.pr.create", { base: "main", title: "Add widget", body, draft: true, confirm: true })
  expect(opened.status).toBe(200)
  expect(opened.body.result).toMatchObject({ number: 42, url: "https://github.com/example-org/widgets/pull/42", state: "open", draft: true, title: "Add widget", owner: "example-org", repo: "widgets", remote: "origin", pushedCommit: git(repo, "rev-parse", "HEAD") })
  const [create] = await gh.calls()
  expect(create?.argv).toEqual(["pr", "create", "--repo", "example-org/widgets", "--head", "example-org:feature", "--base", "main", "--title", "Add widget", "--body-file", "-", "--draft"])
  expect(create?.stdin).toBe(body)
  expect(create?.argv.join(" ")).not.toContain("Private notes")

  await gh.reply("pr-create", { stdout: "something unexpected\n" })
  const odd = await rpc("git.pr.create", { base: "main", title: "Again", confirm: true })
  expect(odd.status).toBe(502)
  expect(odd.body.error.code).toBe("CONTROL_PR_FAILED")
})

test("a registered GitHub connector answers before a gh connection", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      paths.push(`${url.pathname}${url.search}`)
      return Response.json([{ number: 3, html_url: "https://github.com/example-org/widgets/pull/3", state: "closed", merged_at: "2026-10-01T00:00:00Z", draft: false, title: "Docs", head: { ref: "feature" }, base: { ref: "main" } }])
    },
  })
  cleanup.push(async () => { await server.stop(true) })
  const registry = createConnectorRegistry([createGitHubConnector({
    endpoint: server.url.toString(),
    allowRemote: false,
    credential: { reference: { kind: "caller", account: "fixture" }, resolver: createCallerConnectorCredentialResolver(() => "fixture-secret") },
  })])
  const gh = await fakeGitHubCli()
  const { rpc } = await startControl(await repoWith({ origin: "git@github.com:example-org/widgets.git" }), { githubCli: gh.script, connectorRegistry: registry })
  await rpc("codehost.connect", { host: "github.com", via: "gh" })
  const status = await rpc("git.pr.status")
  expect(status.body.result).toMatchObject({ source: "connector", pullRequests: [{ number: 3, state: "merged", merged: true }] })
  expect(paths[0]).toContain("head=example-org%3Afeature")
  expect(paths[0]).toContain("state=all")
  expect(await gh.calls()).toEqual([])
})

test("the connector list asks gh for the signed-in account, and never for the token", async () => {
  const gh = await fakeGitHubCli()
  const cwd = await tempDir("runrail-codehosts-connectors-")
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", authToken: token, loadExtensions: false, githubCli: gh.script, connectorsFile: join(cwd, "connectors.json"), nativeAccountsDir: join(cwd, "accounts"), model: { complete: () => ({ type: "text", text: "done" }) } })
  cleanup.push(() => running.handle.stop())
  const github = async (): Promise<{ connected: boolean } | undefined> => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "connector.setup.list", params: {} }) })
    return ((await response.json()) as { result: { connectors: { id: string; connected: boolean }[] } }).result.connectors.find((entry) => entry.id === "github")
  }
  await gh.reply("config", { stdout: "octo-cat\n" })
  expect(await github()).toMatchObject({ connected: true })
  await gh.reply("config", { stderr: "could not find key \"user\"\n", exitCode: 1 })
  expect(await github()).toMatchObject({ connected: false })
  const calls = await gh.calls()
  expect(calls.map((call) => call.argv)).toEqual([["config", "get", "-h", "github.com", "user"], ["config", "get", "-h", "github.com", "user"]])
  expect(calls.some((call) => call.argv.includes("token"))).toBe(false)
})
