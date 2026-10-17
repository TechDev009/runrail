import { mkdir, realpath, stat } from "node:fs/promises"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { isIP } from "node:net"
import { MCP_SERVER_NAME } from "./behavior/config.ts"
import { RunrailControlError, RunrailSessionController, type RunrailControlInput, type RunrailRewindTarget, type RunrailToolConnectionRoute } from "./control.ts"
import { RunrailSessionError, type RunrailSessionOptions } from "./session.ts"
import { MAX_PROMPT_CHARS } from "./context/resources.ts"
import { THINKING_LEVELS, type ModelCapability, type ModelQuality, type ModelSelection, type ModelTier, type ThinkingLevel } from "./model/catalog.ts"
import type { PluginManager } from "./plugins/manager.ts"
import type { PluginPermission } from "./plugins/manifest.ts"
import { ConnectorError, type ConnectorRegistry } from "./connectors/registry.ts"
import { buildConnectorRegistry, CONNECTOR_KINDS, CONNECTOR_NAMES, connectorSecretId, ConnectorSetupStore, isConnectorKind, type ConnectorKind } from "./connectors/setup.ts"
import { createConnectorsEndpoint } from "./connectors/mcp.ts"
import { callConnector } from "./connectors/tools.ts"
import type { MultiAgentCoordinator, RunrailAgentTask } from "./agents/runner.ts"
import { createDefaultProviderCatalog, discoverProviderModels } from "./providers/catalog.ts"
import type { ProviderCredentialResolver, ProviderDiscoveryOptions, ProviderModelOptions } from "./providers/types.ts"
import { ProviderError } from "./providers/errors.ts"
import { CUSTOM_PROVIDER_PRESETS, PROVIDER_PRESETS, getProviderPreset, isModelKeyVariable, keyVariableAllowedAt, resolveProviderTarget } from "./providers/presets.ts"
import { createModelMetadataSource, mergeModelList, modelDescriptorFacts, type ModelMetadataSource } from "./providers/model-list.ts"
import { createDefaultHarnessAdapters } from "./harness/defaults.ts"
import { HarnessRegistry, negotiateHarnessFeatures } from "./harness/registry.ts"
import { probeHarness, type HarnessProbeOptions, type HarnessProbeTarget } from "./harness/detect.ts"
import { harnessAccountEnvironment, harnessLoginCommand, harnessLogoutCommand, runHarnessLogout, type HarnessAccountCommand } from "./harness/account.ts"
import { createToolLogins, ToolLoginError, type ToolLogins } from "./harness/login-terminal.ts"
import type { HarnessStatus } from "./harness/types.ts"
import { APPROVAL_REVIEWED, REVIEWER_NOTICE } from "./harness/review.ts"
import { CommandAgentBackendError } from "./backend/command-agent.ts"
import { HttpAgentBackendError } from "./backend/http-agent.ts"
import { PtyAgentBackendError } from "./backend/pty-agent.ts"
import { parseAnswers, parseFollowUp, type ApprovalAnswers, type FollowUp } from "./harness/questions.ts"
import { FileTranscriptStore, peekTranscript, RUNRAIL_TRANSCRIPT_VERSION, TranscriptStoreError, type TranscriptAppendInput, type TranscriptReadOptions } from "./transcript/index.ts"
import { continueTranscript } from "./session/carryover.ts"
import { createWorkspacePolicy, DEFAULT_MAX_FILE_BYTES, filteredEnvironment, type WorkspacePolicy } from "./workspace/policy.ts"
import { WorkspaceEditError, saveOverRead, textHash } from "./workspace/edit.ts"
import {
  RUNRAIL_TERMINAL_MAX_INPUT_BYTES,
  RUNRAIL_TERMINAL_MAX_OUTPUT_BYTES,
  type RunrailTerminalBridge,
  type RunrailTerminalCapability,
  type RunrailTerminalChunk,
  type RunrailTerminalReadResult,
  type RunrailTerminalSession,
  validateRunrailTerminalBridge,
} from "./control-terminal.ts"
import { createNativeControlRuntime, nativeTaskController, type NativeControlRuntime } from "./control-native.ts"
import { dispatchControlGit, dispatchControlWorktree, isControlGitMethod, isControlWorktreeMethod } from "./control-git.ts"
import { CheckError, CheckRuns, CHECK_DEFAULT_TIMEOUT_MS, CHECK_MAX_TIMEOUT_MS } from "./check/run.ts"
import { SetupRuns } from "./setups/runner.ts"
import { parseSetup, parseSetupRole, SetupError } from "./setups/schema.ts"
import { SetupStore } from "./setups/store.ts"
import { linkDependencies, mineCandidates, validateCase } from "./evals/mine.ts"
import { EvalRuns } from "./evals/run.ts"
import { EvalError, MAX_CASES, parseSuite, SuiteStore } from "./evals/suite.ts"
import { memoryLabel, recallBlock } from "./memory/block.ts"
import { MemoryService, projectKey } from "./memory/service.ts"
import { parseContact, parseMessage, parseSubscription, PushError, sendPush, vapidKeys, type Vapid } from "./push/web-push.ts"
import { MemoryError } from "./memory/types.ts"
import { MAX_WEBHOOK_INPUT, WorkflowRuns } from "./workflows/run.ts"
import { parseProposalBlock, parseWorkflow, WorkflowError, type Workflow } from "./workflows/schema.ts"
import { WorkflowStore, type PullRequestRef } from "./workflows/store.ts"
import { pullRequestRef, watchedPullRequests } from "./workflows/pull-requests.ts"
import type { TurnCheckpoints } from "./checkpoints/turns.ts"
import { CodeHostError, CodeHostStore, GitError, GitWorkspace, ThreadWorktrees, knownHostService, outsideWorkTree, parseBranchName, parseCodeHost, parseGitService, parseRemoteName, parseWorktreeId, type GitRemote } from "./git/index.ts"
import { failedChecksWithCli, listTeamsWithCli, mergePullRequestWithCli, postReviewWithCli, pullRequestDiffWithCli, REVIEW_QUERY_MAX_CHARS, REVIEW_SEARCH_MAX, searchPullRequestsWithCli, viewPullRequestWithCli, type ReviewComment, type ReviewTeam } from "./git/github-reviews.ts"
import { GITHUB_CLI_MAX_PULL_REQUESTS, GitHubCliError, createPullRequestWithCli, runGitHubCli, gitHubCliLogin, listPullRequestsWithCli, pullRequestFromRest, pullRequestsForBranchWithCli } from "./git/github-cli.ts"
import { AccountError, ConnectionSettingsError, hasToolConnectionKey, toolConnectionAccount, toolConnectionHome, type ConnectionEntry, connectionDestination, connectionPresetId, detectShellConnections, findImportableConnections, redactAccount, parseAccountRecord, resolveConnection, type AccountAuthMode, type AccountRecord, type ResolvedConnection, type ToolConnection } from "./accounts/index.ts"
import { MAX_CREDENTIAL_SECRET_BYTES, type CredentialVault } from "./auth/vault.ts"
import { CredentialStoreError } from "./auth/broker.ts"
import { checkConnection, connectionCheckStatus, type ConnectionCheck } from "./connection-check.ts"
import { SignInError } from "./auth/signin-types.ts"
import { MAX_SIGN_IN_STATUS_WAIT_MS, type SignInManager, type SignInSnapshot } from "./auth/signin.ts"
import { ShareError, advanceShareCursor, assertShareLive, createContentFreeShareBundle, createShareReference, parseShareAccessGrant, parseShareArtifact, revokeShare, type ShareMode, type SharePayloadPolicy, type ShareRole } from "./share/index.ts"
import { presentControlEvent } from "./tools/presentation.ts"
import { LiveFrameCursorError, LiveFrameHub } from "./live/hub.ts"
import { scanServers, type ServerScan } from "./background/servers.ts"
import { BROWSER_ACTIONS, BrowserBridge, BrowserError, type BrowserAction } from "./browser/bridge.ts"
import { createBrowserEndpoint, type BrowserEndpoint } from "./browser/mcp.ts"
import { THREADS_ACTIONS, ThreadsBridge, ThreadsError, type ThreadsAction } from "./threads/bridge.ts"
import { createThreadsEndpoint } from "./threads/mcp.ts"
import { COMPUTER_ACTIONS, ComputerBridge, ComputerError, type ComputerAction } from "./computer/bridge.ts"
import { createComputerEndpoint } from "./computer/mcp.ts"
import { ImageError } from "./images/generate.ts"
import { createImagesEndpoint } from "./images/mcp.ts"
import { ImageService } from "./images/service.ts"
import { ConversationBuilder, SESSION_IMPORTED, boundConversationItems, transcriptEntry } from "./conversation/index.ts"
import {
  EXTERNAL_SOURCE_LABELS,
  ExternalSessionError,
  defaultExternalSessionRoots,
  listExternalSessions,
  parseExternalId,
  parseExternalSource,
  readExternalSession,
  type ExternalSessionRoots,
  type ExternalSessionSource,
} from "./session/external.ts"
import type { RunrailLiveFrame, RunrailLiveFrameInput, RunrailPlanLimitsFrame } from "./live/types.ts"
import { claudeUsageReader, codexUsageReader, UsageReader, UsageReadError, type ToolUsageRead, type UsageTool, type UsageAccountIdentity } from "./harness/usage-read.ts"
import { claudeAgentSdkStatus, installClaudeAgentSdk } from "./backend/claude-agent-sdk.ts"
import { parseNativeCommand } from "./native/commands.ts"
import { NativeContractError } from "./native/errors.ts"
import { parseNativePackageManifest, type NativePackageManifest } from "./native/manifest.ts"
import {
  createRunrailControlContract,
  RUNRAIL_CONTROL_MAX_EVENT_BYTES,
  RUNRAIL_CONTROL_MAX_REPLAY_EVENTS,
  RUNRAIL_CONTROL_PROTOCOL,
  type RunrailControlCapabilityStatus,
  type RunrailControlContract,
} from "./control-contract.ts"
import { timed } from "./startup-timings.ts"

const MAX_CONTROL_TRANSCRIPT_BYTES = 8 * 1024 * 1024
type TerminalControlCapability = "terminal.describe" | "terminal.create" | "terminal.write" | "terminal.read" | "terminal.resize" | "terminal.close"

export interface RunrailControlRpcServerOptions extends RunrailSessionOptions {
  readonly hostname?: string
  readonly allowRemote?: boolean
  /** PEM certificate and key. Required with `allowRemote`: the bearer token never crosses a network in the clear. */
  readonly tls?: { readonly cert: string; readonly key: string }
  readonly port?: number
  readonly authToken?: string
  readonly maxBodyBytes?: number
  readonly pluginManager?: PluginManager
  readonly connectorRegistry?: ConnectorRegistry
  readonly agentCoordinator?: MultiAgentCoordinator
  /** Optional caller-owned PTY/terminal transport. No process is spawned by the control server. */
  readonly terminalBridge?: RunrailTerminalBridge
  /** Terminal capabilities deliberately disabled by a launch path with no PTY bridge. */
  readonly unavailableTerminalCapabilities?: readonly TerminalControlCapability[]
  readonly nativeStateDir?: string
  readonly nativeProjectId?: string
  readonly nativeOwnerId?: string
  readonly nativeCredentialBroker?: import("./accounts/types.ts").CredentialBroker
  readonly nativeAccountStore?: import("./accounts/types.ts").AccountStore
  /** Directory for account metadata shared by every session on this machine. Defaults to the session's own state. */
  readonly nativeAccountsDir?: string
  /** Where pasted keys and sign-in tokens are kept. Enables `POST /secret`; without it accounts resolve from the environment only. */
  readonly nativeCredentialVault?: import("./auth/vault.ts").CredentialVault
  readonly nativeCredentialRefreshers?: Readonly<Record<string, import("./auth/broker.ts").CredentialRefresher>>
  /** The sign-ins on offer. Defaults to those vendors document for third-party tools. No control method can add or change one. */
  readonly nativeSignInFlows?: readonly import("./auth/signin-types.ts").SignInFlow[]
  readonly nativeShareStore?: import("./share/types.ts").ShareStore
  /** Bundled model facts joined onto each connection's model list. Defaults to the shipped snapshot. */
  readonly modelMetadata?: ModelMetadataSource
  /** Variables `connection.detect` looks at. Defaults to this process's environment; only names are reported. */
  readonly connectionEnvironment?: Readonly<Record<string, string | undefined>>
  /** The home folder `connection.importable` reads other tools' settings from. Defaults to the user's. */
  readonly connectionImportHome?: string
  readonly maxTasks?: number
  readonly maxEventsPerTask?: number
  /** The person's setups file. Defaults to `~/.runrail/setups.json`. */
  readonly setupsPath?: string
  /** Eval results, one folder per project. Defaults to `~/.runrail/evals`. */
  readonly evalsDir?: string
  /** Memory and its sources, shared by every engine. Defaults to `~/.runrail/memory`. */
  readonly memoryDir?: string
  /** Every project's workflows. Defaults to `~/.runrail/workflows.json`. */
  readonly workflowsPath?: string
  /** Directory for per-thread git worktrees. Defaults to `~/.runrail/worktrees`; must be outside the repository. */
  readonly worktreeRoot?: string
  /**
   * Where a client keeps its threads, one folder each holding `transcript/<id>.jsonl`. Turns on
   * `conversation.peek`, which reads them without touching them.
   */
  readonly threadsDir?: string
  /** Where the Web Push key for phone access is kept. Defaults to `~/.runrail/push`. */
  readonly pushDir?: string
  /** How `push.send` posts; tests pass a stand-in. */
  readonly pushFetch?: typeof fetch
  /** How `usage.read` asks each tool. Defaults to starting the installed tool; tests pass stand-ins. */
  readonly usageReaders?: Partial<Readonly<Record<UsageTool, ToolUsageRead>>>
  /** Where other harnesses keep their local sessions. Defaults to their standard home directories. */
  readonly externalSessionRoots?: ExternalSessionRoots
  /** Which commands `harness.status` asks about installed coding tools. Defaults to the tools' own names on PATH. */
  readonly harnessProbe?: HarnessProbeOptions
  /** The tool connection the starting backend runs as, as `backend.switch { connectionId }` would set it. */
  readonly toolConnection?: RunrailToolConnectionRoute
  /**
   * Lets the agent use the browser preview the desktop shows for this thread. Off unless set.
   * `mcpCommand` starts this program again as `browser-mcp`, the route Claude Code takes.
   */
  readonly browserTools?: { readonly anySite?: boolean; readonly mcpCommand?: readonly string[] }
  /**
   * Lets the agent list, read and message the person's other threads through the desktop.
   * Off unless set. `mcpCommand` starts this program again as `threads-mcp`, for Claude Code.
   */
  readonly threadTools?: { readonly mcpCommand?: readonly string[] }
  /**
   * Lets the agent see and use apps on the person's Mac that they allowed, through the desktop.
   * Off unless set. `mcpCommand` starts this program again as `computer-mcp`, for Claude Code.
   */
  readonly computerTools?: { readonly mcpCommand?: readonly string[] }
  /**
   * Lets the agent make pictures with the image model the person chose from their connections.
   * Off unless set. `mcpCommand` starts this program again as `images-mcp`, for Claude Code.
   */
  readonly imageTools?: { readonly mcpCommand?: readonly string[] }
  /** The `gh` program used for a host the person connected with `codehost.connect`. Defaults to `gh` on PATH; `false` turns it off. */
  readonly githubCli?: string | false
  /** Which built-in connectors are on, as `~/.runrail/connectors.json`. Without it the engine builds no connectors. */
  readonly connectorsFile?: string
  /** `mcpCommand` starts this program again as `connectors-mcp`, the route Claude Code takes to the connectors. */
  readonly connectorTools?: { readonly mcpCommand?: readonly string[] }
}
export interface RunrailControlRpcServerHandle {
  readonly controller: RunrailSessionController
  readonly contract: RunrailControlContract
  readonly handle: {
    readonly url: string
    readonly token: string
    stop(): Promise<void>
  }
}

interface ControlServices {
  readonly git: GitWorkspace
  readonly folders: RelatedFolders
  readonly worktrees: ThreadWorktrees
  readonly checks: CheckRuns
  readonly setups: SetupStore
  readonly setupRuns: SetupRuns
  readonly suites: SuiteStore
  readonly evalRuns: EvalRuns
  /** Opened on the first `memory.*` call: an engine that never uses memory never opens its file. */
  readonly memory: { readonly open: () => MemoryService; service?: MemoryService }
  readonly workflows: WorkflowStore
  readonly workflowRuns: WorkflowRuns
  /** Open pull requests in a project's repository, for the PR triggers `workflow.due` checks. */
  readonly pullRequestsFor: (root: string, trigger: "pr-review-requested" | "pr-opened") => Promise<readonly PullRequestRef[]>
  readonly live: LiveFrameHub
  readonly conversation: ConversationBuilder
  readonly external: { readonly roots: ExternalSessionRoots; importing: boolean }
  readonly connections: { readonly metadata: ModelMetadataSource; readonly environment: Readonly<Record<string, string | undefined>>; readonly home: string }
  /** The last look at the installed coding tools, kept briefly: each look runs those tools. */
  readonly harnesses: { readonly probe: HarnessProbeOptions; cached?: { readonly at: number; readonly value: Promise<readonly HarnessStatus[]> } }
  /** Closers of the open event streams. A stream never ends by itself, so a stopping server ends them. */
  readonly streams: Set<() => void>
  /** The last look for listening servers, kept briefly: each look runs `ps` and `lsof`. */
  readonly servers: { cached?: { readonly at: number; readonly value: Promise<ServerScan> } }
  readonly browser?: BrowserBridge
  readonly threads?: ThreadsBridge
  readonly computer?: ComputerBridge
  readonly images?: { readonly service: ImageService; readonly endpointToken: string }
  /** The built-in connectors the person turned on, and where that is kept. */
  readonly connectors: { readonly setup?: ConnectorSetupStore; readonly registry?: ConnectorRegistry; readonly endpointToken: string }
  /** Coding-tool sign-ins running in a terminal the person sees. */
  readonly logins: ToolLogins
  readonly githubCli?: string
  /** `codehosts.json` in the accounts folder, so every engine sharing that folder sees one answer per host. */
  readonly codeHosts: CodeHostStore
  readonly threadsDir?: string
  readonly usage: { readonly reader: UsageReader; readonly cwd: string }
  /** Made on the first `push.*` call: an engine that never pushes never makes a key. */
  readonly push: { readonly dir: string; readonly fetch?: typeof fetch; vapid?: Promise<Vapid> }
}

const MAX_TURN_LIVE_FRAMES = 1_024
/** Recent `turn.enqueue` and `turn.steer` keys per session, oldest dropped first. */
const MAX_TURN_KEYS = 256
const turnAnswers = new WeakMap<RunrailSessionController, Map<string, Promise<unknown>>>()
const HARNESS_STATUS_TTL_MS = 10_000
const MAX_LOGIN_READ_BYTES = 64 * 1024
const MAX_LOGIN_INPUT_BYTES = 8 * 1024
const SERVER_SCAN_TTL_MS = 2_000
const BACKGROUND_STOP_TIMEOUT_MS = 10_000
const BACKGROUND_OUTPUT_DEFAULT = 64 * 1024
const BACKGROUND_OUTPUT_MAX = 256 * 1024
const MAX_CONVERSATION_ITEMS = 4_096
const LIVE_CONVERSATION_ITEMS = 2_048
const LIVE_CONVERSATION_TEXT_BYTES = 32 * 1024

class ControlRpcError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    reason: string,
  ) {
    super(reason)
    this.name = "ControlRpcError"
  }
}

