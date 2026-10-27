import { RUNRAIL_VERSION } from "./version.ts"
import { homedir } from "node:os"
import { join } from "node:path"
import { isVendorMark, TurnCheckpoints, type TurnCheckpoint, type VendorMark } from "./checkpoints/turns.ts"
import { nifraApplies, nifraMcpServer, verificationGateAvailable, type NifraUse } from "./nifra.ts"
import { GitError } from "./git/errors.ts"
import type {
  AgentBackend,
  AgentEvent,
  AgentSessionSnapshot,
  ForkSessionResult,
  ReloadResult,
} from "@nifrajs/agent-protocol"
import {
  CodingAgentHost,
  discoverExtensions,
  ExtensionHost,
  FileSessionStore,
  NIFRA_AGENT_INSTRUCTIONS,
  ReplayBackend,
  type SessionStore,
  type ApprovalTimeout,
  type NativeApprovalPort,
  type NativeModelPort,
  type NativeTool,
  type PiBackendOptions,
  type UiExtensionHost,
  validateExtensionModule,
} from "@nifrajs/coding-agent"
import type { VerificationName } from "./cli.ts"
import { RunrailBackend } from "./backend/runrail-backend.ts"
import { createPiBackend } from "./backend/pi.ts"
import { createReplayBackend } from "./backend/replay.ts"
import { CommandAgentBackendError } from "./backend/command-agent.ts"
import {
  BudgetLedger,
  BudgetedModelPort,
  RunrailBudgetError,
  type RunrailBudget,
  type RunrailUsage,
} from "./model/budget.ts"
import {
  ModelCatalog,
  ModelCatalogError,
  createModelCatalog,
  createRoutedModelPort,
  type ModelAdapter,
  type ModelDescriptor,
  type ModelSelection,
  type RoutedModelPort,
} from "./model/catalog.ts"
import { ScriptedModel } from "./model/scripted-model.ts"
import { CommandModelPort, type CommandModelOptions } from "./model/command.ts"
import { FallbackModelPort } from "./model/fallback.ts"
import { createContentModelPort, type RunrailContentModelPort, type RunrailContentPart } from "./model/content.ts"
import { createMcpContextResources, createMcpNativeTools, createMcpPromptCatalog } from "./mcp/bridge.ts"
import type { McpClient } from "./mcp/client.ts"
import { connectConfiguredMcp, grantConfiguredMcp, NO_CONFIGURED_MCP, type ConfiguredMcp, type McpServerStatus } from "./mcp/configured.ts"
import type { McpSignIns } from "./mcp/oauth.ts"
import {
  ContextResourceSet,
  createContextAwareModelPort,
  createContextResourceSet,
  type ContextResourceOptions,
  type RunrailPromptInput,
} from "./context/resources.ts"
import { CachedModelPort, MeteredModelPort, RunrailMetrics, type ModelCache } from "./runtime/metrics.ts"
import { createDefaultBackendRegistry, isAcpRouteBackend, vendorSessionStore } from "./backend/defaults.ts"
import type { VendorSessionStore } from "./harness/vendor-session-store.ts"
import { FOLLOW_UP_UNSUPPORTED, QUESTION_NEEDS_ANSWERS, type ApprovalAnswers, type FollowUp } from "./harness/questions.ts"
import {
  applyBehaviorToolPolicy,
  createBehaviorApprovalPort,
  filterToolsForMode,
  loadBehaviorForSession,
  resolveBehaviorConfigPath,
  type BehaviorConfig,
  type BehaviorMcpServer,
} from "./behavior/config.ts"
import { exportSessionEvidence, importSessionEvidence, isImportedEvidencePayload, type SessionEvidenceBundle } from "./session/transfer.ts"
import type { TranscriptBundle, TranscriptCompactionOptions, TranscriptReadOptions, TranscriptRecord, TranscriptRecoveryResult, TranscriptStore } from "./transcript/index.ts"
import type { BackendRegistry, RunrailBackendAdapter } from "./backend/registry.ts"
import type { PluginHost, PluginHostSnapshot } from "./plugins/sdk.ts"
import type { PiExtensionHost } from "./plugins/pi/extensions.ts"
import type { ConnectorNativeToolOptions, ConnectorRegistry } from "./connectors/registry.ts"
import { createConfiguredProviderModelAdapter } from "./providers/catalog.ts"
import { carryoverText } from "./session/carryover.ts"
import { SESSION_CONTINUED } from "./conversation/index.ts"
import { SteeringModelPort } from "./session/steer.ts"
import type { RunrailApiRetryFrame, RunrailApprovalReviewedFrame, RunrailLiveSink, RunrailReviewerNoticeFrame, RunrailUsageReading } from "./live/types.ts"
import { apiRetryFrame } from "./harness/api-retry.ts"
import { reviewFrame } from "./harness/review.ts"
import type { ProviderModelOptions } from "./providers/types.ts"
import { NativeBackgroundCommands } from "./background/native-commands.ts"
import { createToolCatalog } from "./tools/catalog.ts"
import type { RunrailBrowserAccess } from "./browser/bridge.ts"
import { BROWSER_MCP_ALLOWED_TOOLS, BROWSER_MCP_HINT } from "./browser/mcp.ts"
import { CONNECTORS_ACP_HINT, CONNECTORS_MCP_HINT, CONNECTORS_MCP_SERVER, connectorsPermissions } from "./connectors/mcp.ts"
import { writePiConnectorsExtension, type PiConnectorsExtension } from "./connectors/pi.ts"
import { connectorNativeTools, grantedConnectorTools, grantOf, mcpGrantKey, type GrantedConnectorTool } from "./connectors/tools.ts"
import { ConnectorApprovals } from "./connectors/approvals.ts"
import { createBrowserTools } from "./browser/tools.ts"
import type { RunrailThreadsAccess } from "./threads/bridge.ts"
import { THREADS_MCP_ALLOWED_TOOLS, THREADS_MCP_HINT } from "./threads/mcp.ts"
import { createThreadsTools } from "./threads/tools.ts"
import type { RunrailComputerAccess } from "./computer/bridge.ts"
import { COMPUTER_MCP_ALLOWED_TOOLS, COMPUTER_MCP_HINT } from "./computer/mcp.ts"
import { IMAGES_MCP_ALLOWED_TOOLS, IMAGES_MCP_HINT } from "./images/mcp.ts"
import type { RunrailImageAccess } from "./images/service.ts"
import { createImageTools } from "./images/tools.ts"
import { createSkillReadTool } from "./tools/skill-read.ts"
import { integrationRequirements, unsupportedIntegrations, type RunrailIntegrationBundle } from "./integrations.ts"
import { createDefaultSkillRegistry, type SkillRegistry } from "./skills/registry.ts"
import { createWorkspacePolicy, filteredEnvironment, type WorkspacePolicy } from "./workspace/policy.ts"
import type { HarnessAccountOptions } from "./harness/account.ts"
import type { HarnessAuthOptions, HarnessMetadataSink, HarnessProtocol } from "./harness/types.ts"
import { HarnessLaunchError, MAX_APPEND_SYSTEM_PROMPT, deriveHarnessLaunch, isHarnessModelId, type HarnessLaunchOptions } from "./harness/launch.ts"
import { createHistoryModelPort, historyFromTranscript, ModelHistory } from "./session/history.ts"
import { assembleSystemPrompt, createSystemPromptModelPort, createSystemPromptSource, promptFamily, readPromptEnvironment } from "./prompt/index.ts"
import { timed } from "./startup-timings.ts"

export interface RunrailSessionOptions {
  readonly cwd: string
  /**
   * The project's related folders: absolute paths the agent may read and edit
   * beside `cwd`. Runrail's own loop, Claude Code and Codex take them; other routes refuse them.
   */
  readonly folders?: readonly string[]
  readonly backend: string
  /** Optional caller-supplied adapter for a backend name outside the shipped set. */
  readonly adapter?: RunrailBackendAdapter
  readonly registry?: BackendRegistry
  readonly requiredCapabilities?: readonly string[]
  readonly maxSteps?: number
  /**
   * `false` sends a provider only the project context and the caller's own instructions, without
   * Runrail's default coding prompt. It has no effect on a model that is not a provider.
   */
  readonly defaultSystemPrompt?: boolean
  /**
   * How long a native approval waits for an answer before it is refused: 1 ms to 24 hours, or
   * `"never"` (the default), which waits until it is answered or its turn ends.
   */
  readonly approvalTimeoutMs?: ApprovalTimeout
  /**
   * Longest reply the native model may give in one turn, in characters: default 1 MiB, from 256 to
   * 16 MiB. Past it the reply is cut with a marker; a reply longer than one event's text arrives as
   * consecutive `assistant.message` events.
   */
  readonly maxReplyChars?: number
  readonly maxRepairAttempts?: number
  /**
   * Check the workspace after each turn and, when the check fails, send the agent a repair prompt.
   * Unset: a named command always, and an installed `nifra` in a Nifra project. `true` also runs that
   * `nifra` in any other workspace; `false` turns the gate off whatever is installed.
   */
  readonly verifyAfterTurn?: boolean
  /**
   * Nifra's tools, instructions, and default check (see nifra.ts). Unset: only in a Nifra project,
   * unless `RUNRAIL_NIFRA` says otherwise. `false` turns them all off; `true` turns them on anywhere.
   */
  readonly nifra?: boolean
  readonly verify?: VerificationName
  readonly verificationCommand?: string
  readonly verificationTimeoutMs?: number
  readonly sessionDir?: string
  readonly sessionId?: string
  /**
   * Snapshot the work tree before each turn, so a rewind can put files back. Needs
   * `sessionDir`, where the snapshots are kept.
   */
  readonly checkpoints?: boolean
  /**
   * Skill ids excluded from selection. Managed at runtime through the
   * skills RPC; reapplied whenever the session is recreated.
   */
  readonly disabledSkills?: readonly string[]
  /**
   * Also read the user-wide skill folders (`.agents/skills`, `.claude/skills`, `.codex/skills`,
   * `.pi/agent/skills` and `.config/opencode/skills` under the home directory) in place, ranked
   * below the project's own. `{ home }` names another home directory. When unset, the behavior
   * file's `skills.userRoots` decides; off by default.
   */
  readonly userSkills?: boolean | { readonly home: string }
  /**
   * Optional behavior config file. When set —
   * or when it defaults to `<sessionDir>/config.json` — the file is read at
   * every session creation: strict on first load, last-good fallback after.
   */
  readonly behaviorConfigPath?: string
  /**
   * False: `sessionDir` holds no behavior file, so only `behaviorConfigPath` is read. The command
   * line keeps its sessions so; a desktop thread's folder carries its own.
   */
  readonly sessionBehaviorFile?: boolean
  /** Optional caller-owned payload store; omitted sessions remain content-free. */
  readonly transcriptStore?: TranscriptStore
  /** Imports the workspace's `.nifra/extensions` into this process at start; only for a workspace the person trusts. */
  readonly loadExtensions?: boolean
  readonly pi?: Pick<
    PiBackendOptions,
    | "command"
    | "args"
    | "env"
    | "maxEventQueueSize"
    | "rpcArgs"
    | "sessionDir"
    | "noSession"
    | "reloadCommand"
    | "enableReloadBridge"
    | "appendSystemPrompt"
    | "enableNifraTools"
  >
  readonly approval?: NativeApprovalPort
  /**
   * The caller resolves approvals through `resolveApproval`, so a request the
   * policy wants reviewed stays pending. One-shot runs leave this off and such
   * requests are denied at once.
   */
  readonly pendingApprovals?: boolean
  /** Direct caller-owned model port. It stays in memory and is never persisted by Runrail. */
  readonly model?: NativeModelPort
  /** Optional caller-owned fallback used only when the primary model decision fails. */
  readonly fallbackModel?: NativeModelPort
  /** Caller-owned model port that receives canonical transient content parts. */
  readonly contentModel?: RunrailContentModelPort
  readonly contentModelDescriptor?: ModelDescriptor
  readonly modelCommand?: CommandModelOptions
  /** Optional first-party OpenAI, Anthropic, compatible, or xAI model configuration. */
  readonly provider?: ProviderModelOptions
  readonly harnessCommand?: string
  readonly harnessArgs?: readonly string[]
  readonly harnessAuth?: HarnessAuthOptions
  /** The connection's own config folder or API key for a coding tool; absent, the tool's own sign-in. */
  readonly harnessAccount?: HarnessAccountOptions
  readonly harnessPersistent?: boolean
  readonly harnessProtocol?: HarnessProtocol
  /**
   * Settings for the vendor's own CLI (Codex, Claude Code). What is left unset follows the model
   * selection and the behavior file, so one set of settings governs a thread on any route.
   */
  readonly harnessLaunch?: HarnessLaunchOptions
  /**
   * Caller-owned transient sink for reasoning text, plan updates, and subagent lineage.
   * Frames carry bounded live content for local rendering and are never persisted.
   */
  readonly onLive?: RunrailLiveSink
  readonly modelCatalog?: ModelCatalog
  readonly modelSelection?: ModelSelection
  readonly budget?: RunrailBudget
  readonly onUsage?: (usage: RunrailUsage) => void
  readonly metrics?: RunrailMetrics
  readonly cache?: ModelCache
  readonly context?: ContextResourceOptions
  readonly pluginHost?: PluginHost
  /** Explicitly activated Pi-compatible extensions for the native backend. */
  readonly piExtensions?: PiExtensionHost
  readonly ui?: UiExtensionHost
  readonly tools?: readonly NativeTool[]
  /** Native-only authority ceiling. Tools with undeclared or unadmitted capabilities are excluded. */
  readonly allowedToolCapabilities?: readonly string[]
  /** Caller-owned MCP clients; only transient bridged tools/resources enter the session. */
  readonly mcpClients?: readonly McpClient[]
  readonly mcpLoadResources?: boolean
  /** Caller-owned connector registry; credentials remain inside connector implementations. */
  readonly connectorRegistry?: ConnectorRegistry
  readonly connectorToolOptions?: Omit<ConnectorNativeToolOptions, "cwd">
  readonly integrations?: RunrailIntegrationBundle
  /**
   * The desktop's browser preview for this thread. Runrail's own loop and Codex get the browser
   * tools directly; Claude Code gets them through `mcpConfig`. Other routes go without.
   */
  readonly browser?: RunrailBrowserAccess
  /** The person's other threads, reached through the desktop; routed like `browser`. */
  readonly threads?: RunrailThreadsAccess
  /**
   * Apps on the person's Mac they allowed, reached through the desktop. Codex and
   * Claude Code only: their tool results carry the screenshots Runrail's own loop cannot read.
   */
  readonly computer?: RunrailComputerAccess
  /** Pictures from the image model the person chose, on every route. */
  readonly images?: RunrailImageAccess
  /**
   * The connectors the person turned on. The behavior file's grants pick what this thread may use:
   * Runrail's own loop gets native tools, Claude Code the `mcpConfig` server, Codex dynamic tools.
   */
  readonly connectors?: RunrailConnectorAccess
  /** The MCP servers the person signed in to; their tokens are read for each request. */
  readonly mcpSignIns?: McpSignIns
}

