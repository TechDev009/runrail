import type {
  AgentBackend,
  AgentEvent,
  AgentSessionSnapshot,
  ForkSessionResult,
  SendMessageInput,
} from "@nifrajs/agent-protocol"
import type { HarnessControl } from "./types.ts"
import { isHarnessModelId } from "./launch.ts"

export const HARNESS_CONTROL_VERSION = 1 as const

export type HarnessControlErrorCode =
  | "HARNESS_CONTROL_INVALID"
  | "HARNESS_CONTROL_CLOSED"
  | "HARNESS_CONTROL_BUSY"
  | "HARNESS_CONTROL_UNSUPPORTED"
  | "HARNESS_CONTROL_EVENT_INVALID"
  | "HARNESS_CONTROL_STORE_FAILED"

export class HarnessControlError extends Error {
  constructor(readonly code: HarnessControlErrorCode, reason: string) {
    super(`harness control: ${reason}`)
    this.name = "HarnessControlError"
  }
}

export interface HarnessControlSnapshot {
  readonly version: typeof HARNESS_CONTROL_VERSION
  readonly sessionId: string
  readonly backend: string
  readonly cwd: string
  readonly status: AgentSessionSnapshot["status"]
  readonly lastSeq: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly controls: readonly HarnessControl[]
  readonly capabilities: readonly string[]
  readonly parentSessionId?: string
}

/** Caller-owned metadata store. It must not persist event or credential payloads. */
export interface HarnessControlStore {
  readonly save: (snapshot: HarnessControlSnapshot) => void | PromiseLike<void>
  readonly load?: (sessionId: string) => HarnessControlSnapshot | undefined | PromiseLike<HarnessControlSnapshot | undefined>
}

export interface HarnessControlBackend extends AgentBackend {
  readonly interrupt?: (sessionId: string, reason?: string) => Promise<void>
  readonly resume?: (sessionId: string) => Promise<AgentSessionSnapshot>
  readonly compact?: (sessionId: string, reason?: "manual" | "threshold" | "overflow" | "workflow") => Promise<{ readonly before: number; readonly after: number }>
  readonly setModel?: (sessionId: string, model: string) => Promise<void>
  readonly setThinking?: (sessionId: string, thinking: string) => Promise<void>
  readonly setSandbox?: (sessionId: string, sandbox: string) => Promise<void>
  readonly configureMcp?: (sessionId: string, configuration: unknown) => Promise<void>
}

export interface CreateHarnessControlOptions {
  readonly controls?: readonly HarnessControl[]
  readonly store?: HarnessControlStore
  readonly parentSessionId?: string
  readonly maxEventsPerTurn?: number
}

/**
 * Shared lifecycle facade for external harnesses. It deliberately only calls
 * optional vendor controls when the backend implements them, so a one-shot
 * command adapter cannot accidentally claim persistent-session semantics.
 */
export class HarnessControlSession {
  private readonly controlSet: ReadonlySet<HarnessControl>
  private readonly store?: HarnessControlStore
  private readonly maxEventsPerTurn: number
  private current: HarnessControlSnapshot
  private active = false
  private closed = false

  constructor(readonly backend: HarnessControlBackend, snapshot: AgentSessionSnapshot, options: CreateHarnessControlOptions = {}) {
    this.controlSet = new Set(normalizeControls(options.controls ?? []))
    this.store = options.store
    this.maxEventsPerTurn = options.maxEventsPerTurn ?? 4_096
    if (!Number.isSafeInteger(this.maxEventsPerTurn) || this.maxEventsPerTurn < 1 || this.maxEventsPerTurn > 65_536)
      throw new HarnessControlError("HARNESS_CONTROL_INVALID", "event limit is invalid")
    this.current = makeSnapshot(snapshot, this.controlSet, options.parentSessionId)
  }

  snapshot(): HarnessControlSnapshot {
    return this.current
  }

  /** Read the bounded session metadata without touching the vendor runtime. */
  inspect(): HarnessControlSnapshot {
    this.requireOpen()
    this.requireControl("inspect")
    return this.current
  }

  advertised(control: HarnessControl): boolean {
    return this.controlSet.has(control)
  }

  async send(message: string, signal?: AbortSignal): Promise<readonly AgentEvent[]> {
    this.requireOpen()
    this.requireMessage(message)
    this.requireControl("follow-up")
    if (this.active) throw new HarnessControlError("HARNESS_CONTROL_BUSY", "session already has an active turn")
    this.active = true
    const events: AgentEvent[] = []
    // A turn this side rejects is stopped at the vendor too, not only left unread.
    const turn = new AbortController()
    const forward = (): void => turn.abort(signal?.reason)
    if (signal?.aborted === true) forward()
    else signal?.addEventListener("abort", forward, { once: true })
    try {
      const input: SendMessageInput = { sessionId: this.current.sessionId, message, signal: turn.signal }
      for await (const event of this.backend.send(input)) {
        this.acceptEvent(event)
        events.push(event)
        if (events.length > this.maxEventsPerTurn) throw new HarnessControlError("HARNESS_CONTROL_EVENT_INVALID", "turn exceeded its event limit")
      }
      await this.refresh()
      return Object.freeze(events)
    } catch (error) {
      turn.abort("turn rejected")
      throw error
    } finally {
      signal?.removeEventListener("abort", forward)
      this.active = false
      await this.persist()
    }
  }

