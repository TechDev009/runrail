import type {
  AgentBackend,
  AgentBackendInfo,
  AgentEvent,
  AgentSessionSnapshot,
  CreateSessionInput,
  ReloadResult,
  SendMessageInput,
} from "@nifrajs/agent-protocol"
import { HarnessJsonlError, decodeHarnessJsonl } from "../harness/jsonl.ts"
import { HarnessAuthError, parseHarnessAuthOptions, resolveHarnessEnvironment } from "../harness/auth.ts"
import { credentialValues, exitReason, failureWords } from "../harness/failure-words.ts"
import type { HarnessAuthOptions } from "../harness/types.ts"
import type { RunrailBackendAdapter } from "./registry.ts"
import { RUNRAIL_VERSION } from "../version.ts"
import { terminateProcessTree } from "./process-tree.ts"

const ECHO = 0x00000008
const ICANON = process.platform === "darwin" ? 0x00000100 : 0x00000002

export interface PtyAgentBackendOptions {
  readonly name?: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly auth?: HarnessAuthOptions
  readonly timeoutMs?: number
  readonly maxLineBytes?: number
  readonly maxEvents?: number
  readonly maxStreamBytes?: number
  readonly cols?: number
  readonly rows?: number
  readonly terminalName?: string
}

export type PtyAgentBackendErrorCode =
  | "PTY_AGENT_INVALID"
  | "PTY_AGENT_AUTH_INVALID"
  | "PTY_AGENT_CREDENTIALS_UNAVAILABLE"
  | "PTY_AGENT_TIMEOUT"
  | "PTY_AGENT_CANCELLED"
  | "PTY_AGENT_OUTPUT_INVALID"
  | "PTY_AGENT_FAILED"

export class PtyAgentBackendError extends Error {
  constructor(readonly code: PtyAgentBackendErrorCode, readonly reason: string) {
    super(`pty agent backend: ${reason}`)
    this.name = "PtyAgentBackendError"
  }
}

interface PtyProcess {
  readonly pid: number
  readonly exited: Promise<number>
  readonly terminal: Bun.Terminal | undefined
  kill(signal?: number | NodeJS.Signals): void
}

interface PtySession {
  snapshot: AgentSessionSnapshot
  active?: {
    readonly process: PtyProcess
    readonly terminal: Bun.Terminal
  }
  cancelled?: string
  running?: boolean
}

interface ChannelWaiter {
  readonly resolve: (result: IteratorResult<Uint8Array>) => void
  readonly reject: (error: unknown) => void
}

/**
 * JSONL AgentBackend for interactive command runtimes that require a real PTY.
 * The PTY is a transport only: prompt text, terminal bytes, stderr, and raw output
 * are never retained after the normalized event stream is consumed.
 */
export class PtyAgentBackend implements AgentBackend {
  readonly info: AgentBackendInfo
  private readonly options: Required<Pick<PtyAgentBackendOptions, "timeoutMs" | "maxLineBytes" | "maxEvents" | "maxStreamBytes" | "cols" | "rows" | "terminalName">>
  private readonly commandOptions: PtyAgentBackendOptions
  private readonly auth: HarnessAuthOptions
  private readonly sessions = new Map<string, PtySession>()
  private sequence = 0