export interface RunrailConnectorAccess {
  readonly registry: ConnectorRegistry
  /** One `--mcp-config` document that starts `runrail connectors-mcp` for Claude Code. */
  readonly mcpConfig?: string
  /** The same server for an ACP agent, which takes each server's command and arguments. */
  readonly mcpServer?: { readonly command: string; readonly args: readonly string[] }
  /** Where the engine publishes its `/connectors` address and token; Pi's connector tools read it for each call. */
  readonly endpointFile?: string
}

export interface SessionTreeSnapshot {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly children: readonly string[]
}

export interface RunrailRuntime {
  readonly policy: WorkspacePolicy
  readonly backend: AgentBackend
  readonly adapter: RunrailBackendAdapter
  readonly registry: BackendRegistry
  readonly sessionStore?: SessionStore
  readonly transcriptStore?: TranscriptStore
  readonly extensions?: ExtensionHost
  readonly skillRegistry?: SkillRegistry
  readonly context: ContextResourceSet
  readonly mcpPrompts?: readonly import("./mcp/bridge.ts").McpPromptCatalog[]
  /** MCP servers the behavior file named, started for Runrail's own loop. */
  readonly mcp?: ConfiguredMcp
  readonly connectors?: { readonly registry: ConnectorRegistry; readonly tools: readonly GrantedConnectorTool[]; readonly approvals?: ConnectorApprovals }
  /** Commands Runrail's own agent left running; stopped with the session. */
  readonly backgroundCommands?: NativeBackgroundCommands
  /** The extension that gives Pi the connector tools; removed with the session. */
  readonly piConnectors?: PiConnectorsExtension
  /** The behavior file's MCP servers, whether or not this backend starts them. */
  readonly mcpServers?: readonly BehaviorMcpServer[]
  readonly mcpSignIns?: McpSignIns
  readonly modelCatalog?: ModelCatalog
  readonly modelRouter?: RoutedModelPort
  readonly modelDescriptor?: ModelDescriptor
  readonly setPromptParts?: (parts: readonly RunrailContentPart[]) => void
  readonly usage?: BudgetLedger
  /** Earlier turns replayed to the native model; absent for backends that keep their own. */
  readonly history?: ModelHistory
  /** Guidance joined to a running native turn; absent for backends that take none. */
  readonly steering?: SteeringModelPort
  readonly metrics?: RunrailMetrics
  readonly plugins?: PluginHostSnapshot
  readonly piExtensions?: PiExtensionHost
  readonly ui?: UiExtensionHost
  readonly verify: VerificationName
  readonly maxRepairAttempts: number
  readonly verificationTimeoutMs: number
  readonly verificationCommand: string
  /** False when the default Nifra gate is not installed, so turns skip it instead of failing. */
  readonly verificationAvailable: boolean
  readonly nifra: NifraUse
  readonly reviews: ReviewRelay
  /** Where a thread on Claude Code or Codex can start from a conversation that tool recorded itself. */
  readonly toolSessions?: ToolSessions
}

export interface ToolSessions {
  readonly tool: "claude-code" | "codex" | "opencode"
  readonly store: VendorSessionStore
}

/** A reusable local Runrail session with the same controls used by the CLI and RPC. */
/** Transcript record of a session's usage totals after a turn; the last one is picked up on restart. */
/**
 * Model steps a native turn may take before it stops. The loop runs one tool call per step, so
 * this is roughly the tool calls in one turn; real coding work runs well past a few dozen.
 */
export const DEFAULT_MAX_STEPS = 200
export const MIN_REPLY_CHARS = 256
export const MAX_REPLY_CHARS = 16 * 1024 * 1024
// Above Nifra's 64 KiB default, so a pasted file still fits in one message.
const NATIVE_MESSAGE_CHARS = 256 * 1024

/**
 * Whether the check after a turn can run: a command the caller chose always counts (and has to
 * run); the default `nifra` gate counts only when it is installed and runnable.
 */
type RecordedFrame = RunrailApprovalReviewedFrame | RunrailReviewerNoticeFrame | RunrailApiRetryFrame

/** Carries a coding tool's reviews and retries to the session, which exists only once its backend does. */
class ReviewRelay {
  private target: ((frame: RecordedFrame) => void) | undefined

  attach(target: (frame: RecordedFrame) => void): void {
    this.target = target
  }

  send(frame: RecordedFrame): void {
    this.target?.(frame)
  }
}

function relayReviews(onLive: RunrailLiveSink | undefined, reviews: ReviewRelay): RunrailLiveSink {
  return (frame) => {
    const recorded = reviewFrame(frame) ?? apiRetryFrame(frame)
    if (recorded !== undefined) reviews.send(recorded)
    onLive?.(frame)
  }
}

function durationExceeded(): RunrailBudgetError {
  return new RunrailBudgetError("BUDGET_TIME_EXCEEDED", "run duration budget exceeded")
}

const EXPIRED = Symbol("expired")

/**
 * A coding tool's turn ends at the time budget even when the tool never answers the cancel, so an
 * expired turn is let go without waiting for its stream to settle.
 */
async function* withinDeadline<T>(events: AsyncIterable<T>, endsAt: number | undefined): AsyncGenerator<T> {
  if (endsAt === undefined) return yield* events
  const iterator = events[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), Math.max(0, endsAt - performance.now()))
  })
  let settled = false
  let abandoned = false
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), expired])
      if (next === EXPIRED) {
        abandoned = true
        throw durationExceeded()
      }
      if (next.done === true) {
        settled = true
        return
      }
      yield next.value
    }
  } finally {
    clearTimeout(timer)
    if (abandoned) void Promise.resolve(iterator.return?.()).catch(() => undefined)
    else if (!settled) await iterator.return?.()
  }
}

const METRICS_RECORD = "metrics.totals"
const MAX_COMPACTION_TOKENS = 20_000_000

export type RunrailCompactionReason = "manual" | "threshold" | "overflow" | "workflow"

/** Sizes before and after: a coding tool's tokens, or Runrail's prompt window estimate on native. */
export interface RunrailCompaction {
  readonly before: number
  readonly after: number
  readonly reason: RunrailCompactionReason
  /** Records dropped from Runrail's own prompt window. */
  readonly removed?: number
  /** The coding tool's notice, for the timeline. */
  readonly event?: AgentEvent
}

type BackendCompaction = (sessionId: string, reason: RunrailCompactionReason) => Promise<{ readonly before: number; readonly after: number }>

export class RunrailSessionError extends Error {
  constructor(
    readonly code: "SESSION_BUSY" | "SESSION_COMPACT_UNSUPPORTED" | "SESSION_COMPACT_INVALID" | "SESSION_COMPACT_FAILED" | "SESSION_TOOL_SESSION_UNSUPPORTED" | "SESSION_ANSWERS_INVALID",
    reason: string,
  ) {
    super(reason)
    this.name = "RunrailSessionError"
  }
}

function compactionCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COMPACTION_TOKENS
}

/** A coding tool's own refusals and failures are worded by Runrail, so they can reach the user. */
function compactionFailure(error: unknown): unknown {
  if (!(error instanceof CommandAgentBackendError)) return error
  const reason = error.code === "COMMAND_AGENT_TIMEOUT" ? "the coding tool did not finish compacting in time" : error.message.replace(/^command agent backend: /, "")
  return new RunrailSessionError("SESSION_COMPACT_FAILED", reason)
}

function isCompactedEvent(value: object): value is AgentEvent & { readonly type: "memory.compacted" } {
  return (value as { readonly type?: unknown }).type === "memory.compacted" && typeof (value as { readonly seq?: unknown }).seq === "number"
}

export class RunrailSession {
  readonly policy: WorkspacePolicy
  readonly backend: AgentBackend
  readonly context: ContextResourceSet
  readonly modelCatalog?: ModelCatalog
  readonly mcpPrompts?: readonly import("./mcp/bridge.ts").McpPromptCatalog[]
  private readonly mcp?: ConfiguredMcp
  private readonly nifra: NifraUse
  /** What this thread may use of the connectors, once its grants were applied. */
  readonly connectorTools: readonly GrantedConnectorTool[]
  readonly connectorRegistry?: ConnectorRegistry
  /** The connector calls the person approved in Claude Code's prompt, each spent by one run. */
  readonly connectorApprovals?: ConnectorApprovals
  private readonly backgroundCommands?: NativeBackgroundCommands
  private readonly piConnectors?: PiConnectorsExtension
  private readonly mcpServers: readonly BehaviorMcpServer[]
  private readonly mcpSignIns: McpSignIns | undefined
  readonly usage?: BudgetLedger
  readonly metrics?: RunrailMetrics
  readonly plugins?: PluginHostSnapshot
  readonly piExtensions?: PiExtensionHost
  readonly ui?: UiExtensionHost
  readonly skillRegistry?: SkillRegistry
  private readonly host: CodingAgentHost
  private readonly sessionStore?: SessionStore
  readonly transcriptStore?: TranscriptStore
  /** The work tree before each turn, when the session keeps checkpoints. */
  readonly checkpoints?: TurnCheckpoints
  private readonly modelRouter?: RoutedModelPort
  private readonly setPromptParts?: (parts: readonly RunrailContentPart[]) => void
  private readonly modelHistory?: ModelHistory
  private readonly steering?: SteeringModelPort
  private turnRunning = false
  /** Steers the model has read that the transcript has not recorded yet. */
  private readonly steerRecords: { readonly text: string; readonly toolResults: number }[] = []
  /** Tool calls completed in this session, which is also the loop's count of tool results. */
  private toolResults = 0
  /** Tool calls of the running turn that have started and not finished. */
  private openTools = 0
  /** Whether the usage totals are this session's alone, so the transcript keeps them across restarts. */
  private metricsKept = false
  /** A recap of history a coding-tool route has never seen, put before its next prompt once. */
  private carryover: string | undefined
  private readonly toolSessions?: ToolSessions
  private readonly releasePiRuntime?: () => void
  private piShutdownEmitted = false
  private usageRecorded = false
  private readonly children = new Set<string>()
  private latest: AgentSessionSnapshot
  /** When a coding tool's time budget runs out, on the `performance.now()` clock; native counts its own. */
  private readonly endsAt?: number
  private lastEventSeq = 0

