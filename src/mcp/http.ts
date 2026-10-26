import { McpTransportError } from "./transport.ts"
import type { McpTransport } from "./transport.ts"

export interface McpHttpTransportOptions {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxMessageBytes?: number
  /** Required for non-loopback endpoints; remote auth/network policy stays caller-owned. */
  readonly allowRemote?: boolean
  /** A bearer token read before each request, so a renewed sign-in is used without reconnecting. */
  readonly authorization?: (signal: AbortSignal) => Promise<string>
}

/** Streamable HTTP MCP transport with explicit remote opt-in and caller-owned headers. */
export class McpHttpTransport implements McpTransport {
  private readonly url: URL
  private readonly headers: Readonly<Record<string, string>>
  private readonly authorization: ((signal: AbortSignal) => Promise<string>) | undefined
  private bearer: string | undefined
  private readonly timeoutMs: number
  private readonly maxMessageBytes: number
  private queuedBytes = 0
  private readonly maxQueuedBytes: number
  private readonly active = new Set<AbortController>()
  private readonly queue: string[] = []
  private readonly waiters: Array<{ readonly resolve: (result: IteratorResult<string>) => void; readonly reject: (error: unknown) => void }> = []
  private closed = false
  private failure: unknown
  private sessionId: string | undefined
  private protocolVersion: string | undefined