  constructor(options: PtyAgentBackendOptions) {
    validateOptions(options)
    this.commandOptions = options
    try {
      this.auth = parseHarnessAuthOptions(options.auth)
    } catch {
      throw new PtyAgentBackendError("PTY_AGENT_AUTH_INVALID", "harness authentication options are invalid")
    }
    this.options = {
      timeoutMs: options.timeoutMs ?? 120_000,
      maxLineBytes: options.maxLineBytes ?? 256 * 1024,
      maxEvents: options.maxEvents ?? 4_096,
      maxStreamBytes: options.maxStreamBytes ?? 8 * 1024 * 1024,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      terminalName: options.terminalName ?? "xterm-256color",
    }
    this.info = Object.freeze({
      name: options.name ?? "pty-agent",
      version: options.version ?? RUNRAIL_VERSION,
      capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming", "pty"])].sort()),
    })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096)
      throw new PtyAgentBackendError("PTY_AGENT_INVALID", "session cwd is invalid")
    const id = input.sessionId ?? `${this.info.name}-${++this.sequence}`
    if (!validId(id) || this.sessions.has(id)) throw new PtyAgentBackendError("PTY_AGENT_INVALID", "session id is invalid or already exists")
    const snapshot = makeSnapshot(id, this.info.name, input.cwd, "idle", -1, this.info.capabilities)
    this.sessions.set(id, { snapshot })
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    return this.run(input)
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    session.cancelled = reason.slice(0, 256)
    if (session.active !== undefined) await terminateProcessTree(session.active.process)
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId).snapshot
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    this.requireSession(sessionId)
    return Object.freeze({ revision: `${this.info.version}:reload`, loaded: Object.freeze([]), disabled: Object.freeze([]), rolledBack: false })
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireSession(sessionId)
    validateDimension(cols, "cols")
    validateDimension(rows, "rows")
    session.active?.terminal.resize(cols, rows)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.cancelled = "closed"
    if (session.active !== undefined) await terminateProcessTree(session.active.process)
    session.active?.terminal.close()
    this.sessions.delete(sessionId)
  }

  private async *run(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 256 * 1024)
      throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent message is invalid")
    const session = this.requireSession(input.sessionId)
    if (session.running === true) throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent session is already running")
    session.running = true
    session.cancelled = undefined

    let child: PtyProcess | undefined
    let terminal: Bun.Terminal | undefined
    let secrets: readonly string[] = []
    const channel = new ByteChannel(this.options.maxStreamBytes, () => void (child === undefined ? undefined : terminateProcessTree(child)))
    // Stderr shares the terminal, so a program that fails says why in the last text it printed.
    const printed = new PrintedTail()
    const words = (): string | undefined => failureWords(printed.text, secrets)
    try {
      terminal = new Bun.Terminal({
        cols: this.options.cols,
        rows: this.options.rows,
        name: this.options.terminalName,
        data: (_instance, data) => channel.push(data),
        exit: () => channel.close(),
      })
      // No echo, and no canonical line editing: a canonical PTY cuts a line at MAX_CANON (1024 bytes on macOS).
      terminal.localFlags = terminal.localFlags & ~(ECHO | ICANON)
      const env = await this.commandEnvironment()
      secrets = credentialValues(env, this.auth.credentialEnvironment)
      if (Boolean(input.signal?.aborted) || session.cancelled !== undefined) {
        const stopped = makeStoppedEvent(session, session.cancelled ?? "cancelled")
        session.snapshot = eventSnapshot(stopped, session.snapshot)
        yield stopped
        return
      }
      try {
        child = Bun.spawn([this.commandOptions.command, ...(this.commandOptions.args ?? [])], { cwd: session.snapshot.cwd, env, terminal })
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") throw new PtyAgentBackendError("PTY_AGENT_FAILED", "agent command was not found")
        throw error
      }
      const attachedTerminal = child.terminal
      if (attachedTerminal === undefined) throw new PtyAgentBackendError("PTY_AGENT_FAILED", "PTY was not attached")
      terminal = attachedTerminal
      session.active = { process: child, terminal }

      let timedOut = false
      let cancelled = false
      const timer = setTimeout(() => {
        timedOut = true
        if (child !== undefined) void terminateProcessTree(child)
      }, this.options.timeoutMs)
      const abort = (): void => {
        cancelled = true
        session.cancelled = "cancelled"
        if (child !== undefined) void terminateProcessTree(child)
      }
      input.signal?.addEventListener("abort", abort, { once: true })
      const processExit = child.exited.then((status) => {
        channel.close()
        return status
      })
      try {
        if (input.signal?.aborted === true) abort()
        if (!cancelled) terminal.write(`${JSON.stringify({ type: "prompt", sessionId: input.sessionId, message: input.message })}\n`)
        const stream = decodeHarnessJsonl(printed.tap(channel), {
          sessionId: input.sessionId,
          maxLineBytes: this.options.maxLineBytes,
          maxEvents: this.options.maxEvents,
          maxStreamBytes: this.options.maxStreamBytes,
        })
        for await (const event of stream) {
          session.snapshot = eventSnapshot(event, session.snapshot)
          if (isTerminalEvent(event)) terminal.close()
          yield event
        }
        const status = await processExit
        if (timedOut) throw new PtyAgentBackendError("PTY_AGENT_TIMEOUT", "agent PTY timed out")
        if (cancelled || input.signal?.aborted === true || session.cancelled !== undefined) {
          if (!hasStopped(session.snapshot)) {
            const stopped = makeStoppedEvent(session, session.cancelled ?? "cancelled")
            session.snapshot = eventSnapshot(stopped, session.snapshot)
            yield stopped
          }
          return
        }
        if (status !== 0) throw new PtyAgentBackendError("PTY_AGENT_FAILED", exitReason("agent PTY", status, words()))
        if (!hasTerminal(session.snapshot)) throw new PtyAgentBackendError("PTY_AGENT_OUTPUT_INVALID", withWords("agent PTY has no terminal event", words()))
      } catch (error) {
        if (timedOut) throw new PtyAgentBackendError("PTY_AGENT_TIMEOUT", "agent PTY timed out")
        if (cancelled || input.signal?.aborted === true || session.cancelled !== undefined) {
          if (!hasStopped(session.snapshot)) {
            const stopped = makeStoppedEvent(session, session.cancelled ?? "cancelled")
            session.snapshot = eventSnapshot(stopped, session.snapshot)
            yield stopped
          }
          return
        }
        if (error instanceof HarnessJsonlError) throw mapJsonlError(error, words())
        throw error
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", abort)
      }
    } catch (error) {
      if (error instanceof PtyAgentBackendError) throw error
      throw new PtyAgentBackendError("PTY_AGENT_FAILED", "agent PTY could not start")
    } finally {
      channel.close()
      if (child !== undefined) await terminateProcessTree(child)
      terminal?.close()
      session.active = undefined
      session.running = false
    }
  }

  private requireSession(id: string): PtySession {
    if (!validId(id)) throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent session id is invalid")
    const session = this.sessions.get(id)
    if (session === undefined) throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent session is unknown")
    return session
  }

  private async commandEnvironment(): Promise<Record<string, string>> {
    try {
      return await resolveHarnessEnvironment(this.commandOptions.env, this.auth)
    } catch (error) {
      if (error instanceof HarnessAuthError) throw new PtyAgentBackendError("PTY_AGENT_CREDENTIALS_UNAVAILABLE", "harness credentials are unavailable")
      throw error
    }
  }
}

