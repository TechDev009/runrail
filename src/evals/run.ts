import { randomUUID } from "node:crypto"
import { readBoundedText } from "../runtime/bounded-read.ts"
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import type { CheckCounts, CheckResult } from "../check/run.ts"
import { runGit, type GitRunOptions, type GitRunResult } from "../git/run.ts"
import type { SetupRuns, SetupWorktree } from "../setups/runner.ts"
import { SetupError, type Setup } from "../setups/schema.ts"
import { checkFor, linkDependencies, type EvalCase } from "./mine.ts"
import { EvalError, type EvalSuite } from "./suite.ts"

/**
 * An eval run: every case, setup and repeat as one setup run in its own worktree at the
 * case's base with the hidden tests removed; the tests come back for the check that scores it.
 * Results keep ids, states, counts and durations only, as JSONL under the evals dir.
 */

export type EvalJobState = "queued" | "running" | "checking" | "passed" | "failed" | "skipped" | "error"

export interface EvalJob {
  readonly index: number
  readonly caseId: string
  readonly setupId: string
  readonly repeat: number
  state: EvalJobState
  setupRunId?: string
  setupState?: string
  worktree?: string
  turns?: number
  durationMs?: number
  check?: { readonly exitCode?: number; readonly timedOut: boolean; readonly counts?: CheckCounts }
  error?: string
}

export interface EvalRunStatus {
  readonly runId: string
  readonly suite: string
  readonly setups: readonly { readonly id: string; readonly name: string }[]
  readonly cases: readonly string[]
  readonly repeats: number
  readonly state: "running" | "succeeded" | "stopped" | "failed"
  readonly startedAt: number
  readonly endedAt?: number
  readonly jobs: readonly EvalJob[]
  readonly error?: { readonly code: string; readonly message: string }
}

export interface EvalRunsOptions {
  readonly root: string
  /** Results go to `<dir>/<run id>/`; one directory per project. */
  readonly dir: string
  readonly setupRuns: SetupRuns
  readonly check: (input: { readonly id: string; readonly cwd: string; readonly command: string }) => Promise<CheckResult>
  readonly stopCheck?: (id: string) => Promise<unknown>
  readonly git?: (options: GitRunOptions) => Promise<GitRunResult>
  readonly now?: () => number
  readonly retryMs?: number
}

export interface EvalStart {
  readonly suite: EvalSuite
  readonly setups: readonly Setup[]
  readonly repeats: number
  readonly parallel: number
  readonly maxMinutes: number
}

const MAX_JOBS = 400
const MAX_TASK = 8_000

class EvalStopped extends Error {}

const MAX_RUNS_IN_MEMORY = 32
const MAX_SAVED_RUN_BYTES = 4 * 1024 * 1024
const RUN_STATES: ReadonlySet<unknown> = new Set(["running", "succeeded", "stopped", "failed"])

/** A saved run.json as far as listing needs it; anything else in the file is not trusted. */
function savedRun(value: unknown, runId: string): EvalRunStatus | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const run = value as Record<string, unknown>
  if (run.runId !== runId || typeof run.suite !== "string" || !RUN_STATES.has(run.state) || typeof run.startedAt !== "number" || !Number.isFinite(run.startedAt)) return undefined
  if (!Array.isArray(run.jobs) || run.jobs.length > 10_000 || !run.jobs.every((job) => job !== null && typeof job === "object" && !Array.isArray(job))) return undefined
  if (!Array.isArray(run.setups) || !Array.isArray(run.cases) || typeof run.repeats !== "number") return undefined
  return value as EvalRunStatus
}

interface Run {
  readonly status: Omit<EvalRunStatus, "state" | "endedAt" | "error" | "jobs"> & { state: EvalRunStatus["state"]; endedAt?: number; error?: EvalRunStatus["error"] }
  readonly jobs: EvalJob[]
  readonly controller: AbortController
  readonly setupRunIds: Set<string>
  readonly checkIds: Set<string>
}

export class EvalRuns {
  readonly #runs = new Map<string, Run>()
  readonly #git: (options: GitRunOptions) => Promise<GitRunResult>
  readonly #now: () => number