/** Authenticated loopback control plane for queued turns, model switching, sessions, and plugins. */
export async function startRunrailControlRpcServer(
  options: RunrailControlRpcServerOptions,
): Promise<RunrailControlRpcServerHandle> {
  const hostname = options.hostname ?? "127.0.0.1"
  const allowRemote = options.allowRemote === true
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576
  validateServerOptions(hostname, allowRemote, options.port, maxBodyBytes, options.authToken)
  if (allowRemote && (options.tls === undefined || typeof options.tls.cert !== "string" || typeof options.tls.key !== "string"))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "remote binding requires TLS")
  if (options.terminalBridge !== undefined) {
    try {
      validateRunrailTerminalBridge(options.terminalBridge)
    } catch {
      throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "terminal bridge is invalid")
    }
  }
  const unavailableTerminalCapabilities = validateUnavailableTerminalCapabilities(options.unavailableTerminalCapabilities)
  const token = options.authToken ?? randomBytes(32).toString("hex")
  const live = new LiveFrameHub()
  const callerLive = options.onLive
  const sinkLive = (frame: RunrailLiveFrameInput): void => {
    live.sink(frame)
    if (callerLive === undefined) return
    try { callerLive(frame) } catch { /* Caller sinks are best-effort. */ }
  }
  const browserTools = parseBrowserTools(options.browserTools)
  const browserBridge = browserTools === undefined ? options.browser?.bridge : new BrowserBridge({ anySite: browserTools.anySite })
  const browserEndpoint = browserTools?.mcpCommand === undefined ? undefined : await createBrowserEndpoint(browserTools.mcpCommand)
  browserBridge?.bind(sinkLive)
  const threadTools = parseThreadTools(options.threadTools)
  const threadsBridge = threadTools === undefined ? options.threads?.bridge : new ThreadsBridge()
  const threadsEndpoint = threadTools?.mcpCommand === undefined ? undefined : await createThreadsEndpoint(threadTools.mcpCommand)
  threadsBridge?.bind(sinkLive)
  const computerTools = parseComputerTools(options.computerTools)
  const computerBridge = computerTools === undefined ? options.computer?.bridge : new ComputerBridge()
  const computerEndpoint = computerTools?.mcpCommand === undefined ? undefined : await createComputerEndpoint(computerTools.mcpCommand)
  computerBridge?.bind(sinkLive)
  const imageTools = parseImageTools(options.imageTools)
  const imageService = imageTools === undefined ? undefined : new ImageService()
  const imagesToken = randomBytes(32).toString("hex")
  const imagesEndpoint = imageTools?.mcpCommand === undefined ? undefined : await createImagesEndpoint(imageTools.mcpCommand)
  const connectorSetup = options.connectorsFile === undefined ? undefined : new ConnectorSetupStore(options.connectorsFile)
  const githubCommand = options.githubCli === false ? undefined : (options.githubCli ?? "gh")
  // The vault opens with the native runtime below; a key is read only when a call is made.
  const secretVault: { vault?: CredentialVault } = {}
  const builtConnectors = options.connectorRegistry === undefined && connectorSetup !== undefined ? buildConnectorRegistry(await connectorSetup.read(), { resolve: (kind) => connectorSecret(kind, secretVault.vault, githubCommand) }) : undefined
  const connectorsToken = randomBytes(32).toString("hex")
  const connectorsEndpoint = builtConnectors !== undefined && builtConnectors.list().length > 0 && options.connectorTools?.mcpCommand !== undefined ? await createConnectorsEndpoint(options.connectorTools.mcpCommand) : undefined
  let controller: RunrailSessionController
  try {
    controller = await timed("session", () => RunrailSessionController.create({
      ...options,
      onLive: sinkLive,
      ...(options.pluginManager === undefined ? {} : { pluginHost: options.pluginManager.host }),
      ...(browserTools === undefined ? {} : { browser: { bridge: browserBridge as BrowserBridge, ...(browserEndpoint === undefined ? {} : { mcpConfig: browserEndpoint.mcpConfig }) } }),
      ...(threadTools === undefined ? {} : { threads: { bridge: threadsBridge as ThreadsBridge, ...(threadsEndpoint === undefined ? {} : { mcpConfig: threadsEndpoint.mcpConfig }) } }),
      ...(computerTools === undefined ? {} : { computer: { bridge: computerBridge as ComputerBridge, ...(computerEndpoint === undefined ? {} : { mcpConfig: computerEndpoint.mcpConfig }) } }),
      ...(imageService === undefined ? {} : { images: { service: imageService, ...(imagesEndpoint === undefined ? {} : { mcpConfig: imagesEndpoint.mcpConfig }) } }),
      ...(builtConnectors === undefined ? {} : { connectors: { registry: builtConnectors, ...(connectorsEndpoint === undefined ? {} : { mcpConfig: connectorsEndpoint.mcpConfig }) } }),
    }, options.toolConnection))
  } catch (error) {
    browserBridge?.close()
    await browserEndpoint?.remove()
    threadsBridge?.close()
    await threadsEndpoint?.remove()
    computerBridge?.close()
    await computerEndpoint?.remove()
    await imagesEndpoint?.remove()
    await connectorsEndpoint?.remove()
    throw error
  }
  live.bind(controller.session.snapshot.id)
  // The live conversation view spans backend and provider switches for this process only.
  const conversation = new ConversationBuilder({ maxItems: LIVE_CONVERSATION_ITEMS, maxTextBytes: LIVE_CONVERSATION_TEXT_BYTES, root: controller.session.policy.root })
  controller.subscribe((event) => {
    live.observe(event)
    conversation.add({ kind: "event", seq: event.seq, at: event.at, event })
  })
  // The conversation reads a coding tool's reviews and retries as it reads them back from a transcript, and Runrail's refusals with them.
  live.subscribe((frame) => {
    if (frame.type === APPROVAL_REVIEWED || frame.type === REVIEWER_NOTICE || frame.type === "api.retry" || frame.type === "request.refused") conversation.add({ kind: "event", seq: frame.afterSeq, at: frame.at, event: frame as unknown as import("@nifrajs/agent-protocol").AgentEvent })
  })
  const nativeRuntime = createNativeControlRuntime({
    stateRoot: resolve(options.nativeStateDir ?? join(options.sessionDir ?? join(controller.session.policy.root, ".runrail"), "native")),
    workspaceRoot: controller.session.policy.root,
    projectId: options.nativeProjectId ?? `project-${createHash("sha256").update(controller.session.policy.root).digest("hex").slice(0, 24)}`,
    ownerId: options.nativeOwnerId ?? "local-owner",
    ...(options.nativeAccountStore === undefined ? {} : { accountStore: options.nativeAccountStore }),
    ...(options.nativeCredentialBroker === undefined ? {} : { credentialBroker: options.nativeCredentialBroker }),
    ...(options.nativeAccountsDir === undefined ? {} : { accountsRoot: resolve(options.nativeAccountsDir) }),
    ...(options.nativeCredentialVault === undefined ? {} : { credentialVault: options.nativeCredentialVault }),
    ...(options.nativeCredentialRefreshers === undefined ? {} : { credentialRefreshers: options.nativeCredentialRefreshers }),
    ...(options.nativeSignInFlows === undefined ? {} : { signInFlows: options.nativeSignInFlows }),
    ...(options.nativeShareStore === undefined ? {} : { shareStore: options.nativeShareStore }),
    ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }),
    ...(options.maxEventsPerTask === undefined ? {} : { maxEventsPerTask: options.maxEventsPerTask }),
  })
  secretVault.vault = nativeRuntime.vaultBroker?.vault
  imageService?.bind({
    choice: async () => {
      const image = (await nativeRuntime.connections.list()).image
      return image === undefined || !image.usable ? undefined : { connectionId: image.connectionId, model: image.model, route: image.route }
    },
    connection: async (connectionId) => {
      const connection = connectionFor(await requireAccount(nativeRuntime, connectionId), nativeRuntime.credentialResolver)
      return { name: connection.name, options: connection.options }
    },
    workspace: () => controller.session.policy,
  })
  const workspaceRoot = controller.session.policy.root
  const codeHosts = new CodeHostStore(join(nativeRuntime.accountsRoot, "codehosts.json"))
  const worktrees = new ThreadWorktrees({ root: workspaceRoot, baseDir: resolve(options.worktreeRoot ?? join(homedir(), ".runrail", "worktrees")) })
  const checks = new CheckRuns()
  const setupRuns = new SetupRuns({
    check: async (input) => {
      if (input.cwd !== undefined) return checks.run({ id: input.id, cwd: input.cwd, command: input.command, timeoutMs: CHECK_DEFAULT_TIMEOUT_MS })
      if (input.worktree === undefined) return checks.run({ id: input.id, cwd: workspaceRoot, command: input.command, timeoutMs: CHECK_DEFAULT_TIMEOUT_MS })
      const target = (await worktrees.list()).find((entry) => entry.id === input.worktree)
      if (target === undefined) throw new ControlRpcError("CONTROL_CHECK_NOT_A_WORKTREE", 404, "no worktree of this project has that id")
      return checks.run({ id: input.id, cwd: target.cwd, command: input.command, timeoutMs: CHECK_DEFAULT_TIMEOUT_MS })
    },
    stopCheck: (id) => checks.stop(id),
  })
  const setups = new SetupStore({ user: resolve(options.setupsPath ?? join(homedir(), ".runrail", "setups.json")), project: join(workspaceRoot, ".runrail", "setups.json") })
  const workflows = new WorkflowStore(resolve(options.workflowsPath ?? join(homedir(), ".runrail", "workflows.json")))
  const git = new GitWorkspace({ root: workspaceRoot, hints: () => codeHosts.hints() })
  const folders = relatedFolders(options.folders ?? [], controller.session.policy.folders, () => codeHosts.hints())
  const gh = githubCliOption(options.githubCli).githubCli
  // The commit each workflow worktree started at: a run that changed nothing opens no pull request.
  const workflowStarts = new Map<string, string>()
  const services: ControlServices = {
    git,
    folders,
    worktrees,
    checks,
    setups,
    setupRuns,
    suites: new SuiteStore(workspaceRoot),
    evalRuns: new EvalRuns({
      root: workspaceRoot,
      dir: join(resolve(options.evalsDir ?? join(homedir(), ".runrail", "evals")), createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16)),
      setupRuns,
      check: (input) => checks.run({ ...input, timeoutMs: CHECK_DEFAULT_TIMEOUT_MS }),
      stopCheck: (id) => checks.stop(id),
    }),
    workflows,
    workflowRuns: new WorkflowRuns({
      root: workspaceRoot,
      store: workflows,
      project: projectKey(workspaceRoot),
      setups: { get: (id) => setups.runnable(id) },
      setupRuns,
      createWorktree: async ({ id, pr }) => {
        const revision = pr === undefined ? undefined : (await git.fetch({ pullRequest: pr })).revision
        const created = await worktrees.create({ id, branch: `runrail/${id}`, ...(revision === undefined ? {} : { revision }) })
        if (created.head !== undefined) workflowStarts.set(created.id, created.head)
        await linkDependencies(workspaceRoot, created.cwd)
        return { id: created.id, path: created.path, cwd: created.cwd, ...(created.branch === undefined ? {} : { branch: created.branch }) }
      },
      check: (input) => checks.run(input),
      stopCheck: (id) => checks.stop(id),
      releaseWorktree: async (worktree, { pushed }) => {
        const start = workflowStarts.get(worktree.id)
        workflowStarts.delete(worktree.id)
        if (!pushed) {
          const tree = new GitWorkspace({ root: worktree.cwd, hints: () => codeHosts.hints() })
          const [last] = await tree.log({ limit: 1, skip: 0 })
          const status = await tree.status(1)
          // Work nobody has seen yet stays where the run's threads show it.
          if (status.entries.length > 0 || last?.commit !== start) return
        }
        await worktrees.remove(worktree.id, true, !pushed)
      },
      openPullRequest: async (input) => {
        const tree = new GitWorkspace({ root: input.worktree.cwd, hints: () => codeHosts.hints() })
        try {
          await tree.commit({ message: input.title, paths: ["."], runHooks: false })
        } catch (error) {
          if (!(error instanceof GitError) || error.code !== "GIT_NOTHING_TO_COMMIT") throw error
        }
        const [last] = await tree.log({ limit: 1, skip: 0 })
        if (last === undefined || last.commit === workflowStarts.get(input.worktree.id)) return undefined
        const preview = await tree.pushPreview({})
        await tree.push({ confirmation: preview.confirmation, runHooks: false })
        const base = (await git.status(1)).branch
        const opened = (await createPullRequest({ ...services, git: tree }, options.connectorRegistry, input.worktree.cwd, { confirm: true, title: input.title, body: input.body, draft: input.draft, ...(base === undefined ? {} : { base }) })) as { readonly number: number; readonly url?: string }
        return { number: opened.number, ...(opened.url === undefined ? {} : { url: opened.url }) }
      },
      ...((options.connectorRegistry ?? builtConnectors)?.get("slack") === undefined
        ? {}
        : {
            postSlack: async ({ channel, text }: { readonly channel: string; readonly text: string }) => {
              await (options.connectorRegistry ?? builtConnectors)?.invoke("slack", "sendMessage", { channel, text }, { cwd: workspaceRoot, signal: AbortSignal.timeout(30_000), allowedCapabilities: ["connector.notify", "connector.write"], approve: () => true, maxOutputBytes: 64 * 1024 })
            },
          }),
    }),
    pullRequestsFor: async (root, trigger) => {
      if (gh === undefined) throw new WorkflowError("WORKFLOW_INVALID", "the GitHub CLI is not available")
      return await watchedPullRequests(gh, root, trigger)
    },
    memory: {
      open(): MemoryService {
        this.service ??= new MemoryService({
          dir: resolve(options.memoryDir ?? join(homedir(), ".runrail", "memory")),
          root: workspaceRoot,
          ...(gh === undefined ? {} : { gh: async (args: readonly string[]) => (await runGitHubCli({ command: gh, cwd: workspaceRoot }, args, { maxOutput: 8 * 1024 * 1024 })).text }),
        })
        return this.service
      },
    },
    live,
    conversation,
    external: { roots: options.externalSessionRoots ?? defaultExternalSessionRoots(), importing: false },
    connections: { metadata: options.modelMetadata ?? createModelMetadataSource(), environment: options.connectionEnvironment ?? process.env, home: options.connectionImportHome ?? homedir() },
    harnesses: { probe: options.harnessProbe ?? {} },
    streams: new Set(),
    servers: {},
    logins: createToolLogins(),
    ...(browserBridge === undefined ? {} : { browser: browserBridge }),
    ...(threadsBridge === undefined ? {} : { threads: threadsBridge }),
    ...(computerBridge === undefined ? {} : { computer: computerBridge }),
    ...(imageService === undefined ? {} : { images: { service: imageService, endpointToken: imagesToken } }),
    connectors: { ...(connectorSetup === undefined ? {} : { setup: connectorSetup }), ...(builtConnectors === undefined ? {} : { registry: builtConnectors }), endpointToken: connectorsToken },
    ...githubCliOption(options.githubCli),
    codeHosts,
    ...(options.threadsDir === undefined ? {} : { threadsDir: resolve(options.threadsDir) }),
    usage: {
      reader: new UsageReader({ "claude-code": options.usageReaders?.["claude-code"] ?? claudeUsageReader(), codex: options.usageReaders?.codex ?? codexUsageReader() }),
      cwd: join(options.sessionDir ?? join(workspaceRoot, ".runrail"), "usage"),
    },
    push: { dir: resolve(options.pushDir ?? join(homedir(), ".runrail", "push")), ...(options.pushFetch === undefined ? {} : { fetch: options.pushFetch }) },
  }
  const gitStatus = (await timed("git-available", () => services.git.available())) ? "available" : "unavailable"
  const contract = createRunrailControlContract({
    sessionId: controller.session.snapshot.id,
    projectId: nativeRuntime.projectId,
    maxRequestBytes: maxBodyBytes,
    maxTaskEvents: options.maxEventsPerTask,
    capabilityStatus: {
      "session.transcript": controller.session.transcriptStore === undefined ? "configurable" : "available",
      plugins: options.pluginManager === undefined ? "configurable" : "available",
      connectors: (options.connectorRegistry ?? builtConnectors) === undefined ? "configurable" : "available",
      agents: options.agentCoordinator === undefined ? "configurable" : "available",
      "account.secrets": nativeRuntime.vaultBroker === undefined ? "configurable" : "available",
      "auth.signin": nativeRuntime.signIn === undefined || nativeRuntime.signInFlows.length === 0 ? "configurable" : "available",
      "terminal.describe": options.terminalBridge === undefined ? "configurable" : "available",
      "terminal.create": terminalCapabilityStatus(options.terminalBridge, "create"),
      "terminal.write": terminalCapabilityStatus(options.terminalBridge, "write"),
      "terminal.read": terminalCapabilityStatus(options.terminalBridge, "read"),
      "terminal.resize": terminalCapabilityStatus(options.terminalBridge, "resize"),
      "terminal.close": terminalCapabilityStatus(options.terminalBridge, "close"),
      ...unavailableTerminalCapabilityStatus(unavailableTerminalCapabilities),
      "git.read": gitStatus,
      "git.write": gitStatus,
      "git.remote": gitStatus,
      // Whether GitHub is connected is answered per call, by CONTROL_PR_NOT_CONNECTED.
      "git.pr": gitStatus,
      "git.branches": gitStatus,
      "git.fetch": gitStatus,
      "git.pr.list": gitStatus,
      // The inbox needs gh; whether the host is connected is answered per call.
      "git.pr.reviews": services.githubCli === undefined ? "unavailable" : "available",
      "git.pr.review.post": services.githubCli === undefined ? "unavailable" : "available",
      "git.pr.merge": services.githubCli === undefined ? "unavailable" : "available",
      "git.pr.checks": services.githubCli === undefined ? "unavailable" : "available",
      "git.pull": gitStatus,
      "git.diff.stats": gitStatus,
      codehosts: "available",
      "codehost.remotes": "available",
      worktrees: gitStatus,
      checks: gitStatus,
      setups: gitStatus,
      evals: gitStatus,
      memory: "available",
      workflows: "available",
      "live.frames": "available",
      "session.conversation": "available",
      "conversation.peek": options.threadsDir === undefined ? "configurable" : "available",
      "usage.read": "available",
      "session.external": controller.session.transcriptStore === undefined ? "configurable" : "available",
      "task.rename": "available",
      "harness.status": "available",
      "claude.sdk": "available",
      nifra: "available",
      background: "available",
      browser: browserBridge === undefined ? "configurable" : "available",
      "threads.tools": threadsBridge === undefined ? "configurable" : "available",
      "computer.tools": computerBridge === undefined ? "configurable" : "available",
      "image.tools": imageService === undefined ? "configurable" : "available",
      "connection.login": process.platform === "win32" ? "unavailable" : "available",
      "session.compact": controller.session.canCompact ? "available" : "unavailable",
      "turn.steer.live": controller.session.canSteerLive ? "available" : "unavailable",
      checkpoints: controller.session.checkpoints === undefined ? "configurable" : "available",
      "session.rewind": controller.session.checkpoints === undefined || controller.session.transcriptStore?.truncate === undefined ? "configurable" : "available",
      "thread.copy": options.threadsDir === undefined ? "configurable" : "available",
      push: "available",
    },
  })
  let listener: ReturnType<typeof Bun.serve> | undefined
  let stopped = false
  try {
    listener = Bun.serve({
      hostname,
      port: options.port ?? 0,
      ...(options.tls === undefined ? {} : { tls: { cert: options.tls.cert, key: options.tls.key } }),
      fetch: (request, server) => {
        const refused = refusedPlace(request, allowRemote)
        if (refused !== undefined) return jsonResponse({ ok: false, error: refused }, 403)
        // The listener drops a connection that stays silent for 10 seconds. A turn, a push or a quiet event
        // stream is silent for longer, and each call bounds its own work, so an authorized request is exempt.
        const header = request.headers.get("authorization")
        if (authorized(header, token) || (browserBridge !== undefined && authorized(header, browserBridge.endpointToken)) || (threadsBridge !== undefined && authorized(header, threadsBridge.endpointToken)) || (computerBridge !== undefined && authorized(header, computerBridge.endpointToken)) || (imageService !== undefined && authorized(header, imagesToken)) || (connectorsEndpoint !== undefined && authorized(header, connectorsToken))) server.timeout(request, 0)
        return handleRequest(request, token, maxBodyBytes, controller, nativeRuntime, contract, options.pluginManager, options.connectorRegistry, options.agentCoordinator, options.terminalBridge, unavailableTerminalCapabilities, services)
      },
    })
  } catch (error) {
    browserBridge?.close()
    await browserEndpoint?.remove()
    threadsBridge?.close()
    await threadsEndpoint?.remove()
    computerBridge?.close()
    await computerEndpoint?.remove()
    await imagesEndpoint?.remove()
    await connectorsEndpoint?.remove()
    await controller.close("control server failed")
    throw new ControlRpcError(
      "CONTROL_SERVER_START_FAILED",
      500,
      error instanceof Error ? error.message : "control server failed to start",
    )
  }
  const server = listener
  const url = server.url.toString().replace(/\/$/, "")
  if (browserEndpoint !== undefined && browserBridge !== undefined) {
    try {
      await browserEndpoint.publish(url, browserBridge.endpointToken)
    } catch {
      // Without the file Claude Code's browser tools answer that the browser is unreachable; nothing else changes.
    }
  }
  if (threadsEndpoint !== undefined && threadsBridge !== undefined) {
    try {
      await threadsEndpoint.publish(url, threadsBridge.endpointToken)
    } catch {
      // Without the file Claude Code's thread tools answer that the other threads are unreachable.
    }
  }
  if (computerEndpoint !== undefined && computerBridge !== undefined) {
    try {
      await computerEndpoint.publish(url, computerBridge.endpointToken)
    } catch {
      // Without the file Claude Code's computer tools answer that the computer is unreachable.
    }
  }
  if (imagesEndpoint !== undefined) {
    try {
      await imagesEndpoint.publish(url, imagesToken)
    } catch {
      // Without the file Claude Code's image tool answers that the engine is unreachable.
    }
  }
  if (connectorsEndpoint !== undefined) {
    try {
      await connectorsEndpoint.publish(url, connectorsToken)
    } catch {
      // Without the file Claude Code lists no connector tools; nothing else changes.
    }
  }
  return {
    controller,
    contract,
    handle: {
      url,
      token,
      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        for (const close of [...services.streams]) close()
        browserBridge?.close()
        await browserEndpoint?.remove().catch(() => undefined)
        threadsBridge?.close()
        await threadsEndpoint?.remove().catch(() => undefined)
        computerBridge?.close()
        await computerEndpoint?.remove().catch(() => undefined)
        await imagesEndpoint?.remove().catch(() => undefined)
        await connectorsEndpoint?.remove().catch(() => undefined)
        // A sign-in left waiting would keep its callback port open after the engine is gone.
        await nativeRuntime.signIn?.close()
        await services.logins.dispose()
        await services.workflowRuns.close()
        await services.evalRuns.close()
        await services.memory.service?.close()
        await services.setupRuns.close()
        await services.checks.close()
        // Stop listening first, then end the session: a call held open by a turn answers once the turn ends.
        const drained = server.stop()
        await controller.close("control server stopped")
        await drained
        await options.pluginManager?.close()
      },
    },
  }
}

async function handleRequest(
  request: Request,
  token: string,
  maxBodyBytes: number,
  controller: RunrailSessionController,
  nativeRuntime: NativeControlRuntime,
  contract: RunrailControlContract,
  pluginManager: PluginManager | undefined,
  connectorRegistry: ConnectorRegistry | undefined,
  agentCoordinator: MultiAgentCoordinator | undefined,
  terminalBridge: RunrailTerminalBridge | undefined,
  unavailableTerminalCapabilities: ReadonlySet<TerminalControlCapability>,
  services: ControlServices,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({
      ok: true,
      ...liveContract(contract, controller),
    })
  }
  if (url.pathname === "/events" && request.method === "GET") {
    if (!authorized(request.headers.get("authorization"), token))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      const afterSeq = parseQueryBound(url.searchParams.get("afterSeq"), -1, 4_000_000, "afterSeq") ?? -1
      const maxEvents = parseQueryBound(url.searchParams.get("maxEvents"), 1, RUNRAIL_CONTROL_MAX_REPLAY_EVENTS, "maxEvents") ?? 512
      const afterLiveSeq = parseQueryBound(url.searchParams.get("afterLiveSeq"), 0, Number.MAX_SAFE_INTEGER, "afterLiveSeq") ?? (afterSeq === -1 ? 0 : services.live.lastLiveSeq)
      return createEventStreamResponse(request, controller, afterSeq, maxEvents, services.live, afterLiveSeq, services.streams)
    } catch (error) {
      const status = errorStatus(error)
      const code = error instanceof RunrailControlError ? error.code : undefined
      return jsonResponse(
        { ok: false, error: publicError(error) },
        status,
        code === undefined ? {} : { "x-runrail-error-code": code },
      )
    }
  }
  if (url.pathname === "/secret") {
    // A secret never travels through `/rpc`, whose params may be journaled, replayed or echoed in errors.
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
    if (!authorized(request.headers.get("authorization"), token))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      return jsonResponse({ ok: true, result: await storeSecret(request, nativeRuntime) })
    } catch (error) {
      const publicValue = publicError(error)
      return jsonResponse({ ok: false, error: publicValue }, errorStatus(error), { "x-runrail-error-code": publicValue.code })
    }
  }
  if (url.pathname === "/login-input") {
    // The address a user pastes carries a one-time sign-in code, so it stays off `/rpc` for the same reason a key does.
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
    if (!authorized(request.headers.get("authorization"), token))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      return jsonResponse({ ok: true, result: await submitSignInInput(request, nativeRuntime) })
    } catch (error) {
      const publicValue = publicError(error)
      return jsonResponse({ ok: false, error: publicValue }, errorStatus(error), { "x-runrail-error-code": publicValue.code })
    }
  }
  if (url.pathname === "/browser") {
    // Claude Code's browser tools call here with their own token, which opens this route and no other.
    const bridge = services.browser
    if (bridge === undefined) return jsonResponse({ ok: false, error: "CONTROL_NOT_FOUND" }, 404)
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
    if (!authorized(request.headers.get("authorization"), bridge.endpointToken))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      const call = await readBrowserCall(request)
      const result = await bridge.request(call.action, call.input, request.signal)
      return jsonResponse({ ok: true, result })
    } catch (error) {
      const publicValue = browserPublicError(error)
      return jsonResponse({ ok: false, error: publicValue }, errorStatus(browserRpcError(error)), { "x-runrail-error-code": publicValue.code })
    }
  }
  if (url.pathname === "/threads") {
    // Claude Code's thread tools call here with their own token, which opens this route and no other.
    const bridge = services.threads
    if (bridge === undefined) return jsonResponse({ ok: false, error: "CONTROL_NOT_FOUND" }, 404)
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
    if (!authorized(request.headers.get("authorization"), bridge.endpointToken))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      const call = await readThreadsCall(request)
      const result = await bridge.request(call.action, call.input, request.signal)
      return jsonResponse({ ok: true, result })
    } catch (error) {
      const publicValue = publicError(threadsRpcError(error))
      return jsonResponse({ ok: false, error: publicValue }, errorStatus(threadsRpcError(error)), { "x-runrail-error-code": publicValue.code })
    }
  }
  if (url.pathname === "/computer") {
    // Claude Code's computer tools call here with their own token, which opens this route and no other.
    const bridge = services.computer
    if (bridge === undefined) return jsonResponse({ ok: false, error: "CONTROL_NOT_FOUND" }, 404)
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
    if (!authorized(request.headers.get("authorization"), bridge.endpointToken))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      const call = await readComputerCall(request)
      const result = await bridge.request(call.action, call.input, request.signal)
      return jsonResponse({ ok: true, result })
    } catch (error) {
      const publicValue = publicError(computerRpcError(error))
      return jsonResponse({ ok: false, error: publicValue }, errorStatus(computerRpcError(error)), { "x-runrail-error-code": publicValue.code })
    }
  }
  if (url.pathname === "/images") {
    // Claude Code's image tool calls here with its own token, which opens this route and no other.
    const images = services.images
    if (images === undefined) return jsonResponse({ ok: false, error: "CONTROL_NOT_FOUND" }, 404)
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
    if (!authorized(request.headers.get("authorization"), images.endpointToken))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      const body = await readBoundedBody(request, IMAGE_CALL_MAX_BYTES)
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown
      } catch {
        throw new ImageError("IMAGE_INVALID_INPUT", "the call is not valid JSON")
      }
      const result = await images.service.request(isRecord(value) ? value.input : undefined, request.signal)
      return jsonResponse({ ok: true, result })
    } catch (error) {
      const publicValue = publicError(imageRpcError(error))
      return jsonResponse({ ok: false, error: publicValue }, errorStatus(imageRpcError(error)), { "x-runrail-error-code": publicValue.code })
    }
  }
  if (url.pathname === "/connectors") {
    // Claude Code's connector tools call here with their own token, which opens this route and no other.
    const registry = controller.session.connectorRegistry
    if (registry === undefined || services.connectors.registry === undefined) return jsonResponse({ ok: false, error: "CONTROL_NOT_FOUND" }, 404)
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
    if (!authorized(request.headers.get("authorization"), services.connectors.endpointToken))
      return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
    try {
      return jsonResponse({ ok: true, result: await answerConnectorCall(request, controller.session, registry) })
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "the connector could not do that"
      return jsonResponse({ ok: false, error: { code: error instanceof ConnectorError ? error.code : "CONNECTOR_FAILED", message } }, 200)
    }
  }
  if (url.pathname !== "/rpc") return jsonResponse({ ok: false, error: "CONTROL_NOT_FOUND" }, 404)
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "CONTROL_METHOD_NOT_ALLOWED" }, 405)
  if (!authorized(request.headers.get("authorization"), token))
    return jsonResponse({ ok: false, error: "CONTROL_UNAUTHORIZED" }, 401)
  try {
    const rpc = await readRpcRequest(request, maxBodyBytes)
    const result = await dispatch(rpc.method, rpc.params, controller, nativeRuntime, contract, pluginManager, connectorRegistry, agentCoordinator, terminalBridge, unavailableTerminalCapabilities, services)
    return jsonResponse({ ok: true, result })
  } catch (error) {
    const publicValue = publicError(error)
    return jsonResponse({ ok: false, error: publicValue }, errorStatus(error), { "x-runrail-error-code": publicValue.code })
  }
}

const MAX_UNREAD_STREAM_BYTES = 32 * 1024 * 1024

