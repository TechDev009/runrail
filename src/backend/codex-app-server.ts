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
import { codexModels } from "../harness/detect.ts"
import { HARNESS_ROUTE_LIMITS, HarnessLaunchError, codexEffort, codexEffortFor, codexThreadParameters, effortFromThinking, isVendorSessionId, parseHarnessLaunchOptions, type HarnessLaunchOptions } from "../harness/launch.ts"
import { eventText, eventTextPieces } from "../harness/event-text.ts"
import { oneLine } from "../harness/review.ts"
import { declinedMessage } from "../harness/declined.ts"
import { boundToolInput } from "../harness/tool-input.ts"
import type { HarnessAuthOptions, HarnessMetadataSink } from "../harness/types.ts"
import { emitLive, reasoningText, stampEventSnapshot } from "../harness/mappers.ts"
import { codexPlanLimits } from "../harness/plan-limits.ts"
import { harnessRateLimitMessage } from "../harness/rate-limit.ts"
import { APPROVAL_REVIEWED, REVIEWER_NOTICE, codexReview, codexWarning } from "../harness/review.ts"
import { vendorSessionEntry, type VendorSessionEntry, type VendorSessionStore } from "../harness/vendor-session-store.ts"
import type { RunrailContextUsageFrame, RunrailLiveSink, RunrailPlanLimitsFrame, RunrailPlanStep, RunrailUsageReading } from "../live/types.ts"
import { BrowserBridge, BrowserError } from "../browser/bridge.ts"
import { BROWSER_TOOL_SPECS, browserResultText } from "../browser/tools.ts"
import { ThreadsBridge, ThreadsError } from "../threads/bridge.ts"
import { THREADS_TOOL_SPECS, threadsResultText } from "../threads/tools.ts"
import { ComputerBridge, ComputerError } from "../computer/bridge.ts"
import { COMPUTER_TOOL_SPECS, computerResultText } from "../computer/tools.ts"
import { ImageError } from "../images/generate.ts"
import { ImageService } from "../images/service.ts"
import { IMAGE_TOOL_SPECS } from "../images/tools.ts"
import { ConnectorError, type ConnectorRegistry } from "../connectors/registry.ts"
import { callConnector, type GrantedConnectorTool } from "../connectors/tools.ts"
import { CodexBackgroundTracker } from "./codex-background.ts"
import { FOLLOW_UP_UNSUPPORTED, QUESTION_ACTION, QUESTION_CAPABILITY, QUESTION_NEEDS_ANSWERS, answersMismatch, codexAnswerResult, codexElicitationResult, codexQuestions, elicitationAnswer, elicitationMismatch, mcpElicitation, questionsReason, recordedAnswers, type ApprovalAnswers, type ApprovalQuestion, type ElicitationForm, type FollowUp } from "../harness/questions.ts"
import { CommandAgentBackendError, type CommandAgentBackendErrorCode } from "./command-agent.ts"
import { terminateProcessTree } from "./process-tree.ts"

export const CODEX_APP_SERVER_PROTOCOL_VERSION = "codex.app-server.v2"
const PLAN_LIMITS_TIMEOUT_MS = 5_000
const STEER_TIMEOUT_MS = 5_000
const MAX_STEER_CHARS = 256 * 1024
/** A card opened often reads the account's usage once a minute at most. */
const PLAN_READ_INTERVAL_MS = 60_000
const MAX_TOKENS = 20_000_000
const MAX_SUB_AGENTS = 64
const REFUSED_NO_TURN = "no turn was running, so no one could answer it"
const COMPACTION_REASONS: ReadonlySet<string> = new Set(["manual", "threshold", "overflow", "workflow"])

type CompactionReason = "manual" | "threshold" | "overflow" | "workflow"
type ContextReading = Omit<RunrailContextUsageFrame, "type" | "turnId">

export interface CodexAppServerBackendOptions {
  readonly name?: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Variables the route sets on Codex, such as a connection's own `CODEX_HOME`. Never a credential. */
  readonly routeEnv?: Readonly<Record<string, string>>
  readonly auth?: HarnessAuthOptions
  /**
   * An API key Codex signs in with once it starts. It is sent on stdin and Codex keeps it in memory
   * (`cli_auth_credentials_store="ephemeral"`): no `auth.json` holds it.
   */
  readonly apiKey?: () => Promise<string>
  /** Longest a single request may wait for its response. */
  readonly timeoutMs?: number
  /** Longest a single turn may run. Defaults to `timeoutMs` when that is set, otherwise one hour. */
  readonly turnTimeoutMs?: number
  /** Output accepted from the server during one turn. */
  readonly maxOutputBytes?: number
  readonly maxEvents?: number
  /** Model, permission mode, and added instructions for the vendor thread; effort for each turn. */
  readonly launch?: HarnessLaunchOptions
  /** Keeps the vendor thread id so a later backend instance resumes the same thread. */
  readonly vendorSessions?: VendorSessionStore
  readonly onMetadata?: HarnessMetadataSink
  /** Optional transient sink for reasoning text and plan updates; never persisted. */
  readonly onLive?: RunrailLiveSink
  /** The desktop's browser preview. Codex takes the tools when a thread starts and keeps them with it. */
  readonly browser?: BrowserBridge
  /** Which threads started with the browser tools; a thread started without them cannot gain them. */
  readonly browserThreads?: VendorSessionStore
  /** The person's other threads. Like the browser, a thread has these tools only when it started with them. */
  readonly threads?: ThreadsBridge
  /** Apps on the person's Mac they allowed. Like the browser, a thread has these tools only when it started with them. */
  readonly computer?: ComputerBridge
  /** The person's chosen image model. Like the browser, a thread has this tool only when it started with it. */
  readonly images?: ImageService
  /** Connector actions this thread's role may use without asking, offered as dynamic tools when a thread starts. */
  readonly connectors?: { readonly registry: ConnectorRegistry; readonly tools: readonly GrantedConnectorTool[] }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface PendingApproval {
  readonly id: RpcId
  readonly approvalId: string
  readonly method: string
  readonly turnId: string
  readonly kind: "decision" | "permissions" | "question" | "elicitation"
  readonly permissions?: Record<string, unknown>
  /** request_user_input, or an MCP server's form: what is asked, and the answers once given. */
  readonly questions?: readonly ApprovalQuestion[]
  answers?: ApprovalAnswers
  readonly elicitation?: ElicitationForm
}

/** A Codex sub-agent's thread, spawned from this session's thread or from another of its sub-agents. */
interface SubAgentThread {
  readonly parentThreadId: string
  readonly name?: string
  /** The spawnAgent call that started it, which the live view shows as the agent. */
  readonly callId?: string
}

/** Who a server request comes from: this turn, a sub-agent under it, or neither, refused with why. */
type RequestOrigin = { readonly turnId: string; readonly agent?: SubAgentThread } | { readonly refused: string }

interface AppServerTurn {
  readonly sessionId: string
  readonly queue: EventQueue
  readonly controller: AbortController
  readonly message: string
  readonly textByItem: Map<string, string>
  /** Set on the turn Codex runs for a requested compaction; it reports only the compaction. */
  readonly compaction?: CompactionReason
  eventCount: number
  vendorTurnId?: string
  timer?: ReturnType<typeof setTimeout>
  cleanup?: () => void
  cancelled?: string
  /** Between a compaction item's start and end. */
  compacting?: boolean
  /** The compacted history's size, from Codex's last usage report while it compacted. */
  compactedTokens?: number
  /** Items Codex's reviewer refused, so their end reads as its decision and not the person's. */
  readonly refused: Map<string, "denied" | "timed-out">
}

type RpcId = number | string

/**
 * Codex's documented experimental app-server protocol is deliberately kept
 * separate from the normalized JSONL backend. The server has bidirectional
 * JSON-RPC, vendor thread identity, and server-initiated approval requests;
 * treating it as prompt-in/line-out would silently lose those controls.
 */
export class CodexAppServerBackend implements AgentBackend {
  readonly info: AgentBackendInfo

  private readonly options: Required<Pick<CodexAppServerBackendOptions, "timeoutMs" | "turnTimeoutMs" | "maxOutputBytes" | "maxEvents">>
  private readonly launch: HarnessLaunchOptions
  private readonly commandOptions: CodexAppServerBackendOptions
  private readonly auth: HarnessAuthOptions
  private readonly sessions = new Map<string, AgentSessionSnapshot>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly subAgents = new Map<string, SubAgentThread>()
  private sequence = 0
  private rpcSequence = 0
  private eventSequence = -1
  private child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  private initialized = false
  private processThreadResumed = false
  private processStart: Promise<void> | undefined
  private closed = false
  private starting = false
  private active: AppServerTurn | undefined
  private sessionId: string | undefined
  private vendorThreadId: string | undefined
  /** The last turn Codex completed, in the thread it ran in: a rewind can cut the thread there. */
  private lastTurn: { readonly session: string; readonly at: string } | undefined
  private sessionStarted = false
  private nextModel: string | undefined
  private nextSandbox: string | undefined
  /** Settings that outlive a turn: a restarted server process gets them again. */
  private model: string | undefined
  private effort: string | undefined
  private readonly listedEfforts = new Map<string, readonly string[]>()
  private readonly background = new CodexBackgroundTracker({
    emit: (frame) => emitLive(this.commandOptions, frame),
    request: (method, params, timeoutMs) => this.request(method, params, timeoutMs),
  })
  private defaultModel: string | undefined
  private outputBytes = 0
  private lastContext: ContextReading | undefined
  /** The thread's running total at the last usage report; Codex repeats a report when it starts compacting. */
  private lastTotalTokens: number | undefined
  /** Where Codex compacts on its own, when its config names a limit. */
  private autoCompactAt: number | undefined
  private planReadAt: number | undefined
  /** The newest plan usage from a read or an update, so a throttled read never answers older. */
  private latestPlan: RunrailPlanLimitsFrame | undefined
  /** Auto asked for Codex's own reviewer and the thread came back without it; said once per session. */
  private reviewerRefused = false
  private reviewerNoticed = false

  constructor(options: CodexAppServerBackendOptions = {}) {
    validateOptions(options)
    try {
      this.auth = parseHarnessAuthOptions(options.auth)
    } catch {
      throw new CommandAgentBackendError("COMMAND_AGENT_AUTH_INVALID", "harness authentication options are invalid")
    }
    try {
      this.launch = parseHarnessLaunchOptions(options.launch)
    } catch (error) {
      throw commandError("COMMAND_AGENT_INVALID", error instanceof HarnessLaunchError ? error.message : "Codex app-server launch options are invalid")
    }
    if (this.launch.mcpConfig !== undefined || this.launch.allowedTools !== undefined) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server takes no MCP configuration or allowed tools")
    this.model = this.launch.model
    this.effort = this.launch.effort === undefined ? undefined : codexEffort(this.launch.effort)
    this.commandOptions = options
    this.options = {
      timeoutMs: options.timeoutMs ?? 120_000,
      turnTimeoutMs: options.turnTimeoutMs ?? options.timeoutMs ?? HARNESS_ROUTE_LIMITS.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? HARNESS_ROUTE_LIMITS.maxOutputBytes,
      maxEvents: options.maxEvents ?? HARNESS_ROUTE_LIMITS.maxEvents,
    }
    this.info = Object.freeze({
      name: options.name ?? "codex-app-server",
      version: options.version ?? RUNRAIL_VERSION,
      capabilities: Object.freeze([
        ...(options.capabilities ?? [
          "sessions",
          "streaming",
          "persistent",
          "tools",
          "approvals",
          "resume",
          "fork",
          "models",
          "thinking",
          "sandbox",
          "reload",
          "compact",
        ]),
      ].sort()),
    })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (this.closed) throw commandError("COMMAND_AGENT_INVALID", "backend is closed")
    if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096) throw commandError("COMMAND_AGENT_INVALID", "session cwd is invalid")
    const id = input.sessionId ?? `${this.info.name}-${++this.sequence}`
    if (!validId(id) || this.sessions.has(id)) throw commandError("COMMAND_AGENT_INVALID", "session id is invalid or already exists")
    if (this.sessionId !== undefined) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server backend supports one Runrail session")