  constructor(private readonly options: EvalRunsOptions) {
    this.#git = options.git ?? runGit
    this.#now = options.now ?? Date.now
  }

  start(input: EvalStart): EvalRunStatus {
    if ([...this.#runs.values()].some((run) => run.status.state === "running")) throw new EvalError("EVAL_LIMIT", "an eval is already running in this project; stop it first")
    const total = input.suite.cases.length * input.setups.length * input.repeats
    if (total === 0 || total > MAX_JOBS) throw new EvalError("EVAL_LIMIT", `an eval runs 1 to ${String(MAX_JOBS)} case runs; this one would run ${String(total)}`)
    const runId = `eval-${randomUUID()}`
    const jobs: EvalJob[] = []
    for (const item of input.suite.cases) for (const setup of input.setups) for (let repeat = 1; repeat <= input.repeats; repeat += 1) jobs.push({ index: jobs.length, caseId: item.id, setupId: setup.id, repeat, state: "queued" })
    const run: Run = {
      status: { runId, suite: input.suite.name, setups: input.setups.map((setup) => ({ id: setup.id, name: setup.name })), cases: input.suite.cases.map((item) => item.id), repeats: input.repeats, state: "running", startedAt: this.#now() },
      jobs,
      controller: new AbortController(),
      setupRunIds: new Set(),
      checkIds: new Set(),
    }
    this.#runs.set(runId, run)
    // Finished runs stay listable from their run.json; memory keeps only the latest few.
    for (const [id, kept] of this.#runs) {
      if (this.#runs.size <= MAX_RUNS_IN_MEMORY) break
      if (kept.status.state !== "running") this.#runs.delete(id)
    }
    void this.#execute(run, input)
    return this.status(runId)
  }

  status(runId: string): EvalRunStatus {
    const run = this.#find(runId)
    return { ...run.status, jobs: run.jobs.map((job) => ({ ...job })) }
  }

  /** Runs since the engine started, and earlier ones from their `run.json`. */
  async list(): Promise<readonly EvalRunStatus[]> {
    const runs = [...this.#runs.keys()].map((id) => this.status(id))
    const names = await readdir(this.options.dir).catch(() => [] as string[])
    for (const name of names.filter((entry) => /^eval-[0-9a-f-]{36}$/.test(entry) && !this.#runs.has(entry)).slice(0, 200)) {
      const saved = await readBoundedText(join(this.options.dir, name, "run.json"), MAX_SAVED_RUN_BYTES).then(
        (text) => savedRun(JSON.parse(text) as unknown, name),
        () => undefined,
      )
      if (saved !== undefined) runs.push({ ...saved, state: saved.state === "running" ? "stopped" : saved.state })
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt)
  }

  async stop(runId: string, reason: { readonly code: string; readonly message: string } = { code: "EVAL_STOPPED", message: "the person stopped the eval" }): Promise<EvalRunStatus> {
    const run = this.#find(runId)
    if (run.status.state !== "running") return this.status(runId)
    run.status.error ??= reason
    run.controller.abort()
    await Promise.all([...run.setupRunIds].map((id) => this.options.setupRuns.stop(id).catch(() => undefined)))
    await Promise.all([...run.checkIds].map((id) => this.options.stopCheck?.(id)))
    return this.status(runId)
  }

  async close(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((id) => this.stop(id).catch(() => undefined)))
  }

  #find(runId: string): Run {
    const run = typeof runId === "string" ? this.#runs.get(runId) : undefined
    if (run === undefined) throw new EvalError("EVAL_RUN_NOT_FOUND", "no eval run has that id")
    return run
  }

  async #execute(run: Run, input: EvalStart): Promise<void> {
    const dir = join(this.options.dir, run.status.runId)
    const budget = setTimeout(() => void this.stop(run.status.runId, { code: "EVAL_BUDGET", message: `the eval reached its ${String(input.maxMinutes)}-minute budget` }), input.maxMinutes * 60_000)
    try {
      await mkdir(dir, { recursive: true })
      await this.#writeSummary(dir, run)
      const queue = [...run.jobs]
      const worker = async (): Promise<void> => {
        for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
          if (run.controller.signal.aborted) {
            job.state = "skipped"
            continue
          }
          const item = input.suite.cases.find((entry) => entry.id === job.caseId)
          const setup = input.setups.find((entry) => entry.id === job.setupId)
          if (item === undefined || setup === undefined) continue
          await this.#job(run, job, item, setup, input.suite.check)
          await appendFile(join(dir, "results.jsonl"), `${JSON.stringify(resultLine(job))}\n`, "utf8")
        }
      }
      await Promise.all(Array.from({ length: Math.min(input.parallel, run.jobs.length) }, () => worker()))
      run.status.state = run.controller.signal.aborted ? "stopped" : "succeeded"
    } catch {
      run.status.state = "failed"
      run.status.error ??= { code: "EVAL_FAILED", message: "the eval could not write its results" }
    } finally {
      clearTimeout(budget)
      run.status.endedAt = this.#now()
      await this.#writeSummary(dir, run).catch(() => undefined)
    }
  }

  async #job(run: Run, job: EvalJob, item: EvalCase, setup: Setup, check: string): Promise<void> {
    const started = this.#now()
    job.state = "running"
    let worktree: { readonly id: string; readonly path: string; readonly cwd: string } | undefined
    try {
      worktree = await this.#checkout(run, job, item.base)
      job.worktree = worktree.id
      // The hidden tests leave the worktree; the commit's own message is the task.
      for (const path of item.tests) await removeInside(worktree.path, path)
      await linkDependencies(this.options.root, worktree.cwd)
      const message = await this.#git({ cwd: this.options.root, args: ["log", "-1", "--format=%B", item.fix], maxOutputBytes: 64 * 1024, overflow: "truncate" })
      const task = `${message.stdout.trim().slice(0, MAX_TASK) || "Make the change this repository is missing."}\n\nTests for this change exist but are not in the worktree; Runrail checks your work with them when you finish.`
      const started_ = await this.#startSetup(run, setup, task, { id: worktree.id, path: worktree.path, cwd: worktree.cwd })
      job.setupRunId = started_.runId
      run.setupRunIds.add(started_.runId)
      const ended = await this.options.setupRuns.settled(started_.runId)
      run.setupRunIds.delete(started_.runId)
      job.setupState = ended.state
      job.turns = ended.turns
      if (ended.state === "stopped" && run.controller.signal.aborted) {
        job.state = "skipped"
        return
      }
      job.state = "checking"
      // The fix arrives only now, after the agent is done: before, nothing in the checkout holds it.
      await this.#git({ cwd: worktree.path, args: ["fetch", "--quiet", "--depth", "1", "--no-tags", "--", await this.#toplevel(), item.fix], timeoutMs: 120_000 })
      await this.#git({ cwd: worktree.path, args: ["checkout", item.fix, "--", ...item.tests] })
      // Checked in the same turn as the id is added: a stop either sees the check or prevents it.
      if (run.controller.signal.aborted) throw new EvalStopped()
      const checkId = `${run.status.runId.slice(0, 40)}-${String(job.index)}`
      run.checkIds.add(checkId)
      const result = await this.options.check({ id: checkId, cwd: worktree.path, command: checkFor(check, item.tests) }).finally(() => run.checkIds.delete(checkId))
      job.check = { ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), timedOut: result.timedOut, ...(result.counts === undefined ? {} : { counts: result.counts }) }
      job.state = result.stopped ? "skipped" : result.passed ? "passed" : "failed"
    } catch (error) {
      job.state = run.controller.signal.aborted ? "skipped" : "error"
      // A code only: messages from git or a tool can carry output.
      if (job.state === "error") job.error = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "EVAL_CASE_FAILED"
    } finally {
      job.durationMs = this.#now() - started
      // Results are kept in results.jsonl; the checkout itself would fill the disk run after run.
      if (worktree !== undefined) await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * A checkout of the case's base commit alone, outside the project's repository. A git worktree
   * would share the repository's objects, where the agent could read the fix and its tests.
   */
  async #checkout(run: Run, job: EvalJob, revision: string): Promise<{ readonly id: string; readonly path: string; readonly cwd: string }> {
    const id = `ev-${run.status.runId.slice(5, 13)}-${String(job.index)}`
    const path = join(this.options.dir, run.status.runId, "work", id)
    await rm(path, { recursive: true, force: true })
    await mkdir(path, { recursive: true })
    const toplevel = await this.#toplevel()
    await this.#git({ cwd: path, args: ["init", "--quiet"] })
    await this.#git({ cwd: path, args: ["fetch", "--quiet", "--depth", "1", "--no-tags", "--", toplevel, revision], timeoutMs: 300_000 })
    await this.#git({ cwd: path, args: ["checkout", "--quiet", "--detach", "FETCH_HEAD"] })
    const inside = relative(toplevel, await realpath(this.options.root))
    return { id, path, cwd: inside.length === 0 ? path : join(path, inside) }
  }

  async #toplevel(): Promise<string> {
    const result = await this.#git({ cwd: this.options.root, args: ["rev-parse", "--show-toplevel"], maxOutputBytes: 8_192 })
    return realpath(result.stdout.trim())
  }

