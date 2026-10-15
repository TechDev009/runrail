import {
  comparePiBenchmarkReports,
  createPiBenchmarkReport,
  type PiBenchmarkComparison,
  type PiBenchmarkEnvironment,
  type PiBenchmarkObservation,
  type PiBenchmarkReport,
} from "./benchmark.ts"

export interface PiBenchmarkCase {
  readonly caseId: string
  readonly environment: PiBenchmarkEnvironment
  readonly pi: () => PiBenchmarkObservation | PromiseLike<PiBenchmarkObservation>
  readonly runrail: () => PiBenchmarkObservation | PromiseLike<PiBenchmarkObservation>
}

export interface PiBenchmarkRunnerOptions {
  readonly maxCases?: number
  readonly signal?: AbortSignal
}

export interface PiBenchmarkCaseResult {
  readonly caseId: string
  readonly pi: PiBenchmarkReport
  readonly runrail: PiBenchmarkReport
  readonly comparison: PiBenchmarkComparison
}

export type PiBenchmarkRunnerErrorCode = "PI_BENCHMARK_RUNNER_INVALID" | "PI_BENCHMARK_RUNNER_LIMIT" | "PI_BENCHMARK_RUNNER_CANCELLED" | "PI_BENCHMARK_RUNNER_FAILED"

export class PiBenchmarkRunnerError extends Error {
  constructor(readonly code: PiBenchmarkRunnerErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "PiBenchmarkRunnerError"
  }
}

/** Run matched caller-owned Pi and native functions without receiving task payloads. */
export async function runPiBenchmarkCases(
  cases: readonly PiBenchmarkCase[],
  options: PiBenchmarkRunnerOptions = {},
): Promise<readonly PiBenchmarkCaseResult[]> {
  const maxCases = options.maxCases ?? 128
  if (!Number.isSafeInteger(maxCases) || maxCases < 1 || maxCases > 512)
    throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_LIMIT", "benchmark case limit is invalid")
  if (!Array.isArray(cases) || cases.length > maxCases)
    throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_LIMIT", "benchmark case count exceeds the configured limit")
  const ids = new Set<string>()
  for (const item of cases) {
    if (!isBenchmarkCase(item))
      throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_INVALID", "benchmark case is invalid")
    if (ids.has(item.caseId)) throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_INVALID", "benchmark case ids must be unique")
    ids.add(item.caseId)
  }

  const results: PiBenchmarkCaseResult[] = []
  for (const item of cases) {
    if (options.signal?.aborted === true) throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_CANCELLED", "benchmark was cancelled")
    const pi = await runOne(item, "pi", item.pi, options.signal)
    const runrail = await runOne(item, "runrail", item.runrail, options.signal)
    try {
      results.push(Object.freeze({ caseId: item.caseId, pi, runrail, comparison: comparePiBenchmarkReports(pi, runrail) }))
    } catch (error) {
      if (error instanceof PiBenchmarkRunnerError) throw error
      throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_FAILED", "benchmark comparison failed")
    }
  }
  return Object.freeze(results)
}

async function runOne(
  item: PiBenchmarkCase,
  runner: "pi" | "runrail",
  execute: () => PiBenchmarkObservation | PromiseLike<PiBenchmarkObservation>,
  signal: AbortSignal | undefined,
): Promise<PiBenchmarkReport> {
  if (signal?.aborted === true) throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_CANCELLED", "benchmark was cancelled")
  const started = performance.now()
  let observation: PiBenchmarkObservation
  try {
    observation = await execute()
  } catch {
    throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_FAILED", `${runner} benchmark case failed`)
  }
  const wallMs = Math.max(0, Math.min(86_400_000, performance.now() - started))
  try {
    return createPiBenchmarkReport({
      schemaVersion: 1,
      caseId: item.caseId,
      runner,
      environment: item.environment,
      observation: { ...observation, wallMs },
    })
  } catch {
    throw new PiBenchmarkRunnerError("PI_BENCHMARK_RUNNER_INVALID", `${runner} benchmark observation is invalid`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isBenchmarkCase(value: unknown): value is PiBenchmarkCase {
  return isRecord(value)
    && typeof value.caseId === "string"
    && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.caseId)
    && typeof value.environment === "object"
    && value.environment !== null
    && typeof value.pi === "function"
    && typeof value.runrail === "function"
}
