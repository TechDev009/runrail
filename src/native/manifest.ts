import {
  NATIVE_API_VERSION,
  NATIVE_CONTRACT_VERSION,
  NativeContractError,
  boundedNativeCapability,
  boundedNativeId,
  boundedNativeList,
  boundedNativeOptionalText,
  boundedNativeText,
  nativeInvalid,
  nativeLimit,
  requireNativeBoolean,
} from "./errors.ts"

export type NativeExecutionMode = "trusted" | "isolated"
export type NativePackagePermission = "filesystem.read" | "filesystem.write" | "process.exec" | "network.request" | "credentials.read"
export type NativeContributionKind =
  | "tools"
  | "commands"
  | "actions"
  | "ui"
  | "providers"
  | "context"
  | "workflows"
  | "verification"
  | "repair"
  | "subagents"

export type NativeUISlot = "sidebar" | "task-header" | "timeline" | "inspector" | "composer" | "status"
export type NativeUITone = "neutral" | "positive" | "warning" | "danger"

export interface NativeUIDescriptor {
  readonly id: string
  readonly slot: NativeUISlot
  readonly label: string
  readonly stateSchema?: Readonly<Record<string, NativeUISchema>>
  readonly actions?: readonly NativeUIAction[]
  readonly capabilities: readonly string[]
  readonly accessibilityLabel?: string
}

export interface NativeUIAction {
  readonly id: string
  readonly label: string
  readonly capability?: string
  readonly approvalRequired: boolean
}

export interface NativeUISchema {
  readonly type: "string" | "number" | "boolean" | "object" | "array"
  readonly required?: boolean
  readonly items?: NativeUISchema
  readonly properties?: Readonly<Record<string, NativeUISchema>>
}

export interface NativePackageDependency {
  readonly id: string
  readonly range: string
  readonly digest?: string
}

export interface NativePackageIntegrity {
  readonly algorithm: "sha256"
  readonly digest: string
  readonly signature?: string
  readonly signer?: string
}

export interface NativeExtensionManifest {
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION
  readonly apiVersion: typeof NATIVE_API_VERSION
  readonly id: string
  readonly version: string
  readonly entry: string
  readonly mode: NativeExecutionMode
  readonly capabilities: readonly string[]
  readonly permissions: readonly NativePackagePermission[]
  readonly approval: {
    readonly required: boolean
    readonly capabilities: readonly string[]
  }
  readonly integrity: NativePackageIntegrity
  readonly dependencies: readonly NativePackageDependency[]
  readonly contributes: readonly NativeContributionKind[]
  readonly uiSchemaVersion?: string
  readonly platforms: readonly string[]
  readonly enabled: boolean
}

export interface NativePackageManifest extends NativeExtensionManifest {
  readonly packageType: "extension" | "provider" | "workflow" | "bundle"
  readonly displayName: string
  readonly description?: string
  readonly publisher?: string
  readonly tags: readonly string[]
}

export class NativeManifestError extends NativeContractError {
  constructor(reason: string) {
    super("NATIVE_INVALID", reason)
    this.name = "NativeManifestError"
  }
}

export function parseNativeExtensionManifest(value: unknown): NativeExtensionManifest {
  const record = object(value, "native manifest must be an object")
  knownKeys(record, [
    "contractVersion", "apiVersion", "id", "version", "entry", "mode", "capabilities", "permissions",
    "approval", "integrity", "dependencies", "contributes", "uiSchemaVersion", "platforms", "enabled",
  ], "native manifest")
  if (record.contractVersion !== NATIVE_CONTRACT_VERSION) throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "native manifest contract version is unsupported")
  if (record.apiVersion !== NATIVE_API_VERSION) throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "native manifest API version is unsupported")
  const id = boundedNativeId(record.id, "package id")
  const version = boundedNativeText(record.version, "package version", 64)
  const entry = boundedNativeText(record.entry, "package entry", 256)
  if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").some((part) => part === ".." || part.length === 0)) nativeInvalid("package entry is unsafe")
  if (record.mode !== "trusted" && record.mode !== "isolated") nativeInvalid("package execution mode is invalid")
  const capabilities = parseCapabilities(record.capabilities, "capabilities")
  const permissions = parsePermissions(record.permissions)
  const approval = parseApproval(record.approval, capabilities)
  const integrity = parseIntegrity(record.integrity)
  const dependencies = parseDependencies(record.dependencies)
  const contributes = parseContributions(record.contributes)
  const uiSchemaVersion = boundedNativeOptionalText(record.uiSchemaVersion, "ui schema version", 32)
  const platforms = parsePlatforms(record.platforms)
  const enabled = record.enabled === undefined ? true : requireNativeBoolean(record.enabled, "enabled")
  return Object.freeze({
    contractVersion: NATIVE_CONTRACT_VERSION,
    apiVersion: NATIVE_API_VERSION,
    id,
    version,
    entry,
    mode: record.mode,
    capabilities,
    permissions,
    approval,
    integrity,
    dependencies,
    contributes,
    ...(uiSchemaVersion === undefined ? {} : { uiSchemaVersion }),
    platforms,
    enabled,
  })
}