function createEventStreamResponse(
  request: Request,
  controller: RunrailSessionController,
  afterSeq: number,
  maxEvents: number,
  live: LiveFrameHub,
  afterLiveSeq: number,
  streams: Set<() => void>,
): Response {
  const encoder = new TextEncoder()
  const initial = controller.eventsSince(afterSeq, maxEvents)
  const initialLive = replayLiveFrames(live, afterLiveSeq, maxEvents)
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closed = false
  let replaying = true
  const pending: import("@nifrajs/agent-protocol").AgentEvent[] = []
  const pendingLive: RunrailLiveFrame[] = []
  let unsubscribeLive: (() => void) | undefined
  let closeStream: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const close = (): void => {
        if (closed) return
        closed = true
        streams.delete(close)
        if (heartbeat !== undefined) clearInterval(heartbeat)
        unsubscribe?.()
        unsubscribeLive?.()
        streamController.close()
      }
      closeStream = close
      streams.add(close)
      const send = (event: unknown, name = "runrail.event"): void => {
        if (closed) return
        let payload: string
        try {
          payload = JSON.stringify(event)
        } catch {
          close()
          return
        }
        const id = typeof event !== "object" || event === null ? "0" : "liveSeq" in event ? `live-${String(event.liveSeq)}` : "seq" in event ? String(event.seq) : "0"
        let frame = `event: ${name}\nid: ${id}\ndata: ${payload}\n\n`
        const bytes = Buffer.byteLength(frame, "utf8")
        // Closing here would replay the same event on every reconnect, so it is named and skipped instead.
        if (bytes > RUNRAIL_CONTROL_MAX_EVENT_BYTES) {
          const type = typeof event === "object" && event !== null && "type" in event && typeof event.type === "string" ? event.type.slice(0, 128) : undefined
          frame = `event: runrail.omitted\nid: ${id}\ndata: ${JSON.stringify({ id, stream: name, ...(type === undefined ? {} : { type }), bytes })}\n\n`
        }
        // A client that stops reading is let go once it is far behind; it reconnects from its last event.
        if ((streamController.desiredSize ?? 0) < -MAX_UNREAD_STREAM_BYTES) {
          close()
          return
        }
        try {
          streamController.enqueue(encoder.encode(frame))
        } catch {
          close()
        }
      }
      unsubscribe = controller.subscribe((event) => {
        if (replaying) pending.push(event)
        else send(presentControlEvent(event, { root: controller.session.policy.root }))
      })
      unsubscribeLive = live.subscribe((frame) => {
        if (replaying) pendingLive.push(frame)
        else send(frame, "runrail.live")
      })
      // Headers leave with the first bytes, so a stream with nothing to replay still has to open at once.
      streamController.enqueue(encoder.encode(": open\n\n"))
      for (const event of initial) send(presentControlEvent(event, { root: controller.session.policy.root }))
      let lastLive = afterLiveSeq
      for (const frame of initialLive) {
        send(frame, "runrail.live")
        lastLive = frame.liveSeq
      }
      replaying = false
      for (const event of pending.splice(0)) send(presentControlEvent(event, { root: controller.session.policy.root }))
      for (const frame of pendingLive.splice(0)) if (frame.liveSeq > lastLive) send(frame, "runrail.live")
      heartbeat = setInterval(() => {
        if (closed) return
        try { streamController.enqueue(encoder.encode(": keep-alive\n\n")) } catch { close() }
      }, 15_000)
      request.signal.addEventListener("abort", close, { once: true })
    },
    cancel() { closeStream() },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }))
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-cache, no-store",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  })
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  controller: RunrailSessionController,
  nativeRuntime: NativeControlRuntime,
  contract: RunrailControlContract,
  pluginManager: PluginManager | undefined,
  connectorRegistry: ConnectorRegistry | undefined,
  agentCoordinator: MultiAgentCoordinator | undefined,
  terminalBridge: RunrailTerminalBridge | undefined,
  unavailableTerminalCapabilities: ReadonlySet<TerminalControlCapability>,
  services: ControlServices,
): Promise<unknown> {
  const disabledCapability = capabilityForMethod(method)
  if (disabledCapability !== undefined && unavailableTerminalCapabilities.has(disabledCapability))
    throw unavailableCapabilityError(disabledCapability)
  if (isControlGitMethod(method)) {
    const folder = services.folders.pick(params.folder)
    return dispatchControlGit(folder === undefined ? services.git : services.folders.git(folder), method, params)
  }
  if (isControlWorktreeMethod(method)) return dispatchControlWorktree(services.worktrees, method, params)
  if (CODE_HOST_METHODS.has(method)) return dispatchCodeHost(services, method, params, controller.session.policy.root)
  switch (method) {
    case "git.pr.create":
      return createPullRequest(services, connectorRegistry, controller.session.policy.root, params)
    case "git.pr.status":
      return pullRequestStatus(services, connectorRegistry, controller.session.policy.root, params)
    case "git.pr.list":
      return listPullRequests(services, connectorRegistry, controller.session.policy.root, params)
    case "git.pr.search":
    case "git.pr.teams":
    case "git.pr.view":
    case "git.pr.diff":
    case "git.pr.review.post":
    case "git.pr.merge":
    case "git.pr.checks.logs":
      return reviewInbox(services, method, params, controller.session.policy.root)
    case "check.run":
      return runCheck(services, params)
    case "check.stop":
      return { stopped: await services.checks.stop(checkId(params.id)) }
    case "setup.list":
    case "setup.save":
    case "setup.delete":
    case "setup.trust":
    case "setup.run.start":
    case "setup.run.status":
    case "setup.run.list":
    case "setup.run.answer":
    case "setup.run.stop":
      return setupRpc(services, method, params)
    case "eval.mine":
    case "eval.validate":
    case "eval.suites":
    case "eval.suite.get":
    case "eval.suite.save":
    case "eval.run":
    case "eval.status":
    case "eval.list":
    case "eval.stop":
      return evalRpc(services, controller.session.policy.root, method, params)
    case "workflow.list":
    case "workflow.get":
    case "workflow.save":
    case "workflow.propose":
    case "workflow.approve":
    case "workflow.enable":
    case "workflow.delete":
    case "workflow.due":
    case "workflow.upcoming":
    case "workflow.run.start":
    case "workflow.run.status":
    case "workflow.run.list":
    case "workflow.run.answer":
    case "workflow.run.stop":
      return workflowRpc(services, controller.session.policy.root, method, params)
    case "memory.status":
    case "memory.recall":
    case "memory.add":
    case "memory.update":
    case "memory.forget":
    case "memory.list":
    case "memory.settings.get":
    case "memory.settings.set":
    case "memory.source.list":
    case "memory.source.add":
    case "memory.source.remove":
    case "memory.source.sync":
      return memoryRpc(services.memory.open(), method, params)
    case "control.describe":
      return liveContract(contract, controller)
    case "task.list":
      return nativeRuntime.taskKernel.list(requireTaskProject(params.projectId, nativeRuntime.projectId))
    case "task.create": {
      const taskId = params.taskId === undefined ? `task-${randomUUID()}` : requireNativeId(params.taskId, "task id", 128)
      const projectId = requireTaskProject(params.projectId, nativeRuntime.projectId)
      const title = requireNativeText(params.title, "title", 256)
      const parentTaskId = params.parentTaskId === undefined ? undefined : requireNativeId(params.parentTaskId, "parent task id", 128)
      const task = await nativeRuntime.taskKernel.create({
        taskId,
        projectId,
        sessionId: controller.session.snapshot.id,
        title,
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
      })
      return task
    }
    case "task.snapshot": {
      const task = await nativeRuntime.taskKernel.snapshot(requireNativeId(params.taskId, "task id", 128))
      requireTaskScope(task, nativeRuntime, controller)
      return task
    }
    case "task.events": {
      const task = await nativeRuntime.taskKernel.snapshot(requireNativeId(params.taskId, "task id", 128))
      requireTaskScope(task, nativeRuntime, controller)
      return nativeRuntime.taskKernel.events(task.taskId, parseOptionalBound(params.afterSeq, -1, 2_000_000_000, "afterSeq"), parseOptionalBound(params.maxEvents, 1, 65_536, "maxEvents"))
    }
    case "task.enqueue":
    case "task.start":
    case "task.steer": {
      const task = await nativeTaskController(nativeRuntime, requireNativeId(params.taskId, "task id", 128), controller)
      const message = requireNativeText(params.message, "message", MAX_PROMPT_CHARS)
      const idempotencyKey = requireNativeId(params.idempotencyKey, "idempotencyKey", 256)
      const result = method === "task.enqueue"
        ? await task.enqueue(message, idempotencyKey)
        : method === "task.start"
          ? await task.start(message, idempotencyKey)
          : await task.steer(message, idempotencyKey)
      return { ...result, task: await task.snapshot() }
    }
    case "task.cancel": {
      const task = await nativeTaskController(nativeRuntime, requireNativeId(params.taskId, "task id", 128), controller)
      const idempotencyKey = requireNativeId(params.idempotencyKey, "idempotencyKey", 256)
      const command = createTaskCommand("task.cancel", task.task, idempotencyKey, {
        reason: optionalNativeText(params.reason, "reason", 256) ?? "cancelled",
        clearQueued: optionalBoolean(params.clearQueued) ?? false,
      })
      const result = await nativeRuntime.taskKernel.execute(command, async () => {
        const reason = optionalNativeText(params.reason, "reason", 256) ?? "cancelled"
        controller.cancel(reason, optionalBoolean(params.clearQueued) ?? false)
        await controller.whenIdle()
        return { status: "cancelled", events: [{ type: "task.cancelled", terminal: "cancelled", code: reason }] }
      })
      return { ...result, task: await task.snapshot() }
    }
    case "task.approve":
    case "task.reject": {
      const task = await nativeTaskController(nativeRuntime, requireNativeId(params.taskId, "task id", 128), controller)
      const approvalId = requireNativeId(params.approvalId, "approvalId", 256)
      const idempotencyKey = requireNativeId(params.idempotencyKey, "idempotencyKey", 256)
      const approved = method === "task.approve"
      const command = createTaskCommand(approved ? "task.approve" : "task.reject", task.task, idempotencyKey, {
        approvalId,
        approved,
      })
      const result = await nativeRuntime.taskKernel.execute(command, async () => {
        await controller.resolveApproval(approvalId, approved, optionalNativeText(params.reason, "reason", 256))
        return { events: [{ type: "approval.resolved", metadata: { approvalId, approved } }] }
      })
      return { ...result, task: await task.snapshot() }
    }
    case "task.rename": {
      const task = await nativeRuntime.taskKernel.snapshot(requireNativeId(params.taskId, "task id", 128))
      requireTaskScope(task, nativeRuntime, controller)
      return nativeRuntime.taskKernel.rename(task.taskId, requireNativeText(params.title, "title", 256))
    }
    case "task.remove": {
      const task = await nativeRuntime.taskKernel.snapshot(requireNativeId(params.taskId, "task id", 128))
      requireTaskScope(task, nativeRuntime, controller)
      if (task.status === "running" || task.status === "queued" || task.status === "waiting" || task.status === "paused") throw new ControlRpcError("CONTROL_SESSION_BUSY", 409, "task must be terminal before removal")
      await nativeRuntime.taskKernel.remove(task.taskId)
      nativeRuntime.taskControllers.delete(task.taskId)
      return { removed: true, taskId: task.taskId }
    }
    case "account.list": {
      const provider = params.provider === undefined ? undefined : requireNativeId(params.provider, "provider", 128)
      return (await nativeRuntime.accounts.list(provider)).map(redactAccount)
    }
    case "account.get":
    case "account.status":
    case "account.select":
      return redactAccount(await requireAccount(nativeRuntime, requireNativeId(params.accountId, "accountId", 256)))
    case "account.upsert":
    case "account.create": {
      rejectRawCredentialFields(params)
      const parsed = parseRpcAccountRecord(params)
      await nativeRuntime.connections.requireFreeForAccount(parsed.reference.accountId)
      refuseKeyOnSignInOnly(parsed)
      await requireSameDestination(nativeRuntime, parsed)
      const record = await vaultOwnedStatus(nativeRuntime, parsed)
      await nativeRuntime.accounts.put(record)
      return redactAccount(record)
    }
    case "account.revoke": {
      const accountId = requireNativeId(params.accountId, "accountId", 256)
      const record = await requireAccount(nativeRuntime, accountId)
      const revoked = parseAccountRecord({
        reference: record.reference,
        status: "revoked",
        statusCode: "ACCOUNT_REVOKED",
        lastCheckedAt: Date.now(),
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      })
      await nativeRuntime.accounts.put(revoked)
      await nativeRuntime.credentialBroker.revoke?.(record.reference)
      return redactAccount(revoked)
    }
    case "account.remove": {
      const accountId = requireNativeId(params.accountId, "accountId", 256)
      const record = await requireAccount(nativeRuntime, accountId)
      await nativeRuntime.credentialBroker.revoke?.(record.reference)
      await nativeRuntime.accounts.remove(accountId)
      await nativeRuntime.connections.forgetProvider(accountId)
      return { removed: true, accountId }
    }
    case "account.resolve": {
      rejectRawCredentialFields(params)
      const record = await requireAccount(nativeRuntime, requireNativeId(params.accountId, "accountId", 256))
      let lease: Awaited<ReturnType<NonNullable<import("./accounts/types.ts").CredentialBroker["resolve"]>>>
      try {
        lease = await nativeRuntime.credentialBroker.resolve(record.reference)
      } catch (error) {
        if (error instanceof CredentialStoreError) throw error
        throw new ControlRpcError("CONTROL_ACCOUNT_CREDENTIALS_UNAVAILABLE", 409, error instanceof AccountError ? error.code : "account credentials are unavailable")
      }
      try {
        return { accountId: lease.accountId, provider: lease.provider, ...(lease.expiresAt === undefined ? {} : { expiresAt: lease.expiresAt }), resolved: true }
      } finally {
        await lease.release?.()
      }
    }
    case "auth.flows":
      return requireSignIn(nativeRuntime).list()
    case "auth.login.start": {
      rejectRawCredentialFields(params)
      const flow = params.flow
      if (typeof flow !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(flow)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "flow is invalid")
      return requireSignIn(nativeRuntime).start(flow, {
        ...(params.accountId === undefined ? {} : { accountId: requireNativeId(params.accountId, "accountId", 256) }),
        ...(params.label === undefined ? {} : { label: requireNativeText(params.label, "label", 160) }),
      })
    }
    case "auth.login.status":
      return requireSignIn(nativeRuntime).status(
        requireLoginId(params.loginId),
        parseOptionalBound(params.afterSeq, 0, 1_000_000, "afterSeq") ?? 0,
        parseOptionalBound(params.waitMs, 0, MAX_SIGN_IN_STATUS_WAIT_MS, "waitMs") ?? 0,
      )
    case "auth.login.cancel":
      return requireSignIn(nativeRuntime).cancel(requireLoginId(params.loginId))
    case "auth.logout": {
      const signIn = requireSignIn(nativeRuntime)
      const record = await requireAccount(nativeRuntime, requireNativeId(params.accountId, "accountId", 256))
      if (record.status === "revoked") throw new ControlRpcError("CONTROL_ACCOUNT_REVOKED", 409, "account is revoked")
      const mode = record.reference.authMode
      if (mode !== "api-key" && mode !== "oauth" && mode !== "device") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "account keeps no stored credential")
      await signIn.logout(record)
      return redactAccount(await requireAccount(nativeRuntime, record.reference.accountId))
    }
    case "share.list":
      if (params.taskId === undefined) return listScopedShares(nativeRuntime, controller)
      {
        const task = await nativeRuntime.taskKernel.snapshot(requireNativeId(params.taskId, "task id", 128))
        requireTaskScope(task, nativeRuntime, controller)
        return nativeRuntime.shares.list(task.taskId)
      }
    case "share.get": {
      const shareId = requireNativeId(params.shareId, "shareId", 256)
      return withShareLock(nativeRuntime, shareId, async () => {
        const share = await requireShare(nativeRuntime, shareId)
        await requireShareTaskScope(share, nativeRuntime, controller)
        return share
      })
    }
    case "share.create": {
      const task = await nativeRuntime.taskKernel.snapshot(requireNativeId(params.taskId, "task id", 128))
      requireTaskScope(task, nativeRuntime, controller)
      const payload = parseRpcSharePayload(params.payload)
      if (payload.kind !== "none") throw new ControlRpcError("SHARE_CRYPTO_REQUIRED", 409, "payload-bearing shares require an encrypted payload reference")
      const share = createShareReference({
        taskId: task.taskId,
        ownerId: nativeRuntime.ownerId,
        mode: parseShareMode(params.mode),
        role: "owner",
        payload,
        ...(params.expiresAt === undefined ? {} : { expiresAt: parseRequiredTimestamp(params.expiresAt, "expiresAt") }),
      })
      await nativeRuntime.shares.put(share)
      const artifacts = parseRpcShareArtifacts(params.artifacts)
      return { share, bundle: createContentFreeShareBundle(share, task.digest ?? taskDigest(task), artifacts) }
    }
    case "share.bundle": {
      const shareId = requireNativeId(params.shareId, "shareId", 256)
      return withShareLock(nativeRuntime, shareId, async () => {
        const share = await requireShare(nativeRuntime, shareId)
        const task = await requireShareTaskScope(share, nativeRuntime, controller)
        return createContentFreeShareBundle(share, task.digest ?? taskDigest(task), parseRpcShareArtifacts(params.artifacts))
      })
    }
    case "share.advance": {
      const shareId = requireNativeId(params.shareId, "shareId", 256)
      return withShareLock(nativeRuntime, shareId, async () => {
        const share = await requireShare(nativeRuntime, shareId)
        await requireShareTaskScope(share, nativeRuntime, controller)
        const next = advanceShareCursor(share, nativeRuntime.ownerId, parseRequiredBound(params.cursor, 0, 2_000_000_000, "cursor"), parseRequiredBound(params.expectedRevision, 0, 2_000_000_000, "expectedRevision"))
        await nativeRuntime.shares.put(next)
        return next
      })
    }
    case "share.revoke": {
      const shareId = requireNativeId(params.shareId, "shareId", 256)
      return withShareLock(nativeRuntime, shareId, async () => {
        const share = await requireShare(nativeRuntime, shareId)
        await requireShareTaskScope(share, nativeRuntime, controller)
        const next = revokeShare(share, nativeRuntime.ownerId, parseRequiredBound(params.expectedRevision, 0, 2_000_000_000, "expectedRevision"))
        await nativeRuntime.shares.put(next)
        return next
      })
    }
    case "share.grants": {
      const shareId = requireNativeId(params.shareId, "shareId", 256)
      return withShareLock(nativeRuntime, shareId, async () => {
        const share = await requireShare(nativeRuntime, shareId)
        await requireShareTaskScope(share, nativeRuntime, controller)
        return nativeRuntime.shares.grants(share.shareId)
      })
    }
    case "share.grant": {
      const shareId = requireNativeId(params.shareId, "shareId", 256)
      return withShareLock(nativeRuntime, shareId, async () => {
        const share = await requireShare(nativeRuntime, shareId)
        await requireShareTaskScope(share, nativeRuntime, controller)
        if (share.ownerId !== nativeRuntime.ownerId) throw new ShareError("SHARE_ACCESS_DENIED", "share owner is not available")
        assertShareLive(share)
        const expectedRevision = parseRequiredBound(params.expectedRevision, 0, 2_000_000_000, "expectedRevision")
        if (expectedRevision !== share.revision) throw new ShareError("SHARE_CONFLICT", "share revision is stale")
        const role = parseShareRole(params.role)
        if (role === "owner") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "owner grants are not supported")
        const grant = parseShareAccessGrant({
          grantId: params.grantId === undefined ? `grant-${randomUUID()}` : requireNativeId(params.grantId, "grantId", 256),
          shareId: share.shareId,
          subjectId: requireNativeId(params.subjectId, "subjectId", 256),
          role,
          createdAt: Date.now(),
          ...(params.expiresAt === undefined ? {} : { expiresAt: parseRequiredTimestamp(params.expiresAt, "expiresAt") }),
          revoked: false,
        })
        await nativeRuntime.shares.putGrant(grant)
        const next = Object.freeze({ ...share, revision: share.revision + 1 })
        await nativeRuntime.shares.put(next)
        return { share: next, grant }
      })
    }
    case "share.events": {
      const shareId = requireNativeId(params.shareId, "shareId", 256)
      return withShareLock(nativeRuntime, shareId, async () => {
        const share = await requireShare(nativeRuntime, shareId)
        if (share.ownerId !== nativeRuntime.ownerId) throw new ShareError("SHARE_ACCESS_DENIED", "share owner is not available")
        assertShareLive(share)
        const task = await nativeRuntime.taskKernel.snapshot(share.taskId)
        requireTaskScope(task, nativeRuntime, controller)
        return { share, events: nativeRuntime.taskKernel.events(task.taskId, parseOptionalBound(params.afterSeq, share.eventCursor, 2_000_000_000, "afterSeq"), parseOptionalBound(params.maxEvents, 1, 65_536, "maxEvents")) }
      })
    }
    case "package.list":
    case "packages.list":
      return (await nativeRuntime.packageManager.list()).map(redactNativePackage)
    case "package.get":
    case "packages.get": {
      const packageId = requireNativeId(params.id ?? params.packageId, "package id", 128)
      const item = await nativeRuntime.packageManager.get(packageId)
      if (item === undefined) throw new ControlRpcError("CONTROL_PACKAGE_NOT_FOUND", 404, "package was not found")
      return redactNativePackage(item)
    }
    case "package.install":
    case "packages.install": {
      const replace = optionalBoolean(params.replace) ?? false
      if (replace) ensureControllerIdle(controller)
      const installed = await nativeRuntime.packageManager.install(requireNativeText(params.source, "source", 4_096), { replace, ...(params.sourceLabel === undefined ? {} : { sourceLabel: requireNativeText(params.sourceLabel, "sourceLabel", 2_048) }) })
      return redactNativePackage(installed)
    }
    case "package.update":
    case "packages.update": {
      ensureControllerIdle(controller)
      const updated = await nativeRuntime.packageManager.update(requireNativeId(params.id ?? params.packageId, "package id", 128), requireNativeText(params.source, "source", 4_096))
      return redactNativePackage(updated)
    }
    case "package.activate":
    case "packages.activate": {
      ensureControllerIdle(controller)
      const activated = await nativeRuntime.packageManager.activate(requireNativeId(params.id ?? params.packageId, "package id", 128), {
        approvalGranted: optionalBoolean(params.approvalGranted) ?? false,
        allowTrusted: optionalBoolean(params.allowTrusted) ?? true,
        allowIsolated: optionalBoolean(params.allowIsolated) ?? true,
      })
      return redactNativePackage(activated)
    }
    case "package.deactivate":
    case "packages.deactivate": {
      ensureControllerIdle(controller)
      return redactNativePackage(await nativeRuntime.packageManager.deactivate(requireNativeId(params.id ?? params.packageId, "package id", 128)))
    }
    case "package.rollback":
    case "packages.rollback": {
      ensureControllerIdle(controller)
      return redactNativePackage(await nativeRuntime.packageManager.rollback(requireNativeId(params.id ?? params.packageId, "package id", 128)))
    }
    case "package.remove":
    case "packages.remove": {
      ensureControllerIdle(controller)
      const id = requireNativeId(params.id ?? params.packageId, "package id", 128)
      await nativeRuntime.packageManager.remove(id)
      return { removed: true, id }
    }
    case "package.enable":
    case "packages.enable":
      return redactNativePackage(await nativeRuntime.packageManager.setEnabled(requireNativeId(params.id ?? params.packageId, "package id", 128), true))
    case "package.disable":
    case "packages.disable":
      return redactNativePackage(await nativeRuntime.packageManager.setEnabled(requireNativeId(params.id ?? params.packageId, "package id", 128), false))
    case "package.lock":
    case "packages.lock":
      return nativeRuntime.packageManager.lock()
    case "package.verify":
    case "packages.verify":
      return nativeRuntime.packageManager.verify()
    case "package.doctor":
    case "packages.doctor":
      return nativeRuntime.packageManager.doctor()
    case "package.resolve":
    case "packages.resolve": {
      const manifest = parseRpcPackageManifest(params.manifest)
      const candidates = params.candidates === undefined ? [] : parseRpcPackageCandidates(params.candidates)
      return nativeRuntime.packageManager.resolve(manifest, candidates)
    }
    case "session.snapshot":
      return controller.snapshot()
    case "session.status":
      return controller.snapshot()
    case "session.history": {
      const limit = parseOptionalBound(params.limit, 1, 2_048, "limit")
      const entries = await controller.session.history(limit)
      return entries.map((entry) => ({
        version: entry.version,
        sessionId: entry.sessionId,
        seq: entry.seq,
        at: entry.at,
        type: entry.type,
        ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
      }))
    }
    case "session.context":
      return controller.session.context.list().map((resource) => ({ id: resource.id, kind: resource.kind, ...(resource.path === undefined ? {} : { path: resource.path }) }))
    case "session.tree":
      return controller.session.tree()
    case "session.checkpoints.list":
      return { checkpoints: await requireCheckpoints(controller).list() }
    case "session.checkpoint.changes": {
      const checkpoints = requireCheckpoints(controller)
      return await checkpoints.changes((await controller.session.checkpointFor(parseRewindTarget(params))).n)
    }
    case "session.rewind": {
      ensureControllerIdle(controller)
      const target = parseRewindTarget(params)
      const files = parseRewindFiles(params.files)
      try {
        return await controller.rewind(target, files)
      } catch (error) {
        throw error instanceof TranscriptStoreError ? mapTranscriptError(error) : error
      }
    }
    case "thread.copy":
      return copyThread(services.threadsDir, params)
    case "workspace.list":
      return listWorkspace(await workspaceFor(controller, services, params), params)
    case "workspace.read":
      return readWorkspaceFile(await workspaceFor(controller, services, params), params)
    case "workspace.write":
      return writeWorkspaceFile(await workspaceFor(controller, services, params), params)
    case "backend.list":
      return controller.listBackends()
    case "backend.current":
      return controller.snapshot()
    case "session.reload":
      return controller.session.reload()
    case "session.checkpoint":
      await controller.session.checkpoint()
      return { checkpointed: true }
    case "session.compact": {
      const reason = parseCompactionReason(params.reason)
      if (!controller.session.canCompact) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, `${controller.snapshot().backend} cannot compact its conversation`)
      const state = controller.snapshot()
      if (state.active || state.queued > 0) throw new ControlRpcError("CONTROL_SESSION_BUSY", 409, "cannot compact while a turn is running or queued")
      return controller.compact(reason)
    }
    case "session.usage.read":
      return controller.session.readUsage()
    case "usage.read":
      return readToolUsage(services.usage, nativeRuntime, params)
    case "push.vapid":
    case "push.send":
      return pushRpc(services.push, method, params)
    case "session.fork":
    case "session.branch":
    case "session.clone":
      return controller.session.fork(optionalSessionId(params.targetSessionId))
    case "session.export":
      return { evidence: await controller.session.exportEvidence(parseOptionalBound(params.maxEntries, 1, 16_384, "maxEntries")) }
    case "session.import":
      return controller.session.importEvidence(
        requireString(params.evidence, "evidence"),
        optionalSessionId(params.targetSessionId),
      )
    case "session.transcript.status":
      requireTranscriptStore(controller)
      return {
        configured: true,
        contentFreeEvidence: true,
        sessionId: controller.session.snapshot.id,
        maxRecords: 16_384,
        maxBytes: MAX_CONTROL_TRANSCRIPT_BYTES,
      }
    case "session.transcript.read":
      requireTranscriptStore(controller)
      return {
        sessionId: controller.session.snapshot.id,
        records: await readTranscriptRecords(controller, parseTranscriptReadOptions(params)),
      }
    case "session.transcript.export":
      requireTranscriptStore(controller)
      return { transcript: await exportTranscriptRecords(controller, parseTranscriptReadOptions(params)) }
    case "session.transcript.import":
      requireTranscriptStore(controller)
      return controller.session.importTranscript(
        requireBoundedString(params.transcript, "transcript", MAX_CONTROL_TRANSCRIPT_BYTES),
        optionalSessionId(params.targetSessionId),
      )
    case "session.transcript.branch":
      requireTranscriptStore(controller)
      return { sessionId: await controller.session.branchTranscript(optionalSessionId(params.targetSessionId)) }
    case "session.transcript.compact":
      requireTranscriptStore(controller)
      return controller.session.compactTranscript({
        throughSeq: parseRequiredBound(params.throughSeq, 0, 1_000_000, "throughSeq"),
        replacement: parseTranscriptAppendInput(params.replacement),
      })
    case "session.conversation.read":
      return readConversation(controller, services.conversation, params)
    case "conversation.peek":
      return peekConversation(services.threadsDir, params)
    case "session.external.list":
      // "all": every folder's sessions, each with its folder. Importing one still needs a thread whose folder holds it.
      if (params.scope !== undefined && params.scope !== "project" && params.scope !== "all") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "scope must be project or all")
      try {
        return await listExternalSessions({
          cwd: controller.session.policy.root,
          everywhere: params.scope === "all",
          roots: services.external.roots,
          limit: parseOptionalBound(params.limit, 1, 1_000, "limit") ?? 200,
        })
      } catch (error) {
        throw mapExternalError(error)
      }
    case "session.external.import":
      return importExternalSession(controller, services.external, params)
    case "session.external.refresh":
      return refreshExternalSession(controller, services.external, params)
    case "live.frames": {
      const afterLiveSeq = parseOptionalBound(params.afterLiveSeq, 0, Number.MAX_SAFE_INTEGER, "afterLiveSeq") ?? 0
      const maxFrames = parseOptionalBound(params.maxFrames, 1, 4_096, "maxFrames") ?? 512
      try {
        return { frames: services.live.since(afterLiveSeq, maxFrames), lastLiveSeq: services.live.lastLiveSeq }
      } catch (error) {
        if (error instanceof LiveFrameCursorError) throw new ControlRpcError("CONTROL_LIVE_CURSOR_EXPIRED", 409, "live frame cursor has expired")
        throw error
      }
    }
    case "turn.enqueue":
    case "turn.steer": {
      // A caller that resends after a lost answer names the message; the same key gets the first answer, not a second turn.
      const key = params.idempotencyKey === undefined ? undefined : `${method}:${requireNativeId(params.idempotencyKey, "idempotencyKey", 256)}`
      const answers = turnAnswers.get(controller) ?? new Map<string, Promise<unknown>>()
      turnAnswers.set(controller, answers)
      const earlier = key === undefined ? undefined : answers.get(key)
      if (earlier !== undefined) return earlier
      const answer = answerTurn(method, params, controller, services)
      if (key !== undefined) {
        if (answers.size >= MAX_TURN_KEYS) answers.delete(answers.keys().next().value as string)
        answers.set(key, answer)
        // A refused message may be sent again under the same key.
        answer.catch(() => answers.delete(key))
      }
      return answer
    }
    case "turn.cancel":
      controller.cancel(optionalString(params.reason) ?? "cancelled", optionalBoolean(params.clearQueued) ?? false)
      return controller.snapshot()
    case "approval.resolve":
      return controller.resolveApproval(
        requireString(params.approvalId, "approvalId"),
        requireBoolean(params.approved, "approved"),
        optionalString(params.reason),
        approvalScope(params.scope),
        approvalAnswers(params.answers),
        approvalFollowUp(params),
      )
    case "model.list":
      return controller.session.listModels()
    case "model.switch":
      return controller.switchModel(parseModelSelection(params))
    case "backend.switch": {
      const backend = requireString(params.backend, "backend")
      if (params.connectionId === undefined) return controller.switchBackend(backend)
      const connectionId = requireNativeId(params.connectionId, "connectionId", 256)
      const tool = await nativeRuntime.connections.requireTool(connectionId, backend)
      const account = await toolConnectionAccount(tool, { accountsRoot: nativeRuntime.accountsRoot, ...(nativeRuntime.vaultBroker === undefined ? {} : { vault: nativeRuntime.vaultBroker.vault }) })
      return controller.switchBackend(backend, { connectionId, ...(account === undefined ? {} : { account }), ...(tool.models === undefined ? {} : { models: tool.models }) })
    }
    case "background.list":
      return listBackground(services, params)
    case "background.output":
      return readBackgroundOutput(services, params)
    case "background.stop":
      return stopBackground(services, params)
    case "browser.take":
      return takeBrowserRequest(services, params)
    case "browser.respond":
      return respondToBrowserRequest(services, params)
    case "threads.take":
      return takeThreadsRequest(services, params)
    case "threads.respond":
      return respondToThreadsRequest(services, params)
    case "computer.take":
      return takeComputerRequest(services, params)
    case "computer.respond":
      return respondToComputerRequest(services, params)
    case "metrics.snapshot":
      return controller.session.metrics?.snapshot() ?? null
    case "provider.list":
      return createDefaultProviderCatalog().list()
    case "provider.status":
      return createDefaultProviderCatalog().status()
    case "provider.discover":
    case "model.discover":
      await refuseStoredCredentialOnCallerEndpoint(nativeRuntime, params)
      return discoverProviderModels(parseProviderDiscovery(params, nativeRuntime.credentialResolver))
    case "provider.select":
      if (params.connectionId !== undefined) return controller.switchProvider(await parseConnectionModel(nativeRuntime, params, services.connections.metadata))
      await refuseStoredCredentialOnCallerEndpoint(nativeRuntime, params)
      return controller.switchProvider(parseProviderModel(params, nativeRuntime.credentialResolver))
    case "connection.presets":
      return {
        presets: PROVIDER_PRESETS.map((preset) => ({
          id: preset.id,
          name: preset.name,
          protocol: preset.protocol,
          baseUrl: preset.baseUrl,
          ...(preset.environment === undefined ? {} : { environment: preset.environment }),
          models: preset.models,
          ...(preset.signInOnly === true ? { signInOnly: true } : {}),
        })),
        custom: CUSTOM_PROVIDER_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, protocol: preset.protocol, authStyle: preset.authStyle })),
      }
    case "connection.detect": {
      const accounts = await nativeRuntime.accounts.list()
      const used = new Set(accounts.filter((account) => account.status !== "revoked" && account.reference.authMode === "environment").map((account) => connectionPresetId(account.reference)))
      return { detected: detectShellConnections(services.connections.environment).filter((entry) => !used.has(entry.presetId)) }
    }
    case "connection.importable":
      return { candidates: await findImportableConnections(services.connections.home, services.connections.environment) }
    case "connection.models": {
      const probe = await probeConnection(nativeRuntime, await requireAccount(nativeRuntime, requireNativeId(params.connectionId, "connectionId", 256)))
      return {
        connectionId: probe.connection.connectionId,
        presetId: probe.connection.presetId,
        models: mergeModelList(probe.models, services.connections.metadata.models(probe.connection.presetId)),
        // Only a live list names image models; nothing about them is bundled.
        images: probe.images ?? [],
        live: { ok: probe.models !== undefined, code: probe.code },
        // A model the list does not name can still be typed by hand.
        manualEntry: true,
      }
    }
    case "connection.test": {
      const probe = await probeConnection(nativeRuntime, await requireAccount(nativeRuntime, requireNativeId(params.connectionId, "connectionId", 256)))
      return {
        connectionId: probe.connection.connectionId,
        status: connectionCheckStatus(probe.code),
        code: probe.code,
        ...(probe.models === undefined ? {} : { modelCount: probe.models.length }),
        checkedAt: Date.now(),
      }
    }
    case "connection.list":
      if (params.enabledOnly !== undefined && typeof params.enabledOnly !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "enabledOnly is invalid")
      return nativeRuntime.connections.list({ enabledOnly: params.enabledOnly === true })
    case "connection.update": {
      rejectRawCredentialFields(params)
      if (params.enabled !== undefined && typeof params.enabled !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "enabled is invalid")
      if (params.models !== undefined && params.models !== null && !isStringList(params.models)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "models are invalid")
      return nativeRuntime.connections.update(requireNativeId(params.connectionId, "connectionId", 256), {
        ...(params.label === undefined ? {} : { label: requireNativeText(params.label, "label", 160) }),
        ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
        ...(params.models === undefined ? {} : { models: params.models }),
      })
    }
    case "connection.setDefault": {
      // `connectionId: null` clears it.
      if (params.connectionId === null) return { default: await nativeRuntime.connections.setDefault(undefined) ?? null }
      return { default: await nativeRuntime.connections.setDefault({ connectionId: requireNativeId(params.connectionId, "connectionId", 256), model: requireBoundedString(params.model, "model", 256) }) }
    }
    case "connection.setImageModel": {
      // `connectionId: null` clears it. The model must be one the connection's own list names as an image model.
      if (params.connectionId === null) return { image: await nativeRuntime.connections.setImage(undefined) ?? null }
      const connectionId = requireNativeId(params.connectionId, "connectionId", 256)
      const model = requireBoundedString(params.model, "model", 256)
      const probe = await probeConnection(nativeRuntime, await requireAccount(nativeRuntime, connectionId))
      if (probe.images === undefined) throw new ControlRpcError("CONTROL_CONNECTION_CHECK_FAILED", 409, `the connection's model list could not be read (${probe.code})`)
      const listed = probe.images.find((entry) => entry.id === model)
      if (listed === undefined) throw new ConnectionSettingsError("CONNECTION_MODEL_NOT_CHOSEN", "the connection does not list this image model")
      return { image: await nativeRuntime.connections.setImage({ connectionId, model, route: listed.route }) }
    }
    case "connection.addTool": {
      rejectRawCredentialFields(params)
      if (params.models !== undefined && !isStringList(params.models)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "models are invalid")
      return nativeRuntime.connections.addTool({
        tool: requireNativeId(params.tool, "tool", 64),
        ...(params.authMode === undefined ? {} : { authMode: requireNativeId(params.authMode, "authMode", 32) }),
        ...(params.label === undefined ? {} : { label: requireNativeText(params.label, "label", 160) }),
        ...(params.models === undefined ? {} : { models: params.models }),
        ...(params.connectionId === undefined ? {} : { connectionId: requireNativeId(params.connectionId, "connectionId", 256) }),
        ...(params.separateAccount === undefined ? {} : { separateAccount: requireBoolean(params.separateAccount, "separateAccount") }),
      })
    }
    case "connection.removeTool": {
      const connectionId = requireNativeId(params.connectionId, "connectionId", 256)
      // The tool's own sign-in is left alone: signing out of it is `connection.vendorSignOut`, not this.
      const removed = await nativeRuntime.connections.removeTool(connectionId)
      // The key is Runrail's own copy, so it goes with the connection.
      if (removed.authMode === "api-key") await nativeRuntime.vaultBroker?.vault.delete(connectionId)
      return { removed: true, connectionId }
    }
    case "connection.status":
      return toolConnectionStatus(nativeRuntime, services, requireNativeId(params.connectionId, "connectionId", 256))
    case "connection.loginCommand": {
      const { tool, login } = await toolLogin(nativeRuntime, params.connectionId)
      return { connectionId: tool.connectionId, command: login.command, args: login.args, env: login.env }
    }
    case "connection.loginStart": {
      const cols = parseOptionalBound(params.cols, 20, 400, "cols") ?? 80
      const rows = parseOptionalBound(params.rows, 4, 200, "rows") ?? 16
      const { tool, login } = await toolLogin(nativeRuntime, params.connectionId)
      const command = services.harnesses.probe.commands?.[tool.tool as HarnessProbeTarget]
      const started = services.logins.start({ connectionId: tool.connectionId, command: command?.command ?? login.command, args: [...(command?.args ?? []), ...login.args], env: login.env, cols, rows })
      return { connectionId: tool.connectionId, loginId: started.loginId }
    }
    case "connection.loginRead": {
      const loginId = requireNativeId(params.loginId, "loginId", 64)
      const afterSeq = parseOptionalBound(params.afterSeq, 0, 2_000_000_000, "afterSeq") ?? 0
      const maxBytes = parseOptionalBound(params.maxBytes, 1, MAX_LOGIN_READ_BYTES, "maxBytes") ?? MAX_LOGIN_READ_BYTES
      return services.logins.read(loginId, afterSeq, maxBytes)
    }
    case "connection.loginWrite": {
      const loginId = requireNativeId(params.loginId, "loginId", 64)
      const data = requireBoundedString(params.data, "data", MAX_LOGIN_INPUT_BYTES)
      if (Buffer.byteLength(data, "utf8") > MAX_LOGIN_INPUT_BYTES) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "data is too long")
      return services.logins.write(loginId, data)
    }
    case "connection.loginClose": {
      const loginId = requireNativeId(params.loginId, "loginId", 64)
      await services.logins.close(loginId)
      return { loginId, closed: true }
    }
    case "connection.vendorSignOut": {
      if (params.confirm !== true) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "confirm must be true")
      const tool = await nativeRuntime.connections.getTool(requireNativeId(params.connectionId, "connectionId", 256))
      if (tool.authMode === "api-key" || harnessLogoutCommand(tool.tool) === undefined) throw new ConnectionSettingsError("CONNECTION_AUTH_UNSUPPORTED", "this connection has no tool sign-in Runrail can end")
      const command = services.harnesses.probe.commands?.[tool.tool as HarnessProbeTarget]
      const signedOut = await runHarnessLogout(tool.tool, toolConnectionHome(nativeRuntime.accountsRoot, tool), { ...(command === undefined ? {} : { command }), ...(services.harnesses.probe.env === undefined ? {} : { env: services.harnesses.probe.env }) })
      return { connectionId: tool.connectionId, signedOut }
    }
    case "harness.list":
      return new HarnessRegistry(createDefaultHarnessAdapters()).list()
    case "harness.status": {
      if (params.refresh !== undefined && typeof params.refresh !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "refresh is invalid")
      const cached = services.harnesses.cached
      if (params.refresh !== true && cached !== undefined && Date.now() - cached.at < HARNESS_STATUS_TTL_MS) return cached.value
      const value = new HarnessRegistry(createDefaultHarnessAdapters()).probe(services.harnesses.probe)
      services.harnesses.cached = { at: Date.now(), value }
      // A failed look is not kept: the next call asks again.
      value.catch(() => { if (services.harnesses.cached?.value === value) services.harnesses.cached = undefined })
      return value
    }
    case "claude.sdk.status":
      return claudeAgentSdkStatus()
    case "claude.sdk.install": {
      if (params.confirm !== true) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "confirm must be true")
      const status = claudeAgentSdkStatus()
      if (status.ready) return status
      if (status.source !== "installable") throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, `this engine cannot download the Claude Agent SDK; install it with: ${status.installCommand}`)
      try {
        return await installClaudeAgentSdk()
      } catch (error) {
        throw new ControlRpcError("CONTROL_CLAUDE_SDK_INSTALL_FAILED", 502, error instanceof Error ? error.message.slice(0, 512) : "the download failed")
      }
    }
    case "harness.negotiate": {
      const registry = new HarnessRegistry(createDefaultHarnessAdapters())
      const descriptor = registry.get(requireString(params.id, "id"))?.descriptor
      if (descriptor === undefined) throw new ControlRpcError("CONTROL_HARNESS_NOT_FOUND", 404, "harness is not available")
      return negotiateHarnessFeatures(descriptor, parseHarnessFeatures(params.features))
    }
    case "connector.setup.list":
      return connectorSetupList(services, nativeRuntime.vaultBroker?.vault)
    case "connector.setup.save":
      return connectorSetupSave(services, params)
    case "connector.setup.remove":
      return connectorSetupRemove(services, nativeRuntime, params)
    case "connector.list":
      return requireConnectorRegistry(connectorRegistry ?? services.connectors.registry).list()
    case "connector.actions":
      return requireConnectorRegistry(connectorRegistry ?? services.connectors.registry).actions(requireString(params.id, "id")).map((action) => ({ name: action.name, description: action.description, kind: action.kind, capabilities: action.capabilities, requiresApproval: action.requiresApproval === true }))
    case "connector.invoke": {
      const approved = optionalBoolean(params.approved) ?? false
      return requireConnectorRegistry(connectorRegistry ?? services.connectors.registry).invoke(requireString(params.id, "id"), requireString(params.action, "action"), params.input ?? {}, {
        cwd: controller.session.policy.root,
        signal: AbortSignal.timeout(parseOptionalBound(params.timeoutMs, 1_000, 300_000, "timeoutMs") ?? 60_000),
        allowedCapabilities: parseStringList(params.capabilities, "capabilities"),
        approve: () => approved,
        ...(parseOptionalBound(params.maxInputBytes, 1, 4 * 1024 * 1024, "maxInputBytes") === undefined ? {} : { maxInputBytes: parseOptionalBound(params.maxInputBytes, 1, 4 * 1024 * 1024, "maxInputBytes") }),
        ...(parseOptionalBound(params.maxOutputBytes, 1, 4 * 1024 * 1024, "maxOutputBytes") === undefined ? {} : { maxOutputBytes: parseOptionalBound(params.maxOutputBytes, 1, 4 * 1024 * 1024, "maxOutputBytes") }),
      })
    }
    case "agent.list":
      return requireAgentCoordinator(agentCoordinator).listProfiles()
    case "mcp.status":
      return { servers: controller.session.mcpStatus() }
    case "nifra.status":
      return controller.session.nifraUse()
    case "mcp.check": {
      const name = requireBoundedString(params.name, "server name", 32)
      if (!MCP_SERVER_NAME.test(name)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "server name is invalid")
      const status = await controller.session.checkMcpServer(name)
      if (status === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "no MCP server has this name")
      return status
    }
    case "skills.list":
      await controller.refreshSkills()
      return controller.listSkills()
    case "skills.setEnabled": {
      const id = requireBoundedSkillId(params.id)
      const enabled = params.enabled
      if (typeof enabled !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "skill flag is invalid")
      try {
        return await controller.setSkillEnabled(id, enabled)
      } catch (error) {
        throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, error instanceof Error ? error.message : "skill update failed")
      }
    }
    case "agent.run":
      return requireAgentCoordinator(agentCoordinator).run(parseAgentTask(params))
    case "agent.runMany": {
      const tasks = params.tasks
      if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 128) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "tasks are invalid")
      return requireAgentCoordinator(agentCoordinator).runMany(tasks.map(parseAgentTask), { maxConcurrency: parseOptionalBound(params.maxConcurrency, 1, 32, "maxConcurrency") })
    }
    case "terminal.describe":
      return publicTerminalDescriptor(requireTerminalBridge(terminalBridge))
    case "terminal.create":
      return createTerminalSession(controller, requireTerminalBridge(terminalBridge), params)
    case "terminal.write":
      return writeTerminalInput(requireTerminalBridge(terminalBridge), params)
    case "terminal.read":
      return readTerminalOutput(requireTerminalBridge(terminalBridge), params)
    case "terminal.resize":
      return resizeTerminal(requireTerminalBridge(terminalBridge), params)
    case "terminal.close":
      return closeTerminal(requireTerminalBridge(terminalBridge), params)
    case "plugin.list":
    case "plugins.list":
      return requirePluginManager(pluginManager).list()
    case "plugin.install":
    case "plugins.install":
      return requirePluginManager(pluginManager).install(requireString(params.source, "source"))
    case "plugin.update":
    case "plugins.update": {
      const manager = requirePluginManager(pluginManager)
      ensureControllerIdle(controller)
      const plugin = await manager.update(
        requireString(params.id, "id"),
        requireString(params.source, "source"),
      )
      return { plugin, session: await controller.refreshSession() }
    }
    case "plugin.rollback":
    case "plugins.rollback": {
      const manager = requirePluginManager(pluginManager)
      ensureControllerIdle(controller)
      const plugin = await manager.rollback(requireString(params.id, "id"))
      return { plugin, session: await controller.refreshSession() }
    }
    case "plugin.remove":
    case "plugins.remove": {
      const manager = requirePluginManager(pluginManager)
      ensureControllerIdle(controller)
      await manager.remove(requireString(params.id, "id"))
      return { removed: true, session: await controller.refreshSession() }
    }
    case "plugin.enable":
    case "plugins.enable":
      return requirePluginManager(pluginManager).setEnabled(requireString(params.id, "id"), true)
    case "plugin.disable":
    case "plugins.disable": {
      const manager = requirePluginManager(pluginManager)
      ensureControllerIdle(controller)
      const plugin = await manager.setEnabled(requireString(params.id, "id"), false)
      return { plugin, session: await controller.refreshSession() }
    }
    case "plugin.activate":
    case "plugins.activate": {
      const manager = requirePluginManager(pluginManager)
      ensureControllerIdle(controller)
      const plugin = await manager.activate(
        requireString(params.id, "id"),
        {
          capabilities: parseStringList(params.capabilities, "capabilities"),
          permissions: parsePermissions(params.permissions),
          allowTrusted: true,
          allowIsolated: true,
        },
        optionalBoolean(params.approvalGranted) ?? false,
      )
      return { plugin, session: await controller.refreshSession() }
    }
    case "plugin.deactivate":
    case "plugins.deactivate": {
      const manager = requirePluginManager(pluginManager)
      ensureControllerIdle(controller)
      const plugin = await manager.deactivate(requireString(params.id, "id"))
      return { plugin, session: await controller.refreshSession() }
    }
    case "plugin.invoke":
    case "plugins.invoke":
      return requirePluginManager(pluginManager).invokeIsolatedTool(
        requireString(params.id, "id"),
        requireString(params.name, "name"),
        params.input,
      )
    case "plugin.configure":
    case "plugins.configure":
      await requirePluginManager(pluginManager).configure(requireString(params.id, "id"), params.config)
      return { configured: true }
    case "plugin.test":
    case "plugins.test": {
      const manager = requirePluginManager(pluginManager)
      return manager.test(requireString(params.id, "id"), {
        capabilities: parseStringList(params.capabilities, "capabilities"),
        permissions: parsePermissions(params.permissions),
        allowTrusted: true,
        allowIsolated: true,
      }, optionalBoolean(params.approvalGranted) ?? false)
    }
    default:
      throw new ControlRpcError("CONTROL_UNKNOWN_METHOD", 400, `unknown control method '${method}'`)
  }
}

