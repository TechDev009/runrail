export const PI_COMPATIBILITY_MATRIX_VERSION = 1 as const
export const PI_COMPATIBILITY_FIXTURE_VERSION = 1 as const

export type PiCompatibilityClassification = "native" | "pass-through" | "adapter" | "caller-owned" | "not-applicable"
export type PiCompatibilityStatus = "planned" | "active" | "verified" | "unavailable" | "blocked"
export type PiCompatibilitySurface = "cli" | "interactive" | "rpc" | "sdk" | "package" | "resource" | "provider"

export interface PiCompatibilityFeature {
  readonly id: string
  readonly feature: string
  readonly surface: PiCompatibilitySurface
  readonly classification: PiCompatibilityClassification
  readonly capability: string
  readonly fixture: string
  readonly security: string
  readonly status: PiCompatibilityStatus
  readonly reason?: string
  readonly deprecation?: string
}

export interface PiCompatibilityMatrix {
  readonly schemaVersion: typeof PI_COMPATIBILITY_MATRIX_VERSION
  readonly piVersion: string
  readonly runrailVersion: string
  readonly features: readonly PiCompatibilityFeature[]
}

export type PiFixtureOutcome = "pass" | "refused"

export interface PiCompatibilityFixture {
  readonly id: string
  readonly featureId: string
  readonly surface: PiCompatibilitySurface
  readonly outcome: PiFixtureOutcome
  readonly exitCode: number
  readonly argv?: readonly string[]
  readonly eventTypes?: readonly string[]
  readonly refusalCode?: string
  readonly observationDigest?: string
}

export interface PiCompatibilityFixtureCorpus {
  readonly schemaVersion: typeof PI_COMPATIBILITY_FIXTURE_VERSION
  readonly piVersion: string
  readonly fixtures: readonly PiCompatibilityFixture[]
}

export interface PiCompatibilitySummary {
  readonly total: number
  readonly nativePlanned: number
  readonly nativeVerified: number
  readonly passThrough: number
  readonly adapter: number
  readonly callerOwned: number
  readonly notApplicable: number
  readonly gaps: readonly string[]
}

export type PiCompatibilityErrorCode = "PI_MATRIX_INVALID" | "PI_MATRIX_LIMIT" | "PI_FIXTURE_INVALID" | "PI_FIXTURE_LIMIT"

export class PiCompatibilityError extends Error {
  constructor(readonly code: PiCompatibilityErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "PiCompatibilityError"
  }
}

export function parsePiCompatibilityMatrixJson(text: string): PiCompatibilityMatrix {
  if (typeof text !== "string" || text.length === 0 || text.length > 2 * 1024 * 1024)
    throw new PiCompatibilityError("PI_MATRIX_LIMIT", "matrix JSON is outside the allowed size")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PiCompatibilityError("PI_MATRIX_INVALID", "matrix JSON is malformed")
  }
  return parsePiCompatibilityMatrix(value)
}

export function parsePiCompatibilityMatrix(value: unknown): PiCompatibilityMatrix {
  const record = requireRecord(value, "PI_MATRIX_INVALID", "matrix must be an object")
  requireKnownKeys(record, ["schemaVersion", "piVersion", "runrailVersion", "features"], "PI_MATRIX_INVALID")
  if (record.schemaVersion !== PI_COMPATIBILITY_MATRIX_VERSION)
    throw new PiCompatibilityError("PI_MATRIX_INVALID", "matrix schema version is unsupported")
  const piVersion = requireVersion(record.piVersion, "PI_MATRIX_INVALID", "Pi version")
  const runrailVersion = requireVersion(record.runrailVersion, "PI_MATRIX_INVALID", "Runrail version")
  if (!Array.isArray(record.features) || record.features.length === 0)
    throw new PiCompatibilityError("PI_MATRIX_INVALID", "matrix features must be a non-empty array")
  if (record.features.length > 512)
    throw new PiCompatibilityError("PI_MATRIX_LIMIT", "matrix has too many features")
  const ids = new Set<string>()
  const features = record.features.map((entry, index) => {
    const feature = parseFeature(entry, index)
    if (ids.has(feature.id)) throw new PiCompatibilityError("PI_MATRIX_INVALID", "feature ids must be unique")
    ids.add(feature.id)
    return feature
  })
  return Object.freeze({
    schemaVersion: PI_COMPATIBILITY_MATRIX_VERSION,
    piVersion,
    runrailVersion,
    features: Object.freeze(features),
  })
}

export function parsePiCompatibilityFixtureCorpus(text: string): PiCompatibilityFixtureCorpus {
  if (typeof text !== "string" || text.length === 0 || text.length > 4 * 1024 * 1024)
    throw new PiCompatibilityError("PI_FIXTURE_LIMIT", "fixture corpus is outside the allowed size")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PiCompatibilityError("PI_FIXTURE_INVALID", "fixture JSON is malformed")
  }
  return parsePiCompatibilityFixtureCorpusValue(value)
}

