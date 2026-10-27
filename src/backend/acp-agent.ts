import {
  agentError,
  isAgentEvent,
  type AgentBackend,
  type AgentBackendInfo,
  type AgentEvent,
  type AgentSessionSnapshot,
  type CreateSessionInput,
  type ForkSessionInput,
  type ForkSessionResult,
  type ReloadResult,
  type SendMessageInput,
} from "@nifrajs/agent-protocol"
import { RUNRAIL_VERSION } from "../version.ts"
import { HarnessAuthError, isRouteEnvironment, parseHarnessAuthOptions, resolveHarnessEnvironment } from "../harness/auth.ts"
import { HARNESS_ROUTE_LIMITS, HarnessLaunchError, effortFromThinking, isHarnessModelId, isVendorSessionId, parseHarnessLaunchOptions, type HarnessEffort, type HarnessLaunchOptions, type HarnessPermissionMode } from "../harness/launch.ts"
import { emitLive, stampEventSnapshot } from "../harness/mappers.ts"
import { eventText, eventTextPieces } from "../harness/event-text.ts"
import { credentialValues, exitReason, failureWords, messageWords } from "../harness/failure-words.ts"
import { harnessRateLimitMessage } from "../harness/rate-limit.ts"
import { boundToolInput } from "../harness/tool-input.ts"
import type { HarnessAuthOptions } from "../harness/types.ts"
import { vendorSessionEntry, type VendorSessionStore } from "../harness/vendor-session-store.ts"
import type { RunrailLiveSink, RunrailPlanStep } from "../live/types.ts"
import { CommandAgentBackendError, type CommandAgentBackendErrorCode } from "./command-agent.ts"
import { terminateProcessTree } from "./process-tree.ts"

/** The Agent Client Protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1

/** What a process is started with, for an agent that takes these as command-line settings. */
export interface AcpProcessSettings {
  readonly model?: string
  readonly effort?: HarnessEffort
}

export interface AcpAuthentication {
  readonly methodId: string
  readonly meta?: Readonly<Record<string, unknown>>
}

/** An MCP server the agent starts for each session, as ACP's `session/new` takes it. */
export interface AcpMcpServer {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: readonly { readonly name: string; readonly value: string }[]
}

export interface AcpAgentBackendOptions {
  /** The backend's name in session snapshots, e.g. `copilot`. */
  readonly name: string
  /** The tool's own name, for failure messages. */
  readonly label: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  readonly command: string
  /** Arguments that put the tool into its ACP mode. */
  readonly args?: readonly string[]
  /**
   * Arguments for the settings the agent takes on its command line. With this, a changed model or
   * effort restarts the process and loads the conversation again; without it, a model the agent
   * does not list for the session is refused and an effort is not sent.
   */
  readonly settingArgs?: (settings: AcpProcessSettings) => readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Settings the route itself puts in the agent's environment, on top of the filtered one, such as
   * how the agent asks for permission. Never a credential: those go through `auth`.
   */
  readonly routeEnv?: Readonly<Record<string, string>>
  readonly auth?: HarnessAuthOptions
  /**
   * Signs the agent in once it starts, before a session opens, with a method it advertised. A key
   * goes in `meta`, so it reaches the agent on stdin and never through its environment.
   */
  readonly authenticate?: () => Promise<AcpAuthentication>
  /**
   * How long a turn stays open for updates after the agent answered the prompt, once they stop.
   * ACP puts every update first; OpenCode sends the end of its reply after the answer.
   */
  readonly trailingUpdateMs?: number
  /** Longest a single request other than a prompt may wait for its response. */
  readonly timeoutMs?: number
  /** Longest a single turn may run. Defaults to `timeoutMs` when that is set, otherwise one hour. */
  readonly turnTimeoutMs?: number
  /** Output accepted from the agent during one turn. */
  readonly maxOutputBytes?: number
  readonly maxEvents?: number
  /** Model, effort, permission mode, added instructions, and the conversation to continue. */
  readonly launch?: HarnessLaunchOptions
  /** Runrail's own servers, such as the connectors; the agent starts them for every session it opens, forks or loads. */
  readonly mcpServers?: readonly AcpMcpServer[]
  /** Keeps the agent's session id so a later backend instance loads the same conversation. */
  readonly vendorSessions?: VendorSessionStore
  /** Optional transient sink for reasoning text and plan updates; never persisted. */
  readonly onLive?: RunrailLiveSink
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface PermissionOption {
  readonly optionId: string
  readonly kind: string
}

interface PendingApproval {
  readonly id: RpcId
  readonly turnId: string
  readonly options: readonly PermissionOption[]
  /** `switch`: the agent asks to leave its mode (plan); `planning`: a request its own plan mode let through. */
  readonly leaves?: "switch" | "planning"
}

interface AcpTurn {
  readonly turnId: string
  readonly queue: EventQueue
  /** `detail`: the command, file, or address the tool's own updates named. */
  readonly tools: Map<string, { readonly name: string; done: boolean; detail?: string }>
  /** Assistant text since the last message boundary. */
  text: string
  /** True once the agent said anything or started a tool this turn. */
  produced: boolean
  lastUpdateAt: number
  eventCount: number
  timer?: ReturnType<typeof setTimeout>
  cleanup?: () => void
  cancelled?: string
  readonly settled: Promise<void>
  settle: () => void
}

type RpcId = number | string

/** ACP's error code for a request that needs the user to sign in to the agent first. */
const ACP_AUTH_REQUIRED = -32_000
const JSON_RPC_INVALID_PARAMS = -32_602
/** What the person decides on when the agent asks to leave plan mode, as Claude Code's route words it. */
const LEAVE_PLAN = "Leave plan mode and start making changes"

/** A provider's refusal of the key, passed on in an agent's error (Gemini CLI: "API key not valid"). */
function refusedKey(message: unknown): boolean {
  return typeof message === "string" && /API key not valid|API_KEY_INVALID|invalid api key|incorrect api key/i.test(message.slice(0, 4_096))
}
const MAX_PERMISSION_OPTIONS = 16
const MAX_SESSION_MODELS = 256
const MAX_REASON_CHARS = 256
const MAX_TOOL_OUTPUT_CHARS = 64 * 1024
/** Tool kinds that only look: never a write, a command, or a network call. */
const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"])
const WRITE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"])
/** Kinds that write, run, or reach the network: refused in plan mode whatever the agent's own mode. */
const ACTING_KINDS: ReadonlySet<string> = new Set([...WRITE_KINDS, "execute", "fetch"])

/**
 * A coding tool driven over the Agent Client Protocol: JSON-RPC on the tool's own stdio, one
 * conversation per backend. The agent keeps its own tools, its own login, and its own history;
 * Runrail sends prompts, shows what comes back, and answers the agent's permission requests
 * according to the thread's permission mode.
 *
 * Runrail advertises no file or terminal capability, so the agent never reads, writes, or runs
 * anything through this client.
 */
export class AcpAgentBackend implements AgentBackend {
  readonly info: AgentBackendInfo