    const snapshot = makeSnapshot(id, this.info.name, input.cwd, "idle", -1, this.info.capabilities)
    this.sessions.set(id, snapshot)
    this.sessionId = id
    this.eventSequence = -1
    return snapshot
  }

  /**
   * The server and its thread start with the first thing that needs them, so opening a session
   * runs no vendor process. A fault here belongs to that turn; the session stays for a retry.
   */
  private async ensureThread(session: AgentSessionSnapshot): Promise<void> {
    await this.ensureProcess(session.cwd)
    if (this.vendorThreadId !== undefined) return
    try {
      const stored = await this.storedThread(session.id)
      if (stored?.fork === true) {
        await this.forkStoredThread(session.id, stored.vendorSessionId, session.cwd)
        return
      }
      if (stored !== undefined && await this.resumeStoredThread(stored.vendorSessionId, session.cwd)) {
        await this.checkBrowserTools(session.id, stored.vendorSessionId)
        return
      }
      const dynamicTools = [
        ...(this.commandOptions.browser === undefined ? [] : BROWSER_TOOL_SPECS),
        ...(this.commandOptions.threads === undefined ? [] : THREADS_TOOL_SPECS),
        ...(this.commandOptions.computer === undefined ? [] : COMPUTER_TOOL_SPECS),
        ...(this.commandOptions.images === undefined ? [] : IMAGE_TOOL_SPECS),
        ...(this.commandOptions.connectors?.tools ?? []),
      ].map((spec) => ({ type: "function", name: spec.name, description: spec.description, inputSchema: spec.inputSchema }))
      const result = await this.request<Record<string, unknown>>("thread/start", { cwd: session.cwd, ...this.threadParameters(), ...(dynamicTools.length === 0 ? {} : { dynamicTools }) })
      this.noteReviewer(result)
      const thread = record(result.thread)
      const vendorThreadId = text(thread.id)
      if (vendorThreadId === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server thread identity is invalid")
      this.vendorThreadId = vendorThreadId
      await this.rememberThread(session.id, vendorThreadId)
      if (this.commandOptions.browser !== undefined) await this.commandOptions.browserThreads?.save(session.id, vendorThreadId).catch(() => undefined)
    } catch (error) {
      await this.stopProcess()
      throw normalizeError(error, "Codex app-server thread could not start")
    }
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    return this.run(input)
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    const active = this.active
    if (active === undefined) return
    active.cancelled = boundedReason(reason)
    if (active.vendorTurnId !== undefined && this.vendorThreadId !== undefined) {
      try {
        await this.request("turn/interrupt", { threadId: this.vendorThreadId, turnId: active.vendorTurnId }, 2_000)
      } catch {
        // A vendor process that does not acknowledge interruption is terminated
        // below; it must never remain alive after the caller cancels a turn.
      }
    }
    await this.stopProcess()
    if (this.active === active) {
      this.pushEvent(this.makeEvent("session.stopped", { reason: active.cancelled }), active)
      this.finishActive(active)
    }
    // Closed while the turn was being interrupted: an abort's cancel runs unawaited, so it must not throw.
    if (this.sessions.has(sessionId)) this.sessions.set(sessionId, this.currentSnapshot(session.id))
  }

  async interrupt(sessionId: string, reason = "interrupted"): Promise<void> {
    const session = this.requireSession(sessionId)
    const active = this.active
    if (active === undefined || active.vendorTurnId === undefined || this.vendorThreadId === undefined) throw commandError("COMMAND_AGENT_INVALID", "no active Codex turn can be interrupted")
    await this.request("turn/interrupt", { threadId: this.vendorThreadId, turnId: active.vendorTurnId })
    active.cancelled = boundedReason(reason)
  }

  /**
   * Guidance for the running turn through Codex's own `turn/steer`, which Codex reads at its next
   * step. Codex checks that the turn it names is still the one running, so guidance never lands in
   * a later turn. False when no turn of ours is running or Codex refuses it; the caller then queues
   * it, or drops it when it asked for the running turn only.
   */
  async steerAsync(sessionId: string, message: string): Promise<boolean> {
    this.requireSession(sessionId)
    const active = this.active
    const threadId = this.vendorThreadId
    if (active === undefined || active.cancelled !== undefined || active.compaction !== undefined || active.vendorTurnId === undefined || threadId === undefined) return false
    if (typeof message !== "string" || message.length === 0 || message.length > MAX_STEER_CHARS || message.includes("\0")) return false
    try {
      const result = await this.request<Record<string, unknown>>("turn/steer", { threadId, expectedTurnId: active.vendorTurnId, input: [{ type: "text", text: message, text_elements: [] }] }, STEER_TIMEOUT_MS)
      return text(record(result).turnId) === active.vendorTurnId
    } catch {
      return false
    }
  }

  async resume(sessionId: string): Promise<AgentSessionSnapshot> {
    const session = this.requireSession(sessionId)
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot resume while a turn is active")
    await this.ensureThread(session)
    if (!this.processThreadResumed) await this.resumeVendorThread()
    const snapshot = makeSnapshot(session.id, session.backend, session.cwd, "idle", session.lastSeq, session.capabilities, session.createdAt)
    this.sessions.set(session.id, snapshot)
    return snapshot
  }

  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    const session = this.requireSession(input.sessionId)
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot fork during an active Codex turn")
    const store = this.commandOptions.vendorSessions
    // Without a store the forked thread's id would be lost, and opening the copy would start afresh.
    if (store === undefined) throw commandError("COMMAND_AGENT_UNSUPPORTED", "fork needs a store for the conversation id")
    const targetSessionId = input.targetSessionId ?? `${session.id}-fork-${++this.sequence}`
    if (!validId(targetSessionId) || targetSessionId === session.id) throw commandError("COMMAND_AGENT_INVALID", "fork target session id is invalid")
    await this.ensureThread(session)
    const result = await this.request<Record<string, unknown>>("thread/fork", { threadId: this.vendorThreadId, excludeTurns: true })
    const thread = record(result.thread)
    const vendorForkId = text(thread.id)
    if (vendorForkId === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex fork returned an invalid thread")
    // Kept for the target, so a session opened with that id continues the forked thread.
    await store.save(targetSessionId, vendorForkId)
    return Object.freeze({ sessionId: targetSessionId, parentSessionId: session.id })
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    this.requireSession(sessionId)
    this.nextModel = boundedValue(model, "model", 256)
    this.model = this.nextModel
  }

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.requireSession(sessionId)
    // The same mapping as at launch: Off and Min run as Low.
    const effort = effortFromThinking(thinking)
    if (effort === undefined) throw commandError("COMMAND_AGENT_INVALID", "thinking is invalid")
    this.effort = codexEffort(effort)
  }

  async setSandbox(sessionId: string, sandbox: string): Promise<void> {
    this.requireSession(sessionId)
    if (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") throw commandError("COMMAND_AGENT_INVALID", "Codex sandbox mode is invalid")
    this.nextSandbox = sandbox
  }

  async configureMcp(sessionId: string, _configuration: unknown): Promise<void> {
    this.requireSession(sessionId)
    throw commandError("COMMAND_AGENT_UNSUPPORTED", "Codex app-server MCP reconfiguration is not exposed by this adapter")
  }

  async resolveApproval(sessionId: string, approvalId: string, approved: boolean, reason?: string): Promise<boolean | undefined> {
    const session = this.requireSession(sessionId)
    const pending = this.approvals.get(approvalId)
    if (pending === undefined) return false
    if (approved && this.approvalNeedsAnswers(sessionId, approvalId)) throw commandError("COMMAND_AGENT_INVALID", QUESTION_NEEDS_ANSWERS)
    // A declined question gets no answers; Codex goes on without them.
    const answers = (pending.kind === "question" || pending.kind === "elicitation") && approved ? pending.answers : undefined
    const response = pending.elicitation !== undefined
      ? codexElicitationResult(elicitationAnswer(pending.elicitation, approved, answers))
      : pending.kind === "question"
        ? codexAnswerResult(answers ?? {})
        : pending.kind === "permissions"
          ? { permissions: approved ? pending.permissions ?? {} : {}, scope: "turn" }
          : pending.method === "execCommandApproval" || pending.method === "applyPatchApproval"
            ? { decision: approved ? "approved" : { denied: { rejection: declinedMessage(reason) } } }
            : { decision: approved ? "accept" : "decline" }
    // Gone before the answer is written, so Codex's "resolved" notice for it finds nothing to withdraw.
    this.approvals.delete(approvalId)
    await this.writeMessage({ id: pending.id, result: response })
    const active = this.active
    const recorded = answers === undefined || pending.questions === undefined ? undefined : recordedAnswers(pending.questions, answers)
    if (active !== undefined) this.pushEvent(this.makeEvent("approval.resolved", { turnId: pending.turnId, approvalId, approved, ...(reason === undefined ? {} : { reason: boundedReason(reason) }), ...(recorded === undefined ? {} : { answers: recorded }) }), active)
    this.sessions.set(session.id, this.currentSnapshot(session.id))
    return true
  }

  /** A question waiting on answers it has not been given, which approving alone cannot settle. */
  approvalNeedsAnswers(sessionId: string, approvalId: string): boolean {
    this.requireSession(sessionId)
    const pending = this.approvals.get(approvalId)
    return pending?.kind === "question" && pending.answers === undefined
  }

  /**
   * The person's answers to a question about to be approved. Answers that do not fit its questions
   * are refused here, so the question stays waiting for ones that do.
   */
  setApprovalAnswers(sessionId: string, approvalId: string, answers: ApprovalAnswers, followUp?: FollowUp): boolean {
    this.requireSession(sessionId)
    const pending = this.approvals.get(approvalId)
    if (pending?.questions === undefined) return false
    // Codex's answer holds only answers; it has no way to hear "ask me more".
    if (followUp !== undefined) throw commandError("COMMAND_AGENT_INVALID", FOLLOW_UP_UNSUPPORTED)
    const mismatch = pending.elicitation === undefined ? answersMismatch(pending.questions, answers) : elicitationMismatch(pending.elicitation, answers)
    if (mismatch !== undefined) throw commandError("COMMAND_AGENT_INVALID", `answers do not fit the questions: ${mismatch}`)
    pending.answers = answers
    return true
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId)
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    this.requireSession(sessionId)
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot reload while a Codex turn is active")
    await this.stopProcess()
    return Object.freeze({ revision: `${this.info.version}:reload`, loaded: Object.freeze([]), disabled: Object.freeze([]), rolledBack: false })
  }

