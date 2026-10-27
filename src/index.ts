export { RunrailBackend } from "./backend/runrail-backend.ts"
export {
  BackendRegistry,
  BackendRegistryError,
  backendInfo,
  createBackendRegistry,
  createSecurityManifest,
} from "./backend/registry.ts"
export { createDefaultBackendRegistry } from "./backend/defaults.ts"
export type { DefaultBackendFactories } from "./backend/defaults.ts"
export { createPiBackend } from "./backend/pi.ts"
export { createReplayBackend } from "./backend/replay.ts"
export { CommandAgentBackend, CommandAgentBackendError, createCommandAgentAdapter, createCommandAgentBackend } from "./backend/command-agent.ts"
export { PtyAgentBackend, PtyAgentBackendError, createPtyAgentAdapter, createPtyAgentBackend } from "./backend/pty-agent.ts"
export type { PtyAgentBackendErrorCode, PtyAgentBackendOptions } from "./backend/pty-agent.ts"
export type { CommandAgentBackendErrorCode, CommandAgentBackendOptions, CommandAgentPromptMode } from "./backend/command-agent.ts"
export { PersistentCommandAgentBackend } from "./backend/persistent-command-agent.ts"
export type { PersistentCommandAgentBackendOptions, PersistentCommandAgentControlHandlers } from "./backend/persistent-command-agent.ts"
export { CodexAppServerBackend, CODEX_APP_SERVER_PROTOCOL_VERSION } from "./backend/codex-app-server.ts"
export type { CodexAppServerBackendOptions } from "./backend/codex-app-server.ts"
export { ACP_PROTOCOL_VERSION, AcpAgentBackend, permissionDecision as acpPermissionDecision } from "./backend/acp-agent.ts"
export type { AcpAgentBackendOptions, AcpAuthentication, AcpMcpServer, AcpProcessSettings } from "./backend/acp-agent.ts"
export { CLAUDE_AGENT_SDK, ClaudeAgentSdkBackend, claudeAgentSdkStatus, installClaudeAgentSdk, loadClaudeAgentSdk, parseClaudeAgentSdk, registerClaudeAgentSdk, registerClaudeAgentSdkInstaller, registerClaudeAgentSdkLoader } from "./backend/claude-agent-sdk.ts"
export { agentSdkDirectory, agentSdkInstaller, agentSdkLoader, useDownloadedClaudeAgentSdk, type AgentSdkPin } from "./backend/claude-agent-sdk-download.ts"
export type { ClaudeAgentSdk, ClaudeAgentSdkBackendOptions, ClaudeAgentSdkInstaller, ClaudeAgentSdkSource, ClaudeAgentSdkStatus,ClaudeApprovalScope, ClaudeSdkElicitationRequest, ClaudeSdkElicitationResult, ClaudeSdkPermissionContext, ClaudeSdkPermissionResult, ClaudeSdkQuery, ClaudeSdkQueryOptions, ClaudeSdkSpawnOptions, ClaudeSdkUserMessage } from "./backend/claude-agent-sdk.ts"
export type { ClaudeSdkHookCallback, ClaudeSdkHookMatcher, ClaudeSdkHookOutput } from "./backend/claude-permission-gate.ts"
export { HttpAgentBackend, HttpAgentBackendError, createHttpAgentAdapter, createHttpAgentBackend } from "./backend/http-agent.ts"
export type { HttpAgentBackendErrorCode, HttpAgentBackendOptions } from "./backend/http-agent.ts"
export { ScriptedModel } from "./model/scripted-model.ts"
export { RepairController, buildRepairPrompt, verificationFingerprint } from "./repair/controller.ts"
export { parseCliArgs, runPiPassthrough, runRunrail } from "./cli.ts"
export type {
  CliOptions,
  RunrailCommand,
  RunrailBackendName,
  RunrailEvent,
  PluginCliAction,
  PluginCliOptions,
  PackageCliAction,
  PackageCliOptions,
  RunrailRunOptions,
  RunrailRunResult,
  RunrailTerminalStatus,
} from "./cli.ts"
export { createToolCatalog } from "./tools/catalog.ts"
export { createWorkspacePolicy, filteredEnvironment } from "./workspace/policy.ts"
export type { WorkspaceEntry, WorkspaceSearchMatch, WorkspacePolicy } from "./workspace/policy.ts"
export { createRunrailSession, RunrailSession, RunrailSessionError } from "./session.ts"
export { createRunrailRuntime } from "./session.ts"
export type { RunrailCompaction, RunrailCompactionReason, RunrailRuntime, RunrailSessionOptions } from "./session.ts"
export { startRunrailRpcServer } from "./server.ts"
export type { RunrailRpcServerHandle, RunrailRpcServerOptions } from "./server.ts"
export { startRunrailControlRpcServer } from "./control-server.ts"
export type { RunrailControlRpcServerHandle, RunrailControlRpcServerOptions } from "./control-server.ts"
export {
  assertHandoffSize,
  createPortableHandoff,
  HandoffContractError,
  parsePortableHandoff,
} from "./handoff.ts"
export type {
  PortableHandoff,
  PortableHandoffInput,
  PortableHandoffStatus,
} from "./handoff.ts"
export { routeBackend } from "./router.ts"
export type { RouteDecision, RouteRequest } from "./router.ts"
export { RunrailPlanRunner } from "./plan-runner.ts"
export type { RunrailPlanRunOptions, RunrailPlanRunnerOptions } from "./plan-runner.ts"
export type {
  BackendRegistryErrorCode,
  BackendSelection,
  RunrailBackendAdapter,
  RunrailBackendContext,
} from "./backend/registry.ts"
export {
  ModelCatalog,
  ModelCatalogError,
  RoutedModelPort,
  createModelCatalog,
  createDefaultModelCatalog,
  createRoutedModelPort,
  isThinkingLevel,
  parseModelDescriptor,
  THINKING_LEVELS,
  BudgetLedger,
  BudgetedModelPort,
  RunrailBudgetError,
  parseBudget,
} from "./model/index.ts"
export type {
  CreatedModel,
  ModelAdapter,
  ModelCapability,
  ModelCreateContext,
  ModelDescriptor,
  ModelPricing,
  ModelQuality,
  ModelSelection,
  ModelTier,
  ThinkingLevel,
  BudgetErrorCode,
  ReportedModelUsage,
  RunrailBudget,
  RunrailUsage,
} from "./model/index.ts"
export {
  ContextResourceError,
  ContextResourceSet,
  createContextAwareModelPort,
  createContextResourceSet,
} from "./context/index.ts"
export type {
  ContextResource,
  ContextResourceKind,
  ContextResourceOptions,
  PreparedPrompt,
  PromptAttachment,
  PromptTemplateValues,
  RunrailPromptInput,
} from "./context/index.ts"
export * from "./plugins/index.ts"
export { runRunrailConsole, parseConsoleModelCommand } from "./console.ts"
export type { RunrailConsoleOptions, RunrailConsoleStatus } from "./console.ts"
export { CachedModelPort, MeteredModelPort, RunrailMetrics, createMetrics } from "./runtime/index.ts"
export type { ModelCache, RunrailMetricsSnapshot } from "./runtime/index.ts"
export {
  exportSessionEvidence,
  importSessionEvidence,
  parseSessionEvidence,
  SessionTransferError,
  RUNRAIL_SESSION_EVIDENCE_VERSION,
} from "./session/transfer.ts"
export type { SessionEvidenceBundle, SessionEvidenceEvent, SessionTransferErrorCode } from "./session/transfer.ts"
export { CommandModelError, CommandModelPort, createCommandModelPort } from "./model/command.ts"
export type { CommandModelErrorCode, CommandModelOptions } from "./model/command.ts"
export { ReplayBenchmarkError, runReplayBenchmark, runReferenceBenchmark } from "./benchmark/index.ts"
export type {
  ReplayBenchmarkCase,
  ReplayBenchmarkCaseResult,
  ReplayBenchmarkErrorCode,
  ReplayBenchmarkObservation,
  ReplayBenchmarkOptions,
  ReplayBenchmarkResult,
} from "./benchmark/index.ts"
export type { ReferenceBenchmarkOptions } from "./benchmark/index.ts"
export { RunrailControlError, RunrailSessionController, createRunrailSessionController } from "./control.ts"
export type { RunrailControlInput, RunrailControlListener, RunrailControlSnapshot } from "./control.ts"
export {
  createRunrailControlContract,
  RUNRAIL_CONTROL_API_VERSION,
  RUNRAIL_CONTROL_CAPABILITIES,
  RUNRAIL_CONTROL_MAX_EVENT_BYTES,
  RUNRAIL_CONTROL_MAX_LIVE_EVENTS,
  RUNRAIL_CONTROL_MAX_REPLAY_EVENTS,
  RUNRAIL_CONTROL_PROTOCOL,
} from "./control-contract.ts"
export type { RunrailControlContract } from "./control-contract.ts"
export type { RunrailControlCapability, RunrailControlCapabilityStatus } from "./control-contract.ts"
export { LiveFrameCursorError, LiveFrameHub } from "./live/hub.ts"
export { ConversationBuilder, SESSION_IMPORTED, SESSION_REFRESHED, boundConversationItems, transcriptEntry } from "./conversation/index.ts"
export {
  EXTERNAL_SESSION_SOURCES,
  EXTERNAL_SOURCE_LABELS,
  ExternalSessionError,
  defaultExternalSessionRoots,
  listExternalSessions,
  parseExternalId,
  parseExternalSource,
  readExternalSession,
} from "./session/external.ts"
export type {
  ExternalSessionErrorCode,
  ExternalSessionList,
  ExternalSessionMark,
  ExternalSessionRoots,
  ExternalSessionSource,
  ExternalSessionSummary,
  ExternalSessionTranscript,
} from "./session/external.ts"
export { MODEL_HISTORY_HEADER, ModelHistory, createHistoryModelPort, historyFromTranscript } from "./session/history.ts"
export type { ModelHistoryOptions } from "./session/history.ts"
export {
  MAX_SYSTEM_PROMPT_CHARS,
  assembleSystemPrompt,
  createSystemPromptModelPort,
  createSystemPromptSource,
  defaultCodingPrompt,
  localDate,
  promptFamily,
  readPromptEnvironment,
  type DefaultPromptInput,
  type PromptEnvironment,
  type PromptFamily,
  type SystemPromptSource,
} from "./prompt/index.ts"
export { SHORTENED_TOOL_RESULT, type RestoredToolCall } from "./providers/tool-history.ts"
export type {
  BoundedConversation,
  ConversationApprovalItem,
  ConversationAssistantItem,
  ConversationBuilderOptions,
  ConversationEntry,
  ConversationItem,
  ConversationNoticeItem,
  ConversationReviewItem,
  ConversationToolItem,
  ConversationUserItem,
} from "./conversation/index.ts"
export { APPROVAL_REVIEWED, REVIEWER_NOTICE, type ApprovalReview, type ReviewDecision, type Reviewer, type ReviewerNotice, type ReviewerNoticeKind, type ReviewRisk, type ReviewSource } from "./harness/review.ts"
export type { LiveFrameHubOptions } from "./live/hub.ts"
export type {
  RunrailAgentCompletedFrame,
  RunrailAgentSpawnedFrame,
  RunrailLineageFrame,
  RunrailLiveFrame,
  RunrailLiveFrameInput,
  RunrailLiveSink,
  RunrailModelNoticeFrame,
  RunrailPlanStep,
  RunrailPlanStepStatus,
  RunrailPlanUpdatedFrame,
  RunrailReasoningCompletedFrame,
  RunrailReasoningDeltaFrame,
  RunrailBrowserRequestFrame,
  RunrailThreadsRequestFrame,
  RunrailBrowserNoticeFrame,
  RunrailContextUsageFrame,
  RunrailPlanLimitsFrame,
  RunrailRequestRefusedFrame,
  RunrailUsageReading,
} from "./live/types.ts"
export { BROWSER_ACTIONS, BrowserBridge, BrowserError, browserAddress, isLocalAddress } from "./browser/bridge.ts"
export type { BrowserAction, BrowserBridgeOptions, BrowserErrorCode, BrowserImage, BrowserResult, BrowserTask, RunrailBrowserAccess } from "./browser/bridge.ts"
export { BROWSER_TOOL_SPECS, createBrowserTools } from "./browser/tools.ts"
export type { BrowserToolSpec } from "./browser/tools.ts"
export { THREADS_ACTIONS, ThreadsBridge, ThreadsError } from "./threads/bridge.ts"
export type { RunrailThreadsAccess, ThreadsAction, ThreadsBridgeOptions, ThreadsErrorCode, ThreadsResult, ThreadsTask } from "./threads/bridge.ts"
export { THREADS_TOOL_SPECS, createThreadsTools } from "./threads/tools.ts"
export type { ThreadsToolSpec } from "./threads/tools.ts"
export { COMPUTER_ACTIONS, ComputerBridge, ComputerError } from "./computer/bridge.ts"
export type { ComputerAction, ComputerBridgeOptions, ComputerErrorCode, ComputerResult, ComputerTask, RunrailComputerAccess } from "./computer/bridge.ts"
export { COMPUTER_TOOL_SPECS } from "./computer/tools.ts"
export type { ComputerToolSpec } from "./computer/tools.ts"
export { ImageError, generateImage } from "./images/generate.ts"
export type { GeneratedImage, ImageErrorCode, ImageRequest, ImageShape } from "./images/generate.ts"
export { parseImageModels } from "./images/models.ts"
export type { ImageModel, ImageRoute } from "./images/models.ts"
export { ImageService } from "./images/service.ts"
export type { ImageSource, ImageToolResult, RunrailImageAccess } from "./images/service.ts"
export { IMAGE_TOOL_SPECS, createImageTools } from "./images/tools.ts"
export type { ImageToolSpec } from "./images/tools.ts"
export { RUNRAIL_TERMINAL_MAX_INPUT_BYTES, RUNRAIL_TERMINAL_MAX_OUTPUT_BYTES, validateRunrailTerminalBridge } from "./control-terminal.ts"
export { PTY_TERMINAL_CHUNK_BYTES, createPtyTerminalBridge } from "./terminal/pty.ts"
export type { PtyTerminalBridge, PtyTerminalBridgeOptions } from "./terminal/pty.ts"
export type { RunrailTerminalBridge, RunrailTerminalCapability, RunrailTerminalChunk, RunrailTerminalDescriptor, RunrailTerminalReadResult, RunrailTerminalSession, RunrailTerminalSessionStatus } from "./control-terminal.ts"