  constructor(
    policy: WorkspacePolicy,
    backend: AgentBackend,
    host: CodingAgentHost,
    snapshot: AgentSessionSnapshot,
    controls: {
      readonly context: ContextResourceSet
    readonly sessionStore?: SessionStore
    readonly transcriptStore?: TranscriptStore
      readonly mcpPrompts?: readonly import("./mcp/bridge.ts").McpPromptCatalog[]
      readonly mcp?: ConfiguredMcp
      readonly nifra?: NifraUse
      readonly connectors?: { readonly registry: ConnectorRegistry; readonly tools: readonly GrantedConnectorTool[]; readonly approvals?: ConnectorApprovals }
      readonly backgroundCommands?: NativeBackgroundCommands
      readonly piConnectors?: PiConnectorsExtension
      readonly mcpServers?: readonly BehaviorMcpServer[]
      readonly mcpSignIns?: McpSignIns
      readonly modelCatalog?: ModelCatalog
      readonly modelRouter?: RoutedModelPort
      readonly setPromptParts?: (parts: readonly RunrailContentPart[]) => void
      readonly usage?: BudgetLedger
      readonly history?: ModelHistory
      readonly steering?: SteeringModelPort
      readonly metrics?: RunrailMetrics
      readonly plugins?: PluginHostSnapshot
      readonly piExtensions?: PiExtensionHost
      readonly ui?: UiExtensionHost
      readonly skillRegistry?: SkillRegistry
      readonly endsAt?: number
      readonly reviews?: ReviewRelay
      readonly toolSessions?: ToolSessions
      readonly checkpoints?: TurnCheckpoints
    },
  ) {
    this.policy = policy
    this.backend = backend
    this.host = host
    this.latest = snapshot
    this.sessionStore = controls.sessionStore
    this.transcriptStore = controls.transcriptStore
    this.context = controls.context
    this.mcpPrompts = controls.mcpPrompts
    this.mcp = controls.mcp
    this.nifra = controls.nifra ?? NO_NIFRA
    this.connectorTools = controls.connectors?.tools ?? []
    this.connectorRegistry = controls.connectors?.registry
    this.connectorApprovals = controls.connectors?.approvals
    this.backgroundCommands = controls.backgroundCommands
    this.piConnectors = controls.piConnectors
    this.mcpServers = controls.mcpServers ?? []
    this.mcpSignIns = controls.mcpSignIns
    this.modelCatalog = controls.modelCatalog
    this.modelRouter = controls.modelRouter
    this.setPromptParts = controls.setPromptParts
    this.modelHistory = controls.history
    this.steering = controls.steering
    if (this.steering !== undefined) {
      // The loop's events reach the transcript after the model call that read the steer, so the
      // record waits for its place: after the tool result it followed.
      this.steering.onDelivered = (_sessionId, text, toolResults) => {
        this.steerRecords.push({ text, toolResults })
      }
    }
    this.usage = controls.usage
    this.metrics = controls.metrics
    this.plugins = controls.plugins
    this.piExtensions = controls.piExtensions
    this.releasePiRuntime = this.piExtensions?.setRuntime({
      sessionId: () => this.snapshot.id,
      isIdle: () => this.snapshot.status !== "running",
      hasPendingMessages: () => false,
    abort: () => { void this.stop("extension abort") },
    reload: async () => { await this.reload() },
    })
    this.ui = controls.ui
    this.skillRegistry = controls.skillRegistry
    this.endsAt = controls.endsAt
    this.toolSessions = controls.toolSessions
    this.checkpoints = controls.checkpoints
    controls.reviews?.attach((frame) => this.recordReview(frame))
  }

  /** A coding tool's review or retry goes in the transcript after the last event this session passed on. */
  private recordReview(frame: RecordedFrame): void {
    void this.transcriptStore?.append(this.snapshot.id, { kind: frame.type, payload: { ...frame, afterSeq: this.lastEventSeq } }).catch(() => undefined)
  }

  get snapshot(): AgentSessionSnapshot {
    return this.host.snapshot ?? this.latest
  }

  get model(): ModelDescriptor | undefined {
    return this.modelRouter?.current.descriptor
  }

