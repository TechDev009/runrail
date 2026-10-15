import { RUNRAIL_VERSION } from "../version.ts"
import type {
  AgentBackend,
  AgentBackendInfo,
  AgentEvent,
  AgentSessionSnapshot,
  CreateSessionInput,
  ReloadResult,
  SendMessageInput,
} from "@nifrajs/agent-protocol"
import { isAgentEvent } from "@nifrajs/agent-protocol"
import { failureWords, messageWords } from "../harness/failure-words.ts"
import type { RunrailBackendAdapter } from "./registry.ts"

export interface HttpAgentBackendOptions {
  readonly url: string
  readonly name?: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  /** Caller-owned authentication headers; values are retained only in memory. */
  readonly headers?: Readonly<Record<string, string>>
  readonly allowRemote?: boolean
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

export type HttpAgentBackendErrorCode = "HTTP_AGENT_INVALID" | "HTTP_AGENT_TIMEOUT" | "HTTP_AGENT_CANCELLED" | "HTTP_AGENT_RESPONSE_INVALID" | "HTTP_AGENT_FAILED"

export class HttpAgentBackendError extends Error {
  constructor(readonly code: HttpAgentBackendErrorCode, readonly reason: string) {
    super(`HTTP agent backend: ${reason}`)
    this.name = "HttpAgentBackendError"
  }
}

interface RemoteSession {
  snapshot: AgentSessionSnapshot
  active?: AbortController
  cancelled?: string
}

/** Provider-neutral HTTP AgentBackend. The remote service owns auth, model execution, and storage. */
export class HttpAgentBackend implements AgentBackend {
  readonly info: AgentBackendInfo
  private readonly endpoint: URL
  private readonly headers: Readonly<Record<string, string>>
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly sessions = new Map<string, RemoteSession>()
  private sequence = 0

  constructor(options: HttpAgentBackendOptions) {
    validateOptions(options)
    this.endpoint = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`)
    this.headers = Object.freeze({ "content-type": "application/json", ...(options.headers ?? {}) })
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxResponseBytes = options.maxResponseBytes ?? 512 * 1024
    this.info = Object.freeze({ name: options.name ?? "remote-agent", version: options.version ?? RUNRAIL_VERSION, capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming"])].sort()) })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "session cwd is invalid")
    const value = await this.request("sessions", "POST", { cwd: input.cwd, backend: this.info.name, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) })
    const snapshot = parseSnapshot(value)
    if (snapshot.cwd !== input.cwd || snapshot.backend.length === 0) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote session snapshot does not match the request")
    this.sessions.set(snapshot.id, { snapshot })
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    return this.sendStream(input)
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    session.cancelled = reason.slice(0, 256)
    session.active?.abort(reason)
    await this.request(`sessions/${encodeURIComponent(sessionId)}/cancel`, "POST", { reason: session.cancelled }).catch(() => undefined)
    session.snapshot = makeSnapshot(session.snapshot, "stopped", session.snapshot.lastSeq)
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    this.requireSession(sessionId)
    const value = await this.request(`sessions/${encodeURIComponent(sessionId)}`, "GET")
    const snapshot = parseSnapshot(value)
    if (snapshot.id !== sessionId) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote snapshot id does not match")
    this.sessions.get(sessionId)!.snapshot = snapshot
    return snapshot
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    this.requireSession(sessionId)
    const value = await this.request(`sessions/${encodeURIComponent(sessionId)}/reload`, "POST", {})
    if (!isRecord(value) || typeof value.revision !== "string" || value.revision.length === 0 || !Array.isArray(value.loaded) || !Array.isArray(value.disabled) || typeof value.rolledBack !== "boolean") throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote reload response is invalid")
    return Object.freeze({ revision: value.revision, loaded: boundedStrings(value.loaded, "loaded"), disabled: boundedStrings(value.disabled, "disabled"), rolledBack: value.rolledBack })
  }

  async resolveApproval(sessionId: string, approvalId: string, approved: boolean, reason?: string): Promise<boolean | undefined> {
    this.requireSession(sessionId)
    if (!validId(approvalId) || typeof approved !== "boolean") throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "approval request is invalid")
    const value = await this.request(`sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, "POST", { approved, ...(reason === undefined ? {} : { reason: reason.slice(0, 512) }) })
    if (typeof value === "boolean") return value
    if (!isRecord(value) || typeof value.resolved !== "boolean") throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote approval response is invalid")
    return value.resolved
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.cancelled = "closed"
    session.active?.abort("closed")
    await this.request(`sessions/${encodeURIComponent(sessionId)}`, "DELETE").catch(() => undefined)
    this.sessions.delete(sessionId)
  }