function redactNativePackage(item: import("./packages/manager.ts").NativeInstalledPackage): Readonly<Record<string, unknown>> {
  return Object.freeze({ manifest: item.manifest, enabled: item.enabled, active: item.active })
}

function parseRpcPackageManifest(value: unknown): NativePackageManifest {
  try {
    return parseNativePackageManifest(value)
  } catch {
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "package manifest is invalid")
  }
}

function parseRpcPackageCandidates(value: unknown): readonly NativePackageManifest[] {
  if (!Array.isArray(value) || value.length > 256) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "package candidates are invalid")
  return Object.freeze(value.map(parseRpcPackageManifest))
}
function requireNativeId(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

/** The tool's own login for a subscription connection, with its folder made; Runrail picks the command, never the caller. */
async function toolLogin(nativeRuntime: NativeControlRuntime, connectionId: unknown): Promise<{ readonly tool: ToolConnection; readonly login: HarnessAccountCommand }> {
  const tool = await nativeRuntime.connections.getTool(requireNativeId(connectionId, "connectionId", 256))
  if (tool.authMode === "api-key") throw new ConnectionSettingsError("CONNECTION_AUTH_UNSUPPORTED", "a key connection takes its key through /secret")
  const home = toolConnectionHome(nativeRuntime.accountsRoot, tool)
  const login = harnessLoginCommand(tool.tool, home)
  if (login === undefined) throw new ConnectionSettingsError("CONNECTION_AUTH_UNSUPPORTED", "this tool signs in from its own interface")
  if (home !== undefined) await mkdir(home, { recursive: true, mode: 0o700 })
  return { tool, login }
}

function requireNativeText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || /[\r\n]/.test(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

function optionalNativeText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : requireNativeText(value, name, max)
}

function parseRequiredTimestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999_999) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}


function createTaskCommand(
  name: "task.cancel" | "task.approve" | "task.reject",
  task: import("./task/types.ts").NativeTaskRecord,
  idempotencyKey: string,
  payload: Readonly<Record<string, string | number | boolean>>,
) {
  return parseNativeCommand({
    contractVersion: 1,
    commandId: `native-command-${idempotencyKey}`,
    idempotencyKey,
    taskId: task.taskId,
    sessionId: task.sessionId,
    name,
    requestedAt: Date.now(),
    timeoutMs: 120_000,
    payload,
  })
}

function requireTaskProject(value: unknown, projectId: string): string {
  const requested = value === undefined ? projectId : requireNativeId(value, "project id", 128)
  if (requested !== projectId) throw new NativeContractError("NATIVE_AUTH_REQUIRED", "task belongs to another project")
  return projectId
}

function requireTaskScope(
  task: import("./task/types.ts").NativeTaskRecord,
  runtime: NativeControlRuntime,
  controller: RunrailSessionController,
): void {
  if (task.projectId !== runtime.projectId)
    throw new NativeContractError("NATIVE_AUTH_REQUIRED", "task belongs to another project")
  if (task.sessionId !== controller.session.snapshot.id)
    throw new NativeContractError("NATIVE_AUTH_REQUIRED", "task belongs to another session")
}

const MAX_SECRET_BODY_BYTES = 32 * 1024

/**
 * Stores a pasted key for an account. The request body is the only place the key exists outside the
 * vault: it is not logged, not journaled, not echoed in an error, and no method reads it back.
 */
/** A pasted key for an account (`accountId`) or for a coding tool's key connection (`connectionId`). */
/** A connector's key, read for one call and never kept: GitHub's from `gh`, the others' from the vault. */
async function connectorSecret(kind: ConnectorKind, vault: CredentialVault | undefined, gh: string | undefined): Promise<string> {
  if (kind === "github") {
    if (gh === undefined) throw new ConnectorError("CONNECTOR_CREDENTIALS", "GitHub needs the GitHub CLI (gh)")
    const token = await runGitHubCli({ command: gh, cwd: homedir() }, ["auth", "token"], { maxOutput: 4_096 }).then((answer) => answer.text.trim(), () => "")
    if (token.length === 0 || /\s/.test(token)) throw new ConnectorError("CONNECTOR_CREDENTIALS", "Sign in to GitHub with gh auth login to use it")
    return token
  }
  const stored = await vault?.get(connectorSecretId(kind)).catch(() => undefined)
  if (stored?.kind !== "api-key") throw new ConnectorError("CONNECTOR_CREDENTIALS", `Connect ${CONNECTOR_NAMES[kind]} in Integrations to use it`)
  return stored.secret
}

const MAX_CONNECTOR_CALL_BYTES = 1_048_576
const MAX_CONNECTOR_ANSWER_CHARS = 200_000

/** `POST /connectors` from Claude Code's connector tools: the list this thread may use, or one call. */
async function answerConnectorCall(request: Request, session: RunrailSessionController["session"], registry: ConnectorRegistry): Promise<unknown> {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, MAX_CONNECTOR_CALL_BYTES)))
  } catch {
    throw new ConnectorError("CONNECTOR_INVALID", "connector request is not valid JSON")
  }
  const body = isRecord(value) ? value : {}
  if (body.op === "list") return { tools: session.connectorTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }
  if (body.op !== "call" || typeof body.name !== "string") throw new ConnectorError("CONNECTOR_INVALID", "connector request is invalid")
  const tool = session.connectorTools.find((candidate) => candidate.name === body.name)
  if (tool === undefined) throw new ConnectorError("CONNECTOR_ACTION_NOT_FOUND", "this thread may not use that tool")
  // This route cannot ask; a tool that waits for the person runs only on an approval given in Claude Code's prompt.
  if (tool.approval && session.connectorApprovals?.take(tool.name, body.input) !== true)
    throw new ConnectorError("CONNECTOR_APPROVAL_DENIED", "this tool waits for the person's approval, and none was given for this call")
  const result = await callConnector(registry, tool, body.input, { cwd: session.policy.root, signal: request.signal })
  return { text: (JSON.stringify(result ?? null, null, 2) ?? "null").slice(0, MAX_CONNECTOR_ANSWER_CHARS) }
}

/** Each built-in connector: whether it is on, whether it can sign in, and the settings it keeps. No secret. */
function requireConnectorSetup(services: ControlServices): ConnectorSetupStore {
  if (services.connectors.setup === undefined) throw new ControlRpcError("CONTROL_CONNECTOR_UNAVAILABLE", 501, "connector settings are not configured")
  return services.connectors.setup
}

async function connectorSetupList(services: ControlServices, vault: CredentialVault | undefined): Promise<unknown> {
  const settings = await requireConnectorSetup(services).read()
  const connectors = await Promise.all(CONNECTOR_KINDS.map(async (kind) => {
    const setting = settings[kind]
    const connected = kind === "github"
      ? services.githubCli !== undefined && (await runGitHubCli({ command: services.githubCli, cwd: homedir() }, ["auth", "token"], { maxOutput: 4_096 }).then((answer) => answer.text.trim().length > 0, () => false))
      : (await vault?.get(connectorSecretId(kind)).catch(() => undefined))?.kind === "api-key"
    return { id: kind, name: CONNECTOR_NAMES[kind], on: setting?.on === true, connected, signIn: kind === "github" ? "gh" : "key", ...(setting?.site === undefined ? {} : { site: setting.site }), ...(setting?.email === undefined ? {} : { email: setting.email }) }
  }))
  return { connectors }
}

async function connectorSetupSave(services: ControlServices, params: Record<string, unknown>): Promise<unknown> {
  const id = params.id
  if (!isConnectorKind(id)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "connector is unknown")
  if (typeof params.on !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "on must be true or false")
  const text = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === "") return undefined
    if (typeof value !== "string" || value.length > 256 || /[\0-\x1f]/.test(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
    return value
  }
  const site = text(params.site, "site")
  const email = text(params.email, "email")
  try {
    const saved = await requireConnectorSetup(services).save(id, { on: params.on, ...(site === undefined ? {} : { site }), ...(email === undefined ? {} : { email }) })
    return { id, ...saved }
  } catch (error) {
    if (error instanceof ConnectorError) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, error.message.replace(/^connector: /, ""))
    throw error
  }
}

/** Turns a connector off and forgets its key. */
async function connectorSetupRemove(services: ControlServices, runtime: NativeControlRuntime, params: Record<string, unknown>): Promise<unknown> {
  const id = params.id
  if (!isConnectorKind(id)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "connector is unknown")
  await requireConnectorSetup(services).remove(id)
  if (id !== "github") await runtime.vaultBroker?.vault.delete(connectorSecretId(id)).catch(() => undefined)
  return { id, removed: true }
}

async function storeSecret(request: Request, runtime: NativeControlRuntime): Promise<AccountRecord | ConnectionEntry | { readonly connector: ConnectorKind; readonly connected: true }> {
  const broker = runtime.vaultBroker
  if (broker === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 409, "no credential vault is configured")
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, MAX_SECRET_BODY_BYTES)))
  } catch (error) {
    if (error instanceof ControlRpcError) throw error
    throw new ControlRpcError("CONTROL_INVALID_JSON", 400, "secret request JSON cannot be parsed")
  }
  const keys = isRecord(value) ? Object.keys(value) : []
  const owners = ["accountId", "connectionId", "connectorId"].filter((key) => keys.includes(key))
  if (!isRecord(value) || keys.some((key) => key !== "accountId" && key !== "connectionId" && key !== "connectorId" && key !== "secret") || owners.length !== 1) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "secret request must contain accountId, connectionId or connectorId, and secret")
  // Pasted keys commonly arrive with a trailing newline or surrounding spaces.
  const secret = typeof value.secret === "string" ? value.secret.trim() : ""
  if (secret.length === 0 || Buffer.byteLength(secret, "utf8") > MAX_CREDENTIAL_SECRET_BYTES || /[\0-\x1f\x7f]/.test(secret)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "secret is invalid")
  if (value.connectorId !== undefined) {
    // GitHub answers with the person's own `gh` sign-in; only the other services take a key.
    if (!isConnectorKind(value.connectorId) || value.connectorId === "github") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "connector does not take a pasted key")
    await broker.vault.set(connectorSecretId(value.connectorId), { kind: "api-key", secret })
    return { connector: value.connectorId, connected: true }
  }
  if (value.connectionId !== undefined) {
    const connectionId = requireNativeId(value.connectionId, "connectionId", 256)
    const tool = await runtime.connections.getTool(connectionId)
    if (tool.authMode !== "api-key") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "connection does not take a pasted key")
    await broker.vault.set(connectionId, { kind: "api-key", secret })
    return runtime.connections.get(connectionId)
  }
  const accountId = requireNativeId(value.accountId, "accountId", 256)
  const record = await requireAccount(runtime, accountId)
  if (record.status === "revoked") throw new ControlRpcError("CONTROL_ACCOUNT_REVOKED", 409, "account is revoked")
  if (record.reference.authMode !== "api-key") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "account does not take a pasted key")
  refuseKeyOnSignInOnly(record)
  await broker.store(record.reference, { kind: "api-key", secret })
  return redactAccount(await requireAccount(runtime, accountId))
}

const MAX_LOGIN_INPUT_BODY_BYTES = 16 * 1024

/**
 * Takes the address the user landed on when the browser could not reach Runrail by itself. It holds
 * a one-time sign-in code: not logged, not journaled, not echoed, and no method reads it back.
 */
async function submitSignInInput(request: Request, runtime: NativeControlRuntime): Promise<SignInSnapshot> {
  const signIn = requireSignIn(runtime)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, MAX_LOGIN_INPUT_BODY_BYTES)))
  } catch (error) {
    if (error instanceof ControlRpcError) throw error
    throw new ControlRpcError("CONTROL_INVALID_JSON", 400, "sign-in input JSON cannot be parsed")
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "loginId" && key !== "input")) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "sign-in input must contain loginId and input only")
  if (typeof value.input !== "string") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "input is invalid")
  return signIn.submit(requireLoginId(value.loginId), value.input)
}

function requireSignIn(runtime: NativeControlRuntime): SignInManager {
  if (runtime.signIn === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 409, "no credential vault is configured")
  return runtime.signIn
}

function requireLoginId(value: unknown): string {
  if (typeof value !== "string" || !/^login-[0-9a-f-]{36}$/.test(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "loginId is invalid")
  return value
}

/**
 * When a vault holds the credential, `ready` means "the vault has it" and only the vault path may say
 * so. A client that creates or edits such an account keeps the status the engine last recorded.
 */
async function vaultOwnedStatus(runtime: NativeControlRuntime, record: AccountRecord): Promise<AccountRecord> {
  const mode = record.reference.authMode
  if (runtime.vaultBroker === undefined || (mode !== "api-key" && mode !== "oauth" && mode !== "device")) return record
  const existing = await runtime.accounts.get(record.reference.accountId)
  const kept = existing !== undefined && existing.reference.authMode === mode && existing.reference.provider === record.reference.provider && existing.status !== "revoked" ? existing : undefined
  return parseAccountRecord({
    reference: record.reference,
    status: kept?.status ?? "unconfigured",
    ...(kept?.statusCode === undefined ? {} : { statusCode: kept.statusCode }),
    ...(kept?.lastCheckedAt === undefined ? {} : { lastCheckedAt: kept.lastCheckedAt }),
  })
}

/**
 * A plan address (`signInOnly`) takes only what its sign-in stores. A pasted or shell key belongs
 * on the vendor's key row, so it is refused when the connection is made or the key is typed, not
 * later when a turn fails.
 */
function refuseKeyOnSignInOnly(record: AccountRecord): void {
  const mode = record.reference.authMode
  if (mode === "oauth" || mode === "device") return
  if (getProviderPreset(connectionPresetId(record.reference))?.signInOnly === true)
    throw new ControlRpcError("CONTROL_ACCOUNT_SIGN_IN_ONLY", 400, "this provider is reached through its sign-in; use its key row for a pasted key")
}

/**
 * A stored credential stays with the provider and host it was saved for. Changing either would send
 * the key somewhere its owner never chose, so the account has to be removed and added again.
 */
async function requireSameDestination(runtime: NativeControlRuntime, record: AccountRecord): Promise<void> {
  const existing = await runtime.accounts.get(record.reference.accountId)
  if (existing === undefined || existing.status === "revoked") return
  if (existing.reference.authMode !== record.reference.authMode || connectionDestination(existing.reference) !== connectionDestination(record.reference))
    throw new ControlRpcError("CONTROL_ACCOUNT_ENDPOINT_LOCKED", 409, "an account keeps its provider, address and sign-in type; remove it and add a new one")
}

/**
 * The older provider methods let the caller name the endpoint. That is fine for a key the caller
 * owns, never for one Runrail stores: those only travel through `connectionId`.
 */
async function refuseStoredCredentialOnCallerEndpoint(runtime: NativeControlRuntime, params: Record<string, unknown>): Promise<void> {
  if (params.accountId === undefined) return
  const account = await runtime.accounts.get(requireNativeId(params.accountId, "accountId", 256))
  const mode = account?.reference.authMode
  if (mode === "api-key" || mode === "oauth" || mode === "device") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "this account is used through connectionId")
  const environment = account?.reference.environmentName
  if (environment === undefined) return
  const provider = parseScalarEnum(params.provider, ["openai", "anthropic", "openai-compatible", "xai"], "provider")
  const endpoint = params.endpoint === undefined ? undefined : requireBoundedString(params.endpoint, "endpoint", 2_048)
  if (provider !== undefined && !keyVariableAllowedAt(environment, providerDestination(provider, endpoint))) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "this key belongs to another provider's address")
}

/** The address a provider request reaches once its family's default fills an omitted endpoint. */
function providerDestination(provider: ProviderModelOptions["provider"], endpoint: string | undefined): string {
  try {
    return resolveProviderTarget({ provider, ...(endpoint === undefined ? {} : { endpoint }) }).endpoint
  } catch {
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "provider endpoint is invalid")
  }
}

function connectionFor(record: AccountRecord, resolver: ProviderCredentialResolver): ResolvedConnection {
  try {
    return resolveConnection(record, resolver)
  } catch (error) {
    if (error instanceof AccountError && error.code === "ACCOUNT_REVOKED") throw new ControlRpcError("CONTROL_ACCOUNT_REVOKED", 409, "account is revoked")
    if (error instanceof ProviderError) throw new ControlRpcError(error.code === "PROVIDER_ENDPOINT_DENIED" ? "CONTROL_CONNECTION_ENDPOINT_DENIED" : "CONTROL_CONNECTION_INVALID", 400, error.message)
    throw error
  }
}

/** The shared check, with a record that cannot be a connection refused in this server's own words. */
function probeConnection(runtime: NativeControlRuntime, record: AccountRecord): Promise<ConnectionCheck> {
  return checkConnection(record, runtime.credentialResolver, { resolve: connectionFor })
}

const CONNECTION_OWNED_PARAMS = ["provider", "endpoint", "protocol", "headers", "accountId", "credentialEnvironment", "allowRemote", "allowInsecureRemote", "apiKey", "token", "secret", "credential"] as const

