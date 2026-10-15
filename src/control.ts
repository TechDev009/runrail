import type { AgentBackend, AgentBackendInfo, AgentEvent } from "@nifrajs/agent-protocol"
import { createDefaultBackendRegistry } from "./backend/defaults.ts"
import type { ModelDescriptor, ModelSelection } from "./model/catalog.ts"
import { createRunrailSession, RunrailSession, type ApprovalScope, type RunrailCompaction, type RunrailCompactionReason, type RunrailSessionOptions } from "./session.ts"
import type { ApprovalAnswers, FollowUp } from "./harness/questions.ts"
import { MAX_PROMPT_CHARS, type RunrailPromptInput } from "./context/resources.ts"
import type { ProviderModelOptions } from "./providers/types.ts"
import type { HarnessAccountOptions } from "./harness/account.ts"
import { ConnectionSettingsError } from "./accounts/connection-settings.ts"
import { join } from "node:path"
import type { CheckpointRestore, TurnCheckpoint, TurnCheckpoints, VendorMark } from "./checkpoints/turns.ts"
import type { TranscriptStore } from "./transcript/index.ts"
import { SESSION_REWOUND } from "./conversation/index.ts"
import { forgetVendorSessions } from "./harness/vendor-session-store.ts"

export type RunrailControlInput = string | RunrailPromptInput

export interface RunrailControlSnapshot {
  readonly sessionId: string
  readonly backend: string
  readonly active: boolean
  readonly queued: number
  readonly model?: ModelDescriptor
  /** The tool connection the backend runs as, when one was named. */
  readonly connectionId?: string
  /** The transcript could not be read, so the model has none of the thread's earlier messages. */
  readonly historyUnavailable?: true
}

export type RunrailControlListener = (event: AgentEvent) => void

export interface RunrailSkillStatus {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly scope: string
  readonly enabled: boolean
}

const MAX_LIVE_EVENTS = 8_192

/** A turn by its message's transcript seq, or by its turn id when this session ran it. */
export type RunrailRewindTarget = { readonly turnId: string } | { readonly userSeq: number }

/** What a rewind did: transcript records removed, and each file put back or not. */
export interface RunrailRewindResult {
  readonly removed: number
  readonly restored: readonly string[]
  readonly failed: readonly { readonly path: string; readonly reason: string }[]
}

export class RunrailControlError extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason)
    this.name = "RunrailControlError"
  }
}

interface TurnJob {
  readonly input: RunrailControlInput
  readonly signal?: AbortSignal
  readonly events: AgentEvent[]
  readonly resolve: (events: readonly AgentEvent[]) => void
  readonly reject: (error: unknown) => void
}

/** The tool connection a coding-tool backend runs as: its own folder or key, and its chosen models. */
export interface RunrailToolConnectionRoute {
  readonly connectionId?: string
  readonly account?: HarnessAccountOptions
  /** The connection's chosen models, the first being its default. Absent: every model the tool offers. */
  readonly models?: readonly string[]
}

/** API-side queue, steering, and backend/model switching facade over one bounded session. */
export class RunrailSessionController {
  session: RunrailSession
  private sessionOptions?: RunrailSessionOptions
  private currentBackendName: string
  private chosenModel: { readonly backend: string; readonly selection: ModelSelection } | undefined
  private toolRoute?: RunrailToolConnectionRoute
  private readonly queue: TurnJob[] = []
  private readonly listeners = new Set<RunrailControlListener>()
  private readonly eventLog: AgentEvent[] = []
  private readonly idleWaiters = new Set<() => void>()
  private activeController: AbortController | undefined
  private activeJob: TurnJob | undefined
  private draining = false
  private closed = false
  private switching = false

  /** `route` names the tool connection the starting backend runs as; its account defaults to the session's. */
  constructor(session: RunrailSession, sessionOptions?: RunrailSessionOptions, route?: RunrailToolConnectionRoute) {
    this.session = session
    this.sessionOptions = sessionOptions
    this.currentBackendName = sessionOptions?.backend ?? session.backend.info.name
    const account = route?.account ?? sessionOptions?.harnessAccount
    if (route !== undefined || account !== undefined) this.toolRoute = Object.freeze({ ...route, ...(account === undefined ? {} : { account }) })
  }

