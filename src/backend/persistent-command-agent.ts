import { isAgentEvent, type AgentBackend, type AgentBackendInfo, type AgentEvent, type AgentSessionSnapshot, type CreateSessionInput, type ForkSessionInput, type ForkSessionResult, type ReloadResult, type SendMessageInput } from "@nifrajs/agent-protocol"
import { RUNRAIL_VERSION } from "../version.ts"
import { HarnessAuthError, parseHarnessAuthOptions, resolveHarnessEnvironment } from "../harness/auth.ts"
import { mappedEvents, type HarnessAuthOptions, type HarnessEventMapper, type HarnessEventMappingContext, type HarnessMetadataSink } from "../harness/types.ts"
import type { RunrailLiveSink } from "../live/types.ts"
import { credentialValues, exitReason, failureWords } from "../harness/failure-words.ts"
import { CommandAgentBackendError, UNANSWERABLE, type CommandAgentBackendErrorCode } from "./command-agent.ts"
import { terminateProcessTree } from "./process-tree.ts"

export interface PersistentCommandAgentBackendOptions {
  readonly name?: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly auth?: HarnessAuthOptions
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly maxEvents?: number
  readonly eventMapper?: HarnessEventMapper
  readonly onMetadata?: HarnessMetadataSink
  readonly onLive?: RunrailLiveSink
  /**
   * Explicit caller-owned control authority for a compatible persistent
   * protocol. No control is inferred from the presence of a long-lived
   * process; only supplied handlers are callable.
   */
  readonly controlHandlers?: PersistentCommandAgentControlHandlers
}

export interface PersistentCommandAgentControlHandlers {
  readonly interrupt?: (sessionId: string, reason?: string) => Promise<void>
  readonly resume?: (sessionId: string) => Promise<AgentSessionSnapshot>
  readonly fork?: (input: ForkSessionInput) => Promise<ForkSessionResult>
  readonly compact?: (sessionId: string, reason?: "manual" | "threshold" | "overflow" | "workflow") => Promise<{ readonly before: number; readonly after: number }>
  readonly setModel?: (sessionId: string, model: string) => Promise<void>
  readonly setThinking?: (sessionId: string, thinking: string) => Promise<void>
  readonly setSandbox?: (sessionId: string, sandbox: string) => Promise<void>
  readonly configureMcp?: (sessionId: string, configuration: unknown) => Promise<void>
  readonly resolveApproval?: (sessionId: string, approvalId: string, approved: boolean, reason?: string) => Promise<boolean | undefined>
}

interface PersistentTurn {
  readonly requestId: string
  readonly turnId: string
  readonly queue: EventQueue
  readonly controller: AbortController
  eventCount: number
  outputBytes: number
  timer?: ReturnType<typeof setTimeout>
  cancelled?: string
  cleanup?: () => void
}

/**
 * Long-lived normalized JSONL process backend. It permits one active turn at a
 * time and keeps the process alive between turns; cancellation tears down the
 * process because a killed vendor process cannot safely be resumed.
 */
export class PersistentCommandAgentBackend implements AgentBackend {
  readonly info: AgentBackendInfo
  private readonly options: Required<Pick<PersistentCommandAgentBackendOptions, "timeoutMs" | "maxOutputBytes" | "maxEvents">>
  private readonly commandOptions: PersistentCommandAgentBackendOptions
  private readonly auth: HarnessAuthOptions
  private readonly sessions = new Map<string, AgentSessionSnapshot>()
  private sequence = 0
  private turnSequence = 0
  private child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  private active: PersistentTurn | undefined
  private sessionId: string | undefined
  private vendorSessionId: string | undefined
  private lastSeq = -1
  /** Credential values the running process was given, kept out of the words its failures show. */
  private secrets: readonly string[] = []
  private closed = false
  private starting = false
  private startupCancellation: string | undefined

