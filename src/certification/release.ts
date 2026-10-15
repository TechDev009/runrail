import { createHash } from "node:crypto"
import {
  parsePiCompatibilityMatrix,
  summarizePiCompatibilityMatrix,
  type PiCompatibilityMatrix,
} from "../compatibility/index.ts"
import {
  summarizeHarnessCompatibilityMatrix,
  validateHarnessCompatibilityMatrix,
  type HarnessMatrixValidationOptions,
  type HarnessCompatibilityMatrix,
} from "../harness/matrix.ts"

export const RUNRAIL_RELEASE_CERTIFICATION_VERSION = 1 as const

export type ReleaseCertificationStatus = "pass" | "unavailable" | "failed"

export interface ReleaseCertificationObservation {
  readonly status: ReleaseCertificationStatus
  readonly code?: string
}

export interface ReleaseCertificationProbeContext {
  readonly releaseId: string
  readonly releaseVersion: string
  readonly matrix: PiCompatibilityMatrix
  readonly harnessMatrix?: HarnessCompatibilityMatrix
}

export interface ReleaseCertificationProbe {
  readonly id: string
  readonly required?: boolean
  readonly run: (context: ReleaseCertificationProbeContext) => ReleaseCertificationObservation | PromiseLike<ReleaseCertificationObservation>
}

export interface ReleaseCertificationProfile {
  readonly id: string
  readonly version: string
  readonly matrix: PiCompatibilityMatrix
  readonly harnessMatrix?: HarnessCompatibilityMatrix
  /** Required for release certification when a harness matrix is supplied. */
  readonly harnessValidation?: HarnessMatrixValidationOptions
  readonly checks: readonly ReleaseCertificationProbe[]
  readonly timeoutMs?: number
}

export interface ReleaseCertificationCheckResult {
  readonly id: string
  readonly required: boolean
  readonly status: ReleaseCertificationStatus
  readonly code?: string
}

export interface ReleaseCertificationResult {
  readonly version: typeof RUNRAIL_RELEASE_CERTIFICATION_VERSION
  readonly id: string
  readonly releaseVersion: string
  readonly ok: boolean
  readonly checks: readonly ReleaseCertificationCheckResult[]
  readonly elapsedMs: number
  readonly digest: string
}

export type ReleaseCertificationErrorCode =
  | "RELEASE_CERTIFICATION_INVALID"
  | "RELEASE_CHECK_INVALID"
  | "RELEASE_CHECK_TIMEOUT"

export class ReleaseCertificationError extends Error {
  constructor(readonly code: ReleaseCertificationErrorCode, reason: string) {
    super(`release certification: ${reason}`)
    this.name = "ReleaseCertificationError"
  }
}

/**
 * Runs release probes without returning probe payloads, diagnostics, or
 * credentials. The compatibility matrix is always checked first.
 */