  private async *sendStream(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 256 * 1024) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "agent message is invalid")
    const session = this.requireSession(input.sessionId)
    if (session.active !== undefined) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "agent session is already running")
    session.cancelled = undefined
    const controller = new AbortController()
    session.active = controller
    const abort = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted === true) abort()
    let stoppedEmitted = false
    try {
      const value = await this.request(`sessions/${encodeURIComponent(input.sessionId)}/messages`, "POST", { message: input.message }, controller.signal)
      const events = parseEventList(value, this.maxResponseBytes)
      for (const event of events) {
        if (event.sessionId !== session.snapshot.id || event.seq <= session.snapshot.lastSeq || !ownsSnapshot(event, session.snapshot)) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote event sequence is invalid")
        session.snapshot = eventSnapshot(event, session.snapshot)
        yield event
        if (event.type === "session.stopped") stoppedEmitted = true
      }
      if (controller.signal.aborted || input.signal?.aborted || session.cancelled !== undefined) {
        if (!stoppedEmitted) {
          const event: AgentEvent = Object.freeze({ version: 1, sessionId: session.snapshot.id, seq: session.snapshot.lastSeq + 1, at: Date.now(), type: "session.stopped", reason: session.cancelled ?? "cancelled" })
          session.snapshot = eventSnapshot(event, session.snapshot)
          yield event
        }
        return
      }
      if (!events.some((event) => event.type === "session.completed" || event.type === "session.failed" || event.type === "session.stopped")) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote event stream has no terminal event")
    } catch (error) {
      const cancelled = controller.signal.aborted || input.signal?.aborted || session.cancelled !== undefined
      if (cancelled) {
        if (!stoppedEmitted) {
          const event: AgentEvent = Object.freeze({ version: 1, sessionId: session.snapshot.id, seq: session.snapshot.lastSeq + 1, at: Date.now(), type: "session.stopped", reason: session.cancelled ?? "cancelled" })
          session.snapshot = eventSnapshot(event, session.snapshot)
          yield event
        }
        return
      }
      if (error instanceof HttpAgentBackendError) throw error
      throw new HttpAgentBackendError("HTTP_AGENT_FAILED", "remote request failed")
    } finally {
      input.signal?.removeEventListener("abort", abort)
      session.active = undefined
    }
  }

  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort("HTTP agent timeout"), this.timeoutMs)
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abort, { once: true })
    // A signal aborted before the listener was added never fires it.
    if (signal?.aborted === true) abort()
    try {
      const response = await fetch(new URL(path, this.endpoint), { method, headers: this.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: controller.signal })
      if (!response.ok) {
        const words = await failureBody(response, headerSecrets(this.headers))
        throw new HttpAgentBackendError("HTTP_AGENT_FAILED", `remote agent answered ${String(response.status)}${words === undefined ? "" : `: ${words}`}`)
      }
      const text = await readResponseText(response, this.maxResponseBytes)
      if (text.length === 0) return undefined
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote response is not JSON")
      }
    } catch (error) {
      if (error instanceof HttpAgentBackendError) throw error
      if (controller.signal.aborted) throw new HttpAgentBackendError(signal?.aborted ? "HTTP_AGENT_CANCELLED" : "HTTP_AGENT_TIMEOUT", signal?.aborted ? "remote request was cancelled" : "remote request timed out")
      throw new HttpAgentBackendError("HTTP_AGENT_FAILED", "remote request failed")
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }

  private requireSession(id: string): RemoteSession {
    if (!validId(id)) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "session id is invalid")
    const session = this.sessions.get(id)
    if (session === undefined) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote session is unknown")
    return session
  }
}

export function createHttpAgentBackend(options: HttpAgentBackendOptions): HttpAgentBackend {
  return new HttpAgentBackend(options)
}
export function createHttpAgentAdapter(options: HttpAgentBackendOptions): RunrailBackendAdapter {
  validateOptions(options)
  return {
    name: options.name ?? "remote-agent",
    version: options.version ?? RUNRAIL_VERSION,
    capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming"])]),
    create: () => createHttpAgentBackend(options),
  }


}
function parseEventList(value: unknown, maxBytes: number): readonly AgentEvent[] {
  const raw = isRecord(value) && Array.isArray(value.events) ? value.events : Array.isArray(value) ? value : undefined
  if (raw === undefined || raw.length > 4_096) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote event list is invalid")
  const events: AgentEvent[] = []
  for (const item of raw) {
    if (!isAgentEvent(item)) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote event is invalid")
    events.push(item)
  }
  if (Buffer.byteLength(JSON.stringify(events), "utf8") > maxBytes) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote event list exceeds its byte limit")
  return Object.freeze(events)
}