  constructor(options: PersistentCommandAgentBackendOptions) {
    validateOptions(options)
    try {
      this.auth = parseHarnessAuthOptions(options.auth)
    } catch {
      throw new CommandAgentBackendError("COMMAND_AGENT_AUTH_INVALID", "harness authentication options are invalid")
    }
    this.commandOptions = options
    this.options = { timeoutMs: options.timeoutMs ?? 120_000, maxOutputBytes: options.maxOutputBytes ?? 8 * 1024 * 1024, maxEvents: options.maxEvents ?? 4_096 }
    this.info = Object.freeze({ name: options.name ?? "persistent-command-agent", version: options.version ?? RUNRAIL_VERSION, capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming", "persistent"])] .sort()) })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (this.closed) throw error("COMMAND_AGENT_INVALID", "backend is closed")
    if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096) throw error("COMMAND_AGENT_INVALID", "session cwd is invalid")
    const id = input.sessionId ?? `${this.info.name}-${++this.sequence}`
    if (!validId(id) || this.sessions.has(id)) throw error("COMMAND_AGENT_INVALID", "session id is invalid or already exists")
    if (this.sessionId !== undefined) throw error("COMMAND_AGENT_INVALID", "persistent backend supports one session")
    const snapshot = makeSnapshot(id, this.info.name, input.cwd, "idle", -1, this.info.capabilities)
    this.sessions.set(id, snapshot)
    this.sessionId = id
    this.lastSeq = -1
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    return this.run(input)
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    const active = this.active
    if (active === undefined) {
      if (this.starting) { this.startupCancellation = boundedReason(reason); await this.stopProcess() }
      return
    }
    active.cancelled = boundedReason(reason)
    await this.stopProcess()
    const stopped = this.makeEvent("session.stopped", { reason: active.cancelled })
    this.updateSnapshot(stopped)
    active.queue.push(stopped)
    this.finishActive()
    this.sessions.set(sessionId, this.currentSnapshot(sessionId))
  }

  async interrupt(sessionId: string, reason = "interrupted"): Promise<void> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.interrupt
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide interrupt control")
    await handler(session.id, boundedReason(reason))
  }

