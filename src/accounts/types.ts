import { isModelKeyVariable } from "../providers/presets.ts"
import type { ProviderCredentialReference, ProviderCredentialResolver } from "../providers/types.ts"
import { NativeContractError, boundedNativeCapability, boundedNativeId, boundedNativeList, boundedNativeOptionalText, boundedNativeText, nativeInvalid, requireNativeBoolean, requireNativeTimestamp } from "../native/errors.ts"

/**
 * How an account proves itself.
 * - `environment`, `api-key-reference`: the key is read from a named environment variable.
 * - `api-key`: the key is held in the credential vault.
 * - `oauth`, `device`: sign-in tokens are held in the credential vault and refreshed there.
 */
export type AccountAuthMode = "environment" | "api-key" | "api-key-reference" | "oauth" | "device" | "service-account" | "caller"
export type AccountStatus = "unconfigured" | "ready" | "expired" | "refreshing" | "error" | "revoked"

export interface AccountReference {
  readonly accountId: string
  readonly provider: string
  readonly label: string
  readonly authMode: AccountAuthMode
  readonly scopes: readonly string[]
  readonly environmentName?: string
  /** The entry of the provider preset table this account was created from. */
  readonly preset?: string
  /** Endpoint override for a self-hosted or custom endpoint. Never carries credentials. */
  readonly baseUrl?: string
  /** Extra non-secret request headers the endpoint needs. Credential headers are refused. */
  readonly headers?: Readonly<Record<string, string>>
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AccountRecord {
  readonly reference: AccountReference
  readonly status: AccountStatus
  readonly statusCode?: string
  readonly expiresAt?: number
  readonly lastCheckedAt?: number
}

export interface CredentialLease {
  readonly accountId: string
  readonly provider: string
  readonly expiresAt?: number
  readonly secret: string
  release?(): void | PromiseLike<void>
}

export interface CredentialBroker {
  resolve(reference: AccountReference, signal?: AbortSignal): Promise<CredentialLease>
  revoke?(reference: AccountReference): Promise<void>
}

export interface AccountStore {
  get(accountId: string): Promise<AccountRecord | undefined> | AccountRecord | undefined
  list(provider?: string): Promise<readonly AccountRecord[]> | readonly AccountRecord[]
  put(record: AccountRecord): Promise<void> | void
  remove(accountId: string): Promise<void> | void
}

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode, reason: string) {
    super(`${code}: ${reason.slice(0, 512).replace(/[\r\n\0]/g, " ")}`)
    this.name = "AccountError"
  }
}

export type AccountErrorCode =
  | "ACCOUNT_INVALID"
  | "ACCOUNT_LIMIT"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_REVOKED"
  | "ACCOUNT_CREDENTIALS_UNAVAILABLE"
  | "ACCOUNT_AUTH_FAILED"
  | "ACCOUNT_SCOPE_DENIED"
  | "ACCOUNT_EXPIRED"
  | "ACCOUNT_CANCELLED"

export class InMemoryAccountStore implements AccountStore {
  private readonly records = new Map<string, AccountRecord>()
  private readonly maxAccounts: number

  constructor(options: { readonly maxAccounts?: number } = {}) {
    const maxAccounts = options.maxAccounts ?? 256
    if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 4_096) throw new AccountError("ACCOUNT_LIMIT", "account limit is invalid")
    this.maxAccounts = maxAccounts
  }

  get(accountId: string): AccountRecord | undefined {
    return this.records.get(boundedNativeId(accountId, "account id", 256))
  }

  list(provider?: string): readonly AccountRecord[] {
    const selected = provider === undefined ? undefined : boundedNativeId(provider, "provider", 128)
    return Object.freeze([...this.records.values()].filter((record) => selected === undefined || record.reference.provider === selected).sort((left, right) => left.reference.accountId.localeCompare(right.reference.accountId)))
  }

  put(record: AccountRecord): void {
    const parsed = parseAccountRecord(record)
    const id = parsed.reference.accountId
    if (!this.records.has(id) && this.records.size >= this.maxAccounts) throw new AccountError("ACCOUNT_LIMIT", "account store is full")
    this.records.set(id, parsed)
  }

  remove(accountId: string): void {
    this.records.delete(boundedNativeId(accountId, "account id", 256))
  }
}

export class EnvironmentCredentialBroker implements CredentialBroker {
  private readonly allowed: ReadonlySet<string>
  private readonly environment: NodeJS.ProcessEnv

  constructor(options: { readonly allowedEnvironmentNames?: readonly string[]; readonly environment?: NodeJS.ProcessEnv } = {}) {
    this.allowed = new Set((options.allowedEnvironmentNames ?? []).map((name) => validateEnvironmentName(name)))
    this.environment = options.environment ?? process.env
  }

