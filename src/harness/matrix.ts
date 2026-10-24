import { RUNRAIL_VERSION } from "../version.ts"
import type { HarnessAuthMode, HarnessCapabilityClassification, HarnessDescriptor } from "./types.ts"

export const HARNESS_COMPATIBILITY_MATRIX_VERSION = 1 as const

export type HarnessMatrixStatus = "planned" | "active" | "verified" | "live-verified" | "caller-owned" | "unavailable"

export interface HarnessCompatibilityRow {
  readonly id: string
  readonly harnessId: string
  readonly vendor: string
  readonly runtimeVersion: string
  readonly protocolVersion: string
  readonly feature: string
  readonly classification: HarnessCapabilityClassification
  readonly capability: string
  readonly authModes: readonly HarnessAuthMode[]
  readonly fixture: string
  readonly security: string
  readonly status: HarnessMatrixStatus
  readonly fallback?: string
  readonly reason?: string
}

export interface HarnessCompatibilityMatrix {
  readonly schemaVersion: typeof HARNESS_COMPATIBILITY_MATRIX_VERSION
  readonly runrailVersion: string
  readonly rows: readonly HarnessCompatibilityRow[]
}

export interface HarnessCompatibilitySummary {
  readonly total: number
  readonly verified: number
  readonly liveVerified: number
  readonly active: number
  readonly planned: number
  readonly callerOwned: number
  readonly unavailable: number
  readonly gaps: readonly string[]
}

export interface HarnessMatrixValidationOptions {
  /** Caller-owned fixture lookup. The matrix never reads arbitrary paths itself. */
  readonly fixtureExists?: (fixture: string) => boolean | PromiseLike<boolean>
  /** Deterministic proof for rows marked verified or live-verified. */
  readonly verifyRow?: (row: HarnessCompatibilityRow) => boolean | PromiseLike<boolean>
  /** Caller-owned capability proof for rows whose feature is not directly inferable from metadata. */
  readonly verifyCapability?: (row: HarnessCompatibilityRow, descriptor?: HarnessDescriptor) => boolean | PromiseLike<boolean>
  /** Optional descriptor catalog used as context for capability verification. */
  readonly descriptors?: readonly HarnessDescriptor[]
}

export type HarnessMatrixErrorCode = "HARNESS_MATRIX_INVALID" | "HARNESS_MATRIX_LIMIT"

export class HarnessMatrixError extends Error {
  constructor(readonly code: HarnessMatrixErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "HarnessMatrixError"
  }
}

export function parseHarnessCompatibilityMatrixJson(text: string): HarnessCompatibilityMatrix {
  if (typeof text !== "string" || text.length === 0 || text.length > 2 * 1024 * 1024)
    throw new HarnessMatrixError("HARNESS_MATRIX_LIMIT", "matrix JSON is outside the allowed size")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", "matrix JSON is malformed")
  }
  return parseHarnessCompatibilityMatrix(value)
}

export function parseHarnessCompatibilityMatrix(value: unknown): HarnessCompatibilityMatrix {
  const record = object(value, "matrix must be an object")
  knownKeys(record, ["schemaVersion", "runrailVersion", "rows"], "matrix")
  if (record.schemaVersion !== HARNESS_COMPATIBILITY_MATRIX_VERSION) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", "matrix schema version is unsupported")
  const runrailVersion = version(record.runrailVersion, "Runrail version")
  if (!Array.isArray(record.rows) || record.rows.length === 0) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", "matrix rows must be a non-empty array")
  if (record.rows.length > 512) throw new HarnessMatrixError("HARNESS_MATRIX_LIMIT", "matrix has too many rows")
  const ids = new Set<string>()
  const rows = record.rows.map((entry, index) => {
    const row = parseRow(entry, index)
    if (ids.has(row.id)) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", "matrix row ids must be unique")
    ids.add(row.id)
    return row
  })
  return Object.freeze({ schemaVersion: HARNESS_COMPATIBILITY_MATRIX_VERSION, runrailVersion, rows: Object.freeze(rows) })
}

/**
 * Validate executable release evidence around a parsed matrix. Parsing alone
 * proves shape; this seam proves that fixture paths, capability claims, and
 * verified statuses have caller-supplied evidence without reading payloads.
 */
