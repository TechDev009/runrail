import { spawn, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
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
import { mapClaudeTask } from "../harness/claude-tasks.ts"
import { declinedMessage, userNote } from "../harness/declined.ts"
import { CLAUDE_SEARCH_TOOL_RULES, HARNESS_ROUTE_LIMITS, HarnessLaunchError, effortFromThinking, isHarnessModelId, isMessageMark, isVendorSessionId, parseHarnessLaunchOptions, type HarnessEffort, type HarnessLaunchOptions, type HarnessPermissionMode } from "../harness/launch.ts"
import { emitLive, mapClaudeCodeEvent, stampEventSnapshot } from "../harness/mappers.ts"
import { mappedEvents } from "../harness/types.ts"
import { claudePlanLimits, claudeUsageLimits } from "../harness/plan-limits.ts"
import { harnessRateLimitMessage } from "../harness/rate-limit.ts"
import { claudeApiRetry } from "../harness/api-retry.ts"
import type { HarnessAuthOptions, HarnessEventMappingContext, HarnessMetadataSink } from "../harness/types.ts"
import { vendorSessionEntry, type VendorSessionEntry, type VendorSessionStore } from "../harness/vendor-session-store.ts"
import type { RunrailLiveSink, RunrailPlanLimitsFrame, RunrailUsageReading } from "../live/types.ts"
import { APPROVAL_REVIEWED, MAX_REVIEW_DETAIL, REVIEWER_NOTICE, claudeDenial, claudeUnaskedDenial, oneLine as reviewLine } from "../harness/review.ts"
import { FOLLOW_UP_UNSUPPORTED, QUESTION_ACTION, QUESTION_CAPABILITY, QUESTION_NEEDS_ANSWERS, answersMismatch, claudeAnsweredInput, claudeQuestions, claudeQuestionsTitle, claudeTakesFollowUp, elicitationAnswer, elicitationMismatch, mcpElicitation, questionsReason, recordedAnswers, type ApprovalAnswers, type ApprovalQuestion, type ElicitationAnswer, type ElicitationForm, type FollowUp } from "../harness/questions.ts"
import { EDIT_TOOL_NAMES, MAX_SESSION_GRANTS, claudeAskGate, claudeEditsControlPath, claudeGrantCovers, claudeSessionGrants, type ClaudeSdkHookCallback, type ClaudeSdkHookMatcher, type ClaudeSessionGrant } from "./claude-permission-gate.ts"
import { CommandAgentBackendError, type CommandAgentBackendErrorCode } from "./command-agent.ts"
import { terminateProcessTree } from "./process-tree.ts"

const CLAUDE_TOOL_CONFIG = Object.freeze({ askUserQuestion: Object.freeze({ extendedQuestions: true, previewFormat: "markdown" as const, optionalDescriptions: true }) })
// A question or approval waits for the person: the person's own settings could let Claude Code
// go on without an answer after a minute of quiet.
const CLAUDE_SETTINGS = Object.freeze({ askUserQuestionTimeout: "never", dialogExpiry: "never" })

/**
 * The part of Anthropic's Claude Agent SDK this backend calls, in Runrail's own words. The SDK is
 * an optional peer under Anthropic's Commercial Terms: Runrail never imports its types, and every
 * message it yields is parsed here as untrusted input.
 */

export interface ClaudeAgentSdk {
  query(params: { readonly prompt: AsyncIterable<ClaudeSdkUserMessage>; readonly options: ClaudeSdkQueryOptions }): ClaudeSdkQuery
  /** Copies a conversation under a new id; `dir` is the project it belongs to. */
  forkSession?(sessionId: string, options: { readonly dir: string }): Promise<{ readonly sessionId: string }>
}

export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  close(): void
  /** Claude Code's own count of what fills its context. `full` asks the token-count API. */
  getContextUsage?(options?: { readonly detail?: "summary" | "full" }): Promise<unknown>
  /** The plan's windows behind `/usage`. Experimental in the SDK, so absent once it is gone. */
  readPlanUsage?(): Promise<unknown>
}

export interface ClaudeSdkUserMessage {
  readonly type: "user"
  readonly message: { readonly role: "user"; readonly content: string }
  readonly parent_tool_use_id: null
  /** `next`: read at the model's next step of the running turn. */
  readonly priority?: "next"
}

export type ClaudeSdkPermissionResult =
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown>; readonly updatedPermissions?: readonly unknown[] }
  | { readonly behavior: "deny"; readonly message: string; readonly interrupt?: boolean }

export interface ClaudeSdkPermissionContext {
  readonly signal: AbortSignal
  readonly suggestions?: unknown
  readonly toolUseID?: unknown
  readonly title?: unknown
  readonly displayName?: unknown
  readonly description?: unknown
}

/** An MCP server's request for the person's input, as Claude Code passes it on. */
export interface ClaudeSdkElicitationRequest {
  readonly serverName: string
  readonly message: string
  readonly mode?: "form" | "url"
  readonly url?: string
  readonly elicitationId?: string
  readonly requestedSchema?: Record<string, unknown>
}

export type ClaudeSdkElicitationResult = ElicitationAnswer

export interface ClaudeSdkSpawnOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly signal: AbortSignal
}

export interface ClaudeSdkQueryOptions {
  readonly cwd: string
  /** The project's related folders, as `--add-dir` gives them. */
  readonly additionalDirectories?: readonly string[]
  readonly pathToClaudeCodeExecutable: string
  /** Replaces the child's environment; the SDK never falls back to `process.env` when this is set. */
  readonly env: Readonly<Record<string, string>>
  readonly permissionMode: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions"
  readonly model?: string
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max"
  readonly systemPrompt: { readonly type: "preset"; readonly preset: "claude_code"; readonly append?: string }
  readonly mcpServers?: Readonly<Record<string, unknown>>
  /** `[]` loads none of the person's settings files: no hooks, no settings-defined MCP servers or plugins. */
  readonly settingSources?: readonly string[]
  /** Only `mcpServers` run; every MCP server configured elsewhere is ignored. */
  readonly strictMcpConfig?: boolean
  /** `false` writes no conversation to disk. */
  readonly persistSession?: boolean
  readonly allowedTools?: readonly string[]
  readonly resume?: string
  /** With `resume`: continue a copy under a new id, leaving the resumed conversation as it was. */
  readonly forkSession?: boolean
  /** With `resume`: only messages up to and including this one are continued (a rewind). */
  readonly resumeSessionAt?: string
  readonly includePartialMessages: true
  /** Runs before every tool call; an "ask" answer sends the call to `canUseTool` even where Claude Code would not ask. */
  readonly hooks?: { readonly PreToolUse?: readonly ClaudeSdkHookMatcher[] }
  readonly canUseTool: (toolName: string, input: Record<string, unknown>, context: ClaudeSdkPermissionContext) => Promise<ClaudeSdkPermissionResult>
  /** An MCP server's request no hook answered; without it Claude Code declines every one. */
  readonly onElicitation?: (request: ClaudeSdkElicitationRequest, options: { readonly signal: AbortSignal; readonly requestId?: string }) => Promise<ClaudeSdkElicitationResult>
  readonly abortController: AbortController
  readonly spawnClaudeCodeProcess: (options: ClaudeSdkSpawnOptions) => ChildProcess
  /** How AskUserQuestion asks: Runrail's form shows text and number questions, and choices' markdown previews. */
  readonly toolConfig?: { readonly askUserQuestion?: { readonly extendedQuestions?: boolean; readonly previewFormat?: "markdown" | "html"; readonly optionalDescriptions?: boolean } }
  /** Settings above the person's own, as `--settings` gives them. */
  readonly settings?: Readonly<Record<string, unknown>>
}

export type ClaudeApprovalScope = "once" | "session"

export interface ClaudeAgentSdkBackendOptions {
  readonly sdk: ClaudeAgentSdk
  readonly name?: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  /** The installed `claude`, found on the filtered PATH unless a path is given. */
  readonly command?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Variables the route sets on `claude`, such as a connection's own `CLAUDE_CONFIG_DIR`. Never a credential. */
  readonly routeEnv?: Readonly<Record<string, string>>
  readonly auth?: HarnessAuthOptions
  readonly launch?: HarnessLaunchOptions
  /** Longest a single turn may run, approvals included. */
  readonly turnTimeoutMs?: number
  readonly maxEvents?: number
  readonly vendorSessions?: VendorSessionStore
  readonly onLive?: RunrailLiveSink
  readonly onMetadata?: HarnessMetadataSink
  /** Hears each call the person approved, before Claude Code runs it. */
  readonly onApproved?: (toolName: string, input: Readonly<Record<string, unknown>>) => void
}

interface PendingApproval {
  readonly turnId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly suggestions: readonly unknown[]
  readonly resolve: (result: ClaudeSdkPermissionResult) => void
  scope: ClaudeApprovalScope
  /** Claude Code's AskUserQuestion: what it asks, the call that asks, and the answers once given. */
  readonly questions?: readonly ApprovalQuestion[]
  readonly callId?: string
  answers?: ApprovalAnswers
  /** Claude Code takes a request for more questions instead of all the answers, and the person made one. */
  readonly takesFollowUp?: true
  followUp?: FollowUp
  /** An MCP server's form and where its answer goes; `resolve` only cancels it. */
  readonly elicitation?: { readonly form: ElicitationForm; readonly settle: (answer: ElicitationAnswer) => void }
  cleanup?: () => void
}