/** Provider options for a connection. Everything but the model and reasoning level comes from the stored account. */
async function parseConnectionModel(runtime: NativeControlRuntime, params: Record<string, unknown>, metadata: ModelMetadataSource): Promise<ProviderModelOptions> {
  for (const key of CONNECTION_OWNED_PARAMS) if (Object.hasOwn(params, key)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${key} cannot be set with connectionId`)
  const connectionId = requireNativeId(params.connectionId, "connectionId", 256)
  const record = await requireAccount(runtime, connectionId)
  const model = requireBoundedString(params.model, "model", 256)
  await runtime.connections.requireProviderModel(connectionId, model)
  const connection = connectionFor(record, runtime.credentialResolver)
  const thinking = parseScalarEnum(params.thinking, THINKING_LEVELS, "thinking")
  const facts = modelDescriptorFacts(metadata, connection.presetId, model)
  return Object.freeze({
    ...connection.options,
    model,
    ...(thinking === undefined ? {} : { thinking }),
    ...(facts === undefined ? {} : { descriptor: facts }),
  })
}

/**
 * Whether a tool connection can run: the tool's own answer about its sign-in, read with the
 * connection's folder, or for a key connection whether a key is stored. Never the key or the account.
 */
async function toolConnectionStatus(runtime: NativeControlRuntime, services: ControlServices, connectionId: string): Promise<Record<string, unknown>> {
  const tool = await runtime.connections.getTool(connectionId)
  const home = toolConnectionHome(runtime.accountsRoot, tool)
  const base = { connectionId, tool: tool.tool, authMode: tool.authMode, separateAccount: home !== undefined, enabled: tool.enabled }
  const vault = runtime.vaultBroker?.vault
  if (tool.authMode === "api-key") return { ...base, keyStored: vault !== undefined && await hasToolConnectionKey(vault, connectionId) }
  const probe = await probeHarness(tool.tool as HarnessProbeTarget, { ...services.harnesses.probe, routeEnv: harnessAccountEnvironment(tool.tool, home === undefined ? undefined : { configDir: home }), models: false })
  return { ...base, installed: probe.installed, ...(probe.version === undefined ? {} : { version: probe.version }), ...(probe.signedIn === undefined ? {} : { signedIn: probe.signedIn }) }
}

async function requireAccount(runtime: NativeControlRuntime, accountId: string): Promise<AccountRecord> {
  const account = await runtime.accounts.get(accountId)
  if (account === undefined) throw new ControlRpcError("CONTROL_ACCOUNT_NOT_FOUND", 404, "account was not found")
  return account
}

function parseRpcAccountRecord(params: Record<string, unknown>): AccountRecord {
  const now = Date.now()
  const createdAt = params.createdAt === undefined ? now : parseRequiredTimestamp(params.createdAt, "createdAt")
  const updatedAt = params.updatedAt === undefined ? now : parseRequiredTimestamp(params.updatedAt, "updatedAt")
  const reference = {
    accountId: requireNativeId(params.accountId, "accountId", 256),
    provider: requireNativeId(params.provider, "provider", 128),
    label: requireNativeText(params.label, "label", 160),
    authMode: parseAccountAuthMode(params.authMode),
    scopes: parseNativeCapabilityList(params.scopes, "scopes", 64),
    ...(params.environmentName === undefined ? {} : { environmentName: requireEnvironmentName(params.environmentName) }),
    ...(params.preset === undefined ? {} : { preset: requireNativeId(params.preset, "preset", 128) }),
    // Shape and credential checks for these two live in the account parser below.
    ...(params.baseUrl === undefined ? {} : { baseUrl: params.baseUrl }),
    ...(params.headers === undefined ? {} : { headers: params.headers }),
    createdAt,
    updatedAt,
  }
  try {
    return parseAccountRecord({
      reference,
      status: parseAccountStatus(params.status),
      ...(params.statusCode === undefined ? {} : { statusCode: requireNativeText(params.statusCode, "statusCode", 128) }),
      ...(params.expiresAt === undefined ? {} : { expiresAt: parseRequiredTimestamp(params.expiresAt, "expiresAt") }),
      ...(params.lastCheckedAt === undefined ? {} : { lastCheckedAt: parseRequiredTimestamp(params.lastCheckedAt, "lastCheckedAt") }),
    })
  } catch (error) {
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, error instanceof AccountError ? error.code : "account record is invalid")
  }
}

function parseAccountAuthMode(value: unknown): AccountAuthMode {
  const mode = parseScalarEnum(value, ["environment", "api-key", "api-key-reference", "oauth", "device", "service-account", "caller"], "authMode")
  if (mode === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "authMode is required")
  return mode
}

function parseAccountStatus(value: unknown): AccountRecord["status"] {
  return parseScalarEnum(value, ["unconfigured", "ready", "expired", "refreshing", "error", "revoked"], "status") ?? "unconfigured"
}

function requireEnvironmentName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "environmentName is invalid")
  return value
}

function parseNativeCapabilityList(value: unknown, name: string, maxItems: number): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > maxItems) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item) || result.includes(item)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
    result.push(item)
  }
  return Object.freeze(result)
}

function rejectRawCredentialFields(params: Record<string, unknown>): void {
  const forbidden = ["secret", "token", "apiKey", "password", "accessToken", "refreshToken", "credential"]
  if (Object.keys(params).some((key) => forbidden.includes(key))) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "credential values must use an account reference")
}

const SHARE_LOCKS = new WeakMap<object, Map<string, Promise<unknown>>>()

/** One share's read, check and write run one at a time, so a request that read it earlier cannot undo a later one, such as a revoke. */
async function withShareLock<T>(runtime: NativeControlRuntime, shareId: string, run: () => Promise<T>): Promise<T> {
  let locks = SHARE_LOCKS.get(runtime.shares)
  if (locks === undefined) SHARE_LOCKS.set(runtime.shares, locks = new Map())
  const current = (locks.get(shareId) ?? Promise.resolve()).then(run)
  const settled = current.then(() => undefined, () => undefined)
  locks.set(shareId, settled)
  try {
    return await current
  } finally {
    if (locks.get(shareId) === settled) locks.delete(shareId)
  }
}

async function requireShare(runtime: NativeControlRuntime, shareId: string): Promise<import("./share/types.ts").ShareReference> {
  const share = await runtime.shares.get(shareId)
  if (share === undefined) throw new ControlRpcError("CONTROL_SHARE_NOT_FOUND", 404, "share was not found")
  if (share.expiresAt !== undefined && share.expiresAt <= Date.now() && share.status === "active") {
    const expired = Object.freeze({ ...share, status: "expired" as const, revision: share.revision + 1 })
    await runtime.shares.put(expired)
    return expired
  }
  return share
}

async function requireShareTaskScope(
  share: import("./share/types.ts").ShareReference,
  runtime: NativeControlRuntime,
  controller: RunrailSessionController,
): Promise<import("./task/types.ts").NativeTaskRecord> {
  const task = await runtime.taskKernel.snapshot(share.taskId)
  requireTaskScope(task, runtime, controller)
  return task
}

async function listScopedShares(
  runtime: NativeControlRuntime,
  controller: RunrailSessionController,
): Promise<readonly import("./share/types.ts").ShareReference[]> {
  const visible: import("./share/types.ts").ShareReference[] = []
  for (const share of await runtime.shares.list()) {
    try {
      await requireShareTaskScope(share, runtime, controller)
      visible.push(share)
    } catch (error) {
      if (error instanceof NativeContractError && (error.code === "NATIVE_NOT_FOUND" || error.code === "NATIVE_AUTH_REQUIRED")) {
        // A list must not reveal whether a foreign or orphaned share exists.
        continue
      }
      throw error
    }
  }
  return Object.freeze(visible)
}

function parseShareMode(value: unknown): ShareMode {
  return parseScalarEnum(value, ["local-export", "encrypted-invite", "read-only-live", "collaborative", "artifact-only"], "mode") ?? "local-export"
}

function parseShareRole(value: unknown): ShareRole {
  return parseScalarEnum(value, ["owner", "editor", "reviewer", "viewer"], "role") ?? "viewer"
}

function parseRpcSharePayload(value: unknown): SharePayloadPolicy {
  if (value === undefined) return Object.freeze({ kind: "none", encrypted: false })
  if (!isRecord(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "payload policy is invalid")
  const kind = parseScalarEnum(value.kind, ["none", "encrypted-transcript", "encrypted-artifact"], "payload.kind") ?? "none"
  const encrypted = requireBoolean(value.encrypted, "payload.encrypted")
  const retentionSeconds = parseOptionalBound(value.retentionSeconds, 1, 31_536_000, "payload.retentionSeconds")
  if (kind !== "none" && !encrypted) throw new ControlRpcError("SHARE_CRYPTO_REQUIRED", 409, "payload-bearing shares must be encrypted")
  return Object.freeze({ kind, encrypted, ...(retentionSeconds === undefined ? {} : { retentionSeconds }) })
}

function parseRpcShareArtifacts(value: unknown): readonly import("./share/types.ts").ShareArtifactReference[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 128) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "artifacts are invalid")
  try {
    return Object.freeze(value.map((item) => parseShareArtifact(item)))
  } catch {
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "artifacts are invalid")
  }
}

function taskDigest(task: import("./task/types.ts").NativeTaskRecord): string {
  return createHash("sha256").update(JSON.stringify({ taskId: task.taskId, projectId: task.projectId, sessionId: task.sessionId, status: task.status, revision: task.revision, lastEventSeq: task.lastEventSeq, terminalCode: task.terminalCode })).digest("hex")
}

function errorStatus(error: unknown): number {
  if (error instanceof ControlRpcError) return error.status
  if (error instanceof GitError) return error.status
  if (error instanceof RunrailControlError) return 409
  if (error instanceof RunrailSessionError) return error.code === "SESSION_ANSWERS_INVALID" ? 400 : error.code === "SESSION_COMPACT_UNSUPPORTED" ? 501 : error.code === "SESSION_COMPACT_FAILED" || error.code === "SESSION_COMPACT_INVALID" ? 502 : 409
  if (error instanceof NativeContractError) {
    if (error.code === "NATIVE_NOT_FOUND") return 404
    if (error.code === "NATIVE_AUTH_REQUIRED") return 403
    if (error.code === "NATIVE_LIMIT") return 413
    if (error.code === "NATIVE_INVALID" || error.code === "NATIVE_UNSUPPORTED_VERSION") return 400
    if (error.code === "NATIVE_STATE_CONFLICT" || error.code === "NATIVE_IDEMPOTENCY_CONFLICT" || error.code === "NATIVE_CURSOR_EXPIRED" || error.code === "NATIVE_CANCELLED") return 409
  }
  if (error instanceof CredentialStoreError) return 503
  if (error instanceof SignInError) {
    if (error.code === "AUTH_LOGIN_NOT_FOUND" || error.code === "AUTH_FLOW_UNKNOWN") return 404
    if (error.code === "AUTH_INVALID" || error.code === "AUTH_INPUT_INVALID" || error.code === "AUTH_STATE_MISMATCH") return 400
    if (error.code === "AUTH_STORE_FAILED") return 503
    return 409
  }
  if (error instanceof ProviderError) {
    // Never 401: clients read that as a bad control token, not a bad provider key.
    if (error.code === "PROVIDER_INVALID" || error.code === "PROVIDER_ENDPOINT_DENIED" || error.code === "PROVIDER_CONTENT_UNSUPPORTED") return 400
    if (error.code === "PROVIDER_CREDENTIALS" || error.code === "PROVIDER_AUTH_FAILED" || error.code === "PROVIDER_CALLER_OWNED" || error.code === "PROVIDER_CANCELLED") return 409
    if (error.code === "PROVIDER_RATE_LIMITED") return 429
    if (error.code === "PROVIDER_TIMEOUT") return 504
    return 502
  }
  if (error instanceof ToolLoginError) {
    if (error.code === "TOOL_LOGIN_NOT_FOUND") return 404
    if (error.code === "TOOL_LOGIN_LIMIT") return 429
    if (error.code === "TOOL_LOGIN_UNAVAILABLE") return 501
    return 409
  }
  if (error instanceof ConnectionSettingsError) {
    if (error.code === "CONNECTION_NOT_FOUND") return 404
    if (error.code === "CONNECTION_INVALID" || error.code === "CONNECTION_MODELS_EMPTY" || error.code === "CONNECTION_MODEL_NOT_CHOSEN" || error.code === "CONNECTION_AUTH_UNSUPPORTED") return 400
    if (error.code === "CONNECTION_LIMIT") return 413
    return 409
  }
  if (error instanceof AccountError) {
    if (error.code === "ACCOUNT_NOT_FOUND") return 404
    if (error.code === "ACCOUNT_INVALID") return 400
    if (error.code === "ACCOUNT_LIMIT") return 413
    return 409
  }
  if (error instanceof ShareError) {
    if (error.code === "SHARE_NOT_FOUND") return 404
    if (error.code === "SHARE_INVALID") return 400
    if (error.code === "SHARE_LIMIT") return 413
    if (error.code === "SHARE_ACCESS_DENIED") return 403
    return 409
  }
  return 500
}
interface RpcRequest {
  readonly protocol: number
  readonly method: string
  readonly params: Record<string, unknown>
}

async function readRpcRequest(request: Request, maxBodyBytes: number): Promise<RpcRequest> {
  const body = await readBoundedBody(request, maxBodyBytes)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch {
    throw new ControlRpcError("CONTROL_INVALID_JSON", 400, "control request JSON cannot be parsed")
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ControlRpcError("CONTROL_INVALID_JSON", 400, "control request JSON cannot be parsed")
  }
  if (!isRecord(value) || typeof value.method !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.method))
    throw new ControlRpcError("CONTROL_INVALID_REQUEST", 400, "control method is invalid")
  if (value.params !== undefined && !isRecord(value.params))
    throw new ControlRpcError("CONTROL_INVALID_REQUEST", 400, "control params must be an object")
  const protocol = value.protocol === undefined ? RUNRAIL_CONTROL_PROTOCOL : parseRpcProtocol(value.protocol)
  if (protocol !== RUNRAIL_CONTROL_PROTOCOL)
    throw new ControlRpcError("CONTROL_UNSUPPORTED_VERSION", 400, "control protocol version is unsupported")
  return { protocol, method: value.method, params: value.params === undefined ? {} : value.params }
}

async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    if (!/^\d{1,16}$/.test(contentLength))
      throw new ControlRpcError("CONTROL_INVALID_REQUEST", 400, "content length is invalid")
    const declared = Number.parseInt(contentLength, 10)
    if (!Number.isSafeInteger(declared))
      throw new ControlRpcError("CONTROL_INVALID_REQUEST", 400, "content length is invalid")
    if (declared > maxBodyBytes)
      throw new ControlRpcError("CONTROL_BODY_LIMIT", 413, "control request exceeds body limit")
  }
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBodyBytes) {
        try {
          await reader.cancel()
        } catch {
          // The body is already over the limit; cancellation is best effort.
        }
        throw new ControlRpcError("CONTROL_BODY_LIMIT", 413, "control request exceeds body limit")
      }
      chunks.push(next.value)
    }
  } catch (error) {
    if (error instanceof ControlRpcError) throw error
    throw new ControlRpcError("CONTROL_BODY_READ_FAILED", 400, "control request body could not be read")
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function parseRpcProtocol(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 255)
    throw new ControlRpcError("CONTROL_INVALID_REQUEST", 400, "control protocol version is invalid")
  return value
}

function parseControlInput(params: Record<string, unknown>): RunrailControlInput {
  if (typeof params.message === "string") {
    if (params.message.length === 0 || params.message.length > MAX_PROMPT_CHARS)
      throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "message is invalid")
    return params.message
  }
  const value = params.message
  if (!isRecord(value) || typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_PROMPT_CHARS)
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "message is invalid")
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > 16))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "attachments are invalid")
  const attachments: Array<{ readonly path: string; readonly kind: "file" | "image"; readonly mediaType?: string }> = []
  for (const item of value.attachments ?? []) {
    if (!isRecord(item) || typeof item.path !== "string" || item.path.length === 0 || item.path.length > 512)
      throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "attachment is invalid")
    const kind = item.kind
    if (kind !== "file" && kind !== "image")
      throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "attachment is invalid")
    const mediaType = item.mediaType
    if (mediaType !== undefined && (typeof mediaType !== "string" || mediaType.length === 0 || mediaType.length > 128))
      throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "attachment media type is invalid")
    attachments.push({
      path: item.path,
      kind,
      ...(mediaType === undefined ? {} : { mediaType }),
    })
  }
  if (value.skills === undefined) return { text: value.text, attachments: Object.freeze(attachments) }
  if (!Array.isArray(value.skills) || value.skills.length > 8) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "skills are invalid")
  const skills = value.skills.map(requireBoundedSkillId)
  return { text: value.text, attachments: Object.freeze(attachments), skills: Object.freeze(skills) }
}

function parseTranscriptReadOptions(params: Record<string, unknown>): TranscriptReadOptions {
  const maxRecords = parseOptionalBound(params.maxRecords, 1, 16_384, "maxRecords")
  const afterSeq = parseOptionalBound(params.afterSeq, -1, 1_000_000, "afterSeq")
  const maxBytes = parseOptionalBound(params.maxBytes, 1, MAX_CONTROL_TRANSCRIPT_BYTES, "maxBytes") ?? 4 * 1024 * 1024
  return Object.freeze({
    ...(maxRecords === undefined ? {} : { maxRecords }),
    ...(afterSeq === undefined ? {} : { afterSeq }),
    maxBytes,
  })
}

function parseTranscriptAppendInput(value: unknown): TranscriptAppendInput {
  if (!isRecord(value) || typeof value.kind !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(value.kind) || !Object.hasOwn(value, "payload"))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "transcript replacement is invalid")
  const id = value.id === undefined ? undefined : parseToken(value.id, "id", 256)
  const parentId = value.parentId === undefined ? undefined : parseToken(value.parentId, "parentId", 256)
  let bytes: number
  try {
    const encoded = JSON.stringify(value.payload)
    bytes = encoded === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(encoded, "utf8")
  } catch {
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "transcript replacement payload is invalid")
  }
  if (bytes > 256 * 1024) throw new ControlRpcError("CONTROL_BODY_LIMIT", 413, "transcript replacement payload is too large")
  return Object.freeze({ kind: value.kind, payload: value.payload, ...(id === undefined ? {} : { id }), ...(parentId === undefined ? {} : { parentId }) })
}

async function readConversation(
  controller: RunrailSessionController,
  live: ConversationBuilder,
  params: Record<string, unknown>,
): Promise<{ readonly sessionId: string; readonly source: "live" | "transcript"; readonly items: readonly import("./conversation/index.ts").ConversationItem[]; readonly truncated: boolean; readonly lastSeq: number }> {
  const currentId = controller.session.snapshot.id
  const sessionId = optionalSessionId(params.sessionId) ?? currentId
  const maxItems = parseOptionalBound(params.maxItems, 1, MAX_CONVERSATION_ITEMS, "maxItems") ?? 512
  const maxBytes = parseOptionalBound(params.maxBytes, 1_024, MAX_CONTROL_TRANSCRIPT_BYTES, "maxBytes") ?? 4 * 1024 * 1024
  const requested = parseScalarEnum(params.source, ["auto", "live", "transcript"], "source") ?? "auto"
  const store = controller.session.transcriptStore
  const source = requested === "auto" ? (store === undefined ? "live" : "transcript") : requested
  if (source === "live") {
    if (sessionId !== currentId) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "live conversation is only available for the current session")
    const bounded = boundConversationItems(live.items(maxItems), maxBytes)
    return { sessionId, source, items: bounded.items, truncated: bounded.truncated || live.truncated || live.size > maxItems, lastSeq: live.lastSequence }
  }
  const transcripts = requireTranscriptStore(controller)
  let records: readonly import("./transcript/index.ts").TranscriptRecord[]
  try {
    records = await transcripts.read(sessionId)
  } catch (error) {
    throw mapTranscriptError(error)
  }
  const builder = new ConversationBuilder({ maxItems, root: controller.session.policy.root })
  for (const record of records) {
    const entry = transcriptEntry(record)
    if (entry !== undefined) builder.add(entry)
  }
  const bounded = boundConversationItems(builder.items(), maxBytes)
  return { sessionId, source, items: bounded.items, truncated: bounded.truncated || builder.truncated, lastSeq: builder.lastSequence }
}

/**
 * A coding tool's plan usage for one account with no thread running: the tool's usual login, or a
 * connection signed in from its own folder. A key connection has no plan, so no tool is started.
 * Accounts that share a login share one reading.
 */
async function readToolUsage(usage: ControlServices["usage"], nativeRuntime: NativeControlRuntime, params: Record<string, unknown>): Promise<{ readonly plan: RunrailPlanLimitsFrame; readonly account?: UsageAccountIdentity }> {
  if (params.refresh !== undefined && typeof params.refresh !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "refresh must be a boolean")
  const tool = parseScalarEnum(params.tool, ["claude-code", "codex"], "tool")
  if (tool === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "tool is required")
  let configDir: string | undefined
  if (params.connectionId !== undefined) {
    const connection = await nativeRuntime.connections.requireTool(requireNativeId(params.connectionId, "connectionId", 256), tool)
    if (connection.authMode === "api-key") throw new ControlRpcError("USAGE_UNAVAILABLE", 409, "a key connection has no plan usage")
    configDir = (await toolConnectionAccount(connection, { accountsRoot: nativeRuntime.accountsRoot }))?.configDir
  }
  await mkdir(usage.cwd, { recursive: true, mode: 0o700 })
  try {
    const { account, ...plan } = await usage.reader.read(`${tool}:${configDir ?? "usual"}`, tool, { cwd: usage.cwd, ...(configDir === undefined ? {} : { configDir }) }, params.refresh === true)
    return { plan, ...(account === undefined ? {} : { account }) }
  } catch (error) {
    if (error instanceof UsageReadError) throw new ControlRpcError(error.code, error.code === "TOOL_UNAVAILABLE" ? 501 : 409, error.message)
    throw error
  }
}

const MAX_PEEK_ITEMS = 2_048
const MAX_PEEK_BYTES = 4 * 1024 * 1024

/**
 * Copies a thread's conversation to a new, empty thread: a rewind's kept copy, or
 * with `beforeSeq` a fork from before that message. The copy is marked as continued from the
 * original, so a coding tool there starts with a recap.
 */
async function copyThread(threadsDir: string | undefined, params: Record<string, unknown>): Promise<{ readonly copied: boolean }> {
  if (threadsDir === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, "this engine was started without a threads folder")
  const from = optionalSessionId(params.from)
  const to = optionalSessionId(params.to)
  if (from === undefined || to === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "from and to are required")
  if (from === to) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "a thread cannot be copied onto itself")
  const beforeSeq = parseOptionalBound(params.beforeSeq, 0, 1_000_000, "beforeSeq")
  const target = new FileTranscriptStore({ root: join(threadsDir, to, "transcript") })
  try {
    if ((await target.read(to, { maxRecords: 1 })).length > 0) throw new ControlRpcError("CONTROL_TRANSCRIPT_CONFLICT", 409, "the copy's thread already has a conversation")
    return { copied: await continueTranscript(new FileTranscriptStore({ root: join(threadsDir, from, "transcript") }), from, target, to, beforeSeq) }
  } catch (error) {
    throw mapTranscriptError(error)
  }
}

/** Exactly one of `userSeq` (a message's seq in the transcript as read now) and `turnId`. */
function parseRewindTarget(params: Record<string, unknown>): RunrailRewindTarget {
  if ((params.userSeq === undefined) === (params.turnId === undefined)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "give userSeq or turnId")
  return params.userSeq === undefined ? { turnId: requireBoundedString(params.turnId, "turnId", 256) } : { userSeq: parseRequiredBound(params.userSeq, 0, 1_000_000, "userSeq") }
}

function parseRewindFiles(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 5_000) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "files must be a list of at most 5000 paths")
  return value.map((path) => requireBoundedString(path, "file path", 4_096))
}

/**
 * Another thread's conversation from its transcript, read without changing it, so a client can
 * show it before that thread's own engine is ready. The items are those `session.conversation.read`
 * gives for the same transcript; `workspace` is the thread's folder, used only to show paths.
 */
async function peekConversation(threadsDir: string | undefined, params: Record<string, unknown>): Promise<{ readonly threadId: string; readonly items: readonly import("./conversation/index.ts").ConversationItem[]; readonly truncated: boolean; readonly lastSeq: number }> {
  if (threadsDir === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, "this engine was started without a threads folder")
  const threadId = optionalSessionId(params.threadId)
  if (threadId === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "threadId is required")
  const workspace = params.workspace
  if (typeof workspace !== "string" || workspace.length === 0 || workspace.length > 4_096 || workspace.includes("\0") || !isAbsolute(workspace))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "workspace must be an absolute folder path")
  const root = await realpath(workspace).catch(() => undefined)
  if (root === undefined || !(await stat(root)).isDirectory()) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "workspace is not an existing folder")
  const maxItems = parseOptionalBound(params.maxItems, 1, MAX_PEEK_ITEMS, "maxItems") ?? 512
  let records: readonly import("./transcript/index.ts").TranscriptRecord[]
  try {
    records = await peekTranscript(join(threadsDir, threadId, "transcript", `${threadId}.jsonl`), threadId)
  } catch (error) {
    throw mapTranscriptError(error)
  }
  const builder = new ConversationBuilder({ maxItems, root })
  for (const record of records) {
    const entry = transcriptEntry(record)
    if (entry !== undefined) builder.add(entry)
  }
  const bounded = boundConversationItems(builder.items(), MAX_PEEK_BYTES)
  return { threadId, items: bounded.items, truncated: bounded.truncated || builder.truncated, lastSeq: builder.lastSequence }
}

/**
 * Copies another harness's local session into this session's empty transcript, then loads it as
 * model history so the next turn continues it. Only a fresh thread can import; a thread that
 * already ran turns would hand the model the same conversation twice.
 */
async function importExternalSession(
  controller: RunrailSessionController,
  external: ControlServices["external"],
  params: Record<string, unknown>,
): Promise<{ readonly sessionId: string; readonly source: ExternalSessionSource; readonly title?: string; readonly imported: number; readonly historyMessages: number; readonly truncated?: true; readonly inTool?: true }> {
  const store = requireTranscriptStore(controller)
  let source: ExternalSessionSource
  let id: string
  try {
    source = parseExternalSource(params.source)
    id = parseExternalId(params.id)
  } catch (error) {
    throw mapExternalError(error)
  }
  // "tool": the thread runs on the session's own tool and continues a copy of it there.
  if (params.continueIn !== undefined && params.continueIn !== "tool" && params.continueIn !== "runrail") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "continueIn must be tool or runrail")
  const inTool = params.continueIn === "tool"
  if (inTool && !controller.session.continuesToolSessions(source)) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 409, "this thread cannot continue that session in its own tool")
  ensureControllerIdle(controller)
  if (external.importing) throw new ControlRpcError("CONTROL_SESSION_BUSY", 409, "another import is in progress")
  external.importing = true
  try {
    const sessionId = controller.session.snapshot.id
    try {
      if ((await store.read(sessionId, { maxRecords: 1 })).length > 0)
        throw new ControlRpcError("CONTROL_TRANSCRIPT_CONFLICT", 409, "only a new thread can import a session")
    } catch (error) {
      throw mapTranscriptError(error)
    }
    let session: Awaited<ReturnType<typeof readExternalSession>>
    try {
      session = await readExternalSession({ cwd: controller.session.policy.root, source, id, roots: external.roots })
    } catch (error) {
      throw mapExternalError(error)
    }
    if (session.bundle.records.length === 0) throw new ControlRpcError("CONTROL_EXTERNAL_EMPTY", 422, "session has no conversation to import")
    // Seeded first, so a transcript never claims a continuation the tool would not make.
    if (inTool) await controller.session.seedToolSession(source, id)
    let imported: number
    try {
      imported = (await store.import(session.bundle, sessionId)).imported
      await store.append(sessionId, {
        kind: SESSION_IMPORTED,
        payload: { type: SESSION_IMPORTED, source, name: EXTERNAL_SOURCE_LABELS[source], id, ...session.mark, ...(session.truncated ? { truncated: true } : {}), ...(inTool ? { inTool: true } : {}) },
      })
    } catch (error) {
      if (inTool) await controller.session.seedToolSession(source, undefined).catch(() => undefined)
      throw mapTranscriptError(error)
    }
    const historyMessages = await controller.session.restoreHistory().catch(() => 0)
    await controller.session.prepareCarryover().catch(() => false)
    return {
      ...(controller.session.historyUnavailable ? { historyUnavailable: true as const } : {}),
      sessionId,
      source,
      ...(session.title === undefined ? {} : { title: session.title }),
      imported,
      historyMessages,
      ...(session.truncated ? { truncated: true as const } : {}),
      ...(inTool ? { inTool: true as const } : {}),
    }
  } finally {
    external.importing = false
  }
}

/**
 * Brings in the turns an imported session gained in its tool since the import. The import
 * marker holds how the session ended then; the session is read again and only what follows is
 * appended, under ids that would collide if it were appended twice. Only a thread that has not
 * moved on can take them, since they continue the session where the import left it.
 */
async function refreshExternalSession(
  controller: RunrailSessionController,
  external: ControlServices["external"],
  params: Record<string, unknown>,
): Promise<{ readonly sessionId: string; readonly source: ExternalSessionSource; readonly turns: number; readonly imported: number; readonly truncated?: true; readonly historyMessages?: number; readonly historyUnavailable?: true }> {
  const store = requireTranscriptStore(controller)
  if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "dryRun must be a boolean")
  const dryRun = params.dryRun === true
  if (!dryRun) ensureControllerIdle(controller)
  if (external.importing) throw new ControlRpcError("CONTROL_SESSION_BUSY", 409, "another import is in progress")
  external.importing = true
  try {
    const sessionId = controller.session.snapshot.id
    let records: readonly import("./transcript/index.ts").TranscriptRecord[]
    try {
      records = await store.read(sessionId)
    } catch (error) {
      throw mapTranscriptError(error)
    }
    let at = records.length - 1
    while (at >= 0 && records[at]!.kind !== SESSION_IMPORTED) at -= 1
    if (at < 0) throw new ControlRpcError("CONTROL_NOT_FOUND", 404, "this thread did not import a session")
    const marker = importMark(records[at]!.payload)
    if (marker === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 409, "this import cannot be refreshed; import the session again")
    if (records.slice(at + 1).some((record) => record.kind === "message.user")) throw new ControlRpcError("CONTROL_TRANSCRIPT_CONFLICT", 409, "the thread has moved on since the import")
    let session: Awaited<ReturnType<typeof readExternalSession>>
    try {
      session = await readExternalSession({ cwd: controller.session.policy.root, source: marker.source, id: marker.id, roots: external.roots, after: marker.mark })
    } catch (error) {
      throw mapExternalError(error)
    }
    if (session.grew !== true) throw new ControlRpcError("CONTROL_EXTERNAL_CHANGED", 409, "the session changed in its tool; import it again in a new thread")
    const fresh = session.bundle.records
    const prompts = fresh.filter((record) => record.kind === "message.user").length
    // New records without a new prompt finish the turn the import caught.
    const turns = fresh.length === 0 ? 0 : Math.max(prompts, 1)
    const result = { sessionId, source: marker.source, turns, ...(session.truncated ? { truncated: true as const } : {}) }
    if (dryRun || fresh.length === 0) return { ...result, imported: 0 }
    let imported: number
    try {
      const bundle = { version: session.bundle.version, sessionId, records: fresh.map((record, index) => ({ ...record, sessionId, seq: index, id: `${sessionId}:pulled:${session.first + index}` })) }
      imported = (await store.import(bundle, sessionId)).imported
      await store.append(sessionId, {
        kind: SESSION_IMPORTED,
        payload: { type: SESSION_IMPORTED, source: marker.source, name: EXTERNAL_SOURCE_LABELS[marker.source], id: marker.id, ...session.mark, refreshed: true, turns, ...(session.truncated ? { truncated: true } : {}), ...(marker.inTool ? { inTool: true } : {}) },
      })
    } catch (error) {
      throw mapTranscriptError(error)
    }
    const historyMessages = await controller.session.restoreHistory().catch(() => 0)
    await controller.session.prepareCarryover().catch(() => false)
    return { ...result, imported, historyMessages, ...(controller.session.historyUnavailable ? { historyUnavailable: true as const } : {}) }
  } finally {
    external.importing = false
  }
}

function importMark(payload: unknown): { readonly source: ExternalSessionSource; readonly id: string; readonly mark: { readonly records: number; readonly digest: string }; readonly inTool: boolean } | undefined {
  if (payload === null || typeof payload !== "object") return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.records !== "number" || typeof value.digest !== "string") return undefined
  try {
    return { source: parseExternalSource(value.source), id: parseExternalId(value.id), mark: { records: value.records, digest: value.digest }, inTool: value.inTool === true }
  } catch {
    return undefined
  }
}

function mapExternalError(error: unknown): ControlRpcError {
  if (error instanceof ControlRpcError) return error
  if (error instanceof ExternalSessionError) {
    if (error.code === "EXTERNAL_NOT_FOUND") return new ControlRpcError("CONTROL_NOT_FOUND", 404, error.message)
    if (error.code === "EXTERNAL_LIMIT") return new ControlRpcError("CONTROL_BODY_LIMIT", 413, error.message)
    return new ControlRpcError("CONTROL_INVALID_INPUT", 400, error.message)
  }
  return new ControlRpcError("CONTROL_EXTERNAL_FAILED", 502, "session could not be read")
}

async function readTranscriptRecords(
  controller: RunrailSessionController,
  options: TranscriptReadOptions,
): Promise<readonly import("./transcript/index.ts").TranscriptRecord[]> {
  const store = requireTranscriptStore(controller)
  try {
    const records = await store.read(controller.session.snapshot.id, options)
    ensureTranscriptResponseBytes(records, options.maxBytes ?? MAX_CONTROL_TRANSCRIPT_BYTES)
    return records
  } catch (error) {
    throw mapTranscriptError(error)
  }
}

async function exportTranscriptRecords(
  controller: RunrailSessionController,
  options: TranscriptReadOptions,
): Promise<string> {
  const records = await readTranscriptRecords(controller, options)
  const bundle = {
    version: RUNRAIL_TRANSCRIPT_VERSION,
    sessionId: controller.session.snapshot.id,
    records,
  }
  const encoded = JSON.stringify(bundle)
  if (Buffer.byteLength(encoded, "utf8") > (options.maxBytes ?? MAX_CONTROL_TRANSCRIPT_BYTES))
    throw new ControlRpcError("CONTROL_BODY_LIMIT", 413, "transcript export exceeds its byte limit")
  return encoded
}

function ensureTranscriptResponseBytes(value: unknown, maxBytes: number): void {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new ControlRpcError("CONTROL_TRANSCRIPT_INVALID", 502, "transcript records are not serializable")
  }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes)
    throw new ControlRpcError("CONTROL_BODY_LIMIT", 413, "transcript response exceeds its byte limit")
}

function mapTranscriptError(error: unknown): ControlRpcError {
  if (error instanceof ControlRpcError) return error
  if (isRecord(error) && typeof error.code === "string") {
    if (error.code === "TRANSCRIPT_LIMIT") return new ControlRpcError("CONTROL_BODY_LIMIT", 413, "transcript exceeds its byte limit")
    if (error.code === "TRANSCRIPT_CONFLICT") return new ControlRpcError("CONTROL_TRANSCRIPT_CONFLICT", 409, "transcript state conflicts")
    if (error.code === "TRANSCRIPT_INVALID" || error.code === "TRANSCRIPT_MIGRATION_UNSUPPORTED") return new ControlRpcError("CONTROL_TRANSCRIPT_INVALID", 400, "transcript is invalid")
  }
  return new ControlRpcError("CONTROL_TRANSCRIPT_FAILED", 502, "transcript store operation failed")
}

function parseWorkspacePath(value: unknown, name: string, allowEmpty = false): string {
  if (allowEmpty && (value === undefined || value === "")) return ""
  const path = requireBoundedString(value, name, 4_096)
  if (path.includes("\0") || /[\r\n]/.test(path) || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
    throw new ControlRpcError("CONTROL_WORKSPACE_INVALID", 400, `${name} must be relative to the workspace`)
  return path
}

/**
 * The project's related folders. `workspace.*` and `git.*` take `folder`, one of
 * them as the host named it or as its real path; paths are then relative to that folder.
 */
interface RelatedFolders {
  pick(value: unknown): string | undefined
  policy(folder: string): Promise<WorkspacePolicy>
  git(folder: string): GitWorkspace
}

function relatedFolders(given: readonly string[], real: readonly string[], hints: () => ReturnType<CodeHostStore["hints"]>): RelatedFolders {
  const known = new Map<string, string>()
  real.forEach((folder, index) => {
    known.set(folder, folder)
    const named = given[index]
    if (named !== undefined) known.set(named, folder)
  })
  const policies = new Map<string, Promise<WorkspacePolicy>>()
  const gits = new Map<string, GitWorkspace>()
  return {
    pick(value) {
      if (value === undefined) return undefined
      const folder = typeof value === "string" ? known.get(value) : undefined
      if (folder === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "folder is not one of this project's related folders")
      return folder
    },
    policy(folder) {
      let policy = policies.get(folder)
      if (policy === undefined) policies.set(folder, (policy = createWorkspacePolicy(folder)))
      return policy
    },
    git(folder) {
      let git = gits.get(folder)
      if (git === undefined) gits.set(folder, (git = new GitWorkspace({ root: folder, hints })))
      return git
    },
  }
}

async function workspaceFor(controller: RunrailSessionController, services: ControlServices, params: Record<string, unknown>): Promise<WorkspacePolicy> {
  const folder = services.folders.pick(params.folder)
  return folder === undefined ? controller.session.policy : services.folders.policy(folder)
}

async function listWorkspace(policy: WorkspacePolicy, params: Record<string, unknown>): Promise<unknown> {
  const path = parseWorkspacePath(params.path, "path", true)
  const maxDepth = parseOptionalBound(params.maxDepth, 0, 16, "maxDepth") ?? 2
  const maxEntries = parseOptionalBound(params.maxEntries, 1, 2_048, "maxEntries") ?? 256
  try {
    return { path, entries: await policy.list(path, maxDepth, maxEntries) }
  } catch (error) {
    throw mapWorkspaceError(error)
  }
}

async function readWorkspaceFile(policy: WorkspacePolicy, params: Record<string, unknown>): Promise<unknown> {
  const path = parseWorkspacePath(params.path, "path")
  const maxBytes = parseOptionalBound(params.maxBytes, 1, DEFAULT_MAX_FILE_BYTES, "maxBytes") ?? DEFAULT_MAX_FILE_BYTES
  try {
    const content = await policy.read(path, maxBytes)
    if (content.includes("\0")) throw new ControlRpcError("CONTROL_WORKSPACE_BINARY", 415, "workspace file is not a bounded text file")
    return { path, bytes: Buffer.byteLength(content, "utf8"), content, hash: textHash(content) }
  } catch (error) {
    throw mapWorkspaceError(error)
  }
}

/** The person's edit, saved only over the text `workspace.read` gave them (`baseHash`). */
async function writeWorkspaceFile(policy: WorkspacePolicy, params: Record<string, unknown>): Promise<unknown> {
  const path = parseWorkspacePath(params.path, "path")
  if (typeof params.content !== "string" || params.content.includes("\0")) throw new ControlRpcError("CONTROL_WORKSPACE_INVALID", 400, "content must be text")
  if (typeof params.baseHash !== "string" || !/^[0-9a-f]{64}$/.test(params.baseHash)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "baseHash must be the hash workspace.read returned")
  try {
    return await saveOverRead(policy, path, params.content, params.baseHash)
  } catch (error) {
    if (error instanceof WorkspaceEditError)
      throw error.code === "WORKSPACE_EDIT_CONFLICT" ? new ControlRpcError("CONTROL_WORKSPACE_CONFLICT", 409, error.message) : new ControlRpcError("CONTROL_WORKSPACE_BINARY", 415, "workspace file is not a bounded text file")
    throw mapWorkspaceError(error)
  }
}

function mapWorkspaceError(error: unknown): ControlRpcError {
  if (error instanceof ControlRpcError) return error
  if (isRecord(error) && error.code === "ENOENT") return new ControlRpcError("CONTROL_WORKSPACE_NOT_FOUND", 404, "workspace path was not found")
  if (error instanceof RangeError) return new ControlRpcError("CONTROL_WORKSPACE_LIMIT", 413, "workspace result exceeds its byte or entry limit")
  if (error instanceof TypeError) return new ControlRpcError("CONTROL_WORKSPACE_INVALID", 400, "workspace path or file is invalid")
  return new ControlRpcError("CONTROL_WORKSPACE_FORBIDDEN", 403, "workspace path is not authorized")
}

async function resolveTerminalCwd(controller: RunrailSessionController, value: unknown): Promise<string> {
  const path = parseWorkspacePath(value, "cwd", true)
  try {
    const absolute = path.length === 0 ? controller.session.policy.root : await controller.session.policy.resolveExisting(path)
    await controller.session.policy.list(path, 0, 1)
    return absolute
  } catch (error) {
    throw mapWorkspaceError(error)
  }
}

async function listBackground(services: ControlServices, params: Record<string, unknown>) {
  const withServers = optionalBoolean(params.servers) ?? true
  const entries = services.live.backgroundEntries()
  if (!withServers) return { entries, lastLiveSeq: services.live.lastLiveSeq }
  const now = Date.now()
  const cached = services.servers.cached
  const scan = cached !== undefined && now - cached.at < SERVER_SCAN_TTL_MS ? cached.value : scanServers().catch(() => ({ available: false, servers: [] }))
  if (scan !== cached?.value) services.servers.cached = { at: now, value: scan }
  const { available, servers } = await scan
  return { entries, servers, serversAvailable: available, lastLiveSeq: services.live.lastLiveSeq }
}

function backgroundId(params: Record<string, unknown>): string {
  const id = requireString(params.id, "id")
  if (id.length > 256 || /[\0\r\n]/.test(id)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "id is invalid")
  return id
}

function backgroundEntry(services: ControlServices, id: string) {
  const entry = services.live.backgroundEntry(id)
  if (entry === undefined) throw new ControlRpcError("BACKGROUND_NOT_FOUND", 404, "no background task has that id")
  return entry
}

async function readBackgroundOutput(services: ControlServices, params: Record<string, unknown>) {
  const id = backgroundId(params)
  const maxBytes = parseOptionalBound(params.maxBytes, 1, BACKGROUND_OUTPUT_MAX, "maxBytes") ?? BACKGROUND_OUTPUT_DEFAULT
  backgroundEntry(services, id)
  const read = services.live.backgroundControl(id)?.output
  if (read === undefined) throw new ControlRpcError("BACKGROUND_OUTPUT_UNAVAILABLE", 409, "this task's output stays with the tool that ran it")
  let output: { readonly text: string; readonly truncated: boolean }
  try {
    output = await read(maxBytes)
  } catch {
    throw new ControlRpcError("BACKGROUND_OUTPUT_UNAVAILABLE", 409, "the output could not be read")
  }
  const text = typeof output.text === "string" ? output.text.slice(-maxBytes) : ""
  return { id, text, truncated: output.truncated === true || text.length < (output.text?.length ?? 0) }
}

async function stopBackground(services: ControlServices, params: Record<string, unknown>) {
  const id = backgroundId(params)
  const entry = backgroundEntry(services, id)
  // Stopping what already ended is a no-op, so a second click or a race with its end is harmless.
  if (entry.status !== "running") return { id, status: entry.status }
  const stop = services.live.backgroundControl(id)?.stop
  if (stop === undefined || !entry.stoppable) {
    throw new ControlRpcError("BACKGROUND_STOP_UNSUPPORTED", 409, entry.stopHint === "turn" ? "this task ends when its turn is stopped" : "this task cannot be stopped from Runrail")
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([stop(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), BACKGROUND_STOP_TIMEOUT_MS) })])
  } catch {
    throw new ControlRpcError("BACKGROUND_STOP_FAILED", 502, "the task could not be stopped")
  } finally {
    clearTimeout(timer)
  }
  return { id, status: services.live.backgroundEntry(id)?.status ?? "unknown" }
}

const BROWSER_CALL_MAX_BYTES = 64 * 1024
const BROWSER_ERROR_STATUS: Readonly<Record<BrowserError["code"], number>> = Object.freeze({
  BROWSER_INVALID_INPUT: 400,
  BROWSER_RESULT_INVALID: 400,
  BROWSER_SITE_REFUSED: 403,
  BROWSER_DENIED: 403,
  BROWSER_REQUEST_NOT_FOUND: 404,
  BROWSER_OFF: 409,
  BROWSER_CLOSED: 409,
  BROWSER_BUSY: 429,
  BROWSER_FAILED: 502,
  BROWSER_TIMEOUT: 504,
})

function parseBrowserTools(value: RunrailControlRpcServerOptions["browserTools"]): { readonly anySite: boolean; readonly mcpCommand?: readonly string[] } | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "browser tools option is invalid")
  if (value.anySite !== undefined && typeof value.anySite !== "boolean") throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "browser tools option is invalid")
  const command = value.mcpCommand
  if (command !== undefined && (!Array.isArray(command) || command.length === 0 || command.length > 4 || command.some((part) => typeof part !== "string" || part.length === 0 || part.length > 1_024 || part.includes("\0"))))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "browser MCP command is invalid")
  return Object.freeze({ anySite: value.anySite === true, ...(command === undefined ? {} : { mcpCommand: Object.freeze([...command]) }) })
}

function requireBrowser(services: ControlServices): BrowserBridge {
  if (services.browser === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, "this thread does not let the agent use the browser")
  return services.browser
}

function browserRpcError(error: unknown): unknown {
  return error instanceof BrowserError ? new ControlRpcError(error.code, BROWSER_ERROR_STATUS[error.code], error.message) : error
}

function browserPublicError(error: unknown): { readonly code: string; readonly message: string } {
  return publicError(browserRpcError(error))
}

async function readBrowserCall(request: Request): Promise<{ readonly action: BrowserAction; readonly input: unknown }> {
  const body = await readBoundedBody(request, BROWSER_CALL_MAX_BYTES)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown
  } catch {
    throw new BrowserError("BROWSER_INVALID_INPUT", "the call is not valid JSON")
  }
  if (!isRecord(value) || typeof value.action !== "string" || !BROWSER_ACTIONS.has(value.action as BrowserAction)) throw new BrowserError("BROWSER_INVALID_INPUT", "the browser action is unknown")
  return { action: value.action as BrowserAction, input: value.input }
}

/** Claims one announced request; its parameters are what the desktop acts on. */
function takeBrowserRequest(services: ControlServices, params: Record<string, unknown>) {
  const bridge = requireBrowser(services)
  try {
    const task = bridge.take(params.requestId)
    return { requestId: task.requestId, action: task.action, params: task.params, expiresAt: task.expiresAt, anySite: bridge.anySite }
  } catch (error) {
    throw browserRpcError(error)
  }
}

function respondToBrowserRequest(services: ControlServices, params: Record<string, unknown>) {
  const bridge = requireBrowser(services)
  try {
    bridge.respond(params.requestId, params.answer)
  } catch (error) {
    throw browserRpcError(error)
  }
  return { ok: true }
}

const THREADS_CALL_MAX_BYTES = 64 * 1024
const THREADS_ERROR_STATUS: Readonly<Record<ThreadsError["code"], number>> = Object.freeze({
  THREADS_INVALID_INPUT: 400,
  THREADS_RESULT_INVALID: 400,
  THREADS_DENIED: 403,
  THREADS_NOT_FOUND: 404,
  THREADS_REQUEST_NOT_FOUND: 404,
  THREADS_OFF: 409,
  THREADS_CLOSED: 409,
  THREADS_BUSY: 429,
  THREADS_LIMIT: 429,
  THREADS_FAILED: 502,
  THREADS_TIMEOUT: 504,
})

function parseThreadTools(value: RunrailControlRpcServerOptions["threadTools"]): { readonly mcpCommand?: readonly string[] } | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "thread tools option is invalid")
  const command = value.mcpCommand
  if (command !== undefined && (!Array.isArray(command) || command.length === 0 || command.length > 4 || command.some((part) => typeof part !== "string" || part.length === 0 || part.length > 1_024 || part.includes("\0"))))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "thread tools MCP command is invalid")
  return Object.freeze(command === undefined ? {} : { mcpCommand: Object.freeze([...command]) })
}

function requireThreads(services: ControlServices): ThreadsBridge {
  if (services.threads === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, "this thread does not let the agent reach other threads")
  return services.threads
}

function threadsRpcError(error: unknown): unknown {
  return error instanceof ThreadsError ? new ControlRpcError(error.code, THREADS_ERROR_STATUS[error.code], error.message) : error
}

async function readThreadsCall(request: Request): Promise<{ readonly action: ThreadsAction; readonly input: unknown }> {
  const body = await readBoundedBody(request, THREADS_CALL_MAX_BYTES)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown
  } catch {
    throw new ThreadsError("THREADS_INVALID_INPUT", "the call is not valid JSON")
  }
  if (!isRecord(value) || typeof value.action !== "string" || !THREADS_ACTIONS.has(value.action as ThreadsAction)) throw new ThreadsError("THREADS_INVALID_INPUT", "the thread action is unknown")
  return { action: value.action as ThreadsAction, input: value.input }
}

/** Claims one announced request; its parameters are what the desktop acts on. */
function takeThreadsRequest(services: ControlServices, params: Record<string, unknown>) {
  const bridge = requireThreads(services)
  try {
    const task = bridge.take(params.requestId)
    return { requestId: task.requestId, action: task.action, params: task.params, expiresAt: task.expiresAt }
  } catch (error) {
    throw threadsRpcError(error)
  }
}

function respondToThreadsRequest(services: ControlServices, params: Record<string, unknown>) {
  const bridge = requireThreads(services)
  try {
    bridge.respond(params.requestId, params.answer)
  } catch (error) {
    throw threadsRpcError(error)
  }
  return { ok: true }
}

const COMPUTER_CALL_MAX_BYTES = 16 * 1024
const COMPUTER_ERROR_STATUS: Readonly<Record<ComputerError["code"], number>> = Object.freeze({
  COMPUTER_INVALID_INPUT: 400,
  COMPUTER_RESULT_INVALID: 400,
  COMPUTER_DENIED: 403,
  COMPUTER_PERMISSION: 403,
  COMPUTER_NOT_FOUND: 404,
  COMPUTER_REQUEST_NOT_FOUND: 404,
  COMPUTER_OFF: 409,
  COMPUTER_CLOSED: 409,
  COMPUTER_BUSY: 429,
  COMPUTER_FAILED: 502,
  COMPUTER_TIMEOUT: 504,
})

function parseComputerTools(value: RunrailControlRpcServerOptions["computerTools"]): { readonly mcpCommand?: readonly string[] } | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "computer tools option is invalid")
  const command = value.mcpCommand
  if (command !== undefined && (!Array.isArray(command) || command.length === 0 || command.length > 4 || command.some((part) => typeof part !== "string" || part.length === 0 || part.length > 1_024 || part.includes("\0"))))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "computer tools MCP command is invalid")
  return Object.freeze(command === undefined ? {} : { mcpCommand: Object.freeze([...command]) })
}

const IMAGE_CALL_MAX_BYTES = 16 * 1024
const IMAGE_ERROR_STATUS: Readonly<Record<ImageError["code"], number>> = Object.freeze({
  IMAGE_INVALID_INPUT: 400,
  IMAGE_NO_MODEL: 409,
  IMAGE_REFUSED: 422,
  IMAGE_AUTH_FAILED: 403,
  IMAGE_RATE_LIMITED: 429,
  IMAGE_TIMEOUT: 504,
  IMAGE_UNSUPPORTED: 422,
  IMAGE_FAILED: 502,
})

function parseImageTools(value: RunrailControlRpcServerOptions["imageTools"]): { readonly mcpCommand?: readonly string[] } | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "image tools option is invalid")
  const command = value.mcpCommand
  if (command !== undefined && (!Array.isArray(command) || command.length === 0 || command.length > 4 || command.some((part) => typeof part !== "string" || part.length === 0 || part.length > 1_024 || part.includes("\0"))))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "image tools MCP command is invalid")
  return Object.freeze(command === undefined ? {} : { mcpCommand: Object.freeze([...command]) })
}

function imageRpcError(error: unknown): unknown {
  return error instanceof ImageError ? new ControlRpcError(error.code, IMAGE_ERROR_STATUS[error.code], error.message) : error
}

function requireComputer(services: ControlServices): ComputerBridge {
  if (services.computer === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, "this thread does not let the agent use the computer")
  return services.computer
}

function computerRpcError(error: unknown): unknown {
  return error instanceof ComputerError ? new ControlRpcError(error.code, COMPUTER_ERROR_STATUS[error.code], error.message) : error
}

async function readComputerCall(request: Request): Promise<{ readonly action: ComputerAction; readonly input: unknown }> {
  const body = await readBoundedBody(request, COMPUTER_CALL_MAX_BYTES)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown
  } catch {
    throw new ComputerError("COMPUTER_INVALID_INPUT", "the call is not valid JSON")
  }
  if (!isRecord(value) || typeof value.action !== "string" || !COMPUTER_ACTIONS.has(value.action as ComputerAction)) throw new ComputerError("COMPUTER_INVALID_INPUT", "the computer action is unknown")
  return { action: value.action as ComputerAction, input: value.input }
}

/** Claims one announced request; its parameters are what the desktop acts on. */
function takeComputerRequest(services: ControlServices, params: Record<string, unknown>) {
  const bridge = requireComputer(services)
  try {
    const task = bridge.take(params.requestId)
    return { requestId: task.requestId, action: task.action, params: task.params, expiresAt: task.expiresAt }
  } catch (error) {
    throw computerRpcError(error)
  }
}

function respondToComputerRequest(services: ControlServices, params: Record<string, unknown>) {
  const bridge = requireComputer(services)
  try {
    bridge.respond(params.requestId, params.answer)
  } catch (error) {
    throw computerRpcError(error)
  }
  return { ok: true }
}

function validateUnavailableTerminalCapabilities(value: readonly TerminalControlCapability[] | undefined): ReadonlySet<TerminalControlCapability> {
  if (value === undefined) return new Set<TerminalControlCapability>()
  if (!Array.isArray(value) || value.length > 6) throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "terminal capability policy is invalid")
  const result = new Set<TerminalControlCapability>()
  for (const candidate of value) {
    if (candidate !== "terminal.describe" && candidate !== "terminal.create" && candidate !== "terminal.write" && candidate !== "terminal.read" && candidate !== "terminal.resize" && candidate !== "terminal.close")
      throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "terminal capability policy is invalid")
    if (result.has(candidate)) throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "terminal capability policy is invalid")
    result.add(candidate)
  }
  return result
}

function unavailableTerminalCapabilityStatus(
  capabilities: ReadonlySet<TerminalControlCapability>,
): Partial<Record<TerminalControlCapability, "unavailable">> {
  const result: Partial<Record<TerminalControlCapability, "unavailable">> = {}
  for (const capability of capabilities) result[capability] = "unavailable"
  return result
}

function capabilityForMethod(method: string): TerminalControlCapability | undefined {
  if (method === "terminal.describe" || method === "terminal.create" || method === "terminal.write" || method === "terminal.read" || method === "terminal.resize" || method === "terminal.close") return method
  return undefined
}

function unavailableCapabilityError(capability: TerminalControlCapability): ControlRpcError {
  if (capability.startsWith("terminal.")) return new ControlRpcError("CONTROL_TERMINAL_UNAVAILABLE", 501, "terminal bridge is not available for this launch path")
  return new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, "control capability is unavailable for this launch path")
}

function requireTerminalBridge(bridge: RunrailTerminalBridge | undefined): RunrailTerminalBridge {
  if (bridge === undefined) throw new ControlRpcError("CONTROL_TERMINAL_UNAVAILABLE", 501, "terminal bridge is not configured")
  return bridge
}

function publicTerminalDescriptor(bridge: RunrailTerminalBridge): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: bridge.descriptor.id,
    version: bridge.descriptor.version,
    capabilities: Object.freeze([...bridge.descriptor.capabilities]),
  })
}

function terminalCapabilityStatus(bridge: RunrailTerminalBridge | undefined, capability: RunrailTerminalCapability): "available" | "configurable" | "unavailable" {
  if (bridge === undefined) return "configurable"
  return bridge.descriptor.capabilities.includes(capability) ? "available" : "unavailable"
}

function requireTerminalCapability(bridge: RunrailTerminalBridge, capability: RunrailTerminalCapability): void {
  if (!bridge.descriptor.capabilities.includes(capability))
    throw new ControlRpcError("CONTROL_TERMINAL_CAPABILITY_UNAVAILABLE", 501, `terminal capability '${capability}' is not configured`)
}

async function createTerminalSession(
  controller: RunrailSessionController,
  bridge: RunrailTerminalBridge,
  params: Record<string, unknown>,
): Promise<RunrailTerminalSession> {
  requireTerminalCapability(bridge, "create")
  const sessionId = requireNativeId(params.sessionId, "terminal session id", 128)
  const cwd = await resolveTerminalCwd(controller, params.cwd)
  const cols = parseOptionalBound(params.cols, 1, 4_096, "cols") ?? 120
  const rows = parseOptionalBound(params.rows, 1, 4_096, "rows") ?? 40
  return normalizeTerminalSession(await invokeTerminal(() => bridge.create({ sessionId, cwd, cols, rows })), sessionId)
}

async function writeTerminalInput(bridge: RunrailTerminalBridge, params: Record<string, unknown>): Promise<{ readonly acceptedBytes: number }> {
  requireTerminalCapability(bridge, "write")
  const sessionId = requireNativeId(params.sessionId, "terminal session id", 128)
  const data = requireBoundedString(params.data, "data", RUNRAIL_TERMINAL_MAX_INPUT_BYTES)
  const bytes = Buffer.byteLength(data, "utf8")
  if (bytes > RUNRAIL_TERMINAL_MAX_INPUT_BYTES) throw new ControlRpcError("CONTROL_TERMINAL_LIMIT", 413, "terminal input exceeds its byte limit")
  const result = await invokeTerminal(() => bridge.write({ sessionId, data }))
  if (!isRecord(result) || typeof result.acceptedBytes !== "number" || !Number.isSafeInteger(result.acceptedBytes) || result.acceptedBytes < 0 || result.acceptedBytes > bytes)
    throw new ControlRpcError("CONTROL_TERMINAL_INVALID", 502, "terminal bridge returned an invalid write result")
  return Object.freeze({ acceptedBytes: result.acceptedBytes })
}

async function readTerminalOutput(bridge: RunrailTerminalBridge, params: Record<string, unknown>): Promise<RunrailTerminalReadResult> {
  requireTerminalCapability(bridge, "read")
  const sessionId = requireNativeId(params.sessionId, "terminal session id", 128)
  const afterSeq = parseOptionalBound(params.afterSeq, -1, 2_000_000_000, "afterSeq") ?? -1
  const maxBytes = parseOptionalBound(params.maxBytes, 1, RUNRAIL_TERMINAL_MAX_OUTPUT_BYTES, "maxBytes") ?? 64 * 1024
  const maxChunks = parseOptionalBound(params.maxChunks, 1, 2_048, "maxChunks") ?? 256
  const result = await invokeTerminal(() => bridge.read({ sessionId, afterSeq, maxBytes, maxChunks }))
  return normalizeTerminalReadResult(result, maxBytes, maxChunks, sessionId)
}

async function resizeTerminal(bridge: RunrailTerminalBridge, params: Record<string, unknown>): Promise<RunrailTerminalSession> {
  requireTerminalCapability(bridge, "resize")
  const sessionId = requireNativeId(params.sessionId, "terminal session id", 128)
  const cols = parseRequiredBound(params.cols, 1, 4_096, "cols")
  const rows = parseRequiredBound(params.rows, 1, 4_096, "rows")
  return normalizeTerminalSession(await invokeTerminal(() => bridge.resize({ sessionId, cols, rows })), sessionId)
}

async function closeTerminal(bridge: RunrailTerminalBridge, params: Record<string, unknown>): Promise<RunrailTerminalSession> {
  requireTerminalCapability(bridge, "close")
  const sessionId = requireNativeId(params.sessionId, "terminal session id", 128)
  return normalizeTerminalSession(await invokeTerminal(() => bridge.close({ sessionId })), sessionId)
}

async function invokeTerminal<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ControlRpcError) throw error
    throw new ControlRpcError("CONTROL_TERMINAL_FAILED", 502, "terminal bridge operation failed")
  }
}

function normalizeTerminalSession(value: unknown, expectedSessionId?: string): RunrailTerminalSession {
  if (!isRecord(value)) throw new ControlRpcError("CONTROL_TERMINAL_INVALID", 502, "terminal bridge returned an invalid session")
  const sessionId = requireNativeId(value.sessionId, "terminal session id", 128)
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId)
    throw new ControlRpcError("CONTROL_TERMINAL_INVALID", 502, "terminal bridge returned the wrong session")
  const cols = parseRequiredBound(value.cols, 1, 4_096, "cols")
  const rows = parseRequiredBound(value.rows, 1, 4_096, "rows")
  const status = parseScalarEnum(value.status, ["running", "closed"] as const, "terminal status")
  if (status === undefined) throw new ControlRpcError("CONTROL_TERMINAL_INVALID", 502, "terminal bridge returned an invalid status")
  return Object.freeze({ sessionId, cols, rows, status })
}

function normalizeTerminalReadResult(value: unknown, maxBytes: number, maxChunks: number, expectedSessionId: string): RunrailTerminalReadResult {
  if (!isRecord(value) || !Array.isArray(value.chunks)) throw new ControlRpcError("CONTROL_TERMINAL_INVALID", 502, "terminal bridge returned invalid output")
  if (value.chunks.length > maxChunks) throw new ControlRpcError("CONTROL_TERMINAL_LIMIT", 413, "terminal output chunk count exceeds its limit")
  const chunks: RunrailTerminalChunk[] = []
  let bytes = 0
  for (const item of value.chunks) {
    if (!isRecord(item)) throw new ControlRpcError("CONTROL_TERMINAL_INVALID", 502, "terminal output chunk is invalid")
    const seq = parseRequiredBound(item.seq, 0, 2_000_000_000, "terminal output sequence")
    const data = requireBoundedString(item.data, "terminal output", maxBytes)
    bytes += Buffer.byteLength(data, "utf8")
    if (bytes > maxBytes) throw new ControlRpcError("CONTROL_TERMINAL_LIMIT", 413, "terminal output exceeds its byte limit")
    chunks.push(Object.freeze({ seq, data }))
  }
  const nextSeq = parseRequiredBound(value.nextSeq, 0, 2_000_000_000, "terminal next sequence")
  const closed = requireBoolean(value.closed, "terminal closed")
  return Object.freeze({ session: normalizeTerminalSession(value.session, expectedSessionId), chunks: Object.freeze(chunks), nextSeq, closed })
}

function parseProviderDiscovery(params: Record<string, unknown>, credentialResolver?: ProviderCredentialResolver): ProviderDiscoveryOptions {
  if (Object.hasOwn(params, "apiKey") || Object.hasOwn(params, "token") || Object.hasOwn(params, "secret") || Object.hasOwn(params, "credential")) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "provider secrets must use an environment or account reference")
  const provider = parseScalarEnum(params.provider, ["openai", "anthropic", "openai-compatible", "xai"], "provider")
  if (provider === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "provider is required")
  const accountId = params.accountId === undefined ? undefined : requireNativeId(params.accountId, "accountId", 256)
  if (accountId !== undefined) {
    if (params.credentialEnvironment !== undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "accountId and credentialEnvironment cannot both be set")
    if (credentialResolver === undefined) throw new ControlRpcError("CONTROL_ACCOUNT_CREDENTIALS_UNAVAILABLE", 501, "account resolver is not configured")
  }
  const environment = params.credentialEnvironment === undefined ? defaultCredentialEnvironment(provider) : requireBoundedString(params.credentialEnvironment, "credentialEnvironment", 128)
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environment) || !isModelKeyVariable(environment)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "credentialEnvironment must name a model key variable")
  const endpoint = params.endpoint === undefined ? undefined : requireBoundedString(params.endpoint, "endpoint", 2_048)
  if (accountId === undefined && !keyVariableAllowedAt(environment, providerDestination(provider, endpoint))) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "this key belongs to another provider's address")
  const allowRemote = optionalBoolean(params.allowRemote)
  const allowInsecureRemote = optionalBoolean(params.allowInsecureRemote)
  const protocol = parseScalarEnum(params.protocol, ["responses", "chat"], "protocol")
  const timeoutMs = parseOptionalBound(params.timeoutMs, 1, 120_000, "timeoutMs")
  const maxRetries = parseOptionalBound(params.maxRetries, 0, 5, "maxRetries")
  return Object.freeze({
    provider,
    credential: accountId === undefined
      ? Object.freeze({ kind: "environment", environment })
      : Object.freeze({ kind: "caller", account: accountId }),
    ...(accountId === undefined || credentialResolver === undefined ? {} : { credentialResolver }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(allowRemote === true ? { allowRemote: true } : {}),
    ...(allowInsecureRemote === true ? { allowInsecureRemote: true } : {}),
    ...(protocol === undefined ? {} : { protocol }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
  })
}

function parseProviderModel(params: Record<string, unknown>, credentialResolver?: ProviderCredentialResolver): ProviderModelOptions {
  const discovery = parseProviderDiscovery(params, credentialResolver)
  const model = requireBoundedString(params.model, "model", 256)
  const thinking = parseScalarEnum(params.thinking, THINKING_LEVELS, "thinking")
  return Object.freeze({ ...discovery, model, ...(thinking === undefined ? {} : { thinking }) })
}

function parseHarnessFeatures(value: unknown): readonly ("sessions" | "streaming" | "tools" | "approvals" | "reload" | "compact" | "fork" | "mcp" | "skills" | "connectors" | "worktrees" | "provider.switch" | "verification" | "repair")[] {
  return parseEnumList(value, ["sessions", "streaming", "tools", "approvals", "reload", "compact", "fork", "mcp", "skills", "connectors", "worktrees", "provider.switch", "verification", "repair"] as const, "features") ?? Object.freeze([])
}

function defaultCredentialEnvironment(provider: ProviderModelOptions["provider"]): string {
  return provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "xai" ? "XAI_API_KEY" : "OPENAI_COMPATIBLE_API_KEY"
}

function parseModelSelection(params: Record<string, unknown>): ModelSelection {
  const id = optionalString(params.id)
  const tier = parseScalarEnum(params.tier, ["cheap", "fast", "strong"], "tier")
  const quality = parseScalarEnum(params.quality, ["balanced", "cheap", "fast", "strong"], "quality")
  const thinking = parseScalarEnum(params.thinking, THINKING_LEVELS, "thinking")
  const requiredCapabilities = parseEnumList(params.requiredCapabilities, ["streaming", "tools", "multimodal", "reasoning"], "requiredCapabilities")
  return Object.freeze({
    ...(id === undefined ? {} : { id }),
    ...(tier === undefined ? {} : { tier }),
    ...(quality === undefined ? {} : { quality }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
  })
}

function parseCompactionReason(value: unknown): "manual" | "threshold" | "overflow" | "workflow" {
  return parseScalarEnum(value, ["manual", "threshold", "overflow", "workflow"], "reason") ?? "manual"
}

function parseScalarEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined
  const match = allowed.find((candidate) => candidate === value)
  if (match === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return match
}

function parseEnumList<T extends string>(value: unknown, allowed: readonly T[], name: string): readonly T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 16) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  const result: T[] = []
  for (const item of value) {
    const match = allowed.find((candidate) => candidate === item)
    if (match === undefined || result.includes(match)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
    result.push(match)
  }
  return Object.freeze(result)
}

function parseStringList(value: unknown, name: string): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 128))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return Object.freeze([...new Set(value)])
}

function parsePermissions(value: unknown): readonly PluginPermission[] {
  const permissions = parseStringList(value, "permissions")
  return Object.freeze(permissions.map(parsePluginPermission))
}

function parsePluginPermission(value: string): PluginPermission {
  if (value === "filesystem.read" || value === "filesystem.write" || value === "process.exec" || value === "network.request" || value === "credentials.read") return value
  throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "permissions are invalid")
}

function ensureControllerIdle(controller: RunrailSessionController): void {
  const snapshot = controller.snapshot()
  if (snapshot.active || snapshot.queued > 0)
    throw new ControlRpcError("CONTROL_SESSION_BUSY", 409, "session must be idle for this operation")
}

const GITHUB_CONNECTOR_ID = "github"
const GITHUB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SERVICE_NAMES: Readonly<Record<string, string>> = Object.freeze({ gitlab: "GitLab", bitbucket: "Bitbucket" })

function githubAction(registry: ConnectorRegistry | undefined, action: string): ConnectorRegistry | undefined {
  if (registry === undefined || registry.get(GITHUB_CONNECTOR_ID) === undefined) return undefined
  return registry.actions(GITHUB_CONNECTOR_ID).some((candidate) => candidate.name === action) ? registry : undefined
}

interface GitHubRepository {
  readonly remote: string
  readonly owner: string
  readonly repo: string
  readonly host?: string
  readonly service?: GitRemote["service"]
  readonly serviceFrom?: GitRemote["serviceFrom"]
}

interface PullRequestTarget extends GitHubRepository {
  readonly head: string
  /** Who owns the pushed head: the fork's owner when pull requests live on `upstream`. */
  readonly headOwner: string
  readonly pushRemote: string
}

type PullRequestRoute =
  | { readonly kind: "connector"; readonly registry: ConnectorRegistry }
  | { readonly kind: "gh"; readonly command: string }

/**
 * Who answers a pull request call: a registered `github` connector (the embedder's choice), else
 * the person's own `gh` when they connected the remote's host, else nobody. `gh` is never used
 * just because it is installed.
 */
async function pullRequestRoute(services: ControlServices, registry: ConnectorRegistry | undefined, action: string, target: GitHubRepository): Promise<PullRequestRoute> {
  refuseOtherService(target)
  const connector = githubAction(registry, action)
  if (connector !== undefined) return { kind: "connector", registry: connector }
  const host = target.host ?? "github.com"
  if ((await services.codeHosts.connection(host)) === undefined) throw new ControlRpcError("CONTROL_PR_NOT_CONNECTED", 501, `GitHub is not connected for ${host}`)
  if (services.githubCli === undefined) throw new ControlRpcError("CONTROL_PR_UNAVAILABLE", 501, "install the GitHub CLI (gh) to use the GitHub connection")
  return { kind: "gh", command: services.githubCli }
}

/** Pull requests are GitHub's until other services get connectors; a guessed service is never refused. */
function refuseOtherService(target: Pick<GitHubRepository, "service" | "serviceFrom">): void {
  const name = target.service === undefined ? undefined : SERVICE_NAMES[target.service]
  if (name !== undefined && (target.serviceFrom === "host" || target.serviceFrom === "user"))
    throw new ControlRpcError("CONTROL_PR_UNAVAILABLE", 501, `pull requests for ${name} need a ${name} connector`)
}

/** The branch's upstream remote, else `origin`, else the only remote. */
function pushRemoteOf(remotes: readonly GitRemote[], upstream: string | undefined): GitRemote | undefined {
  const tracking = upstream === undefined ? undefined : remotes.filter((entry) => upstream.startsWith(`${entry.name}/`)).sort((a, b) => b.name.length - a.name.length)[0]
  return tracking ?? remotes.find((entry) => entry.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined)
}

/** Resolves the GitHub repository from params, else the push remote, or `upstream` when the push remote is someone's fork of it. */
async function githubRepository(git: GitWorkspace, params: Record<string, unknown>, push?: GitRemote): Promise<GitHubRepository> {
  const remotes = await git.remotes()
  const requested = parseRemoteName(params.remote)
  const fallback = push ?? pushRemoteOf(remotes, undefined)
  const upstream = remotes.find((entry) => entry.name === "upstream")
  const fork = fallback !== undefined && upstream !== undefined && upstream !== fallback && upstream.owner !== undefined && upstream.repo !== undefined
    && upstream.host === fallback.host && fallback.owner !== undefined && upstream.owner.toLowerCase() !== fallback.owner.toLowerCase()
  const remote: GitRemote | undefined = requested !== undefined ? remotes.find((entry) => entry.name === requested) : fork ? upstream : fallback
  if (remote === undefined) throw new GitError("GIT_NOT_FOUND", "remote is not configured")
  refuseOtherService(remote)
  const owner = params.owner === undefined ? remote.owner : githubSegment(params.owner, "owner")
  const repo = params.repo === undefined ? remote.repo : githubSegment(params.repo, "repo")
  if (owner === undefined || repo === undefined)
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "remote is not an owner/repo URL; pass owner and repo")
  return {
    remote: remote.name,
    owner,
    repo,
    ...(remote.host === undefined || remote.host === "local" ? {} : { host: remote.host }),
    ...(remote.service === undefined ? {} : { service: remote.service }),
    ...(remote.serviceFrom === undefined ? {} : { serviceFrom: remote.serviceFrom }),
  }
}

/** The repository, and the head branch from params or HEAD, with the owner and remote it is pushed to. */
async function pullRequestTarget(git: GitWorkspace, params: Record<string, unknown>): Promise<PullRequestTarget> {
  const status = await git.status(1)
  const head = parseBranchName(params.head) ?? status.branch
  if (head === undefined) throw new GitError("GIT_CONFLICT", "check out a branch before opening a pull request")
  parseBranchName(head)
  const push = pushRemoteOf(await git.remotes(), status.upstream)
  const repository = await githubRepository(git, params, push)
  const forked = push !== undefined && push.name !== repository.remote && push.owner !== undefined && push.host === repository.host
  return { ...repository, head, headOwner: forked ? push.owner ?? repository.owner : repository.owner, pushRemote: forked ? push.name : repository.remote }
}

function githubSegment(value: unknown, name: string): string {
  if (typeof value !== "string" || !GITHUB_SEGMENT.test(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

function cliTarget(command: string, cwd: string, target: GitHubRepository) {
  return { command, cwd, owner: target.owner, repo: target.repo, ...(target.host === undefined ? {} : { host: target.host }) }
}

/**
 * Opens a pull request through the connector or the connected `gh`. `confirm: true` is the user's
 * approval for this single write; the head branch must already be pushed.
 */
async function createPullRequest(services: ControlServices, registry: ConnectorRegistry | undefined, cwd: string, params: Record<string, unknown>): Promise<unknown> {
  if (params.confirm !== true) throw new ControlRpcError("CONTROL_CONFIRMATION_REQUIRED", 428, "confirm must be true to open a pull request")
  const target = await pullRequestTarget(services.git, params)
  const base = parseBranchName(params.base)
  if (base === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "base is required")
  if (base === target.head && target.headOwner === target.owner) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "base and head must differ")
  const title = params.title
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 256 || /[\r\n\0]/.test(title))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "title must be one line of 1 to 256 characters")
  const body = params.body
  if (body !== undefined && (typeof body !== "string" || body.length > 65_536 || body.includes("\0")))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "body must be text up to 65536 characters")
  const draft = optionalBoolean(params.draft)
  const route = await pullRequestRoute(services, registry, "createPullRequest", target)
  const pushed = await services.git.remoteBranch(target.pushRemote, target.head)
  if (pushed === undefined) throw new GitError("GIT_CONFLICT", "push the branch before opening a pull request")
  const where = { owner: target.owner, repo: target.repo, remote: target.remote, pushedCommit: pushed }
  if (route.kind === "gh") {
    const opened = await fromCli("open the pull request", () => createPullRequestWithCli({ ...cliTarget(route.command, cwd, target), head: target.head, headOwner: target.headOwner, base, title, ...(body === undefined ? {} : { body }), ...(draft === undefined ? {} : { draft }) }))
    const read = await pullRequestsForBranchWithCli({ ...cliTarget(route.command, cwd, target), head: target.head, headOwner: target.headOwner, limit: 10 }).catch(() => [])
    const found = read.find((entry) => entry.number === opened.number)
    return { ...(found ?? { number: opened.number, url: opened.url, state: "open", draft: draft === true, merged: false, title, head: target.head, base }), ...where }
  }
  const result = await invokeGitHub(route.registry, "createPullRequest", {
    owner: target.owner,
    repo: target.repo,
    head: target.headOwner === target.owner ? target.head : `${target.headOwner}:${target.head}`,
    base,
    title,
    ...(body === undefined ? {} : { body }),
    ...(draft === undefined ? {} : { draft }),
  }, cwd, ["connector.write"])
  const summary = pullRequestFromRest(result)
  if (summary === undefined) throw new ControlRpcError("CONTROL_PR_FAILED", 502, "github returned an unexpected pull request response")
  return { ...summary, ...where }
}

/** Up to 10 pull requests whose head is the branch, newest first, so a thread can show its PR state. */
async function pullRequestStatus(services: ControlServices, registry: ConnectorRegistry | undefined, cwd: string, params: Record<string, unknown>): Promise<unknown> {
  const state = parseScalarEnum(params.state, ["open", "closed", "all"] as const, "state") ?? "all"
  const target = await pullRequestTarget(services.git, params)
  const route = await pullRequestRoute(services, registry, "listPullRequests", target)
  const base = { owner: target.owner, repo: target.repo, remote: target.remote, head: target.head }
  if (route.kind === "gh")
    return { ...base, source: "gh", pullRequests: await fromCli("read pull requests", () => pullRequestsForBranchWithCli({ ...cliTarget(route.command, cwd, target), head: target.head, headOwner: target.headOwner, state, limit: 10 })) }
  const result = await invokeGitHub(route.registry, "listPullRequests", { owner: target.owner, repo: target.repo, head: `${target.headOwner}:${target.head}`, state, limit: 10 }, cwd, ["connector.read"])
  const pullRequests = Array.isArray(result) ? result.slice(0, 10).map(pullRequestFromRest).filter((entry) => entry !== undefined) : []
  return { ...base, source: "connector", pullRequests }
}

/** Lists open pull requests to start a worktree from. */
async function listPullRequests(services: ControlServices, registry: ConnectorRegistry | undefined, cwd: string, params: Record<string, unknown>): Promise<unknown> {
  const limit = parseOptionalBound(params.limit, 1, GITHUB_CLI_MAX_PULL_REQUESTS, "limit") ?? 30
  const target = await githubRepository(services.git, params)
  const route = await pullRequestRoute(services, registry, "listPullRequests", target)
  const base = { owner: target.owner, repo: target.repo, remote: target.remote }
  if (route.kind === "gh") return { ...base, source: "gh", pullRequests: await fromCli("list pull requests", () => listPullRequestsWithCli({ ...cliTarget(route.command, cwd, target), limit })) }
  const result = await invokeGitHub(route.registry, "listPullRequests", { owner: target.owner, repo: target.repo, state: "open", limit }, cwd, ["connector.read"])
  const pullRequests = Array.isArray(result) ? result.slice(0, limit).map(pullRequestFromRest).filter((entry) => entry !== undefined) : []
  return { ...base, source: "connector", pullRequests }
}

/**
 * The Reviews inbox: the person's pull requests in every repository, read through their own `gh`
 * once they connected the host. No project is needed, so the app-wide engine answers these.
 */
async function reviewInbox(services: ControlServices, method: string, params: Record<string, unknown>, cwd: string): Promise<unknown> {
  let host: string
  try {
    host = params.host === undefined ? "github.com" : parseCodeHost(params.host)
  } catch (error) {
    if (error instanceof CodeHostError) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, error.message)
    throw error
  }
  const pullRequest = (): { readonly owner: string; readonly repo: string; readonly number: number } => ({
    owner: githubSegment(params.owner, "owner"),
    repo: githubSegment(params.repo, "repo"),
    number: parseOptionalBound(params.number, 1, 1_000_000_000, "number") ?? invalid("number is required"),
  })
  // Inputs, and the person's confirmation for a write, are checked before anything is asked of the host or gh.
  const write = method === "git.pr.review.post" || method === "git.pr.merge"
  if (write && params.confirm !== true) throw new ControlRpcError("CONTROL_CONFIRMATION_REQUIRED", 428, "confirm must be true to write to GitHub")
  const read = method === "git.pr.search" ? searchInput(params) : method === "git.pr.teams" ? undefined : pullRequest()
  const path = method === "git.pr.diff" && params.path !== undefined ? diffPath(params.path) : undefined
  const review = method === "git.pr.review.post" ? reviewInput(params) : undefined
  const merge = method === "git.pr.merge" ? mergeInput(params) : undefined
  await refuseOtherHost(services, host)
  if ((await services.codeHosts.connection(host)) === undefined) throw new ControlRpcError("CONTROL_PR_NOT_CONNECTED", 501, `GitHub is not connected for ${host}`)
  if (services.githubCli === undefined) throw new ControlRpcError("CONTROL_PR_UNAVAILABLE", 501, "install the GitHub CLI (gh) to use the GitHub connection")
  const target = { command: services.githubCli, cwd, ...(host === "github.com" ? {} : { host }) }
  switch (method) {
    case "git.pr.search": {
      const search = read as ReturnType<typeof searchInput>
      return { host, group: search.group, ...(await fromCli("search pull requests", () => searchPullRequestsWithCli({ ...target, ...search }))) }
    }
    case "git.pr.teams":
      return { host, teams: await fromCli("list your teams", () => listTeamsWithCli(target)) }
    case "git.pr.view":
      return fromCli("read the pull request", () => viewPullRequestWithCli({ ...target, ...(read as ReturnType<typeof pullRequest>) }))
    case "git.pr.diff":
      return fromCli("read the pull request's changes", () => pullRequestDiffWithCli({ ...target, ...(read as ReturnType<typeof pullRequest>), ...(path === undefined ? {} : { path }) }))
    case "git.pr.review.post":
      return { host, ...(await fromCli("post the review", () => postReviewWithCli({ ...target, ...(read as ReturnType<typeof pullRequest>), ...(review as ReturnType<typeof reviewInput>) }))) }
    case "git.pr.checks.logs":
      return { host, ...(await fromCli("read the failing checks", () => failedChecksWithCli({ ...target, ...(read as ReturnType<typeof pullRequest>) }))) }
    default: {
      const where = read as ReturnType<typeof pullRequest>
      const wanted = merge as ReturnType<typeof mergeInput>
      // Refused here, in Runrail's words, before GitHub is asked to merge.
      const current = await fromCli("read the pull request", () => viewPullRequestWithCli({ ...target, ...where }))
      if (current.state !== "open") throw new ControlRpcError("CONTROL_PR_MERGE_REFUSED", 409, `the pull request is ${current.state}`)
      if (current.draft) throw new ControlRpcError("CONTROL_PR_MERGE_REFUSED", 409, "the pull request is a draft")
      if (!current.mergeMethods.includes(wanted.method)) throw new ControlRpcError("CONTROL_PR_MERGE_REFUSED", 409, `the repository does not allow ${wanted.method} merges`)
      if (current.headCommit !== wanted.headCommit) throw new ControlRpcError("CONTROL_PR_HEAD_MOVED", 409, "the pull request changed since it was read; read it again before merging")
      await fromCli(wanted.auto ? "turn on auto-merge" : "merge the pull request", () => mergePullRequestWithCli({ ...target, ...where, ...wanted }))
      return { host, merged: !wanted.auto, ...(wanted.auto ? { auto: true } : {}), method: wanted.method, ...(current.url === undefined ? {} : { url: current.url }) }
    }
  }
}

const MAX_SETUP_TASK = 20_000

/** Setups: the person's and the project's, and runs of them in this project. */
async function setupRpc(services: ControlServices, method: string, params: Record<string, unknown>): Promise<unknown> {
  const runId = (): string => (typeof params.runId === "string" && params.runId.length <= 80 ? params.runId : invalid("runId is required"))
  try {
    switch (method) {
      case "setup.list":
        return await services.setups.list()
      case "setup.save":
        return await services.setups.save(params.setup)
      case "setup.delete":
        return await services.setups.delete(typeof params.id === "string" ? params.id : invalid("id is required"))
      case "setup.trust":
        return await services.setups.trust(typeof params.id === "string" ? params.id : invalid("id is required"), params.digest)
      case "setup.run.start": {
        const task = params.task
        if (typeof task !== "string" || task.trim().length === 0 || task.length > MAX_SETUP_TASK || task.includes("\0")) invalid(`task must be text up to ${String(MAX_SETUP_TASK)} characters`)
        if (params.checkout !== undefined && typeof params.checkout !== "boolean") invalid("checkout must be true or false")
        const setup = params.setup === undefined ? await services.setups.runnable(typeof params.setupId === "string" ? params.setupId : invalid("setupId or setup is required")) : parseSetup(params.setup)
        // In the checkout, the run's turns and checks work in the project's own folder instead of a worktree.
        return services.setupRuns.start(setup, task.trim(), undefined, params.checkout === true ? { checkout: true } : {})
      }
      case "setup.run.status":
        return services.setupRuns.status(runId())
      case "setup.run.list":
        return { runs: services.setupRuns.list() }
      case "setup.run.answer":
        return services.setupRuns.answer(runId(), typeof params.stepId === "string" ? params.stepId : invalid("stepId is required"), params)
      default:
        return await services.setupRuns.stop(runId())
    }
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    const status = error.code === "SETUP_INVALID" ? 400 : error.code === "SETUP_NOT_FOUND" || error.code === "SETUP_RUN_NOT_FOUND" ? 404 : error.code === "SETUP_LIMIT" ? 429 : error.code === "SETUP_STORE_FAILED" ? 500 : 409
    throw new ControlRpcError(`CONTROL_${error.code}`, status, error.message)
  }
}

/** Workflows: this project's, every project's for the app's scheduler, and runs of them here. */
async function workflowRpc(services: ControlServices, root: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const project = projectKey(root)
  const id = (): string => (typeof params.id === "string" && params.id.length <= 64 ? params.id : invalid("id is required"))
  const runId = (): string => (typeof params.runId === "string" && params.runId.length <= 80 ? params.runId : invalid("runId is required"))
  // A setup step names a setup this project can run.
  const known = async (workflow: Workflow): Promise<Workflow> => {
    for (const step of workflow.steps) if (step.kind === "setup") await services.setups.get(step.setupId)
    return workflow
  }
  try {
    switch (method) {
      case "workflow.list": {
        const live = new Set(services.workflowRuns.list().map((run) => run.runId))
        const now = Date.now()
        const listed = await services.workflows.list(params.all === true ? undefined : project)
        // A run this engine does not hold, past its budget, ended with an engine that stopped.
        return {
          workflows: listed.map((item) => ({
            ...item,
            runs: item.runs.map((run) => ((run.state === "running" || run.state === "waiting") && !live.has(run.runId) && run.startedAt + item.budget.maxMinutes * 60_000 < now ? { ...run, state: "failed", error: "WORKFLOW_INTERRUPTED" } : run)),
          })),
        }
      }
      case "workflow.get":
        return await services.workflows.get(id(), project)
      case "workflow.save":
        return await services.workflows.save(await known(parseWorkflow(params.workflow)), { project, root })
      case "workflow.propose": {
        // An agent's proposal is stored as proposed and never runs until the person approves it.
        const raw = typeof params.workflow === "object" && params.workflow !== null && !Array.isArray(params.workflow) ? (params.workflow as Record<string, unknown>) : typeof params.message === "string" ? parseProposalBlock(params.message) : undefined
        if (raw === undefined) invalid("workflow or a message ending with a workflow block is required")
        const thread = typeof params.thread === "string" && params.thread.trim().length > 0 ? params.thread.replace(/[\r\n]+/g, " ").trim().slice(0, 120) : undefined
        const taken = new Set((await services.workflows.list()).map((item) => item.id))
        const base = typeof raw.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,50}$/.test(raw.id) ? raw.id : "proposed"
        let free = base
        for (let n = 2; taken.has(free); n += 1) free = `${base}-${String(n)}`
        const workflow = parseWorkflow({ ...raw, id: free, state: "proposed", ...(thread === undefined ? {} : { proposedBy: { thread } }) }, { runsOn: parseSetupRole(params.runsOn, "runsOn") })
        return await services.workflows.save(await known(workflow), { project, root })
      }
      case "workflow.approve":
        return await services.workflows.setState(id(), project, "on")
      case "workflow.enable": {
        const current = await services.workflows.get(id(), project)
        if (current.state === "proposed") throw new WorkflowError("WORKFLOW_PROPOSED", "approve a proposed workflow before turning it on or off")
        return await services.workflows.setState(current.id, project, params.on === true ? "on" : "off")
      }
      case "workflow.delete":
        return await services.workflows.delete(id(), project)
      case "workflow.due":
        return { due: await services.workflows.due(Date.now(), services.pullRequestsFor) }
      case "workflow.upcoming":
        return await services.workflows.upcoming(Date.now())
      case "workflow.run.start": {
        const trigger = params.trigger === undefined ? "manual" : params.trigger === "manual" || params.trigger === "schedule" || params.trigger === "pr-review-requested" || params.trigger === "pr-opened" || params.trigger === "webhook" ? params.trigger : invalid("trigger must be manual, schedule, pr-review-requested, pr-opened or webhook")
        const [pr] = params.pr === undefined ? [] : pullRequestRef(params.pr)
        if (params.pr !== undefined && pr === undefined) invalid("pr must name a pull request number")
        const input = params.input === undefined ? undefined : webhookInput(params.input, trigger)
        return await services.workflowRuns.start(id(), { kind: trigger, ...(pr === undefined ? {} : { pr }), ...(input === undefined ? {} : { input }) })
      }
      case "workflow.run.status":
        return services.workflowRuns.status(runId())
      case "workflow.run.list":
        return { runs: services.workflowRuns.list() }
      case "workflow.run.answer":
        return services.workflowRuns.answer(runId(), typeof params.stepId === "string" ? params.stepId : invalid("stepId is required"), params.approved === true)
      default:
        return await services.workflowRuns.stop(runId())
    }
  } catch (error) {
    if (error instanceof SetupError) throw new ControlRpcError(`CONTROL_${error.code}`, error.code === "SETUP_NOT_FOUND" ? 404 : error.code === "SETUP_UNTRUSTED" ? 409 : 400, error.message)
    if (!(error instanceof WorkflowError)) throw error
    const status = error.code === "WORKFLOW_INVALID" ? 400 : error.code === "WORKFLOW_NOT_FOUND" || error.code === "WORKFLOW_RUN_NOT_FOUND" ? 404 : error.code === "WORKFLOW_STORE_FAILED" ? 500 : 409
    throw new ControlRpcError(`CONTROL_${error.code}`, status, error.message)
  }
}

const MAX_RECALL_QUERY = 20_000

/** Appends what the message recalls; a memory failure never stops the message. */
async function withRecall(memory: MemoryService, input: RunrailControlInput): Promise<RunrailControlInput> {
  const text = typeof input === "string" ? input : input.text
  try {
    const block = recallBlock(await memory.recallForMessage(text.slice(0, MAX_RECALL_QUERY)), (hit) => memoryLabel(memory.scopeName(hit.scope), hit.source))
    if (block.length === 0) return input
    return typeof input === "string" ? `${text}${block}` : { ...input, text: `${text}${block}` }
  } catch {
    return input
  }
}

/** Memory: `project` and `person` scopes, recall, edits, the provider, and sources. */
async function memoryRpc(memory: MemoryService, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = (): string => (typeof params.id === "string" && params.id.length <= 80 ? params.id : invalid("id is required"))
  // Scopes go out by name; another project's memories are never listed here.
  const named = <T extends { readonly scope: string }>(item: T): T & { readonly scope: string } => ({ ...item, scope: memory.scopeName(item.scope) })
  try {
    switch (method) {
      case "memory.status":
        return await memory.status()
      case "memory.recall": {
        const query = params.query
        if (typeof query !== "string" || query.length > MAX_RECALL_QUERY) invalid(`query must be text up to ${String(MAX_RECALL_QUERY)} characters`)
        const result = await memory.recall(query, memory.scopes(params.scopes), parseOptionalBound(params.limit, 1, 10, "limit") ?? 3)
        return { ...result, hits: result.hits.map(named) }
      }
      case "memory.add": {
        const kind = params.source === undefined || params.source === "manual" ? "manual" : params.source === "suggested" ? "suggested" : invalid("source must be manual or suggested")
        return named(await (await memory.provider()).add({ scope: memory.scope(params.scope), text: typeof params.text === "string" ? params.text : "", source: { kind } }))
      }
      case "memory.update":
        return named(await (await memory.provider()).update(id(), typeof params.text === "string" ? params.text : ""))
      case "memory.forget":
        return { forgotten: await (await memory.provider()).forget(id()) }
      case "memory.list": {
        const scopes = params.scope === undefined ? memory.scopes(undefined) : [memory.scope(params.scope)]
        const query = params.query === undefined ? undefined : typeof params.query === "string" && params.query.length <= 500 ? params.query : invalid("query must be text up to 500 characters")
        const sourceId = params.sourceId === undefined ? undefined : typeof params.sourceId === "string" && params.sourceId.length <= 80 ? params.sourceId : invalid("sourceId is invalid")
        const before = parseOptionalBound(params.before, 0, Number.MAX_SAFE_INTEGER, "before")
        // Sources always live locally, so their entries are read there whatever the provider.
        const provider = sourceId === undefined ? await memory.provider() : memory.local
        const listed = await provider.list({ scopes, limit: parseOptionalBound(params.limit, 1, 500, "limit") ?? 100, ...(query === undefined ? {} : { query }), ...(sourceId === undefined ? {} : { sourceId }), ...(before === undefined ? {} : { before }) })
        return { memories: listed.map(named) }
      }
      case "memory.settings.get":
        return await memory.settings()
      case "memory.settings.set":
        return await memory.saveSettings(params)
      case "memory.source.list":
        return { sources: (await memory.sources.list(memory.scopes(undefined))).map(named) }
      case "memory.source.add":
        return named(await memory.sources.add({ kind: params.kind, scope: memory.scope(params.scope), target: params.target, name: params.name }))
      case "memory.source.remove":
        return await memory.sources.remove(id())
      default:
        return named(await memory.sources.sync(id()))
    }
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error
    const status = error.code === "MEMORY_INVALID" ? 400 : error.code === "MEMORY_NOT_FOUND" ? 404 : error.code === "MEMORY_LIMIT" ? 429 : error.code === "MEMORY_UNAVAILABLE" ? 503 : error.code === "MEMORY_SOURCE_FAILED" ? 502 : 500
    throw new ControlRpcError(`CONTROL_${error.code}`, status, error.message)
  }
}

const MAX_EVAL_SETUPS = 4

/** Evals: cases mined from this project's history, suites of them, and runs of setups against a suite. */
async function evalRpc(services: ControlServices, root: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const runId = (): string => (typeof params.runId === "string" && params.runId.length <= 80 ? params.runId : invalid("runId is required"))
  const check = (): string => {
    const value = params.check
    if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_CHECK_COMMAND || value.includes("\0")) invalid(`check must be a command up to ${String(MAX_CHECK_COMMAND)} characters`)
    return value.trim()
  }
  try {
    switch (method) {
      case "eval.mine": {
        const limit = parseOptionalBound(params.limit, 1, 50, "limit") ?? 20
        const scan = parseOptionalBound(params.scan, 1, 2_000, "scan") ?? 500
        const since = params.since === undefined ? undefined : typeof params.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.since) ? params.since : invalid("since must be a date like 2026-01-31")
        const candidates = await mineCandidates({ root, limit, scan, ...(since === undefined ? {} : { since }) })
        return { candidates }
      }
      case "eval.validate": {
        const command = check()
        // A one-case suite checks the case's shape the way a saved suite would.
        const [item] = parseSuite({ check: command, cases: [params.case] }, "validate").cases
        if (item === undefined) invalid("case is required")
        const id = `eval-check-${randomUUID()}`
        const verdict = await validateCase(item, { root, check: command, run: (input) => services.checks.run({ id, cwd: input.cwd, command: input.command, timeoutMs: CHECK_DEFAULT_TIMEOUT_MS }) })
        return { id: item.id, verdict }
      }
      case "eval.suites":
        return await services.suites.list()
      case "eval.suite.get":
        return await services.suites.get(typeof params.name === "string" ? params.name : invalid("name is required"))
      case "eval.suite.save": {
        const suite = typeof params.suite === "object" && params.suite !== null && !Array.isArray(params.suite) ? (params.suite as Record<string, unknown>) : invalid("suite is required")
        return await services.suites.save(parseSuite(suite, typeof suite.name === "string" ? suite.name : invalid("suite.name is required")))
      }
      case "eval.run": {
        const suite = await services.suites.get(typeof params.suite === "string" ? params.suite : invalid("suite is required"))
        const ids = params.setupIds
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_EVAL_SETUPS || new Set(ids).size !== ids.length) invalid(`setupIds must list 1 to ${String(MAX_EVAL_SETUPS)} different setups`)
        const setups = []
        for (const id of ids) setups.push(await services.setups.runnable(typeof id === "string" ? id : invalid("setupIds must be setup ids")))
        const only = params.cases
        if (only !== undefined && (!Array.isArray(only) || only.length === 0 || only.length > MAX_CASES || !only.every((id) => typeof id === "string"))) invalid("cases must list case ids")
        const cases = only === undefined ? suite.cases : suite.cases.filter((item) => (only as string[]).includes(item.id))
        if (cases.length === 0) invalid("none of those cases are in the suite")
        return services.evalRuns.start({
          suite: { ...suite, cases },
          setups,
          repeats: parseOptionalBound(params.repeats, 1, 5, "repeats") ?? 1,
          parallel: parseOptionalBound(params.parallel, 1, 4, "parallel") ?? 1,
          maxMinutes: parseOptionalBound(params.maxMinutes, 1, 1_440, "maxMinutes") ?? 120,
        })
      }
      case "eval.status":
        return services.evalRuns.status(runId())
      case "eval.list":
        return { runs: await services.evalRuns.list() }
      default:
        return await services.evalRuns.stop(runId())
    }
  } catch (error) {
    if (error instanceof SetupError) throw new ControlRpcError(`CONTROL_${error.code}`, error.code === "SETUP_NOT_FOUND" ? 404 : error.code === "SETUP_UNTRUSTED" ? 409 : 400, error.message)
    if (!(error instanceof EvalError)) throw error
    const status = error.code === "EVAL_INVALID" ? 400 : error.code === "EVAL_NOT_FOUND" || error.code === "EVAL_RUN_NOT_FOUND" ? 404 : error.code === "EVAL_LIMIT" ? 429 : 500
    throw new ControlRpcError(`CONTROL_${error.code}`, status, error.message)
  }
}

const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_CHECK_COMMAND = 4_000

function checkId(value: unknown): string {
  if (typeof value !== "string" || !CHECK_ID.test(value)) invalid("id must be 1-64 letters, digits, dots, dashes or underscores")
  return value
}

/** The person typed the command, so it runs as given; only in a worktree of this project. */
async function runCheck(services: ControlServices, params: Record<string, unknown>): Promise<unknown> {
  const id = checkId(params.id)
  const worktree = parseWorktreeId(params.worktree)
  const command = params.command
  if (typeof command !== "string" || command.trim().length === 0 || command.length > MAX_CHECK_COMMAND || command.includes("\0")) invalid(`command must be text up to ${String(MAX_CHECK_COMMAND)} characters`)
  const timeoutMs = parseOptionalBound(params.timeoutMs, 1_000, CHECK_MAX_TIMEOUT_MS, "timeoutMs") ?? CHECK_DEFAULT_TIMEOUT_MS
  const target = (await services.worktrees.list()).find((entry) => entry.id === worktree)
  if (target === undefined) throw new ControlRpcError("CONTROL_CHECK_NOT_A_WORKTREE", 404, "no worktree of this project has that id")
  try {
    return await services.checks.run({ id, cwd: target.cwd, command, timeoutMs })
  } catch (error) {
    if (!(error instanceof CheckError)) throw error
    const status = error.code === "CHECK_LIMIT" ? 429 : error.code === "CHECK_START_FAILED" ? 500 : 409
    throw new ControlRpcError(`CONTROL_${error.code}`, status, error.message)
  }
}

const MAX_REVIEW_COMMENTS = 50
const COMMIT = /^[0-9a-f]{40}$/

function reviewInput(params: Record<string, unknown>): { readonly commit: string; readonly body: string; readonly comments: readonly ReviewComment[] } {
  if (typeof params.commit !== "string" || !COMMIT.test(params.commit)) invalid("commit must be the head commit's 40-character id")
  const body = params.body
  if (typeof body !== "string" || body.length > 60_000 || body.includes("\0")) invalid("body must be text up to 60000 characters")
  const list = params.comments ?? []
  if (!Array.isArray(list) || list.length > MAX_REVIEW_COMMENTS) invalid(`comments must be a list of at most ${String(MAX_REVIEW_COMMENTS)}`)
  const comments = list.map((value: unknown): ReviewComment => {
    const item = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : invalid("each comment must be an object")
    const line = parseOptionalBound(item.line, 1, 10_000_000, "comment line") ?? invalid("each comment needs a line")
    const side = item.side === undefined ? "RIGHT" : item.side === "RIGHT" || item.side === "LEFT" ? item.side : invalid("comment side must be RIGHT or LEFT")
    if (typeof item.body !== "string" || item.body.trim().length === 0 || item.body.length > 8_000 || item.body.includes("\0")) invalid("each comment needs text up to 8000 characters")
    return { path: diffPath(item.path), line, side, body: item.body }
  })
  if (body.trim().length === 0 && comments.length === 0) invalid("a review needs a body or at least one comment")
  return { commit: params.commit, body, comments }
}

function mergeInput(params: Record<string, unknown>): { readonly method: "merge" | "squash" | "rebase"; readonly headCommit: string; readonly subject?: string; readonly body?: string; readonly deleteBranch: boolean; readonly auto: boolean } {
  const method = parseScalarEnum(params.method, ["merge", "squash", "rebase"] as const, "method") ?? invalid("method is required")
  if (typeof params.headCommit !== "string" || !COMMIT.test(params.headCommit)) invalid("headCommit must be the 40-character id of the head the person saw")
  const subject = params.subject
  if (subject !== undefined && (typeof subject !== "string" || subject.trim().length === 0 || subject.length > 256 || /[\r\n\0]/.test(subject))) invalid("subject must be one line of 1 to 256 characters")
  const body = params.body
  if (body !== undefined && (typeof body !== "string" || body.length > 65_536 || body.includes("\0"))) invalid("body must be text up to 65536 characters")
  return { method, headCommit: params.headCommit, ...(typeof subject === "string" ? { subject } : {}), ...(typeof body === "string" ? { body } : {}), deleteBranch: optionalBoolean(params.deleteBranch) === true, auto: optionalBoolean(params.auto) === true }
}

function searchInput(params: Record<string, unknown>): { readonly group: "review-requested" | "authored" | "team"; readonly limit: number; readonly team?: ReviewTeam; readonly text?: string } {
  const group = parseScalarEnum(params.group, ["review-requested", "authored", "team"] as const, "group") ?? invalid("group is required")
  const limit = parseOptionalBound(params.limit, 1, REVIEW_SEARCH_MAX, "limit") ?? 20
  let team: ReviewTeam | undefined
  if (params.team !== undefined) {
    if (group !== "team" || typeof params.team !== "string") invalid("team is invalid")
    const [org, slug, extra] = params.team.split("/")
    if (extra !== undefined) invalid("team must be org/slug")
    team = { org: githubSegment(org, "team org"), slug: githubSegment(slug, "team slug") }
  }
  const text = params.query
  if (text !== undefined && (typeof text !== "string" || text.length > REVIEW_QUERY_MAX_CHARS || /[\r\n\0]/.test(text))) invalid(`query must be one line up to ${String(REVIEW_QUERY_MAX_CHARS)} characters`)
  return { group, limit, ...(team === undefined ? {} : { team }), ...(typeof text === "string" && text.trim().length > 0 ? { text } : {}) }
}

function diffPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || value.includes("\0") || /[\r\n]/.test(value)) invalid("path is invalid")
  return value
}

/** What a webhook sent, as text an agent can read: no control characters but line breaks and tabs. */
function webhookInput(value: unknown, trigger: string): string {
  if (trigger !== "webhook") return invalid("input comes only with a webhook trigger")
  if (typeof value !== "string" || value.length > MAX_WEBHOOK_INPUT) return invalid(`input must be text of up to ${String(MAX_WEBHOOK_INPUT)} characters`)
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
}

function invalid(message: string): never {
  throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, message)
}

/** Maps gh's failure kinds to stable codes; gh's own words never leave. */
async function fromCli<T>(doing: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (!(error instanceof GitHubCliError)) throw error
    switch (error.failure) {
      case "unavailable":
        throw new ControlRpcError("CONTROL_PR_UNAVAILABLE", 501, "the GitHub CLI (gh) could not be started")
      case "credentials":
        throw new ControlRpcError("CONTROL_PR_CREDENTIALS", 501, "sign in to the GitHub CLI with gh auth login first")
      case "scope":
        throw new ControlRpcError("CONTROL_PR_SCOPE_MISSING", 403, "the GitHub CLI sign-in lacks the read:org scope; run gh auth refresh -s read:org")
      case "not-found":
        throw new ControlRpcError("CONTROL_PR_NOT_FOUND", 404, "the repository or pull request was not found, or this sign-in cannot see it")
      case "rate-limited":
        throw new ControlRpcError("CONTROL_PR_RATE_LIMITED", 429, "github rate limit reached")
      case "timeout":
        throw new ControlRpcError("CONTROL_PR_TIMEOUT", 504, "github request timed out")
      case "failed":
        throw new ControlRpcError("CONTROL_PR_FAILED", 502, `the GitHub CLI could not ${doing}`)
    }
  }
}

function githubCliOption(option: string | false | undefined): { readonly githubCli?: string } {
  if (option === false) return {}
  const found = option ?? Bun.which("gh", { PATH: filteredEnvironment().PATH ?? "" })
  return found === null || found.length === 0 ? {} : { githubCli: found }
}

const CODE_HOST_METHODS = new Set(["codehost.list", "codehost.set", "codehost.connect", "codehost.disconnect", "codehost.status", "codehost.remotes"])
const MAX_PROJECT_REMOTES = 64

/** The person's answers about git hosts, and which GitHub hosts they connected through `gh`. */
async function dispatchCodeHost(services: ControlServices, method: string, params: Record<string, unknown>, cwd: string): Promise<unknown> {
  try {
    switch (method) {
      case "codehost.list": {
        const listing = await services.codeHosts.list()
        return { hosts: listing.hosts, ...(listing.invalid ? { problem: "CODEHOST_STORE_INVALID" } : {}) }
      }
      case "codehost.set":
        return await services.codeHosts.set(parseCodeHost(params.host), parseGitService(params.service))
      case "codehost.connect": {
        const host = parseCodeHost(params.host)
        if (params.via !== "gh") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "via must be gh")
        await refuseOtherHost(services, host)
        if (services.githubCli === undefined) throw new ControlRpcError("CONTROL_PR_UNAVAILABLE", 501, "install the GitHub CLI (gh) first")
        return await services.codeHosts.connect(host, "gh")
      }
      case "codehost.disconnect":
        return await services.codeHosts.disconnect(parseCodeHost(params.host))
      case "codehost.status": {
        const host = parseCodeHost(params.host)
        await refuseOtherHost(services, host)
        if (services.githubCli === undefined) return { state: "missing" }
        const command = services.githubCli
        return await fromCli("read its sign-in", () => gitHubCliLogin({ command, cwd, host }))
      }
      case "codehost.remotes":
        return await projectRemotes(services, params.path)
      default:
        throw new ControlRpcError("CONTROL_UNKNOWN_METHOD", 400, `unknown control method '${method}'`)
    }
  } catch (error) {
    if (!(error instanceof CodeHostError)) throw error
    if (error.code === "limit") throw new ControlRpcError("CONTROL_CODEHOST_LIMIT", 409, error.message)
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, error.message)
  }
}

/**
 * A project folder's remotes and checked-out branch for a client with no thread there yet, so it
 * can say what the folder is connected to and where a new thread would work: the same offline read
 * as `git.remote.list`, with the person's answers applied.
 */
async function projectRemotes(services: ControlServices, value: unknown): Promise<unknown> {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0") || !isAbsolute(value))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "path must be an absolute folder path")
  const folder = await realpath(value).catch(() => undefined)
  if (folder === undefined || !(await stat(folder)).isDirectory()) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "path is not an existing folder")
  const workspace = new GitWorkspace({ root: folder, hints: () => services.codeHosts.hints() })
  try {
    const signal = AbortSignal.timeout(10_000)
    const [remotes, head] = await Promise.all([workspace.remotes(signal), workspace.head(signal)])
    return { git: true, remotes: remotes.slice(0, MAX_PROJECT_REMOTES), ...head }
  } catch (error) {
    if (outsideWorkTree(error)) return { git: false }
    throw error
  }
}

/** Web Push to the desktop's paired phones: the key phones subscribe with, and one message. */
async function pushRpc(push: ControlServices["push"], method: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    push.vapid ??= vapidKeys(push.dir)
    const vapid = await push.vapid.catch((error: unknown) => {
      push.vapid = undefined
      throw error
    })
    if (method === "push.vapid") return { publicKey: vapid.publicKey }
    return await sendPush({ vapid, subscription: parseSubscription(params.subscription), contact: parseContact(params.contact), message: parseMessage(params.message), ...(push.fetch === undefined ? {} : { fetch: push.fetch }) })
  } catch (error) {
    if (!(error instanceof PushError)) throw error
    if (error.code === "PUSH_INVALID") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, error.message)
    throw new ControlRpcError("CONTROL_PUSH_FAILED", 502, error.message)
  }
}

async function refuseOtherHost(services: ControlServices, host: string): Promise<void> {
  const answered = (await services.codeHosts.list()).hosts.find((record) => record.host === host)?.service
  const known = knownHostService(host.replace(/:\d+$/, ""))
  refuseOtherService(answered !== undefined ? { service: answered, serviceFrom: "user" } : known !== undefined ? { service: known, serviceFrom: "host" } : {})
}

async function invokeGitHub(registry: ConnectorRegistry, action: string, input: Record<string, unknown>, cwd: string, capabilities: readonly string[]): Promise<unknown> {
  try {
    return await registry.invoke(GITHUB_CONNECTOR_ID, action, input, {
      cwd,
      signal: AbortSignal.timeout(60_000),
      allowedCapabilities: capabilities,
      approve: () => true,
      maxOutputBytes: 1024 * 1024,
    })
  } catch (error) {
    if (!(error instanceof ConnectorError)) throw error
    switch (error.code) {
      case "CONNECTOR_INVALID":
        throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "pull request input is invalid")
      case "CONNECTOR_CREDENTIALS":
        throw new ControlRpcError("CONTROL_PR_CREDENTIALS", 501, "github credentials are not configured")
      case "CONNECTOR_AUTH_FAILED":
        throw new ControlRpcError("CONTROL_PR_AUTH_FAILED", 502, "github rejected the configured credentials")
      case "CONNECTOR_RATE_LIMITED":
        throw new ControlRpcError("CONTROL_PR_RATE_LIMITED", 429, "github rate limit reached")
      case "CONNECTOR_TIMEOUT":
      case "CONNECTOR_CANCELLED":
        throw new ControlRpcError("CONTROL_PR_TIMEOUT", 504, "github request timed out")
      default:
        throw new ControlRpcError("CONTROL_PR_FAILED", 502, "github request failed")
    }
  }
}

function requireConnectorRegistry(registry: ConnectorRegistry | undefined): ConnectorRegistry {
  if (registry === undefined) throw new ControlRpcError("CONTROL_CONNECTOR_UNAVAILABLE", 501, "connector registry is not configured")
  return registry
}

function requireAgentCoordinator(coordinator: MultiAgentCoordinator | undefined): MultiAgentCoordinator {
  if (coordinator === undefined) throw new ControlRpcError("CONTROL_AGENT_UNAVAILABLE", 501, "agent coordinator is not configured")
  return coordinator
}

function requireTranscriptStore(controller: RunrailSessionController): import("./transcript/index.ts").TranscriptStore {
  const store = controller.session.transcriptStore
  if (store === undefined)
    throw new ControlRpcError("CONTROL_TRANSCRIPT_UNAVAILABLE", 501, "caller-owned transcript storage is not configured")
  return store
}

function parseAgentTask(value: unknown): RunrailAgentTask {
  if (!isRecord(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "agent task is invalid")
  const id = parseToken(value.id, "id", 128)
  const profile = parseToken(value.profile, "profile", 128)
  const prompt = requireBoundedString(value.prompt, "prompt", 256 * 1024)
  const requiredCapabilities = parseStringList(value.requiredCapabilities, "requiredCapabilities")
  const timeoutMs = parseOptionalBound(value.timeoutMs, 1, 120_000, "timeoutMs")
  const maxDepth = parseOptionalBound(value.maxDepth, 0, 16, "maxDepth")
  const maxRetries = parseOptionalBound(value.maxRetries, 0, 3, "maxRetries")
  const retryable = optionalBoolean(value.retryable)
  return Object.freeze({
    id,
    profile,
    prompt,
    ...(value.cwd === undefined ? {} : { cwd: requireBoundedString(value.cwd, "cwd", 4_096) }),
    ...(requiredCapabilities.length === 0 ? {} : { requiredCapabilities }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
  })
}

function parseToken(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

function requireBoundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

function requireBoundedSkillId(value: unknown): string {
  const id = requireBoundedString(value, "skill id", 128)
  if (!/^[a-z][a-z0-9._:-]{0,127}$/i.test(id))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "skill id is invalid")
  return id
}

function requirePluginManager(manager: PluginManager | undefined): PluginManager {
  if (manager === undefined) throw new ControlRpcError("CONTROL_PLUGIN_UNAVAILABLE", 501, "plugin manager is not configured")
  return manager
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096)
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requireString(value, "value")
}

function requireCheckpoints(controller: RunrailSessionController): TurnCheckpoints {
  const checkpoints = controller.session.checkpoints
  if (checkpoints === undefined) throw new ControlRpcError("CONTROL_CAPABILITY_UNAVAILABLE", 501, "this engine keeps no checkpoints; start it with --checkpoints")
  return checkpoints
}

function optionalSessionId(value: unknown): string | undefined {
  const id = optionalString(value)
  if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id))
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "session id is invalid")
  return id
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

function approvalScope(value: unknown): "once" | "session" | undefined {
  if (value === undefined) return undefined
  if (value !== "once" && value !== "session") throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "scope is invalid")
  return value
}

/** "Ask me more" instead of all the answers: `followUp` true with the approval granted, and an optional note. */
function approvalFollowUp(params: Record<string, unknown>): FollowUp | undefined {
  const followUp = parseFollowUp(params.followUp, params.note)
  if (followUp === "invalid" || (followUp !== undefined && params.approved !== true)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "followUp is invalid")
  return followUp
}

function approvalAnswers(value: unknown): ApprovalAnswers | undefined {
  if (value === undefined) return undefined
  const answers = parseAnswers(value)
  if (answers === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, "answers are invalid")
  return answers
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === undefined ? undefined : requireBoolean(value, "boolean")
}

function parseOptionalBound(value: unknown, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  return value
}

/** Replays retained live frames after a cursor; an expired cursor restarts at the oldest retained frame. */
async function answerTurn(method: "turn.enqueue" | "turn.steer", params: Record<string, unknown>, controller: RunrailSessionController, services: ControlServices): Promise<unknown> {
  const parsed = parseControlInput(params)
  // D14: the person's message carries the memories it recalls, whatever route reads it.
  const input = method === "turn.enqueue" && params.recall === true ? await withRecall(services.memory.open(), parsed) : parsed
  const liveOnly = method === "turn.steer" && optionalBoolean(params.liveOnly) === true
  const liveCursor = services.live.lastLiveSeq
  // Running turn only: an answer at once, and nothing queued when the turn cannot take it.
  if (liveOnly) return { steered: await controller.steerLive(input), events: [], live: replayLiveFrames(services.live, liveCursor, MAX_TURN_LIVE_FRAMES) }
  const events = method === "turn.enqueue" ? await controller.enqueue(input) : await controller.steer(input)
  return { events: events.map((event) => presentControlEvent(event, { root: controller.session.policy.root })), live: replayLiveFrames(services.live, liveCursor, MAX_TURN_LIVE_FRAMES) }
}

function replayLiveFrames(live: LiveFrameHub, afterLiveSeq: number, maxFrames: number): readonly RunrailLiveFrame[] {
  try {
    return live.since(afterLiveSeq, maxFrames)
  } catch (error) {
    if (!(error instanceof LiveFrameCursorError)) throw error
    return live.since(live.oldestCursor(), maxFrames)
  }
}

function parseQueryBound(value: string | null, min: number, max: number, name: string): number | undefined {
  if (value === null) return undefined
  if (!/^-?\d{1,10}$/.test(value)) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is invalid`)
  const parsed = Number.parseInt(value, 10)
  return parseOptionalBound(parsed, min, max, name)
}

