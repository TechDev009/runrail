import { randomBytes } from "node:crypto"

/**
 * The agent's way to the person's other threads: list them, read one, and
 * send one a message. The engine knows only its own thread, so it asks; the desktop claims each
 * request once (`take`), applies its guards (which threads, how many messages, how deep a chain),
 * and answers (`respond`). Requests are bounded, one-time, and expire.
 */

export type ThreadsAction = "list" | "read" | "send"

export const THREADS_ACTIONS: ReadonlySet<ThreadsAction> = new Set(["list", "read", "send"])

export type ThreadsErrorCode =
  | "THREADS_INVALID_INPUT"
  | "THREADS_BUSY"
  | "THREADS_TIMEOUT"
  | "THREADS_CLOSED"
  | "THREADS_DENIED"
  | "THREADS_NOT_FOUND"
  | "THREADS_LIMIT"
  | "THREADS_FAILED"
  | "THREADS_OFF"
  | "THREADS_REQUEST_NOT_FOUND"
  | "THREADS_RESULT_INVALID"

export class ThreadsError extends Error {
  constructor(
    readonly code: ThreadsErrorCode,
    reason: string,
  ) {
    super(reason)
    this.name = "ThreadsError"
  }
}

/** Codes the desktop may answer with; anything else reads as a failure. */
const ANSWER_CODES: ReadonlySet<ThreadsErrorCode> = new Set(["THREADS_DENIED", "THREADS_NOT_FOUND", "THREADS_LIMIT", "THREADS_FAILED", "THREADS_OFF", "THREADS_TIMEOUT"])

export interface ThreadsResult {
  readonly text: string
}

export interface ThreadsTask {
  readonly requestId: string
  readonly action: ThreadsAction
  readonly params: Readonly<Record<string, unknown>>
  readonly expiresAt: number
}

export interface ThreadsRequestFrame {
  readonly type: "threads.request"
  readonly requestId: string
  readonly action: ThreadsAction
}

const MAX_PENDING = 4
const TIMEOUT_MS = 30_000
// A message sent with `wait` holds the call until the other thread's turn ends.
const WAIT_TIMEOUT_MS = 15 * 60_000
const MAX_THREAD_REF = 256
export const MAX_THREAD_MESSAGE = 8_000
const MAX_RESULT_TEXT = 64 * 1024
const MAX_MESSAGE = 500
const REQUEST_ID = /^tr-[0-9a-f]{32}$/

function record(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {}
  if (typeof input !== "object" || Array.isArray(input)) throw new ThreadsError("THREADS_INVALID_INPUT", "input must be an object")
  return input as Record<string, unknown>
}

function threadRef(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_THREAD_REF || /[\u0000-\u001f\u007f]/.test(value)) throw new ThreadsError("THREADS_INVALID_INPUT", "thread must be a thread's id or title from list_threads")
  return value.trim()
}

/** Checks one action's input; what passes is all the desktop is sent. */
export function parseThreadsParams(action: ThreadsAction, input: unknown): Readonly<Record<string, unknown>> {
  const value = record(input)
  switch (action) {
    case "list":
      return Object.freeze({})
    case "read":
      return Object.freeze({ thread: threadRef(value.thread) })
    case "send": {
      if (typeof value.message !== "string" || value.message.trim().length === 0 || value.message.length > MAX_THREAD_MESSAGE) throw new ThreadsError("THREADS_INVALID_INPUT", `message must be text of at most ${String(MAX_THREAD_MESSAGE)} characters`)
      if (value.wait !== undefined && typeof value.wait !== "boolean") throw new ThreadsError("THREADS_INVALID_INPUT", "wait must be a boolean")
      return Object.freeze({ thread: threadRef(value.thread), message: value.message.trim(), ...(value.wait === true ? { wait: true } : {}) })
    }
  }
}

function oneLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : ""
}

/** The desktop's answer, bounded. */
export function parseThreadsAnswer(answer: unknown): ThreadsResult {
  const value = record(answer)
  if (value.ok === false) {
    const code = typeof value.code === "string" && ANSWER_CODES.has(value.code as ThreadsErrorCode) ? (value.code as ThreadsErrorCode) : "THREADS_FAILED"
    throw new ThreadsError(code, oneLine(value.message, MAX_MESSAGE) || "the other thread could not be reached")
  }
  if (value.ok !== true) throw new ThreadsError("THREADS_RESULT_INVALID", "answer must say ok")
  const result = record(value.result)
  if (typeof result.text !== "string") throw new ThreadsError("THREADS_RESULT_INVALID", "result text is invalid")
  return Object.freeze({ text: result.text.slice(0, MAX_RESULT_TEXT) })
}

