import { isIP } from "node:net"
import { fetchCheckingRedirects, RedirectRefusedError, sameOrigin } from "../net/redirect.ts"
import { ConnectorError, type ConnectorAction, type ConnectorDefinition, type ConnectorDescriptor } from "./registry.ts"

export type ConnectorCredentialReference =
  | {
      readonly kind: "environment"
      readonly environment: string
      readonly account?: string
    }
  | {
      readonly kind: "caller"
      readonly account: string
    }

export interface ConnectorCredentialResolver {
  /** Resolves a secret transiently. The returned value must never be serialized or persisted. */
  resolve(reference: ConnectorCredentialReference): string | PromiseLike<string>
}

export type ConnectorAuthScheme = "bearer" | "token" | "basic" | "header"
export type ConnectorHttpMethod = "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT"

export interface ConnectorHttpCredential {
  readonly reference: ConnectorCredentialReference
  readonly resolver: ConnectorCredentialResolver
  readonly scheme?: ConnectorAuthScheme
  readonly username?: string
  readonly headerName?: string
}

export interface ConnectorHttpAction {
  readonly name: string
  readonly description: string
  readonly kind: ConnectorAction["kind"]
  readonly capabilities: readonly string[]
  readonly requiresApproval?: boolean
  readonly method?: ConnectorHttpMethod
  readonly path: string | ((input: unknown) => string)
  readonly query?: (input: unknown) => Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: (input: unknown) => unknown
  readonly response?: "json" | "text"
  /** Retries are permitted only for GET/HEAD requests and transient transport statuses. */
  readonly retryable?: boolean
  readonly parse?: (value: unknown) => unknown
}

export interface ConnectorHttpOptions {
  readonly descriptor: ConnectorDescriptor
  readonly endpoint: string
  readonly credential?: ConnectorHttpCredential
  /** Authentication headers cannot be supplied here; they are generated from the resolver. */
  readonly headers?: Readonly<Record<string, string>>
  readonly actions: readonly ConnectorHttpAction[]
  readonly allowRemote?: boolean
  readonly allowInsecureRemote?: boolean
  readonly allowedHosts?: readonly string[]
  readonly timeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxRetries?: number
  readonly retryDelayMs?: number
}

export interface ConnectorHttpResolverOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/** Create a transient environment-backed connector credential resolver. */
export function createEnvironmentConnectorCredentialResolver(options: ConnectorHttpResolverOptions = {}): ConnectorCredentialResolver {
  const environment = options.environment ?? process.env
  return {
    resolve: (reference) => {
      if (reference.kind !== "environment") throw new ConnectorError("CONNECTOR_CREDENTIALS", "environment credential reference is required")
      validateEnvironmentName(reference.environment)
      const value = environment[reference.environment]
      if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024)
        throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector credential is unavailable")
      return value
    },
  }
}

/** Create a caller-owned resolver without placing its secret in connector configuration. */
export function createCallerConnectorCredentialResolver(resolve: (account: string) => string | PromiseLike<string>): ConnectorCredentialResolver {
  if (typeof resolve !== "function") throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector credential resolver is invalid")
  return {
    resolve: async (reference) => {
      if (reference.kind !== "caller") throw new ConnectorError("CONNECTOR_CREDENTIALS", "caller credential reference is required")
      if (!validAccount(reference.account)) throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector account reference is invalid")
      let secret: unknown
      try {
        secret = await resolve(reference.account)
      } catch {
        throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector credential is unavailable")
      }
      if (typeof secret !== "string" || secret.length === 0 || secret.length > 16 * 1024)
        throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector credential is invalid")
      return secret
    },
  }
}

/** Build a caller-owned REST connector with bounded transport and explicit auth policy. */
export function createHttpConnector(options: ConnectorHttpOptions): ConnectorDefinition {
  const normalized = normalizeOptions(options)
  const actions: ConnectorAction[] = normalized.actions.map((action) => ({
    name: action.name,
    description: action.description,
    kind: action.kind,
    capabilities: Object.freeze([...action.capabilities]),
    ...((action.requiresApproval === true || action.kind === "write" || action.kind === "notify") ? { requiresApproval: true } : {}),
    execute: (input: unknown, context: { readonly cwd: string; readonly signal: AbortSignal }) => executeAction(normalized, action, input, context.signal),
  }))
  return Object.freeze({ descriptor: normalized.descriptor, actions: Object.freeze(actions) })
}