export function createPtyAgentBackend(options: PtyAgentBackendOptions): PtyAgentBackend {
  return new PtyAgentBackend(options)
}

export function createPtyAgentAdapter(options: PtyAgentBackendOptions): RunrailBackendAdapter {
  validateOptions(options)
  return {
    name: options.name ?? "pty-agent",
    version: options.version ?? RUNRAIL_VERSION,
    capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming", "pty"])]),
    create: () => createPtyAgentBackend(options),
  }
}

class ByteChannel implements AsyncIterable<Uint8Array>, AsyncIterator<Uint8Array> {
  private readonly queue: Uint8Array[] = []
  private readonly waiters: ChannelWaiter[] = []
  private queuedBytes = 0
  private closed = false
  private failure: unknown

  constructor(private readonly maxBytes: number, private readonly onLimit: () => void) {}

  push(data: Uint8Array): void {
    if (this.closed) return
    if (data.byteLength === 0) return
    if (this.queuedBytes + data.byteLength > this.maxBytes) {
      this.failure = new PtyAgentBackendError("PTY_AGENT_OUTPUT_INVALID", "agent PTY output exceeded its byte limit")
      this.closed = true
      this.onLimit()
      this.rejectWaiters(this.failure)
      return
    }
    const copy = new Uint8Array(data)
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ done: false, value: copy })
    else {
      this.queue.push(copy)
      this.queuedBytes += copy.byteLength
    }
  }

  close(error?: unknown): void {
    if (error !== undefined && this.failure === undefined) this.failure = error
    this.closed = true
    if (this.queue.length === 0) {
      if (this.failure !== undefined) this.rejectWaiters(this.failure)
      else this.resolveWaiters()
    }
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.queue.shift()
    if (chunk !== undefined) {
      this.queuedBytes -= chunk.byteLength
      if (this.closed && this.queue.length === 0) {
        if (this.failure !== undefined) throw this.failure
        this.resolveWaiters()
      }
      return { done: false, value: chunk }
    }
    if (this.failure !== undefined) throw this.failure
    if (this.closed) return { done: true, value: undefined }
    return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  private rejectWaiters(error: unknown): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }
}