  private readonly options: Required<Pick<AcpAgentBackendOptions, "timeoutMs" | "turnTimeoutMs" | "maxOutputBytes" | "maxEvents">>
  private readonly launch: HarnessLaunchOptions
  private readonly commandOptions: AcpAgentBackendOptions
  private readonly mcpServers: readonly AcpMcpServer[]
  private readonly auth: HarnessAuthOptions
  private readonly label: string
  private readonly sessions = new Map<string, AgentSessionSnapshot>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly approvals = new Map<string, PendingApproval>()
  private sequence = 0
  private rpcSequence = 0
  private turnSequence = 0
  private eventSequence = -1
  private child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  private initialized = false
  private canLoadSession = false
  private canFork = false
  private processStart: Promise<void> | undefined
  /** What the running process was started with. */
  private startedWith: AcpProcessSettings = {}
  private closed = false
  private starting = false
  private active: AcpTurn | undefined
  private sessionId: string | undefined
  private vendorSessionId: string | undefined
  /** True while the running process has the conversation open. */
  private sessionBound = false
  /** True while the agent replays a loaded conversation; that history is not part of any turn. */
  private loading = false
  private sessionModels: ReadonlySet<string> | undefined
  private sessionModes: ReadonlySet<string> | undefined
  /** The session config option that picks the model, when the agent offers one (Goose). */
  private modelOptionId: string | undefined
  private currentModel: string | undefined
  private currentMode: string | undefined
  private instructionsPending = false
  private sessionStarted = false
  private model: string | undefined
  private effort: HarnessEffort | undefined
  private outputBytes = 0
  /** Credential values the running process was given, kept out of the words its failures show. */
  private secrets: readonly string[] = []
  /** The last text the running process wrote to stderr, read only to say why it exited. */
  private stderrTail = ""
  /** The person let the agent leave plan mode; from then on each write is asked, not refused. */
  private planLeft = false
  /** The person said yes to a request the agent's own plan mode let through; its leaving plan mode follows. */
  private planExitApproved = false

  constructor(options: AcpAgentBackendOptions) {
    validateOptions(options)
    try {
      this.auth = parseHarnessAuthOptions(options.auth)
    } catch {
      throw commandError("COMMAND_AGENT_AUTH_INVALID", "harness authentication options are invalid")
    }
    try {
      this.launch = parseHarnessLaunchOptions(options.launch)
    } catch (error) {
      throw commandError("COMMAND_AGENT_INVALID", error instanceof HarnessLaunchError ? error.message : "launch options are invalid")
    }
    if (this.launch.mcpConfig !== undefined || this.launch.allowedTools !== undefined) throw commandError("COMMAND_AGENT_INVALID", "this route takes no MCP configuration or allowed tools")
    if (this.launch.addDirs !== undefined) throw commandError("COMMAND_AGENT_INVALID", "this route takes no related folders")
    this.label = options.label
    this.model = this.launch.model
    this.effort = this.launch.effort
    this.commandOptions = options
    this.mcpServers = Object.freeze((options.mcpServers ?? []).map((server) => Object.freeze({ name: server.name, command: server.command, args: [...server.args], env: server.env.map((variable) => ({ name: variable.name, value: variable.value })) })))
    this.options = {
      timeoutMs: options.timeoutMs ?? 120_000,
      turnTimeoutMs: options.turnTimeoutMs ?? options.timeoutMs ?? HARNESS_ROUTE_LIMITS.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? HARNESS_ROUTE_LIMITS.maxOutputBytes,
      maxEvents: options.maxEvents ?? HARNESS_ROUTE_LIMITS.maxEvents,
    }
    this.info = Object.freeze({
      name: options.name,
      version: options.version ?? RUNRAIL_VERSION,
      capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming", "persistent", "tools", "approvals", "resume", "models", "thinking", "reload"])].sort()),
    })
  }

