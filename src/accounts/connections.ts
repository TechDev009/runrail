import { ProviderError } from "../providers/errors.ts"
import { RUNRAIL_USER_AGENT } from "../providers/http.ts"
import { PROVIDER_PRESETS, getCustomProviderPreset, getProviderPreset, type ProviderPresetProtocol } from "../providers/presets.ts"
import type { ProviderCredentialResolver, ProviderDiscoveryOptions } from "../providers/types.ts"
import { AccountError, validateAccountBaseUrl, type AccountRecord, type AccountReference } from "./types.ts"

/** An account seen as a place to send model requests: which preset, which address, which header. */
export interface ResolvedConnection {
  readonly connectionId: string
  readonly presetId: string
  /** The preset's name, for example "OpenRouter". The person's own label stays on the account. */
  readonly name: string
  readonly protocol: ProviderPresetProtocol
  readonly endpoint: string
  /** `none`: the endpoint has no model list, so model ids are typed by hand. */
  readonly modelList: "list" | "none"
  /** True when the person supplied the address. */
  readonly custom: boolean
  /** Everything a provider adapter needs except the model. */
  readonly options: ProviderDiscoveryOptions
}

/**
 * Turns a stored account into provider options. The address comes from the preset table, never
 * from the caller: a named preset only accepts an address on its own host, and the request is
 * pinned to that one host.
 */
export function resolveConnection(record: AccountRecord, credentialResolver: ProviderCredentialResolver): ResolvedConnection {
  const reference = record.reference
  if (record.status === "revoked") throw new AccountError("ACCOUNT_REVOKED", "account is revoked")
  const presetId = connectionPresetId(reference)
  const preset = getProviderPreset(presetId)
  const custom = preset === undefined ? getCustomProviderPreset(presetId) : undefined
  if (preset === undefined && custom === undefined) throw new ProviderError("PROVIDER_INVALID", "connection preset is unknown")
  const address = reference.baseUrl === undefined ? undefined : checkedAddress(reference.baseUrl)
  let endpoint: URL
  if (preset !== undefined) {
    const fixed = new URL(preset.baseUrl)
    if (address !== undefined && (address.protocol !== "https:" || address.host !== fixed.host)) throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "connection address does not belong to this provider")
    endpoint = address ?? fixed
  } else {
    if (address === undefined) throw new ProviderError("PROVIDER_INVALID", "connection address is required")
    endpoint = address
  }
  requireOwnShellKey(reference, presetId)
  // A plan address takes what its sign-in stored; a pasted key belongs on the vendor's key row.
  if (preset?.signInOnly === true && reference.authMode !== "oauth" && reference.authMode !== "device") throw new ProviderError("PROVIDER_INVALID", "this provider is reached through its sign-in")
  const row = (preset ?? custom)!
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(reference.headers ?? {})) if (name.toLowerCase() !== "user-agent" && name.toLowerCase() !== "originator") headers[name] = value
  headers["user-agent"] = RUNRAIL_USER_AGENT
  const text = reference.baseUrl ?? preset!.baseUrl
  return Object.freeze({
    connectionId: reference.accountId,
    presetId,
    name: row.name,
    protocol: row.protocol,
    endpoint: text,
    modelList: preset?.models ?? "list",
    custom: preset === undefined,
    options: Object.freeze({
      provider: presetId,
      displayName: row.name,
      endpoint: text,
      protocol: row.protocol === "openai-responses" ? "responses" as const : row.protocol === "openai-chat" ? "chat" as const : "messages" as const,
      authStyle: row.authStyle,
      quirks: row.quirks,
      allowRemote: true,
      // Plain http only ever passes the address check for this machine and the local network.
      ...(endpoint.protocol === "http:" ? { allowInsecureRemote: true } : {}),
      allowedHosts: Object.freeze([endpoint.hostname]),
      headers: Object.freeze(headers),
      credential: Object.freeze({ kind: "caller" as const, account: reference.accountId }),
      credentialResolver,
    }),
  })
}

/** The preset an account connects through. Accounts written before presets existed name a family. */
export function connectionPresetId(reference: AccountReference): string {
  const id = reference.preset ?? reference.provider
  return id === "openai-compatible" ? "custom-openai-chat" : id
}

/**
 * Where an account's credential goes: preset plus host. Two references with the same destination
 * may share a stored credential; a change of destination must not inherit one.
 */
export function connectionDestination(reference: AccountReference): string {
  const presetId = connectionPresetId(reference)
  const address = reference.baseUrl ?? getProviderPreset(presetId)?.baseUrl
  let host = ""
  if (address !== undefined) try { host = new URL(address).host } catch { host = "invalid" }
  return `${presetId} ${host}`
}

/** Presets whose conventional shell variable is set. Names only; the values are never read out. */
export function detectShellConnections(environment: Readonly<Record<string, string | undefined>> = process.env): readonly { readonly presetId: string; readonly name: string; readonly environmentName: string }[] {
  return Object.freeze(PROVIDER_PRESETS.flatMap((preset) => {
    const value = preset.environment === undefined ? undefined : environment[preset.environment]
    return preset.environment === undefined || typeof value !== "string" || value.length === 0 ? [] : [Object.freeze({ presetId: preset.id, name: preset.name, environmentName: preset.environment })]
  }))
}

function checkedAddress(value: string): URL {
  try {
    return new URL(validateAccountBaseUrl(value))
  } catch {
    throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "connection address is not allowed")
  }
}

/**
 * A shell variable that a preset conventionally owns (say `OPENAI_API_KEY`) is only sent to that
 * preset. Pointing it at a custom address would hand one vendor's key to another host.
 */
function requireOwnShellKey(reference: AccountReference, presetId: string): void {
  if (reference.authMode !== "environment" && reference.authMode !== "api-key-reference") return
  const name = reference.environmentName
  if (name === undefined) return
  const owners = PROVIDER_PRESETS.filter((preset) => preset.environment === name)
  if (owners.length > 0 && !owners.some((preset) => preset.id === presetId)) throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "this shell key belongs to another provider")
}