  constructor(options: McpHttpTransportOptions) {
    validateOptions(options)
    this.url = new URL(options.url)
    this.headers = Object.freeze({ "content-type": "application/json", accept: "application/json, text/event-stream", ...(options.headers ?? {}) })
    this.authorization = options.authorization
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxMessageBytes = options.maxMessageBytes ?? 1_048_576
    this.maxQueuedBytes = Math.min(this.maxMessageBytes * 4, 16 * 1024 * 1024)
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new McpTransportError("MCP_TRANSPORT_FAILED", "transport is closed")
    if (this.failure !== undefined) throw this.failure
    if (this.active.size >= 32) throw new McpTransportError("MCP_MESSAGE_LIMIT", "too many active MCP requests")
    if (typeof message !== "string" || message.length === 0 || Buffer.byteLength(message, "utf8") > this.maxMessageBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "outgoing message exceeds its byte limit")
    // A token that cannot be read fails this request only; the transport stays usable.
    if (this.authorization !== undefined) {
      this.bearer = await this.authorization(AbortSignal.timeout(this.timeoutMs))
      if (this.closed) throw new McpTransportError("MCP_TRANSPORT_FAILED", "transport is closed")
    }
    const controller = new AbortController()
    this.active.add(controller)
    const timer = setTimeout(() => controller.abort("MCP HTTP timeout"), this.timeoutMs)
    let awaiting: Set<string> | undefined
    try {
      // Its headers can carry a token, which a redirect would hand to another address.
      const response = await fetch(this.url, { method: "POST", headers: this.requestHeaders(), body: message, redirect: "error", signal: controller.signal })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        if (response.status === 401) throw new McpTransportError("MCP_UNAUTHORIZED", "MCP server refused the request's credentials")
        throw new McpTransportError("MCP_TRANSPORT_FAILED", "MCP HTTP request failed")
      }
      const sessionId = response.headers.get("mcp-session-id")
      if (sessionId !== null && /^[\x21-\x7e]{1,256}$/.test(sessionId)) this.sessionId = sessionId
      if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true) {
        awaiting = requestIds(message)
        await this.readEvents(response, awaiting)
        return
      }
      const body = await readBounded(response, this.maxMessageBytes)
      for (const value of parseBody(body, response.headers.get("content-type"), this.maxMessageBytes)) {
        this.noteProtocolVersion(value)
        this.push(value)
      }
    } catch (error) {
      // A stream that answered everything asked of it, or carried no request, ends at the timeout.
      if (controller.signal.aborted && awaiting?.size === 0 && !this.closed) return
      const normalized = error instanceof McpTransportError ? error : controller.signal.aborted ? new McpTransportError("MCP_TRANSPORT_FAILED", "MCP HTTP request timed out") : new McpTransportError("MCP_TRANSPORT_FAILED", "MCP HTTP request failed")
      this.fail(normalized)
      throw normalized
    } finally {
      clearTimeout(timer)
      this.active.delete(controller)
    }
  }

  receive(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
        next: (): Promise<IteratorResult<string>> => {
          const value = this.queue.shift()
          if (value !== undefined) { this.queuedBytes -= Buffer.byteLength(value, "utf8"); return Promise.resolve({ done: false, value }) }
          if (this.failure !== undefined) return Promise.reject(this.failure)
          if (this.closed) return Promise.resolve({ done: true, value: undefined as never })
          return new Promise<IteratorResult<string>>((resolve, reject) => this.waiters.push({ resolve, reject }))
        },
        return: (): Promise<IteratorResult<string>> => {
          void this.close()
          return Promise.resolve({ done: true, value: undefined as never })
        },
      }),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const controller of this.active) controller.abort("MCP HTTP transport closed")
    this.active.clear()
    this.queue.length = 0
    this.queuedBytes = 0
    this.settle()
    if (this.sessionId !== undefined) {
      // The spec asks a client to end its session; a server that does not support it answers 405.
      await fetch(this.url, { method: "DELETE", headers: this.requestHeaders(), redirect: "error", signal: AbortSignal.timeout(2_000) })
        .then((response) => response.body?.cancel())
        .catch(() => undefined)
    }
  }

  private requestHeaders(): Readonly<Record<string, string>> {
    return {
      ...this.headers,
      ...(this.bearer === undefined ? {} : { authorization: `Bearer ${this.bearer}` }),
      ...(this.sessionId === undefined ? {} : { "mcp-session-id": this.sessionId }),
      ...(this.protocolVersion === undefined ? {} : { "mcp-protocol-version": this.protocolVersion }),
    }
  }

  private noteProtocolVersion(value: string): void {
    if (this.protocolVersion !== undefined || !value.includes("protocolVersion")) return
    try {
      const parsed = JSON.parse(value) as { result?: { protocolVersion?: unknown } }
      const version = parsed?.result?.protocolVersion
      if (typeof version === "string" && /^[0-9A-Za-z.-]{1,32}$/.test(version)) this.protocolVersion = version
    } catch {
      // The client reports a malformed message itself.
    }
  }

  /**
   * Hands each SSE event on as it completes. A server may keep the stream open after it answers,
   * so reading stops once every request this POST carried has its reply.
   */
  private async readEvents(response: Response, awaiting: Set<string>): Promise<void> {
    if (response.body === null) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const expectsReply = awaiting.size > 0
    let buffer = ""
    let delivered = 0
    let responseBytes = 0
    let eventCount = 0
    let content = false
    const deliver = (event: string): boolean => {
      if (++eventCount > 256) throw new McpTransportError("MCP_MESSAGE_LIMIT", "MCP SSE event limit exceeded")
      const value = eventData(event)
      if (value === undefined) return false
      if (Buffer.byteLength(value, "utf8") > this.maxMessageBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "incoming MCP response exceeds its byte limit")
      delivered += 1
      this.noteProtocolVersion(value)
      this.push(value)
      for (const id of replyIds(value)) awaiting.delete(id)
      return expectsReply && awaiting.size === 0
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        responseBytes += value?.byteLength ?? 0
        if (responseBytes > this.maxQueuedBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "MCP SSE response limit exceeded")
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        content ||= buffer.trim().length > 0
        for (let end = EVENT_END.exec(buffer); end !== null; end = EVENT_END.exec(buffer)) {
          const event = buffer.slice(0, end.index)
          buffer = buffer.slice(end.index + end[0].length)
          if (deliver(event)) return
        }
        if (Buffer.byteLength(buffer, "utf8") > this.maxMessageBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "incoming MCP response exceeds its byte limit")
        if (done) break
      }
      if (deliver(buffer)) return
      // An empty body answers a notification; a body with no data in it is a broken reply.
      if (delivered === 0 && content) throw new McpTransportError("MCP_TRANSPORT_FAILED", "MCP SSE response has no data")
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private push(value: string): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) {
      const bytes = Buffer.byteLength(value, "utf8")
      if (this.queue.length >= 256 || this.queuedBytes + bytes > this.maxQueuedBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "MCP incoming queue limit exceeded")
      this.queue.push(value)
      this.queuedBytes += bytes
    }
    else waiter.resolve({ done: false, value })
  }

  private fail(error: unknown): void {
    if (this.failure !== undefined || this.closed) return
    this.failure = error
    this.queue.length = 0
    this.queuedBytes = 0
    for (const controller of this.active) controller.abort("MCP transport failed")
    this.settle()
  }

  private settle(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (this.failure !== undefined) waiter.reject(this.failure)
      else waiter.resolve({ done: true, value: undefined as never })
    }
  }
}

