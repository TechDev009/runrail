export const RUNRAIL_PLUGIN_MANIFEST_VERSION = 1 as const
export const RUNRAIL_PLUGIN_API_VERSION = "1.0" as const
export const RUNRAIL_PLUGIN_MANIFEST_FILE = "runrail.plugin.json" as const

export type PluginExecutionMode = "trusted" | "isolated"
export type PluginContributionKind =
  | "tools"
  | "commands"
  | "prompts"
  | "skills"
  | "themes"
  | "ui"
  | "providers"
  | "verification"
  | "workflows"
  | "subagents"
  | "actions"
  | "hooks"
  | "native-ui"
export type PluginPermission =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.request"
  | "credentials.read"

export interface PluginApprovalPolicy {
  readonly required: boolean
  readonly capabilities: readonly string[]
}

export interface PluginIntegrity {
  readonly algorithm: "sha256"
  readonly digest: string
}

export interface PluginJsonSchema {
  readonly type: "object" | "string" | "number" | "boolean" | "array" | "null"
  readonly properties?: Readonly<Record<string, PluginJsonSchema>>
  readonly items?: PluginJsonSchema
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
}

export interface RunrailPluginManifest {
  readonly manifestVersion: typeof RUNRAIL_PLUGIN_MANIFEST_VERSION
  readonly id: string
  readonly version: string
  readonly apiVersion: string
  readonly entry: string
  readonly mode: PluginExecutionMode
  readonly capabilities: readonly string[]
  readonly permissions: readonly PluginPermission[]
  readonly approval: PluginApprovalPolicy
  readonly integrity: PluginIntegrity
  readonly contributes: readonly PluginContributionKind[]
  readonly configuration?: PluginJsonSchema
  readonly enabled: boolean
}

export type PluginManifestErrorCode =
  | "PLUGIN_MANIFEST_INVALID"
  | "PLUGIN_SCHEMA_INVALID"
  | "PLUGIN_CONFIG_INVALID"

export class PluginManifestError extends Error {
  constructor(readonly code: PluginManifestErrorCode, reason: string) {
    super(`plugin manifest: ${reason}`)
    this.name = "PluginManifestError"
  }
}

export function parsePluginManifest(value: unknown): RunrailPluginManifest {
  if (!isRecord(value)) invalid("manifest must be an object")
  if (value.manifestVersion !== RUNRAIL_PLUGIN_MANIFEST_VERSION)
    invalid("manifest version is unsupported")
  const id = boundedString(value.id, 1, 128, "id")
  if (!/^[a-z][a-z0-9._-]{0,127}$/.test(id)) invalid("id is invalid")
  const version = boundedString(value.version, 1, 64, "version")
  const apiVersion = boundedString(value.apiVersion, 1, 32, "apiVersion")
  if (apiVersion !== RUNRAIL_PLUGIN_API_VERSION) invalid("apiVersion is unsupported")
  const entry = boundedString(value.entry, 1, 256, "entry")
  if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes(".."))
    invalid("entry must be a safe relative path")
  if (value.mode !== "trusted" && value.mode !== "isolated") invalid("execution mode is invalid")
  const capabilities = parseStringList(value.capabilities, 64, 128, "capabilities", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
  const permissions = parseEnumList(
    value.permissions,
    16,
    ["filesystem.read", "filesystem.write", "process.exec", "network.request", "credentials.read"],
    "permissions",
  )
  if (!isRecord(value.approval)) invalid("approval policy is invalid")
  if (typeof value.approval.required !== "boolean") invalid("approval.required is invalid")
  const approvalCapabilities = parseStringList(
    value.approval.capabilities,
    64,
    128,
    "approval capabilities",
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/,
  )
  if (approvalCapabilities.some((capability) => !capabilities.includes(capability)))
    invalid("approval capabilities must be declared capabilities")
  if (!isRecord(value.integrity)) invalid("integrity is invalid")
  if (value.integrity.algorithm !== "sha256" || typeof value.integrity.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.integrity.digest))
    invalid("sha256 integrity digest is invalid")
  const contributes = parseEnumList(
    value.contributes,
    16,
    ["tools", "commands", "prompts", "skills", "themes", "ui", "providers", "verification", "workflows", "subagents", "actions", "hooks", "native-ui"],
    "contributes",
  )
  const configuration = value.configuration === undefined ? undefined : parseSchema(value.configuration, 0)
  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== "boolean") invalid("enabled is invalid")
  return Object.freeze({
    manifestVersion: RUNRAIL_PLUGIN_MANIFEST_VERSION,
    id,
    version,
    apiVersion,
    entry,
    mode: value.mode,
    capabilities,
    permissions,
    approval: Object.freeze({ required: value.approval.required, capabilities: approvalCapabilities }),
    integrity: Object.freeze({ algorithm: "sha256", digest: value.integrity.digest }),
    contributes,
    ...(configuration === undefined ? {} : { configuration }),
    enabled,
  })
}

