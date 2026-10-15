import type {
  PluginPermission,
  RunrailPluginManifest,
} from "./manifest.ts"
import { parsePluginManifest } from "./manifest.ts"

export interface PluginTrustPolicy {
  readonly capabilities?: readonly string[]
  readonly permissions?: readonly PluginPermission[]
  readonly allowTrusted?: boolean
  readonly allowIsolated?: boolean
}

export interface PluginAdmissionRequest {
  readonly id: string
  readonly requiredCapabilities?: readonly string[]
  readonly approvalGranted?: boolean
}

export interface PluginAdmission {
  readonly manifest: RunrailPluginManifest
  readonly capabilities: readonly string[]
  readonly permissions: readonly PluginPermission[]
  readonly mode: RunrailPluginManifest["mode"]
  readonly approvalRequired: boolean
}

export type PluginRegistryErrorCode =
  | "PLUGIN_INVALID"
  | "PLUGIN_DUPLICATE"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_DISABLED"
  | "PLUGIN_CAPABILITY_ESCALATION"
  | "PLUGIN_PERMISSION_ESCALATION"
  | "PLUGIN_APPROVAL_REQUIRED"
  | "PLUGIN_EXECUTION_MODE_DENIED"

export class PluginRegistryError extends Error {
  constructor(readonly code: PluginRegistryErrorCode, reason: string) {
    super(`plugin registry: ${reason}`)
    this.name = "PluginRegistryError"
  }
}

/** Admission registry. Registration is metadata-only; code executes only after explicit admission. */
export class PluginRegistry {
  private readonly manifests = new Map<string, RunrailPluginManifest>()

  constructor(manifests: readonly RunrailPluginManifest[] = []) {
    for (const manifest of manifests) this.register(manifest)
  }

  register(manifest: RunrailPluginManifest): this {
    const parsed = parsePluginManifest(manifest)
    if (this.manifests.has(parsed.id))
      throw new PluginRegistryError("PLUGIN_DUPLICATE", `duplicate plugin '${parsed.id}'`)
    this.manifests.set(parsed.id, parsed)
    return this
  }

  clear(): this {
    this.manifests.clear()
    return this
  }

  replace(manifest: RunrailPluginManifest): this {
    const parsed = parsePluginManifest(manifest)
    this.manifests.set(parsed.id, parsed)
    return this
  }

  get(id: string): RunrailPluginManifest | undefined {
    return this.manifests.get(id)
  }

  list(): readonly RunrailPluginManifest[] {
    return Object.freeze([...this.manifests.values()].sort((a, b) => a.id.localeCompare(b.id)))
  }

  admit(request: PluginAdmissionRequest, policy: PluginTrustPolicy = {}): PluginAdmission {
    const parsedRequest = parseAdmissionRequest(request)
    const parsedPolicy = parseTrustPolicy(policy)
    const manifest = this.manifests.get(parsedRequest.id)
    if (manifest === undefined) throw new PluginRegistryError("PLUGIN_NOT_FOUND", `unknown plugin '${parsedRequest.id}'`)
    if (!manifest.enabled) throw new PluginRegistryError("PLUGIN_DISABLED", `plugin '${parsedRequest.id}' is disabled`)
    if (manifest.mode === "trusted" && parsedPolicy.allowTrusted === false)
      throw new PluginRegistryError("PLUGIN_EXECUTION_MODE_DENIED", "trusted plugin execution is disabled")
    if (manifest.mode === "isolated" && parsedPolicy.allowIsolated === false)
      throw new PluginRegistryError("PLUGIN_EXECUTION_MODE_DENIED", "isolated plugin execution is disabled")
    const trustedCapabilities = new Set(parsedPolicy.capabilities)
    const trustedPermissions = new Set(parsedPolicy.permissions)
    if (manifest.capabilities.some((capability) => !trustedCapabilities.has(capability)))
      throw new PluginRegistryError("PLUGIN_CAPABILITY_ESCALATION", `plugin '${parsedRequest.id}' requests an untrusted capability`)
    if (manifest.permissions.some((permission) => !trustedPermissions.has(permission)))
      throw new PluginRegistryError("PLUGIN_PERMISSION_ESCALATION", `plugin '${parsedRequest.id}' requests an untrusted permission`)
    if (parsedRequest.requiredCapabilities.some((capability) => !manifest.capabilities.includes(capability)))
      throw new PluginRegistryError("PLUGIN_CAPABILITY_ESCALATION", "requested capability is not declared by the plugin")
    if (manifest.approval.required && parsedRequest.approvalGranted !== true)
      throw new PluginRegistryError("PLUGIN_APPROVAL_REQUIRED", `plugin '${parsedRequest.id}' requires approval`)
    return Object.freeze({
      manifest,
      capabilities: manifest.capabilities,
      permissions: manifest.permissions,
      mode: manifest.mode,
      approvalRequired: manifest.approval.required,
    })
  }
}

function parseAdmissionRequest(value: unknown): PluginAdmissionRequest & { readonly requiredCapabilities: readonly string[] } {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(value.id))
    throw new PluginRegistryError("PLUGIN_INVALID", "plugin admission request is invalid")
  const requiredCapabilities = parseCapabilityList(value.requiredCapabilities)
  if (value.approvalGranted !== undefined && typeof value.approvalGranted !== "boolean")
    throw new PluginRegistryError("PLUGIN_INVALID", "plugin approval decision is invalid")
  return {
    id: value.id,
    requiredCapabilities,
    ...(value.approvalGranted === undefined ? {} : { approvalGranted: value.approvalGranted }),
  }
}

function parseTrustPolicy(value: unknown): PluginTrustPolicy & { readonly capabilities: readonly string[]; readonly permissions: readonly PluginPermission[] } {
  if (!isRecord(value)) throw new PluginRegistryError("PLUGIN_INVALID", "plugin trust policy is invalid")
  const capabilities = parseCapabilityList(value.capabilities)
  const rawPermissions = parseCapabilityList(value.permissions)
  const permissions: PluginPermission[] = []
  for (const permission of rawPermissions) {
    const parsedPermission = parsePluginPermission(permission)
    if (parsedPermission === undefined)
      throw new PluginRegistryError("PLUGIN_INVALID", "plugin trust permission is invalid")
    permissions.push(parsedPermission)
  }
  if (value.allowTrusted !== undefined && typeof value.allowTrusted !== "boolean")
    throw new PluginRegistryError("PLUGIN_INVALID", "trusted execution policy is invalid")
  if (value.allowIsolated !== undefined && typeof value.allowIsolated !== "boolean")
    throw new PluginRegistryError("PLUGIN_INVALID", "isolated execution policy is invalid")
  return {
    capabilities,
    permissions: Object.freeze(permissions),
    ...(value.allowTrusted === undefined ? {} : { allowTrusted: value.allowTrusted }),
    ...(value.allowIsolated === undefined ? {} : { allowIsolated: value.allowIsolated }),
  }
}

function parsePluginPermission(value: string): PluginPermission | undefined {
  if (value === "filesystem.read" || value === "filesystem.write" || value === "process.exec" || value === "network.request" || value === "credentials.read") return value
  return undefined
}

function parseCapabilityList(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item)))
    throw new PluginRegistryError("PLUGIN_INVALID", "plugin capability list is invalid")
  return Object.freeze([...new Set(value)])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function createPluginRegistry(manifests: readonly RunrailPluginManifest[] = []): PluginRegistry {
  return new PluginRegistry(manifests)
}