  async resolve(reference: AccountReference, signal?: AbortSignal): Promise<CredentialLease> {
    if (signal?.aborted === true) throw new AccountError("ACCOUNT_CANCELLED", "credential resolution was cancelled")
    if (reference.authMode !== "environment" && reference.authMode !== "api-key-reference") throw new AccountError("ACCOUNT_CREDENTIALS_UNAVAILABLE", "environment broker cannot resolve this auth mode")
    const name = reference.environmentName
    if (name === undefined || (this.allowed.size > 0 && !this.allowed.has(name))) throw new AccountError("ACCOUNT_SCOPE_DENIED", "credential environment is not allowed")
    const secret = this.environment[name]
    if (typeof secret !== "string" || secret.length === 0) throw new AccountError("ACCOUNT_CREDENTIALS_UNAVAILABLE", "credential environment is unavailable")
    return Object.freeze({ accountId: reference.accountId, provider: reference.provider, secret })
  }
}

export class InMemoryCredentialBroker implements CredentialBroker {
  private readonly values = new Map<string, string>()

  set(accountId: string, secret: string): void {
    const id = boundedNativeId(accountId, "account id", 256)
    if (typeof secret !== "string" || secret.length === 0 || secret.length > 64 * 1024 || secret.includes("\0")) throw new AccountError("ACCOUNT_INVALID", "credential secret is invalid")
    this.values.set(id, secret)
  }

  async resolve(reference: AccountReference, signal?: AbortSignal): Promise<CredentialLease> {
    if (signal?.aborted === true) throw new AccountError("ACCOUNT_CANCELLED", "credential resolution was cancelled")
    const secret = this.values.get(reference.accountId)
    if (secret === undefined) throw new AccountError("ACCOUNT_CREDENTIALS_UNAVAILABLE", "credential is unavailable")
    return Object.freeze({ accountId: reference.accountId, provider: reference.provider, secret })
  }

  async revoke(reference: AccountReference): Promise<void> {
    this.values.delete(reference.accountId)
  }
}
export function createAccountCredentialResolver(store: AccountStore, broker: CredentialBroker): ProviderCredentialResolver {
  return {
    resolve: async (reference: ProviderCredentialReference): Promise<string> => {
      if (reference.kind !== "caller") throw new AccountError("ACCOUNT_INVALID", "provider must use an account reference")
      const record = await store.get(reference.account)
      if (record === undefined) throw new AccountError("ACCOUNT_NOT_FOUND", "account is unavailable")
      if (record.status === "revoked") throw new AccountError("ACCOUNT_REVOKED", "account is revoked")
      if (record.status === "expired" || (record.expiresAt !== undefined && record.expiresAt <= Date.now())) throw new AccountError("ACCOUNT_EXPIRED", "account is expired")
      const lease = await broker.resolve(record.reference)
      try {
        return lease.secret
      } finally {
        await lease.release?.()
      }
    },
  }
}


/**
 * Ids the vault keeps for Runrail's own keys (a connector's key is `connector:<kind>`). Accounts and
 * tool connections share the vault with them, so they may never take one.
 */
export function isReservedCredentialId(id: string): boolean {
  return id.toLowerCase().startsWith("connector:")
}

export function parseAccountReference(value: unknown): AccountReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AccountError("ACCOUNT_INVALID", "account reference is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["accountId", "provider", "label", "authMode", "scopes", "environmentName", "preset", "baseUrl", "headers", "createdAt", "updatedAt"])
  const accountId = boundedNativeId(record.accountId, "account id", 256)
  if (isReservedCredentialId(accountId)) throw new AccountError("ACCOUNT_INVALID", "account id is reserved")
  const provider = boundedNativeId(record.provider, "provider", 128)
  const label = boundedNativeText(record.label, "account label", 160)
  if (!isAuthMode(record.authMode)) throw new AccountError("ACCOUNT_INVALID", "account auth mode is invalid")
  const scopes = boundedNativeList(record.scopes, "account scopes", 64, (entry, index) => boundedNativeCapability(entry, `account scope ${index}`))
  const environmentName = record.environmentName === undefined ? undefined : validateEnvironmentName(record.environmentName)
  const preset = record.preset === undefined ? undefined : boundedNativeId(record.preset, "account preset", 128)
  const baseUrl = record.baseUrl === undefined ? undefined : validateAccountBaseUrl(record.baseUrl)
  const headers = record.headers === undefined ? undefined : validateAccountHeaders(record.headers)
  const createdAt = requireNativeTimestamp(record.createdAt, "account createdAt")
  const updatedAt = requireNativeTimestamp(record.updatedAt, "account updatedAt")
  if (updatedAt < createdAt) throw new AccountError("ACCOUNT_INVALID", "account timestamps are invalid")
  return Object.freeze({
    accountId,
    provider,
    label,
    authMode: record.authMode,
    scopes,
    ...(environmentName === undefined ? {} : { environmentName }),
    ...(preset === undefined ? {} : { preset }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    createdAt,
    updatedAt,
  })
}

export function parseAccountRecord(value: unknown): AccountRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AccountError("ACCOUNT_INVALID", "account record is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["reference", "status", "statusCode", "expiresAt", "lastCheckedAt"])
  const reference = parseAccountReference(record.reference)
  if (!isAccountStatus(record.status)) throw new AccountError("ACCOUNT_INVALID", "account status is invalid")
  const statusCode = boundedNativeOptionalText(record.statusCode, "account status code", 128)
  const expiresAt = record.expiresAt === undefined ? undefined : requireNativeTimestamp(record.expiresAt, "account expiry")
  const lastCheckedAt = record.lastCheckedAt === undefined ? undefined : requireNativeTimestamp(record.lastCheckedAt, "account last checked")
  return Object.freeze({ reference, status: record.status, ...(statusCode === undefined ? {} : { statusCode }), ...(expiresAt === undefined ? {} : { expiresAt }), ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }) })
}

