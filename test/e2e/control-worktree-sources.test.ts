import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createCallerConnectorCredentialResolver, createConnectorRegistry, createGitHubConnector, type ConnectorRegistry } from "../../src/connectors/index.ts"

const token = "control-sources-token-1234567890abcdef"
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

async function commit(repo: string, file: string, text: string, at: number): Promise<string> {
  await writeFile(join(repo, file), text, "utf8")
  git(repo, "add", "--all")
  const date = `${at} +0000`
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `edit ${file}`], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`git commit failed: ${result.stderr.toString()}`)
  return git(repo, "rev-parse", "HEAD")
}

async function createRepo(prefix = "runrail-sources-"): Promise<string> {
  const repo = await tempDir(prefix)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Runrail Test")
  git(repo, "config", "user.email", "test@runrail.invalid")
  git(repo, "config", "commit.gpgsign", "false")
  await commit(repo, "a.txt", "one\n", 1_700_000_000)
  return repo
}

async function startControl(cwd: string, extra: { readonly connectorRegistry?: ConnectorRegistry; readonly githubCli?: string | false } = {}) {
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    nativeAccountsDir: await tempDir("runrail-sources-accounts-"),
    model: { complete: () => ({ type: "text", text: "done" }) },
    worktreeRoot: await tempDir("runrail-sources-worktrees-"),
    githubCli: extra.githubCli ?? false,
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

/** A project whose `origin` is a bare repository holding a branch and a GitHub-style pull request ref. */
async function projectWithRemote() {
  const repo = await createRepo()
  const bare = await tempDir("runrail-sources-bare-")
  git(bare, "init", "-q", "--bare", "-b", "main")
  git(repo, "remote", "add", "origin", bare)
  git(repo, "push", "-q", "origin", "main")
  const other = await tempDir("runrail-sources-other-")
  git(other, "clone", "-q", bare, ".")
  git(other, "config", "user.name", "Other")
  git(other, "config", "user.email", "other@runrail.invalid")
  git(other, "checkout", "-q", "-b", "feat+x")
  const topic = await commit(other, "topic.txt", "topic\n", 1_700_000_300)
  git(other, "push", "-q", "origin", "feat+x")
  git(other, "checkout", "-q", "-b", "contributor", "main")
  const pull = await commit(other, "pull.txt", "pull\n", 1_700_000_400)
  git(other, "push", "-q", "origin", "contributor:refs/pull/12/head")
  return { repo, topic, pull }
}

test("git.branches lists local and remote-tracking branches newest first, without a remote's HEAD", async () => {
  const { repo } = await projectWithRemote()
  git(repo, "fetch", "-q", "origin")
  git(repo, "remote", "set-head", "origin", "main")
  git(repo, "checkout", "-q", "-b", "older", "main")
  git(repo, "checkout", "-q", "-b", "newest")
  await commit(repo, "b.txt", "two\n", 1_700_000_500)
  git(repo, "branch", "--set-upstream-to=origin/main", "older")
  const { rpc, health } = await startControl(repo)
  expect(health.capabilityStatus["git.branches"]).toBe("available")
  expect(health.capabilityStatus["git.fetch"]).toBe("available")

  const listed = await rpc("git.branches")
  expect(listed.status).toBe(200)
  const result = listed.body.result
  expect(result.current).toBe("newest")
  expect(result.local.map((branch: { name: string }) => branch.name)).toEqual(["newest", "main", "older"])
  expect(result.local[0]).toMatchObject({ updatedAt: 1_700_000_500_000 })
  expect(result.local.find((branch: { name: string }) => branch.name === "older")).toMatchObject({ upstream: "origin/main" })
  expect(result.remote.map((branch: { remote: string; name: string }) => `${branch.remote}/${branch.name}`)).toEqual(["origin/feat+x", "origin/main"])
  expect(result.truncated).toBe(false)

  const cut = await rpc("git.branches", { maxBranches: 2 })
  expect(cut.body.result.local.map((branch: { name: string }) => branch.name)).toEqual(["newest", "main"])
  expect(cut.body.result.remote).toHaveLength(2)
  expect(cut.body.result.truncated).toBe(true)

  for (const maxBranches of [0, 501, 1.5, "10"]) {
    const rejected = await rpc("git.branches", { maxBranches })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.code).toBe("CONTROL_GIT_INVALID")
  }
})

