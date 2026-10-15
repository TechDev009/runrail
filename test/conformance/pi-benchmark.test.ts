import { expect, test } from "bun:test"
import {
  comparePiBenchmarkReports,
  createPiBenchmarkReport,
  parsePiBenchmarkReport,
  runPiBenchmarkCases,
} from "../../src/compatibility/index.ts"

const environment = {
  runtime: "bun-1.3.0",
  os: "darwin",
  arch: "arm64",
  provider: "fixture",
  model: "deterministic",
  workspaceDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  policyDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
}

test("benchmark reports compare only the same case and environment", () => {
  const pi = createPiBenchmarkReport({
    caseId: "coding-loop",
    runner: "pi",
    environment,
    observation: { startupMs: 40, firstTokenMs: 80, firstToolCallMs: 120, usefulChangeMs: 400, wallMs: 500, toolCalls: 2, inputTokens: 100, outputTokens: 50 },
  })
  const runrail = createPiBenchmarkReport({
    caseId: "coding-loop",
    runner: "runrail",
    environment,
    observation: { startupMs: 20, firstTokenMs: 60, firstToolCallMs: 100, usefulChangeMs: 300, wallMs: 350, toolCalls: 2, inputTokens: 90, outputTokens: 40 },
  })
  const comparison = comparePiBenchmarkReports(pi, runrail)

  expect(comparison.caseId).toBe("coding-loop")
  expect(comparison.deltas.wallMs).toBe(-150)
  expect(comparison.deltas.usefulChangeMs).toBe(-100)
  expect(comparison.speedups.wallMs).toBeCloseTo(500 / 350)
  expect(comparison.deltas.reportedCostUsd).toBeUndefined()
})

test("benchmark parsing rejects payload-looking references and invalid measurements", () => {
  expect(() => parsePiBenchmarkReport({
    caseId: "coding-loop",
    runner: "pi",
    environment: { ...environment, workspaceDigest: "prompt text" },
    observation: { wallMs: 1 },
  })).toThrow("PI_BENCHMARK_INVALID")

  expect(() => parsePiBenchmarkReport({
    caseId: "coding-loop",
    runner: "pi",
    environment,
    observation: { wallMs: -1 },
  })).toThrow("PI_BENCHMARK_INVALID")
})

test("matched benchmark cases measure both runners under one environment", async () => {
  const [result] = await runPiBenchmarkCases([{
    caseId: "matched-fixture",
    environment,
    pi: () => ({ wallMs: 999, startupMs: 20, reportedCostUsd: undefined }),
    runrail: () => ({ wallMs: 999, startupMs: 10 }),
  }])
  expect(result?.comparison.caseId).toBe("matched-fixture")
  expect(result?.pi.observation.wallMs).toBeGreaterThanOrEqual(0)
  expect(result?.runrail.observation.wallMs).toBeGreaterThanOrEqual(0)
  expect(result?.pi.observation.reportedCostUsd).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain("prompt")
})

test("matched benchmark cases refuse cancellation and thrown runner output", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(runPiBenchmarkCases([], { signal: controller.signal })).resolves.toEqual([])
  await expect(runPiBenchmarkCases([{
    caseId: "throws",
    environment,
    pi: () => { throw new Error("secret payload") },
    runrail: () => ({ wallMs: 1 }),
  }])).rejects.toMatchObject({ code: "PI_BENCHMARK_RUNNER_FAILED" })
})
