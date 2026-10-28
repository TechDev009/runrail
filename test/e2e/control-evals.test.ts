import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-evals-token-1234567890abcdef"
const cleanup: (() => Promise<void>)[] = []

setDefaultTimeout(30_000)

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Runrail Test", "-c", "user.email=test@runrail.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(`/tmp/${prefix}`)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const SOLO = { id: "solo", name: "Solo", roles: { executor: { route: "codex", access: "auto-edit" } }, rules: { reviewRounds: 0 } }

async function start() {
  const repo = await tempDir("runrail-evals-")
  git(repo, "init", "-q", "-b", "main")
  await mkdir(join(repo, "src"))
  await writeFile(join(repo, "src", "a.js"), "export const a = 1\n")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", "first")
  await writeFile(join(repo, "src", "a.js"), "export const a = 2 // fixed\n")
  await mkdir(join(repo, "test"))
  await writeFile(join(repo, "test", "a.test.sh"), "grep -q fixed src/a.js\n")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", "Make a two")
  const home = await tempDir("runrail-evals-home-")
  const running = await startRunrailControlRpcServer({
    cwd: repo,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    nativeAccountsDir: await tempDir("runrail-evals-accounts-"),
    model: { complete: () => ({ type: "text", text: "done" }) },
    worktreeRoot: await tempDir("runrail-evals-worktrees-"),
    githubCli: false,
    setupsPath: join(home, "setups.json"),
    evalsDir: join(home, "evals"),
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
  return { rpc, health, repo, home }
}

test("evals: mine, validate, save a suite, run a setup against it, score it with the hidden tests", async () => {
  const { rpc, health, repo, home } = await start()
  expect(health.capabilityStatus.evals).toBe("available")
  const mined = (await rpc("eval.mine", { limit: 5 })).body.result
  expect(mined.candidates).toHaveLength(1)
  const [candidate] = mined.candidates
  expect(candidate).toMatchObject({ fix: git(repo, "rev-parse", "HEAD"), base: git(repo, "rev-parse", "HEAD^"), tests: ["test/a.test.sh"] })
  const { sources: _sources, ...item } = candidate
  expect((await rpc("eval.validate", { case: item, check: "sh {tests}" })).body.result).toEqual({ id: item.id, verdict: "valid" })
  expect(await rpc("eval.validate", { case: { ...item, tests: ["/etc/passwd"] }, check: "sh {tests}" })).toMatchObject({ status: 400, body: { error: { code: "CONTROL_EVAL_INVALID" } } })
  expect((await rpc("eval.suite.save", { suite: { name: "smoke", check: "sh {tests}", cases: [item] } })).status).toBe(200)
  expect((await rpc("eval.suites")).body.result).toEqual({ suites: [{ name: "smoke", cases: 1, check: "sh {tests}" }], skipped: [] })
  expect(await rpc("eval.run", { suite: "smoke", setupIds: ["missing"] })).toMatchObject({ status: 404, body: { error: { code: "CONTROL_SETUP_NOT_FOUND" } } })
  expect((await rpc("setup.save", { setup: SOLO })).status).toBe(200)
  expect(await rpc("eval.run", { suite: "smoke", setupIds: ["solo"], parallel: 9 })).toMatchObject({ status: 400, body: { error: { code: "CONTROL_INVALID_INPUT" } } })

  const started = (await rpc("eval.run", { suite: "smoke", setupIds: ["solo"], maxMinutes: 5 })).body.result
  expect(started).toMatchObject({ suite: "smoke", state: "running", cases: [item.id] })
  // Another eval may run beside it; this one is stopped before its case starts.
  const beside = (await rpc("eval.run", { suite: "smoke", setupIds: ["solo"] })).body.result
  expect(beside).toMatchObject({ state: "running" })
  expect((await rpc("eval.stop", { runId: beside.runId })).body.result.error).toMatchObject({ code: "EVAL_STOPPED" })

  // Play the desktop: the turn names the eval's worktree, which has no tests in it.
  let waiting: any
  for (let index = 0; index < 200 && waiting === undefined; index += 1) {
    waiting = (await rpc("setup.run.list")).body.result.runs.find((run: any) => run.waiting?.kind === "turn")
    if (waiting === undefined) await Bun.sleep(20)
  }
  const turn = waiting.waiting
  expect(turn.worktree.id).toStartWith("ev-")
  expect(turn.prompt).toContain("Make a two")
  expect(await Bun.file(join(turn.worktree.cwd, "test", "a.test.sh")).exists()).toBe(false)
  await writeFile(join(turn.worktree.cwd, "src", "a.js"), "export const a = 2 // fixed\n")
  expect((await rpc("setup.run.answer", { runId: waiting.runId, stepId: turn.stepId, ok: true, text: "done", worktree: turn.worktree.id })).status).toBe(200)

  let status = started
  for (let index = 0; index < 300 && status.state === "running"; index += 1) {
    await Bun.sleep(20)
    status = (await rpc("eval.status", { runId: started.runId })).body.result
  }
  expect(status.state).toBe("succeeded")
  expect(status.jobs).toMatchObject([{ caseId: item.id, setupId: "solo", state: "passed", setupState: "succeeded", check: { exitCode: 0 } }])
  expect((await rpc("eval.list")).body.result.runs.map((run: any) => run.runId).sort()).toEqual([started.runId, beside.runId].sort())
  const [project] = await readdir(join(home, "evals"))
  const kept = await readFile(join(home, "evals", project ?? "", started.runId, "results.jsonl"), "utf8")
  expect(kept).not.toContain("Make a two")
  expect(await rpc("eval.status", { runId: "eval-nope" })).toMatchObject({ status: 404, body: { error: { code: "CONTROL_EVAL_RUN_NOT_FOUND" } } })
})

test("an eval stops on request and its waiting setup run stops with it", async () => {
  const { rpc, repo } = await start()
  const [candidate] = (await rpc("eval.mine")).body.result.candidates
  const { sources: _sources, ...item } = candidate
  await rpc("eval.suite.save", { suite: { name: "smoke", check: "sh {tests}", cases: [item] } })
  await rpc("setup.save", { setup: SOLO })
  const started = (await rpc("eval.run", { suite: "smoke", setupIds: ["solo"], repeats: 2 })).body.result
  let runs: any[] = []
  for (let index = 0; index < 200 && runs.length === 0; index += 1) {
    runs = (await rpc("setup.run.list")).body.result.runs.filter((run: any) => run.state === "waiting")
    if (runs.length === 0) await Bun.sleep(20)
  }
  const stopped = (await rpc("eval.stop", { runId: started.runId })).body.result
  expect(stopped.error.code).toBe("EVAL_STOPPED")
  let status = stopped
  for (let index = 0; index < 200 && status.state === "running"; index += 1) {
    await Bun.sleep(20)
    status = (await rpc("eval.status", { runId: started.runId })).body.result
  }
  expect(status.state).toBe("stopped")
  expect(status.jobs.map((job: any) => job.state)).toEqual(["skipped", "skipped"])
  expect((await rpc("setup.run.list")).body.result.runs.map((run: any) => run.state)).toEqual(["stopped"])
  // The project's checkout is untouched: only the suite file is new.
  expect(git(repo, "status", "--porcelain")).toBe("?? .runrail/")
})
