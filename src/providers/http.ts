import { isIP } from "node:net"
import { RUNRAIL_VERSION } from "../version.ts"
import { ProviderError, withRejection } from "./errors.ts"
import type { ProviderEndpointPolicy, ProviderLimits } from "./types.ts"

export interface ProviderHttpRequest {
  readonly path: string
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  readonly signal?: AbortSignal
  readonly retryable?: boolean
  readonly idempotencyKey?: string
}

export interface ProviderHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

export interface ProviderHttpStreamResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: AsyncIterable<Uint8Array>
}

export interface ProviderHttpClient {
  readonly endpoint: URL
  readonly limits: ProviderLimits
  request(input: ProviderHttpRequest): Promise<ProviderHttpResponse>
  stream(input: ProviderHttpRequest): Promise<ProviderHttpStreamResponse>
  json<T>(input: ProviderHttpRequest, parse: (value: unknown) => T): Promise<T>
}

/** Sent on every provider request that does not set its own. */
export const RUNRAIL_USER_AGENT = `runrail/${RUNRAIL_VERSION}`

export function normalizeProviderEndpoint(policy: ProviderEndpointPolicy): { readonly endpoint: URL; readonly limits: ProviderLimits } {
  if (policy === null || typeof policy !== "object" || typeof policy.baseUrl !== "string" || policy.baseUrl.length === 0 || policy.baseUrl.length > 2_048)
    throw new ProviderError("PROVIDER_INVALID", "provider endpoint policy is invalid")
  let endpoint: URL
  try {
    endpoint = new URL(policy.baseUrl.endsWith("/") ? policy.baseUrl : `${policy.baseUrl}/`)
  } catch {
    throw new ProviderError("PROVIDER_INVALID", "provider endpoint URL is invalid")
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0)
    throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "provider endpoint contains forbidden URL credentials or fragments")
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "provider endpoint scheme is not allowed")
  const loopback = isLoopback(endpoint.hostname)
  if (!loopback && policy.allowRemote !== true) throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "remote provider endpoints require explicit opt-in")
  if (!loopback && endpoint.protocol !== "https:" && policy.allowInsecureRemote !== true)
    throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "remote provider endpoints require HTTPS")
  if (policy.allowInsecureRemote === true && policy.allowRemote !== true && !loopback)
    throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "insecure remote provider endpoints require explicit remote opt-in")
  if (policy.allowedHosts !== undefined) {
    if (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.length > 64 || policy.allowedHosts.some((host) => typeof host !== "string" || host.length === 0 || host.length > 256))
      throw new ProviderError("PROVIDER_INVALID", "provider host allowlist is invalid")
    if (!policy.allowedHosts.includes(endpoint.hostname)) throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "provider host is not allowlisted")
  }
  const limits: ProviderLimits = Object.freeze({
    timeoutMs: bound(policy.timeoutMs ?? 120_000, 1, 120_000, "timeout"),
    maxRequestBytes: bound(policy.maxRequestBytes ?? 4 * 1024 * 1024, 1, 16 * 1024 * 1024, "request"),
    maxResponseBytes: bound(policy.maxResponseBytes ?? 4 * 1024 * 1024, 1, 16 * 1024 * 1024, "response"),
    maxStreamBytes: bound(policy.maxStreamBytes ?? 16 * 1024 * 1024, 1, 64 * 1024 * 1024, "stream"),
    maxEvents: bound(policy.maxEvents ?? 8_192, 1, 65_536, "events"),
    maxRetries: bound(policy.maxRetries ?? 2, 0, 5, "retries"),
    retryDelayMs: bound(policy.retryDelayMs ?? 100, 0, 10_000, "retry delay"),
  })
  return Object.freeze({ endpoint, limits })
}

export function createProviderHttpClient(policy: ProviderEndpointPolicy): ProviderHttpClient {
  const normalized = normalizeProviderEndpoint(policy)
  return new BoundedProviderHttpClient(normalized.endpoint, normalized.limits)
}

class BoundedProviderHttpClient implements ProviderHttpClient {
  constructor(readonly endpoint: URL, readonly limits: ProviderLimits) {}

  async request(input: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const response = await this.fetchWithRetry(input, false)
    const body = await readBytes(response, this.limits.maxResponseBytes, input.signal, this.limits.timeoutMs)
    return Object.freeze({ status: response.status, headers: headersSnapshot(response.headers), body })
  }