  static async create(options: RunrailSessionOptions, route?: RunrailToolConnectionRoute): Promise<RunrailSessionController> {
    // The controller is the surface that resolves approvals, so they wait for it.
    const interactive = { ...options, pendingApprovals: options.pendingApprovals ?? true }
    return new RunrailSessionController(await createRunrailSession(interactive), interactive, route)
  }

  snapshot(): RunrailControlSnapshot {
    return Object.freeze({
      sessionId: this.session.snapshot.id,
      backend: this.currentBackendName,
      active: this.activeController !== undefined,
      queued: this.queue.length,
      ...(this.session.model === undefined ? {} : { model: this.session.model }),
      ...(this.toolRoute?.connectionId === undefined ? {} : { connectionId: this.toolRoute.connectionId }),
      ...(this.session.historyUnavailable ? { historyUnavailable: true as const } : {}),
    })
  }

  subscribe(listener: RunrailControlListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Return a bounded replay window for a desktop or RPC consumer reconnecting after a cursor. */
  eventsSince(afterSeq = -1, maxEvents = 512): readonly AgentEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1)
      throw new RangeError("runrail control: event cursor is invalid")
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_LIVE_EVENTS)
      throw new RangeError("runrail control: event limit is invalid")
    const first = this.eventLog[0]
    if (first !== undefined && afterSeq < first.seq - 1)
      throw new RunrailControlError("CONTROL_CURSOR_EXPIRED", "event cursor has expired")
    return Object.freeze(this.eventLog.filter((event) => event.seq > afterSeq).slice(0, maxEvents))
  }

  /** Reset the replay window when a control operation replaces the underlying session. */
  resetEventLog(): void {
    this.eventLog.splice(0)
  }

  /** A `signal` that aborts takes the turn out of the queue, or cancels it once it runs. */
  enqueue(input: RunrailControlInput, signal?: AbortSignal): Promise<readonly AgentEvent[]> {
    if (this.closed) return Promise.reject(new Error("runrail control: controller is closed"))
    if (this.switching) return Promise.reject(new Error("runrail control: the session is being replaced"))
    if (typeof input === "string" && (input.length === 0 || input.length > MAX_PROMPT_CHARS))
      return Promise.reject(new Error("runrail control: message is invalid"))
    return this.queueTurn(input, "back", signal)
  }

  /**
   * Guidance for the running turn. Where the turn can take it (a connected model, Claude Code while
   * one of its tools runs, Codex through its own steer) it joins the turn at the next step and
   * resolves at once with no events. Otherwise (attachments, an invoked skill, no turn running, the
   * tool refusing it) it goes to the front of the queue and runs as the next turn, as before.
   */
  async steer(input: RunrailControlInput, signal?: AbortSignal): Promise<readonly AgentEvent[]> {
    if (this.closed) throw new Error("runrail control: controller is closed")
    if (signal?.aborted === true) throw new Error("runrail control: the turn was cancelled")
    if (await this.joinRunningTurn(input)) return Object.freeze([])
    return await this.queueTurn(input, "front", signal)
  }

  private queueTurn(input: RunrailControlInput, at: "front" | "back", signal: AbortSignal | undefined): Promise<readonly AgentEvent[]> {
    if (signal?.aborted === true) return Promise.reject(new Error("runrail control: the turn was cancelled"))
    return new Promise<readonly AgentEvent[]>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(job)
        if (index >= 0) {
          this.queue.splice(index, 1)
          job.reject(new Error("runrail control: the turn was cancelled"))
          this.resolveIdleIfReady()
        } else if (this.activeJob === job) {
          this.activeController?.abort(signal?.reason ?? "cancelled")
        }
      }
      const job: TurnJob = {
        input,
        ...(signal === undefined ? {} : { signal }),
        events: [],
        resolve: (events) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(events)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (at === "front") this.queue.unshift(job)
      else this.queue.push(job)
      void this.drain()
    })
  }

  /** Guidance for the running turn only: true when the turn took it, false with nothing queued when it could not. */
  async steerLive(input: RunrailControlInput): Promise<boolean> {
    if (this.closed) throw new Error("runrail control: controller is closed")
    return await this.joinRunningTurn(input)
  }

  private async joinRunningTurn(input: RunrailControlInput): Promise<boolean> {
    const plain = typeof input === "string" ? input : input.attachments === undefined && input.parts === undefined && input.skills === undefined ? input.text : undefined
    // A skill is expanded only when a turn is prepared, which steering text skips.
    const text = plain?.startsWith("/skill:") === true ? undefined : plain
    if (text === undefined || this.activeController === undefined) return false
    // A session from before steering, or one a caller built by hand, may not take guidance mid-turn.
    if (typeof this.session.steerLive === "function") return await this.session.steerLive(text)
    return typeof this.session.steer === "function" && this.session.steer(text)
  }

  cancel(reason = "cancelled", clearQueued = false): void {
    this.activeController?.abort(reason)
    if (!clearQueued) return
    const queued = this.queue.splice(0)
    for (const job of queued) job.reject(new Error(`runrail control: ${reason}`))
    this.resolveIdleIfReady()
  }

  /**
   * Compacts between turns. It holds the queue like a turn does, so a message sent meanwhile runs
   * after it on the compacted conversation.
   */
  async compact(reason: RunrailCompactionReason = "manual"): Promise<Omit<RunrailCompaction, "event">> {
    if (this.closed) throw new Error("runrail control: controller is closed")
    if (this.draining || this.activeController !== undefined || this.queue.length > 0)
      throw new RunrailControlError("CONTROL_SESSION_BUSY", "cannot compact while a turn is running or queued")
    this.draining = true
    this.activeController = new AbortController()
    try {
      const { event, ...result } = await this.session.compact(reason)
      if (event !== undefined) this.publish(event)
      return result
    } finally {
      this.activeController = undefined
      this.draining = false
      if (this.queue.length > 0) void this.drain()
      else this.resolveIdleIfReady()
    }
  }

  whenIdle(): Promise<void> {
    if (!this.draining && this.activeController === undefined && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  resolveApproval(approvalId: string, approved: boolean, reason?: string, scope?: ApprovalScope, answers?: ApprovalAnswers, followUp?: FollowUp) {
    return this.session.resolveApproval(approvalId, approved, reason, scope, answers, followUp)
  }

  /** Re-reads the skill folders so a skill added since the session started is listed. A failed read keeps the last good set. */
  async refreshSkills(): Promise<void> {
    await this.session.skillRegistry?.reload().catch(() => undefined)
  }

  /** Skills installed for this session with their toggle state. */
  listSkills(): readonly RunrailSkillStatus[] {
    const registry = this.session.skillRegistry
    if (registry === undefined) return Object.freeze([])
    return Object.freeze(
      [...registry.snapshot(), ...registry.excluded()]
        .map((skill) => Object.freeze({
          id: skill.id,
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          scope: skill.scope,
          enabled: registry.isEnabled(skill.id),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    )
  }

  /**
   * Enable or disable a skill. The registry keeps it listed, and the model's project context is
   * rebuilt at once, so the session's next request leaves it out or has it back. If the rebuild
   * fails the switch is undone.
   */
  async setSkillEnabled(id: string, enabled: boolean): Promise<RunrailSkillStatus> {
    const registry = this.session.skillRegistry
    if (registry === undefined) throw new Error("runrail control: skills are unavailable for this session")
    if (!/^[a-z][a-z0-9._:-]{0,127}$/i.test(id)) throw new Error("runrail control: skill id is invalid")
    if (typeof enabled !== "boolean") throw new Error("runrail control: skill flag is invalid")
    const found = registry.snapshot().find((skill) => skill.id === id) ?? registry.excluded().find((skill) => skill.id === id)
    if (found === undefined) throw new Error("runrail control: unknown skill")
    const before = registry.excluded().map((skill) => skill.id)
    const next = new Set(before)
    if (enabled) next.delete(id)
    else next.add(id)
    registry.setExcluded([...next])
    try {
      await (this.session.context as { reload?: () => Promise<unknown> } | undefined)?.reload?.()
    } catch {
      registry.setExcluded(before)
      throw new Error("runrail control: skill update failed")
    }
    if (this.sessionOptions !== undefined) {
      this.sessionOptions = { ...this.sessionOptions, disabledSkills: Object.freeze([...next]) }
    }
    return Object.freeze({
      id: found.id,
      name: found.name,
      ...(found.description === undefined ? {} : { description: found.description }),
      scope: found.scope,
      enabled,
    })
  }

  switchModel(selection: ModelSelection): Promise<ModelDescriptor> {
    const models = this.toolRoute?.models
    // A tier names no model, so it cannot be held to the list.
    if (models !== undefined && (selection.id === undefined || !models.includes(selection.id))) return Promise.reject(new ConnectionSettingsError("CONNECTION_MODEL_NOT_CHOSEN", "model is not one of the connection's models"))
    const backend = this.currentBackendName
    return this.session.switchModel(selection).then((model) => {
      // Kept, so a refresh recreates the session on this model rather than the one it started on.
      this.chosenModel = { backend, selection }
      return model
    })
  }

  async switchProvider(provider: ProviderModelOptions): Promise<RunrailControlSnapshot> {
    if (this.sessionOptions === undefined) throw new Error("runrail control: provider switching requires factory options")
    if (this.switching || this.activeController !== undefined || this.draining || this.queue.length > 0) throw new Error("runrail control: provider switch requires an idle controller")
    const nextOptions: RunrailSessionOptions = {
      ...this.sessionOptions,
      backend: "native",
      adapter: undefined,
      provider,
      model: undefined,
      contentModel: undefined,
      modelCommand: undefined,
      modelSelection: { id: provider.model, ...(provider.thinking === undefined ? {} : { thinking: provider.thinking }) },
      harnessAccount: undefined,
    }
    await this.replaceSession("provider switch", nextOptions, this.optionsForBackend(this.currentBackendName))
    this.sessionOptions = nextOptions
    this.currentBackendName = "native"
    this.toolRoute = undefined
    this.chosenModel = undefined
    this.resetEventLog()
    return this.snapshot()
  }
  listBackends(): readonly AgentBackendInfo[] {
    const registry = this.sessionOptions?.registry ?? createDefaultBackendRegistry()
    const adapters = registry.list()
    const custom = this.sessionOptions?.adapter
    const all = custom !== undefined && !adapters.some((adapter) => adapter.name === custom.name)
      ? [...adapters, custom]
      : adapters
    return Object.freeze(all
      .map((adapter) => Object.freeze({
        name: adapter.name,
        version: adapter.version,
        capabilities: Object.freeze([...adapter.capabilities]),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)))
  }

  async refreshSession(): Promise<RunrailControlSnapshot> {
    if (this.sessionOptions === undefined) throw new Error("runrail control: session refresh requires factory options")
    if (this.switching || this.activeController !== undefined || this.draining || this.queue.length > 0)
      throw new Error("runrail control: session refresh requires an idle controller")
    // Pi extension contributions are captured when the native model host is built;
    // reload them before recreating the session so newly registered tools are visible.
    await this.session.piExtensions?.reload()
    const options = this.optionsForBackend(this.currentBackendName)
    await this.replaceSession("session refresh", options, options)
    this.resetEventLog()
    return this.snapshot()
  }

  /**
   * Takes the thread back to before the turn `target` names (see
   * `RunrailSession.checkpointFor`): the files in `paths` go back to that
   * turn's checkpoint, the transcript loses the turn's message and everything after, and the
   * session starts again from what is left. Runrail's own loop reads the remaining messages. A
   * coding tool that can cut its own conversation does, once the transcript is cut;
   * any other is forgotten and starts afresh with a recap. Files go back first: a transcript
   * that fails to shorten leaves the conversation whole, and the tool's with it.
   */
  async rewind(target: RunrailRewindTarget, paths: readonly string[]): Promise<RunrailRewindResult> {
    if (this.sessionOptions === undefined) throw new Error("runrail control: rewinding requires factory options")
    if (this.switching || this.activeController !== undefined || this.draining || this.queue.length > 0) throw new Error("runrail control: rewinding requires an idle controller")
    const session = this.session
    const checkpoints = session.checkpoints
    const transcript = session.transcriptStore
    if (checkpoints === undefined || transcript?.truncate === undefined) throw new RunrailControlError("CONTROL_REWIND_UNAVAILABLE", "this thread keeps no checkpoints")
    const checkpoint = await session.checkpointFor(target).catch(() => undefined)
    if (checkpoint?.userId === undefined) throw new RunrailControlError("CONTROL_REWIND_UNAVAILABLE", "that turn cannot be rewound")
    const options = this.optionsForBackend(this.currentBackendName)
    const before = await previousCheckpoint(transcript, session.snapshot.id, checkpoint.userId, checkpoints)
    const forget = async (): Promise<void> => {
      if (options.sessionDir !== undefined) await forgetVendorSessions(join(options.sessionDir, "harness"), session.snapshot.id)
    }
    this.switching = true
    try {
      // Where the tool can cut its own conversation, it keeps its tool outputs and needs no recap.
      // Preparing changes nothing in the tool; the step runs after the cut.
      const keep = options.sessionDir === undefined ? undefined : await prepareVendorRewind(session.backend, session.snapshot.id, { ...(checkpoint.vendor === undefined ? {} : { turn: checkpoint.vendor }), ...(before?.vendor === undefined ? {} : { before: before.vendor }) })
      await session.stop("rewind")
      let cut: { readonly removed: number } | undefined
      let kept = false
      let marked = false
      try {
        const files: CheckpointRestore = paths.length === 0 ? { restored: [], failed: [] } : await checkpoints.restore(checkpoint.n, paths)
        cut = await transcript.truncate(session.snapshot.id, { beforeId: checkpoint.userId })
        await checkpoints.dropFrom(checkpoint.n)
        await forget()
        kept = keep !== undefined && (await keep().then(() => true, () => false))
        await transcript.append(session.snapshot.id, { kind: SESSION_REWOUND, payload: { type: SESSION_REWOUND, removed: cut.removed, ...(kept ? { inTool: true } : {}) } })
        marked = true
        this.session = await createRunrailSession(options)
        return Object.freeze({ removed: cut.removed, restored: files.restored, failed: files.failed })
      } catch (error) {
        // Once the transcript is cut, a tool that did not cut its own conversation must not keep
        // the removed turns: it starts afresh, with a recap of what is left.
        if (cut !== undefined && !marked && !kept) {
          await forget().catch(() => undefined)
          await transcript.append(session.snapshot.id, { kind: SESSION_REWOUND, payload: { type: SESSION_REWOUND, removed: cut.removed } }).catch(() => undefined)
        }
        // The thread keeps a session whatever went wrong; the caller hears what did.
        if (this.session === session) this.session = await createRunrailSession(options)
        throw error
      }
    } finally {
      this.switching = false
      this.resetEventLog()
    }
  }

  /** Without `route` a coding tool runs with its own sign-in and folder, as from a terminal. */
  async switchBackend(backend: string, route?: RunrailToolConnectionRoute): Promise<AgentBackendInfo> {
    if (this.sessionOptions === undefined) throw new Error("runrail control: backend switching requires factory options")
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(backend))
      throw new Error("runrail control: backend is invalid")
    if (this.switching || this.activeController !== undefined || this.draining || this.queue.length > 0)
      throw new Error("runrail control: backend switch requires an idle controller")
    const previousRoute = this.toolRoute
    const previous = this.optionsForBackend(this.currentBackendName)
    this.toolRoute = route === undefined ? undefined : Object.freeze({ ...route })
    try {
      await this.replaceSession("backend switch", this.optionsForBackend(backend), previous)
    } catch (error) {
      this.toolRoute = previousRoute
      throw error
    }
    this.currentBackendName = backend
    this.chosenModel = undefined
    this.resetEventLog()
    return this.session.backend.info
  }
  /**
   * Stops the session and starts one from `next`. If that fails a session is started again from
   * `previous`, so a failed switch never leaves the controller holding a stopped session.
   */
  private async replaceSession(reason: string, next: RunrailSessionOptions, previous: RunrailSessionOptions): Promise<void> {
    this.switching = true
    try {
      await this.session.stop(reason)
      try {
        this.session = await createRunrailSession(next)
      } catch (error) {
        this.session = await createRunrailSession(previous)
        throw error
      }
    } finally {
      this.switching = false
    }
  }

  private optionsForBackend(backend: string): RunrailSessionOptions {
    if (this.sessionOptions === undefined) throw new Error("runrail control: backend options are unavailable")
    const customAdapter = this.sessionOptions.adapter
    return {
      ...this.sessionOptions,
      backend,
      ...(customAdapter !== undefined && customAdapter.name !== backend ? { adapter: undefined } : {}),
      ...(backend === "native" ? {} : { provider: undefined, model: undefined, contentModel: undefined, modelCommand: undefined, modelCatalog: undefined, modelSelection: undefined, fallbackModel: undefined }),
      harnessAccount: this.toolRoute?.account,
      // A connection with chosen models starts on its first one.
      ...(backend !== "native" && this.toolRoute?.models !== undefined ? { modelSelection: { id: this.toolRoute.models[0]! } } : {}),
      ...(this.chosenModel?.backend === backend ? { modelSelection: this.chosenModel.selection } : {}),
    }
  }

  async close(reason = "closed"): Promise<void> {
    this.closed = true
    this.cancel(reason, true)
    await this.session.stop(reason)
    this.listeners.clear()
    this.resolveIdleIfReady()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.closed) {
        const job = this.queue.shift()
        if (job === undefined) continue
        const controller = new AbortController()
        this.activeController = controller
        this.activeJob = job
        try {
          for await (const event of this.session.prompt(job.input, controller.signal)) {
            job.events.push(event)
            this.publish(event)
          }
          this.session.metrics?.recordRun(
            job.events.some((event) => event.type === "session.completed") && !job.events.some((event) => event.type === "session.failed"),
            job.events.filter((event) => event.type === "repair.required").length,
          )
          if (typeof this.session.saveMetrics === "function") await this.session.saveMetrics()
          job.resolve(Object.freeze(job.events))
        } catch (error) {
          job.reject(error)
        } finally {
          this.activeController = undefined
          this.activeJob = undefined
          // Guidance that came after the model's last step runs next, ahead of anything queued.
          const late = typeof this.session.takeUndeliveredSteers === "function" ? this.session.takeUndeliveredSteers() : []
          for (const text of [...late].reverse()) this.queue.unshift({ input: text, events: [], resolve: () => undefined, reject: () => undefined })
        }
      }
    } finally {
      this.draining = false
      this.resolveIdleIfReady()
    }
  }

  private publish(event: AgentEvent): void {
    this.eventLog.push(event)
    if (this.eventLog.length > MAX_LIVE_EVENTS) this.eventLog.splice(0, this.eventLog.length - MAX_LIVE_EVENTS)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Observer failure must not interrupt the authoritative session turn.
      }
    }
  }

  private resolveIdleIfReady(): void {
    if (this.draining || this.activeController !== undefined || this.queue.length > 0) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

export async function createRunrailSessionController(options: RunrailSessionOptions): Promise<RunrailSessionController> {
  return RunrailSessionController.create(options)
}

/**
 * The checkpoint of the turn just before the one whose message is `userId`, found by that turn's
 * message in the transcript: a checkpoint a failed rewind left behind belongs to no message, so
 * its mark is never taken for the conversation to continue from.
 */
async function previousCheckpoint(transcript: TranscriptStore, sessionId: string, userId: string, checkpoints: TurnCheckpoints): Promise<TurnCheckpoint | undefined> {
  const records = await transcript.read(sessionId).catch(() => [] as const)
  const at = records.findIndex((record) => record.id === userId)
  const previous = records.slice(0, Math.max(at, 0)).reverse().find((record) => record.kind === "message.user" && !isSteer(record.payload))
  return previous === undefined ? undefined : checkpoints.find({ userId: previous.id }).catch(() => undefined)
}

function isSteer(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { readonly steer?: unknown }).steer === true
}

/** The step that keeps an exact rewind in the tool's own conversation, from a backend that offers one. */
async function prepareVendorRewind(backend: AgentBackend, sessionId: string, target: { readonly turn?: VendorMark; readonly before?: VendorMark }): Promise<(() => Promise<void>) | undefined> {
  const prepare = (backend as { readonly prepareRewind?: unknown }).prepareRewind
  if (typeof prepare !== "function") return undefined
  try {
    const keep: unknown = await prepare.call(backend, sessionId, target)
    return typeof keep === "function" ? (keep as () => Promise<void>) : undefined
  } catch {
    return undefined
  }
}
