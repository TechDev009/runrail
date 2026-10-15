import { RUNRAIL_VERSION } from "../version.ts"

export const PROVIDER_COMPATIBILITY_VERSION = 1 as const

export type ProviderCompatibilityClassification = "native-adapter" | "pass-through" | "caller-owned" | "unavailable"
export type ProviderCompatibilityStatus = "planned" | "active" | "verified" | "unavailable"

export interface ProviderCompatibilityEntry {
  readonly id: string
  readonly name: string
  readonly protocol: string
  readonly classification: ProviderCompatibilityClassification
  readonly capability: string
  readonly fixture: string
  readonly credentials: "caller-owned" | "environment-reference" | "Pi-owned"
  readonly status: ProviderCompatibilityStatus
  readonly reason?: string
}

export interface ProviderCompatibilityMatrix {
  readonly schemaVersion: typeof PROVIDER_COMPATIBILITY_VERSION
  readonly piVersion: string
  readonly runrailVersion: string
  readonly entries: readonly ProviderCompatibilityEntry[]
}

export interface ProviderCompatibilitySummary {
  readonly total: number
  readonly nativeAdapter: number
  readonly passThrough: number
  readonly callerOwned: number
  readonly unavailable: number
  readonly gaps: readonly string[]
}

export class ProviderCompatibilityError extends Error {
  constructor(readonly code: "PROVIDER_MATRIX_INVALID" | "PROVIDER_MATRIX_LIMIT", reason: string) {
    super(`${code}: ${reason}`)
    this.name = "ProviderCompatibilityError"
  }
}

export function createDefaultProviderCompatibilityMatrix(): ProviderCompatibilityMatrix {
  return parseProviderCompatibilityMatrix({
    schemaVersion: 1,
    piVersion: "0.84.1",
    runrailVersion: RUNRAIL_VERSION,
    entries: [
      entry("openai", "OpenAI", "OpenAI Responses and Chat", "native-adapter", "provider.openai", "provider-openai", "environment-reference", "verified"),
      entry("anthropic", "Anthropic", "Anthropic Messages", "native-adapter", "provider.anthropic", "provider-anthropic", "environment-reference", "verified"),
      entry("openai-compatible", "OpenAI-compatible", "OpenAI Chat or Responses", "native-adapter", "provider.openai-compatible", "provider-openai-compatible", "environment-reference", "verified"),
      entry("xai", "xAI / Grok", "OpenAI-compatible", "native-adapter", "provider.xai", "provider-xai", "environment-reference", "verified"),
      entry("google", "Google", "Provider-specific", "caller-owned", "provider.google", "provider-google", "caller-owned", "verified", "Credentials and the protocol pack remain caller-owned; register an explicit caller-owned model adapter"),
      entry("vertex", "Vertex AI", "Provider-specific", "caller-owned", "provider.vertex", "provider-vertex", "caller-owned", "verified", "Cloud identity and project tenancy remain outside Runrail; register an explicit caller-owned model adapter"),
      entry("bedrock", "Amazon Bedrock", "Provider-specific", "caller-owned", "provider.bedrock", "provider-bedrock", "caller-owned", "verified", "AWS credential chains and region policy remain caller-owned; register an explicit caller-owned model adapter"),
      entry("llama.cpp", "llama.cpp", "Local HTTP or process", "caller-owned", "provider.llama.cpp", "provider-llama.cpp", "caller-owned", "verified", "The local model process and isolation boundary belong to the caller; register an explicit caller-owned model adapter"),
      entry("pi-provider-registry", "Pi provider registry", "Pi native provider ecosystem", "pass-through", "pi.providers", "provider-pi-pass-through", "Pi-owned", "verified", "Use runrail pi when the user needs Pi-owned subscriptions or provider packages"),
    ],
  })
}

