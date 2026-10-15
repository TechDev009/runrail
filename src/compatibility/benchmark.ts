export const PI_BENCHMARK_SCHEMA_VERSION = 1 as const

export type PiBenchmarkRunner = "pi" | "runrail"
export type PiBenchmarkMetric = "startupMs" | "firstTokenMs" | "firstToolCallMs" | "usefulChangeMs" | "wallMs" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "toolCalls" | "repairAttempts" | "reportedCostUsd"

export interface PiBenchmarkEnvironment {
  readonly runtime: string
  readonly os: string
  readonly arch: string
  readonly provider: string
  readonly model: string
  readonly workspaceDigest: string
  readonly policyDigest: string
}

export interface PiBenchmarkObservation {
  readonly startupMs?: number
  readonly firstTokenMs?: number
  readonly firstToolCallMs?: number
  readonly usefulChangeMs?: number
  readonly wallMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly toolCalls?: number
  readonly repairAttempts?: number
  readonly reportedCostUsd?: number
}

export interface PiBenchmarkReport {
  readonly schemaVersion: typeof PI_BENCHMARK_SCHEMA_VERSION
  readonly caseId: string
  readonly runner: PiBenchmarkRunner
  readonly environment: PiBenchmarkEnvironment
  readonly observation: PiBenchmarkObservation
}

export type PiBenchmarkMetricValues = Partial<Record<PiBenchmarkMetric, number>>

export interface PiBenchmarkComparison {
  readonly caseId: string
  readonly environment: PiBenchmarkEnvironment
  readonly deltas: PiBenchmarkMetricValues
  readonly speedups: PiBenchmarkMetricValues
}

export class PiBenchmarkError extends Error {
  constructor(readonly code: "PI_BENCHMARK_INVALID" | "PI_BENCHMARK_LIMIT" | "PI_BENCHMARK_MISMATCH", reason: string) {
    super(`${code}: ${reason}`)
    this.name = "PiBenchmarkError"
  }
}

export function createPiBenchmarkReport(value: unknown): PiBenchmarkReport {
  const record = requireRecord(value)
  return parsePiBenchmarkReport({ ...record, schemaVersion: record.schemaVersion ?? PI_BENCHMARK_SCHEMA_VERSION })
}

export function parsePiBenchmarkReport(value: unknown): PiBenchmarkReport {
  const record = requireRecord(value)
  requireKnownKeys(record, ["schemaVersion", "caseId", "runner", "environment", "observation"])
  if (record.schemaVersion !== PI_BENCHMARK_SCHEMA_VERSION) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", "benchmark schema version is unsupported")
  const environment = parseEnvironment(record.environment)
  const observation = parseObservation(record.observation)
  return Object.freeze({
    schemaVersion: PI_BENCHMARK_SCHEMA_VERSION,
    caseId: requireIdentifier(record.caseId, "case id"),
    runner: requireChoice(record.runner, ["pi", "runrail"], "runner"),
    environment,
    observation,
  })
}

export function comparePiBenchmarkReports(pi: PiBenchmarkReport, runrail: PiBenchmarkReport): PiBenchmarkComparison {
  if (pi.runner !== "pi" || runrail.runner !== "runrail") throw new PiBenchmarkError("PI_BENCHMARK_MISMATCH", "comparison requires Pi then Runrail reports")
  if (pi.caseId !== runrail.caseId || !sameEnvironment(pi.environment, runrail.environment))
    throw new PiBenchmarkError("PI_BENCHMARK_MISMATCH", "reports do not share a case and environment")
  const deltas: PiBenchmarkMetricValues = {}
  const speedups: PiBenchmarkMetricValues = {}
  for (const metric of METRICS) {
    const before = pi.observation[metric]
    const after = runrail.observation[metric]
    if (before === undefined || after === undefined) continue
    deltas[metric] = after - before
    if (after > 0) speedups[metric] = before / after
  }
  return Object.freeze({ caseId: pi.caseId, environment: pi.environment, deltas: Object.freeze(deltas), speedups: Object.freeze(speedups) })
}