  async resume(sessionId: string): Promise<AgentSessionSnapshot> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.resume
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide resume control")
    const snapshot = await handler(session.id)
    return snapshot
  }

  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    const session = this.requireSession(input.sessionId)
    const handler = this.commandOptions.controlHandlers?.fork
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide fork control")
    return handler({ ...input, sessionId: session.id })
  }

  async compact(sessionId: string, reason: "manual" | "threshold" | "overflow" | "workflow" = "manual"): Promise<{ readonly before: number; readonly after: number }> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.compact
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide compaction control")
    return handler(session.id, reason)
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.setModel
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide model control")
    await handler(session.id, model)
  }

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.setThinking
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide thinking control")
    await handler(session.id, thinking)
  }

  async setSandbox(sessionId: string, sandbox: string): Promise<void> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.setSandbox
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide sandbox control")
    await handler(session.id, sandbox)
  }

  async configureMcp(sessionId: string, configuration: unknown): Promise<void> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.configureMcp
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide MCP control")
    await handler(session.id, configuration)
  }

  async resolveApproval(sessionId: string, approvalId: string, approved: boolean, reason?: string): Promise<boolean | undefined> {
    const session = this.requireSession(sessionId)
    const handler = this.commandOptions.controlHandlers?.resolveApproval
    if (handler === undefined) throw error("COMMAND_AGENT_UNSUPPORTED", "persistent harness does not provide approval control")
    return handler(session.id, approvalId, approved, reason === undefined ? undefined : boundedReason(reason))
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId)
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    this.requireSession(sessionId)
    if (this.active !== undefined || this.starting) throw error("COMMAND_AGENT_INVALID", "cannot reload while an agent turn is active")
    await this.stopProcess()
    return Object.freeze({ revision: `${this.info.version}:reload`, loaded: Object.freeze([]), disabled: Object.freeze([]), rolledBack: false })
  }

  async close(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    this.closed = true
    await this.stopProcess()
    this.finishActive()
    this.sessions.delete(sessionId)
    this.sessionId = undefined
    this.closed = true
  }

  private async *run(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 256 * 1024 || input.message.includes("\0")) throw error("COMMAND_AGENT_INVALID", "agent message is invalid")
    const session = this.requireSession(input.sessionId)
    if (this.active !== undefined) throw error("COMMAND_AGENT_INVALID", "agent session is already running")
    let turn: PersistentTurn
    try {
      turn = await this.startTurn(session, input.message, input.signal)
    } catch (caught) {
      if (caught instanceof CommandAgentBackendError && caught.code === "COMMAND_AGENT_CANCELLED") {
        if (this.sessions.has(session.id)) {
          const stopped = this.makeEvent("session.stopped", { reason: this.startupCancellation ?? "cancelled" })
          this.updateSnapshot(stopped)
          yield stopped
        }
        return
      }
      throw caught
    }
    try {
      for await (const event of turn.queue) yield event
    } finally {
      if (this.active === turn) await this.cancel(input.sessionId, input.signal?.aborted ? "cancelled" : "consumer closed")
    }
  }

  private async startTurn(session: AgentSessionSnapshot, message: string, signal?: AbortSignal): Promise<PersistentTurn> {
    if (this.active !== undefined || this.starting) throw error("COMMAND_AGENT_INVALID", "agent session is already running")
    this.starting = true
    this.startupCancellation = undefined
    try {
      if (signal?.aborted) throw error("COMMAND_AGENT_CANCELLED", "startup cancelled")
      await this.ensureProcess(session, signal)
      if (this.closed || this.startupCancellation !== undefined || signal?.aborted) throw error("COMMAND_AGENT_CANCELLED", "startup cancelled")
    } finally {
      this.starting = false
    }
    const requestId = `runrail-request-${++this.turnSequence}`
    const turnId = `runrail-turn-${this.turnSequence}`
    const queue = new EventQueue()
    const controller = new AbortController()
    const turn: PersistentTurn = { requestId, turnId, queue, controller, eventCount: 0, outputBytes: 0 }
    this.active = turn
    this.updateSessionStatus(session.id, "running")
    turn.timer = setTimeout(() => {
      turn.cancelled = "timeout"
      void this.stopProcess().then(() => {
        const event = this.makeEvent("session.stopped", { reason: "timeout" })
        this.updateSnapshot(event)
        queue.push(event)
        this.finishActive()
      })
    }, this.options.timeoutMs)
    const abort = (): void => { controller.abort(); void this.cancel(session.id, "cancelled") }
    turn.cleanup = () => signal?.removeEventListener("abort", abort)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return turn }
    try {
      await this.child?.stdin.write(`${JSON.stringify({ type: "prompt", sessionId: session.id, requestId, turnId, message })}\n`)
    } catch {
      turn.cleanup()
      this.finishActive()
      throw error("COMMAND_AGENT_FAILED", "agent prompt could not be written")
    }
    return turn
  }

  private async ensureProcess(session: AgentSessionSnapshot, signal?: AbortSignal): Promise<void> {
    if (this.child !== undefined) return
    this.vendorSessionId = undefined
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">
    try {
      const env = await this.commandEnvironment()
      if (this.closed || this.startupCancellation !== undefined || signal?.aborted) throw error("COMMAND_AGENT_CANCELLED", "startup cancelled")
      this.secrets = credentialValues(env, this.auth.credentialEnvironment)
      child = Bun.spawn([this.commandOptions.command, ...(this.commandOptions.args ?? [])], { cwd: session.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true, env })
    } catch (caught) {
      if (caught instanceof CommandAgentBackendError) throw caught
      if (isMissingCommand(caught)) throw error("COMMAND_AGENT_NOT_FOUND", "agent command was not found")
      throw error("COMMAND_AGENT_FAILED", "agent command could not start")
    }
    this.child = child
    void this.readOutput(child)
  }

  private async readOutput(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    let stderr = ""
    const stderrPromise = collectStderrFully(child.stderr).then((value) => { stderr = value })
    const decoder = new TextDecoder()
    let buffer = ""
    let idleBytes = 0
    try {
      for await (const chunk of child.stdout) {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
        // The limit is per turn: a process kept between turns is not ended by what earlier turns printed.
        const bytes = Buffer.byteLength(text, "utf8")
        const counted = this.active === undefined ? (idleBytes += bytes) : (this.active.outputBytes += bytes)
        if (counted > this.options.maxOutputBytes || buffer.length > this.options.maxOutputBytes) throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent output exceeded its byte limit")
        buffer += text
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          if (line.trim().length > 0 && !this.replaced(child)) this.acceptLine(line)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim().length > 0 && !this.replaced(child)) this.acceptLine(buffer.trim())
      const status = await child.exited
      await stderrPromise
      if (!this.replaced(child) && this.active !== undefined && this.active.cancelled === undefined) {
        const auth = status !== 0 && looksLikeAuthFailure(stderr)
        const words = auth ? undefined : failureWords(stderr, this.secrets)
        this.failActive(auth ? "COMMAND_AGENT_AUTH_FAILED" : "COMMAND_AGENT_FAILED", status === 0 && words === undefined ? "persistent agent exited before a terminal event" : exitReason("persistent agent", status, words))
      }
    } catch (caught) {
      if (this.replaced(child)) return
      if (this.active !== undefined && this.active.cancelled === undefined) this.failActive(caught instanceof CommandAgentBackendError ? caught.code : "COMMAND_AGENT_OUTPUT_INVALID", caught instanceof Error ? caught.message : "persistent agent output is invalid")
      void this.stopProcess()
    } finally {
      if (this.child === child) {
        this.child = undefined
        this.vendorSessionId = undefined
      }
    }
  }

  private acceptLine(line: string): void {
    let value: unknown
    try { value = JSON.parse(line) as unknown } catch { throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent output is not valid JSONL") }
    const session = this.requireSession(this.sessionId ?? "")
    const active = this.active
    if (active === undefined) throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent output arrived without an active turn")
    validateRequestCorrelation(value, active.requestId)
    const context: HarnessEventMappingContext = { sessionId: session.id, cwd: session.cwd, backend: this.info.name, nextSeq: this.lastSeq + 1, previous: session, requestId: active.requestId, turnId: active.turnId, ...(this.vendorSessionId === undefined ? {} : { vendorSessionId: this.vendorSessionId }), ...(this.commandOptions.onMetadata === undefined ? {} : { onMetadata: this.commandOptions.onMetadata }), ...(this.commandOptions.onLive === undefined ? {} : { onLive: this.commandOptions.onLive }) }
    const mapper = this.commandOptions.eventMapper
    let events: readonly AgentEvent[]
    if (mapper === undefined) {
      if (!isAgentEvent(value)) throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent output event is invalid")
      events = [value]
    } else events = mappedEvents(mapper(value, context))
    this.vendorSessionId = context.vendorSessionId
    for (const event of events) {
      if (this.active !== active) return
      if (event.sessionId !== session.id) throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent output session does not match")
      const normalized = normalizeEvent(event, this.lastSeq + 1, session)
      active.eventCount += 1
      if (active.eventCount > this.options.maxEvents) throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent emitted too many events")
      this.lastSeq = normalized.seq
      this.updateSnapshot(normalized)
      active.queue.push(normalized)
      // Without an approval handler nothing reaches the process, so the card says so instead of waiting.
      if (normalized.type === "approval.required" && this.commandOptions.controlHandlers?.resolveApproval === undefined) {
        const settled = normalizeEvent({ version: 1, sessionId: session.id, seq: this.lastSeq + 1, at: Date.now(), type: "approval.resolved", turnId: normalized.turnId, approvalId: normalized.approvalId, approved: false, withdrawn: true, reason: UNANSWERABLE } as AgentEvent, this.lastSeq + 1, session)
        this.lastSeq = settled.seq
        this.updateSnapshot(settled)
        active.queue.push(settled)
      }
      if (normalized.type === "session.failed") {
        active.queue.fail(terminalFailure(normalized))
        void this.stopProcess()
        this.finishActive()
      } else if (isTerminal(normalized)) this.finishActive()
    }
  }

  private makeEvent(type: "session.stopped", value: { readonly reason: string }): AgentEvent {
    const session = this.requireSession(this.sessionId ?? "")
    const event = normalizeEvent({ version: 1, sessionId: session.id, seq: this.lastSeq + 1, at: Date.now(), type, reason: value.reason }, this.lastSeq + 1, session)
    this.lastSeq = event.seq
    return event
  }

  private updateSnapshot(event: AgentEvent): void {
    const session = this.sessions.get(event.sessionId)
    if (session === undefined) return
    const status = event.type === "session.completed" ? "completed" : event.type === "session.failed" ? "failed" : event.type === "session.stopped" ? "stopped" : event.type === "approval.required" ? "waiting" : event.type === "session.started" || event.type === "session.updated" ? event.snapshot.status : "running"
    this.sessions.set(event.sessionId, makeSnapshot(session.id, session.backend, session.cwd, status, event.seq, session.capabilities, session.createdAt))
  }

  private updateSessionStatus(sessionId: string, status: AgentSessionSnapshot["status"]): void {
    const session = this.requireSession(sessionId)
    this.sessions.set(sessionId, makeSnapshot(session.id, session.backend, session.cwd, status, session.lastSeq, session.capabilities, session.createdAt))
  }

  private currentSnapshot(sessionId: string): AgentSessionSnapshot { return this.requireSession(sessionId) }

  private finishActive(): void {
    const active = this.active
    if (active === undefined) return
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.cleanup?.()
    active.queue.complete()
    this.active = undefined
  }

  private failActive(code: CommandAgentBackendErrorCode, reason: string): void {
    const active = this.active
    if (active === undefined) return
    const event = this.makeEvent("session.stopped", { reason: code })
    this.updateSnapshot(event)
    active.queue.push(event)
    active.queue.fail(error(code, reason))
    this.finishActive()
  }

  /** A process that was stopped and replaced no longer speaks for the current turn. */
  private replaced(child: Bun.Subprocess<"pipe", "pipe", "pipe">): boolean {
    return this.child !== undefined && this.child !== child
  }

  private async stopProcess(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    await terminateProcessTree(child)
    this.child = undefined
  }

  private requireSession(id: string): AgentSessionSnapshot {
    if (!validId(id)) throw error("COMMAND_AGENT_INVALID", "agent session id is invalid")
    const session = this.sessions.get(id)
    if (session === undefined) throw error("COMMAND_AGENT_INVALID", "agent session is unknown")
    return session
  }

  private async commandEnvironment(): Promise<Record<string, string>> {
    try { return await resolveHarnessEnvironment(this.commandOptions.env, this.auth) }
    catch (caught) { if (caught instanceof HarnessAuthError) throw error("COMMAND_AGENT_CREDENTIALS_UNAVAILABLE", "harness credentials are unavailable"); throw caught }
  }
}