export async function validateHarnessCompatibilityMatrix(
  value: HarnessCompatibilityMatrix | unknown,
  options: HarnessMatrixValidationOptions = {},
): Promise<HarnessCompatibilityMatrix> {
  const matrix = parseHarnessCompatibilityMatrix(value)
  const descriptors = new Map((options.descriptors ?? []).map((descriptor) => [descriptor.id, descriptor]))
  if (descriptors.size !== (options.descriptors ?? []).length) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", "descriptor ids must be unique")
  for (const row of matrix.rows) {
    if (options.fixtureExists !== undefined) {
      let exists = false
      try { exists = await options.fixtureExists(row.fixture) } catch { throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${row.id}: fixture check failed`) }
      if (exists !== true) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${row.id}: fixture is missing`)
    }
    const descriptor = descriptors.get(row.harnessId)
    if (options.verifyCapability !== undefined) {
      let valid = false
      try { valid = await options.verifyCapability(row, descriptor) } catch { throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${row.id}: capability check failed`) }
      if (valid !== true) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${row.id}: capability claim is unverified`)
    }
    if ((row.status === "verified" || row.status === "live-verified") && options.verifyRow !== undefined) {
      let verified = false
      try { verified = await options.verifyRow(row) } catch { throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${row.id}: verification check failed`) }
      if (verified !== true) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${row.id}: verified row has no passing check`)
    }
  }
  return matrix
}

export function summarizeHarnessCompatibilityMatrix(matrix: HarnessCompatibilityMatrix): HarnessCompatibilitySummary {
  const gaps: string[] = []
  let verified = 0
  let liveVerified = 0
  let active = 0
  let planned = 0
  let callerOwned = 0
  let unavailable = 0
  for (const row of matrix.rows) {
    if (row.status === "verified") verified += 1
    if (row.status === "live-verified") liveVerified += 1
    if (row.status === "active") active += 1
    if (row.status === "planned") planned += 1
    if (row.status === "caller-owned") callerOwned += 1
    if (row.status === "unavailable") unavailable += 1
    if ((row.status === "unavailable" || row.status === "caller-owned") && row.reason === undefined) gaps.push(`${row.id}: status requires a reason`)
    if (row.classification === "unavailable" && row.reason === undefined) gaps.push(`${row.id}: unavailable classification requires a reason`)
    if (row.fixture.length === 0) gaps.push(`${row.id}: fixture is missing`)
  }
  return Object.freeze({ total: matrix.rows.length, verified, liveVerified, active, planned, callerOwned, unavailable, gaps: Object.freeze(gaps) })
}