export function parsePiCompatibilityFixtureCorpusValue(value: unknown): PiCompatibilityFixtureCorpus {
  const record = requireRecord(value, "PI_FIXTURE_INVALID", "fixture corpus must be an object")
  requireKnownKeys(record, ["schemaVersion", "piVersion", "fixtures"], "PI_FIXTURE_INVALID")
  if (record.schemaVersion !== PI_COMPATIBILITY_FIXTURE_VERSION)
    throw new PiCompatibilityError("PI_FIXTURE_INVALID", "fixture schema version is unsupported")
  const piVersion = requireVersion(record.piVersion, "PI_FIXTURE_INVALID", "Pi version")
  if (!Array.isArray(record.fixtures) || record.fixtures.length === 0)
    throw new PiCompatibilityError("PI_FIXTURE_INVALID", "fixture corpus must contain fixtures")
  if (record.fixtures.length > 1_024)
    throw new PiCompatibilityError("PI_FIXTURE_LIMIT", "fixture corpus has too many fixtures")
  const ids = new Set<string>()
  const fixtures = record.fixtures.map((entry, index) => {
    const fixture = parseFixture(entry, index)
    if (ids.has(fixture.id)) throw new PiCompatibilityError("PI_FIXTURE_INVALID", "fixture ids must be unique")
    ids.add(fixture.id)
    return fixture
  })
  return Object.freeze({ schemaVersion: PI_COMPATIBILITY_FIXTURE_VERSION, piVersion, fixtures: Object.freeze(fixtures) })
}

export function summarizePiCompatibilityMatrix(matrix: PiCompatibilityMatrix): PiCompatibilitySummary {
  const gaps: string[] = []
  let nativePlanned = 0
  let nativeVerified = 0
  let passThrough = 0
  let adapter = 0
  let callerOwned = 0
  let notApplicable = 0
  for (const feature of matrix.features) {
    if (feature.classification === "native" && feature.status === "planned") nativePlanned += 1
    if (feature.classification === "native" && feature.status === "verified") nativeVerified += 1
    if (feature.classification === "pass-through") passThrough += 1
    if (feature.classification === "adapter") adapter += 1
    if (feature.classification === "caller-owned") callerOwned += 1
    if (feature.classification === "not-applicable") notApplicable += 1
    if ((feature.classification === "pass-through" || feature.classification === "caller-owned" || feature.classification === "not-applicable") && feature.reason === undefined)
      gaps.push(`${feature.id}: classification requires a reason`)
    if ((feature.status === "blocked" || feature.status === "unavailable") && feature.reason === undefined)
      gaps.push(`${feature.id}: status requires a reason`)
    if (feature.fixture.length === 0) gaps.push(`${feature.id}: fixture is missing`)
  }
  return Object.freeze({ total: matrix.features.length, nativePlanned, nativeVerified, passThrough, adapter, callerOwned, notApplicable, gaps: Object.freeze(gaps) })
}

function parseFeature(value: unknown, index: number): PiCompatibilityFeature {
  const record = requireRecord(value, "PI_MATRIX_INVALID", `feature ${index} must be an object`)
  requireKnownKeys(record, ["id", "feature", "surface", "classification", "capability", "fixture", "security", "status", "reason", "deprecation"], "PI_MATRIX_INVALID")
  return Object.freeze({
    id: requireIdentifier(record.id, "PI_MATRIX_INVALID", `feature ${index} id`),
    feature: requireText(record.feature, "PI_MATRIX_INVALID", `feature ${index} name`, 256),
    surface: requireChoice(record.surface, ["cli", "interactive", "rpc", "sdk", "package", "resource", "provider"], "PI_MATRIX_INVALID", `feature ${index} surface`),
    classification: requireChoice(record.classification, ["native", "pass-through", "adapter", "caller-owned", "not-applicable"], "PI_MATRIX_INVALID", `feature ${index} classification`),
    capability: requireIdentifier(record.capability, "PI_MATRIX_INVALID", `feature ${index} capability`),
    fixture: requireFixturePath(record.fixture, "PI_MATRIX_INVALID", `feature ${index} fixture`),
    security: requireText(record.security, "PI_MATRIX_INVALID", `feature ${index} security`, 512),
    status: requireChoice(record.status, ["planned", "active", "verified", "unavailable", "blocked"], "PI_MATRIX_INVALID", `feature ${index} status`),
    ...(record.reason === undefined ? {} : { reason: requireText(record.reason, "PI_MATRIX_INVALID", `feature ${index} reason`, 512) }),
    ...(record.deprecation === undefined ? {} : { deprecation: requireText(record.deprecation, "PI_MATRIX_INVALID", `feature ${index} deprecation`, 512) }),
  })
}

