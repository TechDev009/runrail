import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRunrail } from "../cli.ts"
import { runReplayBenchmark, type ReplayBenchmarkResult } from "./replay.ts"

export interface ReferenceBenchmarkOptions {
  readonly repeats?: number
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
}
/** Benchmark only the deterministic local replay path; provider cost remains intentionally unknown. */
export async function runReferenceBenchmark(
  options: ReferenceBenchmarkOptions = {},
): Promise<ReplayBenchmarkResult> {
  const repeats = options.repeats ?? 1
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 32)
    throw new RangeError("benchmark repeats must be between 1 and 32")
  const cases = Array.from({ length: repeats }, (_, index) => ({
    id: `replay-${index + 1}`,
    run: async () => {
      const cwd = await mkdtemp(join(tmpdir(), "runrail-benchmark-"))
      try {
        const result = await runRunrail({ cwd, backend: "replay", task: "benchmark replay", ...(options.signal === undefined ? {} : { signal: options.signal }) })
        return {
          succeeded: result.status === "succeeded",
          usefulResult: result.status === "succeeded",
          steps: result.events.length,
          repairs: result.repairAttempts,
          cacheHits: 0,
          cacheMisses: 0,
        }
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    },
  }))
  return runReplayBenchmark(cases, { maxConcurrency: options.maxConcurrency, signal: options.signal })
}
