import { expect, test } from "bun:test"
import type { CheckResult } from "../../src/check/run.ts"
import { parseSetup } from "../../src/setups/schema.ts"
import { SetupRuns, type SetupTurnPort, type SetupTurnRequest } from "../../src/setups/runner.ts"

const block = (value: unknown): string => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
const PLAN = block({ summary: "two steps", steps: [{ title: "Add the parser" }, { title: "Add tests", detail: "cover blank lines" }] })
const CLEAN = block({ findings: [] })
const BLOCKING = block({ findings: [{ severity: "high", title: "Off by one", path: "src/a.ts", line: 3 }] })

const setup = (rules: Record<string, unknown> = {}) =>
  parseSetup({
    id: "per",
    name: "Plan, execute, review",
    roles: { planner: { route: "claude-code" }, executor: { route: "codex", access: "auto-edit" }, reviewer: { route: "claude-code" } },
    rules: { approvePlan: false, reviewRounds: 1, ...rules },
  })

function passed(pass: boolean): CheckResult {
  return { id: "c", passed: pass, ...(pass ? { exitCode: 0 } : { exitCode: 1 }), timedOut: false, stopped: false, durationMs: 5, tail: pass ? "ok" : "(fail) blank lines", truncated: false }
}

/** Answers each role from its script; records what was asked. */
function scripted(script: Partial<Record<SetupTurnRequest["role"], readonly string[]>>, failOn?: SetupTurnRequest["role"]) {
  const asked: SetupTurnRequest[] = []
  const used: Record<string, number> = {}
  const port: SetupTurnPort = {
    turn: async (_runId, request) => {
      asked.push(request)
      if (request.role === failOn) return { ok: false, error: "the tool stopped" }
      const at = used[request.role] ?? 0
      used[request.role] = at + 1
      const lines = script[request.role] ?? ["done"]
      return { ok: true, text: lines[Math.min(at, lines.length - 1)], worktree: "wt-run" }
    },
  }
  return { port, asked }
}

async function settle(runs: SetupRuns, runId: string) {
  for (let index = 0; index < 200; index += 1) {
    const status = runs.status(runId)
    if (status.state !== "running" && status.state !== "waiting") return status
    await Bun.sleep(5)
  }
  throw new Error("run did not settle")
}

test("plan, two steps checked, a clean review: succeeded, in that order, with read-only planner and reviewer", async () => {
  const checks: string[] = []
  const runs = new SetupRuns({ check: async (input) => (checks.push(`${input.worktree}:${input.command}`), passed(true)) })
  const { port, asked } = scripted({ planner: [PLAN], reviewer: [CLEAN] })
  const started = runs.start(setup({ check: "bun test" }), "Skip blank lines", port)
  const done = await settle(runs, started.runId)
  expect(done.state).toBe("succeeded")
  expect(done.turns).toBe(4)
  expect(done.worktree).toBe("wt-run")
  expect(done.plan?.steps.map((step) => step.title)).toEqual(["Add the parser", "Add tests"])
  expect(done.steps.map((step) => `${step.kind}:${step.status}`)).toEqual(["plan:done", "step:done", "check:done", "step:done", "check:done", "review:done"])
  expect(checks).toEqual(["wt-run:bun test", "wt-run:bun test"])
  expect(asked.map((request) => `${request.role}:${request.mode}:${request.access}`)).toEqual(["planner:plan:ask", "executor:agent:auto-edit", "executor:agent:auto-edit", "reviewer:plan:ask"])
  // One thread per role: the executor's steps continue one thread.
  expect(new Set(asked.filter((request) => request.role === "executor").map((request) => request.thread)).size).toBe(1)
  expect(asked[1]?.prompt).toContain("Do step 1 of 2: Add the parser")
  expect(asked[2]?.prompt).toContain("cover blank lines")
})

