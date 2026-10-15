import { expect, test } from "bun:test"
import { runReplayBenchmark } from "../../src/benchmark/replay.ts"
import { runReferenceBenchmark } from "../../src/benchmark/reference.ts"

test("replay benchmark aggregates only reported cost and deterministic time", async () => {
  let now = 0
  const result = await runReplayBenchmark([
    { id: "one", run: () => { now += 5; return { succeeded: true, costUsd: 0.25, steps: 2 } } },
    { id: "two", run: () => { now += 7; return { succeeded: false, costUsd: 0.10, steps: 3 } } },
  ], { clock: () => now })
  expect(result).toMatchObject({ totalCases: 2, successfulCases: 1, totalDurationMs: 12, totalCostUsd: 0.35, totalSteps: 5 })
})

test("reference benchmark repeats replay cases and omits unknown cost", async () => {
  const result = await runReferenceBenchmark({ repeats: 2 })
  expect(result).toMatchObject({ totalCases: 2, successfulCases: 2, usefulResults: 2 })
  expect(result.totalCostUsd).toBeUndefined()
  expect(result.cases.every((item) => item.costUsd === undefined)).toBe(true)
})

test("runs independent benchmark cases with bounded concurrency", async () => {
  let active = 0
  let peak = 0
  const result = await runReplayBenchmark([
    { id: "a", run: async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 8)); active -= 1; return { succeeded: true } } },
    { id: "b", run: async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 8)); active -= 1; return { succeeded: true } } },
  ], { maxConcurrency: 2 })
  expect(peak).toBe(2)
  expect(result.successfulCases).toBe(2)
})

test("marks queued benchmark cases cancelled without fabricating measurements", async () => {
  const signal = new AbortController()
  signal.abort()
  const result = await runReplayBenchmark([{ id: "cancelled", run: () => ({ succeeded: true, costUsd: 1 }) }], { signal: signal.signal })
  expect(result.cases[0]).toMatchObject({ succeeded: false, errorCode: "BENCHMARK_CANCELLED" })
  expect(result.totalCostUsd).toBeUndefined()
})