export function parseNativePackageManifest(value: unknown): NativePackageManifest {
  const record = object(value, "native package manifest must be an object")
  knownKeys(record, [
    "packageType", "displayName", "description", "publisher", "tags", "contractVersion", "apiVersion", "id", "version", "entry", "mode", "capabilities", "permissions",
    "approval", "integrity", "dependencies", "contributes", "uiSchemaVersion", "platforms", "enabled",
  ], "native package manifest")
  if (record.packageType !== "extension" && record.packageType !== "provider" && record.packageType !== "workflow" && record.packageType !== "bundle") nativeInvalid("package type is invalid")
  const baseRecord: Record<string, unknown> = {}
  for (const key of ["contractVersion", "apiVersion", "id", "version", "entry", "mode", "capabilities", "permissions", "approval", "integrity", "dependencies", "contributes", "uiSchemaVersion", "platforms", "enabled"]) baseRecord[key] = record[key]
  const base = parseNativeExtensionManifest(baseRecord)
  const displayName = boundedNativeText(record.displayName, "display name", 160)
  const description = boundedNativeOptionalText(record.description, "description", 2_048)
  const publisher = boundedNativeOptionalText(record.publisher, "publisher", 160)
  const tags = boundedNativeList(record.tags, "tags", 32, (entry, index) => boundedNativeCapability(entry, `tag ${index}`))
  return Object.freeze({
    ...base,
    packageType: record.packageType,
    displayName,
    ...(description === undefined ? {} : { description }),
    ...(publisher === undefined ? {} : { publisher }),
    tags,
  })
}

export function parseNativeManifestJson(text: string): NativeExtensionManifest {
  if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024) throw new NativeManifestError("manifest JSON is invalid")
  try {
    return parseNativeExtensionManifest(JSON.parse(text))
  } catch (error) {
    if (error instanceof NativeContractError) throw error
    throw new NativeManifestError("manifest JSON cannot be parsed")
  }
}

function parseCapabilities(value: unknown, name: string): readonly string[] {
  return boundedNativeList(value, name, 64, (entry, index) => boundedNativeCapability(entry, `${name}[${index}]`))
}

function parsePermissions(value: unknown): readonly NativePackagePermission[] {
  if (!Array.isArray(value) || value.length > 16) nativeInvalid("permissions are invalid")
  const allowed: readonly NativePackagePermission[] = ["filesystem.read", "filesystem.write", "process.exec", "network.request", "credentials.read"]
  const result = value.map((entry) => {
    if (!allowed.includes(entry as NativePackagePermission)) nativeInvalid("permissions contain an unsupported value")
    return entry as NativePackagePermission
  })
  if (new Set(result).size !== result.length) nativeInvalid("permissions contain duplicates")
  return Object.freeze(result.sort())
}

function parseApproval(value: unknown, capabilities: readonly string[]): NativeExtensionManifest["approval"] {
  const record = object(value, "approval policy is invalid")
  knownKeys(record, ["required", "capabilities"], "approval policy")
  const required = requireNativeBoolean(record.required, "approval.required")
  const approvalCapabilities = parseCapabilities(record.capabilities, "approval capabilities")
  if (approvalCapabilities.some((capability) => !capabilities.includes(capability))) nativeInvalid("approval capability is not declared")
  return Object.freeze({ required, capabilities: approvalCapabilities })
}

function parseIntegrity(value: unknown): NativePackageIntegrity {
  const record = object(value, "integrity is invalid")
  knownKeys(record, ["algorithm", "digest", "signature", "signer"], "integrity")
  if (record.algorithm !== "sha256") nativeInvalid("integrity algorithm is unsupported")
  const digest = boundedNativeText(record.digest, "integrity digest", 128)
  if (!/^[a-f0-9]{64}$/i.test(digest)) nativeInvalid("integrity digest is invalid")
  const signature = boundedNativeOptionalText(record.signature, "integrity signature", 4_096)
  const signer = boundedNativeOptionalText(record.signer, "integrity signer", 256)
  return Object.freeze({ algorithm: "sha256", digest: digest.toLowerCase(), ...(signature === undefined ? {} : { signature }), ...(signer === undefined ? {} : { signer }) })
}

function parseDependencies(value: unknown): readonly NativePackageDependency[] {
  return boundedNativeList(value, "dependencies", 256, (entry) => {
    const record = object(entry, "dependency is invalid")
    knownKeys(record, ["id", "range", "digest"], "dependency")
    const id = boundedNativeId(record.id, "dependency id")
    const range = boundedNativeText(record.range, "dependency range", 128)
    const digest = boundedNativeOptionalText(record.digest, "dependency digest", 128)
    if (digest !== undefined && !/^[a-f0-9]{64}$/i.test(digest)) nativeInvalid("dependency digest is invalid")
    return Object.freeze({ id, range, ...(digest === undefined ? {} : { digest: digest.toLowerCase() }) })
  })
}

function parseContributions(value: unknown): readonly NativeContributionKind[] {
  const allowed: readonly NativeContributionKind[] = ["tools", "commands", "actions", "ui", "providers", "context", "workflows", "verification", "repair", "subagents"]
  if (!Array.isArray(value) || value.length > allowed.length) nativeLimit("contributions are invalid")
  const entries = value as readonly unknown[]
  const result = entries.map((entry) => {
    if (!allowed.includes(entry as NativeContributionKind)) nativeInvalid("contribution is unsupported")
    return entry as NativeContributionKind
  })
  if (new Set(result).size !== result.length) nativeInvalid("contributions contain duplicates")
  return Object.freeze(result.sort())
}

function parsePlatforms(value: unknown): readonly string[] {
  return boundedNativeList(value, "platforms", 16, (entry, index) => boundedNativeId(entry, `platform ${index}`, 64))
}

function object(value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) nativeInvalid(reason)
  return value as Record<string, unknown>
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) nativeInvalid(`${name} contains unknown fields`)
}