test("a run in the checkout asks for its turns there and runs its check in the project's folder", async () => {
  const checks: (string | undefined)[] = []
  const runs = new SetupRuns({ check: async (input) => (checks.push(input.worktree), passed(true)) })
  const asked: SetupTurnRequest[] = []
  const port: SetupTurnPort = {
    turn: async (_runId, request) => {
      asked.push(request)
      return { ok: true, text: request.role === "planner" ? block({ steps: [{ title: "Only step" }] }) : request.role === "reviewer" ? CLEAN : "done" }
    },
  }
  const done = await settle(runs, runs.start(setup({ check: "bun test" }), "task", port, { checkout: true }).runId)
  expect(done).toMatchObject({ state: "succeeded", checkout: true })
  expect(done.worktree).toBeUndefined()
  expect(done.steps.map((step) => `${step.kind}:${step.status}`)).toEqual(["plan:done", "step:done", "check:done", "review:done"])
  expect(checks).toEqual([undefined])
  expect(asked.every((request) => request.checkout === true && request.worktree === undefined)).toBe(true)
})

test("an eval's run checks in the checkout it was given, and its one step is named by the task's first line", async () => {
  const checks: string[] = []
  const runs = new SetupRuns({ check: async (input) => (checks.push(`${String(input.worktree)}|${String(input.cwd)}`), passed(true)) })
  const { port } = scripted({})
  const planless = parseSetup({ id: "x", name: "Executor only", roles: { executor: { route: "codex", access: "auto-edit" } }, rules: { reviewRounds: 0, check: "bun test" } })
  const task = `${"Collapse runs of separators ".repeat(12)}\n\nThe body says more.`
  const done = await settle(runs, runs.start(planless, task, port, { worktree: { id: "ev-1-0", path: "/evals/run/work/ev-1-0", cwd: "/evals/run/work/ev-1-0/pkg" } }).runId)
  expect(done.state).toBe("succeeded")
  expect(checks).toEqual(["undefined|/evals/run/work/ev-1-0/pkg"])
  const title = done.steps[0]?.title ?? ""
  expect(title.startsWith("1. Collapse runs of separators")).toBe(true)
  expect(title.length).toBeLessThanOrEqual(203)
  expect(title).not.toContain("body says")
})

test("a failing check gets one fix turn with the log, then is checked again", async () => {
  const results = [passed(false), passed(true)]
  const runs = new SetupRuns({ check: async () => results.shift() ?? passed(true) })
  const { port, asked } = scripted({ planner: [block({ steps: [{ title: "Only step" }] })], reviewer: [CLEAN] })
  const done = await settle(runs, runs.start(setup({ check: "bun test" }), "task", port).runId)
  expect(done.state).toBe("succeeded")
  expect(done.steps.map((step) => `${step.kind}:${step.status}`)).toEqual(["plan:done", "step:done", "check:failed", "fix:done", "check:done", "review:done"])
  expect(asked.find((request) => request.prompt.startsWith("The check `bun test` failed"))?.prompt).toContain("(fail) blank lines")
})

test("a run whose last check still fails ends failed, not succeeded", async () => {
  const runs = new SetupRuns({ check: async () => passed(false) })
  const { port } = scripted({ planner: [block({ steps: [{ title: "Only step" }] })], reviewer: [CLEAN] })
  const done = await settle(runs, runs.start(setup({ check: "bun test" }), "task", port).runId)
  expect(done.state).toBe("failed")
  expect(done.error?.code).toBe("SETUP_CHECK_FAILED")
})

test("review rounds stop at the setup's limit", async () => {
  const runs = new SetupRuns({ check: async () => passed(true) })
  const { port, asked } = scripted({ planner: [block({ steps: [{ title: "s" }] })], reviewer: [BLOCKING] })
  const done = await settle(runs, runs.start(setup({ reviewRounds: 2 }), "task", port).runId)
  expect(done.state).toBe("succeeded")
  expect(asked.filter((request) => request.role === "reviewer")).toHaveLength(2)
  expect(asked.filter((request) => request.prompt.startsWith("A review of your changes found these"))).toHaveLength(2)
  expect(asked.find((request) => request.prompt.startsWith("A review"))?.prompt).toContain("[high] Off by one (src/a.ts:3)")
})