interface Pending {
  readonly task: ThreadsTask
  taken: boolean
  readonly resolve: (result: ThreadsResult) => void
  readonly reject: (error: ThreadsError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** The thread tools, as a session receives them. */
export interface RunrailThreadsAccess {
  readonly bridge: ThreadsBridge
  /** The `--mcp-config` document that gives Claude Code the thread tools. */
  readonly mcpConfig?: string
}

export interface ThreadsBridgeOptions {
  readonly emit?: (frame: ThreadsRequestFrame) => void
  readonly timeoutMs?: number
  readonly waitTimeoutMs?: number
}

export class ThreadsBridge {
  /** For the `POST /threads` endpoint a coding tool's MCP server calls; never the control token. */
  readonly endpointToken = randomBytes(32).toString("hex")
  private emit: ((frame: ThreadsRequestFrame) => void) | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly timeoutMs: number
  private readonly waitTimeoutMs: number
  private closed = false

  constructor(options: ThreadsBridgeOptions = {}) {
    this.emit = options.emit
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS
    this.waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS
  }

  /** Where requests are announced; the control server binds its live stream here. */
  bind(emit: (frame: ThreadsRequestFrame) => void): void {
    this.emit = emit
  }

  request(action: ThreadsAction, input: unknown, signal?: AbortSignal): Promise<ThreadsResult> {
    if (this.closed) return Promise.reject(new ThreadsError("THREADS_CLOSED", "the thread tools are closed"))
    if (!THREADS_ACTIONS.has(action)) return Promise.reject(new ThreadsError("THREADS_INVALID_INPUT", "unknown thread action"))
    let params: Readonly<Record<string, unknown>>
    try {
      params = parseThreadsParams(action, input)
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new ThreadsError("THREADS_BUSY", "the other threads are still answering earlier requests"))
    const emit = this.emit
    if (emit === undefined) return Promise.reject(new ThreadsError("THREADS_OFF", "no desktop is attached to reach other threads"))
    const requestId = `tr-${randomBytes(16).toString("hex")}`
    const timeoutMs = params.wait === true ? this.waitTimeoutMs : this.timeoutMs
    return new Promise<ThreadsResult>((resolve, reject) => {
      const finish = (): void => {
        const entry = this.pending.get(requestId)
        if (entry === undefined) return
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        signal?.removeEventListener("abort", aborted)
      }
      const aborted = (): void => {
        finish()
        reject(new ThreadsError("THREADS_CLOSED", "the tool call was cancelled"))
      }
      const timer = setTimeout(() => {
        finish()
        reject(new ThreadsError("THREADS_TIMEOUT", params.wait === true ? "the other thread did not finish in time; read it later with read_thread" : "the desktop did not answer in time"))
      }, timeoutMs)
      this.pending.set(requestId, {
        task: Object.freeze({ requestId, action, params, expiresAt: Date.now() + timeoutMs }),
        taken: false,
        resolve: (result) => {
          finish()
          resolve(result)
        },
        reject: (error) => {
          finish()
          reject(error)
        },
        timer,
      })
      if (signal?.aborted === true) return aborted()
      signal?.addEventListener("abort", aborted, { once: true })
      try {
        emit(Object.freeze({ type: "threads.request", requestId, action }))
      } catch {
        this.pending.get(requestId)?.reject(new ThreadsError("THREADS_OFF", "the request could not be announced"))
      }
    })
  }

  /** Hands a request to the desktop once; a replayed announcement finds nothing. */
  take(requestId: unknown): ThreadsTask {
    const entry = typeof requestId === "string" && REQUEST_ID.test(requestId) ? this.pending.get(requestId) : undefined
    if (entry === undefined || entry.taken) throw new ThreadsError("THREADS_REQUEST_NOT_FOUND", "no open thread request has this id")
    entry.taken = true
    return entry.task
  }

  respond(requestId: unknown, answer: unknown): void {
    const entry = typeof requestId === "string" && REQUEST_ID.test(requestId) ? this.pending.get(requestId) : undefined
    if (entry === undefined || !entry.taken) throw new ThreadsError("THREADS_REQUEST_NOT_FOUND", "no claimed thread request has this id")
    let result: ThreadsResult
    try {
      result = parseThreadsAnswer(answer)
    } catch (error) {
      const refusal = error instanceof ThreadsError && error.code !== "THREADS_RESULT_INVALID" && error.code !== "THREADS_INVALID_INPUT"
      const failure = refusal ? error : new ThreadsError("THREADS_RESULT_INVALID", error instanceof Error ? error.message : "the answer is invalid")
      entry.reject(failure)
      // A refusal is an answer; a malformed answer is the desktop's fault, so it hears about it too.
      if (!refusal) throw failure
      return
    }
    entry.resolve(result)
  }

  close(): void {
    this.closed = true
    for (const entry of [...this.pending.values()]) entry.reject(new ThreadsError("THREADS_CLOSED", "the engine stopped"))
  }
}