interface SdkTurn {
  readonly turnId: string
  /** The newest message of the main conversation this turn saw, for a later exact rewind. */
  vendorMessageId?: string
  readonly message: string
  readonly queue: EventQueue
  readonly turnState: Map<string, unknown>
  /** Background tasks this turn started; a cancel stops them, since `interrupt()` leaves them running. */
  readonly tasks: Set<string>
  /** Tool calls started and not yet finished; guidance is taken only while one runs. */
  readonly openTools: Set<string>
  /** What each tool call names (its command, file, or address), for a denial that names only the call. */
  readonly toolDetails: Map<string, string>
  /** Calls Claude Code denied without asking; their results end as its denial, not a failure or the person's. */
  readonly denied: Set<string>
  /** Calls the gate sent to Claude Code's prompt that have not reached `canUseTool` yet. */
  readonly gated: Set<string>
  /** Questions sent back to be asked in the reply; their results say so to the person, not to Claude Code. */
  readonly inReply: Set<string>
  eventCount: number
  /** True once Claude Code has opened the conversation for this turn. */
  opened: boolean
  /** True after the one restart a missing resumed conversation earns. */
  retried: boolean
  timer?: ReturnType<typeof setTimeout>
  cleanup?: () => void
  cancelled?: string
  readonly settled: Promise<void>
  settle: () => void
}

/** A `/compact` sent between turns, until Claude Code's result for it. */
interface PendingCompaction {
  readonly resolve: (counts: { readonly before?: number; readonly after?: number }) => void
  readonly reject: (error: CommandAgentBackendError) => void
  timer?: ReturnType<typeof setTimeout>
  boundary: boolean
  before?: number
  after?: number
}

type SdkPermissionMode = ClaudeSdkQueryOptions["permissionMode"]

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk"
const MAX_REASON_CHARS = 256
const MAX_SUGGESTIONS = 16
const MAX_MCP_CONFIG_BYTES = 256 * 1024
const MAX_MCP_SERVERS = 32
const MAX_STDERR_CHARS = 16 * 1024
const MAX_TOKENS = 20_000_000
const CONTEXT_READ_TIMEOUT_MS = 5_000
const PLAN_READ_TIMEOUT_MS = 5_000
/** The plan's windows move slowly and each read reaches claude.ai, so a card opened often reads once a minute. */
const PLAN_READ_INTERVAL_MS = 60_000
const PLAN_USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
const DECLINED = "The user declined this action."
const ELICITATION_CANCELLED: ClaudeSdkElicitationResult = Object.freeze({ action: "cancel" })
const ASK_IN_REPLY = "This client cannot show questions. Ask the user in your reply instead, then stop."
const ASKED_IN_REPLY = "Claude Code asks this in its reply instead"
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "KillShell", "KillBash"])
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
const NETWORK_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"])
// Named so the user's own Claude Code default can never be wider than what Runrail shows.
const SDK_PERMISSION_MODE: Readonly<Record<HarnessPermissionMode, SdkPermissionMode>> = Object.freeze({
  plan: "plan",
  ask: "default",
  "accept-edits": "acceptEdits",
  auto: "auto",
  bypass: "bypassPermissions",
})

let registeredSdk: ClaudeAgentSdk | undefined
let sdkLoader: (() => Promise<unknown>) | undefined
let loading: Promise<ClaudeAgentSdk | undefined> | undefined

/**
 * Hands the Agent SDK to Runrail in a build that bundles it: a compiled binary cannot import a
 * package it did not bundle, so the build's entry imports the SDK and registers it here.
 * `undefined` removes a registered one.
 */
export function registerClaudeAgentSdk(module: unknown): void {
  registeredSdk = module === undefined ? undefined : parseClaudeAgentSdk(module)
}

/**
 * Hands Runrail a way to get the Agent SDK when it is first needed, for a build that fetches it
 * rather than ship it. Callers waiting at once share one call; a call that fails or finds nothing
 * is made again on the next load. `undefined` removes a registered loader.
 */
export function registerClaudeAgentSdkLoader(loader: (() => Promise<unknown>) | undefined): void {
  sdkLoader = loader
  loading = undefined
}

/** Where the SDK would come from, found without loading or fetching it. */
export function claudeAgentSdkSource(): "registered" | "installed" | "fetched" | "missing" {
  if (registeredSdk !== undefined) return "registered"
  try {
    Bun.resolveSync(SDK_PACKAGE, import.meta.dir)
    return "installed"
  } catch {
    return sdkLoader === undefined ? "missing" : "fetched"
  }
}

/** The registered SDK, else the registered loader's, else the installed optional peer, else undefined. */
export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk | undefined> {
  if (registeredSdk !== undefined) return registeredSdk
  const loader = sdkLoader
  if (loader !== undefined) {
    const pending = (loading ??= loader()
      .then((module) => (module === undefined ? undefined : parseClaudeAgentSdk(module)))
      .catch(() => undefined))
    const sdk = await pending
    if (sdk !== undefined && sdkLoader === loader) registeredSdk = sdk
    if (loading === pending) loading = undefined
    if (sdk !== undefined) return sdk
  }
  let module: unknown
  try {
    // A variable specifier keeps bundlers and the type checker from requiring the optional peer.
    const specifier: string = SDK_PACKAGE
    module = await import(specifier)
  } catch {
    return undefined
  }
  try {
    return parseClaudeAgentSdk(module)
  } catch {
    return undefined
  }
}

export function parseClaudeAgentSdk(module: unknown): ClaudeAgentSdk {
  if (!isRecord(module) || typeof module.query !== "function") throw new TypeError("Claude Agent SDK is invalid")
  const query = module.query as (params: unknown) => unknown
  const forkSession = typeof module.forkSession === "function" ? module.forkSession as (sessionId: string, options: unknown) => unknown : undefined
  return Object.freeze({
    query: (params: Parameters<ClaudeAgentSdk["query"]>[0]) => parseQuery(query(params)),
    ...(forkSession === undefined ? {} : {
      forkSession: async (sessionId: string, options: { readonly dir: string }) => {
        const result: unknown = await forkSession(sessionId, { dir: options.dir })
        if (!isRecord(result) || !isVendorSessionId(result.sessionId)) throw new TypeError("Claude Agent SDK fork result is invalid")
        return Object.freeze({ sessionId: result.sessionId })
      },
    }),
  })
}