/** The baseline rows are deliberately conservative and never imply vendor live availability. */
export function createDefaultHarnessCompatibilityMatrix(): HarnessCompatibilityMatrix {
  return parseHarnessCompatibilityMatrix({
    schemaVersion: HARNESS_COMPATIBILITY_MATRIX_VERSION,
    runrailVersion: RUNRAIL_VERSION,
    rows: [
      row("native.lifecycle", "native", "Runrail", RUNRAIL_VERSION, "runrail.agent/1", "Lifecycle and bounded native tools", "native", "native.sessions", [], "harnesses/native-lifecycle.jsonl", "Workspace and approval policy remain enforced", "verified"),
      row("pi.pass-through", "pi", "Pi", "0.84.1", "pi.cli", "CLI, providers, sessions, and interactive UX", "pass-through", "pi.pass-through", ["subscription", "environment", "caller"], "harnesses/pi-pass-through.jsonl", "Pi retains process and account authority", "verified", "Native mapping is intentionally not claimed"),
      row("codex.lifecycle", "codex", "Codex", "caller-installed", "codex.exec.json", "Structured start, stream, terminal, and failure events", "adapter", "codex.lifecycle", ["subscription", "environment", "caller"], "harnesses/codex-lifecycle.jsonl", "Vendor process is caller-owned and not an isolation boundary", "verified", "runrail generic command adapter"),
      row("codex.approval", "codex", "Codex", "caller-installed", "codex.exec.json", "Approval requests are observable; resolution is caller-owned", "caller-owned", "codex.approval.resolve", ["subscription", "environment", "caller"], "harnesses/codex-approval.jsonl", "The exec adapter never enables or resolves vendor permissions implicitly", "caller-owned", "Use a compatible caller-supplied control protocol or Pi pass-through", "Runrail maps approval requests but the default CLI adapter has no proven resolution control"),
      row("codex.app-server.lifecycle", "codex", "Codex", "0.155.1", "codex.app-server.v2", "Bidirectional persistent thread and turn lifecycle", "adapter", "codex.app-server", ["subscription", "environment", "caller"], "harnesses/codex-app-server.jsonl", "Experimental vendor process remains caller-owned and is not an isolation boundary", "live-verified", "Use codex.exec.json one-shot mode when app-server is unavailable"),
      row("claude-code.lifecycle", "claude-code", "Claude Code", "caller-installed", "claude.stream-json", "Structured start, stream, tool, terminal, and failure events", "adapter", "claude.lifecycle", ["subscription", "environment", "caller"], "harnesses/claude-code-lifecycle.jsonl", "Vendor process is caller-owned and not an isolation boundary", "verified", "runrail generic command adapter"),
      row("claude-code.approval", "claude-code", "Claude Code", "caller-installed", "claude.stream-json", "Approval requests are observable; resolution is caller-owned", "caller-owned", "claude.approval.resolve", ["subscription", "environment", "caller"], "harnesses/claude-code-approval.jsonl", "The print adapter never enables or resolves vendor permissions implicitly", "caller-owned", "Use a compatible caller-supplied control protocol or Claude TUI pass-through", "Runrail maps approval requests but the default CLI adapter has no proven resolution control"),
      row("claude-code.sdk", "claude-code", "Claude Code", "2.1.287", "claude.agent-sdk", "Persistent session over the Agent SDK: per-call approvals, interrupt, and background-task stop", "adapter", "claude.agent-sdk", ["subscription", "environment", "caller"], "harnesses/claude-code-sdk.jsonl", "The unmodified installed claude runs with its own login and Runrail's filtered environment; it is not an isolation boundary", "verified", "Print mode when the SDK is not installed"),
      row("copilot.lifecycle", "copilot", "GitHub Copilot CLI", "1.0.62", "acp.v1", "Agent Client Protocol session, prompt, tool, approval, and cancel lifecycle", "adapter", "copilot.acp", ["subscription"], "harnesses/copilot-acp.jsonl", "Vendor process is caller-owned and not an isolation boundary; Runrail answers its permission requests and presents no editor identity", "verified", "Pi pass-through with a Copilot model Pi is signed in to"),
      row("opencode.acp", "opencode", "OpenCode", "1.2.26", "acp.v1", "Agent Client Protocol session, prompt, tool, approval, fork, and cancel lifecycle", "adapter", "opencode.acp", ["subscription"], "harnesses/opencode-acp.jsonl", "Vendor process is caller-owned and not an isolation boundary; Runrail makes OpenCode ask before edits, commands, and web tools and answers those requests", "live-verified", "Use createCandidateHarness with an explicit normalized wrapper"),
      row("gemini.acp", "gemini", "Gemini CLI", "0.62.0", "acp.v1", "Agent Client Protocol session, prompt, tool, approval, and cancel lifecycle", "adapter", "gemini.acp", ["subscription", "environment"], "harnesses/gemini-acp.jsonl", "Vendor process is caller-owned and not an isolation boundary; Runrail starts Gemini CLI in its default approval mode and answers its permission requests", "caller-owned", "Use createCandidateHarness with an explicit normalized wrapper", "Built from Gemini CLI's published source; no live Gemini turn has run through Runrail"),
      row("goose.acp", "goose", "Goose", "1.53.0", "acp.v1", "Agent Client Protocol session, prompt, tool, approval, and cancel lifecycle", "adapter", "goose.acp", ["subscription", "environment"], "harnesses/goose-acp.jsonl", "Vendor process is caller-owned and not an isolation boundary; Runrail starts Goose in approve mode and answers its permission requests", "live-verified", "Use createCandidateHarness with an explicit normalized wrapper"),
      row("pty.lifecycle", "pty", "Caller PTY", "caller-installed", "runrail.pty.jsonl", "Bounded PTY lifecycle and cancellation", "caller-owned", "pty.lifecycle", ["caller"], "harnesses/pty-lifecycle.jsonl", "PTY authority and isolation remain caller-owned", "caller-owned", "No default executable is assumed", "The caller supplies the PTY executable and isolation policy"),
      row("remote.hosting", "remote", "Caller service", "caller-owned", "runrail.http/1", "Authenticated remote control", "caller-owned", "remote.hosting", ["caller"], "harnesses/remote-hosting.jsonl", "TLS, authentication, tenancy, and retention are caller-owned", "caller-owned", "No hosted control plane is bundled", "Runrail validates a hosting contract but does not provision a service"),
      row("gemini.candidate", "gemini", "Gemini CLI", "caller-installed", "runrail.jsonl", "Caller-configured JSONL harness seam", "caller-owned", "gemini.jsonl", ["subscription", "environment", "caller"], "harnesses/candidate-gemini-jsonl.jsonl", "The caller owns the Gemini CLI account and command policy", "caller-owned", "Use createCandidateHarness with an explicit normalized wrapper", "Vendor-native Gemini protocol is not claimed until a versioned fixture is certified"),
      row("opencode.candidate", "opencode", "OpenCode", "caller-installed", "runrail.jsonl", "Caller-configured JSONL harness seam", "caller-owned", "opencode.jsonl", ["subscription", "environment", "caller"], "harnesses/candidate-opencode-jsonl.jsonl", "The caller owns the OpenCode account and command policy", "caller-owned", "Use createCandidateHarness with an explicit normalized wrapper", "Vendor-native OpenCode protocol is not claimed until a versioned fixture is certified"),
      row("aider.candidate", "aider", "Aider", "caller-installed", "runrail.jsonl", "Caller-configured JSONL harness seam", "caller-owned", "aider.jsonl", ["subscription", "environment", "caller"], "harnesses/candidate-aider-jsonl.jsonl", "The caller owns the Aider account and command policy", "caller-owned", "Use createCandidateHarness with an explicit normalized wrapper", "Vendor-native Aider protocol is not claimed until a versioned fixture is certified"),
      row("goose.candidate", "goose", "Goose", "caller-installed", "runrail.jsonl", "Caller-configured JSONL harness seam", "caller-owned", "goose.jsonl", ["subscription", "environment", "caller"], "harnesses/candidate-goose-jsonl.jsonl", "The caller owns the Goose account and command policy", "caller-owned", "Use createCandidateHarness with an explicit normalized wrapper", "Vendor-native Goose protocol is not claimed until a versioned fixture is certified"),
    ],
  })
}