  async stream(input: ProviderHttpRequest): Promise<ProviderHttpStreamResponse> {
    const response = await this.fetchWithRetry(input, true)
    if (response.body === null) throw new ProviderError("PROVIDER_STREAM_FAILED", "provider response has no stream body")
    const body = boundedStream(response.body, this.limits.maxStreamBytes, input.signal, this.limits.timeoutMs)
    return Object.freeze({ status: response.status, headers: headersSnapshot(response.headers), body })
  }

  async json<T>(input: ProviderHttpRequest, parse: (value: unknown) => T): Promise<T> {
    const response = await this.request(input)
    ensureSuccess(response.status, response.headers)
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(response.body)) as unknown
    } catch {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider response is not valid JSON")
    }
    try {
      return parse(value)
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider response shape is invalid")
    }
  }

  private async fetchWithRetry(input: ProviderHttpRequest, streaming: boolean): Promise<Response> {
    validateRequest(input, this.limits.maxRequestBytes)
    const url = resolvePath(this.endpoint, input.path)
    const body = input.body === undefined ? undefined : typeof input.body === "string" ? input.body : new Uint8Array(input.body)
    const bodyBytes = body === undefined ? 0 : typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength
    if (bodyBytes > this.limits.maxRequestBytes) throw new ProviderError("PROVIDER_INVALID", "provider request exceeds its byte limit")
    // Requests say who is asking. A caller may name its own product; nothing here borrows another one's.
    const named = Object.keys(input.headers ?? {}).some((name) => name.toLowerCase() === "user-agent")
    const headers = { ...(named ? {} : { "user-agent": RUNRAIL_USER_AGENT }), ...(input.headers ?? {}), ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey }) }
    const retryable = input.retryable === true && !streaming
    const cancelled = (): boolean => input.signal?.aborted === true
    let attempt = 0
    for (;;) {
      // An abort event is not replayed to a late listener, so a cancel that came first is checked here,
      // before the request carrying the key is sent.
      if (cancelled()) throw new ProviderError("PROVIDER_CANCELLED", "provider request was cancelled")
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort("provider timeout"), this.limits.timeoutMs)
      const abort = (): void => controller.abort(input.signal?.reason)
      input.signal?.addEventListener("abort", abort, { once: true })
      try {
        // A redirect would carry the key to an address the endpoint policy never checked.
        const response = await fetch(url, { method: input.method ?? "POST", headers, body, signal: controller.signal, redirect: "manual" })
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined)
          throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "provider endpoint answered with a redirect", { status: response.status })
        }
        if (retryable && isRetryStatus(response.status) && attempt < this.limits.maxRetries) {
          await response.body?.cancel().catch(() => undefined)
          attempt += 1
          await wait(this.limits.retryDelayMs * attempt, input.signal)
          continue
        }
        if (!response.ok) {
          const error = statusError(response.status)
          if (response.status === 400 || response.status === 422) throw withRejection(error, await errorText(response))
          await response.body?.cancel().catch(() => undefined)
          throw error
        }
        return response
      } catch (error) {
        if (error instanceof ProviderError) throw error
        if (cancelled()) throw new ProviderError("PROVIDER_CANCELLED", "provider request was cancelled")
        if (controller.signal.aborted) {
          if (attempt < this.limits.maxRetries && retryable) {
            attempt += 1
            await wait(this.limits.retryDelayMs * attempt, input.signal)
            continue
          }
          throw new ProviderError("PROVIDER_TIMEOUT", "provider request timed out")
        }
        if (attempt < this.limits.maxRetries && retryable) {
          attempt += 1
          await wait(this.limits.retryDelayMs * attempt, input.signal)
          continue
        }
        throw new ProviderError("PROVIDER_FAILED", "provider request failed")
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", abort)
      }
    }
  }
}

