import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createCallerConnectorCredentialResolver, createConnectorRegistry, createGitHubConnector, type ConnectorRegistry } from "../../src/connectors/index.ts"
import { previewGitPush, pushGitBranch } from "../../src/git/remote.ts"
import { runGit } from "../../src/git/run.ts"
import { probeGitRepository } from "../../src/git/status.ts"

const token = "control-push-token-1234567890abcdef"
const secret = "github-fixture-secret-value"
const cleanup: (() => Promise<void>)[] = []

// The push test starts over a hundred git processes. Past the 5 s default, Bun kills the in-flight
// git child (a spurious 500) and afterEach deletes the repos while the test body is still running.
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

function identity(repo: string): void {
  git(repo, "config", "user.name", "Runrail Test")
  git(repo, "config", "user.email", "test@runrail.invalid")
  git(repo, "config", "commit.gpgsign", "false")
}

async function commit(repo: string, file: string, text: string): Promise<string> {
  await writeFile(join(repo, file), text, "utf8")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", `edit ${file}`)
  return git(repo, "rev-parse", "HEAD")
}

/** Adds empty commits to the current branch with a single git process. */
function addCommits(repo: string, count: number): void {
  const parent = git(repo, "rev-parse", "HEAD")
  const branch = git(repo, "symbolic-ref", "HEAD")
  let stream = ""
  for (let index = 0; index < count; index++) {
    const message = `bulk ${index}\n`
    stream += `commit ${branch}\ncommitter Runrail Test <test@runrail.invalid> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}${index === 0 ? `from ${parent}\n` : ""}\n`
  }
  const result = Bun.spawnSync(["git", "fast-import", "--quiet"], { cwd: repo, stdin: new TextEncoder().encode(stream), stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git fast-import failed: ${result.stderr.toString()}`)
}

async function createRepo(): Promise<string> {
  const repo = await tempDir("runrail-control-push-")
  git(repo, "init", "-q", "-b", "main")
  identity(repo)
  await commit(repo, "a.txt", "one\n")
  return repo
}

async function startControl(cwd: string, connectorRegistry?: ConnectorRegistry) {
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    nativeAccountsDir: await tempDir("runrail-push-accounts-"),
    model: { complete: () => ({ type: "text", text: "done" }) },
    ...(connectorRegistry === undefined ? {} : { connectorRegistry }),
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

// Dozens of git round trips against a real bare remote; under heavy load this outran the 30 s default.
test("push previews exact commits, requires the matching confirmation, and never forces", async () => {
  const repo = await createRepo()
  const bare = await tempDir("runrail-control-push-bare-")
  git(bare, "init", "-q", "--bare", "-b", "main")
  git(repo, "remote", "add", "origin", bare)
  const { rpc, health } = await startControl(repo)
  expect(health.capabilityStatus["git.remote"]).toBe("available")
  expect(health.capabilityStatus["git.pr"]).toBe("available")

  const remotes = await rpc("git.remote.list")
  expect(remotes.body.result.remotes).toEqual([{ name: "origin", url: "local" }])

  const first = await rpc("git.push.preview")
  expect(first.status).toBe(200)
  expect(first.body.result).toMatchObject({ remote: "origin", branch: "main", localBranch: "main", newBranch: true, setUpstream: true, ahead: 1, commitsTruncated: false })
  expect(first.body.result.commits).toHaveLength(1)
  expect(first.body.result.confirmation).toMatch(/^[0-9a-f]{32}$/)

  const missing = await rpc("git.push")
  expect(missing.status).toBe(400)
  const wrong = await rpc("git.push", { confirmation: "0".repeat(32) })
  expect(wrong.status).toBe(409)
  expect(wrong.body.error.code).toBe("CONTROL_GIT_CONFLICT")
  expect(git(bare, "for-each-ref", "--format=%(refname)")).toBe("")

  const created = await rpc("git.push", { confirmation: first.body.result.confirmation })
  expect(created.status).toBe(200)
  expect(created.body.result).toMatchObject({ remote: "origin", branch: "main", outcome: "created", upstreamSet: true, status: { branch: "main", upstream: "origin/main", ahead: 0 } })
  expect(git(bare, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"))
  expect(JSON.stringify(created.body)).not.toContain(bare)

  const second = await commit(repo, "b.txt", "two\n")
  const next = await rpc("git.push.preview")
  expect(next.body.result).toMatchObject({ newBranch: false, setUpstream: false, ahead: 1, head: second })
  expect(next.body.result.commits[0]).toMatchObject({ commit: second, summary: "edit b.txt" })
  const pushed = await rpc("git.push", { confirmation: next.body.result.confirmation })
  expect(pushed.body.result).toMatchObject({ outcome: "pushed", upstreamSet: false })
  expect(git(bare, "rev-parse", "main")).toBe(second)

  const idle = await rpc("git.push.preview")
  expect(idle.body.result.ahead).toBe(0)
  const same = await rpc("git.push", { confirmation: idle.body.result.confirmation })
  expect(same.body.result.outcome).toBe("up-to-date")

  // A preview goes stale when HEAD moves after it was shown.
  const stale = await rpc("git.push.preview")
  await commit(repo, "c.txt", "three\n")
  const refused = await rpc("git.push", { confirmation: stale.body.result.confirmation })
  expect(refused.status).toBe(409)
  expect(refused.body.error.message).toContain("stale")
  expect(git(bare, "rev-parse", "main")).toBe(second)

  // Another clone moves the remote; the local push is rejected instead of forced.
  const other = await tempDir("runrail-control-push-other-")
  git(other, "clone", "-q", bare, ".")
  identity(other)
  const theirs = await commit(other, "theirs.txt", "theirs\n")
  git(other, "push", "-q", "origin", "main")
  const diverged = await rpc("git.push.preview")
  const rejected = await rpc("git.push", { confirmation: diverged.body.result.confirmation })
  expect(rejected.status).toBe(409)
  expect(rejected.body.error.code).toBe("CONTROL_GIT_CONFLICT")
  expect(git(bare, "rev-parse", "main")).toBe(theirs)

  for (const params of [{ remote: "../escape" }, { remote: "-x" }, { branch: "a..b" }, { branch: "bad branch" }, { branch: "x.lock" }]) {
    const response = await rpc("git.push.preview", params)
    expect(response.status).toBe(400)
  }
  expect((await rpc("git.push.preview", { remote: "missing" })).status).toBe(404)

  git(repo, "checkout", "-q", "--detach")
  const detached = await rpc("git.push.preview")
  expect(detached.status).toBe(409)
}, 90_000)

test("push preview counts long pushes and reads the checked-out branch and its upstream exactly", async () => {
  const repo = await createRepo()
  const bare = await tempDir("runrail-control-push-bare-")
  git(bare, "init", "-q", "--bare", "-b", "main")
  git(repo, "remote", "add", "origin", bare)
  // With a same-named tag, `symbolic-ref --short` names the branch `heads/main`.
  git(repo, "tag", "main")
  addCommits(repo, 55)
  const { rpc } = await startControl(repo)

  const long = await rpc("git.push.preview")
  expect(long.body.result).toMatchObject({ localBranch: "main", branch: "main", newBranch: true, ahead: 56, commitsTruncated: true })
  expect(long.body.result.commits).toHaveLength(50)
  expect(long.body.result.commits[0].commit).toBe(git(repo, "rev-parse", "HEAD"))
  const created = await rpc("git.push", { confirmation: long.body.result.confirmation })
  expect(created.body.result).toMatchObject({ branch: "main", outcome: "created" })

  // `+` is a regex operator for `git config --get-regexp`; the upstream must still be found.
  git(repo, "checkout", "-q", "-b", "feat+x")
  git(repo, "config", "branch.feat+x.remote", "origin")
  git(repo, "config", "branch.feat+x.merge", "refs/heads/main")
  await commit(repo, "d.txt", "four\n")
  const upstream = await rpc("git.push.preview")
  expect(upstream.status).toBe(200)
  expect(upstream.body.result).toMatchObject({ localBranch: "feat+x", branch: "main", newBranch: false, setUpstream: false, ahead: 1, commitsTruncated: false })
})

test("pull requests require confirmation, a pushed head, and a configured GitHub connector", async () => {
  const requests: { method: string; path: string; authorization: string; body: string }[] = []
  const pull = { number: 7, html_url: "https://github.com/example-org/widgets/pull/7", state: "open", draft: true, title: "Add widget", head: { ref: "feature" }, base: { ref: "main" }, merged_at: null }
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = await request.text()
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization") ?? "", body })
      if (request.method === "POST" && url.pathname === "/repos/example-org/widgets/pulls") {
        if ((JSON.parse(body) as { title: string }).title === "fail") return Response.json({ message: "Validation Failed" }, { status: 422 })
        return Response.json(pull, { status: 201 })
      }
      if (request.method === "GET" && url.pathname === "/repos/example-org/widgets/pulls") return Response.json(url.searchParams.get("head") === "example-org:feature" ? [pull] : [])
      return Response.json({ message: "Not Found" }, { status: 404 })
    },
  })
  cleanup.push(async () => { await server.stop(true) })
  const registry = createConnectorRegistry([createGitHubConnector({
    endpoint: server.url.toString(),
    allowRemote: false,
    credential: { reference: { kind: "caller", account: "fixture" }, resolver: createCallerConnectorCredentialResolver(() => secret) },
  })])

  const repo = await createRepo()
  git(repo, "remote", "add", "origin", "git@github.com:example-org/widgets.git")
  git(repo, "remote", "add", "upstream", "https://someone:hunter2-token@github.com/example-org/other.git")
  git(repo, "checkout", "-q", "-b", "feature")
  await commit(repo, "feature.txt", "feature\n")
  const { rpc, health } = await startControl(repo, registry)
  expect(health.capabilityStatus["git.pr"]).toBe("available")

  const remotes = await rpc("git.remote.list")
  expect(remotes.body.result.remotes).toEqual([
    { name: "origin", url: "github.com:example-org/widgets.git", host: "github.com", owner: "example-org", repo: "widgets", path: "example-org/widgets", service: "github", serviceFrom: "host" },
    { name: "upstream", url: "https://github.com/example-org/other.git", host: "github.com", owner: "example-org", repo: "other", path: "example-org/other", service: "github", serviceFrom: "host" },
  ])
  expect(JSON.stringify(remotes.body)).not.toContain("hunter2")

  const unconfirmed = await rpc("git.pr.create", { base: "main", title: "Add widget" })
  expect(unconfirmed.status).toBe(428)
  expect(unconfirmed.body.error.code).toBe("CONTROL_CONFIRMATION_REQUIRED")
  const unpushed = await rpc("git.pr.create", { base: "main", title: "Add widget", confirm: true })
  expect(unpushed.status).toBe(409)
  expect(unpushed.body.error.message).toContain("push the branch")
  expect(requests).toHaveLength(0)

  git(repo, "update-ref", "refs/remotes/origin/feature", "HEAD")
  const opened = await rpc("git.pr.create", { base: "main", title: "Add widget", body: "Line one\n\nLine two", draft: true, confirm: true })
  expect(opened.status).toBe(200)
  expect(opened.body.result).toMatchObject({ number: 7, url: pull.html_url, state: "open", draft: true, merged: false, head: "feature", base: "main", owner: "example-org", repo: "widgets", remote: "origin" })
  expect(requests[0]).toMatchObject({ method: "POST", path: "/repos/example-org/widgets/pulls", authorization: `Bearer ${secret}` })
  expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ title: "Add widget", head: "feature", base: "main", body: "Line one\n\nLine two", draft: true })
  expect(JSON.stringify(opened.body)).not.toContain(secret)

  const status = await rpc("git.pr.status")
  expect(status.status).toBe(200)
  expect(status.body.result).toMatchObject({ owner: "example-org", repo: "widgets", head: "feature", pullRequests: [{ number: 7, draft: true }] })
  expect(requests[1]?.path).toContain("head=example-org%3Afeature")

  for (const params of [
    { title: "Add widget", confirm: true },
    { base: "main", title: "two\nlines", confirm: true },
    { base: "feature", title: "Same branch", confirm: true },
    { base: "main", title: "Bad owner", owner: "../x", repo: "widgets", confirm: true },
    { base: "main", title: "Bad body", body: 42, confirm: true },
  ]) {
    const response = await rpc("git.pr.create", params)
    expect(response.status).toBe(400)
  }

  const failed = await rpc("git.pr.create", { base: "main", title: "fail", confirm: true })
  expect(failed.status).toBe(502)
  expect(failed.body.error.code).toBe("CONTROL_PR_FAILED")
  expect(JSON.stringify(failed.body)).not.toContain("Validation Failed")

  const bare = await createRepo()
  git(bare, "remote", "add", "origin", "git@github.com:example-org/widgets.git")
  git(bare, "checkout", "-q", "-b", "feature")
  const noConnector = await startControl(bare)
  const unavailable = await noConnector.rpc("git.pr.create", { base: "main", title: "x", confirm: true })
  expect(unavailable.status).toBe(501)
  expect(unavailable.body.error).toMatchObject({ code: "CONTROL_PR_NOT_CONNECTED", message: "GitHub is not connected for github.com" })
})

test("a commit made after the confirmed preview is never published", async () => {
  const repo = await createRepo()
  const remote = await tempDir("runrail-push-race-remote-")
  git(remote, "init", "-q", "--bare")
  git(repo, "remote", "add", "origin", remote)
  const target = { remote: "origin", branch: "main" }
  const repository = await probeGitRepository(repo)
  const preview = await previewGitPush(repository, target)
  let late = ""
  // Something commits between the re-checked preview and the push itself.
  const racing: typeof runGit = async (options) => {
    if (options.args[0] === "push" && late === "") late = await commit(repo, "late.txt", "not reviewed\n")
    return runGit(options)
  }
  const pushed = await pushGitBranch(repository, { ...target, confirmation: preview.confirmation, runHooks: false }, racing)
  expect(pushed).toMatchObject({ commit: preview.head, outcome: "created", upstreamSet: true })
  expect(late).not.toBe("")
  expect(git(remote, "rev-parse", "refs/heads/main")).toBe(preview.head)
  expect(git(repo, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main")
})

test("a confirmation stops working once the remote's push destination changes", async () => {
  const repo = await createRepo()
  const reviewed = await tempDir("runrail-push-reviewed-")
  const other = await tempDir("runrail-push-other-")
  git(reviewed, "init", "-q", "--bare")
  git(other, "init", "-q", "--bare")
  git(repo, "remote", "add", "origin", reviewed)
  const target = { remote: "origin", branch: "main" }
  const repository = await probeGitRepository(repo)
  const changes: ReadonlyArray<{ readonly apply: () => void; readonly undo: () => void }> = [
    { apply: () => git(repo, "remote", "set-url", "origin", other), undo: () => git(repo, "remote", "set-url", "origin", reviewed) },
    { apply: () => git(repo, "config", "remote.origin.pushurl", other), undo: () => git(repo, "config", "--unset", "remote.origin.pushurl") },
    { apply: () => git(repo, "config", `url.${other}.pushInsteadOf`, reviewed), undo: () => git(repo, "config", "--remove-section", `url.${other}`) },
  ]
  for (const change of changes) {
    const preview = await previewGitPush(repository, target)
    change.apply()
    await expect(pushGitBranch(repository, { ...target, confirmation: preview.confirmation, runHooks: false })).rejects.toMatchObject({ code: "GIT_CONFLICT" })
    change.undo()
  }
  git(repo, "config", "--add", "remote.origin.pushurl", "https://user:hidden-secret@example.invalid/o/r.git")
  git(repo, "config", "--add", "remote.origin.pushurl", reviewed)
  expect((await previewGitPush(repository, target)).pushUrls).toEqual(["https://example.invalid/o/r.git", "local"])
  git(repo, "config", "--unset-all", "remote.origin.pushurl")
  expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: other }).exitCode).not.toBe(0)
  const preview = await previewGitPush(repository, target)
  await expect(pushGitBranch(repository, { ...target, confirmation: preview.confirmation, runHooks: false })).resolves.toMatchObject({ outcome: "created" })
  expect(git(reviewed, "rev-parse", "refs/heads/main")).toBe(preview.head)
})