test("git.fetch brings one branch or pull request, and a worktree starts from it", async () => {
  const { repo, topic, pull } = await projectWithRemote()
  const { rpc } = await startControl(repo)

  const branch = await rpc("git.fetch", { branch: "feat+x" })
  expect(branch.status).toBe(200)
  expect(branch.body.result).toEqual({ remote: "origin", revision: "refs/remotes/origin/feat+x", commit: topic, branch: "feat+x" })

  const pr = await rpc("git.fetch", { remote: "origin", pullRequest: 12 })
  expect(pr.status).toBe(200)
  expect(pr.body.result).toEqual({ remote: "origin", revision: "refs/runrail/pull/origin/12", commit: pull, pullRequest: 12 })
  // Only the named refs were fetched: no tags, and no other branch.
  expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes", "refs/runrail", "refs/tags").split("\n")).toEqual(["refs/remotes/origin/feat+x", "refs/remotes/origin/main", "refs/runrail/pull/origin/12"])

  const worktree = await rpc("worktree.create", { id: "pr-12", revision: pr.body.result.revision, branch: "review/pr-12" })
  expect(worktree.status).toBe(200)
  expect(worktree.body.result).toMatchObject({ id: "pr-12", head: pull, branch: "review/pr-12" })
})

test("git.fetch refuses unclear or unknown sources with stable codes", async () => {
  const { repo } = await projectWithRemote()
  const { rpc } = await startControl(repo)
  for (const params of [{}, { branch: "main", pullRequest: 1 }, { branch: "-delete" }, { branch: "a:b" }, { branch: "x..y" }, { pullRequest: 0 }, { pullRequest: "12" }, { remote: "../x", branch: "main" }]) {
    const rejected = await rpc("git.fetch", params)
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.code).toBe("CONTROL_GIT_INVALID")
  }
  const missing = await rpc("git.fetch", { branch: "no-such-branch" })
  expect(missing.status).toBe(404)
  expect(missing.body.error.code).toBe("CONTROL_GIT_NOT_FOUND")
  expect(missing.body.error.message).not.toContain("/tmp")
  const noPull = await rpc("git.fetch", { pullRequest: 999 })
  expect(noPull.body.error.code).toBe("CONTROL_GIT_NOT_FOUND")
  const noRemote = await rpc("git.fetch", { remote: "upstream", branch: "main" })
  expect(noRemote.status).toBe(404)
  expect(noRemote.body.error.code).toBe("CONTROL_GIT_NOT_FOUND")
})

/** A stand-in `gh` that records its argv and environment, then prints `stdout` or fails with `stderr`. */
async function fakeGitHubCli(output: { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }) {
  const dir = await tempDir("runrail-sources-gh-")
  const log = join(dir, "argv")
  const reply = join(dir, "reply")
  await writeFile(reply, output.stdout ?? "", "utf8")
  const script = join(dir, "gh")
  await writeFile(script, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${log}'`,
    `printf 'GH_TOKEN=%s\\nGH_PROMPT_DISABLED=%s\\n' "\${GH_TOKEN:-unset}" "\${GH_PROMPT_DISABLED:-unset}" >> '${log}'`,
    `cat '${reply}'`,
    output.stderr === undefined ? "" : `printf '%s\\n' '${output.stderr}' >&2`,
    `exit ${output.exitCode ?? 0}`,
  ].join("\n"), "utf8")
  await chmod(script, 0o755)
  return { script, argv: async () => (await readFile(log, "utf8")).trim().split("\n") }
}