function parseFixture(value: unknown, index: number): PiCompatibilityFixture {
  const record = requireRecord(value, "PI_FIXTURE_INVALID", `fixture ${index} must be an object`)
  requireKnownKeys(record, ["id", "featureId", "surface", "outcome", "exitCode", "argv", "eventTypes", "refusalCode", "observationDigest"], "PI_FIXTURE_INVALID")
  const outcome = requireChoice(record.outcome, ["pass", "refused"], "PI_FIXTURE_INVALID", `fixture ${index} outcome`)
  const argv = optionalStringArray(record.argv, "PI_FIXTURE_INVALID", `fixture ${index} argv`, 32, 256)
  const eventTypes = optionalStringArray(record.eventTypes, "PI_FIXTURE_INVALID", `fixture ${index} event types`, 64, 128)
  const refusalCode = record.refusalCode === undefined ? undefined : requireIdentifier(record.refusalCode, "PI_FIXTURE_INVALID", `fixture ${index} refusal code`)
  if (outcome === "refused" && refusalCode === undefined)
    throw new PiCompatibilityError("PI_FIXTURE_INVALID", `fixture ${index} refusal code is required`)
  if (outcome === "pass" && refusalCode !== undefined)
    throw new PiCompatibilityError("PI_FIXTURE_INVALID", `fixture ${index} pass cannot contain a refusal code`)
  const observationDigest = record.observationDigest === undefined ? undefined : requireDigest(record.observationDigest, "PI_FIXTURE_INVALID", `fixture ${index} observation digest`)
  return Object.freeze({
    id: requireIdentifier(record.id, "PI_FIXTURE_INVALID", `fixture ${index} id`),
    featureId: requireIdentifier(record.featureId, "PI_FIXTURE_INVALID", `fixture ${index} feature id`),
    surface: requireChoice(record.surface, ["cli", "interactive", "rpc", "sdk", "package", "resource", "provider"], "PI_FIXTURE_INVALID", `fixture ${index} surface`),
    outcome,
    exitCode: requireInteger(record.exitCode, "PI_FIXTURE_INVALID", `fixture ${index} exit code`, 0, 255),
    ...(argv === undefined ? {} : { argv: Object.freeze(argv) }),
    ...(eventTypes === undefined ? {} : { eventTypes: Object.freeze(eventTypes) }),
    ...(refusalCode === undefined ? {} : { refusalCode }),
    ...(observationDigest === undefined ? {} : { observationDigest }),
  })
}

function requireRecord(value: unknown, code: PiCompatibilityErrorCode, reason: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PiCompatibilityError(code, reason)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireKnownKeys(record: Record<string, unknown>, keys: readonly string[], code: PiCompatibilityErrorCode): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new PiCompatibilityError(code, "unknown fields are not permitted")
}

function requireText(value: unknown, code: PiCompatibilityErrorCode, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) throw new PiCompatibilityError(code, `${field} is invalid`)
  return value
}

function requireIdentifier(value: unknown, code: PiCompatibilityErrorCode, field: string): string {
  const text = requireText(value, code, field, 128)
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new PiCompatibilityError(code, `${field} is invalid`)
  return text
}

function requireVersion(value: unknown, code: PiCompatibilityErrorCode, field: string): string {
  const text = requireText(value, code, field, 32)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text)) throw new PiCompatibilityError(code, `${field} is invalid`)
  return text
}

function requireFixturePath(value: unknown, code: PiCompatibilityErrorCode, field: string): string {
  const text = requireText(value, code, field, 512)
  if (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.includes("\\") || text.split("/").some((part) => part === "" || part === "." || part === ".."))
    throw new PiCompatibilityError(code, `${field} must be a safe relative path`)
  return text
}

function requireChoice<T extends string>(value: unknown, choices: readonly T[], code: PiCompatibilityErrorCode, field: string): T {
  const choice = choices.find((candidate) => candidate === value)
  if (choice === undefined) throw new PiCompatibilityError(code, `${field} is invalid`)
  return choice
}

function requireInteger(value: unknown, code: PiCompatibilityErrorCode, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new PiCompatibilityError(code, `${field} is invalid`)
  return value
}

function optionalStringArray(value: unknown, code: PiCompatibilityErrorCode, field: string, maxItems: number, maxLength: number): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new PiCompatibilityError(code, `${field} is invalid`)
  return value.map((entry, index) => requireText(entry, code, `${field}[${index}]`, maxLength))
}

function requireDigest(value: unknown, code: PiCompatibilityErrorCode, field: string): string {
  const text = requireText(value, code, field, 71)
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) throw new PiCompatibilityError(code, `${field} is invalid`)
  return text
}
