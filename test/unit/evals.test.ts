import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckRuns } from "../../src/check/run.ts"
import { checkFor, isTestPath, mineCandidates, validateCase, type EvalCase } from "../../src/evals/mine.ts"
import { EvalRuns } from "../../src/evals/run.ts"
import { EvalError, parseSuite, SuiteStore } from "../../src/evals/suite.ts"
import { runGit } from "../../src/git/run.ts"
import { ThreadWorktrees } from "../../src/git/worktrees.ts"
import { runHeadlessEval } from "../../src/evals/headless.ts"
import type { RunrailSession } from "../../src/session.ts"
import { SetupRuns, type SetupTurnRequest } from "../../src/setups/runner.ts"
import { parseSetup } from "../../src/setups/schema.ts"

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "runrail-evals-test-"))
  cleanup.push(path)
  return path
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } })
  const out = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`)
  return out.trim()
}

async function commit(root: string, files: Record<string, string | null>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(root, path))
    else {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), content)
    }
  }
  await git(root, "add", "-A")
  await git(root, "commit", "-q", "-m", message)
  return git(root, "rev-parse", "HEAD")
}

/**
 * A repository whose history has one good case (`fixed`), one whose test already passes before
 * (`always`), and commits that are not cases: tests only, source only.
 */
async function repository(): Promise<{ readonly root: string; readonly fixed: string; readonly always: string }> {
  const root = join(await scratch(), "repo")
  await mkdir(root)
  await git(root, "init", "-q", "-b", "main")
  await commit(root, { "src/a.js": "export const a = 1\n" }, "start")
  const fixed = await commit(root, { "src/a.js": "export const a = 2 // fixed\n", "test/a.test.sh": "grep -q fixed src/a.js\n" }, "Make a two\n\nThe value of a is two.")
  await commit(root, { "test/b.test.sh": "true\n" }, "tests only")
  await commit(root, { "src/b.js": "export const b = 1\n" }, "source only")
  const always = await commit(root, { "src/b.js": "export const b = 2\n", "test/c.test.sh": "true\n" }, "b is two")
  return { root, fixed, always }
}

const CHECK = "sh {tests}"

test("test paths and the {tests} placeholder", () => {
  for (const path of ["test/a.ts", "src/__tests__/a.js", "a.test.tsx", "pkg/foo_test.go", "tests/test_x.py", "spec/x.rb"]) expect(isTestPath(path)).toBe(true)
  for (const path of ["src/a.ts", "src/testing.ts", "docs/tests.md"]) expect(isTestPath(path)).toBe(false)
  expect(checkFor("bun test {tests}", ["test/a b.ts", "test/it's.ts"])).toBe("bun test 'test/a b.ts' 'test/it'\\''s.ts'")
  expect(checkFor("bun test", ["test/a.ts"])).toBe("bun test")
})

test("mining keeps commits that change tests and source, newest first, ids and paths only", async () => {
  const { root, fixed, always } = await repository()
  const found = await mineCandidates({ root, limit: 10 })
  expect(found.map((item) => item.fix)).toEqual([always, fixed])
  expect(found[1]).toEqual({ id: fixed.slice(0, 12), base: await git(root, "rev-parse", `${fixed}^`), fix: fixed, tests: ["test/a.test.sh"], sources: 1 })
  expect(await mineCandidates({ root, limit: 1 })).toHaveLength(1)
})

test("a case is valid only when its tests fail at the base and pass at the fix; the scratch worktree is gone after", async () => {
  const { root } = await repository()
  const checks = new CheckRuns()
  const run = (input: { readonly cwd: string; readonly command: string }) => checks.run({ id: "v", cwd: input.cwd, command: input.command, timeoutMs: 30_000 })
  const [always, fixed] = await mineCandidates({ root, limit: 10 })
  expect(await validateCase(fixed as EvalCase, { root, check: CHECK, run })).toBe("valid")
  expect(await validateCase(always as EvalCase, { root, check: CHECK, run })).toBe("passes-before")
  expect(await validateCase(fixed as EvalCase, { root, check: "false", run })).toBe("fails-after")
  expect((await git(root, "worktree", "list")).split("\n")).toHaveLength(1)
})

test("suites: parsed strictly, saved as YAML, listed with bad files skipped", async () => {
  const root = await scratch()
  const base = "a".repeat(40)
  const fix = "b".repeat(40)
  const item = { id: "c1", base, fix, tests: ["test/a.ts"] }
  expect(() => parseSuite({ check: "bun test", cases: [item] }, "Bad Name")).toThrow(EvalError)
  expect(() => parseSuite({ check: "bun test", cases: [{ ...item, tests: ["../escape.ts"] }] }, "s")).toThrow("outside the repository")
  expect(() => parseSuite({ check: "bun test", cases: [item, item] }, "s")).toThrow("unique id")
  expect(() => parseSuite({ check: "bun test", cases: [{ ...item, fix: "HEAD" }] }, "s")).toThrow("full base and fix")
  const store = new SuiteStore(root)
  expect(await store.list()).toEqual({ suites: [], skipped: [] })
  await store.save({ name: "smoke", check: "  bun test {tests}  ", cases: [item] })
  const text = await readFile(join(root, ".runrail", "evals", "smoke.yaml"), "utf8")
  expect(text.startsWith("# A Runrail eval suite.")).toBe(true)
  expect(await store.get("smoke")).toEqual({ name: "smoke", check: "bun test {tests}", cases: [item] })
  await writeFile(join(root, ".runrail", "evals", "broken.yaml"), "check: [\n")
  expect(await store.list()).toEqual({ suites: [{ name: "smoke", cases: 1, check: "bun test {tests}" }], skipped: ["broken.yaml"] })
  await expect(store.get("missing")).rejects.toMatchObject({ code: "EVAL_NOT_FOUND" })
})

const executorOnly = parseSetup({ id: "solo", name: "Solo", roles: { executor: { route: "codex", access: "auto-edit" } }, rules: { approvePlan: false, reviewRounds: 0 } })

/** Plays the desktop: answers each waiting turn, writing the fix into the turn's worktree when told to. */
function desktop(setupRuns: SetupRuns, fix: (cwd: string, prompt: string) => Promise<void>): () => void {
  let stopped = false
  const seen = new Set<string>()
  void (async () => {
    while (!stopped) {
      for (const run of setupRuns.list()) {
        const waiting = run.waiting
        if (waiting?.kind !== "turn" || seen.has(`${run.runId}:${waiting.stepId}`)) continue
        seen.add(`${run.runId}:${waiting.stepId}`)
        expect(waiting.worktree).toBeDefined()
        await fix(waiting.worktree?.cwd ?? "", waiting.prompt)
        setupRuns.answer(run.runId, waiting.stepId, { ok: true, text: "done", worktree: waiting.worktree?.id })
      }
      await Bun.sleep(10)
    }
  })()
  return () => {
    stopped = true
  }
}

async function evalHarness(maxRuns?: number) {
  const { root, fixed, always } = await repository()
  const home = await scratch()
  const checks = new CheckRuns()
  const worktrees = new ThreadWorktrees({ root, baseDir: join(home, "worktrees") })
  const setupRuns = new SetupRuns({ check: async () => Promise.reject(new Error("no setup check")), ...(maxRuns === undefined ? {} : { maxRuns }) })
  const evals = new EvalRuns({
    root,
    dir: join(home, "evals"),
    setupRuns,
    check: (input) => checks.run({ ...input, timeoutMs: 30_000 }),
    stopCheck: (id) => checks.stop(id),
    retryMs: 20,
  })
  const [, item] = await mineCandidates({ root, limit: 10 })
  return { root, home, fixed, always, checks, worktrees, setupRuns, evals, item: item as EvalCase }
}

async function finished(evals: EvalRuns, runId: string) {
  for (let index = 0; index < 1_000; index += 1) {
    const status = evals.status(runId)
    if (status.state !== "running") return status
    await Bun.sleep(10)
  }
  throw new Error("eval did not finish")
}

test("an eval hides the tests, gives the fix commit's message as the task, and scores with the tests restored", async () => {
  const h = await evalHarness()
  const prompts: string[] = []
  const seenTests: boolean[] = []
  const fixVisible: boolean[] = []
  const stop = desktop(h.setupRuns, async (cwd, prompt) => {
    prompts.push(prompt)
    seenTests.push(await Bun.file(join(cwd, "test/a.test.sh")).exists())
    // The checkout holds the base commit alone: the fix and its tests cannot be read from git.
    fixVisible.push(Bun.spawnSync(["git", "cat-file", "-e", h.item.fix], { cwd }).exitCode === 0)
    // One of two repeats does the work.
    if (prompts.length === 1) await writeFile(join(cwd, "src/a.js"), "export const a = 2 // fixed\n")
  })
  try {
    const started = h.evals.start({ suite: { name: "s", check: CHECK, cases: [h.item] }, setups: [executorOnly], repeats: 2, parallel: 1, maxMinutes: 5 })
    const done = await finished(h.evals, started.runId)
    expect(done.state).toBe("succeeded")
    expect(done.jobs.map((job) => job.state)).toEqual(["passed", "failed"])
    expect(done.jobs[0]).toMatchObject({ caseId: h.item.id, setupId: "solo", repeat: 1, setupState: "succeeded", turns: 1, check: { exitCode: 0, timedOut: false } })
    expect(seenTests).toEqual([false, false])
    expect(fixVisible).toEqual([false, false])
    expect(await readdir(join(h.home, "evals", started.runId, "work")).catch(() => [])).toEqual([])
    expect(prompts[0]).toContain("Make a two")
    expect(prompts[0]).toContain("The value of a is two.")
    const dir = join(h.home, "evals", started.runId)
    const lines = (await readFile(join(dir, "results.jsonl"), "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    // D19: no task, prompt or answer text in what is kept.
    const kept = `${lines.join("\n")}${await readFile(join(dir, "run.json"), "utf8")}`
    expect(kept).not.toContain("Make a two")
    expect(kept).not.toContain("done")
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ case: h.item.id, setup: "solo", repeat: 1, state: "passed" })
    const listed = await new EvalRuns({ root: h.root, dir: join(h.home, "evals"), setupRuns: h.setupRuns, check: () => Promise.reject(new Error("unused")) }).list()
    expect(listed.map((run) => [run.runId, run.state, run.jobs.length])).toEqual([[started.runId, "succeeded", 2]])
  } finally {
    stop()
  }
})

test("an eval runs unattended: its plan is not held for approval and its executor works at Full access", async () => {
  const h = await evalHarness()
  const careful = parseSetup({ id: "careful", name: "Careful", roles: { planner: { route: "claude-code" }, executor: { route: "claude-code", access: "ask" } }, rules: { approvePlan: true, reviewRounds: 0 } })
  const asked: string[] = []
  const seen = new Set<string>()
  let stopped = false
  void (async () => {
    while (!stopped) {
      for (const run of h.setupRuns.list()) {
        const waiting = run.waiting
        if (waiting === undefined || seen.has(`${run.runId}:${waiting.stepId}`)) continue
        seen.add(`${run.runId}:${waiting.stepId}`)
        if (waiting.kind !== "turn") {
          asked.push(waiting.kind)
          continue
        }
        asked.push(`${waiting.role}:${waiting.access}`)
        if (waiting.role === "executor") await writeFile(join(waiting.worktree?.cwd ?? "", "src/a.js"), "export const a = 2 // fixed\n")
        const text = waiting.role === "planner" ? `Plan.\n\n\`\`\`json\n${JSON.stringify({ steps: [{ title: "Make a two" }] })}\n\`\`\`` : "done"
        h.setupRuns.answer(run.runId, waiting.stepId, { ok: true, text, worktree: waiting.worktree?.id })
      }
      await Bun.sleep(10)
    }
  })()
  try {
    const started = h.evals.start({ suite: { name: "s", check: CHECK, cases: [h.item] }, setups: [careful], repeats: 1, parallel: 1, maxMinutes: 5 })
    const done = await finished(h.evals, started.runId)
    expect(done.jobs.map((job) => job.state)).toEqual(["passed"])
    expect(asked).toEqual(["planner:ask", "executor:full"])
  } finally {
    stopped = true
  }
})