  async *prompt(message: string | RunrailPromptInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.endsAt !== undefined && performance.now() >= this.endsAt) throw durationExceeded()
    const inputText = typeof message === "string" ? message : message.text
    const inputResult = this.piExtensions === undefined
      ? undefined
      : await this.piExtensions.emit("input", { text: inputText, source: "interactive" })
    const effectiveMessage = typeof message === "string"
      ? (inputResult?.text ?? message)
      : (inputResult?.text === undefined ? message : { ...message, text: inputResult.text })
    const prepared = await this.context.prepare(effectiveMessage)
    const requiresMultimodal = prepared.parts.some((part) => part.kind === "image" || part.kind === "binary")
    if (requiresMultimodal && this.model !== undefined && !this.model.capabilities.includes("multimodal"))
      throw new ModelCatalogError("MODEL_CAPABILITY_UNAVAILABLE", "selected model does not support image or binary input")
    this.setPromptParts?.(prepared.parts)
    const transcriptSessionId = this.snapshot.id
    const checkpoint = await this.checkpoints?.capture().catch(() => undefined)
    if (this.transcriptStore !== undefined) {
      const record = await this.transcriptStore.append(transcriptSessionId, { kind: "message.user", payload: message })
      if (checkpoint !== undefined) await this.checkpoints?.note(checkpoint.n, { userSeq: record.seq, userId: record.id }).catch(() => undefined)
    }
    // The checkpoint learns its turn's id from the turn's first event that names one (not every tool reports a turn start); a rewind names the turn by it.
    let unlabelled = checkpoint
    const turnId = `runrail-turn-${Date.now().toString(36)}`
    await this.piExtensions?.emit("before_agent_start", { sessionId: transcriptSessionId, text: prepared.text })
    await this.piExtensions?.emit("turn_start", { sessionId: transcriptSessionId, turnId })
    await this.piExtensions?.emit("agent_start", { sessionId: transcriptSessionId, turnId })
    let ok = false
    this.turnRunning = true
    this.openTools = 0
    // A coding tool's turn passes no model port: its tool calls and working time are counted here.
    const activity = this.metrics !== undefined && this.usage === undefined ? { tools: 0, startedAt: performance.now() } : undefined
    // A run of streamed text is one transcript record, not one per token.
    let pending: { readonly event: StreamedTextEvent; text: string } | undefined
    const flush = async (): Promise<void> => {
      const run = pending
      pending = undefined
      if (run !== undefined) await this.transcriptStore?.append(transcriptSessionId, { kind: run.event.type, payload: { ...run.event, text: run.text } })
    }
    // A turn this side stops reading (a transcript that is full, a caller that breaks off) is stopped
    // in the host too; otherwise it keeps calling the model with no one listening.
    const turn = new AbortController()
    const forward = (): void => turn.abort(signal?.reason)
    if (signal?.aborted === true) forward()
    else signal?.addEventListener("abort", forward, { once: true })
    let finished = false
    try {
      const carryover = this.carryover
      this.carryover = undefined
      for await (const event of withinDeadline(this.host.prompt(carryover === undefined ? prepared.text : `${carryover}${prepared.text}`, turn.signal), this.endsAt)) {
        const streamed = this.transcriptStore === undefined ? undefined : streamedText(event)
        if (streamed !== undefined && pending !== undefined && sameStream(pending.event, streamed) && pending.text.length < MAX_STREAMED_RECORD_CHARS && !this.steerDue()) {
          pending.text += streamed.text
        } else {
          await flush()
          await this.recordSteers(transcriptSessionId, false)
          if (streamed !== undefined) pending = { event: streamed, text: streamed.text }
          else await this.transcriptStore?.append(transcriptSessionId, { kind: event.type, payload: event })
        }
        const named = (event as { readonly turnId?: unknown }).turnId
        if (unlabelled !== undefined && typeof named === "string") {
          await this.checkpoints?.note(unlabelled.n, { turnId: named }).catch(() => undefined)
          unlabelled = undefined
        }
        if (event.type === "tool.started") this.openTools += 1
        if (event.type === "tool.completed") {
          this.toolResults += 1
          this.openTools = Math.max(0, this.openTools - 1)
          if (activity !== undefined) activity.tools += 1
        }
        if (event.type === "session.started" || event.type === "session.updated" || event.type === "session.completed")
          this.latest = event.snapshot
        this.lastEventSeq = event.seq
        yield event
      }
      await flush()
      ok = this.snapshot.status !== "failed"
      finished = true
      // Where the tool's own conversation now stands, so a rewind to after this turn can cut it there.
      const vendor = ok && checkpoint !== undefined ? vendorMarkOf(this.backend, this.snapshot.id) : undefined
      if (vendor !== undefined && checkpoint !== undefined) await this.checkpoints?.note(checkpoint.n, { vendor }).catch(() => undefined)
    } finally {
      signal?.removeEventListener("abort", forward)
      if (!finished) turn.abort("turn stopped")
      await flush().catch(() => undefined)
      this.turnRunning = false
      if (activity !== undefined) this.metrics?.recordActivity(activity.tools, Math.max(0, performance.now() - activity.startedAt))
      // A place never reached (a compacted conversation) still gets the record, at the end of the turn.
      await this.recordSteers(transcriptSessionId, true).catch(() => undefined)
      await this.piExtensions?.emit("agent_end", { sessionId: transcriptSessionId, turnId, ok })
      await this.piExtensions?.emit("turn_end", { sessionId: transcriptSessionId, turnId, ok })
      this.setPromptParts?.([])
    }
  }

  /**
   * Adds guidance to the running turn: the model reads it at its next step. False when no turn is
   * running, the backend takes none at this point (most coding tools), or the text is not accepted.
   */
  steer(text: string): boolean {
    if (!this.turnRunning) return false
    if (this.steering !== undefined) return this.steering.push(text)
    const steer = (this.backend as { readonly steer?: unknown }).steer
    if (typeof steer !== "function" || steer.call(this.backend, this.snapshot.id, text) !== true) return false
    // A coding tool reads it after the running tool's result, so the record follows that result.
    this.steerRecords.push({ text, toolResults: this.toolResults + 1 })
    return true
  }

  /**
   * As `steer`, and also through a backend that asks its tool first (Codex's `turn/steer`). The
   * record goes after the running tool's result, or before the turn's next event when none runs.
   */
  async steerLive(text: string): Promise<boolean> {
    if (this.steer(text)) return true
    if (!this.turnRunning) return false
    const steer = (this.backend as { readonly steerAsync?: unknown }).steerAsync
    if (typeof steer !== "function") return false
    const toolResults = this.toolResults + (this.openTools > 0 ? 1 : 0)
    if ((await (steer as (sessionId: string, text: string) => Promise<unknown>).call(this.backend, this.snapshot.id, text)) !== true) return false
    if (this.turnRunning) this.steerRecords.push({ text, toolResults })
    else await this.transcriptStore?.append(this.snapshot.id, { kind: "message.user", payload: { text, steer: true } })
    return true
  }

  /** Whether a message can join the running turn: Runrail's own loop, or a backend that takes guidance mid-turn. */
  get canSteerLive(): boolean {
    if (this.steering !== undefined) return true
    const backend = this.backend as { readonly steer?: unknown; readonly steerAsync?: unknown }
    return typeof backend.steer === "function" || typeof backend.steerAsync === "function"
  }

  private steerDue(): boolean {
    const next = this.steerRecords[0]
    return next !== undefined && next.toolResults <= this.toolResults
  }

  private async recordSteers(sessionId: string, all: boolean): Promise<void> {
    while (this.steerRecords.length > 0 && (all || this.steerRecords[0]!.toolResults <= this.toolResults)) {
      const { text } = this.steerRecords.shift()!
      await this.transcriptStore?.append(sessionId, { kind: "message.user", payload: { text, steer: true } })
    }
  }

  /** Guidance that came after the model's last step; the caller runs it as the next turn. */
  takeUndeliveredSteers(): readonly string[] {
    return this.steering?.takeUndelivered() ?? Object.freeze([])
  }

  listModels(): readonly ModelDescriptor[] {
    return this.modelCatalog?.list() ?? Object.freeze([])
  }

  /** The behavior file's MCP servers and how each one started. Empty when it names none. */
  mcpStatus(): readonly McpServerStatus[] {
    return this.mcp?.status ?? []
  }

  /** What Nifra brings to this session, so a client can say so and offer to turn it off. */
  nifraUse(): NifraUse {
    return this.nifra
  }

  /**
   * Starts one of the behavior file's servers on its own, lists its tools, and stops it, so a
   * server can be checked before any thread uses it. Undefined when the file does not name it.
   */
  async checkMcpServer(name: string): Promise<McpServerStatus | undefined> {
    const server = this.mcpServers.find((candidate) => candidate.name === name)
    if (server === undefined) return undefined
    const checked = await connectConfiguredMcp([{ ...server, enabled: true }], this.policy.root, undefined, undefined, process.env, this.mcpSignIns)
    await checked.close()
    return checked.status[0]
  }

  listMcpPrompts(): readonly import("./mcp/protocol.ts").McpPromptDescriptor[] {
    return Object.freeze(this.mcpPrompts?.flatMap((catalog) => catalog.list()) ?? [])
  }

  getMcpPrompt(name: string, args: Readonly<Record<string, string>> = {}) {
    const catalog = this.mcpPrompts?.find((candidate) => candidate.list().some((prompt) => prompt.name === name))
    if (catalog === undefined) throw new Error("MCP_PROMPT_NOT_FOUND")
    return catalog.get(name, args)
  }
  async switchModel(selection: ModelSelection): Promise<ModelDescriptor> {
    if (this.modelRouter === undefined)
      throw new Error("runrail model: model switching is unavailable for this session")
    if (this.snapshot.status === "running")
      throw new Error("runrail model: switch is unavailable while a turn is running")
    const descriptor = await this.modelRouter.switch(selection)
    this.usage?.setModel(descriptor)
    return descriptor
  }

  async reload(): Promise<ReloadResult> {
    await this.piExtensions?.reload()
    const result = await this.host.reload()
    if (!result.rolledBack) {
      await this.context.reload()
      await this.piExtensions?.emit("reload", { sessionId: this.snapshot.id })
    }
    return result
  }

  checkpoint(): Promise<void> {
    return this.host.checkpoint()
  }

  /** Whether `compact` reaches the conversation the model reads: a coding tool's own, or Runrail's. */
  get canCompact(): boolean {
    return this.backendCompaction() !== undefined || this.hostCompacted()
  }

  /**
   * A coding tool compacts its own conversation, which leaves a notice for the timeline. Runrail's
   * prompt window is compacted only where it is what the model reads: Runrail's own loop.
   */
  async compact(reason: RunrailCompactionReason = "manual"): Promise<RunrailCompaction> {
    const compact = this.backendCompaction()
    if (compact === undefined && !this.hostCompacted())
      throw new RunrailSessionError("SESSION_COMPACT_UNSUPPORTED", `${this.snapshot.backend} cannot compact its conversation`)
    if (this.turnRunning) throw new RunrailSessionError("SESSION_BUSY", "cannot compact while a turn is running")
    let result: RunrailCompaction
    if (compact === undefined) {
      result = await this.host.compact(reason)
    } else {
      const counts = await compact(this.snapshot.id, reason).catch((error: unknown) => {
        throw compactionFailure(error)
      })
      if (!compactionCount(counts.before) || !compactionCount(counts.after))
        throw new RunrailSessionError("SESSION_COMPACT_INVALID", "the backend returned invalid compaction counts")
      const event = isCompactedEvent(counts) ? counts : undefined
      if (event !== undefined) await this.transcriptStore?.append(this.snapshot.id, { kind: event.type, payload: event })
      result = { before: counts.before, after: counts.after, reason, ...(event === undefined ? {} : { event }) }
    }
    await this.piExtensions?.emit("session_compact", { sessionId: this.snapshot.id, reason })
    return result
  }

  /** Runrail's own loop reads its prompt window, so compacting that window is real there. */
  private hostCompacted(): boolean {
    return this.backend instanceof RunrailBackend || this.backend instanceof ReplayBackend
  }

  private backendCompaction(): BackendCompaction | undefined {
    const compact = (this.backend as { readonly compact?: unknown }).compact
    if (typeof compact !== "function" || !this.backend.info.capabilities.includes("compact")) return undefined
    return (sessionId, reason) => compact.call(this.backend, sessionId, reason) as Promise<{ readonly before: number; readonly after: number }>
  }

  /** What the backend says now about its context and the plan; empty when it has nothing to say. */
  async readUsage(): Promise<RunrailUsageReading> {
    const read = (this.backend as { readonly readUsage?: unknown }).readUsage
    if (typeof read !== "function") return Object.freeze({})
    return await read.call(this.backend, this.snapshot.id) as RunrailUsageReading
  }

  async fork(targetSessionId?: string): Promise<ForkSessionResult> {
    const result = await this.host.fork(targetSessionId)
    this.children.add(result.sessionId)
    return result
  }

  branch(targetSessionId?: string): Promise<ForkSessionResult> {
    return this.fork(targetSessionId)
  }

  clone(targetSessionId?: string): Promise<ForkSessionResult> {
    return this.fork(targetSessionId)
  }

  tree(): SessionTreeSnapshot {
    return Object.freeze({
      sessionId: this.snapshot.id,
      children: Object.freeze([...this.children].sort()),
    })
  }

  exportEvidence(maxEntries?: number): Promise<string> {
    if (this.sessionStore === undefined) throw new Error("runrail session: evidence storage is disabled")
    return exportSessionEvidence(this.sessionStore, this.snapshot.id, maxEntries)
  }

  importEvidence(source: string | SessionEvidenceBundle, targetSessionId?: string) {
    if (this.sessionStore === undefined) throw new Error("runrail session: evidence storage is disabled")
    return importSessionEvidence(this.sessionStore, source, targetSessionId)
  }
  exportTranscript(options?: TranscriptReadOptions): Promise<string> {
    if (this.transcriptStore === undefined) throw new Error("runrail session: transcript storage is disabled")
    return this.transcriptStore.export(this.snapshot.id, options)
  }
  importTranscript(source: string | TranscriptBundle, targetSessionId?: string) {
    if (this.transcriptStore === undefined) throw new Error("runrail session: transcript storage is disabled")
    return this.transcriptStore.import(source, targetSessionId)
  }
  compactTranscript(options: TranscriptCompactionOptions) {
    if (this.transcriptStore === undefined) throw new Error("runrail session: transcript storage is disabled")
    return this.transcriptStore.compact(this.snapshot.id, options)
  }
  recoverTranscript(): Promise<TranscriptRecoveryResult> {
    if (this.transcriptStore === undefined) throw new Error("runrail session: transcript storage is disabled")
    if (typeof this.transcriptStore.recover !== "function") throw new Error("runrail session: transcript recovery is unavailable")
    return this.transcriptStore.recover(this.snapshot.id)
  }
  /**
   * The checkpoint before the turn a caller names: by the seq of its message in the transcript as
   * read now, which names any turn, or by its turn id, which names only a turn this session ran.
   */
  async checkpointFor(target: { readonly turnId: string } | { readonly userSeq: number }): Promise<TurnCheckpoint> {
    if (this.checkpoints === undefined) throw new GitError("GIT_NOT_FOUND", "this session keeps no checkpoints")
    if ("turnId" in target) return this.checkpoints.find({ turnId: target.turnId })
    const record = (await this.transcriptStore?.read(this.snapshot.id, { afterSeq: target.userSeq - 1, maxRecords: 1 }))?.[0]
    if (record?.seq !== target.userSeq || record.kind !== "message.user") throw new GitError("GIT_NOT_FOUND", "that message has no checkpoint")
    return this.checkpoints.find({ userId: record.id })
  }

  /** Copies this session's transcript to another session, marked as continued there. */
  async branchTranscript(targetSessionId?: string): Promise<string> {
    if (this.transcriptStore === undefined) throw new Error("runrail session: transcript storage is disabled")
    const target = await this.transcriptStore.branch(this.snapshot.id, targetSessionId)
    await this.transcriptStore.append(target, { kind: SESSION_CONTINUED, payload: { type: SESSION_CONTINUED } })
    return target
  }
  replayTranscript(visitor: (record: TranscriptRecord) => void | PromiseLike<void>, options?: TranscriptReadOptions) {
    if (this.transcriptStore === undefined) throw new Error("runrail session: transcript storage is disabled")
    return this.transcriptStore.replay(this.snapshot.id, visitor, options)
  }

  /**
   * Reloads the turns the native model has not seen from this session's transcript: everything
   * recorded before this process started, or an import. Call it only before the first new turn,
   * since the model already holds turns it ran. Returns the number of restored messages.
   */
  async restoreHistory(): Promise<number> {
    if (this.modelHistory === undefined || this.transcriptStore === undefined) return 0
    try {
      const messages = historyFromTranscript(await this.transcriptStore.read(this.snapshot.id))
      this.modelHistory.set(this.snapshot.id, messages)
      this.historyUnavailable = false
      return messages.length
    } catch (error) {
      this.historyUnavailable = true
      throw error
    }
  }

  /** The last restore could not read the transcript, so the model goes on without the earlier messages. */
  historyUnavailable = false

  /**
   * Picks up the usage totals this session's transcript last recorded and lets `saveMetrics` record
   * them from now on, so stats outlive an engine restart. Only for totals this session owns alone.
   * A copy of another session's transcript (a branch) carries that session's id and is not taken.
   */
  async keepMetrics(): Promise<boolean> {
    if (this.metrics === undefined || this.transcriptStore === undefined) return false
    this.metricsKept = true
    const sessionId = this.snapshot.id
    let last: unknown
    await this.transcriptStore.replay(sessionId, (record) => {
      if (record.kind === METRICS_RECORD && isRecord(record.payload) && record.payload.sessionId === sessionId) last = record.payload
    })
    return last !== undefined && this.metrics.restore(last)
  }

  /** Whether this thread runs on `tool` and can start from a conversation that tool recorded itself. */
  continuesToolSessions(tool: string): boolean {
    return this.toolSessions?.tool === tool
  }

  /**
   * Starts this thread from a conversation its coding tool recorded outside Runrail. The first turn
   * continues a copy, so the tool's own history is never written. `undefined` forgets it.
   */
  async seedToolSession(tool: string, vendorSessionId: string | undefined): Promise<void> {
    if (this.toolSessions === undefined || this.toolSessions.tool !== tool) throw new RunrailSessionError("SESSION_TOOL_SESSION_UNSUPPORTED", "this thread cannot continue that tool's session")
    await this.toolSessions.store.save(this.snapshot.id, vendorSessionId, { fork: true })
  }

  /**
   * For a coding-tool route: finds history in this session's transcript the tool has never seen (a
   * thread continued from another, or an import) and puts a recap of it before the next prompt. A
   * native session needs none: `restoreHistory` gives its model the messages themselves.
   */
  async prepareCarryover(): Promise<boolean> {
    if (this.modelHistory !== undefined || this.transcriptStore === undefined) return false
    this.carryover = carryoverText(await this.transcriptStore.read(this.snapshot.id))
    return this.carryover !== undefined
  }

  /**
   * Records the usage totals in the transcript, once the turn's run is counted. Best-effort: stats
   * that fail to save only start lower after a restart.
   */
  async saveMetrics(): Promise<void> {
    if (!this.metricsKept || this.metrics === undefined || this.transcriptStore === undefined) return
    const sessionId = this.snapshot.id
    await this.transcriptStore.append(sessionId, { kind: METRICS_RECORD, payload: { sessionId, ...this.metrics.snapshot() } }).catch(() => undefined)
  }

  history(limit?: number) {
    return this.host.history(limit)
  }

  get pendingApprovals() {
    return this.host.pendingApprovals
  }

  /**
   * `session` also covers the rest of the session, on a backend that can remember an answer. The
   * host takes only yes or no, so such a backend is told before the answer goes through it, and so
   * are the answers to a question, or the person's request for more questions.
   */
  resolveApproval(approvalId: string, approved: boolean, reason?: string, scope?: ApprovalScope, answers?: ApprovalAnswers, followUp?: FollowUp) {
    if (approved && scope === "session") rememberApprovalForSession(this.backend, this.snapshot.id, approvalId)
    if (approved && (answers !== undefined || followUp !== undefined)) answerApprovalQuestions(this.backend, this.snapshot.id, approvalId, answers ?? NO_ANSWERS, followUp)
    // The host settles an approval before the backend sees it, so a question it would refuse is refused first, still answerable.
    if (approved && approvalNeedsAnswers(this.backend, this.snapshot.id, approvalId)) throw new RunrailSessionError("SESSION_ANSWERS_INVALID", QUESTION_NEEDS_ANSWERS)
    return this.host.resolveApproval(approvalId, approved, reason)
  }

  async stop(reason = "stopped"): Promise<void> {
    if (!this.usageRecorded && this.metrics !== undefined && this.usage !== undefined) {
      this.metrics.recordUsage(this.usage.snapshot(), this.usage)
      this.usageRecorded = true
    }
    if (!this.piShutdownEmitted) {
      this.piShutdownEmitted = true
      await this.piExtensions?.emit("session_shutdown", { sessionId: this.snapshot.id, reason })
      this.releasePiRuntime?.()
    }
    await this.host.stop(reason)
    await this.mcp?.close()
    await this.backgroundCommands?.close()
    await this.piConnectors?.remove()
  }

  close(reason = "closed"): Promise<void> {
    return this.stop(reason)
  }
}