interface NormalizedHttpOptions extends Omit<ConnectorHttpOptions, "endpoint" | "headers" | "actions" | "timeoutMs" | "maxRequestBytes" | "maxResponseBytes" | "maxRetries" | "retryDelayMs"> {
  readonly endpoint: URL
  readonly headers: Readonly<Record<string, string>>
  readonly actions: readonly ConnectorHttpAction[]
  readonly timeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxRetries: number
  readonly retryDelayMs: number
}

async function executeAction(options: NormalizedHttpOptions, action: ConnectorHttpAction, input: unknown, signal: AbortSignal): Promise<unknown> {
  if (!(signal instanceof AbortSignal)) throw new ConnectorError("CONNECTOR_INVALID", "connector signal is invalid")
  if (signal.aborted) throw new ConnectorError("CONNECTOR_CANCELLED", "connector request was cancelled")
  let path: string
  try {
    path = typeof action.path === "string" ? action.path : action.path(input)
  } catch (error) {
    if (error instanceof ConnectorError) throw error
    throw new ConnectorError("CONNECTOR_INVALID", "connector request path is invalid")
  }
  let query: Readonly<Record<string, string | number | boolean | undefined>> | undefined
  try {
    query = action.query?.(input)
  } catch (error) {
    if (error instanceof ConnectorError) throw error
    throw new ConnectorError("CONNECTOR_INVALID", "connector query is invalid")
  }
  const url = resolveUrl(options.endpoint, path, query)
  const method = action.method ?? "GET"
  let rawBody: unknown
  try {
    rawBody = action.body?.(input)
  } catch (error) {
    if (error instanceof ConnectorError) throw error
    throw new ConnectorError("CONNECTOR_INVALID", "connector request body is invalid")
  }
  if (rawBody !== undefined && (method === "GET" || method === "HEAD")) throw new ConnectorError("CONNECTOR_INVALID", "GET connector actions cannot have a body")
  let body: string | undefined
  if (rawBody !== undefined) {
    try {
      body = JSON.stringify(rawBody)
    } catch {
      throw new ConnectorError("CONNECTOR_INVALID", "connector request body is not serializable")
    }
    if (body === undefined || Buffer.byteLength(body, "utf8") > options.maxRequestBytes) throw new ConnectorError("CONNECTOR_LIMIT", "connector request exceeds its byte limit")
  }
  const auth = options.credential === undefined ? {} : { [authHeaderName(options.credential)]: await resolveAuth(options.credential) }
  const headers: Record<string, string> = { ...options.headers, accept: "application/json", ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) }
  const retryable = action.retryable === true && (method === "GET" || method === "HEAD")
  let attempt = 0
  for (;;) {
    if (signal.aborted) throw new ConnectorError("CONNECTOR_CANCELLED", "connector request was cancelled")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort("connector timeout"), options.timeoutMs)
    const requestSignal = AbortSignal.any([signal, controller.signal])
    try {
      let response: Response
      try {
        // A connector's API never sends its key on to another address.
        response = await fetchCheckingRedirects(url, { method, headers, ...(body === undefined ? {} : { body }), signal: requestSignal }, sameOrigin)
      } catch (error) {
        if (error instanceof RedirectRefusedError) throw new ConnectorError("CONNECTOR_FAILED", "the service redirected to another address")
        throw error
      }
      if (retryable && isRetryStatus(response.status) && attempt < options.maxRetries) {
        await response.body?.cancel()
        attempt += 1
        await wait(options.retryDelayMs * attempt, signal)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw statusError(response.status)
      }
      const bytes = await readResponse(response, options.maxResponseBytes, signal, controller.signal)
      let value: unknown
      if (bytes.byteLength === 0) value = null
      else if ((action.response ?? "json") === "text") value = new TextDecoder().decode(bytes)
      else {
        try {
          value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
        } catch {
          throw new ConnectorError("CONNECTOR_FAILED", "connector response is not valid JSON")
        }
      }
      if (action.parse === undefined) return value
      try {
        return action.parse(value)
      } catch (error) {
        if (error instanceof ConnectorError) throw error
        throw new ConnectorError("CONNECTOR_FAILED", "connector response mapping failed")
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error
      if (signal.aborted) throw new ConnectorError("CONNECTOR_CANCELLED", "connector request was cancelled")
      if (controller.signal.aborted) {
        if (retryable && attempt < options.maxRetries) {
          attempt += 1
          await wait(options.retryDelayMs * attempt, signal)
          continue
        }
        throw new ConnectorError("CONNECTOR_TIMEOUT", "connector request timed out")
      }
      if (retryable && attempt < options.maxRetries) {
        attempt += 1
        await wait(options.retryDelayMs * attempt, signal)
        continue
      }
      throw new ConnectorError("CONNECTOR_TRANSPORT", "connector request failed")
    } finally {
      clearTimeout(timer)
    }
  }
}