export function createMcpHttpTransport(options: McpHttpTransportOptions): McpHttpTransport {
  return new McpHttpTransport(options)
}

function validateOptions(options: McpHttpTransportOptions): void {
  if (options === null || typeof options !== "object" || typeof options.url !== "string" || options.url.length === 0 || options.url.length > 2_048) throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP URL is invalid")
  let url: URL
  try {
    url = new URL(options.url)
  } catch {
    throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP URL is invalid")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP URL scheme or credentials are invalid")
  if (options.allowRemote !== true && !isLoopback(url.hostname)) throw new McpTransportError("MCP_TRANSPORT_INVALID", "remote MCP URLs require explicit opt-in")
  if (options.headers !== undefined) {
    if (options.headers === null || typeof options.headers !== "object" || Array.isArray(options.headers) || Object.keys(options.headers).length > 32) throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP headers are invalid")
    for (const [name, value] of Object.entries(options.headers)) if (!/^[A-Za-z0-9-]{1,128}$/.test(name) || typeof value !== "string" || value.length > 4_096 || /[\r\n]/.test(value)) throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP header is invalid")
  }
  if (options.authorization !== undefined && typeof options.authorization !== "function") throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP authorization is invalid")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP timeout is invalid")
  if (options.maxMessageBytes !== undefined && (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes < 1 || options.maxMessageBytes > 16 * 1024 * 1024)) throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP message limit is invalid")
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new McpTransportError("MCP_MESSAGE_LIMIT", "incoming MCP response exceeds its byte limit")
  }
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new McpTransportError("MCP_MESSAGE_LIMIT", "incoming MCP response exceeds its byte limit")
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const EVENT_END = /\r\n\r\n|\n\n|\r\r/

/** One SSE event is one message; its `data:` lines join with newlines. */
function eventData(event: string): string | undefined {
  const value = event.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5)).join("\n").trim()
  return value.length === 0 ? undefined : value
}

/** The ids of the requests in an outgoing message, a batch or one. */
function requestIds(message: string): Set<string> {
  return new Set(rpcEntries(message).filter((entry) => typeof entry.method === "string").flatMap(idKey))
}

/** The ids a message answers. */
function replyIds(message: string): readonly string[] {
  return rpcEntries(message).filter((entry) => entry.method === undefined && ("result" in entry || "error" in entry)).flatMap(idKey)
}

function rpcEntries(message: string): readonly Record<string, unknown>[] {
  let value: unknown
  try {
    value = JSON.parse(message)
  } catch {
    return []
  }
  return (Array.isArray(value) ? value : [value]).filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry))
}

function idKey(entry: Record<string, unknown>): readonly string[] {
  return typeof entry.id === "string" || typeof entry.id === "number" ? [`${typeof entry.id}:${String(entry.id)}`] : []
}

function parseBody(body: string, contentType: string | null, maxBytes: number): readonly string[] {
  if (body.trim().length === 0) return Object.freeze([])
  if (contentType?.toLowerCase().includes("text/event-stream") === true) {
    // One SSE event is one message; its `data:` lines join with newlines.
    const values: string[] = []
    for (const event of body.split(/\r\n\r\n|\n\n|\r\r/)) {
      const data = event.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      const value = data.join("\n").trim()
      if (value.length > 0) values.push(value)
    }
    if (values.length === 0) throw new McpTransportError("MCP_TRANSPORT_FAILED", "MCP SSE response has no data")
    return Object.freeze(values)
  }
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "MCP response exceeds its byte limit")
  return Object.freeze([body.trim()])
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}