function parseRequiredBound(value: unknown, min: number, max: number, name: string): number {
  const parsed = parseOptionalBound(value, min, max, name)
  if (parsed === undefined) throw new ControlRpcError("CONTROL_INVALID_INPUT", 400, `${name} is required`)
  return parsed
}

function authorized(header: string | null, token: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false
  const supplied = header.slice(7)
  return constantTimeEqual(supplied, token)
}

function constantTimeEqual(leftInput: string, rightInput: string): boolean {
  const left = Buffer.from(leftInput, "utf8")
  const right = Buffer.from(rightInput, "utf8")
  const size = Math.max(left.length, right.length)
  const paddedLeft = Buffer.alloc(size)
  const paddedRight = Buffer.alloc(size)
  left.copy(paddedLeft)
  right.copy(paddedRight)
  const equal = timingSafeEqual(paddedLeft, paddedRight)
  return left.length === right.length && equal
}

function validateServerOptions(
  hostname: string,
  allowRemote: boolean,
  port: number | undefined,
  maxBodyBytes: number,
  authToken: string | undefined,
): void {
  if (hostname.length === 0 || hostname.length > 255 || (!allowRemote && !isLoopbackHost(hostname)))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "remote binding requires allowRemote: true")
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65_535))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "port is invalid")
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 16 * 1024 * 1024)
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "maxBodyBytes is invalid")
  if (authToken !== undefined && !/^[A-Za-z0-9._~-]{16,256}$/.test(authToken))
    throw new ControlRpcError("CONTROL_SERVER_INVALID", 400, "authToken is invalid")
}