function parseQuery(value: unknown): ClaudeSdkQuery {
  if (!isRecord(value) || typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") throw new TypeError("Claude Agent SDK query is invalid")
  for (const name of ["interrupt", "setModel", "stopTask", "close"]) if (typeof value[name] !== "function") throw new TypeError("Claude Agent SDK query is invalid")
  const call = (name: string, ...args: unknown[]): unknown => (value[name] as (...rest: unknown[]) => unknown).apply(value, args)
  return Object.freeze({
    [Symbol.asyncIterator]: () => (value as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator](),
    interrupt: async () => await call("interrupt"),
    setModel: async (model?: string) => {
      await call("setModel", model)
    },
    stopTask: async (taskId: string) => {
      await call("stopTask", taskId)
    },
    close: () => {
      call("close")
    },
    ...(typeof value.getContextUsage === "function" ? { getContextUsage: async (options?: { readonly detail?: "summary" | "full" }) => await call("getContextUsage", options) } : {}),
    ...(typeof value[PLAN_USAGE_METHOD] === "function" ? { readPlanUsage: async () => await call(PLAN_USAGE_METHOD, { skipBehaviors: true }) } : {}),
  })
}

/**
 * Claude Code driven through Anthropic's Agent SDK: one long-lived `claude` process per session,
 * fed turns over its stream-json input. Unlike print mode, Claude Code can ask: each permission
 * prompt becomes a Runrail approval and waits for the user's answer.
 *
 * The process is the user's installed, unmodified `claude`, run with its own login and Runrail's
 * filtered environment. Runrail never reads Claude Code's credentials.
 */
export class ClaudeAgentSdkBackend implements AgentBackend {
  readonly info: AgentBackendInfo

  private readonly sdk: ClaudeAgentSdk
  private readonly commandOptions: ClaudeAgentSdkBackendOptions
  private readonly launch: HarnessLaunchOptions
  private readonly auth: HarnessAuthOptions
  private readonly limits: { readonly turnTimeoutMs: number; readonly maxEvents: number }
  private readonly sessions = new Map<string, AgentSessionSnapshot>()
  private readonly approvals = new Map<string, PendingApproval>()
  /** What the person allowed for the rest of the session; the gate's "ask" passes over Claude Code's own copy. */
  private readonly grants: ClaudeSessionGrant[] = []
  /** The mode Claude Code last said it runs in, so a fallback from auto is told once. */
  private reportedMode: string | undefined
  private sequence = 0
  private turnSequence = 0
  private approvalSequence = 0
  private eventSequence = -1
  private sessionId: string | undefined
  private vendorSessionId: string | undefined
  /** Where Claude Code's conversation stood once the last turn ended. */
  private lastMark: { readonly session: string; readonly at: string } | undefined
  private query: ClaudeSdkQuery | undefined
  private input: InputQueue | undefined
  private abort: AbortController | undefined
  private child: ChildProcess | undefined
  private childExited: Promise<number> | undefined
  /** Kept only to recognize a missing conversation or a missing login; never logged or returned. */
  private stderr = ""
  /** The conversation the running process was asked to continue. */
  private resumedWith: string | undefined
  /** The conversation the running process reported; a later report must match it. */
  private processVendorSessionId: string | undefined
  /** True once the launch's resume id was found missing, so it is not tried again. */
  private launchResumeSpent = false
  private startedEffort: HarnessEffort | undefined
  /** The model the running process is on: the one it started with, or the last switch it accepted. */
  private runningModel: string | undefined
  private model: string | undefined
  private effort: HarnessEffort | undefined
  private active: SdkTurn | undefined
  private compaction: PendingCompaction | undefined
  private planReadAt: number | undefined
  /** The newest plan usage from a read or a turn's events, so a throttled read never answers older. */
  private latestPlan: RunrailPlanLimitsFrame | undefined
  /** Vendor id writes, chained so a later id is never overwritten by an earlier one. */
  private saving: Promise<void> = Promise.resolve()
  private starting = false
  private sessionStarted = false
  private closed = false

  constructor(options: ClaudeAgentSdkBackendOptions) {
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
    this.sdk = options.sdk
    this.commandOptions = options
    this.model = this.launch.model
    this.effort = this.launch.effort
    this.limits = { turnTimeoutMs: options.turnTimeoutMs ?? HARNESS_ROUTE_LIMITS.timeoutMs, maxEvents: options.maxEvents ?? HARNESS_ROUTE_LIMITS.maxEvents }
    this.info = Object.freeze({
      name: options.name ?? "claude-code",
      version: options.version ?? RUNRAIL_VERSION,
      capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming", "persistent", "tools", "approvals", "resume", "fork", "models", "thinking", "reload", "compact"])].sort()),
    })
  }

  /** Opening a session runs no process; Claude Code starts with the first turn. */
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
    this.requireSession(sessionId)
    const active = this.active
    if (active === undefined) return
    active.cancelled = boundedReason(reason)
    this.releaseApprovals()
    const query = this.query
    if (query !== undefined) {
      await Promise.race([query.interrupt().catch(() => undefined), delay(2_000)])
      await this.stopTurnTasks(active, query)
      // A well-behaved process ends the turn with its result; one that does not is stopped.
      await Promise.race([active.settled, delay(2_000)])
    }
    if (this.active === active) {
      await this.closeQuery()
      if (this.active === active) {
        this.pushEvent(this.makeEvent("session.stopped", { reason: active.cancelled }), active)
        this.finishActive(active)
      }
    }
  }

  async interrupt(sessionId: string, reason = "interrupted"): Promise<void> {
    this.requireSession(sessionId)
    const active = this.active
    const query = this.query
    if (active === undefined || query === undefined) throw commandError("COMMAND_AGENT_INVALID", "no active turn can be interrupted")
    active.cancelled = boundedReason(reason)
    this.releaseApprovals()
    try {
      await query.interrupt()
    } catch {
      throw commandError("COMMAND_AGENT_FAILED", "Claude Code could not be interrupted")
    }
    await this.stopTurnTasks(active, query)
  }

  /**
   * Guidance for the running turn, read at Claude Code's next step. It is taken only while one of
   * Claude Code's tools runs: another step then follows within the same turn and reads it. At any
   * other point Claude Code could answer it as a turn of its own, so it is refused and the caller
   * queues it as the next turn.
   */
  steer(sessionId: string, text: string): boolean {
    this.requireSession(sessionId)
    const active = this.active
    if (active === undefined || active.cancelled !== undefined || active.openTools.size === 0 || this.input === undefined) return false
    if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024 || text.includes("\0")) return false
    this.input.push(userMessage(text, "next"))
    return true
  }

  async resume(sessionId: string): Promise<AgentSessionSnapshot> {
    const session = this.requireSession(sessionId)
    if (this.active !== undefined || this.starting) throw commandError("COMMAND_AGENT_INVALID", "cannot resume while a turn is active")
    await this.ensureQuery(session)
    return this.currentSnapshot(session.id)
  }

  /**
   * Copies the conversation under a new Claude Code id kept for the target session, so a session
   * opened with that id continues the copy. This session keeps its own conversation.
   */
  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    const session = this.requireSession(input.sessionId)
    if (this.active !== undefined || this.starting || this.compaction !== undefined) throw commandError("COMMAND_AGENT_INVALID", "cannot fork during an active turn")
    const targetSessionId = input.targetSessionId ?? `${session.id}-fork-${++this.sequence}`
    if (!validId(targetSessionId) || targetSessionId === session.id) throw commandError("COMMAND_AGENT_INVALID", "fork target session id is invalid")
    const store = this.commandOptions.vendorSessions
    // Without a store the copy's id would be lost and nothing could open it.
    if (store === undefined) throw commandError("COMMAND_AGENT_UNSUPPORTED", "fork needs a store for the conversation id")
    await this.saving
    const known = this.vendorSessionId ?? (await this.storedSession(session.id))?.vendorSessionId
    let forked: string | undefined
    if (known !== undefined) {
      const forkSession = this.sdk.forkSession
      if (forkSession === undefined) throw commandError("COMMAND_AGENT_UNSUPPORTED", "this Agent SDK cannot fork a conversation")
      // The SDK copies the transcript in this process, so it has to look where the spawned Claude Code writes.
      const env = await this.commandEnvironment()
      if (env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR) throw commandError("COMMAND_AGENT_UNSUPPORTED", "fork needs Claude Code to use this process's config directory")
      try {
        forked = (await forkSession(known, { dir: session.cwd })).sessionId
      } catch (error) {
        throw normalizeError(error, "Claude Code could not fork the conversation")
      }
    }
    // A conversation that has not started forks to a new one, so an id an earlier target kept is dropped.
    await store.save(targetSessionId, forked)
    return Object.freeze({ sessionId: targetSessionId, parentSessionId: session.id })
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    this.requireSession(sessionId)
    if (!isHarnessModelId(model)) throw commandError("COMMAND_AGENT_INVALID", "model is invalid")
    this.model = model
    const query = this.query
    if (query === undefined) return
    try {
      await query.setModel(model)
      if (this.query === query) this.runningModel = model
    } catch {
      // The process stays on its old model, so the next turn starts one with the new model.
      if (this.active === undefined) await this.closeQuery()
    }
  }

  /** Claude Code takes its effort at start, so a changed level starts a fresh process at the next turn. */
  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.requireSession(sessionId)
    const effort = effortFromThinking(thinking)
    if (effort === undefined) throw commandError("COMMAND_AGENT_INVALID", "thinking is invalid")
    this.effort = effort
  }

  async resolveApproval(sessionId: string, approvalId: string, approved: boolean, reason?: string): Promise<boolean | undefined> {
    this.requireSession(sessionId)
    const pending = this.approvals.get(approvalId)
    if (pending === undefined) return false
    if (approved && this.approvalNeedsAnswers(sessionId, approvalId)) throw commandError("COMMAND_AGENT_INVALID", QUESTION_NEEDS_ANSWERS)
    this.approvals.delete(approvalId)
    pending.cleanup?.()
    if (pending.elicitation !== undefined) return this.answerElicitation(pending, pending.elicitation, approvalId, approved, reason)
    if (pending.questions !== undefined) return this.answerQuestions(pending, approvalId, approved, reason)
    // A tool that asks every time is never allowed for the rest of the session.
    const remember = approved && pending.scope === "session" && pending.suggestions.length > 0 && !this.asksEveryTime(pending.toolName)
    if (remember) this.remember(pending.suggestions)
    if (approved) this.commandOptions.onApproved?.(pending.toolName, pending.input)
    pending.resolve(approved
      ? { behavior: "allow", updatedInput: pending.input, ...(remember ? { updatedPermissions: pending.suggestions } : {}) }
      : { behavior: "deny", message: declinedMessage(reason) })
    const active = this.active
    if (active !== undefined) this.pushEvent(this.makeEvent("approval.resolved", { turnId: pending.turnId, approvalId, approved, ...(reason === undefined ? {} : { reason: boundedReason(reason) }) }), active)
    return true
  }

  /** A question waiting on answers it has not been given, which approving alone cannot settle. */
  approvalNeedsAnswers(sessionId: string, approvalId: string): boolean {
    this.requireSession(sessionId)
    const pending = this.approvals.get(approvalId)
    return pending !== undefined && pending.elicitation === undefined && pending.questions !== undefined && pending.answers === undefined
  }

  /**
   * The person's answers to a question about to be approved. Answers that do not fit its questions
   * are refused here, so the approval stays waiting for ones that do.
   */
  setApprovalAnswers(sessionId: string, approvalId: string, answers: ApprovalAnswers, followUp?: FollowUp): boolean {
    this.requireSession(sessionId)
    const pending = this.approvals.get(approvalId)
    if (pending?.questions === undefined) return false
    if (followUp !== undefined && pending.takesFollowUp !== true) throw commandError("COMMAND_AGENT_INVALID", FOLLOW_UP_UNSUPPORTED)
    const mismatch = pending.elicitation === undefined ? answersMismatch(pending.questions, answers, followUp !== undefined) : elicitationMismatch(pending.elicitation.form, answers)
    if (mismatch !== undefined) throw commandError("COMMAND_AGENT_INVALID", `answers do not fit the questions: ${mismatch}`)
    pending.answers = answers
    if (followUp === undefined) delete pending.followUp
    else pending.followUp = followUp
    return true
  }

  /** The MCP server hears accept with the answers, decline, or cancel when nobody filled its form in. */
  private answerElicitation(pending: PendingApproval, elicitation: NonNullable<PendingApproval["elicitation"]>, approvalId: string, approved: boolean, reason: string | undefined): boolean {
    const answers = approved ? pending.answers : undefined
    elicitation.settle(elicitationAnswer(elicitation.form, approved, answers))
    const recorded = answers === undefined ? undefined : recordedAnswers(elicitation.form.questions, answers)
    const active = this.active
    if (active !== undefined) this.pushEvent(this.makeEvent("approval.resolved", { turnId: pending.turnId, approvalId, approved, ...(reason === undefined ? {} : { reason: boundedReason(reason) }), ...(recorded === undefined ? {} : { answers: recorded }) }), active)
    return true
  }

  /** Answered, or asked for more, Claude Code reads it all from its input; declined, it hears why. */
  private answerQuestions(pending: PendingApproval, approvalId: string, approved: boolean, reason: string | undefined): boolean {
    const questions = pending.questions ?? []
    const answers = approved ? pending.answers : undefined
    const followUp = answers === undefined ? undefined : pending.followUp
    const active = this.active
    if (answers !== undefined) pending.resolve({ behavior: "allow", updatedInput: claudeAnsweredInput(pending.input, questions, answers, followUp) })
    else pending.resolve(deny(reason === undefined ? "The user chose not to answer." : `The user chose not to answer: ${userNote(reason)}`))
    const recorded = answers === undefined ? undefined : recordedAnswers(questions, answers)
    const asked = followUp === undefined ? {} : { followUp: true, ...(followUp.note === undefined ? {} : { note: followUp.note }) }
    if (active !== undefined) this.pushEvent(this.makeEvent("approval.resolved", { turnId: pending.turnId, approvalId, approved, ...(reason === undefined ? {} : { reason: boundedReason(reason) }), ...(recorded === undefined ? {} : { answers: recorded }), ...asked }), active)
    return true
  }

  /**
   * Whether an approval about to be granted also covers the rest of the session. Claude Code
   * suggests the rule itself; Runrail passes back only what it suggested.
   */
  setApprovalScope(sessionId: string, approvalId: string, scope: ClaudeApprovalScope): boolean {
    this.requireSession(sessionId)
    if (scope !== "once" && scope !== "session") throw commandError("COMMAND_AGENT_INVALID", "approval scope is invalid")
    const pending = this.approvals.get(approvalId)
    if (pending === undefined) return false
    pending.scope = scope
    return true
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId)
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    this.requireSession(sessionId)
    if (this.active !== undefined || this.starting || this.compaction !== undefined) throw commandError("COMMAND_AGENT_INVALID", "cannot reload while a turn is active")
    await this.closeQuery()
    return Object.freeze({ revision: `${this.info.version}:reload`, loaded: Object.freeze([]), disabled: Object.freeze([]), rolledBack: false })
  }

  async close(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    if (this.active !== undefined) await this.cancel(sessionId, "closed")
    await this.closeQuery()
    this.sessions.delete(sessionId)
    this.sessionId = undefined
    this.vendorSessionId = undefined
    this.closed = true
  }

  /**
   * Summarizes the conversation with Claude Code's own `/compact`, between turns. Both sizes are
   * read from Claude Code in full; the boundary's own figures leave out the system prompt and
   * tools, and stand in only when a read fails.
   */
  async compact(sessionId: string, reason: CompactionReason = "manual"): Promise<AgentEvent> {
    const session = this.requireSession(sessionId)
    if (!COMPACTION_REASONS.has(reason)) throw commandError("COMMAND_AGENT_INVALID", "compaction reason is invalid")
    if (this.active !== undefined || this.starting || this.compaction !== undefined) throw commandError("COMMAND_AGENT_INVALID", "cannot compact while a turn is active")
    if ((this.vendorSessionId ?? (await this.storedSession(session.id))?.vendorSessionId) === undefined) throw commandError("COMMAND_AGENT_INVALID", "the conversation has nothing to compact yet")
    this.starting = true
    try {
      await this.ensureQuery(session)
    } finally {
      this.starting = false
    }
    const prior = await this.readContext("full")
    const counts = await new Promise<{ readonly before?: number; readonly after?: number }>((resolve, reject) => {
      const pending: PendingCompaction = { resolve, reject, boundary: false }
      pending.timer = setTimeout(() => {
        this.endCompaction(commandError("COMMAND_AGENT_TIMEOUT", "Claude Code did not finish compacting"))
        void this.closeQuery()
      }, this.limits.turnTimeoutMs)
      this.compaction = pending
      this.input?.push(userMessage("/compact"))
    })
    const reading = await this.readContext("full")
    if (reading !== undefined) emitLive(this.commandOptions, { type: "context.usage", ...reading, estimated: true })
    const event = this.makeEvent("memory.compacted", { before: prior?.usedTokens ?? counts.before ?? 0, after: reading?.usedTokens ?? counts.after ?? 0, reason })
    this.eventSequence = event.seq
    this.updateSnapshotFromEvent(event)
    return event
  }

  /**
   * What Claude Code says now about its context and the plan. No process is started for it:
   * without one the last readings stand. Mid-turn the context is left to the turn's own reports.
   */
  async readUsage(sessionId: string): Promise<RunrailUsageReading> {
    this.requireSession(sessionId)
    if (this.query === undefined) return {}
    const idle = this.active === undefined && this.compaction === undefined && !this.starting
    const [reading, plan] = await Promise.all([idle ? this.readContext("full") : Promise.resolve(undefined), this.readPlan()])
    if (reading !== undefined) emitLive(this.commandOptions, { type: "context.usage", ...reading, estimated: true })
    if (plan !== undefined) emitLive(this.commandOptions, plan)
    return Object.freeze({ ...(reading === undefined ? {} : { context: { ...reading, estimated: true } }), ...(plan === undefined ? {} : { plan }) })
  }

  private async readContext(detail: "summary" | "full"): Promise<ClaudeContextReading | undefined> {
    const query = this.query
    if (query?.getContextUsage === undefined) return undefined
    try {
      return claudeContextReading(await Promise.race([query.getContextUsage({ detail }), delay(CONTEXT_READ_TIMEOUT_MS).then(() => undefined)]))
    } catch {
      return undefined
    }
  }

  private async readPlan(): Promise<RunrailPlanLimitsFrame | undefined> {
    const query = this.query
    if (query?.readPlanUsage === undefined) return undefined
    if (this.planReadAt !== undefined && Date.now() - this.planReadAt < PLAN_READ_INTERVAL_MS) return this.latestPlan
    this.planReadAt = Date.now()
    try {
      this.notePlan(claudeUsageLimits(await Promise.race([query.readPlanUsage(), delay(PLAN_READ_TIMEOUT_MS).then(() => undefined)])))
    } catch {
      // The call is experimental: a version without it, or an API-key login, has no plan to show.
    }
    return this.latestPlan
  }

  /** A turn's events name no plan; the one the usage call named is kept. */
  private notePlan(limits: RunrailPlanLimitsFrame | undefined): void {
    if (limits === undefined) return
    const plan = limits.plan ?? this.latestPlan?.plan
    const extraUsage = limits.extraUsage ?? this.latestPlan?.extraUsage
    this.latestPlan = { ...limits, ...(plan === undefined ? {} : { plan }), ...(extraUsage === undefined ? {} : { extraUsage }) }
  }

  private async *run(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 256 * 1024 || input.message.includes("\0")) throw commandError("COMMAND_AGENT_INVALID", "agent message is invalid")
    const session = this.requireSession(input.sessionId)
    if (this.active !== undefined || this.starting || this.compaction !== undefined) throw commandError("COMMAND_AGENT_INVALID", "agent session is already running")
    const turn = await this.startTurn(session, input.message, input.signal)
    try {
      for await (const event of turn.queue) yield event
      // The pointer is on disk before the turn is over, so an engine that stops next still continues it.
      await this.saving
    } finally {
      if (turn.cancelled === undefined && this.active === turn) await this.cancel(input.sessionId, input.signal?.aborted ? "cancelled" : "consumer closed")
    }
  }

  private async startTurn(session: AgentSessionSnapshot, message: string, signal?: AbortSignal): Promise<SdkTurn> {
    this.starting = true
    try {
      await this.ensureQuery(session)
    } finally {
      this.starting = false
    }
    let settle: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const turn: SdkTurn = { turnId: `turn-${++this.turnSequence}`, message, queue: new EventQueue(), turnState: new Map(), tasks: new Set(), openTools: new Set(), toolDetails: new Map(), denied: new Set(), gated: new Set(), inReply: new Set(), eventCount: 0, opened: false, retried: false, settled, settle }
    this.active = turn
    this.updateSessionStatus(session.id, "running")
    if (!this.sessionStarted) {
      this.sessionStarted = true
      this.pushEvent(this.makeEvent("session.started", { snapshot: this.currentSnapshot(session.id) }), turn)
    }
    this.pushEvent(this.makeEvent("turn.started", { turnId: turn.turnId, prompt: message }), turn)
    turn.timer = setTimeout(() => void this.cancel(session.id, "timeout"), this.limits.turnTimeoutMs)
    const abort = (): void => void this.cancel(session.id, "cancelled")
    turn.cleanup = () => signal?.removeEventListener("abort", abort)
    signal?.addEventListener("abort", abort, { once: true })
    this.input?.push(userMessage(message))
    if (signal?.aborted) abort()
    return turn
  }

  /** The long-lived process, started by the first thing that needs it. */
  private async ensureQuery(session: AgentSessionSnapshot): Promise<void> {
    // Effort is a start-up setting, and a model switch the process refused is one too; either needs a
    // fresh process that continues the conversation.
    if (this.query !== undefined && (this.effort !== this.startedEffort || this.model !== this.runningModel)) await this.closeQuery()
    if (this.query !== undefined) return
    const env = await this.commandEnvironment()
    // Identifies Runrail in Claude Code's User-Agent; it carries no credential.
    env.CLAUDE_AGENT_SDK_CLIENT_APP = `runrail/${RUNRAIL_VERSION}`
    const executable = Bun.which(this.commandOptions.command ?? "claude", { PATH: env.PATH ?? "" })
    if (executable === null) throw commandError("COMMAND_AGENT_NOT_FOUND", "Claude Code command was not found")
    const mcpServers = await this.mcpServers()
    const stored = this.vendorSessionId === undefined ? await this.storedSession(session.id) : undefined
    const resume = this.vendorSessionId ?? stored?.vendorSessionId
    const input = new InputQueue()
    const abort = new AbortController()
    const permissionMode = SDK_PERMISSION_MODE[this.launch.permissionMode ?? "ask"]
    const options: ClaudeSdkQueryOptions = {
      cwd: session.cwd,
      ...(this.launch.addDirs === undefined ? {} : { additionalDirectories: this.launch.addDirs }),
      pathToClaudeCodeExecutable: executable,
      env,
      permissionMode,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.effort === undefined ? {} : { effort: claudeEffort(this.effort) }),
      systemPrompt: { type: "preset", preset: "claude_code", ...(this.launch.appendSystemPrompt === undefined ? {} : { append: this.launch.appendSystemPrompt }) },
      ...(mcpServers === undefined ? {} : { mcpServers }),
      // The person's own settings only: a clone or a pull request's head brings its own
      // `.claude/settings.json` hooks and `.mcp.json` servers, which would run unasked.
      settingSources: Object.freeze(["user"]),
      allowedTools: Object.freeze([...(this.launch.allowedTools ?? []), ...CLAUDE_SEARCH_TOOL_RULES]),
      ...(resume === undefined ? {} : { resume }),
      // The init message reports the copy's id, which replaces the stored one.
      ...(stored?.fork === true ? { forkSession: true } : {}),
      // A rewind continues the copy from the turn it went back to.
      ...(stored?.fork === true && stored.at !== undefined ? { resumeSessionAt: stored.at } : {}),
      includePartialMessages: true,
      hooks: { PreToolUse: [{ hooks: [this.watchGate(claudeAskGate(permissionMode, this.launch.allowedTools, this.launch.askTools, session.cwd))] }] },
      canUseTool: (toolName, toolInput, context) => this.canUseTool(toolName, toolInput, context),
      onElicitation: (request, elicitationOptions) => this.elicit(request, elicitationOptions),
      abortController: abort,
      spawnClaudeCodeProcess: (spawnOptions) => this.spawnProcess(spawnOptions, session.cwd),
      toolConfig: CLAUDE_TOOL_CONFIG,
      settings: CLAUDE_SETTINGS,
    }
    let query: ClaudeSdkQuery
    try {
      query = this.sdk.query({ prompt: input, options })
    } catch {
      throw commandError("COMMAND_AGENT_FAILED", "Claude Code could not start")
    }
    this.query = query
    this.input = input
    this.abort = abort
    this.stderr = ""
    this.resumedWith = resume
    this.processVendorSessionId = undefined
    this.startedEffort = this.effort
    this.runningModel = this.model
    void this.readMessages(query)
  }

  private spawnProcess(options: ClaudeSdkSpawnOptions, cwd: string): ChildProcess {
    if (!isRecord(options) || typeof options.command !== "string" || options.command.length === 0 || !Array.isArray(options.args) || options.args.some((arg) => typeof arg !== "string")) throw commandError("COMMAND_AGENT_INVALID", "Claude Code launch is invalid")
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(isRecord(options.env) ? options.env : {})) if (typeof value === "string") env[name] = value
    // Detached, so a stop ends the process and every helper it started as one group.
    const child = spawn(options.command, [...options.args], { cwd: typeof options.cwd === "string" && options.cwd.length > 0 ? options.cwd : cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true })
    this.child = child
    this.childExited = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1))
      child.once("error", () => resolve(1))
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (this.child !== child || this.stderr.length >= MAX_STDERR_CHARS) return
      this.stderr = `${this.stderr}${String(chunk)}`.slice(0, MAX_STDERR_CHARS)
    })
    return child
  }

  private async readMessages(query: ClaudeSdkQuery): Promise<void> {
    try {
      for await (const message of query) {
        if (this.query !== query) return
        this.acceptMessage(message)
      }
      if (this.query === query) await this.queryEnded(query, commandError("COMMAND_AGENT_FAILED", "Claude Code exited"))
    } catch {
      if (this.query === query) await this.queryEnded(query, commandError("COMMAND_AGENT_FAILED", "Claude Code exited"))
    }
  }

  /** The process is gone. A turn it took with it fails, unless the conversation it continued was missing. */
  private async queryEnded(query: ClaudeSdkQuery, failure: CommandAgentBackendError): Promise<void> {
    const stderr = this.stderr
    const resumed = this.resumedWith
    if (this.query === query) await this.closeQuery()
    const active = this.active
    if (active === undefined) return
    if (active.cancelled !== undefined) {
      this.pushEvent(this.makeEvent("session.stopped", { reason: active.cancelled }), active)
      this.finishActive(active)
      return
    }
    if (resumed !== undefined && !active.opened && !active.retried && looksLikeMissingSession(stderr)) {
      // Claude Code no longer has that conversation. Forget it and run the prompt once from a clean start.
      active.retried = true
      this.launchResumeSpent = true
      await this.rememberVendorSession(undefined)
      try {
        await this.ensureQuery(this.currentSnapshot(this.requireSessionId()))
        this.input?.push(userMessage(active.message))
        return
      } catch (error) {
        this.failActive(normalizeError(error, "Claude Code could not start"))
        return
      }
    }
    this.failActive(looksLikeAuthFailure(stderr) ? commandError("COMMAND_AGENT_AUTH_FAILED", "harness authentication failed") : failure)
  }

  private acceptMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return
    if (value.type === "rate_limit_event") this.notePlan(claudePlanLimits(value.rate_limit_info))
    const active = this.active
    if (value.type === "system" && value.subtype === "init") {
      this.acceptInit(value, active)
      return
    }
    if (isTaskMessage(value)) {
      this.trackTask(value, active)
      const query = this.query
      mapClaudeTask(value, this.commandOptions, query === undefined ? undefined : (taskId) => query.stopTask(taskId))
      return
    }
    const compaction = this.compaction
    if (active === undefined && compaction !== undefined) {
      this.acceptCompaction(value, compaction)
      return
    }
    // Between turns only background tasks report; anything else belongs to no turn.
    if (active === undefined) return
    const limitMessage = harnessRateLimitMessage(value, "Claude Code")
    if (limitMessage !== undefined) {
      this.failActive(commandError("COMMAND_AGENT_RATE_LIMITED", limitMessage))
      return
    }
    // Claude Code retries a refused key or sign-in ten times over more than a minute; the answer will not change.
    if (value.type === "system" && value.subtype === "api_retry" && value.error === "authentication_failed") {
      this.failActive(commandError("COMMAND_AGENT_AUTH_FAILED", "harness authentication failed"))
      return
    }
    // Claude Code waits between its own retries and says nothing else meanwhile; this is the only sign of the wait.
    if (value.type === "system" && value.subtype === "api_retry") {
      const retry = claudeApiRetry(value, active.turnId)
      if (retry !== undefined) emitLive(this.commandOptions, retry)
      return
    }
    if (value.type === "system" && value.subtype === "permission_denied") {
      const toolName = typeof value.tool_name === "string" ? value.tool_name : "tool"
      const review = claudeDenial(value, approvalKind(toolName), typeof value.tool_use_id === "string" ? active.toolDetails.get(value.tool_use_id) : undefined)
      if (review !== undefined) {
        // Sent before the call's result, so that result can end as this denial.
        if (active.denied.size < 256) active.denied.add(value.tool_use_id as string)
        emitLive(this.commandOptions, { type: APPROVAL_REVIEWED, turnId: active.turnId, ...review })
      }
      return
    }
    if (value.type === "result" && active.cancelled !== undefined) {
      this.pushEvent(this.makeEvent("session.stopped", { reason: active.cancelled }), active)
      this.finishActive(active)
      return
    }
    let events: readonly AgentEvent[]
    try {
      const context = this.mappingContext(active)
      events = mappedEvents(mapClaudeCodeEvent(value, context))
      if (context.vendorMessageId !== undefined) active.vendorMessageId = context.vendorMessageId
    } catch {
      this.failActive(commandError("COMMAND_AGENT_OUTPUT_INVALID", "Claude Code output is invalid"))
      return
    }
    if (events.some((event) => event.type === "session.completed") && this.vendorSessionId !== undefined && active.vendorMessageId !== undefined) this.lastMark = Object.freeze({ session: this.vendorSessionId, at: active.vendorMessageId })
    for (const mapped of events) {
      if (this.active !== active) return
      this.acceptMapped(mapped, active)
    }
  }

  private acceptMapped(mapped: AgentEvent, active: SdkTurn): void {
    // The backend announces the session and the turn itself; Claude Code's own records would repeat them.
    if (mapped.type === "session.started" || mapped.type === "turn.started") return
    // A record can carry several events, so each takes the next number.
    let event: AgentEvent = Object.freeze({ ...mapped, seq: this.eventSequence + 1 })
    if (event.type === "tool.completed") {
      const gated = active.gated.delete(event.callId)
      const reported = active.denied.delete(event.callId)
      // The mapper's HARNESS_TOOL_FAILED only carries Claude Code's words; a denial still names itself.
      if (!event.ok && (event.error === undefined || event.error.code === "HARNESS_TOOL_FAILED") && (reported || (gated && active.cancelled === undefined))) {
        // A call the gate sent to the prompt that failed without reaching `canUseTool` was refused before asking, and Claude Code says nothing more.
        const review = reported ? undefined : claudeUnaskedDenial(event.callId, approvalKind(event.name), active.toolDetails.get(event.callId))
        if (review !== undefined) emitLive(this.commandOptions, { type: APPROVAL_REVIEWED, turnId: active.turnId, ...review })
        event = Object.freeze({ ...event, seq: this.eventSequence + 1, error: agentError("REVIEW_DENIED", "Claude Code denied this call without asking") })
      }
      if (active.inReply.delete(event.callId) && !event.ok) event = Object.freeze({ ...event, error: agentError("QUESTION_IN_REPLY", ASKED_IN_REPLY) })
    }
    try {
      this.pushEvent(event, active)
    } catch (error) {
      this.failActive(normalizeError(error, "Claude Code output is invalid"))
      return
    }
    if (event.type === "tool.started" && active.openTools.size < 256) {
      active.openTools.add(event.callId)
      const detail = toolDetail(event.input)
      if (detail !== undefined) {
        if (active.toolDetails.size >= 256) active.toolDetails.delete(active.toolDetails.keys().next().value as string)
        active.toolDetails.set(event.callId, detail)
      }
    } else if (event.type === "tool.completed") active.openTools.delete(event.callId)
    if (event.type === "session.completed" || event.type === "session.failed" || event.type === "session.stopped") this.finishActive(active)
  }

  /** Claude Code while it compacts between turns. Its summary and the command's echo are not shown. */
  private acceptCompaction(record: Record<string, unknown>, pending: PendingCompaction): void {
    const limitMessage = harnessRateLimitMessage(record, "Claude Code")
    if (limitMessage !== undefined) {
      this.endCompaction(commandError("COMMAND_AGENT_RATE_LIMITED", limitMessage))
      void this.closeQuery()
      return
    }
    if (record.type === "system" && record.subtype === "api_retry" && record.error === "authentication_failed") {
      this.endCompaction(commandError("COMMAND_AGENT_AUTH_FAILED", "harness authentication failed"))
      void this.closeQuery()
      return
    }
    if (record.type === "system" && record.subtype === "compact_boundary") {
      const metadata = isRecord(record.compact_metadata) ? record.compact_metadata : {}
      pending.boundary = true
      pending.before = tokenCount(metadata.pre_tokens)
      pending.after = tokenCount(metadata.post_tokens)
      return
    }
    if (record.type === "rate_limit_event") {
      const limits = claudePlanLimits(record.rate_limit_info)
      if (limits !== undefined) emitLive(this.commandOptions, limits)
      return
    }
    if (record.type !== "result") return
    // Too short a conversation, or a failed summary, ends without a boundary.
    if (record.is_error === true || record.subtype !== "success" || !pending.boundary) this.endCompaction(commandError("COMMAND_AGENT_FAILED", "Claude Code could not compact the conversation"))
    else this.endCompaction()
  }

  private endCompaction(failure?: CommandAgentBackendError): void {
    const pending = this.compaction
    if (pending === undefined) return
    this.compaction = undefined
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (failure !== undefined) pending.reject(failure)
    else pending.resolve({ ...(pending.before === undefined ? {} : { before: pending.before }), ...(pending.after === undefined ? {} : { after: pending.after }) })
  }

  /** Claude Code opens the conversation again on every turn; within one process it must stay the same one. */
  private acceptInit(record: Record<string, unknown>, active: SdkTurn | undefined): void {
    const reported = record.session_id
    if (!isVendorSessionId(reported) || (this.processVendorSessionId !== undefined && this.processVendorSessionId !== reported)) {
      if (active !== undefined) this.failActive(commandError("COMMAND_AGENT_OUTPUT_INVALID", "Claude Code session identity does not match"))
      else void this.closeQuery()
      return
    }
    this.processVendorSessionId = reported
    if (active !== undefined) active.opened = true
    if (this.vendorSessionId !== reported) void this.rememberVendorSession(reported)
    // Claude Code runs auto mode it cannot use (its settings, the model, fast mode, its circuit breaker) as default, and says so only here.
    const mode = typeof record.permissionMode === "string" ? record.permissionMode : undefined
    if (this.launch.permissionMode === "auto" && mode !== undefined && mode !== this.reportedMode && active !== undefined) {
      this.reportedMode = mode
      if (mode === "default") emitLive(this.commandOptions, { type: REVIEWER_NOTICE, turnId: active.turnId, reviewer: "claude-code", notice: "unavailable" })
    }
  }

  private trackTask(record: Record<string, unknown>, active: SdkTurn | undefined): void {
    const taskId = typeof record.task_id === "string" && record.task_id.length > 0 && record.task_id.length <= 200 ? record.task_id : undefined
    if (taskId === undefined) return
    if (record.subtype === "task_started") {
      if (active !== undefined && active.tasks.size < 256) active.tasks.add(taskId)
      return
    }
    const patch = isRecord(record.patch) ? record.patch : {}
    const ended = record.subtype === "task_notification" || (record.subtype === "task_updated" && typeof patch.status === "string" && patch.status !== "pending" && patch.status !== "running" && patch.status !== "paused")
    if (ended) active?.tasks.delete(taskId)
  }

  private async stopTurnTasks(turn: SdkTurn, query: ClaudeSdkQuery): Promise<void> {
    const tasks = [...turn.tasks]
    turn.tasks.clear()
    await Promise.all(tasks.map((taskId) => Promise.race([query.stopTask(taskId).catch(() => undefined), delay(2_000)])))
  }

  private async canUseTool(toolName: string, input: Record<string, unknown>, context: ClaudeSdkPermissionContext): Promise<ClaudeSdkPermissionResult> {
    const active = this.active
    if (typeof toolName !== "string" || !isRecord(input) || !isRecord(context) || !(context.signal instanceof AbortSignal)) return deny("The request is invalid.", true)
    // Outside a turn or while one is being cancelled, nothing is granted.
    if (active === undefined || active.cancelled !== undefined || context.signal.aborted) return deny("No turn is running.", true)
    if (typeof context.toolUseID === "string") active.gated.delete(context.toolUseID)
    const callId = typeof context.toolUseID === "string" ? context.toolUseID : undefined
    // A question is never allowed by a rule: without its answers Claude Code has nothing to read.
    const questions = toolName === "AskUserQuestion" ? claudeQuestions(input) : undefined
    if (toolName === "AskUserQuestion" && questions === undefined) return this.askInReply(active, callId)
    const cwd = this.sessionId === undefined ? undefined : this.sessions.get(this.sessionId)?.cwd
    const every = this.asksEveryTime(toolName) || (cwd === undefined ? EDIT_TOOL_NAMES.has(toolName) : claudeEditsControlPath(toolName, input, cwd))
    if (questions === undefined && !every && this.grants.some((grant) => claudeGrantCovers(grant, toolName, input))) return Object.freeze({ behavior: "allow", updatedInput: input })
    const fromVendor = typeof context.toolUseID === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(context.toolUseID) ? `claude-${context.toolUseID}` : undefined
    const approvalId = fromVendor ?? `claude-approval-${++this.approvalSequence}`
    if (this.approvals.has(approvalId)) return deny("The request repeats an earlier one.", true)
    // Claude Code may suggest saving a rule to the user's or the project's settings file. An answer
    // for this session never writes one, so every rule is kept to the session.
    const suggestions = questions === undefined && Array.isArray(context.suggestions) ? context.suggestions.slice(0, MAX_SUGGESTIONS).filter(isRecord).map((suggestion) => Object.freeze({ ...suggestion, destination: "session" })) : []
    const takesFollowUp = questions !== undefined && claudeTakesFollowUp(input)
    return await new Promise<ClaudeSdkPermissionResult>((resolve) => {
      const pending: PendingApproval = { turnId: active.turnId, toolName, input, suggestions, resolve, scope: "once", ...(questions === undefined ? {} : { questions }), ...(callId === undefined ? {} : { callId }), ...(takesFollowUp ? { takesFollowUp: true as const } : {}) }
      const reason = questions === undefined ? approvalReason(toolName, input, context) : claudeQuestionsTitle(input) ?? questionsReason(questions)
      const kind = questions === undefined ? approvalKind(toolName) : { action: QUESTION_ACTION, capability: QUESTION_CAPABILITY, questions, ...(takesFollowUp ? { takesFollowUp: true } : {}) }
      this.askPerson(pending, approvalId, context.signal, { ...kind, ...(reason === undefined ? {} : { reason }) }, active)
    })
  }

  /**
   * An MCP server's form, which Claude Code passes on when no hook answers it, asked as questions.
   * One Runrail cannot show is declined, and the person sees it and why.
   */
  private async elicit(request: ClaudeSdkElicitationRequest, options: { readonly signal: AbortSignal }): Promise<ClaudeSdkElicitationResult> {
    const active = this.active
    // Outside a turn nobody is there to answer.
    if (!isRecord(options) || !(options.signal instanceof AbortSignal) || active === undefined || active.cancelled !== undefined || options.signal.aborted) return ELICITATION_CANCELLED
    const asked = mcpElicitation(request)
    const approvalId = `claude-elicitation-${++this.approvalSequence}`
    const form = asked.form
    if (form === undefined) {
      try {
        this.pushEvent(this.makeEvent("approval.required", { turnId: active.turnId, approvalId, ...asked.approval }), active)
        this.pushEvent(this.makeEvent("approval.resolved", { turnId: active.turnId, approvalId, approved: false, reason: boundedReason(asked.declined ?? DECLINED) }), active)
      } catch (error) {
        this.failActive(normalizeError(error, "Claude Code output is invalid"))
      }
      return Object.freeze({ action: "decline" })
    }
    return await new Promise<ClaudeSdkElicitationResult>((settle) => {
      const pending: PendingApproval = { turnId: active.turnId, toolName: "", input: {}, suggestions: [], resolve: () => settle(ELICITATION_CANCELLED), scope: "once", elicitation: { form, settle }, ...(form.questions.length === 0 ? {} : { questions: form.questions }) }
      this.askPerson(pending, approvalId, options.signal, asked.approval, active)
    })
  }

  /** Waits on the person's answer; one Claude Code takes back before then is withdrawn. */
  private askPerson(pending: PendingApproval, approvalId: string, signal: AbortSignal, shown: Readonly<Record<string, unknown>>, active: SdkTurn): void {
    const onAbort = (): void => {
      if (this.approvals.get(approvalId) !== pending) return
      this.approvals.delete(approvalId)
      pending.resolve(deny("The request was withdrawn.", true))
      // Claude Code dropped the request mid-turn, so its card must not stay waiting on the person.
      const current = this.active
      if (current !== undefined && current.turnId === pending.turnId && current.cancelled === undefined) this.pushEvent(this.makeEvent("approval.resolved", { turnId: pending.turnId, approvalId, approved: false, withdrawn: true, reason: "Claude Code withdrew the request" }), current)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    pending.cleanup = () => signal.removeEventListener("abort", onAbort)
    this.approvals.set(approvalId, pending)
    try {
      this.pushEvent(this.makeEvent("approval.required", { turnId: active.turnId, approvalId, ...shown }), active)
    } catch (error) {
      this.approvals.delete(approvalId)
      pending.cleanup()
      pending.resolve(deny("The request could not be shown.", true))
      this.failActive(normalizeError(error, "Claude Code output is invalid"))
    }
  }

  private asksEveryTime(toolName: string): boolean {
    return this.launch.askTools?.includes(toolName) === true
  }

  /** The gate, noting each call it sends to Claude Code's prompt. */
  private watchGate(gate: ClaudeSdkHookCallback): ClaudeSdkHookCallback {
    return async (input, toolUseId, options) => {
      const output = await gate(input, toolUseId, options)
      const active = this.active
      if (output.hookSpecificOutput?.permissionDecision === "ask" && typeof toolUseId === "string" && active !== undefined && active.gated.size < 256) active.gated.add(toolUseId)
      return output
    }
  }

  private remember(suggestions: readonly unknown[]): void {
    for (const grant of claudeSessionGrants(suggestions)) {
      if (this.grants.length >= MAX_SESSION_GRANTS) return
      if (!this.grants.some((kept) => kept.tool === grant.tool && kept.content === grant.content)) this.grants.push(grant)
    }
  }

  /** Claude Code is told to ask in its reply; its call then ends saying so to the person. */
  private askInReply(active: SdkTurn, callId: string | undefined): ClaudeSdkPermissionResult {
    if (callId !== undefined && active.inReply.size < 256) active.inReply.add(callId)
    return deny(ASK_IN_REPLY)
  }

  private releaseApprovals(): void {
    for (const pending of this.approvals.values()) {
      pending.cleanup?.()
      pending.resolve(deny("The turn was stopped.", true))
    }
    this.approvals.clear()
  }

  private mappingContext(turn: SdkTurn): HarnessEventMappingContext {
    const session = this.currentSnapshot(this.requireSessionId())
    return {
      sessionId: session.id,
      cwd: session.cwd,
      backend: session.backend,
      nextSeq: this.eventSequence + 1,
      previous: session,
      turnId: turn.turnId,
      turnState: turn.turnState,
      tolerateUnknown: true,
      ...(this.vendorSessionId === undefined ? {} : { vendorSessionId: this.vendorSessionId }),
      ...(this.commandOptions.onLive === undefined ? {} : { onLive: this.commandOptions.onLive }),
      ...(this.commandOptions.onMetadata === undefined ? {} : { onMetadata: this.commandOptions.onMetadata }),
    }
  }

  /**
   * MCP configuration as print mode takes it (`--mcp-config`: JSON documents or files), merged into
   * the SDK's server map. A later document's server replaces an earlier one of the same name.
   */
  private async mcpServers(): Promise<Readonly<Record<string, unknown>> | undefined> {
    const configs = this.launch.mcpConfig
    if (configs === undefined || configs.length === 0) return undefined
    const servers: Record<string, unknown> = {}
    for (const config of configs) {
      let text: string
      try {
        text = config.trimStart().startsWith("{") ? config : await readFile(config, "utf8")
      } catch {
        throw commandError("COMMAND_AGENT_INVALID", "MCP configuration could not be read")
      }
      if (Buffer.byteLength(text, "utf8") > MAX_MCP_CONFIG_BYTES) throw commandError("COMMAND_AGENT_INVALID", "MCP configuration is too large")
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        throw commandError("COMMAND_AGENT_INVALID", "MCP configuration is invalid")
      }
      const map = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined
      if (map === undefined) throw commandError("COMMAND_AGENT_INVALID", "MCP configuration is invalid")
      for (const [name, server] of Object.entries(map)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !isRecord(server)) throw commandError("COMMAND_AGENT_INVALID", "MCP configuration is invalid")
        servers[name] = server
      }
    }
    if (Object.keys(servers).length > MAX_MCP_SERVERS) throw commandError("COMMAND_AGENT_INVALID", "MCP configuration names too many servers")
    return Object.freeze(servers)
  }

  private async storedSession(sessionId: string): Promise<VendorSessionEntry | undefined> {
    let stored: VendorSessionEntry | undefined
    try {
      stored = await vendorSessionEntry(this.commandOptions.vendorSessions, sessionId)
    } catch {
      stored = undefined
    }
    if (stored !== undefined) return stored
    const known = this.launchResumeSpent ? undefined : this.launch.resume
    return isVendorSessionId(known) ? Object.freeze({ vendorSessionId: known, fork: false }) : undefined
  }

  vendorMark(sessionId: string): { readonly session: string; readonly at: string } | undefined {
    return sessionId === this.sessionId ? this.lastMark : undefined
  }

  /** As the print route's: the next query continues a copy of `before`'s conversation from its mark. */
  async prepareRewind(sessionId: string, target: { readonly before?: { readonly session: string; readonly at: string } }): Promise<(() => Promise<void>) | undefined> {
    const store = this.commandOptions.vendorSessions
    const before = target.before
    if (store === undefined || before === undefined || !isVendorSessionId(before.session) || !isMessageMark(before.at)) return undefined
    return () => store.save(sessionId, before.session, { fork: true, at: before.at })
  }

  private rememberVendorSession(vendorSessionId: string | undefined): Promise<void> {
    this.vendorSessionId = vendorSessionId
    const store = this.commandOptions.vendorSessions
    const sessionId = this.sessionId
    if (store === undefined || sessionId === undefined) return this.saving
    // Losing the id only costs continuity after a restart; it never fails the session.
    this.saving = this.saving.then(() => store.save(sessionId, vendorSessionId)).catch(() => {})
    return this.saving
  }

  private async closeQuery(): Promise<void> {
    this.endCompaction(commandError("COMMAND_AGENT_FAILED", "Claude Code stopped while compacting"))
    const query = this.query
    const child = this.child
    const exited = this.childExited
    this.query = undefined
    this.child = undefined
    this.childExited = undefined
    this.processVendorSessionId = undefined
    this.input?.close()
    this.input = undefined
    this.releaseApprovals()
    try {
      query?.close()
    } catch {
      // The process is going away either way.
    }
    this.abort?.abort()
    this.abort = undefined
    if (child !== undefined && exited !== undefined && typeof child.pid === "number") {
      const pid = child.pid
      await terminateProcessTree({ pid, exited, kill: (signal) => void child.kill(signal) })
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

  private makeEvent(type: string, payload: Record<string, unknown>): AgentEvent {
    const sessionId = this.requireSessionId()
    const seq = this.eventSequence + 1
    const candidate: unknown = Object.freeze({ version: 1, sessionId, seq, at: Date.now(), type, ...stampEventSnapshot(payload, seq) })
    if (!isAgentEvent(candidate)) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Claude Code event could not be normalized")
    return candidate
  }

  private pushEvent(event: AgentEvent, active: SdkTurn): void {
    if (event.sessionId !== this.sessionId || event.seq <= this.eventSequence) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Claude Code event is out of order")
    active.eventCount += 1
    if (active.eventCount > this.limits.maxEvents) throw commandError("COMMAND_AGENT_OUTPUT_INVALID", "Claude Code event count exceeded its limit")
    this.eventSequence = event.seq
    this.updateSnapshotFromEvent(event)
    active.queue.push(event)
  }

  private failActive(failure: CommandAgentBackendError): void {
    const active = this.active
    if (active === undefined) return
    const auth = failure.code === "COMMAND_AGENT_AUTH_FAILED"
    const limited = failure.code === "COMMAND_AGENT_RATE_LIMITED"
    const event = this.makeEvent("session.failed", { error: agentError(failure.code, limited ? failure.reason : auth ? "Claude Code refused its sign-in or key" : "Claude Code turn failed"), recoverable: !auth && !limited })
    this.eventSequence = event.seq
    this.updateSnapshotFromEvent(event)
    active.queue.push(event)
    this.releaseApprovals()
    this.finishActive(active)
    // What the process does next is unknown; the next turn starts a fresh one that continues the conversation.
    if (this.query !== undefined) void this.closeQuery()
  }

  private finishActive(active: SdkTurn): void {
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.cleanup?.()
    active.queue.complete()
    active.settle()
    if (this.active === active) this.active = undefined
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
    if (event.type === "session.started" || event.type === "turn.started" || event.type === "approval.resolved") status = "running"
    else if (event.type === "approval.required") status = "waiting"
    else if (event.type === "session.completed") status = "completed"
    else if (event.type === "session.failed") status = "failed"
    else if (event.type === "session.stopped") status = "stopped"
    this.sessions.set(event.sessionId, makeSnapshot(previous.id, previous.backend, previous.cwd, status, event.seq, previous.capabilities, previous.createdAt, event.type === "turn.started" ? event.turnId : undefined))
  }
}

/** What the approval is for, from Claude Code's tool name. */
function approvalKind(toolName: string): { readonly action: string; readonly capability: string } {
  if (COMMAND_TOOLS.has(toolName)) return { action: "command", capability: "process.exec" }
  if (WRITE_TOOLS.has(toolName)) return { action: "file_change", capability: "filesystem.write" }
  if (NETWORK_TOOLS.has(toolName)) return { action: "permission", capability: "network.request" }
  if (toolName === "ExitPlanMode") return { action: "plan", capability: "tool.use" }
  return { action: "permission", capability: "tool.use" }
}

/** The command, file, or address a tool call names. */
function toolDetail(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  return reviewLine(input.command, MAX_REVIEW_DETAIL) ?? reviewLine(input.file_path, MAX_REVIEW_DETAIL) ?? reviewLine(input.notebook_path, MAX_REVIEW_DETAIL) ?? reviewLine(input.url, MAX_REVIEW_DETAIL)
}

/** One line the user decides on: the tool and the command, file, or address it names. */
function approvalReason(toolName: string, input: Record<string, unknown>, context: ClaudeSdkPermissionContext): string | undefined {
  if (toolName === "ExitPlanMode") return "Leave plan mode and start making changes"
  const label = oneLine(context.displayName) ?? oneLine(context.title) ?? oneLine(toolName)
  const detail = oneLine(input.command) ?? oneLine(input.file_path) ?? oneLine(input.notebook_path) ?? oneLine(input.url) ?? oneLine(context.description)
  const text = detail === undefined ? label : label === undefined ? detail : `${label}: ${detail}`
  return text === undefined ? undefined : text.slice(0, MAX_REASON_CHARS)
}

function oneLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/[\0-\x1f\x7f]+/g, " ").trim()
  return text.length === 0 ? undefined : text
}