test("an eval stops at its minutes budget and skips what is left; four evals at a time", async () => {
  const h = await evalHarness()
  const started = h.evals.start({ suite: { name: "s", check: CHECK, cases: [h.item] }, setups: [executorOnly], repeats: 3, parallel: 1, maxMinutes: 0.01 })
  const others = [1, 2, 3].map(() => h.evals.start({ suite: { name: "s", check: CHECK, cases: [h.item] }, setups: [executorOnly], repeats: 1, parallel: 1, maxMinutes: 5 }).runId)
  expect(() => h.evals.start({ suite: { name: "s", check: CHECK, cases: [h.item] }, setups: [executorOnly], repeats: 1, parallel: 1, maxMinutes: 5 })).toThrow("4 evals are already running")
  for (const runId of others) await h.evals.stop(runId)
  for (const runId of others) expect((await finished(h.evals, runId)).state).toBe("stopped")
  const done = await finished(h.evals, started.runId)
  expect(done.state).toBe("stopped")
  expect(done.error?.code).toBe("EVAL_BUDGET")
  expect(done.jobs.map((job) => job.state)).toEqual(["skipped", "skipped", "skipped"])
  expect(h.setupRuns.list().every((run) => run.state === "stopped")).toBe(true)
})

test("parallel cases wait for a setup slot instead of failing", async () => {
  const h = await evalHarness(1)
  let running = 0
  let most = 0
  const stop = desktop(h.setupRuns, async (cwd) => {
    running += 1
    most = Math.max(most, h.setupRuns.list().filter((run) => run.state === "running" || run.state === "waiting").length)
    await writeFile(join(cwd, "src/a.js"), "export const a = 2 // fixed\n")
    running -= 1
  })
  try {
    const started = h.evals.start({ suite: { name: "s", check: CHECK, cases: [h.item] }, setups: [executorOnly], repeats: 3, parallel: 3, maxMinutes: 5 })
    const done = await finished(h.evals, started.runId)
    expect(done.jobs.map((job) => job.state)).toEqual(["passed", "passed", "passed"])
    expect(most).toBe(1)
    expect(new Set(done.jobs.map((job) => job.worktree)).size).toBe(3)
  } finally {
    stop()
  }
})