export async function createRunrailSession(options: RunrailSessionOptions): Promise<RunrailSession> {
  const startedAt = performance.now()
  const runtime = await timed("runtime", () => createRunrailRuntime(options))
  const host = createHost(runtime, options)
  let snapshot: Awaited<ReturnType<typeof host.start>>
  try {
    snapshot = await timed("backend-start", () => host.start({
      cwd: runtime.policy.root,
      backend: runtime.adapter.name,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }))
  } catch (error) {
    await closeRuntimeResources(runtime)
    throw error
  }
  try {
    await timed("transcript-recover", async () => await options.transcriptStore?.recover?.(snapshot.id))
  } catch (error) {
    await host.stop("transcript recovery failed").catch(() => undefined)
    await closeRuntimeResources(runtime)
    throw error
  }
  const session = new RunrailSession(runtime.policy, runtime.backend, host, snapshot, {
    ...(runtime.sessionStore === undefined ? {} : { sessionStore: runtime.sessionStore }),
    ...(runtime.skillRegistry === undefined ? {} : { skillRegistry: runtime.skillRegistry }),
    ...(options.transcriptStore === undefined ? {} : { transcriptStore: options.transcriptStore }),
    context: runtime.context,
    ...(runtime.modelCatalog === undefined ? {} : { modelCatalog: runtime.modelCatalog }),
    ...(runtime.modelRouter === undefined ? {} : { modelRouter: runtime.modelRouter }),
    ...(runtime.setPromptParts === undefined ? {} : { setPromptParts: runtime.setPromptParts }),
    ...(runtime.usage === undefined ? {} : { usage: runtime.usage }),
    ...(runtime.history === undefined ? {} : { history: runtime.history }),
    ...(runtime.steering === undefined ? {} : { steering: runtime.steering }),
    ...(runtime.metrics === undefined ? {} : { metrics: runtime.metrics }),
    ...(runtime.plugins === undefined ? {} : { plugins: runtime.plugins }),
    ...(runtime.ui === undefined ? {} : { ui: runtime.ui }),
    ...(runtime.mcpPrompts === undefined ? {} : { mcpPrompts: runtime.mcpPrompts }),
    ...(runtime.mcp === undefined ? {} : { mcp: runtime.mcp }),
    ...(runtime.connectors === undefined ? {} : { connectors: runtime.connectors }),
    ...(runtime.backgroundCommands === undefined ? {} : { backgroundCommands: runtime.backgroundCommands }),
    ...(runtime.piConnectors === undefined ? {} : { piConnectors: runtime.piConnectors }),
    ...(runtime.mcpServers === undefined ? {} : { mcpServers: runtime.mcpServers }),
    ...(runtime.mcpSignIns === undefined ? {} : { mcpSignIns: runtime.mcpSignIns }),
    nifra: runtime.nifra,
    ...(runtime.piExtensions === undefined ? {} : { piExtensions: runtime.piExtensions }),
    ...(runtime.usage === undefined && options.budget?.maxDurationMs !== undefined ? { endsAt: startedAt + options.budget.maxDurationMs } : {}),
    reviews: runtime.reviews,
    ...(runtime.toolSessions === undefined ? {} : { toolSessions: runtime.toolSessions }),
    ...(options.checkpoints === true && options.sessionDir !== undefined ? { checkpoints: new TurnCheckpoints({ root: runtime.policy.root, dir: join(options.sessionDir, "checkpoints") }) } : {}),
  })
  // History is context for the model, not state: a transcript it cannot read starts without it, and
  // `historyUnavailable` says so to the client instead of the thread silently forgetting.
  await timed("restore-history", () => session.restoreHistory().catch(() => 0))
  // Totals a caller passed in are the caller's to keep.
  if (options.metrics === undefined) await timed("metrics", () => session.keepMetrics().catch(() => false))
  await timed("carryover", () => session.prepareCarryover().catch(() => false))
  await runtime.piExtensions?.emit("session_start", { sessionId: snapshot.id })
  return session
}

export async function createRunrailRuntime(options: RunrailSessionOptions): Promise<RunrailRuntime> {
  // What the runtime starts is the caller's to close only once it is returned; a failure before that closes it here.
  const owned: (() => Promise<unknown>)[] = []
  try {
    return await buildRunrailRuntime(options, owned)
  } catch (error) {
    for (const release of owned.reverse()) await release().catch(() => undefined)
    throw error
  }
}

/** Closes what a runtime started that no session has taken over yet. */
async function closeRuntimeResources(runtime: RunrailRuntime): Promise<void> {
  await runtime.mcp?.close().catch(() => undefined)
  await runtime.backgroundCommands?.close().catch(() => undefined)
  await runtime.piConnectors?.remove().catch(() => undefined)
}