test("a plan without its block is asked for once more, then the run fails", async () => {
  const runs = new SetupRuns({ check: async () => passed(true) })
  const { port, asked } = scripted({ planner: ["no block here"] })
  const done = await settle(runs, runs.start(setup(), "task", port).runId)
  expect(done).toMatchObject({ state: "failed", error: { code: "SETUP_PLAN_FORMAT" } })
  expect(asked).toHaveLength(2)
})

test("approval: the person's edit is used; a send-back revises; a decline ends the run", async () => {
  const runs = new SetupRuns({ check: async () => passed(true) })
  const { port, asked } = scripted({ planner: [PLAN, block({ steps: [{ title: "Revised" }] })], reviewer: [CLEAN] })
  const runId = runs.start(setup({ approvePlan: true }), "task", port).runId
  let status = await waitFor(runs, runId, "approve")
  status = runs.answer(runId, status.waiting?.stepId ?? "", { approved: false, feedback: "fewer steps" })
  status = await waitFor(runs, runId, "approve")
  expect(asked[asked.length - 1]?.prompt).toContain("fewer steps")
  expect(status.waiting?.kind === "approve" ? status.waiting.plan.steps.map((step) => step.title) : []).toEqual(["Revised"])
  runs.answer(runId, status.waiting?.stepId ?? "", { approved: true, plan: { steps: [{ title: "Edited by the person" }] } })
  const done = await settle(runs, runId)
  expect(done.state).toBe("succeeded")
  expect(asked.find((request) => request.role === "executor")?.prompt).toContain("Edited by the person")

  const declined = runs.start(setup({ approvePlan: true }), "task", scripted({ planner: [PLAN] }).port).runId
  const waiting = await waitFor(runs, declined, "approve")
  runs.answer(declined, waiting.waiting?.stepId ?? "", { approved: false })
  expect(await settle(runs, declined)).toMatchObject({ state: "failed", error: { code: "SETUP_PLAN_DECLINED" } })
})

test("the turn budget, a failed turn, and stop", async () => {
  const runs = new SetupRuns({ check: async () => passed(true) })
  const budget = await settle(runs, runs.start(setup({ budget: { maxTurns: 2 } }), "task", scripted({ planner: [PLAN] }).port).runId)
  expect(budget).toMatchObject({ state: "failed", error: { code: "SETUP_BUDGET" }, turns: 2 })

  const failed = await settle(runs, runs.start(setup(), "task", scripted({ planner: [PLAN] }, "executor").port).runId)
  expect(failed).toMatchObject({ state: "failed", error: { code: "SETUP_TURN_FAILED" } })

  const pending = runs.start(setup(), "task")
  await waitFor(runs, pending.runId, "turn")
  expect((await runs.stop(pending.runId)).state).toBe("stopped")
  expect(() => runs.answer(pending.runId, "1-1", { ok: true })).toThrow("not waiting")
})

test("the pending port: a turn waits in the status until the desktop answers it", async () => {
  const runs = new SetupRuns({ check: async () => passed(true) })
  const runId = runs.start(parseSetup({ id: "solo", name: "Solo", roles: { executor: { route: "native" } }, rules: { reviewRounds: 0 } }), "Rename the flag").runId
  const status = await waitFor(runs, runId, "turn")
  expect(status.waiting).toMatchObject({ kind: "turn", role: "executor", mode: "agent", access: "ask", prompt: "Rename the flag" })
  expect(() => runs.answer(runId, "wrong", { ok: true })).toThrow("not waiting")
  runs.answer(runId, status.waiting?.stepId ?? "", { ok: true, text: "done", worktree: "wt-1" })
  expect(await settle(runs, runId)).toMatchObject({ state: "succeeded", worktree: "wt-1", turns: 1 })
})

async function waitFor(runs: SetupRuns, runId: string, kind: "turn" | "approve") {
  for (let index = 0; index < 200; index += 1) {
    const status = runs.status(runId)
    if (status.waiting?.kind === kind) return status
    if (status.state !== "running" && status.state !== "waiting") throw new Error(`run ended: ${status.state}`)
    await Bun.sleep(5)
  }
  throw new Error(`run did not wait for ${kind}`)
}