class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly events: AgentEvent[] = []
  private readonly waiters: Array<{ readonly resolve: (result: IteratorResult<AgentEvent>) => void; readonly reject: (error: unknown) => void }> = []
  private done = false
  private failure: unknown

  push(event: AgentEvent): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ done: false, value: event })
    else this.events.push(event)
  }
  complete(): void {
    if (this.done) return
    this.done = true
    this.flush()
  }
  fail(errorValue: unknown): void {
    if (this.done) return
    this.failure = errorValue
    this.done = true
    this.flush()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const result = await this.next()
      if (result.done) return
      yield result.value
    }
  }
  private next(): Promise<IteratorResult<AgentEvent>> {
    if (this.events.length > 0) return Promise.resolve({ done: false, value: this.events.shift() as AgentEvent })
    if (this.done) return this.failure === undefined ? Promise.resolve({ done: true, value: undefined }) : Promise.reject(this.failure)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
  private flush(): void {
    while (this.waiters.length > 0 && this.events.length > 0) this.waiters.shift()?.resolve({ done: false, value: this.events.shift() as AgentEvent })
    if (!this.done || this.events.length > 0) return
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (this.failure === undefined) waiter?.resolve({ done: true, value: undefined })
      else waiter?.reject(this.failure)
    }
  }
}