export function parsePluginManifestJson(text: string): RunrailPluginManifest {
  if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024)
    throw new PluginManifestError("PLUGIN_MANIFEST_INVALID", "manifest JSON is invalid")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PluginManifestError("PLUGIN_MANIFEST_INVALID", "manifest JSON cannot be parsed")
  }
  return parsePluginManifest(value)
}

export function validatePluginConfiguration(
  manifest: RunrailPluginManifest,
  value: unknown,
): void {
  if (manifest.configuration === undefined) {
    if (value !== undefined) configInvalid("plugin does not declare configuration")
    return
  }
  validateValue(manifest.configuration, value, "configuration", 0)
}

function parseSchema(value: unknown, depth: number): PluginJsonSchema {
  if (depth > 8 || !isRecord(value)) schemaInvalid("configuration schema is invalid")
  const type = parseSchemaType(value.type)
  const propertiesValue = value.properties
  let properties: Readonly<Record<string, PluginJsonSchema>> | undefined
  if (propertiesValue !== undefined) {
    if (!isRecord(propertiesValue) || Object.keys(propertiesValue).length > 64)
      schemaInvalid("configuration schema properties are invalid")
    const parsed: Record<string, PluginJsonSchema> = {}
    for (const [key, schema] of Object.entries(propertiesValue)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) schemaInvalid("configuration property name is invalid")
      parsed[key] = parseSchema(schema, depth + 1)
    }
    properties = Object.freeze(parsed)
  }
  const required = value.required === undefined ? undefined : parseStringList(value.required, 64, 64, "required", /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/)
  if (type === "object" && required !== undefined && properties !== undefined && required.some((key) => properties[key] === undefined))
    schemaInvalid("required configuration property is not declared")
  const items = value.items === undefined ? undefined : parseSchema(value.items, depth + 1)
  if (type === "array" && items === undefined) schemaInvalid("array schema must declare items")
  if (type !== "array" && items !== undefined) schemaInvalid("items require array schema")
  if (type !== "object" && (properties !== undefined || required !== undefined)) schemaInvalid("object fields require object schema")
  const additionalProperties = value.additionalProperties
  if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") schemaInvalid("additionalProperties is invalid")
  return Object.freeze({
    type,
    ...(properties === undefined ? {} : { properties }),
    ...(items === undefined ? {} : { items }),
    ...(required === undefined ? {} : { required }),
    additionalProperties: additionalProperties === true,
  })
}

function parseSchemaType(value: unknown): PluginJsonSchema["type"] {
  if (value === "object" || value === "string" || value === "number" || value === "boolean" || value === "array" || value === "null") return value
  schemaInvalid("configuration schema type is invalid")
}

function validateValue(schema: PluginJsonSchema, value: unknown, path: string, depth: number): void {
  if (depth > 8) configInvalid(`${path} is too deep`)
  if (schema.type === "null") {
    if (value !== null) configInvalid(`${path} must be null`)
    return
  }
  if (schema.type === "string" && typeof value !== "string") configInvalid(`${path} must be a string`)
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) configInvalid(`${path} must be a number`)
  if (schema.type === "boolean" && typeof value !== "boolean") configInvalid(`${path} must be a boolean`)
  if (schema.type === "array") {
    if (!Array.isArray(value)) configInvalid(`${path} must be an array`)
    const items = schema.items
    if (items !== undefined) value.forEach((item, index) => validateValue(items, item, `${path}[${index}]`, depth + 1))
    return
  }
  if (schema.type !== "object") return
  if (!isRecord(value)) configInvalid(`${path} must be an object`)
  const properties = schema.properties ?? {}
  for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) configInvalid(`${path}.${key} is required`)
  for (const [key, item] of Object.entries(value)) {
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (child === undefined) {
      if (schema.additionalProperties !== true) configInvalid(`${path}.${key} is not allowed`)
      continue
    }
    validateValue(child, item, `${path}.${key}`, depth + 1)
  }
}

function parseEnumList<T extends string>(value: unknown, max: number, allowed: readonly T[], name: string): readonly T[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${name} is invalid`)
  const result: T[] = []
  for (const item of value) {
    const match = allowed.find((candidate) => candidate === item)
    if (match === undefined || result.includes(match)) invalid(`${name} contains an invalid value`)
    result.push(match)
  }
  return Object.freeze(result.sort())
}

function parseStringList(value: unknown, max: number, itemMax: number, name: string, pattern: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${name} is invalid`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > itemMax || !pattern.test(item) || result.includes(item))
      invalid(`${name} contains an invalid value`)
    result.push(item)
  }
  return Object.freeze(result.sort())
}

function boundedString(value: unknown, min: number, max: number, name: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) invalid(`${name} is invalid`)
  return value
}

function invalid(reason: string): never {
  throw new PluginManifestError("PLUGIN_MANIFEST_INVALID", reason)
}

function schemaInvalid(reason: string): never {
  throw new PluginManifestError("PLUGIN_SCHEMA_INVALID", reason)
}

function configInvalid(reason: string): never {
  throw new PluginManifestError("PLUGIN_CONFIG_INVALID", reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
