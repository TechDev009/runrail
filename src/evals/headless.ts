import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { CheckRuns, CHECK_DEFAULT_TIMEOUT_MS } from "../check/run.ts"
import { HeadlessTurns, type HeadlessTurnsOptions } from "../setups/headless.ts"
import { SetupRuns } from "../setups/runner.ts"
import type { Setup } from "../setups/schema.ts"
import { SetupStore } from "../setups/store.ts"
import { EvalRuns, type EvalRunStatus } from "./run.ts"
import { EvalError, SuiteStore } from "./suite.ts"

/**
 * An eval with no desktop: the same suites, setups, checks, and results folder the app uses, with
 * each case's turns run in this process. A finished run shows in the app's Evals list.
 */

export interface HeadlessEvalOptions {
  readonly cwd: string
  readonly suite: string
  readonly setupIds: readonly string[]
  readonly cases?: readonly string[]
  readonly repeats?: number
  readonly parallel?: number
  readonly maxMinutes?: number
  /** The person's setups file, as the app reads it. */
  readonly setupsPath: string
  /** Every project's eval results, a folder each. */
  readonly evalsDir: string
  readonly open: HeadlessTurnsOptions["open"]
  readonly onProgress?: (status: EvalRunStatus) => void
  readonly signal?: AbortSignal
  readonly pollMs?: number
}

export async function runHeadlessEval(options: HeadlessEvalOptions): Promise<EvalRunStatus> {
  const root = await realpath(options.cwd)
  const suite = await new SuiteStore(root).get(options.suite)
  const store = new SetupStore({ user: options.setupsPath, project: join(root, ".runrail", "setups.json") })
  const setups: Setup[] = []
  for (const id of options.setupIds) setups.push(await store.runnable(id))
  const cases = options.cases === undefined ? suite.cases : suite.cases.filter((item) => options.cases?.includes(item.id))
  if (cases.length === 0) throw new EvalError("EVAL_INVALID", "none of those cases are in the suite")
  const checks = new CheckRuns()
  const setupRuns = new SetupRuns({
    check: (input) => checks.run({ id: input.id, cwd: input.cwd ?? root, command: input.command, timeoutMs: CHECK_DEFAULT_TIMEOUT_MS }),
    stopCheck: (id) => checks.stop(id),
  })
  const turns = new HeadlessTurns({ open: options.open, root })
  const evals = new EvalRuns({
    root,
    // The app's folder for this project, so the run is listed there too.
    dir: join(options.evalsDir, createHash("sha256").update(root).digest("hex").slice(0, 16)),
    setupRuns,
    port: turns,
    check: (input) => checks.run({ ...input, timeoutMs: CHECK_DEFAULT_TIMEOUT_MS }),
    stopCheck: (id) => checks.stop(id),
  })
  const started = evals.start({ suite: { ...suite, cases }, setups, repeats: options.repeats ?? 1, parallel: options.parallel ?? 1, maxMinutes: options.maxMinutes ?? 120 })
  const stop = (): void => void evals.stop(started.runId).catch(() => undefined)
  options.signal?.addEventListener("abort", stop, { once: true })
  try {
    let shown = ""
    for (;;) {
      const status = evals.status(started.runId)
      const seen = JSON.stringify(status.jobs.map((job) => job.state))
      if (seen !== shown || status.state !== "running") {
        shown = seen
        options.onProgress?.(status)
      }
      if (status.state !== "running") return status
      await Bun.sleep(options.pollMs ?? 1_000)
    }
  } finally {
    options.signal?.removeEventListener("abort", stop)
    await evals.close().catch(() => undefined)
    await setupRuns.close().catch(() => undefined)
    await turns.close()
  }
}