function validateOptions(options: PtyAgentBackendOptions): void {
  if (options === null || typeof options !== "object" || typeof options.command !== "string" || options.command.length === 0 || options.command.length > 256 || /\s/.test(options.command) || options.command.startsWith("-"))
    throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent command is invalid")
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.length > 128 || options.args.some((arg) => typeof arg !== "string" || arg.length > 4_096)))
    throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent arguments are invalid")
  if (options.name !== undefined && !validId(options.name)) throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent backend name is invalid")
  if (options.version !== undefined && (typeof options.version !== "string" || options.version.length === 0 || options.version.length > 64))
    throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent backend version is invalid")
  const capabilities = options.capabilities ?? ["sessions", "streaming", "pty"]
  if (!Array.isArray(capabilities) || capabilities.length > 32 || capabilities.some((value) => !validCapability(value)))
    throw new PtyAgentBackendError("PTY_AGENT_INVALID", "agent backend capabilities are invalid")
  validateBound(options.timeoutMs ?? 120_000, 1, 120_000, "timeoutMs")
  validateBound(options.maxLineBytes ?? 256 * 1024, 1, 4 * 1024 * 1024, "maxLineBytes")
  validateBound(options.maxEvents ?? 4_096, 1, 65_536, "maxEvents")
  validateBound(options.maxStreamBytes ?? 8 * 1024 * 1024, 1, 64 * 1024 * 1024, "maxStreamBytes")
  validateDimension(options.cols ?? 120, "cols")
  validateDimension(options.rows ?? 40, "rows")
  if (options.terminalName !== undefined && (typeof options.terminalName !== "string" || options.terminalName.length === 0 || options.terminalName.length > 64 || !/^[A-Za-z0-9._-]+$/.test(options.terminalName)))
    throw new PtyAgentBackendError("PTY_AGENT_INVALID", "terminal name is invalid")
  try {
    parseHarnessAuthOptions(options.auth)
  } catch {
    throw new PtyAgentBackendError("PTY_AGENT_AUTH_INVALID", "harness authentication options are invalid")
  }
}

function validateBound(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new PtyAgentBackendError("PTY_AGENT_INVALID", `${name} is invalid`)
}

function validateDimension(value: number, name: string): void {
  validateBound(value, 1, 4_096, name)
}

function mapJsonlError(error: HarnessJsonlError, words: string | undefined): PtyAgentBackendError {
  if (error.code === "HARNESS_JSONL_LIMIT") return new PtyAgentBackendError("PTY_AGENT_OUTPUT_INVALID", "agent PTY output exceeded its limit")
  return new PtyAgentBackendError("PTY_AGENT_OUTPUT_INVALID", withWords("agent PTY emitted invalid JSONL", words))
}

function withWords(reason: string, words: string | undefined): string {
  return words === undefined ? reason : `${reason}: ${words}`
}

/** The last text a PTY program printed, bounded; read only to say why it failed. */
class PrintedTail {
  text = ""
  private readonly decoder = new TextDecoder()

  async *tap(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      this.text = `${this.text}${this.decoder.decode(chunk, { stream: true })}`.slice(-8 * 1024)
      yield chunk
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function eventSnapshot(event: AgentEvent, previous: AgentSessionSnapshot): AgentSessionSnapshot {
  if (event.type === "session.started" || event.type === "session.updated" || event.type === "session.completed") return event.snapshot
  if (event.type === "session.stopped") return makeSnapshot(previous.id, previous.backend, previous.cwd, "stopped", event.seq, previous.capabilities)
  if (event.type === "session.failed") return makeSnapshot(previous.id, previous.backend, previous.cwd, "failed", event.seq, previous.capabilities)
  if (event.type === "approval.required") return makeSnapshot(previous.id, previous.backend, previous.cwd, "waiting", event.seq, previous.capabilities)
  return makeSnapshot(previous.id, previous.backend, previous.cwd, "running", event.seq, previous.capabilities)
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "session.completed" || event.type === "session.failed" || event.type === "session.stopped"
}

function makeStoppedEvent(session: PtySession, reason: string): AgentEvent {
  return Object.freeze({ version: 1, sessionId: session.snapshot.id, seq: session.snapshot.lastSeq + 1, at: Date.now(), type: "session.stopped", reason: reason.slice(0, 256) })
}

function makeSnapshot(id: string, backend: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq: number, capabilities: readonly string[]): AgentSessionSnapshot {
  return Object.freeze({ version: 1, id, backend, cwd, status, createdAt: 0, updatedAt: Date.now(), lastSeq, capabilities: Object.freeze([...capabilities]) })
}

function hasTerminal(snapshot: AgentSessionSnapshot): boolean {
  return snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "stopped"
}

function hasStopped(snapshot: AgentSessionSnapshot): boolean {
  return snapshot.status === "stopped"
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}
