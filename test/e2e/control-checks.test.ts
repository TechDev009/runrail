import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-checks-token-1234567890abcdef"
const cleanup: (() => Promise<void>)[] = []

setDefaultTimeout(30_000)

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Runrail Test", "-c", "user.email=test@runrail.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(`/tmp/${prefix}`)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function start() {
  const repo = await tempDir("runrail-checks-")
  git(repo, "init", "-q", "-b", "main")
  await writeFile(join(repo, "check.sh"), "echo checking in $(basename $(pwd))\nprintf ' 2 pass\\n 1 fail\\nRan 3 tests across 1 file.\\n'\nexit 1\n")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", "first")
  const running = await startRunrailControlRpcServer({
    cwd: repo,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    nativeAccountsDir: await tempDir("runrail-checks-accounts-"),
    model: { complete: () => ({ type: "text", text: "done" }) },
    worktreeRoot: await tempDir("runrail-checks-worktrees-"),
    githubCli: false,
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
  const health = (await (await fetch(`${running.handle.url}/health`)).json()) as { capabilityStatus: Record<string, string> }
  return { rpc, health }
}

test("check.run runs the command in the worktree and reads the runner's counts", async () => {
  const { rpc, health } = await start()
  expect(health.capabilityStatus.checks).toBe("available")
  expect((await rpc("worktree.create", { id: "wt-check" })).status).toBe(200)
  const run = await rpc("check.run", { id: "run-1", worktree: "wt-check", command: "sh check.sh", timeoutMs: 10_000 })
  expect(run.status).toBe(200)
  const result = run.body.result
  expect(result).toMatchObject({ id: "run-1", exitCode: 1, passed: false, timedOut: false, stopped: false, counts: { runner: "bun", passed: 2, failed: 1, total: 3 } })
  expect(result.tail).toStartWith("checking in wt-check")
})

test("check.run refuses outside a worktree of this project, and bad input before running", async () => {
  const { rpc } = await start()
  expect(await rpc("check.run", { id: "run-1", worktree: "missing", command: "true" })).toMatchObject({ status: 404, body: { error: { code: "CONTROL_CHECK_NOT_A_WORKTREE" } } })
  for (const params of [
    { worktree: "wt", command: "true" },
    { id: "../x", worktree: "wt", command: "true" },
    { id: "run", worktree: "../etc", command: "true" },
    { id: "run", worktree: "wt", command: "   " },
    { id: "run", worktree: "wt", command: "x".repeat(4_001) },
    { id: "run", worktree: "wt", command: "true", timeoutMs: 10 },
  ]) {
    const answer = await rpc("check.run", params)
    expect(answer.status, JSON.stringify(params).slice(0, 80)).toBe(400)
  }
  expect((await rpc("check.stop", { id: "nothing-running" })).body).toMatchObject({ result: { stopped: false } })
})
