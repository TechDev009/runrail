import { NATIVE_API_VERSION, NATIVE_CONTRACT_VERSION, NativeContractError, boundedNativeCapability, boundedNativeId, boundedNativeText } from "./errors.ts"

export const NATIVE_MATRIX_VERSION = 1 as const
export type NativeCapabilityStatus = "planned" | "active" | "verified" | "caller-owned" | "unavailable"
export type NativeCapabilityClassification = "native" | "adapter" | "caller-owned" | "unavailable"

export interface NativeCapabilityRow {
  readonly id: string
  readonly owner: "engine" | "desktop" | "host" | "provider" | "operator"
  readonly surface: string
  readonly classification: NativeCapabilityClassification
  readonly api: string
  readonly stateModel: string
  readonly authority: string
  readonly fixture: string
  readonly fallback?: string
  readonly status: NativeCapabilityStatus
  readonly reason?: string
}

export interface NativeCapabilityMatrix {
  readonly schemaVersion: typeof NATIVE_MATRIX_VERSION
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION
  readonly apiVersion: typeof NATIVE_API_VERSION
  readonly rows: readonly NativeCapabilityRow[]
}

export interface NativeCapabilitySummary {
  readonly total: number
  readonly verified: number
  readonly active: number
  readonly planned: number
  readonly callerOwned: number
  readonly unavailable: number
  readonly gaps: readonly string[]
}

export function createDefaultNativeCapabilityMatrix(): NativeCapabilityMatrix {
  return parseNativeCapabilityMatrix({
    schemaVersion: NATIVE_MATRIX_VERSION,
    contractVersion: NATIVE_CONTRACT_VERSION,
    apiVersion: NATIVE_API_VERSION,
    rows: [
      row("task.kernel", "engine", "Task lifecycle", "native", "native.task/1", "task state plus replayable event journal", "workspace, approval, and idempotency policy", "native-task-contract", "verified"),
      row("coding.loop", "engine", "Coding loop", "native", "native.session/1", "session and turn lifecycle", "workspace policy and tool approval", "native-coding-loop", "verified"),
      row("verification.repair", "engine", "Verification and repair", "native", "native.verification/1", "verification and bounded repair state", "approval and repair budget", "native-verification", "verified"),
      row("orchestration.plans", "engine", "Plans and goals", "native", "native.plan/1", "bounded plan graph and progress", "plan policy and cancellation", "native-plan", "verified"),
      row("orchestration.agents", "engine", "Agents and handoffs", "native", "native.agents/1", "worker snapshots and handoff packets", "native loop only, within the parent's capabilities, depth, and workspace", "native-agents", "verified"),
      row("integration.mcp", "engine", "MCP", "adapter", "native.mcp/1", "bounded tool/resource/prompt bridge", "caller transport and capability approval", "native-mcp", "verified", "Caller supplies MCP servers; Runrail owns the bridge contract."),
      row("integration.connectors", "engine", "Connectors", "adapter", "native.connector/1", "declared actions and approval state", "caller credentials and external service policy", "native-connectors", "verified", "Service operation and accounts remain explicit caller or host integrations."),
      row("extensions.native", "engine", "Native extensions", "native", "native.extension/1", "transactional contribution graph and UI schema", "manifest capabilities, permissions, approval, and isolation", "native-extensions", "active", "Native extension API and cross-shell rendering are still being completed."),
      row("packages.native", "engine", "Native packages", "native", "native.package/1", "lockfile, dependency graph, integrity, and rollback", "signature, source, dependency, and activation policy", "native-packages", "active", "Install resolves dependencies into a lockfile and checks pinned signers; remote registry sources and running package code are planned."),
      row("accounts.native", "engine", "Accounts and auth", "native", "native.account/1", "account reference and credential broker state", "desktop vault or caller broker; secret values never persist", "native-accounts", "active", "Native account broker and desktop auth flows are still being completed."),
      row("providers.native", "engine", "Provider protocols", "adapter", "native.provider/1", "model catalog and routed provider session", "provider policy, account scope, and endpoint allowlist", "native-providers", "verified", "Provider-specific accounts and OAuth flows use the native account contract."),
      row("sharing.local", "engine", "Local sharing", "native", "native.share/1", "bounded export, invite, access, and revoke state", "payload opt-in, encryption, and local ownership", "native-share-local", "active", "Native share protocol and encrypted local bundles are still being completed."),
      row("sharing.hosted", "host", "Hosted collaboration", "native", "host.task/1", "durable shared task/event/artifact state", "identity, authorization, retention, quotas, and audit", "host-sharing", "planned", "No Runrail Host service exists yet; sharing is local only."),
      row("desktop.cockpit", "desktop", "Native desktop cockpit", "native", "desktop.task/1", "task timeline, inspectors, accounts, packages, and share flows", "macOS workspace access and Keychain", "desktop-cockpit", "active", "Desktop task cockpit integration is still being completed."),
      row("hosting.operation", "host", "Hosted operation", "native", "host.control/1", "registry, identity, storage, and deployment profiles", "operator-owned infrastructure and certificates", "host-operation", "planned", "No first-party hosted operation exists yet; an operator runs `runrail serve` with its own TLS and hosting."),
      row("sandbox.isolation", "operator", "Strong isolation", "caller-owned", "native.sandbox/1", "supplied executor descriptor and probe", "caller OS/container/VM executor", "sandbox-boundary", "caller-owned", "Runrail validates but does not provision hostile-code isolation."),
    ],
  })
}