export function parseProviderCompatibilityMatrix(value: unknown): ProviderCompatibilityMatrix {
  if (!isRecord(value)) invalid("matrix must be an object")
  requireKnownKeys(value, ["schemaVersion", "piVersion", "runrailVersion", "entries"])
  if (value.schemaVersion !== PROVIDER_COMPATIBILITY_VERSION) invalid("matrix schema version is unsupported")
  const piVersion = version(value.piVersion, "Pi version")
  const runrailVersion = version(value.runrailVersion, "Runrail version")
  if (!Array.isArray(value.entries) || value.entries.length === 0) invalid("matrix entries are invalid")
  if (value.entries.length > 256) throw new ProviderCompatibilityError("PROVIDER_MATRIX_LIMIT", "matrix has too many entries")
  const ids = new Set<string>()
  const entries = value.entries.map((item, index) => {
    const parsed = parseEntry(item, index)
    if (ids.has(parsed.id)) invalid("provider ids must be unique")
    ids.add(parsed.id)
    return parsed
  })
  return Object.freeze({ schemaVersion: PROVIDER_COMPATIBILITY_VERSION, piVersion, runrailVersion, entries: Object.freeze(entries) })
}

export function summarizeProviderCompatibilityMatrix(matrix: ProviderCompatibilityMatrix): ProviderCompatibilitySummary {
  const gaps: string[] = []
  let nativeAdapter = 0
  let passThrough = 0
  let callerOwned = 0
  let unavailable = 0
  for (const entry of matrix.entries) {
    if (entry.classification === "native-adapter") nativeAdapter += 1
    if (entry.classification === "pass-through") passThrough += 1
    if (entry.classification === "caller-owned") callerOwned += 1
    if (entry.classification === "unavailable") unavailable += 1
    if ((entry.classification === "caller-owned" || entry.classification === "pass-through" || entry.classification === "unavailable") && entry.reason === undefined)
      gaps.push(`${entry.id}: ownership reason is missing`)
    if (entry.status === "unavailable" && entry.reason === undefined) gaps.push(`${entry.id}: unavailable reason is missing`)
  }
  return Object.freeze({ total: matrix.entries.length, nativeAdapter, passThrough, callerOwned, unavailable, gaps: Object.freeze(gaps) })
}

function entry(id: string, name: string, protocol: string, classification: ProviderCompatibilityClassification, capability: string, fixture: string, credentials: ProviderCompatibilityEntry["credentials"], status: ProviderCompatibilityStatus, reason?: string): Record<string, string> {
  return { id, name, protocol, classification, capability, fixture, credentials, status, ...(reason === undefined ? {} : { reason }) }
}

function parseEntry(value: unknown, index: number): ProviderCompatibilityEntry {
  if (!isRecord(value)) invalid(`entry ${index} is invalid`)
  requireKnownKeys(value, ["id", "name", "protocol", "classification", "capability", "fixture", "credentials", "status", "reason"])
  const classification = choice(value.classification, ["native-adapter", "pass-through", "caller-owned", "unavailable"], `entry ${index} classification`)
  const status = choice(value.status, ["planned", "active", "verified", "unavailable"], `entry ${index} status`)
  const reason = value.reason === undefined ? undefined : text(value.reason, `entry ${index} reason`, 512)
  if ((classification === "caller-owned" || classification === "pass-through" || classification === "unavailable") && reason === undefined) invalid(`entry ${index} ownership reason is required`)
  return Object.freeze({
    id: identifier(value.id, `entry ${index} id`),
    name: text(value.name, `entry ${index} name`, 128),
    protocol: text(value.protocol, `entry ${index} protocol`, 128),
    classification,
    capability: identifier(value.capability, `entry ${index} capability`),
    fixture: identifier(value.fixture, `entry ${index} fixture`),
    credentials: choice(value.credentials, ["caller-owned", "environment-reference", "Pi-owned"], `entry ${index} credentials`),
    status,
    ...(reason === undefined ? {} : { reason }),
  })
}

function requireKnownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) invalid("unknown matrix fields are not permitted")
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 128)
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(result)) invalid(`${field} is invalid`)
  return result
}

function version(value: unknown, field: string): string {
  const result = text(value, field, 32)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result)) invalid(`${field} is invalid`)
  return result
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || /[\r\n]/.test(value)) invalid(`${field} is invalid`)
  return value
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const match = choices.find((candidate) => candidate === value)
  if (match === undefined) invalid(`${field} is invalid`)
  return match
}

function invalid(reason: string): never {
  throw new ProviderCompatibilityError("PROVIDER_MATRIX_INVALID", reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