function deny(message: string, interrupt = false): ClaudeSdkPermissionResult {
  return Object.freeze({ behavior: "deny", message, ...(interrupt ? { interrupt: true } : {}) })
}

function userMessage(text: string, priority?: "next"): ClaudeSdkUserMessage {
  return Object.freeze({ type: "user", message: Object.freeze({ role: "user", content: text }), parent_tool_use_id: null, ...(priority === undefined ? {} : { priority }) })
}

/** Claude Code's levels run from low to max. */
function claudeEffort(effort: HarnessEffort): NonNullable<ClaudeSdkQueryOptions["effort"]> {
  if (effort === "minimal") return "low"
  if (effort === "ultra") return "max"
  return effort
}

function isTaskMessage(record: Record<string, unknown>): boolean {
  return record.type === "system" && typeof record.subtype === "string" && (record.subtype.startsWith("task_") || record.subtype === "background_tasks_changed")
}

class InputQueue implements AsyncIterable<ClaudeSdkUserMessage> {
  private readonly messages: ClaudeSdkUserMessage[] = []
  private readonly waiters: Array<(result: IteratorResult<ClaudeSdkUserMessage>) => void> = []
  private done = false

  push(message: ClaudeSdkUserMessage): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: message })
    else this.messages.push(message)
  }

  close(): void {
    if (this.done) return
    this.done = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkUserMessage> {
    return {
      next: () => {
        const message = this.messages.shift()
        if (message !== undefined) return Promise.resolve({ done: false, value: message })
        if (this.done) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
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

function makeSnapshot(id: string, backend: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq: number, capabilities: readonly string[], createdAt = Date.now(), activeTurnId?: string): AgentSessionSnapshot {
  return Object.freeze({ version: 1, id, backend, cwd, status, createdAt, updatedAt: Date.now(), lastSeq, capabilities: Object.freeze([...capabilities]), ...(activeTurnId === undefined ? {} : { activeTurnId }) })
}

function validateOptions(options: ClaudeAgentSdkBackendOptions): void {
  if (options === null || typeof options !== "object") throw commandError("COMMAND_AGENT_INVALID", "options are invalid")
  if (options.sdk === null || typeof options.sdk !== "object" || typeof options.sdk.query !== "function") throw commandError("COMMAND_AGENT_INVALID", "Claude Agent SDK is invalid")
  if (options.name !== undefined && !validId(options.name)) throw commandError("COMMAND_AGENT_INVALID", "backend name is invalid")
  if (options.command !== undefined && (typeof options.command !== "string" || options.command.length === 0 || options.command.length > 4_096 || options.command.startsWith("-") || options.command.includes("\0"))) throw commandError("COMMAND_AGENT_INVALID", "command is invalid")
  if (options.turnTimeoutMs !== undefined && (!Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs < 1 || options.turnTimeoutMs > 86_400_000)) throw commandError("COMMAND_AGENT_INVALID", "turn timeout is invalid")
  if (options.maxEvents !== undefined && (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 1_000_000)) throw commandError("COMMAND_AGENT_INVALID", "event bound is invalid")
  if (options.vendorSessions !== undefined && (options.vendorSessions === null || typeof options.vendorSessions !== "object" || typeof options.vendorSessions.load !== "function" || typeof options.vendorSessions.save !== "function")) throw commandError("COMMAND_AGENT_INVALID", "vendor session store is invalid")
  if (options.onLive !== undefined && typeof options.onLive !== "function") throw commandError("COMMAND_AGENT_INVALID", "live sink is invalid")
  if (options.onMetadata !== undefined && typeof options.onMetadata !== "function") throw commandError("COMMAND_AGENT_INVALID", "metadata sink is invalid")
  if (options.onApproved !== undefined && typeof options.onApproved !== "function") throw commandError("COMMAND_AGENT_INVALID", "approval sink is invalid")
  if (options.routeEnv !== undefined && !isRouteEnvironment(options.routeEnv)) throw commandError("COMMAND_AGENT_INVALID", "route environment is invalid")
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

/** Matches only the vendor's "that conversation does not exist" wording; the text itself is never kept. */
function looksLikeMissingSession(stderr: string): boolean {
  return /no\s+(?:conversation|session)\s+found|(?:conversation|session)\s+(?:\S+\s+)?(?:was\s+)?not\s+found/i.test(stderr)
}

function looksLikeAuthFailure(stderr: string): boolean {
  return /not\s+(?:logged\s+in|authenticated)|authentication\s+(?:failed|required)|unauthori[sz]ed|login\s+required|invalid\s+api\s+key|oauth\s+session\s+expired|session\s+expired|could\s+not\s+be\s+refreshed/i.test(stderr)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

type CompactionReason = "manual" | "threshold" | "overflow" | "workflow"

const COMPACTION_REASONS: ReadonlySet<string> = new Set(["manual", "threshold", "overflow", "workflow"])

interface ClaudeContextReading {
  readonly usedTokens: number
  readonly windowTokens: number
  readonly autoCompactAt?: number
}

/** `getContextUsage`'s totals, checked like any other vendor output. */
function claudeContextReading(value: unknown): ClaudeContextReading | undefined {
  if (!isRecord(value)) return undefined
  const usedTokens = tokenCount(value.totalTokens)
  const windowTokens = tokenCount(value.maxTokens)
  if (usedTokens === undefined || windowTokens === undefined || windowTokens === 0) return undefined
  const threshold = value.isAutoCompactEnabled === false ? undefined : tokenCount(value.autoCompactThreshold)
  const autoCompactAt = threshold !== undefined && threshold > 0 && threshold <= windowTokens ? threshold : undefined
  return { usedTokens, windowTokens, ...(autoCompactAt === undefined ? {} : { autoCompactAt }) }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
