export interface ReplayBenchmarkObservation {
  readonly succeeded: boolean
  readonly usefulResult?: boolean
  readonly costUsd?: number
  readonly steps?: number
  readonly repairs?: number
  readonly cacheHits?: number
  readonly cacheMisses?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly toolCalls?: number
}

export interface ReplayBenchmarkCase {
  readonly id: string
  readonly run: (signal?: AbortSignal) => ReplayBenchmarkObservation | PromiseLike<ReplayBenchmarkObservation>
}

export interface ReplayBenchmarkCaseResult {
  readonly id: string
  readonly succeeded: boolean
  readonly usefulResult: boolean
  readonly durationMs: number
  readonly costUsd?: number
  readonly steps?: number
  readonly repairs: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly toolCalls?: number
  readonly errorCode?: "BENCHMARK_CASE_FAILED" | "BENCHMARK_OBSERVATION_INVALID" | "BENCHMARK_CANCELLED"
}

export interface ReplayBenchmarkResult {
  readonly cases: readonly ReplayBenchmarkCaseResult[]
  readonly totalCases: number
  readonly successfulCases: number
  readonly usefulResults: number
  readonly totalDurationMs: number
  readonly totalCostUsd?: number
  readonly totalSteps?: number
  readonly totalRepairs: number
  readonly totalCacheHits: number
  readonly totalCacheMisses: number
  readonly totalInputTokens?: number
  readonly totalOutputTokens?: number
  readonly totalToolCalls?: number
}

export type ReplayBenchmarkErrorCode = "BENCHMARK_INVALID" | "BENCHMARK_LIMIT"

export class ReplayBenchmarkError extends Error {
  constructor(readonly code: ReplayBenchmarkErrorCode, reason: string) {
    super(`replay benchmark: ${reason}`)
    this.name = "ReplayBenchmarkError"
  }
}

export interface ReplayBenchmarkOptions {
  readonly clock?: () => number
  readonly maxCases?: number
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
}