  async close(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    if (this.active !== undefined) await this.cancel(sessionId, "closed")
    await this.stopProcess()
    this.sessions.delete(sessionId)
    this.sessionId = undefined
    this.vendorThreadId = undefined
    this.closed = true
  }

  /**
   * Runs Codex's own compaction between turns. Codex runs it as a turn of its own and takes no
   * input meanwhile; sent during a turn it interrupts that turn, so it is refused then.
   */
  async compact(sessionId: string, reason: CompactionReason = "manual"): Promise<AgentEvent> {
    const session = this.requireSession(sessionId)
    if (!COMPACTION_REASONS.has(reason)) throw commandError("COMMAND_AGENT_INVALID", "compaction reason is invalid")
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot compact while a turn is active")
    // Codex compacts an empty thread too, spending a model call on nothing.
    if ((this.vendorThreadId ?? (await this.storedThread(session.id))?.vendorSessionId) === undefined) throw commandError("COMMAND_AGENT_INVALID", "the conversation has nothing to compact yet")
    this.starting = true
    try {
      await this.ensureThread(session)
    } finally {
      this.starting = false
    }
    const turn: AppServerTurn = { sessionId: session.id, queue: new EventQueue(), controller: new AbortController(), message: "", textByItem: new Map(), compaction: reason, eventCount: 0, refused: new Map() }
    this.active = turn
    this.outputBytes = 0
    turn.timer = setTimeout(() => {
      turn.cancelled = "timeout"
      void this.cancel(session.id, "timeout")
    }, this.options.turnTimeoutMs)
    try {
      await this.request("thread/compact/start", { threadId: this.requireVendorThreadId() })
    } catch (error) {
      this.failActive(normalizeError(error, "Codex could not start compacting"))
      throw normalizeError(error, "Codex could not start compacting")
    }
    let compacted: AgentEvent | undefined
    for await (const event of turn.queue) {
      if (event.type === "memory.compacted") compacted = event
      else if (event.type === "session.stopped") throw commandError(turn.cancelled === "timeout" ? "COMMAND_AGENT_TIMEOUT" : "COMMAND_AGENT_CANCELLED", "Codex compaction was stopped")
      else if (event.type === "session.failed") throw commandError("COMMAND_AGENT_FAILED", "Codex could not compact the conversation")
    }
    if (compacted === undefined) throw commandError("COMMAND_AGENT_FAILED", "Codex could not compact the conversation")
    return compacted
  }