const METRICS: readonly PiBenchmarkMetric[] = ["startupMs", "firstTokenMs", "firstToolCallMs", "usefulChangeMs", "wallMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "toolCalls", "repairAttempts", "reportedCostUsd"]

function parseEnvironment(value: unknown): PiBenchmarkEnvironment {
  const record = requireRecord(value)
  requireKnownKeys(record, ["runtime", "os", "arch", "provider", "model", "workspaceDigest", "policyDigest"])
  return Object.freeze({
    runtime: requireMetadata(record.runtime, "runtime"),
    os: requireMetadata(record.os, "os"),
    arch: requireMetadata(record.arch, "arch"),
    provider: requireMetadata(record.provider, "provider"),
    model: requireMetadata(record.model, "model"),
    workspaceDigest: requireDigest(record.workspaceDigest, "workspace digest"),
    policyDigest: requireDigest(record.policyDigest, "policy digest"),
  })
}

function parseObservation(value: unknown): PiBenchmarkObservation {
  const record = requireRecord(value)
  requireKnownKeys(record, [...METRICS])
  const observation: Record<string, number> = {}
  for (const metric of METRICS) {
    if (record[metric] === undefined) continue
    observation[metric] = requireMetric(record[metric], metric)
  }
  const wallMs = observation.wallMs
  if (wallMs === undefined) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", "wallMs is required")
  return Object.freeze({
    ...(observation.startupMs === undefined ? {} : { startupMs: observation.startupMs }),
    ...(observation.firstTokenMs === undefined ? {} : { firstTokenMs: observation.firstTokenMs }),
    ...(observation.firstToolCallMs === undefined ? {} : { firstToolCallMs: observation.firstToolCallMs }),
    ...(observation.usefulChangeMs === undefined ? {} : { usefulChangeMs: observation.usefulChangeMs }),
    wallMs,
    ...(observation.inputTokens === undefined ? {} : { inputTokens: observation.inputTokens }),
    ...(observation.outputTokens === undefined ? {} : { outputTokens: observation.outputTokens }),
    ...(observation.cacheReadTokens === undefined ? {} : { cacheReadTokens: observation.cacheReadTokens }),
    ...(observation.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: observation.cacheWriteTokens }),
    ...(observation.toolCalls === undefined ? {} : { toolCalls: observation.toolCalls }),
    ...(observation.repairAttempts === undefined ? {} : { repairAttempts: observation.repairAttempts }),
    ...(observation.reportedCostUsd === undefined ? {} : { reportedCostUsd: observation.reportedCostUsd }),
  })
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", "value must be an object")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireKnownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", "unknown fields are not permitted")
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", `${field} is invalid`)
  return value
}

function requireMetadata(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.includes("\0") || /[\r\n]/.test(value)) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", `${field} is invalid`)
  return value
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", `${field} is invalid`)
  return value
}

function requireMetric(value: unknown, metric: PiBenchmarkMetric): number {
  const max = metric === "reportedCostUsd" ? 1_000_000 : metric.endsWith("Ms") ? 86_400_000 : 20_000_000
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", `${metric} is invalid`)
  if (!metric.endsWith("Ms") && metric !== "reportedCostUsd" && !Number.isSafeInteger(value)) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", `${metric} must be an integer`)
  return value
}

function requireChoice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const choice = choices.find((candidate) => candidate === value)
  if (choice === undefined) throw new PiBenchmarkError("PI_BENCHMARK_INVALID", `${field} is invalid`)
  return choice
}

function sameEnvironment(left: PiBenchmarkEnvironment, right: PiBenchmarkEnvironment): boolean {
  return left.runtime === right.runtime && left.os === right.os && left.arch === right.arch && left.provider === right.provider && left.model === right.model && left.workspaceDigest === right.workspaceDigest && left.policyDigest === right.policyDigest
}
