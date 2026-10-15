import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-pull-token-1234567890abcdef"
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

/** A clone tracking `origin/main`, and a second clone that moves the remote ahead. */
async function clones() {
  const bare = await tempDir("runrail-pull-bare-")
  git(bare, "init", "-q", "--bare", "-b", "main")
  const seed = await tempDir("runrail-pull-seed-")
  git(seed, "clone", "-q", bare, ".")
  identity(seed)
  await commit(seed, "a.txt", "one\n")
  git(seed, "push", "-q", "origin", "main")
  const repo = await tempDir("runrail-pull-repo-")
  git(repo, "clone", "-q", bare, ".")
  identity(repo)
  return { bare, seed, repo }
}

async function startControl(cwd: string) {
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", authToken: token, loadExtensions: false, githubCli: false, model: { complete: () => ({ type: "text", text: "done" }) } })
  cleanup.push(() => running.handle.stop())
  return async (method: string, params: Readonly<Record<string, unknown>> = {}): Promise<{ readonly status: number; readonly body: any }> => {
    const response = await fetch(`${running.handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
}

test("git.pull fast-forwards to the upstream, and says when there is nothing to pull", async () => {
  const { seed, repo } = await clones()
  const before = git(repo, "rev-parse", "HEAD")
  await commit(seed, "b.txt", "two\n")
  const tip = await commit(seed, "c.txt", "three\n")
  git(seed, "push", "-q", "origin", "main")
  const rpc = await startControl(repo)

  const pulled = await rpc("git.pull")
  expect(pulled.status).toBe(200)
  expect(pulled.body.result).toMatchObject({ remote: "origin", branch: "main", upstream: "origin/main", from: before, to: tip, pulled: 2, outcome: "fast-forwarded" })
  expect(pulled.body.result.status.branch).toBe("main")
  expect(git(repo, "rev-parse", "HEAD")).toBe(tip)

  const again = await rpc("git.pull")
  expect(again.body.result).toMatchObject({ pulled: 0, outcome: "up-to-date", from: tip, to: tip })
})

test("git.pull refuses diverged branches, local changes in the way, and branches with no upstream", async () => {
  const { seed, repo } = await clones()
  await commit(seed, "a.txt", "remote edit\n")
  git(seed, "push", "-q", "origin", "main")
  const rpc = await startControl(repo)

  await writeFile(join(repo, "a.txt"), "local edit\n", "utf8")
  const dirty = await rpc("git.pull")
  expect(dirty.status).toBe(409)
  expect(dirty.body.error).toMatchObject({ code: "CONTROL_GIT_CONFLICT", message: "local changes would be overwritten; commit or stash them first" })
  expect(git(repo, "status", "--porcelain")).toBe("M a.txt")

  git(repo, "checkout", "-q", "--", "a.txt")
  await commit(repo, "local.txt", "mine\n")
  const diverged = await rpc("git.pull")
  expect(diverged.status).toBe(409)
  expect(diverged.body.error.code).toBe("CONTROL_GIT_DIVERGED")

  git(repo, "checkout", "-q", "-b", "solo")
  const lone = await rpc("git.pull")
  expect(lone.status).toBe(409)
  expect(lone.body.error).toMatchObject({ code: "CONTROL_GIT_CONFLICT", message: "the branch has no upstream; publish it first" })

  const bad = await rpc("git.pull", { runHooks: "yes" })
  expect(bad.status).toBe(400)
  expect(bad.body.error.code).toBe("CONTROL_GIT_INVALID")
})

test("git.diff statsOnly counts what the patch path counts, builds no patch, and never reads a credential file", async () => {
  const { repo } = await clones()
  await writeFile(join(repo, "a.txt"), "one\nchanged\nmore\n", "utf8")
  await writeFile(join(repo, "new.txt"), "x\ny\nz\n", "utf8")
  await writeFile(join(repo, ".env"), "TOKEN=1\nOTHER=2\n", "utf8")
  const rpc = await startControl(repo)

  const full = await rpc("git.diff", { scope: "head", includeUntracked: true })
  const stats = await rpc("git.diff", { scope: "head", includeUntracked: true, statsOnly: true })
  expect(stats.status).toBe(200)
  expect(stats.body.result.totals).toEqual(full.body.result.totals)
  expect(stats.body.result.totals).toEqual({ files: 3, additions: 5, deletions: 0 })
  expect(stats.body.result.files.some((file: { patch?: string }) => file.patch !== undefined)).toBe(false)
  expect(stats.body.result.files.find((file: { path: string }) => file.path === ".env")).toMatchObject({ additions: 0, sensitive: true })
  expect(stats.body.result.truncated).toBe(false)

  const cut = await rpc("git.diff", { scope: "head", includeUntracked: true, statsOnly: true, maxBytes: 1_024, maxFileBytes: 1_024 })
  expect(cut.body.result.truncated).toBe(false)
  await writeFile(join(repo, "big.txt"), "line\n".repeat(400), "utf8")
  const over = await rpc("git.diff", { scope: "head", includeUntracked: true, statsOnly: true, maxBytes: 1_024, maxFileBytes: 1_024 })
  expect(over.body.result.truncated).toBe(true)

  const refused = await rpc("git.diff", { statsOnly: 1 })
  expect(refused.status).toBe(400)
})

test("a review fetch follows the remote's service: GitLab's ref on an unknown host, and none on Bitbucket", async () => {
  const { seed, repo } = await clones()
  git(seed, "checkout", "-q", "-b", "feature")
  const head = await commit(seed, "mr.txt", "merge request\n")
  git(seed, "push", "-q", "origin", "feature:refs/merge-requests/5/head")
  git(repo, "remote", "add", "bb", "git@bitbucket.org:team/widgets.git")
  const rpc = await startControl(repo)

  const fetched = await rpc("git.fetch", { pullRequest: 5 })
  expect(fetched.status).toBe(200)
  expect(fetched.body.result).toEqual({ remote: "origin", revision: "refs/runrail/pull/origin/5", commit: head, pullRequest: 5 })

  const bitbucket = await rpc("git.fetch", { remote: "bb", pullRequest: 1 })
  expect(bitbucket.status).toBe(400)
  expect(bitbucket.body.error.message).toContain("source branch")

  const remotes = await rpc("git.remote.list")
  expect(remotes.body.result.remotes).toEqual([
    { name: "bb", url: "bitbucket.org:team/widgets.git", host: "bitbucket.org", owner: "team", repo: "widgets", path: "team/widgets", service: "bitbucket", serviceFrom: "host" },
    { name: "origin", url: "local" },
  ])
})