/** Run caller-supplied deterministic cases without recording prompts, payloads, or diagnostics. */
export async function runReplayBenchmark(
  cases: readonly ReplayBenchmarkCase[],
  options: ReplayBenchmarkOptions = {},
): Promise<ReplayBenchmarkResult> {
  const maxCases = options.maxCases ?? 256
  if (!Array.isArray(cases) || !Number.isSafeInteger(maxCases) || maxCases < 1 || maxCases > 4_096 || cases.length > maxCases)
    throw new ReplayBenchmarkError("BENCHMARK_LIMIT", "benchmark case count is invalid")
  const maxConcurrency = options.maxConcurrency ?? 1
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32)
    throw new ReplayBenchmarkError("BENCHMARK_LIMIT", "benchmark concurrency is invalid")
  for (const item of cases) if (!isCase(item)) throw new ReplayBenchmarkError("BENCHMARK_INVALID", "benchmark case is invalid")
  const clock = options.clock ?? (() => performance.now())
  const results: Array<ReplayBenchmarkCaseResult | undefined> = Array.from({ length: cases.length })
  let next = 0
  const runOne = async (index: number): Promise<void> => {
    const item = cases[index]!
    const started = clock()
    if (options.signal?.aborted === true) {
      results[index] = failedResult(item.id, elapsed(clock(), started), "BENCHMARK_CANCELLED")
      return
    }
    try {
      const observation = await item.run(options.signal)
      if (!isObservation(observation)) {
        results[index] = failedResult(item.id, elapsed(clock(), started), "BENCHMARK_OBSERVATION_INVALID")
        return
      }
      results[index] = Object.freeze({
        id: item.id,
        succeeded: observation.succeeded,
        usefulResult: observation.usefulResult ?? observation.succeeded,
        durationMs: elapsed(clock(), started),
        repairs: observation.repairs ?? 0,
        cacheHits: observation.cacheHits ?? 0,
        cacheMisses: observation.cacheMisses ?? 0,
        ...(observation.costUsd === undefined ? {} : { costUsd: observation.costUsd }),
        ...(observation.steps === undefined ? {} : { steps: observation.steps }),
        ...(observation.inputTokens === undefined ? {} : { inputTokens: observation.inputTokens }),
        ...(observation.outputTokens === undefined ? {} : { outputTokens: observation.outputTokens }),
        ...(observation.toolCalls === undefined ? {} : { toolCalls: observation.toolCalls }),
      })
    } catch {
      results[index] = failedResult(item.id, elapsed(clock(), started), options.signal?.aborted ? "BENCHMARK_CANCELLED" : "BENCHMARK_CASE_FAILED")
    }
  }
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= cases.length) return
      await runOne(index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, cases.length) }, () => worker()))
  const complete = results.map((result, index) => result ?? failedResult(cases[index]!.id, 0, "BENCHMARK_CASE_FAILED"))
  const successfulCases = complete.filter((item) => item.succeeded).length
  const usefulResults = complete.filter((item) => item.usefulResult).length
  const costs = complete.map((item) => item.costUsd).filter((cost): cost is number => cost !== undefined)
  const steps = complete.map((item) => item.steps).filter((step): step is number => step !== undefined)
  const inputTokens = complete.map((item) => item.inputTokens).filter((value): value is number => value !== undefined)
  const outputTokens = complete.map((item) => item.outputTokens).filter((value): value is number => value !== undefined)
  const toolCalls = complete.map((item) => item.toolCalls).filter((value): value is number => value !== undefined)
  return Object.freeze({
    cases: Object.freeze(complete),
    totalCases: complete.length,
    successfulCases,
    usefulResults,
    totalDurationMs: complete.reduce((sum, item) => sum + item.durationMs, 0),
    totalRepairs: complete.reduce((sum, item) => sum + item.repairs, 0),
    totalCacheHits: complete.reduce((sum, item) => sum + item.cacheHits, 0),
    totalCacheMisses: complete.reduce((sum, item) => sum + item.cacheMisses, 0),
    ...(costs.length === complete.length && costs.length > 0 ? { totalCostUsd: costs.reduce((sum, cost) => sum + cost, 0) } : {}),
    ...(steps.length === complete.length && steps.length > 0 ? { totalSteps: steps.reduce((sum, step) => sum + step, 0) } : {}),
    ...(inputTokens.length === complete.length && inputTokens.length > 0 ? { totalInputTokens: inputTokens.reduce((sum, value) => sum + value, 0) } : {}),
    ...(outputTokens.length === complete.length && outputTokens.length > 0 ? { totalOutputTokens: outputTokens.reduce((sum, value) => sum + value, 0) } : {}),
    ...(toolCalls.length === complete.length && toolCalls.length > 0 ? { totalToolCalls: toolCalls.reduce((sum, value) => sum + value, 0) } : {}),
  })
}

function failedResult(
  id: string,
  durationMs: number,
  errorCode: "BENCHMARK_CASE_FAILED" | "BENCHMARK_OBSERVATION_INVALID" | "BENCHMARK_CANCELLED",
): ReplayBenchmarkCaseResult {
  return Object.freeze({ id, succeeded: false, usefulResult: false, durationMs, repairs: 0, cacheHits: 0, cacheMisses: 0, errorCode })
}

function isCase(value: unknown): value is ReplayBenchmarkCase {
  return isRecord(value) && typeof value.id === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.id) && typeof value.run === "function"
}

function isObservation(value: unknown): value is ReplayBenchmarkObservation {
  return isRecord(value) && typeof value.succeeded === "boolean" && optionalBoolean(value.usefulResult) && optionalNonNegative(value.costUsd, 1_000_000) && optionalInteger(value.steps) && optionalInteger(value.repairs) && optionalInteger(value.cacheHits) && optionalInteger(value.cacheMisses) && optionalInteger(value.inputTokens) && optionalInteger(value.outputTokens) && optionalInteger(value.toolCalls)
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean"
}

function optionalNonNegative(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max)
}

function optionalInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000)
}

function elapsed(end: number, start: number): number {
  if (!Number.isFinite(end) || !Number.isFinite(start) || end < start) return 0
  return end - start
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