  followUp(message: string, signal?: AbortSignal): Promise<readonly AgentEvent[]> {
    return this.send(message, signal)
  }

  /** Continue with a new caller-supplied turn; this never resumes vendor state. */
  continue(message: string, signal?: AbortSignal): Promise<readonly AgentEvent[]> {
    return this.send(message, signal)
  }

  async cancel(reason = "cancelled"): Promise<void> {
    this.requireOpen()
    this.requireControl("cancel")
    const safeReason = boundedReason(reason)
    const active = this.active
    await this.backend.cancel(this.current.sessionId, safeReason)
    // An active send owns delivery of the terminal stop event. Refreshing here
    // would advance the cursor before that event reaches the send consumer.
    if (!active) await this.refresh()
    await this.persist()
  }

  async interrupt(reason = "interrupted"): Promise<void> {
    this.requireOpen()
    this.requireControl("interrupt")
    if (this.backend.interrupt === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement interrupt")
    const active = this.active
    await this.backend.interrupt(this.current.sessionId, boundedReason(reason))
    // As with cancel: an active send delivers the stop event and moves the cursor past it.
    if (!active) await this.refresh()
    await this.persist()
  }

  async approve(approvalId: string, reason?: string): Promise<boolean> {
    return this.resolveApproval(approvalId, true, reason)
  }

  async reject(approvalId: string, reason?: string): Promise<boolean> {
    return this.resolveApproval(approvalId, false, reason)
  }

  async resolveApproval(approvalId: string, approved: boolean, reason?: string): Promise<boolean> {
    this.requireOpen()
    this.requireControl(approved ? "approve" : "reject")
    if (!validIdentifier(approvalId)) throw new HarnessControlError("HARNESS_CONTROL_INVALID", "approval id is invalid")
    if (this.backend.resolveApproval === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement approvals")
    const active = this.active
    const result = await this.backend.resolveApproval(this.current.sessionId, approvalId, approved, reason === undefined ? undefined : boundedReason(reason))
    if (result !== true) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend did not resolve the approval")
    if (!active) await this.refresh()
    await this.persist()
    return true
  }

  async resume(): Promise<HarnessControlSnapshot> {
    this.requireOpen()
    this.requireControl("resume")
    if (this.backend.resume === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement resume")
    const snapshot = await this.backend.resume(this.current.sessionId)
    this.acceptSnapshot(snapshot)
    await this.persist()
    return this.current
  }

  async fork(targetSessionId?: string): Promise<ForkSessionResult> {
    this.requireOpen()
    this.requireControl("fork")
    if (this.active) throw new HarnessControlError("HARNESS_CONTROL_BUSY", "cannot fork during an active turn")
    if (this.backend.fork === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement fork")
    const result = await this.backend.fork({ sessionId: this.current.sessionId, ...(targetSessionId === undefined ? {} : { targetSessionId }) })
    if (!validIdentifier(result.sessionId) || !validIdentifier(result.parentSessionId)) throw new HarnessControlError("HARNESS_CONTROL_EVENT_INVALID", "backend returned an invalid fork result")
    return Object.freeze(result)
  }

  async compact(reason: "manual" | "threshold" | "overflow" | "workflow" = "manual"): Promise<{ readonly before: number; readonly after: number }> {
    this.requireOpen()
    this.requireControl("compact")
    if (this.backend.compact === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement compaction")
    const result = await this.backend.compact(this.current.sessionId, reason)
    if (!Number.isSafeInteger(result.before) || !Number.isSafeInteger(result.after) || result.before < 0 || result.after < 0 || result.after > result.before)
      throw new HarnessControlError("HARNESS_CONTROL_EVENT_INVALID", "backend returned invalid compaction counts")
    await this.refresh()
    await this.persist()
    return Object.freeze({ before: result.before, after: result.after })
  }

  async setModel(model: string): Promise<void> {
    this.requireOpen()
    this.requireControl("model")
    // The launch's own model format: provider/model ids such as OpenCode's have a slash.
    if (!isHarnessModelId(model)) throw new HarnessControlError("HARNESS_CONTROL_INVALID", "model is invalid")
    if (this.backend.setModel === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement model switching")
    await this.backend.setModel(this.current.sessionId, model)
    await this.persist()
  }

  async setThinking(thinking: string): Promise<void> {
    this.requireOpen()
    this.requireControl("thinking")
    if (!validIdentifier(thinking)) throw new HarnessControlError("HARNESS_CONTROL_INVALID", "thinking level is invalid")
    if (this.backend.setThinking === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement thinking controls")
    await this.backend.setThinking(this.current.sessionId, thinking)
    await this.persist()
  }

  async setSandbox(sandbox: string): Promise<void> {
    this.requireOpen()
    this.requireControl("sandbox")
    if (!validIdentifier(sandbox)) throw new HarnessControlError("HARNESS_CONTROL_INVALID", "sandbox is invalid")
    if (this.backend.setSandbox === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement sandbox controls")
    await this.backend.setSandbox(this.current.sessionId, sandbox)
    await this.persist()
  }

  async configureMcp(configuration: unknown): Promise<void> {
    this.requireOpen()
    this.requireControl("mcp")
    if (this.backend.configureMcp === undefined) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", "backend does not implement MCP controls")
    await this.backend.configureMcp(this.current.sessionId, configuration)
    await this.persist()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.backend.close(this.current.sessionId)
    this.current = Object.freeze({ ...this.current, status: "stopped", updatedAt: Date.now() })
    await this.persist()
  }

  private acceptEvent(event: AgentEvent): void {
    if (event.sessionId !== this.current.sessionId || !Number.isSafeInteger(event.seq) || event.seq <= this.current.lastSeq)
      throw new HarnessControlError("HARNESS_CONTROL_EVENT_INVALID", "backend returned an out-of-order or foreign event")
    this.current = Object.freeze({ ...this.current, status: statusForEvent(event, this.current.status), lastSeq: event.seq, updatedAt: Date.now() })
  }

  private acceptSnapshot(snapshot: AgentSessionSnapshot): void {
    if (snapshot.id !== this.current.sessionId || snapshot.backend !== this.current.backend || snapshot.cwd !== this.current.cwd || snapshot.lastSeq < this.current.lastSeq)
      throw new HarnessControlError("HARNESS_CONTROL_EVENT_INVALID", "backend returned an invalid session snapshot")
    this.current = Object.freeze({ ...this.current, status: snapshot.status, lastSeq: snapshot.lastSeq, updatedAt: snapshot.updatedAt })
  }

  private async refresh(): Promise<void> {
    try {
      this.acceptSnapshot(await this.backend.snapshot(this.current.sessionId))
    } catch (error) {
      if (error instanceof HarnessControlError) throw error
      throw new HarnessControlError("HARNESS_CONTROL_EVENT_INVALID", "backend session snapshot is invalid")
    }
  }

  private async persist(): Promise<void> {
    if (this.store === undefined) return
    try {
      await this.store.save(this.current)
    } catch {
      throw new HarnessControlError("HARNESS_CONTROL_STORE_FAILED", "caller-owned session metadata could not be saved")
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new HarnessControlError("HARNESS_CONTROL_CLOSED", "session is closed")
  }

  private requireControl(control: HarnessControl): void {
    if (!this.controlSet.has(control)) throw new HarnessControlError("HARNESS_CONTROL_UNSUPPORTED", `control '${control}' is not advertised`)
  }

  private requireMessage(message: string): void {
    if (typeof message !== "string" || message.length === 0 || message.length > 256 * 1024 || message.includes("\0")) throw new HarnessControlError("HARNESS_CONTROL_INVALID", "message is invalid")
  }
}

export async function createHarnessControlSession(backend: HarnessControlBackend, input: { readonly cwd: string; readonly sessionId?: string; readonly capabilities?: readonly string[] }, options: CreateHarnessControlOptions = {}): Promise<HarnessControlSession> {
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096) throw new HarnessControlError("HARNESS_CONTROL_INVALID", "session cwd is invalid")
  const snapshot = await backend.createSession(input)
  return new HarnessControlSession(backend, snapshot, options)
}

function makeSnapshot(snapshot: AgentSessionSnapshot, controls: ReadonlySet<HarnessControl>, parentSessionId?: string): HarnessControlSnapshot {
  return Object.freeze({ version: HARNESS_CONTROL_VERSION, sessionId: snapshot.id, backend: snapshot.backend, cwd: snapshot.cwd, status: snapshot.status, lastSeq: snapshot.lastSeq, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt, controls: Object.freeze([...controls].sort()), capabilities: Object.freeze([...snapshot.capabilities].sort()), ...(parentSessionId === undefined ? {} : { parentSessionId }) })
}

function statusForEvent(event: AgentEvent, previous: AgentSessionSnapshot["status"]): AgentSessionSnapshot["status"] {
  if (event.type === "session.started" || event.type === "session.updated") return event.snapshot.status
  if (event.type === "session.completed") return "completed"
  if (event.type === "session.failed") return "failed"
  if (event.type === "session.stopped") return "stopped"
  if (event.type === "approval.required") return "waiting"
  return previous === "idle" ? "running" : previous
}

function normalizeControls(values: readonly HarnessControl[]): readonly HarnessControl[] {
  const valid = new Set<HarnessControl>(["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "fork", "compact", "model", "thinking", "sandbox", "mcp", "inspect", "close"])
  if (!Array.isArray(values) || values.length > 32 || values.some((value) => !valid.has(value))) throw new HarnessControlError("HARNESS_CONTROL_INVALID", "controls are invalid")
  return Object.freeze([...new Set(values)].sort())
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function boundedReason(value: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0") ? value : "cancelled"
}
