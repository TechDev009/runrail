import type { AgentBackend } from "@nifrajs/agent-protocol"
import { HarnessRegistry, HarnessRegistryError } from "./registry.ts"
import type { HarnessAdapter, HarnessAuthMode, HarnessCapabilityClassification, HarnessControl, HarnessDescriptor, HarnessEventFamily, HarnessFeature, HarnessKind } from "./types.ts"

export const HARNESS_SDK_VERSION = "1.0" as const
export const HARNESS_ADAPTER_MANIFEST_VERSION = 1 as const

export interface HarnessAdapterManifest {
  readonly manifestVersion: typeof HARNESS_ADAPTER_MANIFEST_VERSION
  readonly id: string
  readonly name: string
  readonly apiVersion: string
  readonly adapterVersion: string
  readonly runtimeVersion: string
  readonly protocolVersion: string
  readonly kind: HarnessKind
  readonly classification: HarnessCapabilityClassification
  readonly features: readonly HarnessFeature[]
  readonly capabilities: readonly string[]
  readonly controls: readonly HarnessControl[]
  readonly events: readonly HarnessEventFamily[]
  readonly authModes: readonly HarnessAuthMode[]
  /**
   * Labels for people reading the manifest ("caller-process", "bounded-jsonl"). Runrail cannot check
   * free text; what it does enforce is that a backend advertises only the declared capabilities.
   */
  readonly security: readonly string[]
}

export interface HarnessAdapterModule {
  readonly manifest: HarnessAdapterManifest
  readonly create: (context: { readonly cwd: string; readonly requestedFeatures: readonly HarnessFeature[] }) => AgentBackend | PromiseLike<AgentBackend>
}

export type HarnessSdkErrorCode = "HARNESS_SDK_INVALID" | "HARNESS_SDK_UNSUPPORTED" | "HARNESS_SDK_REGISTRATION_FAILED"

export class HarnessSdkError extends Error {
  constructor(readonly code: HarnessSdkErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "HarnessSdkError"
  }
}

export function parseHarnessAdapterManifest(value: unknown): HarnessAdapterManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HarnessSdkError("HARNESS_SDK_INVALID", "manifest must be an object")
  const record = value as Record<string, unknown>
  if (record.manifestVersion !== HARNESS_ADAPTER_MANIFEST_VERSION) throw new HarnessSdkError("HARNESS_SDK_UNSUPPORTED", "manifest version is unsupported")
  const apiVersion = text(record.apiVersion, "apiVersion", 16)
  if (!/^1\.[0-9]+$/.test(apiVersion)) throw new HarnessSdkError("HARNESS_SDK_UNSUPPORTED", "adapter API major version is unsupported")
  const kind = choice(record.kind, ["native", "pi", "codex", "claude-code", "copilot", "gemini", "opencode", "aider", "goose", "grok", "pty", "remote", "a2a", "custom"] as const, "kind")
  const classification = choice(record.classification, ["native", "pass-through", "adapter", "caller-owned", "unavailable"] as const, "classification")
  const features = enumList(record.features, ["sessions", "streaming", "tools", "approvals", "reload", "compact", "fork", "mcp", "skills", "connectors", "worktrees", "provider.switch", "verification", "repair"] as const, "features")
  const controls = enumList(record.controls, ["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "fork", "compact", "model", "thinking", "sandbox", "mcp", "inspect", "close"] as const, "controls")
  const events = enumList(record.events, ["lifecycle", "turn", "assistant", "tool", "approval", "usage", "rate-limit", "compaction", "cancellation", "failure"] as const, "events")
  const authModes = enumList(record.authModes, ["subscription", "environment", "caller"] as const, "authModes")
  const capabilities = stringList(record.capabilities, "capabilities", 64, 128)
  if (capabilities.some((capability) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(capability))) throw new HarnessSdkError("HARNESS_SDK_INVALID", "capabilities contains an invalid value")
  return Object.freeze({
    manifestVersion: HARNESS_ADAPTER_MANIFEST_VERSION,
    id: identifier(record.id, "id"),
    name: text(record.name, "name", 128),
    apiVersion,
    adapterVersion: version(record.adapterVersion, "adapterVersion"),
    runtimeVersion: version(record.runtimeVersion, "runtimeVersion"),
    protocolVersion: version(record.protocolVersion, "protocolVersion"),
    kind,
    classification,
    features,
    capabilities,
    controls,
    events,
    authModes,
    security: stringList(record.security, "security", 32, 256),
  })
}

export function createHarnessAdapterModule(manifest: HarnessAdapterManifest, create: HarnessAdapterModule["create"]): HarnessAdapter {
  const parsed = parseHarnessAdapterManifest(manifest)
  const descriptor: HarnessDescriptor = Object.freeze({
    id: parsed.id,
    name: parsed.name,
    version: parsed.adapterVersion,
    runtimeVersion: parsed.runtimeVersion,
    protocolVersion: parsed.protocolVersion,
    kind: parsed.kind,
    classification: parsed.classification,
    features: Object.freeze([...parsed.features]),
    capabilities: Object.freeze([...parsed.capabilities]),
    controls: Object.freeze([...parsed.controls]),
    events: Object.freeze([...parsed.events]),
    authModes: Object.freeze([...parsed.authModes]),
    defaultAuthMode: parsed.authModes.includes("subscription") ? "subscription" : parsed.authModes[0],
  })
  const guarded: HarnessAdapterModule["create"] = async (context) => {
    const undeclared = context.requestedFeatures.filter((feature) => !parsed.features.includes(feature))
    if (undeclared.length > 0) throw new HarnessSdkError("HARNESS_SDK_UNSUPPORTED", `adapter does not declare ${undeclared.join(", ")}`)
    const backend = await create(context)
    if (backend.info.capabilities.some((capability) => !parsed.capabilities.includes(capability)))
      throw new HarnessSdkError("HARNESS_SDK_INVALID", "backend advertises capabilities its manifest does not declare")
    return backend
  }
  const adapter: HarnessAdapter = Object.freeze({ descriptor, create: guarded })
  try {
    new HarnessRegistry([adapter])
  } catch (error) {
    if (error instanceof HarnessRegistryError) throw new HarnessSdkError("HARNESS_SDK_REGISTRATION_FAILED", error.message)
    throw error
  }
  return adapter
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || /[\r\n]/.test(value)) throw new HarnessSdkError("HARNESS_SDK_INVALID", `${field} is invalid`)
  return value
}
function identifier(value: unknown, field: string): string {
  const result = text(value, field, 64)
  if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(result)) throw new HarnessSdkError("HARNESS_SDK_INVALID", `${field} is invalid`)
  return result
}
function version(value: unknown, field: string): string {
  const result = text(value, field, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9.+:_/-]{0,63}$/.test(result)) throw new HarnessSdkError("HARNESS_SDK_INVALID", `${field} is invalid`)
  return result
}
function stringList(value: unknown, field: string, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((entry) => typeof entry !== "string")) throw new HarnessSdkError("HARNESS_SDK_INVALID", `${field} is invalid`)
  const values = value.map((entry, index) => text(entry, `${field}[${index}]`, maxLength))
  return Object.freeze([...new Set(values)].sort())
}
function enumList<T extends string>(value: unknown, allowed: readonly T[], field: string): readonly T[] {
  const values = stringList(value, field, 64, 128)
  if (values.some((entry) => !allowed.includes(entry as T))) throw new HarnessSdkError("HARNESS_SDK_INVALID", `${field} contains an unsupported value`)
  return Object.freeze(values as T[])
}
function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new HarnessSdkError("HARNESS_SDK_INVALID", `${field} is invalid`)
  return value as T
}