export function redactAccount(record: AccountRecord): AccountRecord {
  return Object.freeze({
    reference: record.reference,
    status: record.status,
    ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.lastCheckedAt === undefined ? {} : { lastCheckedAt: record.lastCheckedAt }),
  })
}

function validateEnvironmentName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) || !isModelKeyVariable(value)) throw new AccountError("ACCOUNT_INVALID", "environment name must name a model key variable")
  return value
}

/** An absolute http(s) endpoint with no embedded credentials and no fragment. */
export function validateAccountBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || /[\0-\x20\x7f]/.test(value)) throw new AccountError("ACCOUNT_INVALID", "account base URL is invalid")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AccountError("ACCOUNT_INVALID", "account base URL is invalid")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AccountError("ACCOUNT_INVALID", "account base URL must use http or https")
  if (url.username !== "" || url.password !== "") throw new AccountError("ACCOUNT_INVALID", "account base URL must not carry credentials")
  if (url.hash !== "" || url.hostname === "") throw new AccountError("ACCOUNT_INVALID", "account base URL is invalid")
  // The account's key is sent to this address. Without TLS anyone on the path can read it, so plain
  // http is limited to this machine and the local network (a model server on the LAN or a tailnet).
  if (url.protocol === "http:" && !isLocalNetworkHost(url.hostname)) throw new AccountError("ACCOUNT_INVALID", "account base URL must use https outside the local network")
  return value
}

/** `hostname` as the URL parser reports it: lower case, IPv4 in dotted form, IPv6 in brackets. */
function isLocalNetworkHost(hostname: string): boolean {
  if (hostname.startsWith("[")) {
    const address = hostname.slice(1, -1)
    // Loopback, unique local (fc00::/7), link local (fe80::/10).
    return address === "::1" || /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (octets !== null) {
    const first = Number(octets[1])
    const second = Number(octets[2])
    // Loopback, RFC 1918, and the carrier-grade range tailnets use. Link-local 169.254/16 is left out:
    // it holds cloud metadata services, not model servers.
    return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127)
  }
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || !hostname.includes(".")
}

const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key", "x-goog-api-key", "x-auth-token", "host", "content-length", "transfer-encoding", "connection"])

function validateAccountHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AccountError("ACCOUNT_INVALID", "account headers are invalid")
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 32) throw new AccountError("ACCOUNT_LIMIT", "account has too many headers")
  const headers: Record<string, string> = {}
  for (const [name, text] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) throw new AccountError("ACCOUNT_INVALID", "account header name is invalid")
    const lower = name.toLowerCase()
    // A credential belongs in the vault, where it is never listed, logged or sent to a client.
    if (CREDENTIAL_HEADER_NAMES.has(lower) || /token|secret|key|auth/.test(lower)) throw new AccountError("ACCOUNT_INVALID", "account headers must not carry credentials")
    // Runrail names itself on every request; an account cannot make it answer to another product's name.
    if (lower === "user-agent" || lower === "originator") throw new AccountError("ACCOUNT_INVALID", "account headers must not set the client identity")
    if (Object.hasOwn(headers, lower)) throw new AccountError("ACCOUNT_INVALID", "account header is repeated")
    headers[lower] = boundedNativeText(text, "account header value", 1_024)
  }
  return Object.freeze(headers)
}

function isAuthMode(value: unknown): value is AccountAuthMode {
  return value === "environment" || value === "api-key" || value === "api-key-reference" || value === "oauth" || value === "device" || value === "service-account" || value === "caller"
}

function isAccountStatus(value: unknown): value is AccountStatus {
  return value === "unconfigured" || value === "ready" || value === "expired" || value === "refreshing" || value === "error" || value === "revoked"
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new AccountError("ACCOUNT_INVALID", "account record contains unknown fields")
}