test("a stop while the hidden tests are being restored starts no check", async () => {
  const h = await evalHarness()
  let release = (): void => undefined
  const restoring = new Promise<void>((resolve) => { release = resolve })
  let reachedRestore = false
  let checks = 0
  const evals = new EvalRuns({
    root: h.root,
    dir: join(h.home, "evals-stop"),
    setupRuns: h.setupRuns,
    git: async (options) => {
      if (options.args[0] === "checkout" && options.args.includes("--") && !options.args.includes("--detach")) {
        reachedRestore = true
        await restoring
      }
      return runGit(options)
    },
    check: async (input) => {
      checks += 1
      return h.checks.run({ ...input, timeoutMs: 30_000 })
    },
    stopCheck: (id) => h.checks.stop(id),
    retryMs: 20,
  })
  const stop = desktop(h.setupRuns, async () => undefined)
  try {
    const started = evals.start({ suite: { name: "s", check: CHECK, cases: [h.item] }, setups: [executorOnly], repeats: 1, parallel: 1, maxMinutes: 5 })
    for (let attempt = 0; attempt < 500 && !reachedRestore; attempt += 1) await Bun.sleep(10)
    expect(reachedRestore).toBe(true)
    await evals.stop(started.runId)
    release()
    const done = await finished(evals, started.runId)
    expect(done.state).toBe("stopped")
    expect(done.jobs.map((job) => job.state)).toEqual(["skipped"])
    expect(checks).toBe(0)
  } finally {
    stop()
  }
})