async function buildRunrailRuntime(options: RunrailSessionOptions, owned: (() => Promise<unknown>)[]): Promise<RunrailRuntime> {
  if (options.provider !== undefined && options.backend !== "native") throw new Error("PROVIDER_REQUIRES_NATIVE_BACKEND")
  if (options.allowedToolCapabilities !== undefined) {
    if (options.backend !== "native" || options.adapter !== undefined || options.registry !== undefined || options.loadExtensions === true) throw new Error("TOOL_CAPABILITIES_UNSUPPORTED_BACKEND")
    if (!Array.isArray(options.allowedToolCapabilities) || options.allowedToolCapabilities.length > 64 || options.allowedToolCapabilities.some((capability) => typeof capability !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(capability))) throw new Error("TOOL_CAPABILITIES_INVALID")
  }
  // Only Runrail's own model loop counts tokens, cost, and tool calls before it spends them.
  const uncounted = options.backend === "native" || options.budget === undefined ? [] : Object.keys(options.budget).filter((key) => key !== "maxDurationMs")
  if (uncounted.length > 0) throw new RunrailBudgetError("BUDGET_INVALID", `${uncounted.join(", ")} need the native backend; a coding tool takes only maxDurationMs`)
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const maxRepairAttempts = options.maxRepairAttempts ?? 2
  assertBound(maxSteps, 1, 512, "maxSteps")
  assertBound(maxRepairAttempts, 0, 8, "maxRepairAttempts")
  if (options.maxReplyChars !== undefined) {
    if (options.backend !== "native") throw new Error("MAX_REPLY_CHARS_REQUIRES_NATIVE_BACKEND")
    assertBound(options.maxReplyChars, MIN_REPLY_CHARS, MAX_REPLY_CHARS, "maxReplyChars")
  }
  const verify = options.verify ?? "check"
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 120_000
  assertBound(verificationTimeoutMs, 1, 120_000, "verificationTimeoutMs")
  const policy = await createWorkspacePolicy(options.cwd, options.folders ?? [])
  if (policy.folders.length > 0 && options.backend !== "native" && options.backend !== "claude-code" && options.backend !== "codex") throw new Error("FOLDERS_UNSUPPORTED_BACKEND")
  const behavior = await loadBehaviorForSession(
    resolveBehaviorConfigPath(options.behaviorConfigPath, options.sessionBehaviorFile === false ? undefined : options.sessionDir),
    {
      cwd: policy.root,
      allowMissing: options.behaviorConfigPath === undefined,
      onWarning: (message) => console.error(`[runrail] ${message}`),
    },
  )
  const behaviorApproval = behavior === undefined ? undefined : createBehaviorApprovalPort(behavior, { pending: options.pendingApprovals === true })
  const integrationOption = options.integrations
  const pluginHost = options.pluginHost ?? integrationOption?.pluginHost
  const piExtensions = options.piExtensions ?? integrationOption?.piExtensions
  if (piExtensions !== undefined && options.backend !== "native") throw new Error("PI_EXTENSIONS_REQUIRE_NATIVE_BACKEND")
  const plugins = mergePluginSnapshots(pluginHost?.snapshot(), piExtensions?.snapshot())
  const activePluginHost = plugins !== undefined && plugins.plugins.length > 0 ? pluginHost : undefined
  const mcpClients = options.mcpClients ?? integrationOption?.mcpClients ?? []
  const mcpLoadResources = options.mcpLoadResources ?? integrationOption?.mcpLoadResources ?? false
  if (!Array.isArray(mcpClients) || mcpClients.length > 32 || mcpClients.some((client) => client === null || typeof client !== "object" || typeof client.listTools !== "function" || typeof client.callTool !== "function" || (mcpLoadResources && (typeof client.listResources !== "function" || typeof client.readResource !== "function")))) throw new Error("MCP_CLIENTS_INVALID")
  if (typeof mcpLoadResources !== "boolean") throw new Error("MCP_CLIENTS_INVALID")
  const connectorRegistry = options.connectorRegistry ?? integrationOption?.connectorRegistry
  const connectorToolOptions = options.connectorToolOptions ?? integrationOption?.connectorToolOptions
  const baseContext = options.context ?? integrationOption?.context
  const callerSkills = baseContext?.skillRegistry ?? integrationOption?.skillRegistry
  const userHome = userSkillHome(options.userSkills, behavior)
  // Named skill paths and plugin skills join the session's own registry, so they are listed,
  // switched off, and loaded on demand like any other skill. A caller's registry is its own.
  const namedSkillPaths = callerSkills === undefined ? baseContext?.skillPaths ?? [] : []
  const pluginSkills = callerSkills === undefined ? plugins?.skills ?? [] : []
  const defaultSkills = (): Promise<SkillRegistry> => createDefaultSkillRegistry(policy, {
    ...(options.disabledSkills === undefined ? {} : { exclude: options.disabledSkills }),
    ...(userHome === undefined ? {} : { userHome }),
    ...(namedSkillPaths.length === 0 ? {} : { additionalSources: namedSkillPaths.map((path) => ({ path, scope: "explicit" as const, strict: true })) }),
    ...(pluginSkills.length === 0 ? {} : { supplied: pluginSkills }),
  })
  const skillRegistry = callerSkills ?? (options.backend === "native" ? await timed("skills", defaultSkills) : undefined)
  // Only the native loop is handed skills. Another backend reads them itself, and the session still lists what the workspace offers.
  const listedSkillRegistry = skillRegistry ?? (await timed("skills", defaultSkills))
  const bundledTools = integrationOption?.tools ?? []
  const callerTools = options.tools ?? []
  if (!Array.isArray(bundledTools) || !Array.isArray(callerTools)) throw new Error("NATIVE_TOOL_INVALID")
  const integrationTools = Object.freeze([...bundledTools, ...callerTools])
  const integrationBundle: RunrailIntegrationBundle = Object.freeze({
    ...(mcpClients.length === 0 ? {} : { mcpClients: Object.freeze([...mcpClients]) }),
    mcpLoadResources,
    ...(connectorRegistry === undefined ? {} : { connectorRegistry, ...(connectorToolOptions === undefined ? {} : { connectorToolOptions }) }),
    ...(activePluginHost === undefined ? {} : { pluginHost: activePluginHost }),
    ...(piExtensions === undefined ? {} : { piExtensions }),
    ...(skillRegistry === undefined ? {} : { skillRegistry }),
    ...(integrationTools.length === 0 ? {} : { tools: integrationTools }),
    ...(integrationOption?.context === undefined ? {} : { context: integrationOption.context }),
  })
  const requiredCapabilities = Object.freeze([...(options.requiredCapabilities ?? [])].sort())
  const admissionRegistry = options.registry ?? createDefaultBackendRegistry()
  const admissionAdapter = options.adapter ?? admissionRegistry.select({ preferred: options.backend, requiredCapabilities })
  if (!requiredCapabilities.every((capability) => admissionAdapter.capabilities.includes(capability))) throw new Error("BACKEND_CAPABILITY_UNAVAILABLE")
  const missingIntegrations = unsupportedIntegrations(admissionAdapter.capabilities, integrationBundle)
  if (missingIntegrations.length > 0) throw new Error(`INTEGRATION_CAPABILITY_UNAVAILABLE:${missingIntegrations.join(",")}`)
  if (admissionAdapter.name !== "native" && integrationRequirements(integrationBundle).length > 0 && admissionAdapter.integrationHook === undefined) throw new Error("INTEGRATION_BRIDGE_UNAVAILABLE")
  const mcpTools = Object.freeze((await Promise.all(mcpClients.map((client) => createMcpNativeTools(client)))).flat())
  const mcpResources = mcpLoadResources
    ? Object.freeze((await Promise.all(mcpClients.map((client) => createMcpContextResources(client)))).flat())
    : Object.freeze([])
  const promptClients = mcpClients.filter((client) => {
    const value = client as unknown
    return isRecord(value) && typeof value.listPrompts === "function" && typeof value.getPrompt === "function"
  })
  const mcpPrompts = Object.freeze(await Promise.all(promptClients.map((client) => createMcpPromptCatalog(client))))
  // Explicit CLI context wins; otherwise behavior-file instructions append.
  const ownContext = namedSkillPaths.length === 0 ? baseContext : withoutSkillPaths(baseContext)
  const behaviorSystemPrompt = behavior?.instructionsText
  const effectiveContext = behaviorSystemPrompt !== undefined && ownContext?.systemPrompt === undefined
    ? { ...ownContext, systemPrompt: behaviorSystemPrompt }
    : ownContext
  const context = await createContextResourceSet(policy, contextOptions(effectiveContext, plugins, mcpResources, skillRegistry, callerSkills !== undefined))
  // Native turns count through the model port; Claude Code and Codex report theirs as they finish.
  const counted = options.backend === "native" || options.backend === "codex" || options.backend === "claude-code"
  const metrics = options.metrics ?? (counted ? new RunrailMetrics() : undefined)
  const nativeModel =
    options.backend === "native"
      ? await createNativeModel(options, policy.root, context, plugins, metrics, behavior, policy.folders)
      : undefined
  const modelPort = nativeModel === undefined || piExtensions === undefined ? nativeModel?.port : withActivePiTools(nativeModel.port, piExtensions)
  const connectorTools = connectorRegistry === undefined
    ? Object.freeze([])
    : await connectorRegistry.nativeTools({
      cwd: policy.root,
      ...(connectorToolOptions ?? {}),
      // Native Nifra approval is the authoritative gate for a connector tool.
      // The registry still denies direct invocations without its own callback,
      // while this nested call avoids asking twice after the host approved it.
      ...(connectorToolOptions?.approve === undefined ? { approve: () => true } : {}),
    })
  // The behavior file's servers, and Nifra's in a Nifra project, serve Runrail's own loop; a coding
  // tool keeps its own MCP settings.
  const grants = behavior?.integrations
  const nifraServer = options.backend === "native" ? nifraMcpServer(policy.root, options.nifra, behavior?.mcpServers ?? []) : undefined
  const servers = nifraServer === undefined ? behavior?.mcpServers : [...(behavior?.mcpServers ?? []), nifraServer]
  // A server the role may not use is not started at all.
  const grantedServers = servers?.map((server) => (grantOf(grants, mcpGrantKey(server.name)) === "off" ? { ...server, enabled: false } : server))
  const configuredMcp = options.backend === "native" && grantedServers !== undefined ? grantConfiguredMcp(await connectConfiguredMcp(grantedServers, policy.root, undefined, undefined, process.env, options.mcpSignIns), grants) : NO_CONFIGURED_MCP
  owned.push(() => configuredMcp.close())
  const grantedConnectors = options.connectors === undefined ? [] : grantedConnectorTools(options.connectors.registry, grants)
  // Codex, Pi, and the ACP agents cannot ask before a connector runs, so they get only what runs without asking.
  const unaskedConnectors = grantedConnectors.filter((tool) => !tool.approval)
  const acpRoute = isAcpRouteBackend(options.backend)
  const acpConnectors = acpRoute && options.connectors?.mcpServer !== undefined && unaskedConnectors.length > 0 ? options.connectors.mcpServer : undefined
  const piConnectors = options.backend === "pi" && options.connectors?.endpointFile !== undefined && unaskedConnectors.length > 0 ? await writePiConnectorsExtension(options.connectors.endpointFile, unaskedConnectors) : undefined
  if (piConnectors !== undefined) owned.push(() => piConnectors.remove())
  const backgroundCommands = options.backend === "native" ? new NativeBackgroundCommands({ root: policy.root, ...(options.onLive === undefined ? {} : { onLive: options.onLive }) }) : undefined
  if (backgroundCommands !== undefined) owned.push(() => backgroundCommands.close())
  const mergedTools = mergeNativeTools([
    ...createToolCatalog(policy, {
      verificationCommand: options.verificationCommand,
      verification: options.verify,
      ...(backgroundCommands === undefined ? {} : { background: backgroundCommands }),
    }),
    // The context lists skills without their bodies; this is how the native loop loads one.
    ...(options.backend === "native" && skillRegistry !== undefined ? [createSkillReadTool(skillRegistry)] : []),
    ...(options.backend === "native" && options.browser !== undefined ? createBrowserTools(options.browser.bridge) : []),
    ...(options.backend === "native" && options.threads !== undefined ? createThreadsTools(options.threads.bridge) : []),
    ...(options.backend === "native" && options.images !== undefined ? createImageTools(options.images.service) : []),
    ...mcpTools,
    ...configuredMcp.tools,
    ...connectorTools,
    ...(options.backend === "native" && options.connectors !== undefined ? connectorNativeTools(options.connectors.registry, grantedConnectors) : []),
    ...(plugins?.tools ?? []),
    ...integrationTools,
  ])
  // Plan mode is genuinely read-only: mutating native tools never reach the model.
  const modeTools = behavior?.mode === "plan" ? filterToolsForMode(mergedTools, behavior.mode) : mergedTools
  const admittedTools = options.allowedToolCapabilities === undefined ? modeTools : modeTools.filter((tool) => (tool.capabilities?.length ?? 0) > 0 && tool.capabilities!.every((capability) => options.allowedToolCapabilities!.includes(capability)))
  const tools = behavior === undefined ? admittedTools : applyBehaviorToolPolicy(admittedTools, behavior)
  const registry = options.registry ?? createDefaultBackendRegistry({
    native: () => {
      if (nativeModel === undefined) throw new Error("native model was not initialized")
      // Without a port the engine keeps an approval pending until it is resolved.
      const approval: NativeApprovalPort | undefined =
        options.approval ?? behaviorApproval ?? (options.pendingApprovals === true ? undefined : { request: () => false })
      return new RunrailBackend({
        model: modelPort ?? nativeModel.port,
        tools,
        ...(approval === undefined ? {} : { approval }),
        approvalTimeoutMs: options.approvalTimeoutMs ?? APPROVAL_WAIT,
        ...(options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars }),
        maxSteps,
        maxMessageChars: NATIVE_MESSAGE_CHARS,
      })
    },
    pi: () => createPiBackend(createPiOptions(options, piConnectors === undefined ? [] : ["--extension", piConnectors.file])),
    replay: () => createReplayBackend(),
  })
  const adapter = options.adapter ?? registry.select({ preferred: options.backend, requiredCapabilities })
  const vendorRoute = options.backend === "codex" || options.backend === "claude-code" || acpRoute
  if (options.harnessLaunch !== undefined && !vendorRoute) throw new Error("HARNESS_LAUNCH_REQUIRES_HARNESS_BACKEND")
  // A caller who shapes the command line by hand owns every argument on it.
  // An ACP tool speaks one protocol whatever the command is called, so its settings always travel.
  const launchApplies = vendorRoute && options.harnessPersistent !== true && (options.harnessCommand === undefined || options.harnessProtocol === "app-server" || options.harnessProtocol === "sdk" || acpRoute)
  if (options.harnessLaunch !== undefined && !launchApplies) throw new Error("HARNESS_LAUNCH_REQUIRES_VENDOR_COMMAND")
  if (policy.folders.length > 0 && vendorRoute && !launchApplies) throw new Error("FOLDERS_REQUIRE_VENDOR_COMMAND")
  const launched = launchApplies ? deriveHarnessLaunch(options.harnessLaunch, options.modelSelection, behavior) : undefined
  const derivedLaunch = launched === undefined || policy.folders.length === 0 ? launched : Object.freeze({ ...launched, addDirs: policy.folders })
  const browserLaunch = derivedLaunch !== undefined && options.backend === "claude-code" && options.browser?.mcpConfig !== undefined ? withToolsMcp(derivedLaunch, options.browser.mcpConfig, BROWSER_MCP_HINT, BROWSER_MCP_ALLOWED_TOOLS) : derivedLaunch
  const threadsLaunch = browserLaunch !== undefined && options.backend === "claude-code" && options.threads?.mcpConfig !== undefined ? withToolsMcp(browserLaunch, options.threads.mcpConfig, THREADS_MCP_HINT, THREADS_MCP_ALLOWED_TOOLS) : browserLaunch
  const computerLaunch = threadsLaunch !== undefined && options.backend === "claude-code" && options.computer?.mcpConfig !== undefined ? withToolsMcp(threadsLaunch, options.computer.mcpConfig, COMPUTER_MCP_HINT, COMPUTER_MCP_ALLOWED_TOOLS) : threadsLaunch
  const imagesLaunch = computerLaunch !== undefined && options.backend === "claude-code" && options.images?.mcpConfig !== undefined ? withToolsMcp(computerLaunch, options.images.mcpConfig, IMAGES_MCP_HINT, IMAGES_MCP_ALLOWED_TOOLS) : computerLaunch
  const harnessLaunch = imagesLaunch !== undefined && options.backend === "claude-code" && options.connectors?.mcpConfig !== undefined && grantedConnectors.length > 0
    ? withConnectorsMcp(imagesLaunch, options.connectors.mcpConfig, grantedConnectors)
    : imagesLaunch !== undefined && acpConnectors !== undefined ? withInstructions(imagesLaunch, CONNECTORS_ACP_HINT) : imagesLaunch
  const connectorApprovals = options.backend === "claude-code" && grantedConnectors.some((tool) => tool.approval) ? new ConnectorApprovals() : undefined
  // The tool's own command in its default config folder, where an import found the conversation.
  const shapedArgs = Array.isArray(options.harnessArgs) && options.harnessArgs.length > 0
  // Of the tools spoken to over ACP only OpenCode copies a conversation (`session/fork`); Gemini CLI,
  // Goose and Copilot CLI would only load the original, writing into their own history.
  const copiesSessions = options.backend === "claude-code" || options.backend === "codex" || (options.backend === "opencode" && options.harnessCommand === undefined)
  const toolSessions: ToolSessions | undefined = copiesSessions && launchApplies && !shapedArgs && options.sessionDir !== undefined && options.harnessAccount?.configDir === undefined
    ? Object.freeze({ tool: options.backend, store: vendorSessionStore(join(options.sessionDir, "harness"), options.backend) })
    : undefined
  const reviews = new ReviewRelay()
  // A coding tool's reviews and retries reach the transcript even when no one is watching live.
  const harnessLive = options.onLive === undefined && options.transcriptStore === undefined ? undefined : relayReviews(options.onLive, reviews)
  let backend = await adapter.create({
    cwd: policy.root,
    requestedCapabilities: requiredCapabilities,
    options: Object.freeze({
      model: modelPort,
      tools,
      pi: options.pi,
          harnessCommand: options.harnessCommand,
          harnessArgs: options.harnessArgs,
          harnessAuth: options.harnessAuth,
          ...(options.harnessAccount === undefined ? {} : { harnessAccount: options.harnessAccount }),
          harnessPersistent: options.harnessPersistent,
          harnessProtocol: options.harnessProtocol,
          ...(harnessLaunch === undefined ? {} : { harnessLaunch }),
          ...(options.backend === "codex" && options.browser !== undefined ? { browser: options.browser.bridge } : {}),
          ...(options.backend === "codex" && options.threads !== undefined ? { threads: options.threads.bridge } : {}),
          ...(options.backend === "codex" && options.computer !== undefined ? { computer: options.computer.bridge } : {}),
          ...(options.backend === "codex" && options.images !== undefined ? { images: options.images.service } : {}),
          // Codex cannot ask before a dynamic tool runs, so it gets only what runs without asking.
          ...(options.backend === "codex" && options.connectors !== undefined && unaskedConnectors.length > 0 ? { connectors: { registry: options.connectors.registry, tools: unaskedConnectors } } : {}),
          ...(acpConnectors === undefined ? {} : { harnessMcpServers: [{ name: CONNECTORS_MCP_SERVER, command: acpConnectors.command, args: acpConnectors.args, env: [] }] }),
          // Beside the session's own files: the vendor conversation this session continues.
          ...(vendorRoute && options.sessionDir !== undefined ? { harnessStateDir: join(options.sessionDir, "harness") } : {}),
          ...(harnessLive === undefined ? {} : { onLive: harnessLive }),
          ...(metrics === undefined || !vendorRoute ? {} : { onMetadata: harnessUsageSink(metrics, options.backend) }),
          ...(connectorApprovals === undefined ? {} : { onApproved: connectorApprovalSink(connectorApprovals) }),
        }),
  })
  if (adapter.integrationHook !== undefined) backend = await adapter.integrationHook(backend, { cwd: policy.root, bundle: integrationBundle, requested: integrationRequirements(integrationBundle) })
  const sessionStore =
    options.sessionDir === undefined
      ? undefined
      : new EvidenceOnlySessionStore(new FileSessionStore({ root: join(options.sessionDir, "events") }))
  const extensions = options.loadExtensions === true ? await createExtensionHost(policy.root) : undefined
  // A command the caller chose must run, and fails the turn when it cannot. The default gate is
  // optional: without a runnable `nifra`, or outside a Nifra project, there is nothing to check against.
  const verificationAvailable = options.verifyAfterTurn !== false && verificationGateAvailable({ command: options.verificationCommand, cwd: policy.root, requested: options.verifyAfterTurn === true, ...(options.nifra === undefined ? {} : { nifra: options.nifra }) })
  return {
    policy,
    backend,
    adapter,
    registry,
    ...(sessionStore === undefined ? {} : { sessionStore }),
    ...(extensions === undefined ? {} : { extensions }),
    skillRegistry: listedSkillRegistry,
    context,
    ...(mcpPrompts.length === 0 ? {} : { mcpPrompts }),
    ...(configuredMcp.status.length === 0 ? {} : { mcp: configuredMcp }),
    // What `/connectors` lists and runs for this thread's route.
    ...(options.connectors === undefined ? {} : { connectors: { registry: options.connectors.registry, tools: options.backend === "pi" || acpRoute ? unaskedConnectors : grantedConnectors, ...(connectorApprovals === undefined ? {} : { approvals: connectorApprovals }) } }),
    ...(backgroundCommands === undefined ? {} : { backgroundCommands }),
    ...(piConnectors === undefined ? {} : { piConnectors }),
    ...(behavior === undefined || behavior.mcpServers.length === 0 ? {} : { mcpServers: behavior.mcpServers }),
    ...(options.mcpSignIns === undefined ? {} : { mcpSignIns: options.mcpSignIns }),
    ...(nativeModel?.catalog === undefined ? {} : { modelCatalog: nativeModel.catalog }),
    ...(nativeModel?.router === undefined ? {} : { modelRouter: nativeModel.router }),
    ...(nativeModel?.descriptor === undefined ? {} : { modelDescriptor: nativeModel.descriptor }),
    ...(nativeModel?.setPromptParts === undefined ? {} : { setPromptParts: nativeModel.setPromptParts }),
    ...(nativeModel?.usage === undefined ? {} : { usage: nativeModel.usage }),
    ...(nativeModel?.history === undefined ? {} : { history: nativeModel.history }),
    ...(nativeModel?.steering === undefined ? {} : { steering: nativeModel.steering }),
    ...(metrics === undefined ? {} : { metrics }),
    ...(plugins === undefined ? {} : { plugins }),
    ...(piExtensions === undefined ? {} : { piExtensions }),
    ...(options.ui === undefined ? {} : { ui: options.ui }),
    verify,
    maxRepairAttempts,
    verificationTimeoutMs,
    verificationCommand: options.verificationCommand ?? process.env.RUNRAIL_NIFRA_COMMAND ?? "nifra",
    verificationAvailable,
    nifra: Object.freeze({
      mcp: nifraServer !== undefined && configuredMcp.status.some((server) => server.name === "nifra" && server.state === "ready"),
      pi: options.backend === "pi" && piUsesNifra(createPiOptions(options)),
      check: verificationAvailable && options.backend !== "replay" && options.verificationCommand === undefined && process.env.RUNRAIL_NIFRA_COMMAND === undefined,
    }),
    reviews,
    ...(toolSessions === undefined ? {} : { toolSessions }),
  }
}