function parseSnapshot(value: unknown): AgentSessionSnapshot {
  if (!isRecord(value) || value.version !== 1) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote session snapshot is invalid")
  const id = value.id
  const backend = value.backend
  const cwd = value.cwd
  const status = value.status
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  const lastSeq = value.lastSeq
  if (!validId(id) || typeof backend !== "string" || backend.length === 0 || typeof cwd !== "string" || cwd.length === 0 || !isSessionStatus(status) || !isSafeInteger(createdAt) || !isSafeInteger(updatedAt) || !isSafeInteger(lastSeq) || lastSeq < -1) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote session snapshot is invalid")
  const capabilities = boundedStrings(value.capabilities, "capabilities")
  return Object.freeze({ version: 1, id, backend, cwd, status, createdAt, updatedAt, lastSeq, capabilities })
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function isSessionStatus(value: unknown): value is AgentSessionSnapshot["status"] {
  return value === "idle" || value === "running" || value === "waiting" || value === "completed" || value === "failed" || value === "stopped"
}

function ownsSnapshot(event: AgentEvent, previous: AgentSessionSnapshot): boolean {
  return event.type !== "session.started" && event.type !== "session.updated" && event.type !== "session.completed" || (event.snapshot.id === previous.id && event.snapshot.cwd === previous.cwd)
}

function eventSnapshot(event: AgentEvent, previous: AgentSessionSnapshot): AgentSessionSnapshot {
  if (event.type === "session.started" || event.type === "session.updated" || event.type === "session.completed") return event.snapshot
  if (event.type === "session.failed") return makeSnapshot(previous, "failed", event.seq)
  if (event.type === "session.stopped") return makeSnapshot(previous, "stopped", event.seq)
  if (event.type === "approval.required") return makeSnapshot(previous, "waiting", event.seq)
  return makeSnapshot(previous, "running", event.seq)
}

function makeSnapshot(previous: AgentSessionSnapshot, status: AgentSessionSnapshot["status"], lastSeq: number): AgentSessionSnapshot {
  return Object.freeze({ ...previous, status, lastSeq, updatedAt: Date.now() })
}

function boundedStrings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256)) throw new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", `${name} is invalid`)
  return Object.freeze(value.map((item) => item as string))
}

function validateOptions(options: HttpAgentBackendOptions): void {
  if (options === null || typeof options !== "object" || typeof options.url !== "string" || options.url.length === 0 || options.url.length > 2_048) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote URL is invalid")
  let url: URL
  try { url = new URL(options.url) } catch { throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote URL is invalid") }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username.length > 0 || url.password.length > 0) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote URL scheme or credentials are invalid")
  if (options.allowRemote !== true && !isLoopback(url.hostname)) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote agent URLs require explicit opt-in")
  if (options.name !== undefined && !validId(options.name)) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote agent name is invalid")
  if (options.version !== undefined && (typeof options.version !== "string" || options.version.length === 0 || options.version.length > 64)) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote agent version is invalid")
  const capabilities = options.capabilities ?? ["sessions", "streaming"]
  if (!Array.isArray(capabilities) || capabilities.length > 32 || capabilities.some((value) => !validCapability(value))) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote capabilities are invalid")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote timeout is invalid")
  if (options.maxResponseBytes !== undefined && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1 || options.maxResponseBytes > 4 * 1024 * 1024)) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote response limit is invalid")
  if (options.headers !== undefined) {
    if (options.headers === null || typeof options.headers !== "object" || Array.isArray(options.headers) || Object.keys(options.headers).length > 32) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote headers are invalid")
    for (const [name, value] of Object.entries(options.headers)) if (!/^[A-Za-z0-9-]{1,128}$/.test(name) || typeof value !== "string" || value.length > 4_096 || /[\r\n]/.test(value)) throw new HttpAgentBackendError("HTTP_AGENT_INVALID", "remote header is invalid")
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

/** The caller's header values, whole and as their last word (the token in `Bearer <token>`). */
function headerSecrets(headers: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type").flatMap(([, value]) => [value, value.trim().split(/\s+/).at(-1) ?? ""])
}

/** The remote agent's words for a refused request: its JSON error message, else its text. Never a header it was sent. */
async function failureBody(response: Response, secrets: readonly string[]): Promise<string | undefined> {
  // A proxy's error page is markup, not words; the status says enough.
  if (/html/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  let text: string
  try {
    text = await readResponseText(response, 16 * 1024)
  } catch {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    // Not JSON: the last thing the text says.
    return failureWords(text, secrets)
  }
  const error = isRecord(value) ? value.error : undefined
  const message = isRecord(error) ? error.message : typeof error === "string" ? error : isRecord(value) ? value.message : undefined
  return typeof message === "string" ? messageWords(message, secrets) : undefined
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = (): HttpAgentBackendError => new HttpAgentBackendError("HTTP_AGENT_RESPONSE_INVALID", "remote response exceeds its byte limit")
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
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
      throw tooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