function row(id: string, harnessId: string, vendor: string, runtimeVersion: string, protocolVersion: string, feature: string, classification: HarnessCapabilityClassification, capability: string, authModes: readonly HarnessAuthMode[], fixture: string, security: string, status: HarnessMatrixStatus, fallback?: string, reason?: string): Record<string, unknown> {
  return { id, harnessId, vendor, runtimeVersion, protocolVersion, feature, classification, capability, authModes, fixture, security, status, ...(fallback === undefined ? {} : { fallback }), ...(reason === undefined ? {} : { reason }) }
}

function parseRow(value: unknown, index: number): HarnessCompatibilityRow {
  const record = object(value, `matrix row ${index} must be an object`)
  knownKeys(record, ["id", "harnessId", "vendor", "runtimeVersion", "protocolVersion", "feature", "classification", "capability", "authModes", "fixture", "security", "status", "fallback", "reason"], `matrix row ${index}`)
  const authModes = stringArray(record.authModes, `matrix row ${index} auth modes`, 3, 32).map((mode) => {
    if (mode !== "subscription" && mode !== "environment" && mode !== "caller") throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `matrix row ${index} auth mode is invalid`)
    return mode
  }) as HarnessAuthMode[]
  const classification = choice(record.classification, ["native", "pass-through", "adapter", "caller-owned", "unavailable"] as const, `matrix row ${index} classification`)
  const status = choice(record.status, ["planned", "active", "verified", "live-verified", "caller-owned", "unavailable"] as const, `matrix row ${index} status`)
  if (authModes.length === 0 && classification !== "native") throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `matrix row ${index} auth modes are required`)
  if ((status === "caller-owned" || status === "unavailable" || classification === "unavailable") && typeof record.reason !== "string") throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `matrix row ${index} requires a reason`)
  return Object.freeze({
    id: identifier(record.id, `matrix row ${index} id`),
    harnessId: identifier(record.harnessId, `matrix row ${index} harness id`),
    vendor: text(record.vendor, `matrix row ${index} vendor`, 128),
    runtimeVersion: version(record.runtimeVersion, `matrix row ${index} runtime version`),
    protocolVersion: version(record.protocolVersion, `matrix row ${index} protocol version`),
    feature: text(record.feature, `matrix row ${index} feature`, 256),
    classification,
    capability: identifier(record.capability, `matrix row ${index} capability`),
    authModes: Object.freeze(authModes),
    fixture: fixturePath(record.fixture, `matrix row ${index} fixture`),
    security: text(record.security, `matrix row ${index} security`, 512),
    status,
    ...(record.fallback === undefined ? {} : { fallback: text(record.fallback, `matrix row ${index} fallback`, 512) }),
    ...(record.reason === undefined ? {} : { reason: text(record.reason, `matrix row ${index} reason`, 512) }),
  })
}

function object(value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", reason)
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || /[\r\n]/.test(value)) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} is invalid`)
  return value
}
function identifier(value: unknown, field: string): string {
  const result = text(value, field, 128)
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(result)) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} is invalid`)
  return result
}
function version(value: unknown, field: string): string {
  const result = text(value, field, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9.+:_/-]{0,63}$/.test(result) || /^(?:latest|current|any|unbounded)$/i.test(result)) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} is invalid`)
  return result
}
function fixturePath(value: unknown, field: string): string {
  const result = text(value, field, 512)
  if (result.startsWith("/") || result.includes("\\") || result.split("/").some((part) => part === "" || part === "." || part === "..")) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} must be a safe relative path`)
  return result
}
function stringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} is invalid`)
  const values = value.map((entry, index) => text(entry, `${field}[${index}]`, maxLength))
  if (new Set(values).size !== values.length) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} contains duplicates`)
  return values
}
function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} is invalid`)
  return value as T
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new HarnessMatrixError("HARNESS_MATRIX_INVALID", `${field} contains unknown fields`)
}