export type ApprovalScope = "once" | "session"

function rememberApprovalForSession(backend: AgentBackend, sessionId: string, approvalId: string): void {
  const setScope = (backend as { readonly setApprovalScope?: unknown }).setApprovalScope
  if (typeof setScope === "function") setScope.call(backend, sessionId, approvalId, "session")
}

const NO_ANSWERS: ApprovalAnswers = Object.freeze({})

function approvalNeedsAnswers(backend: AgentBackend, sessionId: string, approvalId: string): boolean {
  const needs = (backend as { readonly approvalNeedsAnswers?: unknown }).approvalNeedsAnswers
  return typeof needs === "function" && needs.call(backend, sessionId, approvalId) === true
}

/** A backend without questions takes the approval alone, and its coding tool asks in its reply; it cannot be asked for more. */
function answerApprovalQuestions(backend: AgentBackend, sessionId: string, approvalId: string, answers: ApprovalAnswers, followUp: FollowUp | undefined): void {
  const setAnswers = (backend as { readonly setApprovalAnswers?: unknown }).setApprovalAnswers
  if (typeof setAnswers !== "function") {
    if (followUp !== undefined) throw new RunrailSessionError("SESSION_ANSWERS_INVALID", FOLLOW_UP_UNSUPPORTED)
    return
  }
  try {
    setAnswers.call(backend, sessionId, approvalId, answers, followUp)
  } catch (error) {
    throw new RunrailSessionError("SESSION_ANSWERS_INVALID", error instanceof Error ? error.message.replace(/^command agent backend: /, "") : "answers are invalid")
  }
}

const MAX_STREAMED_RECORD_CHARS = 64 * 1024

type StreamedTextEvent = Extract<AgentEvent, { readonly type: "assistant.delta" | "tool.delta" }>

function streamedText(event: AgentEvent): StreamedTextEvent | undefined {
  return (event.type === "assistant.delta" || event.type === "tool.delta") && typeof event.text === "string" ? event : undefined
}

function sameStream(left: StreamedTextEvent, right: StreamedTextEvent): boolean {
  if (left.type !== right.type || left.turnId !== right.turnId) return false
  return left.type !== "tool.delta" || right.type !== "tool.delta" || left.callId === right.callId
}

/** Claude Code's approvals of connector tools, kept for `POST /connectors` to spend. */
function connectorApprovalSink(approvals: ConnectorApprovals): (toolName: string, input: Readonly<Record<string, unknown>>) => void {
  const prefix = `mcp__${CONNECTORS_MCP_SERVER}__`
  return (toolName, input) => {
    if (toolName.startsWith(prefix)) approvals.approve(toolName.slice(prefix.length), input)
  }
}

/** Claude Code's connectors: tools that need no approval run without asking; the rest always ask. */
function withConnectorsMcp(launch: HarnessLaunchOptions, mcpConfig: string, granted: readonly GrantedConnectorTool[]): HarnessLaunchOptions {
  const permissions = connectorsPermissions(granted)
  const room = MAX_APPEND_SYSTEM_PROMPT - CONNECTORS_MCP_HINT.length - 2
  return Object.freeze({
    ...launch,
    appendSystemPrompt: launch.appendSystemPrompt === undefined ? CONNECTORS_MCP_HINT : `${launch.appendSystemPrompt.slice(0, room)}\n\n${CONNECTORS_MCP_HINT}`,
    mcpConfig: Object.freeze([...(launch.mcpConfig ?? []), mcpConfig]),
    allowedTools: Object.freeze([...new Set([...(launch.allowedTools ?? []), ...permissions.allowedTools])]),
    ...(permissions.askTools.length === 0 ? {} : { askTools: Object.freeze([...new Set([...(launch.askTools ?? []), ...permissions.askTools])]) }),
  })
}

function withInstructions(launch: HarnessLaunchOptions, hint: string): HarnessLaunchOptions {
  const room = MAX_APPEND_SYSTEM_PROMPT - hint.length - 2
  return Object.freeze({ ...launch, appendSystemPrompt: launch.appendSystemPrompt === undefined ? hint : `${launch.appendSystemPrompt.slice(0, room)}\n\n${hint}` })
}

/** Claude Code's browser or thread tools: one more MCP server, whose tools run without asking each time. */
function withToolsMcp(launch: HarnessLaunchOptions, mcpConfig: string, hint: string, allowed: string): HarnessLaunchOptions {
  const room = MAX_APPEND_SYSTEM_PROMPT - hint.length - 2
  return Object.freeze({
    ...launch,
    appendSystemPrompt: launch.appendSystemPrompt === undefined ? hint : `${launch.appendSystemPrompt.slice(0, room)}\n\n${hint}`,
    mcpConfig: Object.freeze([...(launch.mcpConfig ?? []), mcpConfig]),
    allowedTools: Object.freeze([...new Set([...(launch.allowedTools ?? []), allowed])]),
  })
}

/**
 * Token counts a coding tool reports at the end of each turn, added to the session's totals.
 * Claude Code reports cached prompt tokens apart from `input_tokens`, as Anthropic does, so they
 * are added back; Codex already counts them inside its input. Only counts travel, never content.
 */
function harnessUsageSink(metrics: RunrailMetrics, backend: string | undefined): HarnessMetadataSink {
  return (event) => {
    if (event.kind !== "usage") return
    const cached = backend === "claude-code" ? (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0) : 0
    const input = event.inputTokens === undefined ? undefined : event.inputTokens + cached
    metrics.recordTokens(input ?? 0, event.outputTokens ?? 0)
  }
}

/** Nifra denies an approval after five minutes unless told; the person may be away, so it waits for them. */
const APPROVAL_WAIT: ApprovalTimeout = "never"

function createHost(runtime: RunrailRuntime, options: RunrailSessionOptions): CodingAgentHost {
  return new CodingAgentHost({
    backend: runtime.backend,
    approvals: { timeoutMs: APPROVAL_WAIT },
    ...(runtime.sessionStore === undefined ? {} : { sessionStore: runtime.sessionStore }),
    ...(runtime.extensions === undefined ? {} : { extensions: runtime.extensions }),
    verifyAfterTurn: runtime.adapter.name === "replay" || !runtime.verificationAvailable ? [] : [runtime.verify],
    maxRepairAttempts: runtime.maxRepairAttempts,
    verification: {
      command: runtime.verificationCommand,
      timeoutMs: runtime.verificationTimeoutMs,
      maxOutputBytes: 64 * 1024,
      env: filteredEnvironment(),
    },
    ...(options.ui === undefined ? {} : { exposeErrorStacks: false }),
  })
}

interface NativeModelRuntime {
  readonly port: NativeModelPort
  readonly steering: SteeringModelPort
  readonly catalog: ModelCatalog
  readonly router: RoutedModelPort
  readonly descriptor: ModelDescriptor
  readonly setPromptParts: (parts: readonly RunrailContentPart[]) => void
  readonly usage: BudgetLedger
  readonly history: ModelHistory
}