test("git.pr.list asks the person's own gh once they connect it, never hands it a token, and keeps only well-formed entries", async () => {
  const repo = await createRepo()
  git(repo, "remote", "add", "origin", "git@github.com:example-org/widgets.git")
  const gh = await fakeGitHubCli({
    stdout: JSON.stringify([
      { number: 12, title: "Faster search", headRefName: "fast-search", baseRefName: "main", author: { login: "octo-cat", name: "Octo" }, isDraft: true, updatedAt: "2026-10-01T08:00:00Z", url: "https://github.com/example-org/widgets/pull/12" },
      { number: 9, title: "x".repeat(400), headRefName: "y", baseRefName: "main", author: { login: "bad login!" }, isDraft: false, updatedAt: "soon", url: "javascript:alert(1)" },
      { number: -1, title: "not a pull request" },
      "junk",
    ]),
  })
  const saved = process.env.GH_TOKEN
  process.env.GH_TOKEN = "gh-token-must-not-leak"
  try {
    const { rpc, health } = await startControl(repo, { githubCli: gh.script })
    expect(health.capabilityStatus["git.pr.list"]).toBe("available")
    const notConnected = await rpc("git.pr.list", { limit: 5 })
    expect(notConnected.status).toBe(501)
    expect(notConnected.body.error.code).toBe("CONTROL_PR_NOT_CONNECTED")
    expect((await rpc("codehost.connect", { host: "github.com", via: "gh" })).status).toBe(200)
    const listed = await rpc("git.pr.list", { limit: 5 })
    expect(listed.status).toBe(200)
    expect(listed.body.result).toEqual({
      owner: "example-org",
      repo: "widgets",
      remote: "origin",
      source: "gh",
      pullRequests: [
        { number: 12, url: "https://github.com/example-org/widgets/pull/12", state: "open", draft: true, merged: false, title: "Faster search", head: "fast-search", base: "main", author: "octo-cat", updatedAt: Date.parse("2026-10-01T08:00:00Z") },
        { number: 9, state: "open", draft: false, merged: false, title: "x".repeat(256), head: "y", base: "main" },
      ],
    })
    const argv = await gh.argv()
    expect(argv.slice(0, 9)).toEqual(["pr", "list", "--repo", "example-org/widgets", "--state", "open", "--limit", "5", "--json"])
    expect(argv).toContain("GH_TOKEN=unset")
    expect(argv).toContain("GH_PROMPT_DISABLED=1")
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved
  }
})

test("git.pr.list says what is missing: a connection, gh, its sign-in, or a valid limit", async () => {
  const repo = await createRepo()
  git(repo, "remote", "add", "origin", "https://github.com/example-org/widgets.git")

  const none = await startControl(repo)
  expect(none.health.capabilityStatus["git.pr.list"]).toBe("available")
  const notConnected = await none.rpc("git.pr.list")
  expect(notConnected.status).toBe(501)
  expect(notConnected.body.error).toMatchObject({ code: "CONTROL_PR_NOT_CONNECTED", message: "GitHub is not connected for github.com" })
  const noGh = await none.rpc("codehost.connect", { host: "github.com", via: "gh" })
  expect(noGh.status).toBe(501)
  expect(noGh.body.error.code).toBe("CONTROL_PR_UNAVAILABLE")

  const signedOut = await fakeGitHubCli({ stderr: "To get started with GitHub CLI, please run:  gh auth login (example-secret-host)", exitCode: 4 })
  const { rpc } = await startControl(repo, { githubCli: signedOut.script })
  await rpc("codehost.connect", { host: "github.com", via: "gh" })
  const credentials = await rpc("git.pr.list")
  expect(credentials.status).toBe(501)
  expect(credentials.body.error.code).toBe("CONTROL_PR_CREDENTIALS")
  expect(JSON.stringify(credentials.body)).not.toContain("example-secret-host")

  for (const limit of [0, 101, "5"]) {
    const rejected = await rpc("git.pr.list", { limit })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error.code).toBe("CONTROL_INVALID_INPUT")
  }
})

test("git.pr.list uses a registered GitHub connector before gh", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      paths.push(`${url.pathname}${url.search}`)
      return Response.json([{ number: 3, html_url: "https://github.com/example-org/widgets/pull/3", state: "open", draft: false, title: "Docs", head: { ref: "docs" }, base: { ref: "main" }, user: { login: "writer" }, updated_at: "2026-09-30T10:00:00Z", merged_at: null }])
    },
  })
  cleanup.push(async () => { await server.stop(true) })
  const registry = createConnectorRegistry([createGitHubConnector({
    endpoint: server.url.toString(),
    allowRemote: false,
    credential: { reference: { kind: "caller", account: "fixture" }, resolver: createCallerConnectorCredentialResolver(() => "fixture-secret") },
  })])
  const repo = await createRepo()
  git(repo, "remote", "add", "origin", "git@github.com:example-org/widgets.git")
  const gh = await fakeGitHubCli({ stdout: "[]" })
  const { rpc } = await startControl(repo, { connectorRegistry: registry, githubCli: gh.script })
  await rpc("codehost.connect", { host: "github.com", via: "gh" })
  const listed = await rpc("git.pr.list")
  expect(listed.status).toBe(200)
  expect(listed.body.result).toMatchObject({ source: "connector", pullRequests: [{ number: 3, head: "docs", author: "writer", updatedAt: Date.parse("2026-09-30T10:00:00Z") }] })
  expect(paths[0]).toBe("/repos/example-org/widgets/pulls?state=open&per_page=30")
})