  /** Opening a session runs no process; the agent starts with the first turn. */
  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (this.closed) throw commandError("COMMAND_AGENT_INVALID", "backend is closed")
    if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096) throw commandError("COMMAND_AGENT_INVALID", "session cwd is invalid")
    const id = input.sessionId ?? `${this.info.name}-${++this.sequence}`
    if (!validId(id) || this.sessions.has(id)) throw commandError("COMMAND_AGENT_INVALID", "session id is invalid or already exists")
    if (this.sessionId !== undefined) throw commandError("COMMAND_AGENT_INVALID", "this backend supports one Runrail session")
    const snapshot = makeSnapshot(id, this.info.name, input.cwd, "idle", -1, this.info.capabilities)
    this.sessions.set(id, snapshot)
    this.sessionId = id
    this.eventSequence = -1
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    return this.run(input)
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    const active = this.active
    if (active === undefined) return
    active.cancelled = boundedReason(reason)
    this.releaseApprovals()
    if (this.child !== undefined && this.vendorSessionId !== undefined && this.sessionBound) {
      await this.writeMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.vendorSessionId } }).catch(() => undefined)
      // A well-behaved agent ends the prompt with `cancelled`; one that does not is stopped.
      await Promise.race([active.settled, delay(2_000)])
    }
    if (this.active === active) {
      await this.stopProcess()
      if (this.active === active) {
        this.pushEvent(this.makeEvent("session.stopped", { reason: active.cancelled }), active)
        this.finishActive(active)
      }
    }
    this.sessions.set(sessionId, this.currentSnapshot(session.id))
  }

  async interrupt(sessionId: string, reason = "interrupted"): Promise<void> {
    this.requireSession(sessionId)
    const active = this.active
    if (active === undefined || this.vendorSessionId === undefined) throw commandError("COMMAND_AGENT_INVALID", "no active turn can be interrupted")
    active.cancelled = boundedReason(reason)
    this.releaseApprovals()
    await this.writeMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.vendorSessionId } })
  }

  async resume(sessionId: string): Promise<AgentSessionSnapshot> {
    const session = this.requireSession(sessionId)
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot resume while a turn is active")
    await this.ensureSession(session)
    const snapshot = makeSnapshot(session.id, session.backend, session.cwd, "idle", session.lastSeq, session.capabilities, session.createdAt)
    this.sessions.set(session.id, snapshot)
    return snapshot
  }

  /**
   * The agent's copy of the conversation, kept for the target session, so a session opened with
   * that id continues the copy. Only for an agent that offers `session/fork`.
   */
  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    const session = this.requireSession(input.sessionId)
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot fork during an active turn")
    const targetSessionId = input.targetSessionId ?? `${session.id}-fork-${++this.sequence}`
    if (!validId(targetSessionId) || targetSessionId === session.id) throw commandError("COMMAND_AGENT_INVALID", "fork target session id is invalid")
    const store = this.commandOptions.vendorSessions
    // Without a store the copy's id would be lost and nothing could open it.
    if (store === undefined) throw commandError("COMMAND_AGENT_UNSUPPORTED", "fork needs a store for the conversation id")
    this.starting = true
    try {
      await this.ensureSession(session)
    } finally {
      this.starting = false
    }
    if (!this.canFork) throw commandError("COMMAND_AGENT_UNSUPPORTED", `${this.label} cannot fork a conversation`)
    const parent = this.requireVendorSessionId()
    const result = await this.request<unknown>("session/fork", { sessionId: parent, cwd: session.cwd, mcpServers: this.mcpServers })
    const forked = isRecord(result) ? result.sessionId : undefined
    if (!isVendorSessionId(forked) || forked === parent) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} fork identity is invalid`)
    await store.save(targetSessionId, forked)
    return Object.freeze({ sessionId: targetSessionId, parentSessionId: session.id })
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    this.requireSession(sessionId)
    if (!isHarnessModelId(model)) throw commandError("COMMAND_AGENT_INVALID", "model is invalid")
    this.model = model
  }

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.requireSession(sessionId)
    const effort = effortFromThinking(thinking)
    if (effort === undefined) throw commandError("COMMAND_AGENT_INVALID", "thinking is invalid")
    this.effort = effort
  }

  async resolveApproval(sessionId: string, approvalId: string, approved: boolean, reason?: string): Promise<boolean | undefined> {
    const session = this.requireSession(sessionId)
    const pending = this.approvals.get(approvalId)
    if (pending === undefined) return false
    const decision = approved ? "allow" : "reject"
    const sent = permissionOption(pending, decision) === undefined ? "cancelled" : decision
    // Set before the answer goes, so the agent's mode change that follows it finds the yes.
    if (sent === "allow" && pending.leaves === "switch") this.planLeft = true
    if (sent === "allow" && pending.leaves === "planning") this.planExitApproved = true
    await this.answerPermission(pending, decision)
    this.approvals.delete(approvalId)
    const active = this.active
    // An answer the agent offered no one-time option for went as a cancel; the card says so.
    const outcome = sent === "cancelled"
      ? { approved: false, reason: `${this.label} offered no way to ${approved ? "allow" : "refuse"} this once, so the request was cancelled` }
      : { approved, ...(reason === undefined ? {} : { reason: boundedReason(reason) }) }
    if (active !== undefined) this.pushEvent(this.makeEvent("approval.resolved", { turnId: pending.turnId, approvalId, ...outcome }), active)
    this.sessions.set(session.id, this.currentSnapshot(session.id))
    return true
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId)
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    this.requireSession(sessionId)
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot reload while a turn is active")
    await this.stopProcess()
    return Object.freeze({ revision: `${this.info.version}:reload`, loaded: Object.freeze([]), disabled: Object.freeze([]), rolledBack: false })
  }

  async close(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    if (this.active !== undefined) await this.cancel(sessionId, "closed")
    await this.stopProcess()
    this.sessions.delete(sessionId)
    this.sessionId = undefined
    this.vendorSessionId = undefined
    this.closed = true
  }

  private async *run(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 256 * 1024 || input.message.includes("\0")) throw commandError("COMMAND_AGENT_INVALID", "agent message is invalid")
    const session = this.requireSession(input.sessionId)
    if (this.active !== undefined) throw commandError("COMMAND_AGENT_INVALID", "agent session is already running")
    const turn = await this.startTurn(session, input.message, input.signal)
    try {
      for await (const event of turn.queue) yield event
    } finally {
      const shouldCancel = turn.cancelled === undefined && this.active === turn
      if (shouldCancel) await this.cancel(input.sessionId, input.signal?.aborted ? "cancelled" : "consumer closed")
    }
  }

  private async startTurn(session: AgentSessionSnapshot, message: string, signal?: AbortSignal): Promise<AcpTurn> {
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "agent session is already running")
    this.starting = true
    try {
      await this.ensureSession(session)
    } finally {
      this.starting = false
    }
    let settle: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const turn: AcpTurn = { turnId: `turn-${++this.turnSequence}`, queue: new EventQueue(), tools: new Map(), text: "", produced: false, lastUpdateAt: 0, eventCount: 0, settled, settle }
    this.active = turn
    this.outputBytes = 0
    this.updateSessionStatus(session.id, "running")
    if (!this.sessionStarted) {
      this.sessionStarted = true
      this.pushEvent(this.makeEvent("session.started", { snapshot: this.currentSnapshot(session.id) }), turn)
    }
    this.pushEvent(this.makeEvent("turn.started", { turnId: turn.turnId, prompt: eventText(message) }), turn)
    turn.timer = setTimeout(() => void this.cancel(session.id, "timeout"), this.options.turnTimeoutMs)
    const abort = (): void => void this.cancel(session.id, "cancelled")
    turn.cleanup = () => signal?.removeEventListener("abort", abort)
    signal?.addEventListener("abort", abort, { once: true })

    // ACP has no field for instructions, so they open the conversation as its first block.
    const instructions = this.instructionsPending ? this.launch.appendSystemPrompt : undefined
    this.instructionsPending = false
    const prompt = [...(instructions === undefined ? [] : [{ type: "text", text: `Instructions for this conversation, set by the user:\n\n${instructions}` }]), { type: "text", text: message }]
    // The prompt request answers when the turn ends; the turn's own timer bounds it.
    void this.request<Record<string, unknown>>("session/prompt", { sessionId: this.requireVendorSessionId(), prompt }, this.options.turnTimeoutMs + 5_000).then(
      (result) => this.endTurn(turn, result),
      (error) => {
        if (this.active === turn && turn.cancelled === undefined) this.failActive(normalizeError(error, `${this.label} turn failed`))
        turn.settle()
      },
    )
    if (signal?.aborted) abort()
    return turn
  }

  private endTurn(turn: AcpTurn, result: unknown): void {
    const quietMs = this.commandOptions.trailingUpdateMs ?? 0
    const stopReason = isRecord(result) ? result.stopReason : undefined
    if (quietMs === 0 || stopReason === "cancelled" || turn.cancelled !== undefined || this.active !== turn) {
      this.completeTurn(turn, result)
      return
    }
    turn.lastUpdateAt = Date.now()
    void this.untilQuiet(turn, quietMs).then(() => this.completeTurn(turn, result))
  }

  /** Waits until the turn's updates have stopped for `quietMs`, for at most two seconds. */
  private async untilQuiet(turn: AcpTurn, quietMs: number): Promise<void> {
    const deadline = Date.now() + 2_000
    for (;;) {
      const wait = Math.min(turn.lastUpdateAt + quietMs, deadline) - Date.now()
      if (wait <= 0 || this.active !== turn || turn.cancelled !== undefined) return
      await delay(wait)
    }
  }

  private completeTurn(turn: AcpTurn, result: unknown): void {
    turn.settle()
    if (this.active !== turn) return
    try {
      const stopReason = isRecord(result) ? result.stopReason : undefined
      this.flushMessage(turn)
      if (stopReason === "cancelled" || turn.cancelled !== undefined) {
        this.pushEvent(this.makeEvent("session.stopped", { reason: turn.cancelled ?? "cancelled" }), turn)
      } else if (stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
        // OpenCode ends a turn whose model call failed this way: nothing said, no tokens used.
        if (!turn.produced && isRecord(result) && isRecord(result.usage) && result.usage.totalTokens === 0) {
          this.failActive(commandError("COMMAND_AGENT_FAILED", `${this.label} model gave no answer`))
          return
        }
        this.pushEvent(this.makeEvent("session.completed", { snapshot: this.makeSnapshotFor("completed") }), turn)
      } else if (stopReason === "refusal") {
        this.failActive(commandError("COMMAND_AGENT_FAILED", `${this.label} declined the request`))
        return
      } else throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} ended the turn without a known reason`)
      this.finishActive(turn)
    } catch (error) {
      this.failActive(normalizeError(error, `${this.label} turn failed`))
    }
  }

  /**
   * The process and the conversation, started by the first thing that needs them. A fault here
   * belongs to that turn; the Runrail session stays for a retry.
   */
  private async ensureSession(session: AgentSessionSnapshot): Promise<void> {
    if (this.child !== undefined && this.needsRestart()) await this.stopProcess()
    await this.ensureProcess(session.cwd)
    try {
      if (!this.sessionBound) {
        const stored = this.vendorSessionId === undefined ? await vendorSessionEntry(this.commandOptions.vendorSessions, session.id).catch(() => undefined) : undefined
        if (stored?.fork === true) await this.continueCopy(session, stored.vendorSessionId)
        else {
          const known = this.vendorSessionId ?? await this.storedSessionId(session.id)
          if (known === undefined || !(await this.loadSession(known, session.cwd))) await this.newSession(session)
        }
      }
      await this.applySessionSettings()
    } catch (error) {
      await this.stopProcess()
      throw normalizeError(error, `${this.label} conversation could not start`)
    }
  }

  /** True when the running process was started with settings that no longer hold. */
  private needsRestart(): boolean {
    if (this.commandOptions.settingArgs === undefined) return false
    if (this.effort !== this.startedWith.effort) return true
    // A model the agent lists for the conversation is switched in place.
    return this.model !== this.startedWith.model && !(this.model !== undefined && this.sessionModels?.has(this.model) === true)
  }

  private async newSession(session: AgentSessionSnapshot): Promise<void> {
    const result = await this.request<unknown>("session/new", { cwd: session.cwd, mcpServers: this.mcpServers })
    const vendorSessionId = isRecord(result) ? result.sessionId : undefined
    if (!isVendorSessionId(vendorSessionId)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} session identity is invalid`)
    this.vendorSessionId = vendorSessionId
    this.sessionBound = true
    this.readSessionInfo(result)
    this.instructionsPending = this.launch.appendSystemPrompt !== undefined
    const store = this.commandOptions.vendorSessions
    if (store !== undefined) {
      try {
        await store.save(session.id, vendorSessionId)
      } catch {
        // Losing the id only costs continuity after a restart; it never fails the session.
      }
    }
  }

  /**
   * A conversation the tool recorded outside Runrail (an import continued in its own tool): a copy
   * is continued, so the tool's own history is never written. An agent that cannot copy one
   * is refused rather than loading the original.
   */
  private async continueCopy(session: AgentSessionSnapshot, original: string): Promise<void> {
    if (!this.canFork) throw commandError("COMMAND_AGENT_UNSUPPORTED", `${this.label} cannot continue a copy of that conversation`)
    const result = await this.request<unknown>("session/fork", { sessionId: original, cwd: session.cwd, mcpServers: this.mcpServers })
    const forked = isRecord(result) ? result.sessionId : undefined
    if (!isVendorSessionId(forked) || forked === original) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} fork identity is invalid`)
    this.vendorSessionId = forked
    this.sessionBound = true
    this.readSessionInfo(result)
    this.instructionsPending = this.launch.appendSystemPrompt !== undefined
    // Saved without the mark: the copy is this thread's own from now on.
    await this.commandOptions.vendorSessions?.save(session.id, forked)
  }

  /** Continue a conversation the agent still has. One it no longer has is forgotten. */
  private async loadSession(vendorSessionId: string, cwd: string): Promise<boolean> {
    if (!this.canLoadSession) return false
    this.loading = true
    try {
      const result = await this.request<unknown>("session/load", { sessionId: vendorSessionId, cwd, mcpServers: this.mcpServers })
      this.vendorSessionId = vendorSessionId
      this.sessionBound = true
      this.readSessionInfo(result)
      return true
    } catch (error) {
      // A dead process or a missing login is not "the conversation is gone".
      if (this.child === undefined || (error instanceof CommandAgentBackendError && error.code === "COMMAND_AGENT_AUTH_FAILED")) throw error
      this.vendorSessionId = undefined
      return false
    } finally {
      this.loading = false
    }
  }

  private readSessionInfo(result: unknown): void {
    this.sessionModels = undefined
    this.sessionModes = undefined
    this.modelOptionId = undefined
    this.currentModel = undefined
    this.currentMode = undefined
    if (!isRecord(result)) return
    const option = modelConfigOption(result.configOptions)
    if (option !== undefined) {
      this.modelOptionId = option.id
      this.sessionModels = option.values
      this.currentModel = option.current
    } else if (isRecord(result.models) && Array.isArray(result.models.availableModels)) {
      const ids = result.models.availableModels.slice(0, MAX_SESSION_MODELS).flatMap((entry) => (isRecord(entry) && isHarnessModelId(entry.modelId) ? [entry.modelId] : []))
      this.sessionModels = new Set(ids)
      this.currentModel = isHarnessModelId(result.models.currentModelId) ? result.models.currentModelId : undefined
    }
    if (isRecord(result.modes) && Array.isArray(result.modes.availableModes)) {
      this.sessionModes = new Set(result.modes.availableModes.slice(0, 32).flatMap((entry) => (isRecord(entry) && shortText(entry.id) !== undefined ? [shortText(entry.id)!] : [])))
      this.currentMode = shortText(result.modes.currentModeId)
    }
  }

  /** The model and mode the thread asks for, where the agent offers them for the conversation. */
  private async applySessionSettings(): Promise<void> {
    const sessionId = this.requireVendorSessionId()
    const model = this.model
    if (model !== undefined && model !== this.currentModel) {
      if (this.modelOptionId !== undefined) {
        // The agent's answer names the model it now runs; anything else would be a silent swap.
        const answer = await this.request<unknown>("session/set_config_option", { sessionId, configId: this.modelOptionId, value: model })
        const now = isRecord(answer) ? modelConfigOption(answer.configOptions)?.current : undefined
        if (now !== model) throw commandError("COMMAND_AGENT_INVALID", `${this.label} did not take this model`)
        this.currentModel = model
      } else if (this.sessionModels?.has(model) === true) {
        await this.request("session/set_model", { sessionId, modelId: model })
        this.currentModel = model
      } else if (this.commandOptions.settingArgs === undefined) {
        // Nothing carried this model to the agent; running on another one would be a silent swap.
        throw commandError("COMMAND_AGENT_INVALID", `${this.label} does not offer this model`)
      }
    }
    // A plan-only agent mode, when there is one, on top of refusing every write and command.
    const mode = this.gateMode() === "plan" && this.sessionModes?.has("plan") === true ? "plan" : undefined
    if (mode !== undefined && mode !== this.currentMode) {
      await this.request("session/set_mode", { sessionId, modeId: mode })
      this.currentMode = mode
    }
  }

  private async storedSessionId(sessionId: string): Promise<string | undefined> {
    let stored: string | undefined
    try {
      stored = await this.commandOptions.vendorSessions?.load(sessionId)
    } catch {
      stored = undefined
    }
    const known = stored ?? this.launch.resume
    return isVendorSessionId(known) ? known : undefined
  }

  private async ensureProcess(cwd: string): Promise<void> {
    if (this.child !== undefined && this.initialized) return
    if (this.processStart !== undefined) return this.processStart
    const start = this.startProcess(cwd)
    this.processStart = start
    try {
      await start
    } finally {
      if (this.processStart === start) this.processStart = undefined
    }
  }

  private async startProcess(cwd: string): Promise<void> {
    const settings: AcpProcessSettings = { ...(this.model === undefined ? {} : { model: this.model }), ...(this.effort === undefined ? {} : { effort: this.effort }) }
    const extra = this.commandOptions.settingArgs?.(settings) ?? []
    if (!Array.isArray(extra) || extra.length > 16 || extra.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 256 || arg.includes("\0"))) throw commandError("COMMAND_AGENT_INVALID", "setting arguments are invalid")
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">
    try {
      const env = await this.commandEnvironment()
      this.secrets = credentialValues(env, this.auth.credentialEnvironment)
      child = Bun.spawn([this.commandOptions.command, ...(this.commandOptions.args ?? []), ...extra], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true, env })
    } catch (caught) {
      if (caught instanceof CommandAgentBackendError) throw caught
      if (isMissingCommand(caught)) throw commandError("COMMAND_AGENT_NOT_FOUND", `${this.label} command was not found`)
      throw commandError("COMMAND_AGENT_FAILED", `${this.label} command could not start`)
    }
    this.child = child
    this.initialized = false
    this.sessionBound = false
    this.stderrTail = ""
    this.startedWith = settings
    void this.readOutput(child)
    try {
      const result = await this.request<unknown>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Nothing is offered: the agent uses its own tools and asks permission for them.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "runrail", title: "Runrail", version: RUNRAIL_VERSION },
      })
      if (!isRecord(result) || result.protocolVersion !== ACP_PROTOCOL_VERSION) throw commandError("COMMAND_AGENT_UNSUPPORTED", `${this.label} speaks another protocol version`)
      this.canLoadSession = isRecord(result.agentCapabilities) && result.agentCapabilities.loadSession === true
      this.canFork = isRecord(result.agentCapabilities) && isRecord(result.agentCapabilities.sessionCapabilities) && isRecord(result.agentCapabilities.sessionCapabilities.fork)
      if (this.commandOptions.authenticate !== undefined) await this.authenticate(result.authMethods)
      this.initialized = true
    } catch (error) {
      await this.stopProcess()
      throw normalizeError(error, `${this.label} could not initialize`)
    }
  }

  private async authenticate(advertised: unknown): Promise<void> {
    let sign: AcpAuthentication
    try {
      sign = await this.commandOptions.authenticate!()
    } catch {
      throw commandError("COMMAND_AGENT_CREDENTIALS_UNAVAILABLE", "harness credentials are unavailable")
    }
    this.secrets = [...this.secrets, ...Object.values(sign.meta ?? {}).filter((value): value is string => typeof value === "string")]
    const offered = Array.isArray(advertised) && advertised.some((method) => isRecord(method) && method.id === sign.methodId)
    if (!offered) throw commandError("COMMAND_AGENT_UNSUPPORTED", `${this.label} does not offer that sign-in`)
    try {
      await this.request("authenticate", { methodId: sign.methodId, ...(sign.meta === undefined ? {} : { _meta: sign.meta }) })
    } catch {
      // The agent's own message is not passed on: it may repeat what it was sent.
      throw commandError("COMMAND_AGENT_AUTH_FAILED", `${this.label} refused the sign-in`)
    }
  }

  private async readOutput(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    let buffer = ""
    const stderrPromise = this.drainStderr(child)
    try {
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) {
        const value = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
        this.outputBytes += Buffer.byteLength(value, "utf8")
        if (this.outputBytes > this.options.maxOutputBytes) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} output exceeded its byte limit`)
        buffer += value
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          if (line.trim().length > 0) this.acceptLine(line)
        }
      }
      const status = await child.exited
      await stderrPromise
      const exited = commandError("COMMAND_AGENT_FAILED", exitReason(this.label, status, failureWords(this.stderrTail, this.secrets)))
      if (this.child === child) this.failPending(exited)
      if (this.active !== undefined && this.active.cancelled === undefined) this.failActive(exited)
    } catch (caught) {
      const failure = normalizeError(caught, `${this.label} output is invalid`)
      this.failPending(failure)
      if (this.active !== undefined && this.active.cancelled === undefined) this.failActive(failure)
      await terminateProcessTree(child)
    } finally {
      if (this.child === child) {
        this.child = undefined
        this.initialized = false
        this.sessionBound = false
      }
    }
  }

  private async drainStderr(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const decoder = new TextDecoder()
    try {
      // Read so the pipe never fills; only the tail is kept, to say why the process exited.
      for await (const chunk of child.stderr) {
        if (this.child === child) this.stderrTail = `${this.stderrTail}${decoder.decode(chunk, { stream: true })}`.slice(-8 * 1024)
      }
    } catch {
      // The process is going away.
    }
  }

  private acceptLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      // A line that is not a protocol message (a stray log line) is not part of the conversation.
      return
    }
    if (!isRecord(value)) return
    if (value.id !== undefined && value.method === undefined) {
      if (!isRpcId(value.id)) return
      const key = rpcKey(value.id)
      const pending = this.pending.get(key)
      // A response that arrives after its request timed out has nobody waiting for it.
      if (pending === undefined) return
      this.pending.delete(key)
      clearTimeout(pending.timer)
      if (value.error !== undefined) {
        const limitMessage = harnessRateLimitMessage(value.error, this.label)
        const code = limitMessage !== undefined ? "COMMAND_AGENT_RATE_LIMITED" : isRecord(value.error) && (value.error.code === ACP_AUTH_REQUIRED || refusedKey(value.error.message)) ? "COMMAND_AGENT_AUTH_FAILED" : "COMMAND_AGENT_FAILED"
        // A refused sign-in is not repeated: the agent's words may carry the account or the key.
        const words = code === "COMMAND_AGENT_FAILED" && isRecord(value.error) && typeof value.error.message === "string" ? messageWords(value.error.message, this.secrets) : undefined
        pending.reject(commandError(code, limitMessage ?? (words === undefined ? `${this.label} request failed` : `${this.label} reported an error: ${words}`)))
      } else pending.resolve(value.result)
      return
    }
    const method = shortText(value.method)
    if (method === undefined) return
    if (value.id !== undefined) {
      if (!isRpcId(value.id)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} request id is invalid`)
      this.handleAgentRequest(method, value.id, value.params)
      return
    }
    if (method === "session/update") this.handleUpdate(value.params)
  }

  private handleAgentRequest(method: string, id: RpcId, params: unknown): void {
    const active = this.active
    if (method !== "session/request_permission") {
      // Refused, never granted: Runrail offered no file, terminal, or other client method.
      void this.writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `Runrail does not offer ${method}` } }).catch(() => undefined)
      return
    }
    if (!isRecord(params)) {
      void this.writeMessage({ jsonrpc: "2.0", id, error: { code: JSON_RPC_INVALID_PARAMS, message: "The permission request has no parameters" } }).catch(() => undefined)
      return
    }
    const options = permissionOptions(params.options)
    const pending: PendingApproval = { id, turnId: active?.turnId ?? "turn", options }
    // Outside a turn, for another conversation, or while one is being cancelled, nothing is granted.
    if (active === undefined || active.cancelled !== undefined || this.loading || params.sessionId !== this.vendorSessionId) {
      void this.answerPermission(pending, "cancelled").catch(() => undefined)
      return
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
    const kind = shortText(toolCall.kind) ?? "other"
    const gate = this.gateMode()
    // The agent's own plan mode keeps writes out, so what it asks for there is to leave that mode or
    // something for the person (Gemini CLI's plan approval is kind `other`): the person decides.
    const planning = gate === "plan" && this.currentMode === "plan" && kind !== "switch_mode" && !READ_KINDS.has(kind) && !ACTING_KINDS.has(kind)
    const decision = planning ? "ask" : permissionDecision(gate, kind)
    if (decision !== "ask") {
      void this.answerPermission(pending, decision).catch(() => undefined)
      return
    }
    const approvalId = `acp-${typeof id}-${String(id)}`
    if (this.approvals.has(approvalId)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} repeated a permission request id`)
    const leaves = kind === "switch_mode" ? "switch" : planning ? "planning" : undefined
    this.approvals.set(approvalId, { ...pending, ...(leaves === undefined ? {} : { leaves }) })
    const callId = shortText(toolCall.toolCallId)
    // A plan the agent asks to carry out shows on the call it gates, so the person reads it before deciding.
    if (kind === "switch_mode" && callId !== undefined && !active.tools.has(callId)) this.startTool(active, callId, toolCall)
    const known = callId === undefined ? undefined : active.tools.get(callId)?.detail
    const title = permissionReason(toolCall, known) ?? (kind === "switch_mode" ? LEAVE_PLAN : undefined)
    this.pushEvent(this.makeEvent("approval.required", {
      turnId: active.turnId,
      approvalId,
      action: kind === "switch_mode" ? "plan" : kind === "execute" ? "command" : WRITE_KINDS.has(kind) ? "file_change" : "permission",
      capability: kind === "execute" ? "process.exec" : WRITE_KINDS.has(kind) ? "filesystem.write" : kind === "fetch" ? "network.request" : "tool.use",
      ...(title === undefined ? {} : { reason: title }),
    }), active)
  }

  /** The thread's permission mode, unless the person has since let the agent leave plan mode. */
  private gateMode(): HarnessPermissionMode | undefined {
    return this.launch.permissionMode === "plan" && this.planLeft ? "ask" : this.launch.permissionMode
  }

  /**
   * Answers with one of the options the agent offered (`permissionOption`). A one-time answer never
   * becomes a standing one: a standing yes would skip the person's next say, and a standing no would
   * stop the agent asking. With no one-time option offered, the request is cancelled.
   */
  private async answerPermission(pending: PendingApproval, decision: "allow" | "reject" | "cancelled"): Promise<void> {
    const option = permissionOption(pending, decision)
    await this.writeMessage({ jsonrpc: "2.0", id: pending.id, result: { outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId } } })
  }

  private releaseApprovals(): void {
    for (const pending of this.approvals.values()) void this.answerPermission(pending, "cancelled").catch(() => undefined)
    this.approvals.clear()
  }

  private handleUpdate(params: unknown): void {
    const active = this.active
    // History replayed by a load, another conversation, and anything between turns are not this turn.
    if (active === undefined || this.loading || !isRecord(params) || params.sessionId !== this.vendorSessionId || !isRecord(params.update)) return
    const update = params.update
    active.lastUpdateAt = Date.now()
    const kind = update.sessionUpdate
    if (kind === "agent_message_chunk") {
      const text = contentText(update.content)
      if (text === undefined || text.length === 0) return
      active.produced = true
      active.text += text
      for (const piece of eventTextPieces(text)) this.pushEvent(this.makeEvent("assistant.delta", { turnId: active.turnId, text: piece }), active)
      return
    }
    if (kind === "agent_thought_chunk") {
      const text = contentText(update.content)
      if (text !== undefined && text.length > 0) emitLive(this.commandOptions, { type: "reasoning.delta", turnId: active.turnId, text })
      return
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const callId = shortText(update.toolCallId)
      if (callId === undefined) return
      const tool = active.tools.get(callId) ?? this.startTool(active, callId, update)
      // A tool's input can arrive after it starts, and its permission request may not repeat it.
      tool.detail = toolTarget(update) ?? tool.detail
      if (tool.done || (update.status !== "completed" && update.status !== "failed")) return
      tool.done = true
      const ok = update.status === "completed"
      const output = toolOutput(update.content)
      this.pushEvent(this.makeEvent("tool.completed", {
        turnId: active.turnId,
        callId,
        name: tool.name,
        ok,
        ...(output === undefined ? {} : { output }),
        ...(ok ? {} : { error: agentError("ACP_TOOL_FAILED", (output === undefined ? undefined : failureWords(output, this.secrets)) ?? "tool call failed") }),
      }), active)
      return
    }
    if (kind === "plan" && Array.isArray(update.entries)) {
      const steps: RunrailPlanStep[] = []
      for (const entry of update.entries.slice(0, 64)) {
        if (!isRecord(entry) || typeof entry.content !== "string" || entry.content.trim().length === 0) continue
        steps.push({ text: entry.content.slice(0, 1_024), status: entry.status === "completed" ? "completed" : entry.status === "in_progress" ? "in_progress" : "pending" })
      }
      emitLive(this.commandOptions, { type: "plan.updated", turnId: active.turnId, steps })
      return
    }
    if (kind === "current_mode_update") {
      const previous = this.currentMode
      this.currentMode = shortText(update.currentModeId) ?? this.currentMode
      // The agent left its plan mode on the person's yes to its request: Runrail's gate leaves it too.
      if (previous === "plan" && this.currentMode !== "plan" && this.planExitApproved) this.planLeft = true
    }
  }

  /** A tool call the turn has not seen, from an update or a permission request that names it. */
  private startTool(active: AcpTurn, callId: string, update: Record<string, unknown>): { readonly name: string; done: boolean; detail?: string } {
    // What the assistant said before the tool is a message of its own.
    this.flushMessage(active)
    active.produced = true
    const tool = { name: shortText(update.kind) ?? "tool", done: false }
    active.tools.set(callId, tool)
    // A request to leave plan mode carries the plan it would carry out (in its input or its content).
    const plan = tool.name === "switch_mode" ? planText(update) : undefined
    const input = boundToolInput({ ...(typeof update.title === "string" ? { title: update.title } : {}), ...(plan === undefined ? {} : { plan }), ...(update.rawInput === undefined ? {} : { input: update.rawInput }), ...(Array.isArray(update.locations) ? { locations: update.locations } : {}) })
    this.pushEvent(this.makeEvent("tool.started", { turnId: active.turnId, callId, name: tool.name, ...(input === undefined ? {} : { input }) }), active)
    return tool
  }

  private flushMessage(turn: AcpTurn): void {
    if (turn.text.length === 0) return
    const text = turn.text
    turn.text = ""
    // A reply longer than one event's text travels whole as consecutive messages.
    for (const piece of eventTextPieces(text)) this.pushEvent(this.makeEvent("assistant.message", { turnId: turn.turnId, text: piece }), turn)
  }

  private makeEvent(type: string, payload: Record<string, unknown>): AgentEvent {
    const sessionId = this.requireSessionId()
    const seq = ++this.eventSequence
    const candidate: unknown = Object.freeze({ version: 1, sessionId, seq, at: Date.now(), type, ...stampEventSnapshot(payload, seq) })
    if (!isAgentEvent(candidate)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} event could not be normalized`)
    return candidate
  }

  private pushEvent(event: AgentEvent, active: AcpTurn): void {
    active.eventCount += 1
    if (active.eventCount > this.options.maxEvents) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", `${this.label} event count exceeded its limit`)
    this.updateSnapshotFromEvent(event)
    active.queue.push(event)
  }

  private failActive(failure: CommandAgentBackendError): void {
    const active = this.active
    if (active === undefined) return
    const auth = failure.code === "COMMAND_AGENT_AUTH_FAILED"
    const limited = failure.code === "COMMAND_AGENT_RATE_LIMITED"
    const event = this.makeEvent("session.failed", { error: agentError(failure.code, auth ? `${this.label} refused its sign-in or key` : failure.reason), recoverable: !auth && !limited })
    active.queue.push(event)
    active.queue.complete()
    this.updateSnapshotFromEvent(event)
    this.releaseApprovals()
    this.finishActive(active, false)
  }

  private finishActive(active: AcpTurn, completeQueue = true): void {
    // A yes counts toward leaving plan mode only in the turn that asked.
    this.planExitApproved = false
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.cleanup?.()
    if (completeQueue) active.queue.complete()
    if (this.active === active) this.active = undefined
  }

  private failPending(failure: CommandAgentBackendError): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(failure)
    }
    this.pending.clear()
  }

  private async stopProcess(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.initialized = false
    this.sessionBound = false
    this.approvals.clear()
    if (child === undefined) return
    this.failPending(commandError("COMMAND_AGENT_CANCELLED", `${this.label} process stopped`))
    await terminateProcessTree(child)
  }

  private async request<T>(method: string, params: unknown, timeoutMs = this.options.timeoutMs): Promise<T> {
    if (this.child === undefined) throw commandError("COMMAND_AGENT_FAILED", `${this.label} process is unavailable`)
    const id = ++this.rpcSequence
    const key = rpcKey(id)
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(commandError("COMMAND_AGENT_TIMEOUT", `${this.label} request timed out`))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
    })
    try {
      await this.writeMessage({ jsonrpc: "2.0", id, method, params })
    } catch (error) {
      const pending = this.pending.get(key)
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        this.pending.delete(key)
        pending.reject(normalizeError(error, `${this.label} request could not be written`))
      }
    }
    return await promise as T
  }

  private async writeMessage(value: Record<string, unknown>): Promise<void> {
    if (this.child === undefined) throw commandError("COMMAND_AGENT_FAILED", `${this.label} process is unavailable`)
    try {
      await this.child.stdin.write(`${JSON.stringify(value)}\n`)
    } catch {
      throw commandError("COMMAND_AGENT_FAILED", `${this.label} message could not be written`)
    }
  }

  private async commandEnvironment(): Promise<Record<string, string>> {
    try {
      return { ...await resolveHarnessEnvironment(this.commandOptions.env, this.auth), ...this.commandOptions.routeEnv }
    } catch (error) {
      if (error instanceof HarnessAuthError) throw commandError("COMMAND_AGENT_CREDENTIALS_UNAVAILABLE", "harness credentials are unavailable")
      throw error
    }
  }

  private requireSession(sessionId: string): AgentSessionSnapshot {
    if (!validId(sessionId)) throw commandError("COMMAND_AGENT_INVALID", "session id is invalid")
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw commandError("COMMAND_AGENT_INVALID", "agent session is unknown")
    return session
  }

  private requireSessionId(): string {
    if (this.sessionId === undefined) throw commandError("COMMAND_AGENT_INVALID", "agent session is unavailable")
    return this.sessionId
  }

  private requireVendorSessionId(): string {
    if (this.vendorSessionId === undefined) throw commandError("COMMAND_AGENT_INVALID", `${this.label} conversation is unavailable`)
    return this.vendorSessionId
  }

  private currentSnapshot(sessionId: string): AgentSessionSnapshot {
    const snapshot = this.sessions.get(sessionId)
    if (snapshot === undefined) throw commandError("COMMAND_AGENT_INVALID", "agent session is unknown")
    return snapshot
  }

  private updateSessionStatus(sessionId: string, status: AgentSessionSnapshot["status"]): void {
    const previous = this.currentSnapshot(sessionId)
    this.sessions.set(sessionId, makeSnapshot(previous.id, previous.backend, previous.cwd, status, previous.lastSeq, previous.capabilities, previous.createdAt))
  }

  private updateSnapshotFromEvent(event: AgentEvent): void {
    const previous = this.currentSnapshot(event.sessionId)
    let status = previous.status
    if (event.type === "session.started" || event.type === "turn.started") status = "running"
    else if (event.type === "approval.required") status = "waiting"
    else if (event.type === "session.completed") status = "completed"
    else if (event.type === "session.failed") status = "failed"
    else if (event.type === "session.stopped") status = "stopped"
    this.sessions.set(event.sessionId, makeSnapshot(previous.id, previous.backend, previous.cwd, status, event.seq, previous.capabilities, previous.createdAt, event.type === "turn.started" ? event.turnId : undefined))
  }

  private makeSnapshotFor(status: AgentSessionSnapshot["status"]): AgentSessionSnapshot {
    const session = this.currentSnapshot(this.requireSessionId())
    return makeSnapshot(session.id, session.backend, session.cwd, status, this.eventSequence, session.capabilities, session.createdAt)
  }
}