/**
 * A browser page never reaches the control plane: it would send an Origin, and a DNS-rebound
 * name in Host. Runrail's own clients send neither, and only `/health` is open without the token.
 */
function refusedPlace(request: Request, allowRemote: boolean): string | undefined {
  if (request.headers.get("origin") !== null) return "CONTROL_ORIGIN_REFUSED"
  if (allowRemote) return undefined
  const host = request.headers.get("host") ?? ""
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0] ?? ""
  return isLoopbackHost(name.toLowerCase()) ? undefined : "CONTROL_HOST_REFUSED"
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true
  const kind = isIP(hostname)
  return kind === 4 && hostname.split(".")[0] === "127"
}

function jsonResponse(value: unknown, status = 200, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  let body: string
  try {
    body = JSON.stringify(value)
  } catch {
    body = JSON.stringify({ ok: false, error: "CONTROL_RESPONSE_INVALID" })
    status = 500
  }
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  })
}

function publicError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof ControlRpcError)
    return { code: error.code, message: error.message.slice(0, 512) }
  if (error instanceof GitError)
    return { code: `CONTROL_${error.code}`, message: error.message.slice(0, 512) }
  if (error instanceof RunrailSessionError) return { code: error.code, message: error.message.slice(0, 512) }
  // A coding tool's backend words its own failures (Codex refusing a request, a tool that exited, a remote agent's answer).
  if (error instanceof CommandAgentBackendError || error instanceof PtyAgentBackendError || error instanceof HttpAgentBackendError) return { code: error.code, message: error.reason.slice(0, 512) }
  // The vault code tells a client why the store failed (locked, timed out, unsafe permissions).
  if (error instanceof CredentialStoreError) return { code: "CONTROL_CREDENTIAL_STORE_FAILED", message: error.vaultCode }
  // The code says what went wrong; nothing the vendor or the user sent is repeated.
  if (error instanceof SignInError) return { code: error.code, message: "sign-in failed" }
  if (isRecord(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_.-]{0,127}$/.test(error.code))
    return { code: error.code, message: "control operation failed" }
  return { code: "CONTROL_OPERATION_FAILED", message: "control operation failed" }
}

/** Compaction and live steering follow the running backend, which `backend.switch` can replace. */
function liveContract(contract: RunrailControlContract, controller: RunrailSessionController): RunrailControlContract {
  const compact: RunrailControlCapabilityStatus = controller.session.canCompact ? "available" : "unavailable"
  const steer: RunrailControlCapabilityStatus = controller.session.canSteerLive ? "available" : "unavailable"
  if (contract.capabilityStatus["session.compact"] === compact && contract.capabilityStatus["turn.steer.live"] === steer) return contract
  return Object.freeze({ ...contract, capabilityStatus: Object.freeze({ ...contract.capabilityStatus, "session.compact": compact, "turn.steer.live": steer }) })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 1_024 && value.every((entry) => typeof entry === "string")
}