export function parseNativeCapabilityMatrix(value: unknown): NativeCapabilityMatrix {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeContractError("NATIVE_INVALID", "native capability matrix is invalid")
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== NATIVE_MATRIX_VERSION || record.contractVersion !== NATIVE_CONTRACT_VERSION || record.apiVersion !== NATIVE_API_VERSION)
    throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "native capability matrix version is unsupported")
  if (!Array.isArray(record.rows) || record.rows.length === 0 || record.rows.length > 256) throw new NativeContractError("NATIVE_LIMIT", "native capability matrix rows are invalid")
  const ids = new Set<string>()
  const rows = record.rows.map((entry) => parseRow(entry))
  for (const item of rows) {
    if (ids.has(item.id)) throw new NativeContractError("NATIVE_DUPLICATE", "native capability row ids must be unique")
    ids.add(item.id)
  }
  return Object.freeze({ schemaVersion: NATIVE_MATRIX_VERSION, contractVersion: NATIVE_CONTRACT_VERSION, apiVersion: NATIVE_API_VERSION, rows: Object.freeze(rows) })
}

export function summarizeNativeCapabilityMatrix(matrix: NativeCapabilityMatrix): NativeCapabilitySummary {
  let verified = 0
  let active = 0
  let planned = 0
  let callerOwned = 0
  let unavailable = 0
  const gaps: string[] = []
  for (const row of matrix.rows) {
    if (row.status === "verified") verified += 1
    if (row.status === "active") active += 1
    if (row.status === "planned") planned += 1
    if (row.status === "caller-owned") callerOwned += 1
    if (row.status === "unavailable") unavailable += 1
    if ((row.status === "active" || row.status === "planned" || row.status === "unavailable" || row.classification === "unavailable") && row.reason === undefined) gaps.push(`${row.id}: reason is required`)
    if (row.fixture.length === 0) gaps.push(`${row.id}: fixture is required`)
  }
  return Object.freeze({ total: matrix.rows.length, verified, active, planned, callerOwned, unavailable, gaps: Object.freeze(gaps) })
}

function row(
  id: string,
  owner: NativeCapabilityRow["owner"],
  surface: string,
  classification: NativeCapabilityClassification,
  api: string,
  stateModel: string,
  authority: string,
  fixture: string,
  status: NativeCapabilityStatus,
  reason?: string,
  fallback?: string,
): Record<string, unknown> {
  return { id, owner, surface, classification, api, stateModel, authority, fixture, status, ...(reason === undefined ? {} : { reason }), ...(fallback === undefined ? {} : { fallback }) }
}

function parseRow(value: unknown): NativeCapabilityRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeContractError("NATIVE_INVALID", "native capability row is invalid")
  const record = value as Record<string, unknown>
  const id = boundedNativeId(record.id, "row id")
  const owner = parseEnum(record.owner, ["engine", "desktop", "host", "provider", "operator"], "row owner")
  const surface = boundedNativeText(record.surface, "row surface", 128)
  const classification = parseEnum(record.classification, ["native", "adapter", "caller-owned", "unavailable"], "row classification")
  const api = boundedNativeCapability(record.api, "row api")
  const stateModel = boundedNativeText(record.stateModel, "row state model", 512)
  const authority = boundedNativeText(record.authority, "row authority", 512)
  const fixture = boundedNativeId(record.fixture, "row fixture", 256)
  const status = parseEnum(record.status, ["planned", "active", "verified", "caller-owned", "unavailable"], "row status")
  const reason = record.reason === undefined ? undefined : boundedNativeText(record.reason, "row reason", 512)
  const fallback = record.fallback === undefined ? undefined : boundedNativeText(record.fallback, "row fallback", 512)
  if ((status === "active" || status === "planned" || status === "unavailable" || classification === "unavailable") && reason === undefined)
    throw new NativeContractError("NATIVE_INVALID", "native capability row needs a reason")
  return Object.freeze({ id, owner, surface, classification, api, stateModel, authority, fixture, status, ...(reason === undefined ? {} : { reason }), ...(fallback === undefined ? {} : { fallback }) })
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) throw new NativeContractError("NATIVE_INVALID", `${name} is invalid`)
  return value as T
}
