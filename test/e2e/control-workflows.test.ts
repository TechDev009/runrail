import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-workflows-token-1234567890abcdef"
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

async function start(home: string) {
  const repo = await tempDir("runrail-workflows-")
  git(repo, "init", "-q", "-b", "main")
  await writeFile(join(repo, "a.txt"), "a\n")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", "first")
  const running = await startRunrailControlRpcServer({
    cwd: repo,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    nativeAccountsDir: await tempDir("runrail-workflows-accounts-"),
    model: { complete: () => ({ type: "text", text: "done" }) },
    worktreeRoot: await tempDir("runrail-workflows-worktrees-"),
    githubCli: false,
    setupsPath: join(home, "setups.json"),
    workflowsPath: join(home, "workflows.json"),
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
  // The engine names its project by its real path (`/tmp` is `/private/tmp` on macOS).
  return { rpc, health, repo: await realpath(repo) }
}

const role = { route: "codex", access: "auto-edit" }

test("workflows: save, propose from a message, a proposal refuses to run until approved, and every project's list for the scheduler", async () => {
  const home = await tempDir("runrail-workflows-home-")
  const { rpc, health, repo } = await start(home)
  expect(health.capabilityStatus.workflows).toBe("available")
  const saved = (await rpc("workflow.save", { workflow: { id: "nightly", name: "Nightly bumps", state: "on", trigger: { kind: "schedule", schedule: { kind: "weekdays", hour: 2, minute: 0 } }, steps: [{ id: "bump", kind: "agent", title: "Bump", prompt: "Bump the dependencies.", runsOn: role }] } })).body.result
  expect(saved).toMatchObject({ id: "nightly", state: "on", root: repo, runs: [] })
  const upcoming = (await rpc("workflow.upcoming")).body.result
  expect(upcoming).toMatchObject({ armed: 1, next: { workflowId: "nightly", name: "Nightly bumps", root: repo } })
  expect(upcoming.next.at).toBeGreaterThan(Date.now() - 1_000)
  expect(await rpc("workflow.save", { workflow: { id: "x", name: "X", steps: [{ id: "s", kind: "setup", title: "S", setupId: "missing", task: "t" }] } })).toMatchObject({ status: 404, body: { error: { code: "CONTROL_SETUP_NOT_FOUND" } } })

  const message = 'I fixed the same flaky test twice.\n\n```json\n{"workflow": {"id": "nightly", "name": "Fix flaky tests weekly", "trigger": {"kind": "schedule", "schedule": {"kind": "weekly", "day": 1, "hour": 9, "minute": 0}}, "steps": [{"id": "find", "kind": "agent", "title": "Find flaky tests", "prompt": "Run the tests five times."}]}}\n```'
  const proposed = (await rpc("workflow.propose", { message, thread: "fix the build", runsOn: role })).body.result
  expect(proposed).toMatchObject({ id: "nightly-2", state: "proposed", proposedBy: { thread: "fix the build" }, steps: [{ runsOn: { route: "codex" } }] })
  expect(await rpc("workflow.run.start", { id: "nightly-2" })).toMatchObject({ status: 409, body: { error: { code: "CONTROL_WORKFLOW_PROPOSED" } } })
  expect(await rpc("workflow.enable", { id: "nightly-2", on: true })).toMatchObject({ status: 409, body: { error: { code: "CONTROL_WORKFLOW_PROPOSED" } } })
  // A proposal is never due, whatever its trigger says.
  expect((await rpc("workflow.due")).body.result).toEqual({ due: [] })
  expect((await rpc("workflow.approve", { id: "nightly-2" })).body.result).toMatchObject({ state: "on" })
  expect((await rpc("workflow.enable", { id: "nightly", on: false })).body.result).toMatchObject({ state: "off" })
  // Only the approved proposal starts by itself now; reading changes nothing that is due.
  expect((await rpc("workflow.upcoming")).body.result).toMatchObject({ armed: 1, next: { workflowId: "nightly-2" } })
  expect((await rpc("workflow.due")).body.result).toEqual({ due: [] })

  // Another project's engine sees its own list empty, and every project's with `all`.
  const other = await start(home)
  expect((await other.rpc("workflow.list")).body.result.workflows).toEqual([])
  expect((await other.rpc("workflow.list", { all: true })).body.result.workflows.map((item: any) => [item.id, item.root])).toEqual([
    ["nightly", repo],
    ["nightly-2", repo],
  ])
  expect((await rpc("workflow.delete", { id: "nightly" })).body.result).toEqual({ deleted: true })
})

test("workflows: a webhook trigger is armed but never due, and only its runs take what a webhook sent", async () => {
  const home = await tempDir("runrail-workflows-home-")
  const { rpc } = await start(home)
  const saved = (await rpc("workflow.save", { workflow: { id: "alert", name: "On an alert", state: "on", where: "checkout", trigger: { kind: "webhook" }, steps: [{ id: "say", kind: "action", title: "Tell me", action: "notify", text: "Got it" }] } })).body.result
  expect(saved).toMatchObject({ id: "alert", trigger: { kind: "webhook" } })
  expect((await rpc("workflow.upcoming")).body.result).toEqual({ armed: 1 })
  expect((await rpc("workflow.due")).body.result).toEqual({ due: [] })
  expect(await rpc("workflow.run.start", { id: "alert", input: "hi" })).toMatchObject({ status: 400, body: { error: { code: "CONTROL_INVALID_INPUT", message: "input comes only with a webhook trigger" } } })
  expect(await rpc("workflow.run.start", { id: "alert", trigger: "webhook", input: "x".repeat(16_385) })).toMatchObject({ status: 400, body: { error: { code: "CONTROL_INVALID_INPUT" } } })
  expect(await rpc("workflow.run.start", { id: "alert", trigger: "hook" })).toMatchObject({ status: 400 })
  const started = (await rpc("workflow.run.start", { id: "alert", trigger: "webhook", input: '{"alert": "disk full"}\u0000' })).body.result
  expect(started).toMatchObject({ workflowId: "alert", trigger: "webhook" })
  expect(JSON.stringify(started)).not.toContain("disk full")
})

test("workflows: a run's agent step is a setup run the desktop answers, in the checkout, and the run's record keeps no text", async () => {
  const home = await tempDir("runrail-workflows-home-")
  const { rpc } = await start(home)
  await rpc("workflow.save", {
    workflow: {
      id: "check-in",
      name: "Check in",
      where: "checkout",
      steps: [
        { id: "look", kind: "agent", title: "Look around", prompt: "Say hello.", runsOn: role },
        { id: "tests", kind: "check", title: "Run the check", command: "test -f a.txt", repeat: 2 },
        { id: "ok", kind: "approval", title: "Approve" },
        { id: "say", kind: "action", title: "Tell me", action: "notify", text: "Checked in" },
      ],
    },
  })
  const started = (await rpc("workflow.run.start", { id: "check-in" })).body.result
  expect(started).toMatchObject({ workflowId: "check-in", trigger: "manual", state: "running" })

  let turn: any
  for (let tries = 0; tries < 200 && turn === undefined; tries += 1) {
    turn = (await rpc("setup.run.list")).body.result.runs.find((run: any) => run.waiting?.kind === "turn")
    if (turn === undefined) await Bun.sleep(20)
  }
  expect(turn).toMatchObject({ owner: { kind: "workflow", runId: started.runId, name: "Check in" }, waiting: { prompt: "Say hello.", checkout: true, role: "executor" } })
  await rpc("setup.run.answer", { runId: turn.runId, stepId: turn.waiting.stepId, ok: true, text: "Hello." })

  let status: any
  for (let tries = 0; tries < 200; tries += 1) {
    status = (await rpc("workflow.run.status", { runId: started.runId })).body.result
    if (status.waiting !== undefined) break
    await Bun.sleep(20)
  }
  expect(status).toMatchObject({ state: "waiting", waiting: { kind: "approve", stepId: "ok" } })
  expect(status.steps.find((step: any) => step.id === "tests")).toMatchObject({ status: "done", note: "passed 2 of 2" })
  expect(await rpc("workflow.run.answer", { runId: started.runId, stepId: "nope", approved: true })).toMatchObject({ status: 409, body: { error: { code: "CONTROL_WORKFLOW_RUN_NOT_WAITING" } } })
  await rpc("workflow.run.answer", { runId: started.runId, stepId: "ok", approved: true })
  for (let tries = 0; tries < 200 && status.state !== "succeeded"; tries += 1) {
    status = (await rpc("workflow.run.status", { runId: started.runId })).body.result
    await Bun.sleep(20)
  }
  expect(status).toMatchObject({ state: "succeeded", notices: [{ stepId: "say", text: "Checked in" }] })
  expect((await rpc("workflow.run.list")).body.result.runs.map((run: any) => run.runId)).toEqual([started.runId])

  const [record] = (await rpc("workflow.get", { id: "check-in" })).body.result.runs
  expect(record).toMatchObject({ runId: started.runId, state: "succeeded", steps: [{ id: "look", status: "done" }, { id: "tests", status: "done", note: "passed 2 of 2" }, { id: "ok", status: "done" }, { id: "say", status: "done" }] })
  expect(JSON.stringify(record)).not.toContain("Hello")
})