function normalizeOptions(options: ConnectorHttpOptions): NormalizedHttpOptions {
  if (options === null || typeof options !== "object" || !isRecord(options.descriptor) || typeof options.endpoint !== "string" || options.endpoint.length === 0 || options.endpoint.length > 2_048 || !Array.isArray(options.actions) || options.actions.length === 0 || options.actions.length > 256)
    throw new ConnectorError("CONNECTOR_INVALID", "HTTP connector options are invalid")
  const endpoint = normalizeEndpoint(options.endpoint, options.allowRemote === true, options.allowInsecureRemote === true, options.allowedHosts)
  const headers = validateHeaders(options.headers)
  if (options.credential !== undefined) validateCredential(options.credential)
  const actions = options.actions.map(validateAction)
  return Object.freeze({
    ...options,
    descriptor: Object.freeze({ ...options.descriptor, capabilities: Object.freeze([...options.descriptor.capabilities]) }),
    endpoint,
    headers,
    actions: Object.freeze(actions),
    timeoutMs: bounded(options.timeoutMs ?? 120_000, 1, 120_000, "timeoutMs"),
    maxRequestBytes: bounded(options.maxRequestBytes ?? 1 * 1024 * 1024, 1, 16 * 1024 * 1024, "maxRequestBytes"),
    maxResponseBytes: bounded(options.maxResponseBytes ?? 4 * 1024 * 1024, 1, 16 * 1024 * 1024, "maxResponseBytes"),
    maxRetries: bounded(options.maxRetries ?? 2, 0, 5, "maxRetries"),
    retryDelayMs: bounded(options.retryDelayMs ?? 100, 0, 10_000, "retryDelayMs"),
  })
}

function validateAction(action: ConnectorHttpAction): ConnectorHttpAction {
  if (action === null || typeof action !== "object" || !validName(action.name) || typeof action.description !== "string" || action.description.length === 0 || action.description.length > 64 * 1024 || !Array.isArray(action.capabilities) || action.capabilities.length === 0 || action.capabilities.some((value) => !validCapability(value)) || typeof action.path !== "string" && typeof action.path !== "function" || action.method !== undefined && !["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"].includes(action.method) || action.response !== undefined && action.response !== "json" && action.response !== "text" || action.retryable !== undefined && typeof action.retryable !== "boolean" || action.parse !== undefined && typeof action.parse !== "function")
    throw new ConnectorError("CONNECTOR_INVALID", "HTTP connector action is invalid")
  return Object.freeze({ ...action, capabilities: Object.freeze([...action.capabilities]) })
}