  /** A person's own setup runs share the project's run limit, so a case waits its turn for a slot. */
  async #startSetup(run: Run, setup: Setup, task: string, worktree: SetupWorktree): Promise<{ readonly runId: string }> {
    for (;;) {
      if (run.controller.signal.aborted) throw new EvalStopped()
      try {
        return this.options.setupRuns.start(unattended(setup), task, this.options.setupRuns.pending, { worktree })
      } catch (error) {
        if (!(error instanceof SetupError) || error.code !== "SETUP_LIMIT") throw error
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.retryMs ?? 5_000))
    }
  }

  async #writeSummary(dir: string, run: Run): Promise<void> {
    const jobs = run.jobs
    const summary = {
      ...run.status,
      jobs,
      total: jobs.length,
      passed: jobs.filter((job) => job.state === "passed").length,
      failed: jobs.filter((job) => job.state === "failed").length,
      skipped: jobs.filter((job) => job.state === "skipped").length,
      errors: jobs.filter((job) => job.state === "error").length,
    }
    await writeFile(join(dir, "run.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  }
}

/**
 * No one watches an eval's runs, so none of them waits for an answer: the plan is not held for
 * approval, and the executor works at Full access in its throwaway checkout outside the project.
 */
function unattended(setup: Setup): Setup {
  return Object.freeze({
    ...setup,
    roles: Object.freeze({ ...setup.roles, executor: Object.freeze({ ...setup.roles.executor, access: "full" as const }) }),
    rules: Object.freeze({ ...setup.rules, approvePlan: false }),
  })
}

/** Removes a hidden test file only when the folder it is in resolves inside the checkout, never through a committed link. */
async function removeInside(root: string, path: string): Promise<void> {
  const target = join(root, path)
  const realRoot = await realpath(root)
  let parent: string
  try {
    parent = await realpath(dirname(target))
  } catch {
    return
  }
  if (parent !== realRoot && !parent.startsWith(realRoot + sep)) throw new EvalError("EVAL_INVALID", "a test path leads outside the checkout")
  const info = await lstat(target).catch(() => undefined)
  if (info === undefined) return
  if (info.isDirectory()) throw new EvalError("EVAL_INVALID", "a test path is a folder")
  await rm(target, { force: true })
}

/** D19: ids, states, counts, durations. Never a prompt, an answer, or a log. */
function resultLine(job: EvalJob): Record<string, unknown> {
  return {
    case: job.caseId,
    setup: job.setupId,
    repeat: job.repeat,
    state: job.state,
    ...(job.setupRunId === undefined ? {} : { setupRun: job.setupRunId }),
    ...(job.setupState === undefined ? {} : { setupState: job.setupState }),
    ...(job.turns === undefined ? {} : { turns: job.turns }),
    ...(job.durationMs === undefined ? {} : { durationMs: job.durationMs }),
    ...(job.check === undefined ? {} : { check: job.check }),
  }
}