function resolvePath(endpoint: URL, path: string): URL {
  if (typeof path !== "string" || path.length === 0 || path.length > 2_048 || path.includes("\\") || /[\r\n]/.test(path))
    throw new ProviderError("PROVIDER_INVALID", "provider request path is invalid")
  try {
    // Provider paths are endpoint-relative even when callers spell them with a
    // leading slash. `new URL('/models', endpoint)` would silently discard a
    // configured `/v1/` prefix and route requests outside the provider base.
    const prefix = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`
    const relativePath = path.startsWith("/") ? path.slice(1) : path
    const url = new URL(relativePath, endpoint)
    if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0 || url.origin !== endpoint.origin || !url.pathname.startsWith(prefix))
      throw new ProviderError("PROVIDER_ENDPOINT_DENIED", "provider request URL is not allowed")
    return url
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError("PROVIDER_INVALID", "provider request URL is invalid")
  }
}

function validateRequest(input: ProviderHttpRequest, maxRequestBytes: number): void {
  if (input === null || typeof input !== "object") throw new ProviderError("PROVIDER_INVALID", "provider request is invalid")
  if (input.headers !== undefined) {
    if (input.headers === null || typeof input.headers !== "object" || Array.isArray(input.headers) || Object.keys(input.headers).length > 64)
      throw new ProviderError("PROVIDER_INVALID", "provider request headers are invalid")
    for (const [name, value] of Object.entries(input.headers)) {
      if (!/^[A-Za-z0-9-]{1,128}$/.test(name) || typeof value !== "string" || value.length > 16 * 1024 || /[\r\n]/.test(value))
        throw new ProviderError("PROVIDER_INVALID", "provider request header is invalid")
    }
  }
  if (input.body !== undefined && typeof input.body !== "string" && !(input.body instanceof Uint8Array)) throw new ProviderError("PROVIDER_INVALID", "provider request body is invalid")
  if (input.body !== undefined && (typeof input.body === "string" ? Buffer.byteLength(input.body, "utf8") : input.body.byteLength) > maxRequestBytes)
    throw new ProviderError("PROVIDER_INVALID", "provider request exceeds its byte limit")
}

async function readBytes(response: Response, maxBytes: number, signal: AbortSignal | undefined, timeoutMs: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await readChunk(reader, signal, timeoutMs)
      if (next.done) break
      const chunk = next.value
      total += chunk.byteLength
      if (total > maxBytes) {
        await reader.cancel("provider response limit")
        throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider response exceeds its byte limit")
      }
      chunks.push(chunk)
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

async function* boundedStream(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal | undefined, timeoutMs: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  let total = 0
  let ended = false
  try {
    for (;;) {
      const next = await readChunk(reader, signal, timeoutMs)
      if (next.done) {
        ended = true
        return
      }
      total += next.value.byteLength
      if (total > maxBytes) throw new ProviderError("PROVIDER_STREAM_FAILED", "provider stream exceeds its byte limit")
      yield next.value
    }
  } finally {
    // A consumer that stopped early, a parse failure or a limit: the rest of the body is not downloaded.
    if (!ended) await reader.cancel("provider stream closed").catch(() => undefined)
    reader.releaseLock()
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted === true) {
    await reader.cancel(signal.reason)
    throw new ProviderError("PROVIDER_CANCELLED", "provider response was cancelled")
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const abort = (): void => {
      void reader.cancel(signal?.reason)
      finish(() => reject(new ProviderError("PROVIDER_CANCELLED", "provider response was cancelled")))
    }
    const timer = setTimeout(() => {
      void reader.cancel("provider timeout")
      finish(() => reject(new ProviderError("PROVIDER_TIMEOUT", "provider response timed out")))
    }, timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    reader.read().then(
      (value) => finish(() => resolve(value as ReadableStreamReadResult<Uint8Array>)),
      (error) => finish(() => reject(error)),
    )
  })
}

function ensureSuccess(status: number, headers: Readonly<Record<string, string>>): void {
  if (status >= 200 && status < 300) return
  void headers
  throw statusError(status)
}

/** At most 2 KiB of a refusal's body; the rest is never read. */
async function errorText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ""
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (bytes < 2_048) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      bytes += value.byteLength
    }
  } catch {
    return ""
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, 2_048))
}

function statusError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("PROVIDER_AUTH_FAILED", "provider authentication failed", { status })
  if (status === 408 || status === 504) return new ProviderError("PROVIDER_TIMEOUT", "provider request timed out", { status, retryable: true })
  if (status === 429) return new ProviderError("PROVIDER_RATE_LIMITED", "provider usage limit reached", { status })
  return new ProviderError("PROVIDER_FAILED", "provider request failed", { status, retryable: status >= 500 })
}

function isRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504
}

async function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new ProviderError("PROVIDER_CANCELLED", "provider request was cancelled")
  if (delayMs === 0) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      signal?.removeEventListener("abort", abort)
      resolve()
    }, delayMs)
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(new ProviderError("PROVIDER_CANCELLED", "provider request was cancelled"))
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function headersSnapshot(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    if (["authorization", "proxy-authenticate", "proxy-authorization", "set-cookie", "cookie", "x-api-key"].includes(name.toLowerCase())) continue
    result[name] = value.slice(0, 4_096)
  }
  return Object.freeze(result)
}

function bound(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ProviderError("PROVIDER_INVALID", `provider ${name} limit is invalid`)
  return value
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || (isIP(normalized) === 4 && normalized.startsWith("127."))
}