function validateCredential(credential: ConnectorHttpCredential): void {
  if (credential === null || typeof credential !== "object" || credential.reference === null || typeof credential.reference !== "object" || Array.isArray(credential.reference) || credential.resolver === null || typeof credential.resolver !== "object" || Array.isArray(credential.resolver) || typeof credential.resolver.resolve !== "function" || credential.scheme !== undefined && !["bearer", "token", "basic", "header"].includes(credential.scheme))
    throw new ConnectorError("CONNECTOR_CREDENTIALS", "HTTP connector credential is invalid")
  if (credential.reference.kind === "environment") validateEnvironmentName(credential.reference.environment)
  else if (credential.reference.kind !== "caller" || !validAccount(credential.reference.account)) throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector credential reference is invalid")
  if (credential.username !== undefined && (typeof credential.username !== "string" || credential.username.length === 0 || credential.username.length > 256 || /[\r\n]/.test(credential.username))) throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector username is invalid")
  if (credential.headerName !== undefined && (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(credential.headerName) || isForbiddenHeader(credential.headerName))) throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector authentication header is invalid")
  if (credential.scheme === "basic" && credential.username === undefined) throw new ConnectorError("CONNECTOR_CREDENTIALS", "basic connector authentication requires a username")
  if (credential.scheme === "header" && credential.headerName === undefined) throw new ConnectorError("CONNECTOR_CREDENTIALS", "header connector authentication requires a header name")
}

async function resolveAuth(credential: ConnectorHttpCredential): Promise<string> {
  let secret: unknown
  try {
    secret = await credential.resolver.resolve(credential.reference)
  } catch (error) {
    if (error instanceof ConnectorError) throw error
    throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector credential is unavailable")
  }
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 16 * 1024 || /[\r\n]/.test(secret)) throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector credential is invalid")
  const scheme = credential.scheme ?? "bearer"
  if (scheme === "basic") return `Basic ${Buffer.from(`${credential.username}:${secret}`, "utf8").toString("base64")}`
  if (scheme === "token") return `token ${secret}`
  if (scheme === "header") return secret
  return `Bearer ${secret}`
}

function authHeaderName(credential: ConnectorHttpCredential): string {
  return credential.scheme === "header" ? credential.headerName! : "authorization"
}

function normalizeEndpoint(input: string, allowRemote: boolean, allowInsecureRemote: boolean, allowedHosts: readonly string[] | undefined): URL {
  let endpoint: URL
  try {
    endpoint = new URL(input.endsWith("/") ? input : `${input}/`)
  } catch {
    throw new ConnectorError("CONNECTOR_INVALID", "connector endpoint URL is invalid")
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0 || endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new ConnectorError("CONNECTOR_INVALID", "connector endpoint is not allowed")
  const loopback = isLoopback(endpoint.hostname)
  if (!loopback && !allowRemote) throw new ConnectorError("CONNECTOR_INVALID", "remote connector endpoints require explicit opt-in")
  if (!loopback && endpoint.protocol !== "https:" && !allowInsecureRemote) throw new ConnectorError("CONNECTOR_INVALID", "remote connector endpoints require HTTPS")
  if (allowInsecureRemote && !allowRemote && !loopback) throw new ConnectorError("CONNECTOR_INVALID", "insecure remote connector endpoints require remote opt-in")
  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts) || allowedHosts.length > 64 || allowedHosts.some((host) => typeof host !== "string" || host.length === 0 || host.length > 256) || !allowedHosts.includes(endpoint.hostname)) throw new ConnectorError("CONNECTOR_INVALID", "connector endpoint host is not allowlisted")
  }
  return endpoint
}