/**
 * What Runrail does with a permission request, from the thread's permission mode and the kind of
 * tool call. `ask` hands the question to the user. With no mode chosen, everything is asked.
 */
export function permissionDecision(mode: HarnessPermissionMode | undefined, kind: string): "allow" | "reject" | "ask" {
  if (mode === "bypass") return "allow"
  // Leaving plan mode is the person's call: refusing it unasked would hide the plan.
  if (mode === "plan") return READ_KINDS.has(kind) ? "allow" : kind === "switch_mode" ? "ask" : "reject"
  if (mode === "accept-edits" || mode === "auto") return READ_KINDS.has(kind) || kind === "edit" ? "allow" : "ask"
  return "ask"
}

class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly events: AgentEvent[] = []
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = []
  private done = false

  push(event: AgentEvent): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: event })
    else this.events.push(event)
  }

  complete(): void {
    if (this.done) return
    this.done = true
    if (this.events.length > 0) return
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const next = await this.next()
      if (next.done) return
      yield next.value
    }
  }

  private next(): Promise<IteratorResult<AgentEvent>> {
    const event = this.events.shift()
    if (event !== undefined) return Promise.resolve({ done: false, value: event })
    if (this.done) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

/** The agent's one-time option for a decision; a cancel, or no such option, has none. */
function permissionOption(pending: PendingApproval, decision: "allow" | "reject" | "cancelled"): PermissionOption | undefined {
  const wanted = decision === "allow" ? "allow_once" : decision === "reject" ? "reject_once" : undefined
  return wanted === undefined ? undefined : pending.options.find((entry) => entry.kind === wanted)
}

function permissionOptions(value: unknown): readonly PermissionOption[] {
  if (!Array.isArray(value)) return []
  const options: PermissionOption[] = []
  for (const entry of value.slice(0, MAX_PERMISSION_OPTIONS)) {
    if (!isRecord(entry)) continue
    const optionId = shortText(entry.optionId)
    const kind = shortText(entry.kind)
    if (optionId !== undefined && kind !== undefined) options.push({ optionId, kind })
  }
  return options
}

/**
 * The tool call's title, with the command, file, or address it touches when the title does not say
 * it already. Some agents title a request with the bare tool name ("bash") and leave its input to
 * the tool's own updates, which `known` carries.
 */
function permissionReason(toolCall: Record<string, unknown>, known?: string): string | undefined {
  const title = typeof toolCall.title === "string" ? oneLine(toolCall.title) : ""
  const detail = toolTarget(toolCall) ?? known ?? ""
  // Goose cuts a long title ("write · /long/pa..."); the full target replaces the cut part.
  const separator = title.lastIndexOf(" · ")
  const cut = detail.length > 0 && /(?:\.\.\.|…)$/.test(title)
  const text = cut ? (separator > 0 ? `${title.slice(0, separator)} · ${detail}` : detail) : detail.length === 0 || title.includes(detail) ? title : title.length === 0 ? detail : `${title}: ${detail}`
  return text.length === 0 ? undefined : text.slice(0, MAX_REASON_CHARS)
}

/** The command, file, or address a tool call names in its input or locations. */
function toolTarget(toolCall: Record<string, unknown>): string | undefined {
  const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : {}
  const location = Array.isArray(toolCall.locations) && isRecord(toolCall.locations[0]) ? toolCall.locations[0].path : undefined
  const target = [input.command, input.filePath, input.filepath, input.file_path, input.path, input.url, location].find((value): value is string => typeof value === "string" && value.trim().length > 0)
  return target === undefined ? undefined : oneLine(target)
}

function oneLine(value: string): string {
  return value.trim().replace(/[\0-\x1f\x7f]+/g, " ").slice(0, MAX_REASON_CHARS)
}

/** The plan a request to leave plan mode carries: its input's `plan`, else the text of its content. */
function planText(toolCall: Record<string, unknown>): string | undefined {
  const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : {}
  if (typeof input.plan === "string" && input.plan.trim().length > 0) return input.plan
  const text = toolOutput(toolCall.content)
  return text === undefined || text.trim().length === 0 ? undefined : text
}

/** Text of one content block, when it is a text block. */
function contentText(value: unknown): string | undefined {
  // The event protocol refuses NUL; the text keeps its place with U+FFFD instead of vanishing.
  return isRecord(value) && value.type === "text" && typeof value.text === "string" ? value.text.replaceAll("\0", "\uFFFD") : undefined
}

/** The text a finished tool call reported, bounded. Diffs and terminals are left to the tool's own view. */
function toolOutput(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  let output = ""
  for (const entry of value.slice(0, 64)) {
    const text = isRecord(entry) && entry.type === "content" ? contentText(entry.content) : undefined
    if (text === undefined) continue
    output += output.length === 0 ? text : `\n${text}`
    if (output.length >= MAX_TOOL_OUTPUT_CHARS) break
  }
  return output.length === 0 ? undefined : output.slice(0, MAX_TOOL_OUTPUT_CHARS)
}

function makeSnapshot(id: string, backend: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq: number, capabilities: readonly string[], createdAt = Date.now(), activeTurnId?: string): AgentSessionSnapshot {
  return Object.freeze({ version: 1, id, backend, cwd, status, createdAt, updatedAt: Date.now(), lastSeq, capabilities: Object.freeze([...capabilities]), ...(activeTurnId === undefined ? {} : { activeTurnId }) })
}

function validateOptions(options: AcpAgentBackendOptions): void {
  if (options === null || typeof options !== "object") throw commandError("COMMAND_AGENT_INVALID", "options are invalid")
  if (typeof options.name !== "string" || !validId(options.name)) throw commandError("COMMAND_AGENT_INVALID", "backend name is invalid")
  if (typeof options.label !== "string" || options.label.length === 0 || options.label.length > 64 || /[\0-\x1f\x7f]/.test(options.label)) throw commandError("COMMAND_AGENT_INVALID", "backend label is invalid")
  if (typeof options.command !== "string" || options.command.length === 0 || options.command.length > 256 || /\s/.test(options.command) || options.command.startsWith("-") || options.command.includes("\0")) throw commandError("COMMAND_AGENT_INVALID", "command is invalid")
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.length > 128 || options.args.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 4_096 || arg.includes("\0")))) throw commandError("COMMAND_AGENT_INVALID", "arguments are invalid")
  if (options.settingArgs !== undefined && typeof options.settingArgs !== "function") throw commandError("COMMAND_AGENT_INVALID", "setting arguments are invalid")
  if (options.routeEnv !== undefined && !isRouteEnvironment(options.routeEnv)) throw commandError("COMMAND_AGENT_INVALID", "route environment is invalid")
  if (options.authenticate !== undefined && typeof options.authenticate !== "function") throw commandError("COMMAND_AGENT_INVALID", "sign-in is invalid")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw commandError("COMMAND_AGENT_INVALID", "timeout is invalid")
  if (options.trailingUpdateMs !== undefined && (!Number.isSafeInteger(options.trailingUpdateMs) || options.trailingUpdateMs < 0 || options.trailingUpdateMs > 1_000)) throw commandError("COMMAND_AGENT_INVALID", "trailing update wait is invalid")
  if (options.turnTimeoutMs !== undefined && (!Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs < 1 || options.turnTimeoutMs > 86_400_000)) throw commandError("COMMAND_AGENT_INVALID", "turn timeout is invalid")
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 1024 * 1024 * 1024)) throw commandError("COMMAND_AGENT_INVALID", "output bound is invalid")
  if (options.maxEvents !== undefined && (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 1_000_000)) throw commandError("COMMAND_AGENT_INVALID", "event bound is invalid")
  if (options.vendorSessions !== undefined && (options.vendorSessions === null || typeof options.vendorSessions !== "object" || typeof options.vendorSessions.load !== "function" || typeof options.vendorSessions.save !== "function")) throw commandError("COMMAND_AGENT_INVALID", "vendor session store is invalid")
  if (options.onLive !== undefined && typeof options.onLive !== "function") throw commandError("COMMAND_AGENT_INVALID", "live sink is invalid")
  if (options.mcpServers !== undefined && (!Array.isArray(options.mcpServers) || options.mcpServers.length > 16 || !options.mcpServers.every(isMcpServer))) throw commandError("COMMAND_AGENT_INVALID", "MCP servers are invalid")
}

