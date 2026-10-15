export type PiProbeStatus = "pass" | "refused" | "failed" | "cancelled"

export interface PiCompatibilityProbeObservation {
  readonly status: Exclude<PiProbeStatus, "cancelled" | "failed"> 
  readonly code?: string
}

export interface PiCompatibilityProbe {
  readonly id: string
  readonly featureId: string
  readonly run: (signal?: AbortSignal) => PiCompatibilityProbeObservation | PromiseLike<PiCompatibilityProbeObservation>
}

export interface PiCompatibilityProbeResult {
  readonly id: string
  readonly featureId: string
  readonly status: PiProbeStatus
  readonly durationMs: number
  readonly code?: string
  readonly eventTypes?: readonly string[]
}

export interface PiCompatibilityProbeOptions {
  readonly maxProbes?: number
  readonly clock?: () => number
  readonly signal?: AbortSignal
}

export type PiCompatibilityProbeErrorCode = "PI_PROBE_INVALID" | "PI_PROBE_LIMIT"

export class PiCompatibilityProbeError extends Error {
  constructor(readonly code: PiCompatibilityProbeErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "PiCompatibilityProbeError"
  }
}

/** Execute black-box probes while returning only bounded status metadata. */
export async function runPiCompatibilityProbes(
  probes: readonly PiCompatibilityProbe[],
  options: PiCompatibilityProbeOptions = {},
): Promise<readonly PiCompatibilityProbeResult[]> {
  const maxProbes = options.maxProbes ?? 256
  if (!Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > 1_024)
    throw new PiCompatibilityProbeError("PI_PROBE_LIMIT", "probe limit is invalid")
  if (!Array.isArray(probes) || probes.length > maxProbes)
    throw new PiCompatibilityProbeError("PI_PROBE_LIMIT", "probe count exceeds the configured limit")
  const ids = new Set<string>()
  for (const probe of probes) {
    if (!isProbe(probe)) throw new PiCompatibilityProbeError("PI_PROBE_INVALID", "probe shape is invalid")
    if (ids.has(probe.id)) throw new PiCompatibilityProbeError("PI_PROBE_INVALID", "probe ids must be unique")
    ids.add(probe.id)
  }
  const clock = options.clock ?? (() => performance.now())
  const results: PiCompatibilityProbeResult[] = []
  for (const probe of probes) {
    const started = safeClock(clock)
    if (options.signal?.aborted) {
      results.push(Object.freeze({ id: probe.id, featureId: probe.featureId, status: "cancelled", durationMs: elapsed(clock, started), code: "PROBE_CANCELLED" }))
      continue
    }
    try {
      const observation = await probe.run(options.signal)
      if (!isObservation(observation)) {
        results.push(Object.freeze({ id: probe.id, featureId: probe.featureId, status: "failed", durationMs: elapsed(clock, started), code: "PROBE_OBSERVATION_INVALID" }))
        continue
      }
      results.push(Object.freeze({ id: probe.id, featureId: probe.featureId, status: observation.status, durationMs: elapsed(clock, started), ...(observation.code === undefined ? {} : { code: observation.code }) }))
    } catch {
      results.push(Object.freeze({ id: probe.id, featureId: probe.featureId, status: "failed", durationMs: elapsed(clock, started), code: "PROBE_THROWN" }))
    }
  }
  return Object.freeze(results)
}

function isProbe(value: unknown): value is PiCompatibilityProbe {
  if (!isRecord(value)) return false
  const record = value
  return typeof record.id === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(record.id) && typeof record.featureId === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(record.featureId) && typeof record.run === "function"
}

function isObservation(value: unknown): value is PiCompatibilityProbeObservation {
  if (!isRecord(value)) return false
  const record = value
  if (record.status !== "pass" && record.status !== "refused") return false
  return record.code === undefined || (typeof record.code === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(record.code))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function safeClock(clock: () => number): number {
  try {
    const value = clock()
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function elapsed(clock: () => number, started: number): number {
  const ended = safeClock(clock)
  return ended >= started ? Math.min(86_400_000, ended - started) : 0
}