async function createNativeModel(
  options: RunrailSessionOptions,
  cwd: string,
  context: ContextResourceSet,
  plugins: PluginHostSnapshot | undefined,
  metrics: RunrailMetrics | undefined,
  behavior: BehaviorConfig | undefined,
  folders: readonly string[] = [],
): Promise<NativeModelRuntime> {
  const direct = options.model
  const contentModel = options.contentModel
  const command = options.modelCommand
  const onLive = options.onLive
  const configuredProvider = options.provider === undefined
    ? undefined
    : createConfiguredProviderModelAdapter(onLive === undefined ? options.provider : { ...options.provider, onReasoning: (text) => onLive({ type: "reasoning.delta", text }), onNotice: (notice) => onLive({ type: "model.notice", ...notice }) })
  if (configuredProvider !== undefined && (direct !== undefined || contentModel !== undefined || command !== undefined)) throw new Error("MODEL_CONFIG_CONFLICT")
  const defaultId = options.modelSelection?.id ?? (configuredProvider?.descriptor.id ?? (contentModel === undefined ? direct === undefined ? command === undefined ? "scripted" : "command" : "caller" : options.contentModelDescriptor?.id ?? "content"))
  const descriptor: ModelDescriptor = configuredProvider?.descriptor ?? {
    ...(options.contentModelDescriptor ?? {}),
    id: options.contentModelDescriptor?.id ?? defaultId,
    provider: options.contentModelDescriptor?.provider ?? (contentModel === undefined ? direct === undefined ? command === undefined ? "runrail" : "command" : "caller" : "caller"),
    version: options.contentModelDescriptor?.version ?? RUNRAIL_VERSION,
    tier: options.contentModelDescriptor?.tier ?? (contentModel === undefined ? direct === undefined ? command === undefined ? "cheap" : "fast" : "strong" : "strong"),
    capabilities: Object.freeze(options.contentModelDescriptor?.capabilities ?? options.modelCommand?.capabilities ?? ["streaming", "tools"]),
    contextTokens: options.contentModelDescriptor?.contextTokens ?? 128_000,
  }
  const promptParts: { current: readonly RunrailContentPart[] } = { current: Object.freeze([]) }
  const adapter: ModelAdapter = configuredProvider === undefined
    ? {
        descriptor,
        create: () => contentModel === undefined
          ? direct ?? (command === undefined ? new ScriptedModel() : new CommandModelPort(command))
          : createContentModelPort(contentModel, () => promptParts.current),
      }
    : {
        descriptor,
        contentAware: true,
        create: async (modelContext) => createContentModelPort(
          await configuredProvider.create(modelContext) as unknown as RunrailContentModelPort,
          () => promptParts.current,
        ),
      }
  const catalog = options.modelCatalog ?? createModelCatalog([adapter])
  if (options.modelCatalog !== undefined && catalog.get(descriptor.id) === undefined) catalog.register(adapter)
  if (plugins !== undefined) {
    for (const provider of plugins.providers) {
      if (catalog.get(provider.descriptor.id) === undefined) catalog.register(provider)
    }
  }
  const selection: ModelSelection = options.modelSelection ?? (options.modelCatalog === undefined || configuredProvider !== undefined ? { id: descriptor.id } : {})
  // Behavior-file effort fills thinking only when the caller did not set it.
  const effectiveSelection = behavior !== undefined && selection.thinking === undefined
    ? { ...selection, thinking: behavior.effort }
    : selection
  const router = await createRoutedModelPort(catalog, effectiveSelection, { cwd })
  const selectedBase: NativeModelPort = router
  const selectedModel: NativeModelPort = options.fallbackModel === undefined
    ? selectedBase
    : new FallbackModelPort(selectedBase, options.fallbackModel)
  // Innermost of the session's ports, so its key covers the whole request: earlier turns, the project
  // context or system prompt, and the attachments, which some adapters add further in.
  const cachedModel: NativeModelPort = options.cache === undefined
    ? selectedModel
    : new CachedModelPort(selectedModel, () => router.current.descriptor, options.cache, metrics, () => ({ thinking: router.current.thinking, quality: router.current.quality, parts: promptParts.current }))
  const selectedAdapter = catalog.get(router.current.descriptor.id)
  const contentSelected: NativeModelPort = selectedAdapter?.contentAware === true
    ? createContentModelPort(cachedModel as unknown as RunrailContentModelPort, () => promptParts.current)
    : cachedModel
  // A provider takes instructions as a system prompt of their own: the default coding prompt, then
  // the project's context. Any other model keeps the context as the first message, as before.
  const contextual = configuredProvider === undefined || options.provider === undefined
    ? createContextAwareModelPort(contentSelected, context)
    : createSystemPromptModelPort(
        contentSelected,
        options.defaultSystemPrompt === false
          ? { text: () => assembleSystemPrompt("", context.text()).trimStart() }
          : createSystemPromptSource({
              family: promptFamily(options.provider.provider, configuredProvider.provider.protocols[0], options.provider.model),
              environment: { ...(await readPromptEnvironment(cwd)), ...(folders.length === 0 ? {} : { folders }) },
              ...(behavior === undefined ? {} : { mode: behavior.mode }),
            }, () => context.text()),
      )
  // Earlier turns go after the project context and before the live conversation.
  const history = new ModelHistory()
  const recalled = createHistoryModelPort(contextual, history)
  const usage = new BudgetLedger({
    budget: options.budget,
    model: router.current.descriptor,
    onUsage: (snapshot) => {
      // The usage pane reads the session's totals while it runs, not only after it stops.
      metrics?.trackUsage(usage, snapshot)
      options.onUsage?.(snapshot)
    },
    ...(onLive === undefined
      ? {}
      : {
          onRequest: (request) => {
            const windowTokens = router.current.descriptor.contextTokens
            onLive({ type: "context.usage", usedTokens: request.inputTokens + request.outputTokens, ...(windowTokens > 0 ? { windowTokens } : {}), estimated: request.estimated })
          },
        }),
  })
  const budgeted = new BudgetedModelPort(recalled, usage)
  // With a cache, the cache counts the calls that reached the model.
  const counted: NativeModelPort = options.cache !== undefined || metrics === undefined ? budgeted : new MeteredModelPort(budgeted, metrics)
  // Outermost, so a steer sits among the loop's own messages, before earlier turns are added.
  const steering = new SteeringModelPort(counted)
  return {
    port: steering,
    steering,
    catalog,
    router,
    descriptor: router.current.descriptor,
    setPromptParts: (parts) => {
      promptParts.current = Object.freeze([...parts])
    },
    usage,
    history,
  }
}

function mergeNativeTools(tools: readonly NativeTool[]): readonly NativeTool[] {
  const names = new Set<string>()
  const result: NativeTool[] = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== "object" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(tool.name) || typeof tool.description !== "string" || tool.description.length > 64 * 1024 || typeof tool.execute !== "function")
      throw new Error("NATIVE_TOOL_INVALID")
    if (names.has(tool.name)) throw new Error("NATIVE_TOOL_DUPLICATE")
    names.add(tool.name)
    result.push(tool)
  }
  return Object.freeze(result)
}

function mergePluginSnapshots(
  ...snapshots: readonly (PluginHostSnapshot | undefined)[]
): PluginHostSnapshot | undefined {
  const active = snapshots.filter((snapshot): snapshot is PluginHostSnapshot => snapshot !== undefined)
  if (active.length === 0) return undefined
  return Object.freeze({
    plugins: Object.freeze(active.flatMap((snapshot) => snapshot.plugins)),
    tools: Object.freeze(active.flatMap((snapshot) => snapshot.tools)),
    commands: Object.freeze(active.flatMap((snapshot) => snapshot.commands)),
    prompts: Object.freeze(active.flatMap((snapshot) => snapshot.prompts)),
    skills: Object.freeze(active.flatMap((snapshot) => snapshot.skills)),
    themes: Object.freeze(active.flatMap((snapshot) => snapshot.themes)),
    ui: Object.freeze(active.flatMap((snapshot) => snapshot.ui)),
    providers: Object.freeze(active.flatMap((snapshot) => snapshot.providers)),
    verification: Object.freeze(active.flatMap((snapshot) => snapshot.verification)),
    workflows: Object.freeze(active.flatMap((snapshot) => snapshot.workflows)),
    subagents: Object.freeze(active.flatMap((snapshot) => snapshot.subagents)),
    ...(active.some((snapshot) => snapshot.actions !== undefined) ? { actions: Object.freeze(active.flatMap((snapshot) => snapshot.actions ?? [])) } : {}),
    ...(active.some((snapshot) => snapshot.hooks !== undefined) ? { hooks: Object.freeze(active.flatMap((snapshot) => snapshot.hooks ?? [])) } : {}),
    ...(active.some((snapshot) => snapshot.nativeUI !== undefined) ? { nativeUI: Object.freeze(active.flatMap((snapshot) => snapshot.nativeUI ?? [])) } : {}),
  })
}

function contextOptions(
  options: ContextResourceOptions | undefined,
  plugins: PluginHostSnapshot | undefined,
  mcpResources: readonly import("./context/resources.ts").ContextResource[] = [],
  skillRegistry: ContextResourceOptions["skillRegistry"] = undefined,
  /** Plugin skills go in whole only beside a caller's registry; otherwise the session's registry lists them. */
  pluginSkillsAsResources = false,
): ContextResourceOptions | undefined {
  if (plugins === undefined && mcpResources.length === 0 && skillRegistry === undefined) return options
  const additionalResources = Object.freeze([
    ...((options?.additionalResources ?? [])),
    ...mcpResources,
    ...(pluginSkillsAsResources ? plugins?.skills.map((resource) => ({ id: resource.id, kind: "skill" as const, content: resource.content })) ?? [] : []),
    ...(plugins?.themes.map((resource) => ({ id: resource.id, kind: "theme" as const, content: resource.content })) ?? []),
  ])
  const promptTemplates: Record<string, string> = { ...(options?.promptTemplates ?? {}) }
  for (const prompt of plugins?.prompts ?? []) if (promptTemplates[prompt.id] === undefined) promptTemplates[prompt.id] = prompt.template
  return {
    ...(options ?? {}),
    ...(skillRegistry === undefined || options?.skillRegistry !== undefined ? {} : { skillRegistry }),
    additionalResources,
    promptTemplates: Object.freeze(promptTemplates),
  }
}

async function createExtensionHost(cwd: string): Promise<ExtensionHost> {
  return new ExtensionHost({
    cwd,
    roots: await discoverExtensions(cwd),
    validate: validateExtensionModule,
  })
}

/**
 * Keeps the public local session store evidence-only even when a caller invokes the generic
 * checkpoint API with an arbitrary payload. Checkpoint state is represented by the host snapshot
 * event; the separate Nifra checkpoint file is intentionally discarded at this seam.
 */
class EvidenceOnlySessionStore implements SessionStore {
  constructor(private readonly inner: FileSessionStore) {}

  append(
    sessionId: string,
    type: string,
    payload?: unknown,
    options?: { readonly pinned?: boolean },
  ) {
    return this.inner.append(
      sessionId,
      type,
      // An imported checkpoint keeps only where it came from, so importing it again is a no-op.
      type === "session.checkpoint" && !isImportedEvidencePayload(payload) ? undefined : payload,
      options,
    )
  }

  read(sessionId: string) {
    return this.inner.read(sessionId)
  }

  checkpoint(_sessionId: string, _payload: unknown): Promise<void> {
    return Promise.resolve()
  }

  fork(sessionId: string, targetSessionId?: string) {
    return this.inner.fork(sessionId, targetSessionId)
  }
}

const NO_NIFRA: NifraUse = Object.freeze({ mcp: false, pi: false, check: false })

function piUsesNifra(options: Pick<PiBackendOptions, "appendSystemPrompt" | "enableNifraTools">): boolean {
  return options.enableNifraTools === true || options.appendSystemPrompt === NIFRA_AGENT_INSTRUCTIONS
}

function createPiOptions(options: RunrailSessionOptions, extraArgs: readonly string[] = []): Pick<PiBackendOptions, "command" | "args" | "rpcArgs" | "env" | "sessionDir" | "noSession" | "reloadCommand" | "enableReloadBridge" | "appendSystemPrompt" | "enableNifraTools" | "maxEventQueueSize"> {
  const command = options.pi?.command ?? process.env.RUNRAIL_PI_COMMAND
  const sessionDir = options.pi?.sessionDir ?? options.sessionDir
  const args = [...piSelectionArguments(options), ...extraArgs]
  const nifra = nifraApplies(options.nifra, options.cwd)
  return {
    ...(options.pi ?? {}),
    ...(args.length === (options.pi?.args?.length ?? 0) ? {} : { args }),
    ...(command === undefined ? {} : { command }),
    ...(sessionDir === undefined ? {} : { sessionDir }),
    // Pi is told it works in a Nifra project, and gets Nifra's tools, only when it does.
    ...(options.pi?.appendSystemPrompt === undefined && nifra ? { appendSystemPrompt: NIFRA_AGENT_INSTRUCTIONS } : {}),
    enableNifraTools: options.pi?.enableNifraTools ?? nifra,
  }
}

const PI_THINKING: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

/**
 * A model and a thinking level chosen in Runrail travel to Pi as its own `--model` and `--thinking`
 * flags. Pi resolves the model (`provider/id`, or a pattern) against the logins it holds itself.
 * A flag the caller already put on Pi's command line is left as written.
 */
function piSelectionArguments(options: RunrailSessionOptions): readonly string[] {
  const given = options.pi?.args ?? []
  const selection = options.backend === "pi" ? options.modelSelection : undefined
  if (selection === undefined) return given
  const args = [...given]
  if (selection.id !== undefined && !given.includes("--model")) {
    // Never a leading hyphen: the id is one argument on Pi's command line.
    if (!isHarnessModelId(selection.id)) throw new HarnessLaunchError("model is invalid")
    args.push("--model", selection.id)
  }
  if (selection.thinking !== undefined && PI_THINKING.has(selection.thinking) && !given.includes("--thinking")) args.push("--thinking", selection.thinking)
  return Object.freeze(args)
}

function withoutSkillPaths(context: ContextResourceOptions | undefined): ContextResourceOptions | undefined {
  if (context?.skillPaths === undefined) return context
  const { skillPaths: _moved, ...rest } = context
  return rest
}

/** The home whose user-wide skill folders are read, or undefined when they are not. */
function userSkillHome(value: RunrailSessionOptions["userSkills"], behavior: BehaviorConfig | undefined): string | undefined {
  if (value === undefined) return behavior?.userSkillRoots === true ? homedir() : undefined
  if (typeof value === "boolean") return value ? homedir() : undefined
  if (!isRecord(value) || typeof value.home !== "string") throw new Error("USER_SKILLS_INVALID")
  return value.home
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertBound(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max}`)
}

/**
 * The catalog is built once, but an extension may change its active tools at any time, so each
 * request leaves out the Pi tools that are inactive right now. Their executors refuse as well.
 */
function withActivePiTools(port: NativeModelPort, host: PiExtensionHost): NativeModelPort {
  return new Proxy(port, {
    get(target, property) {
      if (property === "complete") return (request: Parameters<NativeModelPort["complete"]>[0]) => target.complete({ ...request, tools: request.tools.filter((tool) => host.isToolActive(tool.name)) })
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** A coding tool's mark of where its own conversation stands, if it keeps one. */
function vendorMarkOf(backend: AgentBackend, sessionId: string): VendorMark | undefined {
  const mark = (backend as { readonly vendorMark?: unknown }).vendorMark
  if (typeof mark !== "function") return undefined
  const value: unknown = mark.call(backend, sessionId)
  return isVendorMark(value) ? value : undefined
}