function isMcpServer(server: AcpMcpServer): boolean {
  const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
  return server !== null && typeof server === "object" && text(server.name, 128) && text(server.command, 1_024)
    && Array.isArray(server.args) && server.args.length <= 128 && server.args.every((arg) => text(arg, 4_096))
    && Array.isArray(server.env) && server.env.length <= 64 && server.env.every((variable) => variable !== null && typeof variable === "object" && text(variable.name, 256) && typeof variable.value === "string" && !variable.value.includes("\0"))
}

function normalizeError(error: unknown, fallback: string): CommandAgentBackendError {
  if (error instanceof CommandAgentBackendError) return error
  return commandError("COMMAND_AGENT_FAILED", fallback)
}

function commandError(code: CommandAgentBackendErrorCode, reason: string): CommandAgentBackendError {
  return new CommandAgentBackendError(code, reason)
}

function boundedReason(value: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REASON_CHARS && !value.includes("\0") ? value : "cancelled"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** An id or a word from the agent: short, one line. */
/**
 * ACP's session config option that picks the model (`category: "model"`, else `id: "model"`), as
 * Goose sends it. Its listed values are what the agent knows; Goose also takes an id it does not list.
 */
function modelConfigOption(value: unknown): { readonly id: string; readonly values: ReadonlySet<string>; readonly current: string | undefined } | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value.slice(0, 32).filter(isRecord)
  const option = options.find((entry) => entry.category === "model" && entry.type === "select") ?? options.find((entry) => entry.id === "model" && entry.type === "select")
  const id = option === undefined ? undefined : shortText(option.id)
  if (option === undefined || id === undefined) return undefined
  const values = Array.isArray(option.options) ? option.options.slice(0, MAX_SESSION_MODELS).flatMap((entry) => (isRecord(entry) && isHarnessModelId(entry.value) ? [entry.value] : [])) : []
  return { id, values: new Set(values), current: isHarnessModelId(option.currentValue) ? option.currentValue : undefined }
}

function shortText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\0-\x1f\x7f]/.test(value) ? value : undefined
}

function rpcKey(value: RpcId): string {
  return `${typeof value}:${String(value)}`
}

function isRpcId(value: unknown): value is RpcId {
  return (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && value.length > 0 && value.length <= 128)
}

function validId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isMissingCommand(value: unknown): boolean {
  return value !== null && typeof value === "object" && "code" in value && (value as { readonly code?: unknown }).code === "ENOENT"
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