test("saved runs are listed only when their run.json has the shape of one", async () => {
  const home = await scratch()
  const dir = join(home, "evals")
  const good = "eval-00000000-0000-4000-8000-000000000001"
  const bad = "eval-00000000-0000-4000-8000-000000000002"
  for (const name of [good, bad]) await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, good, "run.json"), JSON.stringify({ runId: good, suite: "s", setups: [], cases: [], repeats: 1, state: "running", startedAt: 1, jobs: [] }))
  await writeFile(join(dir, bad, "run.json"), JSON.stringify({ runId: bad, suite: "s", state: "succeeded", startedAt: "yesterday", jobs: [] }))
  const evals = new EvalRuns({ root: home, dir, setupRuns: new SetupRuns({ check: async () => Promise.reject(new Error("unused")) }), check: () => Promise.reject(new Error("unused")) })
  expect((await evals.list()).map((run) => [run.runId, run.state])).toEqual([[good, "stopped"]])
})

test("a headless eval runs each case's roles in this process, read only or at Full access, and keeps its results where the app reads them", async () => {
  const { root } = await repository()
  const home = await scratch()
  const [, item] = await mineCandidates({ root, limit: 10 })
  await new SuiteStore(root).save(parseSuite({ name: "smoke", check: CHECK, cases: [item] }, "smoke"))
  const setupsPath = join(home, "setups.json")
  const duo = { id: "duo", name: "Duo", roles: { planner: { route: "claude-code", model: "fixture-small" }, executor: { route: "codex", access: "auto-edit", effort: "high" } }, rules: { approvePlan: true, reviewRounds: 0 } }
  await writeFile(setupsPath, JSON.stringify({ version: 1, setups: [duo] }))
  const opened: string[] = []
  const stopped: string[] = []
  const open = async (request: SetupTurnRequest, cwd: string) => {
    opened.push(`${request.role}:${request.mode}:${request.access}:${request.runsOn.route}:${cwd === request.worktree?.cwd ? "worktree" : cwd}`)
    let used = 0
    return {
      metrics: { snapshot: () => ({ inputTokens: used, outputTokens: 100 }) },
      async *prompt(text: string) {
        used += 1_000
        if (request.role === "executor") await writeFile(join(cwd, "src/a.js"), "export const a = 2 // fixed\n")
        yield { type: "assistant.message", turnId: "t", text: request.role === "planner" ? `Plan for: ${text.split("\n")[2] ?? ""}\n\n\`\`\`json\n${JSON.stringify({ steps: [{ title: "Make a two" }] })}\n\`\`\`` : "Done." }
      },
      resolveApproval: () => true,
      stop: async () => void stopped.push(request.role),
    } as unknown as RunrailSession
  }
  const progress: string[] = []
  const status = await runHeadlessEval({ cwd: root, suite: "smoke", setupIds: ["duo"], setupsPath, evalsDir: join(home, "evals"), open, pollMs: 10, onProgress: (run) => progress.push(run.jobs.map((job) => job.state).join(",")) })
  expect(status).toMatchObject({ state: "succeeded", suite: "smoke", setups: [{ id: "duo", name: "Duo" }] })
  // No one approves the plan, and the executor works at Full access in its throwaway checkout.
  expect(opened).toEqual(["planner:plan:ask:claude-code:worktree", "executor:agent:full:codex:worktree"])
  expect(status.jobs).toMatchObject([{ state: "passed", setupState: "succeeded", turns: 2, tokens: 2_200 }])
  expect(stopped.sort()).toEqual(["executor", "planner"])
  expect(progress.at(-1)).toBe("passed")
  const [project] = await readdir(join(home, "evals"))
  expect(await readFile(join(home, "evals", project ?? "", status.runId, "results.jsonl"), "utf8")).toContain('"state":"passed"')
  await expect(runHeadlessEval({ cwd: root, suite: "smoke", setupIds: ["missing"], setupsPath, evalsDir: join(home, "evals"), open })).rejects.toMatchObject({ code: "SETUP_NOT_FOUND" })
})