export async function certifyRelease(profile: ReleaseCertificationProfile): Promise<ReleaseCertificationResult> {
  validateProfile(profile)
  let matrix: PiCompatibilityMatrix
  try {
    matrix = parsePiCompatibilityMatrix(profile.matrix)
  } catch {
    throw new ReleaseCertificationError("RELEASE_CERTIFICATION_INVALID", "compatibility matrix is invalid")
  }
  let harnessMatrix: HarnessCompatibilityMatrix | undefined
  if (profile.harnessMatrix !== undefined) {
    const validation = profile.harnessValidation
    if (validation === undefined || validation.fixtureExists === undefined || validation.verifyRow === undefined || validation.verifyCapability === undefined)
      throw new ReleaseCertificationError("RELEASE_CERTIFICATION_INVALID", "harness matrix evidence is incomplete")
    try {
      harnessMatrix = await validateHarnessCompatibilityMatrix(profile.harnessMatrix, validation)
    } catch {
      throw new ReleaseCertificationError("RELEASE_CERTIFICATION_INVALID", "harness compatibility matrix is invalid")
    }
  }
  const started = performance.now()
  const timeoutMs = profile.timeoutMs ?? 30_000
  const context = Object.freeze({ releaseId: profile.id, releaseVersion: profile.version, matrix, ...(harnessMatrix === undefined ? {} : { harnessMatrix }) })
  const probes: readonly ReleaseCertificationProbe[] = Object.freeze([
    { id: "compatibility-matrix", required: true, run: () => compatibilityObservation(matrix) },
    ...(harnessMatrix === undefined ? [] : [{ id: "harness-compatibility", required: true, run: () => harnessCompatibilityObservation(harnessMatrix) }]),
    ...profile.checks,
  ])
  const checks: ReleaseCertificationCheckResult[] = []
  for (const probe of probes) {
    const required = probe.required ?? true
    let observation: ReleaseCertificationObservation
    try {
      observation = normalizeObservation(await withTimeout(Promise.resolve(probe.run(context)), timeoutMs))
    } catch (error) {
      const code = error instanceof ReleaseCertificationError ? error.code : "RELEASE_CHECK_THROWN"
      observation = { status: "failed", code }
    }
    checks.push(Object.freeze({ id: probe.id, required, ...observation }))
  }
  const frozenChecks = Object.freeze(checks)
  const matrixDigest = createHash("sha256").update(JSON.stringify(matrix)).digest("hex")
  const harnessMatrixDigest = harnessMatrix === undefined ? undefined : createHash("sha256").update(JSON.stringify(harnessMatrix)).digest("hex")
  const digest = createHash("sha256").update(JSON.stringify({ id: profile.id, version: profile.version, matrixDigest, harnessMatrixDigest, checks: frozenChecks })).digest("hex")
  return Object.freeze({
    version: RUNRAIL_RELEASE_CERTIFICATION_VERSION,
    id: profile.id,
    releaseVersion: profile.version,
    ok: frozenChecks.every((check) => check.status === "pass" || (!check.required && check.status === "unavailable")),
    checks: frozenChecks,
    elapsedMs: Math.max(0, performance.now() - started),
    digest,
  })
}

function compatibilityObservation(matrix: PiCompatibilityMatrix): ReleaseCertificationObservation {
  const summary = summarizePiCompatibilityMatrix(matrix)
  const incomplete = matrix.features.some((feature) => feature.status === "planned" || feature.status === "active" || feature.status === "blocked")
  const unverifiedNative = matrix.features.some((feature) => feature.classification === "native" && feature.status !== "verified")
  return summary.gaps.length === 0 && !incomplete && !unverifiedNative
    ? { status: "pass" }
    : { status: "failed", code: "RELEASE_MATRIX_INCOMPLETE" }
}

function harnessCompatibilityObservation(matrix: HarnessCompatibilityMatrix): ReleaseCertificationObservation {
  const summary = summarizeHarnessCompatibilityMatrix(matrix)
  const incomplete = matrix.rows.some((row) => row.status === "planned" || row.status === "active")
  return summary.gaps.length === 0 && !incomplete
    ? { status: "pass" }
    : { status: "failed", code: "RELEASE_HARNESS_MATRIX_INCOMPLETE" }
}

function validateProfile(profile: ReleaseCertificationProfile): void {
  if (!isRecord(profile) || !boundedId(profile.id) || !boundedVersion(profile.version) || !Array.isArray(profile.checks) || profile.checks.length > 64)
    throw new ReleaseCertificationError("RELEASE_CERTIFICATION_INVALID", "release profile is invalid")
  if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 120_000))
    throw new ReleaseCertificationError("RELEASE_CERTIFICATION_INVALID", "release timeout is invalid")
  const ids = new Set(["compatibility-matrix"])
  for (const probe of profile.checks) {
    if (!isRecord(probe) || !boundedId(probe.id) || ids.has(probe.id) || typeof probe.run !== "function" || (probe.required !== undefined && typeof probe.required !== "boolean"))
      throw new ReleaseCertificationError("RELEASE_CERTIFICATION_INVALID", "release check is invalid")
    ids.add(probe.id)
  }
}

function normalizeObservation(value: unknown): ReleaseCertificationObservation {
  if (!isRecord(value) || (value.status !== "pass" && value.status !== "unavailable" && value.status !== "failed"))
    throw new ReleaseCertificationError("RELEASE_CHECK_INVALID", "release check result is invalid")
  if (value.code !== undefined && (typeof value.code !== "string" || !/^[A-Z][A-Z0-9_.:-]{0,63}$/.test(value.code)))
    throw new ReleaseCertificationError("RELEASE_CHECK_INVALID", "release check code is invalid")
  return Object.freeze({ status: value.status, ...(value.code === undefined ? {} : { code: value.code }) })
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ReleaseCertificationError("RELEASE_CHECK_TIMEOUT", "release check timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function boundedVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