  /** What Codex says now about the plan, with the last context reading. No process is started for it. */
  async readUsage(sessionId: string): Promise<RunrailUsageReading> {
    this.requireSession(sessionId)
    if (this.child === undefined || !this.initialized) return {}
    const plan = await this.readPlanLimits()
    return Object.freeze({ ...(this.lastContext === undefined ? {} : { context: this.lastContext }), ...(plan === undefined ? {} : { plan }) })
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

  private async startTurn(session: AgentSessionSnapshot, message: string, signal?: AbortSignal): Promise<AppServerTurn> {
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "agent session is already running")
    this.starting = true
    try {
      await this.ensureThread(session)
    } finally {
      this.starting = false
    }
    const turn: AppServerTurn = { sessionId: session.id, queue: new EventQueue(), controller: new AbortController(), message, textByItem: new Map(), eventCount: 0, refused: new Map() }
    this.active = turn
    this.outputBytes = 0
    this.updateSessionStatus(session.id, "running")
    if (!this.sessionStarted) {
      this.sessionStarted = true
      this.pushEvent(this.makeEvent("session.started", { snapshot: this.currentSnapshot(session.id) }), turn)
    }
    turn.timer = setTimeout(() => {
      turn.cancelled = "timeout"
      void this.cancel(session.id, "timeout")
    }, this.options.turnTimeoutMs)
    const abort = (): void => { turn.controller.abort(); void this.cancel(session.id, "cancelled") }
    turn.cleanup = () => signal?.removeEventListener("abort", abort)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    try {
      const params: Record<string, unknown> = {
        threadId: this.requireVendorThreadId(),
        input: [{ type: "text", text: message, text_elements: [] }],
        ...(this.nextModel === undefined ? {} : { model: this.nextModel }),
        // Sent with every turn: the thread does not take an effort when it starts.
        ...(this.effort === undefined ? {} : { effort: codexEffortFor(this.effort, this.listedEfforts.get(this.model ?? this.defaultModel ?? "")) }),
        ...(this.nextSandbox === undefined ? {} : { sandboxPolicy: sandboxPolicy(this.nextSandbox, session.cwd, this.launch.addDirs) }),
      }
      this.nextModel = undefined
      this.nextSandbox = undefined
      const response = await this.request<Record<string, unknown>>("turn/start", params)
      const vendorTurn = record(response.turn)
      const vendorTurnId = text(vendorTurn.id)
      if (vendorTurnId === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex turn identity is invalid")
      turn.vendorTurnId = vendorTurnId
      return turn
    } catch (error) {
      this.failActive(normalizeError(error, "Codex turn could not start"))
      throw normalizeError(error, "Codex turn could not start")
    }
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
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">
    try {
      child = Bun.spawn([this.commandOptions.command ?? "codex", ...(this.commandOptions.args ?? ["app-server", "--listen", "stdio://"]), ...(this.commandOptions.apiKey === undefined ? [] : ["-c", 'cli_auth_credentials_store="ephemeral"'])], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        env: await this.commandEnvironment(),
      })
    } catch (caught) {
      if (isMissingCommand(caught)) throw commandError("COMMAND_AGENT_NOT_FOUND", "Codex app-server command was not found")
      throw commandError("COMMAND_AGENT_FAILED", "Codex app-server command could not start")
    }
    this.child = child
    this.initialized = false
    this.processThreadResumed = false
    // Sub-agent threads run inside the server process, so a new one has none yet.
    this.subAgents.clear()
    void this.readOutput(child)
    try {
      await this.request("initialize", {
        clientInfo: { name: "runrail", title: "Runrail", version: RUNRAIL_VERSION },
        // The experimental API carries `thread/backgroundTerminals/*`, which stops a command Codex left running.
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      await this.writeMessage({ method: "initialized" })
      if (this.commandOptions.apiKey !== undefined) await this.signInWithKey(this.commandOptions.apiKey)
      this.initialized = true
      // Both feed only live frames, which a run without a listener never sends.
      if (this.commandOptions.onLive !== undefined) {
        void this.readPlanLimits()
        void this.readConfig(cwd)
      }
      void this.readModels()
      if (this.vendorThreadId !== undefined) await this.resumeVendorThread()
    } catch (error) {
      await this.stopProcess()
      throw normalizeError(error, "Codex app-server could not initialize")
    }
  }

  private async signInWithKey(read: () => Promise<string>): Promise<void> {
    let apiKey: string
    try {
      apiKey = await read()
    } catch {
      throw commandError("COMMAND_AGENT_CREDENTIALS_UNAVAILABLE", "harness credentials are unavailable")
    }
    if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > 16 * 1024) throw commandError("COMMAND_AGENT_CREDENTIALS_UNAVAILABLE", "harness credentials are unavailable")
    try {
      await this.request("account/login/start", { type: "apiKey", apiKey })
    } catch {
      // Codex's own message is not passed on: it may repeat what it was sent.
      throw commandError("COMMAND_AGENT_AUTH_FAILED", "Codex refused the API key")
    }
  }

  /** The account's usage so far, so it shows before the first update. An API-key login has none. */
  private async readPlanLimits(): Promise<RunrailPlanLimitsFrame | undefined> {
    if (this.planReadAt !== undefined && Date.now() - this.planReadAt < PLAN_READ_INTERVAL_MS) return this.latestPlan
    this.planReadAt = Date.now()
    try {
      const result = await this.request<Record<string, unknown>>("account/rateLimits/read", undefined, PLAN_LIMITS_TIMEOUT_MS)
      const limits = codexPlanLimits(record(result).rateLimits)
      if (limits !== undefined) {
        this.latestPlan = limits
        emitLive(this.commandOptions, limits)
      }
    } catch {
      // Usage is shown when Codex has it; a server without the method, or no plan, shows none.
    }
    return this.latestPlan
  }

  /** Codex's own auto-compaction limit. It has none by default, and then the point is not shown. */
  private async readConfig(cwd: string): Promise<void> {
    try {
      const result = await this.request<Record<string, unknown>>("config/read", { cwd }, PLAN_LIMITS_TIMEOUT_MS)
      const limit = record(record(result).config).model_auto_compact_token_limit
      this.autoCompactAt = safeInteger(limit) && limit > 0 && limit <= MAX_TOKENS ? limit : undefined
    } catch {
      this.autoCompactAt = undefined
    }
  }

  /** Which levels each model takes, so a level one does not list runs as the nearest it does. */
  private async readModels(): Promise<void> {
    try {
      const result = await this.request<unknown>("model/list", {}, PLAN_LIMITS_TIMEOUT_MS)
      for (const model of codexModels(result) ?? []) {
        if (model.efforts !== undefined) this.listedEfforts.set(model.id, model.efforts)
        if (model.default === true) this.defaultModel = model.id
      }
    } catch {
      // Without the list, the level goes to Codex as chosen.
    }
  }

  private async resumeVendorThread(): Promise<void> {
    const vendorThreadId = this.requireVendorThreadId()
    const result = await this.request<Record<string, unknown>>("thread/resume", { threadId: vendorThreadId, excludeTurns: true, ...this.threadParameters() })
    const thread = record(result.thread)
    const resumedId = text(thread.id)
    if (resumedId === undefined || resumedId !== vendorThreadId) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex resume returned a different thread")
    this.noteReviewer(result)
    this.processThreadResumed = true
  }

  /** What the thread is started or resumed with; a later `setModel` replaces the launch model. */
  private threadParameters(): Record<string, unknown> {
    return { ...codexThreadParameters(this.launch), ...(this.model === undefined ? {} : { model: this.model }) }
  }

  private async storedThread(sessionId: string): Promise<VendorSessionEntry | undefined> {
    let stored: VendorSessionEntry | undefined
    try {
      stored = await vendorSessionEntry(this.commandOptions.vendorSessions, sessionId)
    } catch {
      stored = undefined
    }
    if (stored !== undefined) return stored
    const threadId = this.launch.resume
    return isVendorSessionId(threadId) ? Object.freeze({ vendorSessionId: threadId, fork: false }) : undefined
  }

  /** A thread from Codex's own history is continued as a copy, so that history is never written. */
  private async forkStoredThread(sessionId: string, threadId: string, cwd: string): Promise<void> {
    const result = await this.request<Record<string, unknown>>("thread/fork", { threadId, cwd, excludeTurns: true, ...this.threadParameters() })
    const vendorThreadId = text(record(result.thread).id)
    if (vendorThreadId === undefined || vendorThreadId === threadId) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex fork returned an invalid thread")
    this.noteReviewer(result)
    this.vendorThreadId = vendorThreadId
    this.processThreadResumed = true
    await this.rememberThread(sessionId, vendorThreadId)
    await this.checkBrowserTools(sessionId, vendorThreadId)
  }

  /**
   * Continue the thread an earlier engine process left behind. A thread the server no longer
   * has is forgotten, and the caller starts a new one.
   */
  /** A Codex too old for a reviewer, or a policy that forbids it, answers without `auto_review`. */
  private noteReviewer(result: Record<string, unknown>): void {
    // `guardian_subagent` is the reviewer's older name.
    if (this.launch.permissionMode === "auto") this.reviewerRefused = result.approvalsReviewer !== "auto_review" && result.approvalsReviewer !== "guardian_subagent"
  }

  private async resumeStoredThread(threadId: string, cwd: string): Promise<boolean> {
    try {
      const result = await this.request<Record<string, unknown>>("thread/resume", { threadId, cwd, excludeTurns: true, ...this.threadParameters() })
      if (text(record(result.thread).id) === threadId) {
        this.noteReviewer(result)
        this.vendorThreadId = threadId
        this.processThreadResumed = true
        return true
      }
    } catch (error) {
      if (this.child === undefined) throw error
    }
    this.vendorThreadId = undefined
    return false
  }

  /** Tells the desktop when the browser is on but this conversation has no browser tools to use it with. */
  private async checkBrowserTools(sessionId: string, threadId: string): Promise<void> {
    const store = this.commandOptions.browserThreads
    if (this.commandOptions.browser === undefined || store === undefined) return
    let marked: string | undefined
    try {
      marked = await store.load(sessionId)
    } catch {
      marked = undefined
    }
    if (marked !== threadId) emitLive(this.commandOptions, { type: "browser.notice", code: "BROWSER_TOOLS_UNAVAILABLE" })
  }

  /** Where Codex's thread stood once the last turn ended. */
  vendorMark(sessionId: string): { readonly session: string; readonly at: string } | undefined {
    return sessionId === this.sessionId ? this.lastTurn : undefined
  }

  /**
   * An exact rewind: Codex drops `turn` and every later turn from the thread's history
   * (`thread/revert`, which leaves files alone). Returns the step that does it, which the caller
   * takes only once its own transcript is cut and the old pointers are forgotten, so a failure
   * before then never leaves the thread shorter than the transcript. This session's server has
   * stopped by then, so the step runs a short-lived one of its own. Undefined when Codex cannot.
   */
  async prepareRewind(sessionId: string, target: { readonly turn?: { readonly session: string; readonly at: string } }): Promise<(() => Promise<void>) | undefined> {
    const threadId = this.vendorThreadId
    const turn = target.turn
    const store = this.commandOptions.vendorSessions
    const cwd = this.sessions.get(sessionId)?.cwd
    if (store === undefined || cwd === undefined || sessionId !== this.sessionId || threadId === undefined || turn === undefined || turn.session !== threadId || this.active !== undefined) return undefined
    const { onLive: _live, onMetadata: _metadata, ...options } = this.commandOptions
    return async () => {
      const server = new CodexAppServerBackend(options)
      try {
        await server.revertThread(threadId, turn.at, cwd)
      } finally {
        await server.stopProcess()
      }
      // Unlike a turn's own note of the thread, this one must land: without it the thread starts afresh with no recap.
      await store.save(sessionId, threadId)
    }
  }

  private async revertThread(threadId: string, beforeTurnId: string, cwd: string): Promise<void> {
    await this.ensureProcess(cwd)
    if (!(await this.resumeStoredThread(threadId, cwd))) throw commandError("COMMAND_AGENT_FAILED", "Codex no longer has the thread")
    await this.request("thread/revert", { threadId, beforeTurnId })
  }

  private async rememberThread(sessionId: string, vendorThreadId: string): Promise<void> {
    const store = this.commandOptions.vendorSessions
    if (store === undefined || !isVendorSessionId(vendorThreadId)) return
    try {
      await store.save(sessionId, vendorThreadId)
    } catch {
      // Losing the id only costs continuity after a restart; it never fails the session.
    }
  }

  private async readOutput(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    let buffer = ""
    const stderrPromise = this.drainStderr(child)
    try {
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) {
        if (this.child !== child) return
        const value = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
        this.outputBytes += Buffer.byteLength(value, "utf8")
        if (this.outputBytes > this.options.maxOutputBytes) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server output exceeded its byte limit")
        buffer += value
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          if (line.trim().length > 0) this.acceptLine(line)
          if (this.child !== child) return
        }
      }
      if (this.child !== child) return
      buffer += decoder.decode()
      if (buffer.trim().length > 0) this.acceptLine(buffer.trim())
      await child.exited
      const stderrOverflow = await stderrPromise
      if (this.child === child && this.active !== undefined && this.active.cancelled === undefined) {
        this.failActive(stderrOverflow
          ? commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server diagnostics exceeded their byte limit")
          : commandError("COMMAND_AGENT_FAILED", "Codex app-server exited before a terminal event"))
      }
    } catch (caught) {
      const failure = normalizeError(caught, "Codex app-server output is invalid")
      if (this.child === child) {
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(failure)
        }
        this.pending.clear()
        if (this.active !== undefined && this.active.cancelled === undefined) this.failActive(failure)
      }
      await terminateProcessTree(child)
    } finally {
      if (this.child === child) {
        this.child = undefined
        this.initialized = false
        this.processThreadResumed = false
      }
    }
  }

  private async drainStderr(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<boolean> {
    let bytes = 0
    let overflow = false
    try {
      for await (const chunk of child.stderr) {
        bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength
        if (bytes > this.options.maxOutputBytes) overflow = true
      }
    } catch {
      overflow = true
    }
    return overflow
  }

  private acceptLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server output is not valid JSONL")
    }
    const message = record(value)
    if (message.id !== undefined && message.method === undefined) {
      const key = rpcKey(message.id)
      const pending = this.pending.get(key)
      // A response that arrives after its request timed out has nobody waiting for it.
      if (pending === undefined) return
      this.pending.delete(key)
      clearTimeout(pending.timer)
      if (message.error !== undefined) {
        const limitMessage = harnessRateLimitMessage(message.error, "Codex")
        const words = codexWords(message.error)
        pending.reject(commandError(limitMessage === undefined ? "COMMAND_AGENT_FAILED" : "COMMAND_AGENT_RATE_LIMITED", limitMessage ?? (words === undefined ? "Codex app-server request failed" : `Codex refused the request: ${words}`)))
      } else pending.resolve(message.result)
      return
    }
    const method = text(message.method)
    if (method === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server message has no method")
    if (message.id !== undefined) {
      this.handleServerRequest(method, message.id, message.params)
      return
    }
    this.handleNotification(method, message.params)
  }

  private handleServerRequest(method: string, id: unknown, params: unknown): void {
    if (!isRpcId(id)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server request id is invalid")
    // Neither needs a turn: Codex asks for the time, or for a sign-in, between turns as well.
    if (method === "currentTime/read") {
      void this.writeMessage({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }).catch(() => undefined)
      return
    }
    if (method === "account/chatgptAuthTokens/refresh") {
      // Runrail signs Codex in with a key or leaves it its own login; it never hands Codex ChatGPT tokens.
      this.refuseRequest(id, method, "Runrail holds no ChatGPT tokens for Codex. Sign in to Codex again with `codex login`")
      return
    }
    if (method === "mcpServer/elicitation/request") {
      this.askElicitation(id, method, record(params), this.active)
      return
    }
    const active = this.active
    if (active === undefined) {
      this.refuseRequest(id, method, REFUSED_NO_TURN)
      return
    }
    if (method === "item/tool/call") {
      void this.answerToolCall(id, params, active)
      return
    }
    if (method === "item/permissions/requestApproval") {
      const input = record(params)
      const origin = this.requestOrigin(input, active)
      if ("refused" in origin) {
        this.refuseRequest(id, method, origin.refused)
        return
      }
      const approvalId = text(input.approvalId) ?? `codex-request-${String(id)}`
      if (this.approvals.has(approvalId)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server approval id duplicated")
      const pending: PendingApproval = { id, approvalId, method, turnId: origin.turnId, kind: "permissions", permissions: permissionProfile(input.permissions) }
      this.approvals.set(approvalId, pending)
      const reason = requestReason(text(input.reason), origin.agent)
      this.askPerson({
        turnId: pending.turnId,
        approvalId,
        action: permissionSummary(pending.permissions) ?? "permission",
        capability: "sandbox.permission",
        ...(reason === undefined ? {} : { reason }),
      }, origin.agent, active)
      return
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "execCommandApproval" || method === "applyPatchApproval") {
      const input = record(params)
      const origin = this.requestOrigin(input, active)
      if ("refused" in origin) {
        this.refuseRequest(id, method, origin.refused)
        return
      }
      const approvalId = text(input.approvalId) ?? `codex-request-${String(id)}`
      if (this.approvals.has(approvalId)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server approval id was duplicated")
      const pending: PendingApproval = { id, approvalId, method, turnId: origin.turnId, kind: "decision" }
      this.approvals.set(approvalId, pending)
      const isFileChange = method.includes("fileChange") || method.includes("applyPatch")
      const reason = requestReason(text(input.reason), origin.agent)
      this.askPerson({
        turnId: pending.turnId,
        approvalId,
        action: (isFileChange ? fileChangeSummary(input) : commandSummary(input)) ?? (isFileChange ? "file_change" : "command"),
        capability: isFileChange ? "filesystem.write" : "process.exec",
        ...(reason === undefined ? {} : { reason }),
      }, origin.agent, active)
      return
    }
    if (method === "item/tool/requestUserInput") {
      const input = record(params)
      const questions = codexQuestions(input)
      const origin = this.requestOrigin(input, active)
      const approvalId = `codex-request-${String(id)}`
      if (questions !== undefined && "refused" in origin) {
        this.refuseRequest(id, method, origin.refused)
        return
      }
      if (questions !== undefined && "turnId" in origin && !this.approvals.has(approvalId)) {
        this.approvals.set(approvalId, { id, approvalId, method, turnId: origin.turnId, kind: "question", questions })
        this.askPerson({ turnId: origin.turnId, approvalId, action: QUESTION_ACTION, capability: QUESTION_CAPABILITY, reason: requestReason(questionsReason(questions), origin.agent), questions }, origin.agent, active)
        return
      }
    }
    // Refused, never granted: the server gets a plain "method not found" and the turn goes on.
    void this.writeMessage({ id, error: { code: -32601, message: "Runrail does not expose this Codex server request" } }).catch(() => undefined)
  }

  /**
   * An MCP server's form, asked as questions, and always answered in MCP's terms: cancel when
   * nobody can be asked, decline when Runrail cannot show the form (the person sees it and why).
   */
  private askElicitation(id: RpcId, method: string, input: Record<string, unknown>, active: AppServerTurn | undefined): void {
    const origin = active === undefined ? undefined : this.requestOrigin(input, active)
    const approvalId = `codex-request-${String(id)}`
    if (active === undefined || origin === undefined || "refused" in origin || this.approvals.has(approvalId)) {
      void this.writeMessage({ id, result: codexElicitationResult({ action: "cancel" }) }).catch(() => undefined)
      const why = active === undefined ? REFUSED_NO_TURN : origin !== undefined && "refused" in origin ? origin.refused : undefined
      if (why !== undefined) this.tellRefusal(refusalMessage(method, why))
      return
    }
    const asked = mcpElicitation(input)
    const shown = { turnId: origin.turnId, approvalId, ...asked.approval, reason: requestReason(asked.approval.reason, origin.agent) }
    const form = asked.form
    if (form === undefined) {
      this.askPerson(shown, origin.agent, active)
      this.pushEvent(this.makeEvent("approval.resolved", { turnId: origin.turnId, approvalId, approved: false, reason: boundedReason(asked.declined ?? "declined") }), active)
      void this.writeMessage({ id, result: codexElicitationResult({ action: "decline" }) }).catch(() => undefined)
      return
    }
    this.approvals.set(approvalId, { id, approvalId, method, turnId: origin.turnId, kind: "elicitation", elicitation: form, ...(form.questions.length === 0 ? {} : { questions: form.questions }) })
    this.askPerson(shown, origin.agent, active)
  }

  /** Codex reads an error reply as a denial and keeps only its own fixed words, so the person is told why here. */
  private refuseRequest(id: RpcId, method: string, why: string): void {
    const message = refusalMessage(method, why)
    void this.writeMessage({ id, error: { code: -32000, message } }).catch(() => undefined)
    this.tellRefusal(message)
  }

  private tellRefusal(message: string): void {
    const turnId = this.active?.vendorTurnId
    emitLive(this.commandOptions, { type: "request.refused", source: "codex", ...(turnId === undefined ? {} : { turnId }), message })
  }

  /** A request from this thread's running turn, or from a sub-agent under it, which the person answers within that turn. */
  private requestOrigin(input: Record<string, unknown>, active: AppServerTurn): RequestOrigin {
    // The older approval requests name the thread as a conversation.
    const threadId = text(input.threadId) ?? text(input.conversationId)
    if (threadId !== undefined && this.vendorThreadId !== undefined && threadId !== this.vendorThreadId) {
      const agent = this.subAgentOf(threadId)
      if (agent === undefined) return { refused: "it came from a Codex thread that is neither this session's nor one of its sub-agents" }
      return { turnId: active.vendorTurnId ?? "turn", agent }
    }
    const turnId = text(input.turnId) ?? active.vendorTurnId ?? "turn"
    if (active.vendorTurnId !== undefined && turnId !== active.vendorTurnId) return { refused: "it belongs to a Codex turn that has already ended" }
    return { turnId }
  }

  /** Shows a request to the person; one a sub-agent made sits under that agent's spawn call. */
  private askPerson(payload: Record<string, unknown>, agent: SubAgentThread | undefined, active: AppServerTurn): void {
    const event = this.makeEvent("approval.required", payload)
    this.pushEvent(event, active)
    if (agent?.callId !== undefined) emitLive(this.commandOptions, { type: "lineage", parentCallId: agent.callId, eventSeq: event.seq })
  }

  /** The sub-agent a thread belongs to, when it descends from this session's thread. */
  private subAgentOf(threadId: string): SubAgentThread | undefined {
    const agent = this.subAgents.get(threadId)
    let parent = agent?.parentThreadId
    for (let depth = 0; parent !== undefined && depth < MAX_SUB_AGENTS; depth++) {
      if (parent === this.vendorThreadId) return agent
      parent = this.subAgents.get(parent)?.parentThreadId
    }
    return undefined
  }

  /** Learns a sub-agent's thread, from its start or from the spawnAgent call that names it. */
  private noteSubAgent(threadId: string, parentThreadId: string | undefined, details: { readonly name?: string; readonly callId?: string }): void {
    if (parentThreadId === undefined || threadId === parentThreadId || threadId === this.vendorThreadId) return
    if (parentThreadId !== this.vendorThreadId && !this.subAgents.has(parentThreadId)) return
    const known = this.subAgents.get(threadId)
    if (known === undefined && this.subAgents.size >= MAX_SUB_AGENTS) return
    const name = details.name ?? known?.name
    const callId = details.callId ?? known?.callId
    this.subAgents.set(threadId, { parentThreadId, ...(name === undefined ? {} : { name }), ...(callId === undefined ? {} : { callId }) })
    if (callId !== undefined && known?.callId !== callId) emitLive(this.commandOptions, { type: "background.state", entry: { id: `codex:agent:${threadId}`, kind: "agent", label: name ?? "Subagent", callId, status: "running", startedAt: Date.now(), stopHint: "turn" } })
  }

  private noteSpawn(item: Record<string, unknown>): void {
    if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent" || !Array.isArray(item.receiverThreadIds)) return
    const callId = text(item.id)
    const parentThreadId = text(item.senderThreadId) ?? this.vendorThreadId
    for (const receiver of item.receiverThreadIds.slice(0, MAX_SUB_AGENTS)) {
      const threadId = text(receiver)
      if (threadId !== undefined) this.noteSubAgent(threadId, parentThreadId, callId === undefined ? {} : { callId })
    }
  }

  /** Codex settled a request on its own (the turn ended, or a question resolved itself), so nobody answers it now. */
  private withdrawRequest(params: unknown): void {
    const requestId = record(params).requestId
    if (!isRpcId(requestId)) return
    const key = rpcKey(requestId)
    for (const pending of this.approvals.values()) {
      if (rpcKey(pending.id) !== key) continue
      this.approvals.delete(pending.approvalId)
      const active = this.active
      if (active !== undefined) this.pushEvent(this.makeEvent("approval.resolved", { turnId: pending.turnId, approvalId: pending.approvalId, approved: false, withdrawn: true, reason: "Codex no longer needs an answer" }), active)
      return
    }
  }

  /** A browser, thread or connector tool call; the answer always goes back, so the turn never waits on a lost one. */
  private async answerToolCall(id: RpcId, params: unknown, active: AppServerTurn): Promise<void> {
    const input = record(params)
    // The call spends this turn's browser and connector access, so it must name this thread and turn.
    const threadId = text(input.threadId)
    const turnId = text(input.turnId)
    const foreign = threadId === undefined || threadId !== this.vendorThreadId || (active.vendorTurnId !== undefined && turnId !== active.vendorTurnId)
    if (foreign || active.controller.signal.aborted || this.active !== active) {
      await this.writeMessage({ id, result: { success: false, contentItems: [{ type: "inputText", text: "This tool call is not part of the running turn." }] } }).catch(() => undefined)
      return
    }
    const unnamespaced = input.namespace === undefined || input.namespace === null
    const spec = unnamespaced ? BROWSER_TOOL_SPECS.find((candidate) => candidate.name === input.tool) : undefined
    const threadsSpec = unnamespaced && spec === undefined ? THREADS_TOOL_SPECS.find((candidate) => candidate.name === input.tool) : undefined
    const computerSpec = unnamespaced && spec === undefined && threadsSpec === undefined ? COMPUTER_TOOL_SPECS.find((candidate) => candidate.name === input.tool) : undefined
    const imageSpec = unnamespaced && spec === undefined && threadsSpec === undefined && computerSpec === undefined ? IMAGE_TOOL_SPECS.find((candidate) => candidate.name === input.tool) : undefined
    const connectorTool = unnamespaced && spec === undefined && threadsSpec === undefined && computerSpec === undefined && imageSpec === undefined ? this.commandOptions.connectors?.tools.find((candidate) => candidate.name === input.tool) : undefined
    const failed = (message: string) => ({ success: false, contentItems: [{ type: "inputText", text: message }] })
    let response: Record<string, unknown>
    if (threadsSpec !== undefined) {
      if (this.commandOptions.threads === undefined) response = failed("The person has turned off messaging between threads.")
      else {
        try {
          const result = await this.commandOptions.threads.request(threadsSpec.action, input.arguments, active.controller.signal)
          response = { success: true, contentItems: [{ type: "inputText", text: threadsResultText(threadsSpec.action, input.arguments, result) }] }
        } catch (error) {
          response = failed(error instanceof ThreadsError ? error.message : "the other thread could not be reached")
        }
      }
    } else if (computerSpec !== undefined) {
      if (this.commandOptions.computer === undefined) response = failed("The person has turned off computer use for this thread.")
      else {
        try {
          const result = await this.commandOptions.computer.request(computerSpec.action, input.arguments, active.controller.signal)
          response = {
            success: true,
            contentItems: [
              { type: "inputText", text: computerResultText(result) },
              ...(result.image === undefined ? [] : [{ type: "inputImage", imageUrl: `data:${result.image.mediaType};base64,${result.image.dataBase64}` }]),
            ],
          }
        } catch (error) {
          response = failed(error instanceof ComputerError ? error.message : "the computer could not do that")
        }
      }
    } else if (imageSpec !== undefined) {
      if (this.commandOptions.images === undefined) response = failed("This thread has no image tool.")
      else {
        try {
          const result = await this.commandOptions.images.request(input.arguments, active.controller.signal)
          response = {
            success: true,
            contentItems: [
              { type: "inputText", text: result.text },
              ...(result.image === undefined ? [] : [{ type: "inputImage", imageUrl: `data:${result.image.mediaType};base64,${result.image.dataBase64}` }]),
            ],
          }
        } catch (error) {
          response = failed(error instanceof ImageError ? error.message : "the picture could not be made")
        }
      }
    } else if (connectorTool !== undefined && this.commandOptions.connectors !== undefined) {
      try {
        const cwd = this.sessions.get(active.sessionId)?.cwd ?? process.cwd()
        const result = await callConnector(this.commandOptions.connectors.registry, connectorTool, input.arguments, { cwd, signal: active.controller.signal })
        response = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result ?? null) }] }
      } catch (error) {
        response = failed(error instanceof ConnectorError ? error.message : "the connector could not do that")
      }
    } else if (spec === undefined) response = failed("Runrail has no tool by that name.")
    else if (this.commandOptions.browser === undefined) response = failed("The person has turned off browser use for this thread. They can turn it on in the browser tab.")
    else {
      try {
        const result = await this.commandOptions.browser.request(spec.action, input.arguments, active.controller.signal)
        response = {
          success: true,
          contentItems: [
            { type: "inputText", text: browserResultText(spec.action, result) },
            ...(result.image === undefined ? [] : [{ type: "inputImage", imageUrl: `data:${result.image.mediaType};base64,${result.image.dataBase64}` }]),
          ],
        }
      } catch (error) {
        response = failed(error instanceof BrowserError ? error.message : "the browser could not do that")
      }
    }
    await this.writeMessage({ id, result: response }).catch(() => undefined)
  }

  private handleNotification(method: string, params: unknown): void {
    // The server speaks about more than this turn: other threads, account state, and kinds of
    // notification a newer server adds. None of that belongs to the turn, so it is skipped.
    if (params === null || typeof params !== "object" || Array.isArray(params)) return
    const input = params as Record<string, unknown>
    this.background.observe(method, input)
    // Request ids are this connection's own, so a sub-agent's request is withdrawn by its id alone.
    if (method === "serverRequest/resolved") {
      this.withdrawRequest(params)
      return
    }
    const threadId = text(input.threadId)
    if (threadId !== undefined && this.vendorThreadId !== undefined && threadId !== this.vendorThreadId) {
      const agent = this.subAgentOf(threadId)
      if (agent?.callId !== undefined && this.active !== undefined) this.handleSubAgentNotification(method, input, agent.callId, this.active)
      return
    }
    const active = this.active
    if (method === "remoteControl/status/changed" || method === "mcpServer/startupStatus/updated" || method === "warning" || method === "model/rerouted" || method === "model/verification" || method === "hook/started" || method === "hook/completed" || method === "thread/status/changed" || method === "thread/queue/changed" || method === "turn/diff/updated" || method === "thread/name/updated" || method === "item/mcpToolCall/progress" || method === "item/reasoning/summaryPartAdded" || method === "item/plan/delta") return
    if (method === "turn/plan/updated") {
      this.emitPlan(input)
      return
    }
    // Account-wide, so it is passed on between turns as well.
    if (method === "account/rateLimits/updated") {
      const limits = codexPlanLimits(input.rateLimits)
      if (limits !== undefined) {
        this.latestPlan = limits.plan === undefined && this.latestPlan?.plan !== undefined ? { ...limits, plan: this.latestPlan.plan } : limits
        emitLive(this.commandOptions, limits)
      }
      if (active !== undefined) this.commandOptions.onMetadata?.({ version: 1, sessionId: this.requireSessionId(), seq: this.eventSequence + 1, kind: "rate-limit", turnId: active.vendorTurnId })
      return
    }
    if (method === "thread/started") {
      const thread = record(input.thread)
      const threadId = text(thread.id)
      if (threadId === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex thread identity is invalid")
      // Another thread starting (a sub-agent's, say) never replaces the one this session owns.
      if (this.vendorThreadId === undefined) this.vendorThreadId = threadId
      else this.noteSubAgent(threadId, text(thread.parentThreadId), { name: oneLine(thread.agentNickname, 64) ?? oneLine(thread.agentRole, 64) })
      return
    }
    if (active === undefined || !this.belongsToTurn(input, active)) return
    if (method === "turn/started") {
      const turn = record(input.turn)
      const turnId = text(turn.id) ?? active.vendorTurnId ?? "turn"
      if (active.vendorTurnId !== undefined && turnId !== active.vendorTurnId) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex turn identity changed")
      active.vendorTurnId = turnId
      if (active.compaction === undefined) {
        this.pushEvent(this.makeEvent("turn.started", { turnId, prompt: eventText(active.message) }), active)
        if (this.reviewerRefused && !this.reviewerNoticed) {
          this.reviewerNoticed = true
          emitLive(this.commandOptions, { type: REVIEWER_NOTICE, turnId, reviewer: "codex", notice: "unavailable" })
        }
      }
      return
    }
    const review = codexReview(method, input)
    if (review !== undefined) {
      const target = text(input.targetItemId)
      if (target !== undefined && (review.decision === "denied" || review.decision === "timed-out") && active.refused.size < 256) active.refused.set(target, review.decision)
      if (active.compaction === undefined) emitLive(this.commandOptions, { type: APPROVAL_REVIEWED, turnId: text(input.turnId) ?? active.vendorTurnId ?? "turn", ...review })
      return
    }
    if (method === "guardianWarning") {
      const message = codexWarning(input.message)
      if (message !== undefined && active.compaction === undefined) emitLive(this.commandOptions, { type: REVIEWER_NOTICE, turnId: active.vendorTurnId ?? "turn", reviewer: "codex", notice: "warning", message })
      return
    }
    if (method === "item/agentMessage/delta") {
      const turnId = text(input.turnId) ?? active.vendorTurnId ?? "turn"
      const itemId = text(input.itemId) ?? "assistant"
      // An empty delta carries nothing; Codex sends one at times, and it is no reason to end the session.
      if (input.delta === "") return
      const delta = input.delta
      if (typeof delta !== "string") throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex assistant delta is invalid")
      active.textByItem.set(itemId, `${active.textByItem.get(itemId) ?? ""}${delta}`)
      for (const piece of eventTextPieces(delta)) this.pushEvent(this.makeEvent("assistant.delta", { turnId, text: piece }), active)
      return
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = typeof input.delta === "string" ? input.delta : undefined
      if (delta === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex reasoning delta is invalid")
      const itemId = text(input.itemId)
      if (delta.length > 0) emitLive(this.commandOptions, { type: "reasoning.delta", turnId: text(input.turnId) ?? active.vendorTurnId ?? "turn", ...(itemId === undefined ? {} : { itemId }), text: delta })
      return
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
      const turnId = text(input.turnId) ?? active.vendorTurnId ?? "turn"
      const callId = text(input.itemId) ?? "tool"
      if (input.delta === "") return
      const delta = text(input.delta)
      if (delta === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex tool delta is invalid")
      this.pushEvent(this.makeEvent("tool.delta", { turnId, callId, text: delta }), active)
      return
    }
    if (method === "item/started") {
      const item = record(input.item)
      this.noteSpawn(item)
      const kind = text(item.type)
      if (kind === "contextCompaction") active.compacting = true
      if (kind === "commandExecution" || kind === "fileChange" || kind === "mcpToolCall" || kind === "dynamicToolCall" || kind === "collabAgentToolCall") {
        const turnId = text(input.turnId) ?? active.vendorTurnId ?? "turn"
        const callId = text(item.id) ?? "tool"
        const name = kind === "commandExecution" ? "command" : kind === "fileChange" ? "file_change" : kind === "mcpToolCall" ? text(item.tool) ?? "mcp" : kind === "dynamicToolCall" ? text(item.tool) ?? kind : kind
        const toolInput = boundToolInput(item)
        this.pushEvent(this.makeEvent("tool.started", { turnId, callId, name, ...(toolInput === undefined ? {} : { input: toolInput }) }), active)
      }
      return
    }
    if (method === "item/completed") {
      this.noteSpawn(record(input.item))
      this.handleCompletedItem(input, active)
      return
    }
    if (method === "thread/tokenUsage/updated") {
      this.emitUsageMetadata(input, active)
      return
    }
    if (method === "thread/compacted") return
    if (method === "turn/completed") {
      const turn = record(input.turn)
      const status = text(turn.status)
      if (status === "interrupted" || active.cancelled !== undefined) {
        this.pushEvent(this.makeEvent("session.stopped", { reason: active.cancelled ?? "interrupted" }), active)
      } else if (status === "failed") {
        const limitMessage = harnessRateLimitMessage(turn.error, "Codex")
        const words = codexWords(turn.error)
        this.failActive(commandError(limitMessage === undefined ? "COMMAND_AGENT_FAILED" : "COMMAND_AGENT_RATE_LIMITED", limitMessage ?? (words === undefined ? "Codex turn failed" : `Codex turn failed: ${words}`)))
      } else if (status === "completed") {
        if (this.vendorThreadId !== undefined && active.vendorTurnId !== undefined) this.lastTurn = Object.freeze({ session: this.vendorThreadId, at: active.vendorTurnId })
        if (active.compaction === undefined) this.pushEvent(this.makeEvent("session.completed", { snapshot: this.makeSnapshotFor("completed") }), active)
      } else throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex turn terminal status is invalid")
      if (this.active === active) this.finishActive(active)
      return
    }
    if (method === "error") {
      const limitMessage = harnessRateLimitMessage(input.error, "Codex")
      if (limitMessage !== undefined) {
        this.failActive(commandError("COMMAND_AGENT_RATE_LIMITED", limitMessage))
        return
      }
      // A refused key or sign-in is retried ten times over about twenty seconds; the answer will not change.
      if (refusedCredential(input)) {
        if (active.vendorTurnId !== undefined && this.vendorThreadId !== undefined) void this.request("turn/interrupt", { threadId: this.vendorThreadId, turnId: active.vendorTurnId }, 2_000).catch(() => {})
        this.failActive(commandError("COMMAND_AGENT_AUTH_FAILED", "Codex refused its key or sign-in"))
        return
      }
      // A retry the server will make itself is not the end of the turn.
      if (input.willRetry === true) return
      const words = codexWords(input.error)
      this.failActive(commandError("COMMAND_AGENT_FAILED", words === undefined ? "Codex app-server reported an error" : `Codex reported an error: ${words}`))
      return
    }
  }

  private handleSubAgentNotification(method: string, input: Record<string, unknown>, parentCallId: string, active: AppServerTurn): void {
    const turnId = text(input.turnId) ?? (input.turn === undefined ? undefined : text(record(input.turn).id)) ?? parentCallId
    const itemId = text(input.itemId) ?? (input.item === undefined ? undefined : text(record(input.item).id))
    const push = (event: AgentEvent): void => {
      if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.delta") {
        emitLive(this.commandOptions, { type: "lineage", parentCallId, callId: event.callId })
      } else emitLive(this.commandOptions, { type: "lineage", parentCallId, eventSeq: event.seq })
      this.pushEvent(event, active)
    }
    if (method === "item/agentMessage/delta") {
      if (typeof input.delta !== "string") throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex subagent delta is invalid")
      if (itemId !== undefined) {
        const key = `${text(input.threadId)}:${itemId}`
        active.textByItem.set(key, `${active.textByItem.get(key) ?? ""}${input.delta}`)
      }
      for (const piece of eventTextPieces(input.delta)) push(this.makeEvent("assistant.delta", { turnId, text: piece }))
    } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      if (typeof input.delta !== "string") throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex subagent reasoning is invalid")
      if (input.delta.length > 0) emitLive(this.commandOptions, { type: "reasoning.delta", turnId, parentCallId, ...(itemId === undefined ? {} : { itemId }), text: input.delta })
    } else if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
      if (itemId === undefined || typeof input.delta !== "string") throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex subagent tool delta is invalid")
      for (const piece of eventTextPieces(input.delta)) push(this.makeEvent("tool.delta", { turnId, callId: itemId, text: piece }))
    } else if (method === "item/started" || method === "item/completed") {
      const item = record(input.item)
      this.noteSpawn(item)
      const kind = text(item.type)
      if (method === "item/completed" && kind === "agentMessage") {
        const key = `${text(input.threadId)}:${itemId}`
        const value = typeof item.text === "string" && item.text.length > 0 ? item.text : active.textByItem.get(key) ?? ""
        active.textByItem.delete(key)
        for (const piece of eventTextPieces(value)) push(this.makeEvent("assistant.message", { turnId, text: piece }))
      } else if (method === "item/completed" && kind === "reasoning") {
        const reasoning = reasoningText(item)
        emitLive(this.commandOptions, { type: "reasoning.completed", turnId, parentCallId, ...(itemId === undefined ? {} : { itemId }), ...(reasoning === undefined ? {} : { text: reasoning }) })
      } else if (kind === "commandExecution" || kind === "fileChange" || kind === "mcpToolCall" || kind === "dynamicToolCall" || kind === "collabAgentToolCall") {
        if (itemId === undefined) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex subagent tool identity is invalid")
        if (method === "item/completed") {
          emitLive(this.commandOptions, { type: "lineage", parentCallId, callId: itemId })
          this.handleCompletedItem(input, active)
        }
        else {
          const name = kind === "commandExecution" ? "command" : kind === "fileChange" ? "file_change" : kind === "collabAgentToolCall" ? kind : text(item.tool) ?? kind
          const toolInput = boundToolInput(item)
          push(this.makeEvent("tool.started", { turnId, callId: itemId, name, ...(toolInput === undefined ? {} : { input: toolInput }) }))
        }
      }
    } else if (method === "turn/started") {
      emitLive(this.commandOptions, { type: "background.state", entry: { id: `codex:agent:${text(input.threadId)}`, status: "running" } })
    } else if (method === "turn/completed") {
      const status = text(record(input.turn).status)
      const ok = status === "completed"
      emitLive(this.commandOptions, { type: "agent.completed", callId: parentCallId, ok })
      emitLive(this.commandOptions, { type: "background.state", entry: { id: `codex:agent:${text(input.threadId)}`, status: ok ? "completed" : status === "interrupted" ? "stopped" : "failed", endedAt: Date.now() } })
    }
  }

  /** False for a notification that names a turn other than the active one. */
  private belongsToTurn(input: Record<string, unknown>, active: AppServerTurn): boolean {
    const turnId = text(input.turnId)
    if (turnId !== undefined && active.vendorTurnId !== undefined && turnId !== active.vendorTurnId) return false
    if (input.turn !== null && typeof input.turn === "object" && !Array.isArray(input.turn)) {
      const nestedTurnId = text((input.turn as Record<string, unknown>).id)
      if (nestedTurnId !== undefined && active.vendorTurnId !== undefined && nestedTurnId !== active.vendorTurnId) return false
    }
    return true
  }

  private handleCompletedItem(input: Record<string, unknown>, active: AppServerTurn): void {
    const item = record(input.item)
    const kind = text(item.type)
    const turnId = text(input.turnId) ?? active.vendorTurnId ?? "turn"
    const itemId = text(item.id) ?? "item"
    if (kind === "agentMessage") {
      const textValue = typeof item.text === "string" && item.text.length > 0 ? item.text : active.textByItem.get(itemId) ?? ""
      // A reply longer than one event's text travels whole as consecutive messages.
      for (const piece of eventTextPieces(textValue)) this.pushEvent(this.makeEvent("assistant.message", { turnId, text: piece }), active)
      return
    }
    if (kind === "reasoning") {
      const reasoning = reasoningText(item)
      emitLive(this.commandOptions, { type: "reasoning.completed", turnId, itemId, ...(reasoning === undefined ? {} : { text: reasoning }) })
      return
    }
    if (kind === "contextCompaction") {
      active.compacting = false
      const after = active.compactedTokens
      this.pushEvent(this.makeEvent("memory.compacted", { before: this.lastContext?.usedTokens ?? 0, after: after ?? 0, reason: active.compaction ?? "threshold" }), active)
      // Leaves out the system prompt and tools, so it stays an estimate until the next request reports.
      if (after !== undefined) this.reportContext(text(input.turnId) ?? active.vendorTurnId, after, this.lastContext?.windowTokens, true)
      return
    }
    if (kind !== "commandExecution" && kind !== "fileChange" && kind !== "mcpToolCall" && kind !== "dynamicToolCall" && kind !== "collabAgentToolCall") return
    const name = kind === "commandExecution" ? "command" : kind === "fileChange" ? "file_change" : kind === "mcpToolCall" ? text(item.tool) ?? "mcp" : kind === "dynamicToolCall" ? text(item.tool) ?? kind : kind
    const status = text(item.status)
    const failedExit = typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) && item.exitCode !== 0
    const ok = item.success === false || failedExit ? false : status === "completed" || status === "succeeded" || item.success === true || item.exitCode === 0
    const refused = active.refused.get(itemId)
    this.pushEvent(this.makeEvent("tool.completed", {
      turnId,
      callId: itemId,
      name,
      ok,
      ...(typeof item.aggregatedOutput !== "string" || item.aggregatedOutput.length === 0 ? {} : { output: eventText(item.aggregatedOutput, 64 * 1024) }),
      // A command or patch the user refused ends `declined`: report it as the engine's own denial.
      ...(ok ? {} : refused !== undefined ? { error: agentError("REVIEW_DENIED", refused === "timed-out" ? "Codex's reviewer did not decide in time" : "Codex's reviewer denied this call") } : status === "declined" ? { error: agentError("APPROVAL_DENIED", "Codex tool approval was denied") } : { error: agentError("CODEX_TOOL_FAILED", toolFailure(item) ?? "Codex tool execution failed") }),
    }), active)
  }

  private emitPlan(input: Record<string, unknown>): void {
    if (!Array.isArray(input.plan)) return
    const steps: RunrailPlanStep[] = []
    for (const entry of input.plan.slice(0, 64)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
      const step = entry as Record<string, unknown>
      const label = typeof step.step === "string" ? step.step : undefined
      if (label === undefined || label.trim().length === 0) continue
      steps.push({ text: label, status: step.status === "completed" ? "completed" : step.status === "inProgress" || step.status === "in_progress" ? "in_progress" : "pending" })
    }
    const turnId = text(input.turnId) ?? this.active?.vendorTurnId
    const explanation = typeof input.explanation === "string" && input.explanation.length > 0 ? input.explanation : undefined
    emitLive(this.commandOptions, { type: "plan.updated", ...(turnId === undefined ? {} : { turnId }), ...(explanation === undefined ? {} : { explanation }), steps })
  }

  private emitUsageMetadata(input: Record<string, unknown>, active: AppServerTurn): void {
    const usage = record(input.tokenUsage)
    const last = record(usage.last)
    const value = (name: string): number | undefined => safeInteger(last[name]) ? last[name] as number : undefined
    const turnId = text(input.turnId) ?? active.vendorTurnId
    if (active.compacting === true) {
      // While compacting, Codex reports its summarizing request, then the compacted history with
      // every count zero but the total. Neither is the context's size, so only the second is kept.
      if (value("inputTokens") === 0 && (value("outputTokens") ?? 0) === 0 && (value("totalTokens") ?? 0) > 0) {
        active.compactedTokens = value("totalTokens")
        return
      }
    }
    const total = record(usage.total).totalTokens
    if (safeInteger(total)) {
      if (total === this.lastTotalTokens) return
      this.lastTotalTokens = total
    }
    this.commandOptions.onMetadata?.({
      version: 1,
      sessionId: this.requireSessionId(),
      seq: this.eventSequence + 1,
      kind: "usage",
      turnId,
      ...(value("inputTokens") === undefined ? {} : { inputTokens: value("inputTokens") }),
      ...(value("outputTokens") === undefined ? {} : { outputTokens: value("outputTokens") }),
      ...(value("totalTokens") === undefined ? {} : { totalTokens: value("totalTokens") }),
    })
    if (active.compacting === true) return
    const inputTokens = value("inputTokens")
    const usedTokens = value("totalTokens") ?? (inputTokens === undefined ? undefined : inputTokens + (value("outputTokens") ?? 0))
    const windowTokens = safeInteger(usage.modelContextWindow) ? usage.modelContextWindow as number : undefined
    if (usedTokens !== undefined) this.reportContext(turnId, usedTokens, windowTokens, false)
  }

  private reportContext(turnId: string | undefined, usedTokens: number, windowTokens: number | undefined, estimated: boolean): void {
    const autoCompactAt = this.autoCompactAt !== undefined && (windowTokens === undefined || this.autoCompactAt <= windowTokens) ? this.autoCompactAt : undefined
    this.lastContext = Object.freeze({ usedTokens, ...(windowTokens === undefined ? {} : { windowTokens }), ...(autoCompactAt === undefined ? {} : { autoCompactAt }), estimated })
    emitLive(this.commandOptions, { type: "context.usage", ...(turnId === undefined ? {} : { turnId }), ...this.lastContext })
  }

  private makeEvent(type: string, payload: Record<string, unknown>): AgentEvent {
    const sessionId = this.requireSessionId()
    const seq = ++this.eventSequence
    const candidate: unknown = Object.freeze({ version: 1, sessionId, seq, at: Date.now(), type, ...stampEventSnapshot(payload, seq) })
    if (!isAgentEvent(candidate)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server event could not be normalized")
    return candidate
  }

  private pushEvent(event: AgentEvent, active: AppServerTurn): void {
    active.eventCount += 1
    if (active.eventCount > this.options.maxEvents) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server event count exceeded its limit")
    this.updateSnapshotFromEvent(event)
    active.queue.push(event)
  }

  private failActive(failure: CommandAgentBackendError): void {
    const active = this.active
    if (active === undefined) return
    const limited = failure.code === "COMMAND_AGENT_RATE_LIMITED"
    const event = this.makeEvent("session.failed", { error: agentError(failure.code, failure.code === "COMMAND_AGENT_AUTH_FAILED" && !limited ? "Codex authentication failed" : failure.reason), recoverable: failure.code !== "COMMAND_AGENT_AUTH_FAILED" && !limited })
    active.queue.push(event)
    active.queue.complete()
    this.updateSnapshotFromEvent(event)
    this.finishActive(active, false)
    if (limited) {
      // Detach synchronously so retries stop and a later turn can restart. Process termination handles exit races internally.
      void this.stopProcess()
    }
  }

  private finishActive(active: AppServerTurn, completeQueue = true): void {
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.cleanup?.()
    if (completeQueue) active.queue.complete()
    if (this.active === active) this.active = undefined
  }

  private async stopProcess(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.initialized = false
    this.processThreadResumed = false
    this.approvals.clear()
    if (child === undefined) return
    this.background.close()
    const failure = commandError("COMMAND_AGENT_CANCELLED", "Codex app-server process stopped")
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(failure)
    }
    this.pending.clear()
    await terminateProcessTree(child)
  }

  private async request<T>(method: string, params?: unknown, timeoutMs = this.options.timeoutMs): Promise<T> {
    if (this.child === undefined) throw commandError("COMMAND_AGENT_FAILED", "Codex app-server process is unavailable")
    const id = ++this.rpcSequence
    const key = rpcKey(id)
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(commandError("COMMAND_AGENT_TIMEOUT", "Codex app-server request timed out"))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
    })
    try {
      await this.writeMessage({ method, id, ...(params === undefined ? {} : { params }) })
    } catch (error) {
      const pending = this.pending.get(key)
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        this.pending.delete(key)
        pending.reject(normalizeError(error, "Codex app-server request could not be written"))
      }
    }
    return await promise as T
  }

  private async writeMessage(value: Record<string, unknown>): Promise<void> {
    if (this.child === undefined) throw commandError("COMMAND_AGENT_FAILED", "Codex app-server process is unavailable")
    try {
      await this.child.stdin.write(`${JSON.stringify(value)}\n`)
    } catch {
      throw commandError("COMMAND_AGENT_FAILED", "Codex app-server message could not be written")
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

  private requireVendorThreadId(): string {
    if (this.vendorThreadId === undefined) throw commandError("COMMAND_AGENT_INVALID", "Codex vendor thread is unavailable")
    return this.vendorThreadId
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
    if (event.type === "session.started") status = "running"
    else if (event.type === "approval.required") status = "waiting"
    else if (event.type === "session.completed") status = "completed"
    else if (event.type === "session.failed") status = "failed"
    else if (event.type === "session.stopped") status = "stopped"
    else if (event.type === "turn.started") status = "running"
    this.sessions.set(event.sessionId, makeSnapshot(previous.id, previous.backend, previous.cwd, status, event.seq, previous.capabilities, previous.createdAt, event.type === "turn.started" ? event.turnId : undefined))
  }

  private makeSnapshotFor(status: AgentSessionSnapshot["status"]): AgentSessionSnapshot {
    const session = this.currentSnapshot(this.requireSessionId())
    return makeSnapshot(session.id, session.backend, session.cwd, status, this.eventSequence, session.capabilities, session.createdAt)
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

  fail(error: unknown): void {
    if (this.done) return
    this.failure = error
    this.done = true
    this.flush()
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
    if (this.done) {
      if (this.failure !== undefined) return Promise.reject(this.failure)
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private flush(): void {
    while (this.waiters.length > 0 && this.events.length > 0) this.waiters.shift()?.resolve({ done: false, value: this.events.shift()! })
    if (!this.done || this.events.length > 0) return
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (this.failure !== undefined) waiter.reject(this.failure)
      else waiter.resolve({ done: true, value: undefined })
    }
  }
}

function makeSnapshot(
  id: string,
  backend: string,
  cwd: string,
  status: AgentSessionSnapshot["status"],
  lastSeq: number,
  capabilities: readonly string[],
  createdAt = Date.now(),
  activeTurnId?: string,
): AgentSessionSnapshot {
  return Object.freeze({ version: 1, id, backend, cwd, status, createdAt, updatedAt: Date.now(), lastSeq, capabilities: Object.freeze([...capabilities]), ...(activeTurnId === undefined ? {} : { activeTurnId }) })
}

function validateOptions(options: CodexAppServerBackendOptions): void {
  if (options === null || typeof options !== "object") throw commandError("COMMAND_AGENT_INVALID", "Codex app-server options are invalid")
  if (options.command !== undefined && (!validCommand(options.command))) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server command is invalid")
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.length > 128 || options.args.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 4_096))) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server arguments are invalid")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server timeout is invalid")
  if (options.turnTimeoutMs !== undefined && (!Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs < 1 || options.turnTimeoutMs > 86_400_000)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server turn timeout is invalid")
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 1024 * 1024 * 1024)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server output bound is invalid")
  if (options.maxEvents !== undefined && (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 1_000_000)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server event bound is invalid")
  if (options.vendorSessions !== undefined && (options.vendorSessions === null || typeof options.vendorSessions !== "object" || typeof options.vendorSessions.load !== "function" || typeof options.vendorSessions.save !== "function")) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server vendor session store is invalid")
  if (options.onMetadata !== undefined && typeof options.onMetadata !== "function") throw commandError("COMMAND_AGENT_INVALID", "Codex app-server metadata sink is invalid")
  if (options.onLive !== undefined && typeof options.onLive !== "function") throw commandError("COMMAND_AGENT_INVALID", "Codex app-server live sink is invalid")
  if (options.browser !== undefined && !(options.browser instanceof BrowserBridge)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server browser bridge is invalid")
  if (options.threads !== undefined && !(options.threads instanceof ThreadsBridge)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server thread bridge is invalid")
  if (options.computer !== undefined && !(options.computer instanceof ComputerBridge)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server computer bridge is invalid")
  if (options.images !== undefined && !(options.images instanceof ImageService)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server image service is invalid")
  if (options.browserThreads !== undefined && (options.browserThreads === null || typeof options.browserThreads !== "object" || typeof options.browserThreads.load !== "function" || typeof options.browserThreads.save !== "function")) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server browser thread store is invalid")
  if (options.routeEnv !== undefined && !isRouteEnvironment(options.routeEnv)) throw commandError("COMMAND_AGENT_INVALID", "Codex app-server route environment is invalid")
  if (options.apiKey !== undefined && typeof options.apiKey !== "function") throw commandError("COMMAND_AGENT_INVALID", "Codex app-server API key is invalid")
}

/** Codex names a failed model request's HTTP status, or `unauthorized`, in `codexErrorInfo`. */
function refusedCredential(input: Record<string, unknown>): boolean {
  const info = isObject(input.error) ? input.error.codexErrorInfo : undefined
  if (info === "unauthorized") return true
  return isObject(info) && Object.values(info).some((detail) => isObject(detail) && detail.httpStatusCode === 401)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sandboxPolicy(value: string, cwd: string, addDirs: readonly string[] = []): Record<string, unknown> {
  if (value === "read-only") return { type: "readOnly", networkAccess: false }
  if (value === "danger-full-access") return { type: "dangerFullAccess" }
  return { type: "workspaceWrite", writableRoots: [cwd, ...addDirs], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

type BoundedJsonValue = null | boolean | number | string | readonly BoundedJsonValue[] | { readonly [key: string]: BoundedJsonValue }

const MAX_APPROVAL_SUMMARY = 4_000

/** What a command approval runs, and where: the person approves this, not the word "command". */
function commandSummary(input: Record<string, unknown>): string | undefined {
  const command = Array.isArray(input.command)
    ? input.command.filter((part): part is string => typeof part === "string").map(shellWord).join(" ")
    : text(input.command)
  if (command === undefined || command.length === 0) return undefined
  const cwd = text(input.cwd)
  return bounded(cwd === undefined ? command : `${command}\n(in ${cwd})`)
}

/** The files a change approval writes, or the folder it asks to write in. */
function fileChangeSummary(input: Record<string, unknown>): string | undefined {
  const changes = input.fileChanges ?? input.changes
  const paths = changes !== null && typeof changes === "object" && !Array.isArray(changes) ? Object.keys(changes) : []
  const root = text(input.grantRoot)
  const lines = [...paths.slice(0, 50), ...(paths.length > 50 ? [`and ${String(paths.length - 50)} more files`] : []), ...(root === undefined ? [] : [`write access to ${root}`])]
  return lines.length === 0 ? undefined : bounded(lines.join("\n"))
}

/** The wider sandbox access asked for, as Codex describes it. */
function permissionSummary(permissions: Record<string, unknown> | undefined): string | undefined {
  if (permissions === undefined || Object.keys(permissions).length === 0) return undefined
  return bounded(Object.entries(permissions).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n"))
}

function shellWord(part: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`
}

function bounded(value: string): string {
  return value.length > MAX_APPROVAL_SUMMARY ? `${value.slice(0, MAX_APPROVAL_SUMMARY)}\n[truncated]` : value
}

function permissionProfile(value: unknown): Record<string, unknown> {
  const input = record(value)
  const result: Record<string, unknown> = {}
  for (const key of ["fileSystem", "network"] as const) {
    const candidate = input[key]
    if (candidate !== undefined && candidate !== null) result[key] = boundedJson(candidate)
  }
  return Object.freeze(result)
}

function boundedJson(value: unknown, depth = 0): BoundedJsonValue {
  if (depth > 8) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex permission profile is too deep")
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value.length > 4_096 || value.includes("\0")) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex permission profile string is invalid")
    return value
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex permission profile number is invalid")
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex permission profile array is too large")
    return Object.freeze(value.map((entry) => boundedJson(entry, depth + 1)))
  }
  const input = record(value)
  const entries = Object.entries(input)
  if (entries.length > 32) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex permission profile object is too large")
  const result: Record<string, BoundedJsonValue> = {}
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > 128 || key.includes("\0")) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex permission profile key is invalid")
    result[key] = boundedJson(entry, depth + 1)
  }
  return Object.freeze(result)
}

function normalizeError(error: unknown, fallback: string): CommandAgentBackendError {
  if (error instanceof CommandAgentBackendError) return error
  return commandError("COMMAND_AGENT_FAILED", fallback)
}

function commandError(code: CommandAgentBackendErrorCode, reason: string): CommandAgentBackendError {
  return new CommandAgentBackendError(code, reason)
}

/** Codex's own words for a failure (`message`, as its errors carry it), one bounded line. */
function codexWords(error: unknown): string | undefined {
  const message = error !== null && typeof error === "object" && !Array.isArray(error) ? (error as Record<string, unknown>).message : error
  return oneLine(message, 300)
}

/** Why a tool call failed: an MCP tool's own error, or a command's exit code (its output shows beside). */
function toolFailure(item: Record<string, unknown>): string | undefined {
  const words = codexWords(item.error)
  if (words !== undefined) return words
  return typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) && item.exitCode !== 0 ? `Exited with code ${String(item.exitCode)}` : undefined
}

function boundedReason(value: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0") ? value : "cancelled"
}

const REFUSED_WHAT: Readonly<Record<string, string>> = {
  "item/commandExecution/requestApproval": "to run a command",
  execCommandApproval: "to run a command",
  "item/fileChange/requestApproval": "to change files",
  applyPatchApproval: "to change files",
  "item/permissions/requestApproval": "for wider access",
  "item/tool/requestUserInput": "to ask you a question",
  "mcpServer/elicitation/request": "to show you an MCP server's form",
  "item/tool/call": "to use a tool",
  "account/chatgptAuthTokens/refresh": "to refresh its ChatGPT sign-in",
}

/** What Codex asked for and why Runrail refused it, in words for the person. */
function refusalMessage(method: string, why: string): string {
  const what = REFUSED_WHAT[method]
  return `Runrail refused a Codex request${what === undefined ? "" : ` ${what}`}: ${why}.`
}

/** What the person reads beside a request: Codex's reason, after the sub-agent that asked when one did. */
function requestReason(reason: string | undefined, agent: SubAgentThread | undefined): string | undefined {
  if (agent === undefined) return reason
  const asker = agent.name === undefined ? "a Codex sub-agent" : `Codex sub-agent ${agent.name}`
  // Codex's reason may fill an event's text on its own; the attribution must still fit.
  return reason === undefined ? `Asked by ${asker}` : `Asked by ${asker}: ${reason.slice(0, 64 * 1024)}`
}

function boundedValue(value: string, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || /[\r\n]/.test(value)) throw commandError("COMMAND_AGENT_INVALID", `${name} is invalid`)
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server object is invalid")
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 * 1024 && !value.includes("\0") ? value : undefined
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function rpcKey(value: unknown): string {
  if (!isRpcId(value)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Codex app-server id is invalid")
  return `${typeof value}:${String(value)}`
}

function isRpcId(value: unknown): value is RpcId {
  return (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && value.length > 0 && value.length <= 128)
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validCommand(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/.test(value) && !value.startsWith("-") && !value.includes("\0")
}

function isMissingCommand(value: unknown): boolean {
  return value !== null && typeof value === "object" && "code" in value && (value as { readonly code?: unknown }).code === "ENOENT"
}