function resolveUrl(endpoint: URL, path: string, query: Readonly<Record<string, string | number | boolean | undefined>> | undefined): URL {
  if (typeof path !== "string" || path.length === 0 || path.length > 2_048 || path.includes("\\") || /[\r\n]/.test(path)) throw new ConnectorError("CONNECTOR_INVALID", "connector request path is invalid")
  const prefix = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`
  let url: URL
  try {
    // Connector paths are relative to the configured endpoint prefix. A
    // leading slash must not turn `/v1/` into the origin root.
    const relativePath = path.startsWith("/") ? path.slice(1) : path
    url = new URL(relativePath, endpoint)
  } catch {
    throw new ConnectorError("CONNECTOR_INVALID", "connector request URL is invalid")
  }
  if (url.origin !== endpoint.origin || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0 || !url.pathname.startsWith(prefix)) throw new ConnectorError("CONNECTOR_INVALID", "connector request URL is not allowed")
  if (query !== undefined) {
    if (!isRecord(query) || Object.keys(query).length > 64) throw new ConnectorError("CONNECTOR_INVALID", "connector query is invalid")
    for (const [key, value] of Object.entries(query)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new ConnectorError("CONNECTOR_INVALID", "connector query key is invalid")
      if (value === undefined) continue
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new ConnectorError("CONNECTOR_INVALID", "connector query value is invalid")
      const text = String(value)
      if (text.length > 4_096 || /[\r\n]/.test(text)) throw new ConnectorError("CONNECTOR_INVALID", "connector query value is invalid")
      url.searchParams.set(key, text)
    }
  }
  return url
}

async function readResponse(response: Response, maxBytes: number, callerSignal: AbortSignal, timeoutSignal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (callerSignal.aborted) {
        await reader.cancel(callerSignal.reason)
        throw new ConnectorError("CONNECTOR_CANCELLED", "connector response was cancelled")
      }
      if (timeoutSignal.aborted) {
        await reader.cancel(timeoutSignal.reason)
        throw new ConnectorError("CONNECTOR_TIMEOUT", "connector response timed out")
      }
      const next = await readChunk(reader, callerSignal, timeoutSignal)
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel("connector response limit")
        throw new ConnectorError("CONNECTOR_LIMIT", "connector response exceeds its byte limit")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      callerSignal.removeEventListener("abort", onCallerAbort)
      timeoutSignal.removeEventListener("abort", onTimeout)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onCallerAbort = (): void => {
      void reader.cancel(callerSignal.reason)
      finish(() => reject(new ConnectorError("CONNECTOR_CANCELLED", "connector response was cancelled")))
    }
    const onTimeout = (): void => {
      void reader.cancel(timeoutSignal.reason)
      finish(() => reject(new ConnectorError("CONNECTOR_TIMEOUT", "connector response timed out")))
    }
    callerSignal.addEventListener("abort", onCallerAbort, { once: true })
    timeoutSignal.addEventListener("abort", onTimeout, { once: true })
    reader.read().then(
      (value) => finish(() => resolve(value as ReadableStreamReadResult<Uint8Array>)),
      (error) => finish(() => reject(error)),
    )
  })
}

function statusError(status: number): ConnectorError {
  if (status === 401 || status === 403) return new ConnectorError("CONNECTOR_AUTH_FAILED", "connector authentication failed")
  if (status === 408 || status === 504) return new ConnectorError("CONNECTOR_TIMEOUT", "connector request timed out")
  if (status === 429) return new ConnectorError("CONNECTOR_RATE_LIMITED", "connector rate limit exceeded")
  return new ConnectorError("CONNECTOR_FAILED", "connector request failed")
}

function isRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ConnectorError("CONNECTOR_CANCELLED", "connector request was cancelled")
  if (delayMs === 0) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      signal.removeEventListener("abort", abort)
      resolve()
    }, delayMs)
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new ConnectorError("CONNECTOR_CANCELLED", "connector request was cancelled"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function validateHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({})
  if (!isRecord(value) || Object.keys(value).length > 32) throw new ConnectorError("CONNECTOR_INVALID", "connector headers are invalid")
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(name) || typeof entry !== "string" || entry.length > 4_096 || /[\r\n]/.test(entry) || isForbiddenHeader(name)) throw new ConnectorError("CONNECTOR_INVALID", "connector header is invalid")
    result[name] = entry
  }
  return Object.freeze(result)
}

function isForbiddenHeader(name: string): boolean {
  return ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key"].includes(name.toLowerCase())
}

function validateEnvironmentName(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new ConnectorError("CONNECTOR_CREDENTIALS", "connector environment name is invalid")
}

function validAccount(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConnectorError("CONNECTOR_LIMIT", `connector ${name} is invalid`)
  return value
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || isIP(normalized) === 4 && normalized.startsWith("127.")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