function normalizeEvent(event: AgentEvent, seq: number, session: AgentSessionSnapshot): AgentEvent {
  if (!Number.isSafeInteger(seq) || seq < 0) throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent event sequence is invalid")
  if (event.type === "session.started" || event.type === "session.updated" || event.type === "session.completed") {
    return Object.freeze({ ...event, version: 1, sessionId: session.id, seq, at: Date.now(), snapshot: Object.freeze({ ...event.snapshot, version: 1, id: session.id, backend: session.backend, cwd: session.cwd, lastSeq: seq, updatedAt: Date.now() }) })
  }
  return Object.freeze({ ...event, version: 1, sessionId: session.id, seq, at: Date.now() })
}
function terminalFailure(event: AgentEvent): CommandAgentBackendError {
  if (event.type === "session.failed" && event.error.code === "HARNESS_RATE_LIMITED") return error("COMMAND_AGENT_RATE_LIMITED", event.error.message)
  const authentication = event.type === "session.failed" && event.error.code === "HARNESS_AUTH_FAILED"
  if (authentication) return error("COMMAND_AGENT_AUTH_FAILED", "harness authentication failed")
  return error("COMMAND_AGENT_FAILED", event.type === "session.failed" ? event.error.message : "harness reported a failure")
}
function isTerminal(event: AgentEvent): boolean { return event.type === "session.completed" || event.type === "session.failed" || event.type === "session.stopped" }
function makeSnapshot(id: string, backend: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq: number, capabilities: readonly string[], createdAt = Date.now()): AgentSessionSnapshot { return Object.freeze({ version: 1, id, backend, cwd, status, createdAt, updatedAt: Date.now(), lastSeq, capabilities: Object.freeze([...capabilities]) }) }
function validateOptions(options: PersistentCommandAgentBackendOptions): void {
  if (options === null || typeof options !== "object" || typeof options.command !== "string" || options.command.length === 0 || options.command.length > 256 || /\s/.test(options.command) || options.command.startsWith("-")) throw error("COMMAND_AGENT_INVALID", "agent command is invalid")
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.length > 128 || options.args.some((arg) => typeof arg !== "string" || arg.length > 4_096))) throw error("COMMAND_AGENT_INVALID", "agent arguments are invalid")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000)) throw error("COMMAND_AGENT_INVALID", "agent timeout is invalid")
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 64 * 1024 * 1024)) throw error("COMMAND_AGENT_INVALID", "agent output limit is invalid")
  if (options.maxEvents !== undefined && (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 65_536)) throw error("COMMAND_AGENT_INVALID", "agent event limit is invalid")
  if (options.onMetadata !== undefined && typeof options.onMetadata !== "function") throw error("COMMAND_AGENT_INVALID", "agent metadata sink is invalid")
  if (options.onLive !== undefined && typeof options.onLive !== "function") throw error("COMMAND_AGENT_INVALID", "agent live sink is invalid")
  if (options.controlHandlers !== undefined && (options.controlHandlers === null || typeof options.controlHandlers !== "object" || Array.isArray(options.controlHandlers) || Object.values(options.controlHandlers).some((handler) => handler !== undefined && typeof handler !== "function"))) throw error("COMMAND_AGENT_INVALID", "persistent control handlers are invalid")
}
function error(code: CommandAgentBackendErrorCode, reason: string): CommandAgentBackendError { return new CommandAgentBackendError(code, reason) }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value) }
function boundedReason(value: string): string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0") ? value : "cancelled" }
function isMissingCommand(value: unknown): boolean { return value !== null && typeof value === "object" && "code" in value && (value as { code?: unknown }).code === "ENOENT" }
function validateRequestCorrelation(value: unknown, requestId: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  const echoed = record.requestId ?? record.request_id
  if (echoed !== undefined && echoed !== requestId) throw error("COMMAND_AGENT_OUTPUT_INVALID", "agent output request does not match")
}
async function collectStderrFully(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return ""
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    for await (const chunk of stream) {
      if (bytes >= 16 * 1024) continue
      const decoded = decoder.decode(chunk, { stream: true })
      const remaining = 16 * 1024 - bytes
      text += decoded.slice(0, remaining)
      bytes = Buffer.byteLength(text, "utf8")
    }
    if (bytes < 16 * 1024) text += decoder.decode()
    return text.slice(0, 16 * 1024)
  } catch {
    // Stderr is diagnostic-only and may contain credentials; the exit status remains authoritative.
    return ""
  }
}

function looksLikeAuthFailure(stderr: string): boolean { return /not\s+(?:logged\s+in|authenticated)|authentication\s+(?:failed|required)|unauthori[sz]ed|login\s+required|sign\s+in|api\s+key|credential|subscription\s+(?:required|expired|inactive)|oauth\s+session\s+expired|session\s+expired|could\s+not\s+be\s+refreshed/i.test(stderr) }