export { runRunrailTui } from "./tui.ts"
export type { RunrailTuiOptions } from "./tui.ts"

export { createGatewayModelAdapter, createGatewayContentModelPort } from "./model/gateway.ts"
export type { GatewayModelAdapterOptions, GatewayContentModelOptions } from "./model/gateway.ts"
export { createFallbackModelPort, FallbackModelPort } from "./model/fallback.ts"
export type { ModelFallbackOptions } from "./model/fallback.ts"
export { ContentModelPortBridge, createContentModelPort, isImageMediaType, isRunrailContentPart } from "./model/content.ts"
export type { ImageMediaType, RunrailContentModelPort, RunrailContentModelRequest, RunrailContentPart, RunrailContentPartInput } from "./model/content.ts"
export { CommandContentModelPort, createCommandContentModelPort } from "./model/command.ts"
export { runRunrailWorkbench } from "./workbench/runner.ts"
export * from "./workbench/index.ts"
export type { SessionTreeSnapshot } from "./session.ts"
export * from "./certification/index.ts"
export * from "./skills/index.ts"
export * from "./connectors/index.ts"
export * from "./worktree/index.ts"
export * from "./agents/index.ts"
export * from "./mcp/index.ts"
export * from "./providers/index.ts"
export * from "./harness/index.ts"
export { createDefaultHarnessAdapters } from "./harness/defaults.ts"
export { integrationRequirements, mergeIntegrationBundles, unsupportedIntegrations } from "./integrations.ts"
export type { RunrailIntegrationBundle, RunrailIntegrationContext, RunrailIntegrationHook, RunrailIntegrationName } from "./integrations.ts"
export { RUNRAIL_VERSION } from "./version.ts"
export * from "./sandbox/index.ts"
export * from "./hosting/index.ts"
export * from "./compatibility/index.ts"
export * from "./transcript/index.ts"
export * from "./native/index.ts"
export * from "./task/index.ts"
export * from "./accounts/index.ts"
export * from "./auth/index.ts"
export { checkConnection, connectionCheckStatus, type ConnectionCheck, type ConnectionCheckCode, type ConnectionCheckOptions, type ConnectionCheckStatus } from "./connection-check.ts"
export * from "./share/index.ts"
export * from "./packages/index.ts"
