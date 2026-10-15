#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import {
  type AgentBackend,
  type AgentEvent,
  type AgentError,
} from "@nifrajs/agent-protocol"
import {
  type PiBackendOptions,
} from "@nifrajs/coding-agent"
import { verificationFingerprint } from "./repair/controller.ts"
import { createRunrailSession, DEFAULT_MAX_STEPS, MAX_REPLY_CHARS, MIN_REPLY_CHARS } from "./session.ts"
import { nifraNotice, verificationGateAvailable } from "./nifra.ts"
import { parseNewCliArgs, runNewCli } from "./starters.ts"
import { runRunrailConsole } from "./console.ts"
import { runRunrailTui } from "./tui.ts"
import { createDefaultBackendRegistry, isAcpRouteBackend } from "./backend/defaults.ts"
import type { ContextResourceOptions } from "./context/resources.ts"
import type { ModelCapability, ModelCatalog, ModelDescriptor, ModelQuality, ModelSelection, ThinkingLevel } from "./model/catalog.ts"
import type { RunrailBudget, RunrailUsage } from "./model/budget.ts"
import type { CommandModelOptions } from "./model/command.ts"
import { createDefaultModelCatalog, isThinkingLevel } from "./model/catalog.ts"
import type { ModelCache, RunrailMetrics } from "./runtime/metrics.ts"
import { createPluginManager } from "./plugins/manager.ts"
import type { PluginManager } from "./plugins/manager.ts"
import { createPiMigrationPlan, PiResourceAdapter } from "./plugins/pi/index.ts"
import { createPiExtensionHost, type PiExtensionHost } from "./plugins/pi/extensions.ts"
import { startRunrailRpcServer } from "./server.ts"
import { startRunrailControlRpcServer } from "./control-server.ts"
import { checkTerminalShell, createPtyTerminalBridge } from "./terminal/pty.ts"
import { runReferenceBenchmark } from "./benchmark/index.ts"
import { McpClient } from "./mcp/client.ts"
import { runRunrailMcpServer } from "./mcp/stdio.ts"
import { browserMcpCommand, runBrowserMcpServer } from "./browser/mcp.ts"
import { runConnectorsMcpServer } from "./connectors/mcp.ts"
import { runThreadsMcpServer } from "./threads/mcp.ts"
import { runComputerMcpServer } from "./computer/mcp.ts"
import { runImagesMcpServer } from "./images/mcp.ts"
import { runWakeService } from "./service/wake.ts"
import { NativePackageManager } from "./packages/index.ts"
import { RUNRAIL_VERSION } from "./version.ts"
import type { PluginPermission } from "./plugins/manifest.ts"
import type { ProviderDiscoveryOptions, ProviderModelOptions } from "./providers/types.ts"
import { createDefaultProviderCatalog, discoverProviderModels } from "./providers/catalog.ts"
import { createDefaultHarnessAdapters } from "./harness/defaults.ts"
import { mayContinue } from "./harness/event-text.ts"
import { HarnessRegistry } from "./harness/registry.ts"
import { HARNESS_EFFORTS, HARNESS_PERMISSION_MODES, parseHarnessLaunchOptions, type HarnessEffort, type HarnessLaunchOptions, type HarnessPermissionMode } from "./harness/launch.ts"
import { HARNESS_PROTOCOLS, type HarnessAuthMode, type HarnessAuthOptions, type HarnessProtocol } from "./harness/types.ts"
import type { HarnessAccountOptions } from "./harness/account.ts"
import { createDefaultPiCompatibilityMatrix, summarizePiCompatibilityMatrix } from "./compatibility/index.ts"
import { createDefaultHarnessCompatibilityMatrix, summarizeHarnessCompatibilityMatrix } from "./harness/index.ts"
import { createDefaultNativeCapabilityMatrix, summarizeNativeCapabilityMatrix } from "./native/index.ts"
import { FileTranscriptStore } from "./transcript/index.ts"
import { continueTranscript } from "./session/carryover.ts"
import { FileCredentialVault, KeychainCredentialVault, MemoryCredentialVault, VaultCredentialBroker, credentialRefreshersFor, defaultSignInFlows, osKeychainReachable, type CredentialVault, type SignInFlow } from "./auth/index.ts"
import { vendorSignInFlows } from "./auth/vendors-unofficial/index.ts"
import { AUTH_DOCTOR_USAGE, runAuthDoctor, type AuthDoctorOptions } from "./connection-check.ts"
import { SIGN_IN_CLI_USAGE, runSignInCli, type SignInCliOptions } from "./login-cli.ts"
import { AccountError, ConnectionDirectory, ConnectionSettingsError, EnvironmentCredentialBroker, FileAccountStore, FileConnectionSettingsStore, createAccountCredentialResolver, resolveConnection, toolConnectionAccount } from "./accounts/index.ts"
import { resolveAccountsRoot } from "./accounts/storage.ts"
import { ProviderError } from "./providers/errors.ts"
import { createModelMetadataSource, modelDescriptorFacts } from "./providers/model-list.ts"
import { getCustomProviderPreset, getProviderPreset, isProviderFamilyId } from "./providers/presets.ts"
import { timed } from "./startup-timings.ts"
import { exportCliSession, listCliSessions, openCliSession, prepareCliSession, resolveSessionsRoot, routeArgs, routeBackend, shortId, type CliSessionPlan, type OpenCliSession } from "./sessions-cli.ts"
import { doctorText, runDoctor } from "./doctor.ts"
import type { TranscriptStore } from "./transcript/store.ts"
import { terminalText } from "./workbench/terminal-text.ts"
export type RunrailBackendName = "replay" | "native" | "pi" | "codex" | "claude-code" | "copilot" | "opencode" | "gemini" | "goose"
export type RunrailCommand = "run" | "pi" | "backends" | "models" | "providers" | "harnesses" | "compatibility" | "plugins" | "packages" | "serve" | "control" | "console" | "benchmark" | "mcp" | "browser-mcp" | "connectors-mcp" | "threads-mcp" | "computer-mcp" | "images-mcp" | "login" | "logout" | "auth" | "service" | "sessions" | "export" | "doctor"
export type VerificationName = "check" | "assure" | "test"
export type RunrailTerminalStatus =
  | "succeeded"
  | "cancelled"
  | "denied"
  | "timed_out"
  | "exhausted"
  | "unrecoverable"

export type PluginCliAction = "list" | "install" | "inspect-pi" | "migrate-pi" | "update" | "rollback" | "remove" | "enable" | "disable" | "activate" | "deactivate" | "configure" | "test"
export interface PluginCliOptions {
  readonly action: PluginCliAction
  readonly id?: string
  readonly source?: string
  readonly capabilities: readonly string[]
  readonly permissions: readonly PluginPermission[]
  readonly config?: unknown
}
export type PackageCliAction = "search" | "install" | "update" | "remove" | "list" | "lock" | "verify" | "audit" | "activate" | "rollback" | "doctor" | "enable" | "disable"
export interface PackageCliOptions {
  readonly action: PackageCliAction
  readonly id?: string
  readonly source?: string
  readonly replace?: boolean
  readonly approvalGranted?: boolean
}
export interface CliOptions {
  readonly command: RunrailCommand
  readonly cwd: string
  readonly backend: RunrailBackendName
  readonly requiredCapabilities?: readonly string[]
  readonly maxSteps: number
  readonly maxRepairAttempts: number
  readonly verify: VerificationName
  readonly verificationCommand?: string
  readonly verificationTimeoutMs?: number
  readonly json: boolean
  readonly task: string
  readonly piArgs: readonly string[]
  readonly piCommand?: string
  readonly piOptions?: Pick<
    PiBackendOptions,
    | "args"
    | "env"
    | "maxEventQueueSize"
    | "rpcArgs"
    | "noSession"
    | "sessionDir"
    | "reloadCommand"
    | "enableReloadBridge"
    | "appendSystemPrompt"
    | "enableNifraTools"
  >
  readonly sessionDir?: string
  /** Opt-in caller-owned transcript storage for the control sidecar. */
  readonly transcriptDir?: string
  /** Another session's transcript this one continues: copied in, with a marker, the first time the session starts. */
  readonly continueFrom?: { readonly transcriptDir: string; readonly sessionId: string }
  /** Root for control thread worktrees; defaults to `~/.runrail/worktrees`. */
  readonly worktreeRoot?: string
  /** A client's thread folders, read by `conversation.peek`. */
  readonly threadsDir?: string
  /** Directory for account metadata shared by every control sidecar; defaults to `~/.runrail/accounts`. */
  readonly accountsDir?: string
  /** Where pasted keys and sign-in tokens are kept; defaults to the OS keychain. */
  readonly credentialVault?: CliCredentialVault
  /** A saved connection to run on. Resolved to `provider` before the command starts. */
  readonly connection?: { readonly id: string; readonly model: string; readonly thinking?: ThinkingLevel }
  /** The coding-tool connection a tool backend runs as: it must be on, and its first model is the default. */
  readonly toolConnection?: string
  /** What `login` or `logout` was asked to do. */
  readonly signIn?: SignInCliOptions
  /** False when `login --no-browser` asked for the page to be printed only. */
  readonly openBrowser?: boolean
  /** The connection `auth doctor` checks. */
  readonly doctor?: AuthDoctorOptions
  /** Serve `terminal.*` from a local PTY shell for the control sidecar. */
  readonly terminal?: boolean
  /** The shell those terminals run; one of the login shells the system lists. */
  readonly terminalShell?: string
  /** Stop the control sidecar when its stdin closes, so it cannot outlive the process that started it. */
  readonly exitOnStdinClose?: boolean
  /** Let the agent use the desktop's browser preview: on this computer only, unless `browserAnySite`. */
  readonly browserTools?: boolean
  readonly browserAnySite?: boolean
  /** Let the agent list, read and message the person's other threads, through the desktop. */
  readonly threadTools?: boolean
  /** Let the agent see and use apps on the person's Mac that they allowed, through the desktop. */
  readonly computerTools?: boolean
  /** Let the agent make pictures with the image model the person chose from their connections. */
  readonly imageTools?: boolean
  /** Control only: the project's related folders, which the agent may read and edit beside the working folder. */
  readonly folders?: readonly string[]
  /** Control, console, and serve: check, and repair, after each turn. Off unless asked, since a failing check makes the agent edit code. */
  readonly verifyAfterTurn?: boolean
  /** Control only: snapshot the work tree before each turn, so a rewind can put files back. */
  readonly checkpoints?: boolean
  /** Where `browser-mcp` reads the control server's address and its browser token. */
  readonly browserEndpointFile?: string
  /** `service` only: the app bundle it opens when work is due. */
  readonly serviceApp?: string
  readonly provider?: ProviderModelOptions
  readonly providerDiscovery?: ProviderDiscoveryOptions
  readonly harnessCommand?: string
  readonly harnessArgs?: readonly string[]
  readonly harnessAuth?: HarnessAuthOptions
  /** Set by `--tool-connection`: the connection's own config folder or key for the tool. */
  readonly harnessAccount?: HarnessAccountOptions
  /** Set by `--tool-connection`: the connection and its chosen models, which the control session is held to. */
  readonly toolConnectionRoute?: { readonly connectionId: string; readonly models?: readonly string[] }
  readonly harnessPersistent?: boolean
  readonly harnessProtocol?: HarnessProtocol
  readonly harnessLaunch?: HarnessLaunchOptions
  readonly sessionId?: string
  readonly behaviorConfigPath?: string
  /** Read the user-wide skill folders in place; unset leaves it to the behavior file. */
  readonly userSkills?: boolean
  /** `false` (`--no-nifra`) turns off Nifra's tools, instructions, and default check; unset leaves them to the project. */
  readonly nifra?: boolean
  readonly modelSelection?: ModelSelection
  readonly modelCommand?: CommandModelOptions
  readonly budget?: RunrailBudget
  readonly context?: ContextResourceOptions
  /** False: a provider session gets no default coding prompt, only project context and the user's own instructions. */
  readonly defaultSystemPrompt?: boolean
  /** How long a native approval waits for an answer, at most 24 hours; without it, until it is answered. */
  readonly approvalTimeoutMs?: number
  /** Longest reply the native model may give in one turn; default 1 MiB characters. */
  readonly maxReplyChars?: number
  readonly piExtensionPaths?: readonly string[]
  readonly piExtensionCapabilities?: readonly string[]
  readonly host?: string
  readonly port?: number
  readonly authToken?: string
  readonly plugin?: PluginCliOptions
  readonly package?: PackageCliOptions
  readonly benchmarkRepeats?: number
  readonly benchmarkConcurrency?: number
  readonly mcpMaxMessageBytes?: number
  readonly mcpCommand?: string
  readonly mcpArgs?: readonly string[]
  readonly mcpLoadResources?: boolean
  /** `sessions`: the folder to list, else every saved session, and how many. */
  readonly sessionList?: { readonly cwd?: string; readonly limit: number }
  /** `export`: the session, the format, and a file to write instead of printing. */
  readonly sessionExport?: { readonly ref: string; readonly format: "json" | "markdown"; readonly out?: string }
  /** `doctor --cwd`: a project folder to check as well. */
  readonly doctorCwd?: string
}

export interface RunrailRunOptions {
  readonly cwd: string
  readonly backend: RunrailBackendName
  readonly requiredCapabilities?: readonly string[]
  readonly maxSteps?: number
  readonly maxRepairAttempts?: number
  readonly verify?: VerificationName
  readonly task?: string
  readonly signal?: AbortSignal
  readonly verificationCommand?: string
  readonly verificationTimeoutMs?: number
  readonly sessionDir?: string
  readonly sessionId?: string
  readonly behaviorConfigPath?: string
  /** Read the user-wide skill folders in place; unset leaves it to the behavior file. */
  readonly userSkills?: boolean
  /** `false` (`--no-nifra`) turns off Nifra's tools, instructions, and default check; unset leaves them to the project. */
  readonly nifra?: boolean
  readonly harnessCommand?: string
  readonly harnessArgs?: readonly string[]
  readonly harnessAuth?: HarnessAuthOptions
  readonly harnessAccount?: HarnessAccountOptions
  readonly provider?: ProviderModelOptions
  readonly harnessPersistent?: boolean
  readonly harnessProtocol?: HarnessProtocol
  readonly harnessLaunch?: HarnessLaunchOptions
  readonly modelCommand?: CommandModelOptions
  readonly modelCatalog?: ModelCatalog
  readonly modelSelection?: ModelSelection
  readonly budget?: RunrailBudget
  readonly context?: ContextResourceOptions
  /** False: a provider session gets no default coding prompt, only project context and the user's own instructions. */
  readonly defaultSystemPrompt?: boolean
  /** How long a native approval waits for an answer, at most 24 hours; without it, until it is answered. */
  readonly approvalTimeoutMs?: number
  /** Longest reply the native model may give in one turn; default 1 MiB characters. */
  readonly maxReplyChars?: number
  readonly onUsage?: (usage: RunrailUsage) => void
  readonly metrics?: RunrailMetrics
  readonly cache?: ModelCache
  readonly onEvent?: (event: AgentEvent) => void
  /** A line for the person running it, such as what Nifra adds to this run. */
  readonly onNotice?: (line: string) => void
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
  readonly approval?: import("@nifrajs/coding-agent").NativeApprovalPort
  readonly model?: import("@nifrajs/coding-agent").NativeModelPort
  readonly fallbackModel?: import("@nifrajs/coding-agent").NativeModelPort
  readonly mcpClients?: readonly import("./mcp/client.ts").McpClient[]
  readonly mcpLoadResources?: boolean
  readonly piExtensions?: PiExtensionHost
  /** Where the conversation is kept, so a later run can continue it. */
  readonly transcriptStore?: TranscriptStore
  /** False: `sessionDir` holds no behavior file; only `behaviorConfigPath` is read. */
  readonly sessionBehaviorFile?: boolean
}

export interface RunrailEvent {
  readonly seq: number
  readonly type: string
  readonly tool?: string
  readonly ok?: boolean
  readonly code?: string
  readonly status?: number | null
  readonly attempt?: number
  readonly reason?: string
}

export interface RunrailRunResult {
  readonly backend: RunrailBackendName
  readonly cwd: string
  readonly sessionId?: string
  readonly status: RunrailTerminalStatus
  readonly verification?: { readonly name: VerificationName; readonly ok: boolean; readonly status: number | null }
  readonly model?: ModelDescriptor
  readonly usage?: RunrailUsage
  readonly repairAttempts: number
  readonly events: readonly RunrailEvent[]
  readonly digest: string

}
export function parseCliArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): CliOptions {
  if (argv[0] === "pi") {
    return {
      command: "pi",
      cwd: resolve("."),
      backend: "pi",
      maxSteps: DEFAULT_MAX_STEPS,
      maxRepairAttempts: 2,
      verify: "check",
      json: false,
      task: "",
      piArgs: Object.freeze([...argv.slice(1)]),
    }
  }
  if (argv[0] === "backends") {
    if (argv.slice(1).some((arg) => arg !== "--json")) throw new Error("backends accepts only --json")
    return {
      command: "backends",
      cwd: resolve("."),
      backend: "native",
      maxSteps: DEFAULT_MAX_STEPS,
      maxRepairAttempts: 2,
      verify: "check",
      json: argv.includes("--json"),
      task: "",
      piArgs: Object.freeze([]),
    }
  }
  if (argv[0] === "models") return parseModelListCliArgs(argv.slice(1))
  if (argv[0] === "providers") {
    if (argv.slice(1).some((arg) => arg !== "--json")) throw new Error("providers accepts only --json")
    return { command: "providers", cwd: resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json: argv.includes("--json"), task: "", piArgs: Object.freeze([]) }
  }
  if (argv[0] === "harnesses") {
    if (argv.slice(1).some((arg) => arg !== "--json")) throw new Error("harnesses accepts only --json")
    return { command: "harnesses", cwd: resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json: argv.includes("--json"), task: "", piArgs: Object.freeze([]) }
  }
  if (argv[0] === "compatibility") {
    if (argv.slice(1).some((arg) => arg !== "--json")) throw new Error("compatibility accepts only --json")
    return { command: "compatibility", cwd: resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json: argv.includes("--json"), task: "", piArgs: Object.freeze([]) }
  }
  if (argv[0] === "benchmark") return parseBenchmarkCliArgs(argv.slice(1))
  if (argv[0] === "mcp") return parseMcpCliArgs(argv.slice(1))
  if (argv[0] === "browser-mcp") return parseBrowserMcpCliArgs(argv.slice(1))
  if (argv[0] === "connectors-mcp") return parseBrowserMcpCliArgs(argv.slice(1), "connectors-mcp")
  if (argv[0] === "threads-mcp") return parseBrowserMcpCliArgs(argv.slice(1), "threads-mcp")
  if (argv[0] === "computer-mcp") return parseBrowserMcpCliArgs(argv.slice(1), "computer-mcp")
  if (argv[0] === "images-mcp") return parseBrowserMcpCliArgs(argv.slice(1), "images-mcp")
  if (argv[0] === "service") return parseServiceCliArgs(argv.slice(1))
  if (argv[0] === "packages") return parsePackageCliArgs(argv.slice(1))
  if (argv[0] === "plugins") return parsePluginCliArgs(argv.slice(1))
  if (argv[0] === "login" || argv[0] === "logout") return parseSignInCliArgs(argv[0], argv.slice(1))
  if (argv[0] === "auth") return parseAuthCliArgs(argv.slice(1))
  if (argv[0] === "sessions") return parseSessionsCliArgs(argv.slice(1))
  if (argv[0] === "export") return parseExportCliArgs(argv.slice(1))
  if (argv[0] === "doctor") return parseDoctorCliArgs(argv.slice(1))
  const command = argv[0]
  if (command !== "run" && command !== "serve" && command !== "control" && command !== "console")
    throw new Error("usage: runrail run|serve|control|console|sessions|export|doctor|benchmark|mcp|providers|harnesses|compatibility|login|logout|auth --backend replay|native|pi|codex|claude-code|copilot|opencode|gemini|goose --cwd <path> [task]")
  let cwd: string | undefined
  let backend: RunrailBackendName = "native"
  const requiredCapabilities: string[] = []
  let maxSteps = DEFAULT_MAX_STEPS
  let maxRepairAttempts = 2
  let verify: VerificationName = "check"
  let verificationCommand: string | undefined
  let verificationTimeoutMs: number | undefined
let json = false
let sessionDir: string | undefined
let transcriptDir: string | undefined
let continueFromDir: string | undefined
let continueFromSession: string | undefined
let worktreeRoot: string | undefined
let threadsDir: string | undefined
  let accountsDir: string | undefined
  let credentialVault: CliCredentialVault | undefined
let terminal = false
let terminalShell: string | undefined
let exitOnStdinClose = false
let browserTools = false
let verifyAfterTurn = false
let checkpoints = false
let browserAnySite = false
let threadTools = false
let computerTools = false
let imageTools = false
const folders: string[] = []
  let sessionId: string | undefined
  let behaviorConfigPath: string | undefined
  let userSkills: boolean | undefined
  let nifra: boolean | undefined
  let modelCommand: string | undefined
  const modelCommandArgs: string[] = []
  const modelCapabilities: ModelCapability[] = []
  const requiredModelCapabilities: ModelCapability[] = []
  let modelId: string | undefined
  let providerName: ProviderModelOptions["provider"] | undefined
  let connectionId: string | undefined
  let toolConnectionId: string | undefined
  let providerModel: string | undefined
  let providerCredentialEnvironment: string | undefined
  let providerEndpoint: string | undefined
  let providerAllowRemote = false
  let providerAllowInsecureRemote = false
  let providerProtocol: ProviderModelOptions["protocol"] | undefined
  let providerTimeoutMs: number | undefined
  let providerMaxRetries: number | undefined
  let harnessCommand: string | undefined
  const harnessArgs: string[] = []
  let harnessAuthMode: HarnessAuthMode | undefined
  let harnessPersistent = false
  let harnessProtocol: HarnessProtocol | undefined
  const harnessCredentialEnvironment: string[] = []
  let harnessEffort: HarnessEffort | undefined
  let harnessPermissionMode: HarnessPermissionMode | undefined
  let harnessAppendSystemPrompt: string | undefined
  const harnessMcpConfig: string[] = []
  let harnessResume: string | undefined
  let quality: ModelQuality | undefined
  let thinking: ThinkingLevel | undefined
  let maxInputTokens: number | undefined
  let maxOutputTokens: number | undefined
  let maxTotalTokens: number | undefined
  let maxCostUsd: number | undefined
  let maxToolCalls: number | undefined
  let maxDurationMs: number | undefined
  const contextFiles: string[] = []
  const skillPaths: string[] = []
  const themePaths: string[] = []
  const piExtensionPaths: string[] = []
  const piExtensionCapabilities: string[] = []
  let noContext = false
  let noDefaultPrompt = false
  let approvalTimeoutMs: number | undefined
  let maxReplyChars: number | undefined
  let noSession = false
  let systemPrompt: string | undefined
  let mcpCommand: string | undefined
  const mcpArgs: string[] = []
  let mcpLoadResources = false
  let piCommand: string | undefined
  const piArgs: string[] = []
  const piRpcArgs: string[] = []
  let piSystemPrompt: string | undefined
  let piNifraTools: boolean | undefined
  const piEnvironment: Record<string, string | undefined> = {}
  let piMaxEventQueueSize: number | undefined
  let piReloadCommand: PiBackendOptions["reloadCommand"]
let host: string | undefined
let port: number | undefined
let authToken: string | undefined
  const task: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") {
      json = true
      continue
    }
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === "--cwd") cwd = value()
    else if (arg === "--backend") {
      const next = value()
      if (next !== "replay" && next !== "native" && next !== "pi" && next !== "codex" && next !== "claude-code" && next !== "copilot" && next !== "opencode" && next !== "gemini" && next !== "goose") throw new Error("invalid backend")
      backend = next
    } else if (arg === "--harness-command") harnessCommand = boundedText(value(), "harness-command", 256)
    else if (arg === "--harness-persistent") harnessPersistent = true
    else if (arg === "--harness-protocol") {
      const next = value()
      if (!HARNESS_PROTOCOLS.includes(next as HarnessProtocol)) throw new Error("invalid harness protocol")
      harnessProtocol = next as HarnessProtocol
    }
    else if (arg === "--harness-arg") harnessArgs.push(boundedText(value(), "harness-arg", 4_096))
    else if (arg === "--harness-effort") {
      const next = value()
      if (!HARNESS_EFFORTS.includes(next as HarnessEffort)) throw new Error("invalid harness effort")
      harnessEffort = next as HarnessEffort
    } else if (arg === "--harness-permission-mode") {
      const next = value()
      if (!HARNESS_PERMISSION_MODES.includes(next as HarnessPermissionMode)) throw new Error("invalid harness permission mode")
      harnessPermissionMode = next as HarnessPermissionMode
    } else if (arg === "--harness-append-system-prompt") harnessAppendSystemPrompt = boundedText(value(), "harness-append-system-prompt", 32 * 1024)
    else if (arg === "--harness-mcp-config") harnessMcpConfig.push(boundedText(value(), "harness-mcp-config", 4_096))
    else if (arg === "--harness-resume") harnessResume = boundedText(value(), "harness-resume", 128)
    else if (arg === "--harness-auth") {
      const next = value()
      if (next !== "subscription" && next !== "environment" && next !== "caller") throw new Error("invalid harness authentication mode")
      harnessAuthMode = next
    } else if (arg === "--harness-credential-env") {
      const next = value()
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(next) || harnessCredentialEnvironment.includes(next) || harnessCredentialEnvironment.length >= 16) throw new Error("invalid harness credential environment")
      harnessCredentialEnvironment.push(next)
    }
    else if (arg === "--require-capability") {
      const capability = value()
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(capability)) throw new Error("invalid required capability")
      requiredCapabilities.push(capability)
    } else if (arg === "--max-steps") maxSteps = parseBoundedInteger(value(), "max-steps", 1, 512)
    else if (arg === "--max-repair-attempts") maxRepairAttempts = parseBoundedInteger(value(), "max-repair-attempts", 0, 8)
    else if (arg === "--verify") {
      const next = value()
      if (next !== "check" && next !== "assure" && next !== "test") throw new Error("invalid verification gate")
      verify = next
    } else if (arg === "--verification-command") verificationCommand = boundedText(value(), "verification-command", 256)
    else if (arg === "--verification-timeout-ms") verificationTimeoutMs = parseBoundedInteger(value(), "verification-timeout-ms", 1, 120_000)
    else if (arg === "--session-dir") sessionDir = resolve(value())
    else if (arg === "--transcript-dir") transcriptDir = resolve(value())
    else if (arg === "--continue-from-dir") continueFromDir = resolve(boundedText(value(), "continue-from-dir", 4_096))
    else if (arg === "--continue-from-session") continueFromSession = boundedText(value(), "continue-from-session", 256)
    else if (arg === "--worktree-root") worktreeRoot = resolve(boundedText(value(), "worktree-root", 4_096))
    else if (arg === "--threads-dir") threadsDir = resolve(boundedText(value(), "threads-dir", 4_096))
    else if (arg === "--accounts-dir") accountsDir = resolve(boundedText(value(), "accounts-dir", 4_096))
    else if (arg === "--credential-vault") credentialVault = parseCredentialVault(value())
    else if (arg === "--terminal") terminal = true
    else if (arg === "--terminal-shell") terminalShell = checkTerminalShell(boundedText(value(), "terminal shell", 256))
    else if (arg === "--exit-on-stdin-close") exitOnStdinClose = true
    else if (arg === "--browser-tools") browserTools = true
    else if (arg === "--verify-after-turn") verifyAfterTurn = true
    else if (arg === "--checkpoints") checkpoints = true
    else if (arg === "--browser-any-site") browserAnySite = true
    else if (arg === "--thread-tools") threadTools = true
    else if (arg === "--computer-tools") computerTools = true
    else if (arg === "--image-tools") imageTools = true
    else if (arg === "--add-dir") folders.push(resolve(boundedText(value(), "added folder", 4_096)))
    else if (arg === "--session-id") sessionId = value()
    else if (arg === "--config") behaviorConfigPath = boundedText(value(), "behavior config", 4_096)
    else if (arg === "--provider") providerName = parseCliProvider(value())
    else if (arg === "--connection") {
      const next = value()
      if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(next)) throw new Error("connection id is invalid")
      connectionId = next
    } else if (arg === "--tool-connection") {
      const next = value()
      if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(next)) throw new Error("tool connection id is invalid")
      toolConnectionId = next
    } else if (arg === "--provider-model") providerModel = boundedText(value(), "provider-model", 256)
    else if (arg === "--provider-credential-env") {
      const next = value()
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(next)) throw new Error("provider credential environment is invalid")
      providerCredentialEnvironment = next
    } else if (arg === "--provider-endpoint") providerEndpoint = boundedText(value(), "provider-endpoint", 2_048)
    else if (arg === "--provider-allow-remote") providerAllowRemote = true
    else if (arg === "--provider-allow-insecure-remote") providerAllowInsecureRemote = true
    else if (arg === "--provider-protocol") {
      const next = value()
      if (next !== "responses" && next !== "chat") throw new Error("invalid provider protocol")
      providerProtocol = next
    } else if (arg === "--provider-timeout-ms") providerTimeoutMs = parseBoundedInteger(value(), "provider-timeout-ms", 1, 120_000)
    else if (arg === "--provider-max-retries") providerMaxRetries = parseBoundedInteger(value(), "provider-max-retries", 0, 5)
    else if (arg === "--model-command") modelCommand = boundedText(value(), "model-command", 256)
    else if (arg === "--model-command-arg") modelCommandArgs.push(boundedText(value(), "model-command-arg", 4_096))
    else if (arg === "--model-capability") modelCapabilities.push(parseModelCapability(value()))
    else if (arg === "--requires-model-capability") requiredModelCapabilities.push(parseModelCapability(value()))
    else if (arg === "--model") modelId = boundedText(value(), "model", 128)
    else if (arg === "--quality") {
      const next = value()
      if (next !== "balanced" && next !== "cheap" && next !== "fast" && next !== "strong") throw new Error("invalid model quality")
      quality = next
    } else if (arg === "--thinking") {
      const next = value()
      if (!isThinkingLevel(next)) throw new Error("invalid thinking level")
      thinking = next
    } else if (arg === "--max-input-tokens") maxInputTokens = parseBoundedInteger(value(), "max-input-tokens", 1, 10_000_000)
    else if (arg === "--max-output-tokens") maxOutputTokens = parseBoundedInteger(value(), "max-output-tokens", 1, 10_000_000)
    else if (arg === "--max-total-tokens") maxTotalTokens = parseBoundedInteger(value(), "max-total-tokens", 1, 20_000_000)
    else if (arg === "--max-cost-usd") maxCostUsd = parseBoundedNumber(value(), "max-cost-usd", 0, 1_000_000)
    else if (arg === "--max-tool-calls") maxToolCalls = parseBoundedInteger(value(), "max-tool-calls", 1, 512)
    else if (arg === "--max-duration-ms") maxDurationMs = parseBoundedInteger(value(), "max-duration-ms", 1, 86_400_000)
    else if (arg === "--context-file") contextFiles.push(boundedText(value(), "context-file", 512))
    else if (arg === "--skill-path") skillPaths.push(boundedText(value(), "skill-path", 512))
    else if (arg === "--theme-path") themePaths.push(boundedText(value(), "theme-path", 512))
    else if (arg === "--pi-extension") piExtensionPaths.push(boundedText(value(), "pi-extension", 4_096))
    else if (arg === "--pi-extension-capability") {
      const capability = value()
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(capability)) throw new Error("invalid Pi extension capability")
      piExtensionCapabilities.push(capability)
    }
    else if (arg === "--no-context") noContext = true
    else if (arg === "--user-skills") userSkills = true
    else if (arg === "--no-user-skills") userSkills = false
    else if (arg === "--no-nifra") nifra = false
    else if (arg === "--no-default-prompt") noDefaultPrompt = true
    else if (arg === "--approval-timeout-ms") approvalTimeoutMs = parseBoundedInteger(value(), "approval-timeout-ms", 1, 86_400_000)
    else if (arg === "--max-reply-chars") maxReplyChars = parseBoundedInteger(value(), "max-reply-chars", MIN_REPLY_CHARS, MAX_REPLY_CHARS)
    else if (arg === "--system-prompt") systemPrompt = boundedText(value(), "system-prompt", 256 * 1024)
    else if (arg === "--mcp-command") mcpCommand = boundedText(value(), "mcp-command", 256)
    else if (arg === "--mcp-arg") mcpArgs.push(boundedText(value(), "mcp-arg", 4_096))
    else if (arg === "--mcp-load-resources") mcpLoadResources = true
    else if (arg === "--no-session") noSession = true
    else if (arg === "--pi-command") piCommand = value()
    else if (arg === "--pi-arg") piArgs.push(value())
    else if (arg === "--pi-rpc-arg") piRpcArgs.push(value())
    else if (arg === "--pi-system-prompt") piSystemPrompt = value()
    else if (arg === "--no-pi-nifra-tools") piNifraTools = false
    else if (arg === "--pi-env") {
      const pair = value()
      const separator = pair.indexOf("=")
      if (separator <= 0) throw new Error("pi-env must be NAME=VALUE")
      const name = pair.slice(0, separator)
      const envValue = pair.slice(separator + 1)
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || envValue.length > 4_096) throw new Error("pi-env is invalid")
      piEnvironment[name] = envValue
    } else if (arg === "--pi-max-event-queue") piMaxEventQueueSize = parseBoundedInteger(value(), "pi-max-event-queue", 1, 4_096)
    else if (arg === "--pi-reload-command") {
      const next = value()
      if (next !== "restart" && next !== "prompt" && next !== "rpc") throw new Error("invalid Pi reload command")
      piReloadCommand = next
    } else if (arg === "--host") host = value()
    else if (arg === "--port") port = parseBoundedInteger(value(), "port", 0, 65_535)
    else if (arg === "--token") throw new Error("--token is not accepted: other local users can read arguments; use RUNRAIL_CONTROL_TOKEN or --token-file")
    else if (arg === "--token-file") authToken = readTokenFile(value())
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`)
    else task.push(arg)
  }
if (cwd === undefined) throw new Error("--cwd is required")
// argv is readable by every local user through ps, so the desktop hands the token over in the environment.
if (authToken === undefined && (command === "control" || command === "serve") && env.RUNRAIL_CONTROL_TOKEN !== undefined) authToken = env.RUNRAIL_CONTROL_TOKEN
if (transcriptDir !== undefined && command !== "control") throw new Error("--transcript-dir requires the control command")
if ((continueFromDir === undefined) !== (continueFromSession === undefined)) throw new Error("--continue-from-dir and --continue-from-session go together")
if (continueFromDir !== undefined && (transcriptDir === undefined || sessionId === undefined)) throw new Error("--continue-from-dir requires --transcript-dir and --session-id")
if (continueFromSession !== undefined && continueFromSession === sessionId) throw new Error("a session cannot continue itself")
if (worktreeRoot !== undefined && command !== "control") throw new Error("--worktree-root requires the control command")
if (threadsDir !== undefined && command !== "control") throw new Error("--threads-dir requires the control command")
if (accountsDir !== undefined && command !== "control" && connectionId === undefined && toolConnectionId === undefined) throw new Error("--accounts-dir requires the control command, --connection, or --tool-connection")
if (credentialVault !== undefined && command !== "control" && connectionId === undefined && toolConnectionId === undefined) throw new Error("--credential-vault requires the control command, --connection, or --tool-connection")
if (terminal && command !== "control") throw new Error("--terminal requires the control command")
if (terminalShell !== undefined && !terminal) throw new Error("--terminal-shell requires --terminal")
if (exitOnStdinClose && command !== "control") throw new Error("--exit-on-stdin-close requires the control command")
if (browserTools && command !== "control") throw new Error("--browser-tools requires the control command")
if (browserAnySite && !browserTools) throw new Error("--browser-any-site requires --browser-tools")
if (threadTools && command !== "control") throw new Error("--thread-tools requires the control command")
if (computerTools && command !== "control") throw new Error("--computer-tools requires the control command")
if (imageTools && command !== "control") throw new Error("--image-tools requires the control command")
if (folders.length > 0 && command !== "control") throw new Error("--add-dir requires the control command")
if (verifyAfterTurn && command !== "control" && command !== "console" && command !== "serve") throw new Error("--verify-after-turn requires the control, console, or serve command")
if (checkpoints && command !== "control") throw new Error("--checkpoints requires the control command")
  if (mcpCommand === undefined && (mcpArgs.length > 0 || mcpLoadResources)) throw new Error("--mcp-command is required when MCP options are used")
  if (mcpCommand !== undefined && command !== "run") throw new Error("MCP command attachment requires a run")
  const selectedProviderModel = providerModel ?? modelId
  if (providerName !== undefined && selectedProviderModel === undefined) throw new Error("--provider-model is required with --provider")
  if (providerName !== undefined && modelId !== undefined && providerModel !== undefined && modelId !== providerModel) throw new Error("--model and --provider-model must match")
  if (providerName !== undefined && backend !== "native") throw new Error("provider configuration requires the native backend")
  if (connectionId !== undefined) {
    // A connection carries its own address, protocol and key; none of them can be overridden here.
    if (providerName !== undefined || providerCredentialEnvironment !== undefined || providerEndpoint !== undefined || providerAllowRemote || providerAllowInsecureRemote || providerProtocol !== undefined) throw new Error("--connection cannot be combined with --provider options")
    if (selectedProviderModel === undefined) throw new Error("--model is required with --connection")
    if (modelId !== undefined && providerModel !== undefined && modelId !== providerModel) throw new Error("--model and --provider-model must match")
    if (backend !== "native") throw new Error("--connection requires the native backend")
  }
  if (toolConnectionId !== undefined && (backend === "native" || backend === "replay")) throw new Error("--tool-connection requires a coding-tool backend")
  if (toolConnectionId !== undefined && connectionId !== undefined) throw new Error("--tool-connection cannot be combined with --connection")
  if (piExtensionPaths.length > 0 && backend !== "native") throw new Error("Pi extensions require the native backend")
  if (maxReplyChars !== undefined && backend !== "native") throw new Error("--max-reply-chars requires the native backend")
  if (harnessAuthMode === "caller") throw new Error("caller harness authentication is available through the library API")
  if (harnessAuthMode === undefined && harnessCredentialEnvironment.length > 0) throw new Error("--harness-auth environment is required with --harness-credential-env")
  if (harnessAuthMode === "subscription" && harnessCredentialEnvironment.length > 0) throw new Error("subscription harness authentication cannot include --harness-credential-env")
  if (harnessAuthMode === "environment" && harnessCredentialEnvironment.length === 0) throw new Error("--harness-credential-env is required with --harness-auth environment")
  if (harnessPersistent && backend !== "codex" && backend !== "claude-code") throw new Error("--harness-persistent requires the Codex or Claude Code backend")
  if (harnessProtocol === "app-server" && backend !== "codex") throw new Error("--harness-protocol app-server requires the Codex backend")
  const acpRoute = isAcpRouteBackend(backend)
  if (harnessProtocol !== undefined && acpRoute) throw new Error(`--harness-protocol does not apply to the ${({ copilot: "Copilot", opencode: "OpenCode", gemini: "Gemini CLI", goose: "Goose" } as Record<string, string>)[backend]} backend`)
  if ((harnessProtocol === "sdk" || harnessProtocol === "print") && backend !== "claude-code") throw new Error(`--harness-protocol ${harnessProtocol} requires the Claude Code backend`)
  if (harnessProtocol === "sdk" && (harnessPersistent || harnessArgs.length > 0)) throw new Error("--harness-protocol sdk cannot be combined with --harness-persistent or --harness-arg")
  const harnessLaunchRequested = harnessEffort !== undefined || harnessPermissionMode !== undefined || harnessAppendSystemPrompt !== undefined || harnessMcpConfig.length > 0 || harnessResume !== undefined
  if (harnessLaunchRequested && backend !== "codex" && backend !== "claude-code" && !acpRoute) throw new Error("harness launch options require a Codex, Claude Code, or Agent Client Protocol backend")
  // A caller who shapes the command line by hand owns every argument on it.
  if (harnessLaunchRequested && (harnessPersistent || (harnessCommand !== undefined && harnessProtocol !== "app-server" && harnessProtocol !== "sdk" && !acpRoute))) throw new Error("harness launch options cannot be combined with --harness-command or --harness-persistent")
  if (harnessMcpConfig.length > 0 && backend !== "claude-code") throw new Error("--harness-mcp-config requires the Claude Code backend")
  const harnessLaunch: HarnessLaunchOptions | undefined = harnessLaunchRequested
    ? parseHarnessLaunchOptions({
      ...(harnessEffort === undefined ? {} : { effort: harnessEffort }),
      ...(harnessPermissionMode === undefined ? {} : { permissionMode: harnessPermissionMode }),
      ...(harnessAppendSystemPrompt === undefined ? {} : { appendSystemPrompt: harnessAppendSystemPrompt }),
      ...(harnessMcpConfig.length === 0 ? {} : { mcpConfig: harnessMcpConfig }),
      ...(harnessResume === undefined ? {} : { resume: harnessResume }),
    })
    : undefined
  const harnessAuth: HarnessAuthOptions | undefined = harnessAuthMode === undefined
    ? undefined
    : Object.freeze({ mode: harnessAuthMode, ...(harnessCredentialEnvironment.length === 0 ? {} : { credentialEnvironment: Object.freeze([...harnessCredentialEnvironment]) }) })
  const provider: ProviderModelOptions | undefined = providerName === undefined || selectedProviderModel === undefined
    ? undefined
    : {
        provider: providerName,
        model: selectedProviderModel,
        credential: { kind: "environment", environment: providerCredentialEnvironment ?? defaultCredentialEnvironment(providerName) },
        ...(providerEndpoint === undefined ? {} : { endpoint: providerEndpoint }),
        ...(providerAllowRemote ? { allowRemote: true } : {}),
        ...(providerAllowInsecureRemote ? { allowInsecureRemote: true } : {}),
        ...(providerProtocol === undefined ? {} : { protocol: providerProtocol }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(providerTimeoutMs === undefined ? {} : { timeoutMs: providerTimeoutMs }),
        ...(providerMaxRetries === undefined ? {} : { maxRetries: providerMaxRetries }),
      }
  return {
    command,
    cwd: resolve(cwd),
    backend,
    ...(provider === undefined ? {} : { provider }),
    ...(requiredCapabilities.length === 0 ? {} : { requiredCapabilities: Object.freeze([...new Set(requiredCapabilities)].sort()) }),
    maxSteps,
    maxRepairAttempts,
    verify,
    ...(verificationCommand === undefined ? {} : { verificationCommand }),
    ...(verificationTimeoutMs === undefined ? {} : { verificationTimeoutMs }),
    json,
    task: task.join(" ") || "Complete the bounded coding task.",
    piArgs: Object.freeze([...piArgs]),
    ...(piCommand === undefined ? {} : { piCommand }),
    piOptions: Object.freeze({
      ...(piArgs.length === 0 ? {} : { args: Object.freeze([...piArgs]) }),
      ...(piRpcArgs.length === 0 ? {} : { rpcArgs: Object.freeze([...piRpcArgs]) }),
      ...(noSession ? { noSession: true } : {}),
      ...(sessionDir === undefined ? {} : { sessionDir }),
      ...(piReloadCommand === undefined ? {} : { reloadCommand: piReloadCommand }),
      ...(piSystemPrompt === undefined ? {} : { appendSystemPrompt: piSystemPrompt }),
      ...(Object.keys(piEnvironment).length === 0 ? {} : { env: Object.freeze({ ...piEnvironment }) }),
      ...(piMaxEventQueueSize === undefined ? {} : { maxEventQueueSize: piMaxEventQueueSize }),
      ...(piNifraTools === undefined ? {} : { enableNifraTools: piNifraTools }),
    }),
    ...(sessionDir === undefined ? {} : { sessionDir }),
    ...(transcriptDir === undefined ? {} : { transcriptDir }),
    ...(continueFromDir === undefined || continueFromSession === undefined ? {} : { continueFrom: Object.freeze({ transcriptDir: continueFromDir, sessionId: continueFromSession }) }),
    ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
    ...(threadsDir === undefined ? {} : { threadsDir }),
    ...(accountsDir === undefined ? {} : { accountsDir }),
    ...(credentialVault === undefined ? {} : { credentialVault }),
    ...(connectionId === undefined || selectedProviderModel === undefined ? {} : { connection: Object.freeze({ id: connectionId, model: selectedProviderModel, ...(thinking === undefined ? {} : { thinking }) }) }),
    ...(toolConnectionId === undefined ? {} : { toolConnection: toolConnectionId }),
    ...(terminal ? { terminal: true } : {}),
    ...(terminalShell === undefined ? {} : { terminalShell }),
    ...(exitOnStdinClose ? { exitOnStdinClose: true } : {}),
    ...(browserTools ? { browserTools: true, ...(browserAnySite ? { browserAnySite: true } : {}) } : {}),
    ...(threadTools ? { threadTools: true } : {}),
    ...(computerTools ? { computerTools: true } : {}),
    ...(imageTools ? { imageTools: true } : {}),
    ...(folders.length === 0 ? {} : { folders: Object.freeze([...folders]) }),
    ...(verifyAfterTurn ? { verifyAfterTurn: true } : {}),
    ...(checkpoints ? { checkpoints: true } : {}),
    ...(harnessCommand === undefined ? {} : { harnessCommand, harnessArgs: Object.freeze([...harnessArgs]) }),
    ...(harnessAuth === undefined ? {} : { harnessAuth }),
    ...(harnessPersistent ? { harnessPersistent: true } : {}),
    ...(harnessProtocol === undefined ? {} : { harnessProtocol }),
    ...(harnessLaunch === undefined ? {} : { harnessLaunch }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(behaviorConfigPath === undefined ? {} : { behaviorConfigPath }),
    ...(userSkills === undefined ? {} : { userSkills }),
    ...(nifra === undefined ? {} : { nifra }),
    ...(modelCommand === undefined ? {} : { modelCommand: { command: modelCommand, args: Object.freeze([...modelCommandArgs]), ...(modelCapabilities.length === 0 ? {} : { capabilities: Object.freeze([...new Set(modelCapabilities)]) }) } }),
    ...(selectedProviderModel === undefined && quality === undefined && thinking === undefined && requiredModelCapabilities.length === 0
      ? {}
      : { modelSelection: { ...(selectedProviderModel === undefined ? {} : { id: selectedProviderModel }), ...(quality === undefined ? {} : { quality }), ...(thinking === undefined ? {} : { thinking }), ...(requiredModelCapabilities.length === 0 ? {} : { requiredCapabilities: Object.freeze([...new Set(requiredModelCapabilities)]) }) } }),
    ...(maxInputTokens === undefined && maxOutputTokens === undefined && maxTotalTokens === undefined && maxCostUsd === undefined && maxToolCalls === undefined && maxDurationMs === undefined
      ? {}
      : { budget: { ...(maxInputTokens === undefined ? {} : { maxInputTokens }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }), ...(maxCostUsd === undefined ? {} : { maxCostUsd }), ...(maxToolCalls === undefined ? {} : { maxToolCalls }), ...(maxDurationMs === undefined ? {} : { maxDurationMs }) } }),
    ...(noContext || contextFiles.length > 0 || skillPaths.length > 0 || themePaths.length > 0 || systemPrompt !== undefined
      ? { context: {
        ...(noContext ? { instructionFiles: Object.freeze([]) } : contextFiles.length === 0 ? {} : { instructionFiles: Object.freeze([...contextFiles]) }),
        ...(skillPaths.length === 0 ? {} : { skillPaths: Object.freeze([...skillPaths]) }),
        ...(themePaths.length === 0 ? {} : { themePaths: Object.freeze([...themePaths]) }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
      } }
      : {}),
    ...(noDefaultPrompt ? { defaultSystemPrompt: false } : {}),
    ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
    ...(maxReplyChars === undefined ? {} : { maxReplyChars }),
    ...(piExtensionPaths.length === 0 ? {} : { piExtensionPaths: Object.freeze([...piExtensionPaths]) }),
    ...(piExtensionCapabilities.length === 0 ? {} : { piExtensionCapabilities: Object.freeze([...new Set(piExtensionCapabilities)].sort()) }),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(authToken === undefined ? {} : { authToken }),
    ...(mcpCommand === undefined ? {} : { mcpCommand, mcpArgs: Object.freeze([...mcpArgs]), mcpLoadResources }),
  }
}

export interface PiPassthroughOptions {
  readonly command?: string
  readonly cwd?: string
}

/** Execute Pi unchanged for users who want Pi's complete native UX and ecosystem. */
export async function runPiPassthrough(
  args: readonly string[],
  options: PiPassthroughOptions = {},
): Promise<number> {
  const command = options.command ?? process.env.RUNRAIL_PI_COMMAND ?? "pi"
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd ?? process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

export async function runRunrail(options: RunrailRunOptions): Promise<RunrailRunResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const maxRepairAttempts = options.maxRepairAttempts ?? 2
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 512) throw new RangeError("maxSteps must be between 1 and 512")
  if (!Number.isSafeInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 8)
    throw new RangeError("maxRepairAttempts must be between 0 and 8")
  const verify = options.verify ?? "check"
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 120_000
  if (!Number.isSafeInteger(verificationTimeoutMs) || verificationTimeoutMs < 1 || verificationTimeoutMs > 120_000)
    throw new RangeError("verificationTimeoutMs must be between 1 and 120000")
  const session = await createRunrailSession({
    cwd: options.cwd,
    backend: options.backend,
    requiredCapabilities: options.requiredCapabilities,
    maxSteps,
    maxRepairAttempts,
    verify,
    verificationCommand: options.verificationCommand,
    verificationTimeoutMs,
        sessionDir: options.sessionDir,
        sessionId: options.sessionId,
        ...(options.behaviorConfigPath === undefined ? {} : { behaviorConfigPath: options.behaviorConfigPath }),
        ...(options.userSkills === undefined ? {} : { userSkills: options.userSkills }),
        ...(options.nifra === undefined ? {} : { nifra: options.nifra }),
        provider: options.provider,
    harnessCommand: options.harnessCommand,
    harnessArgs: options.harnessArgs,
          harnessAuth: options.harnessAuth,
          ...(options.harnessAccount === undefined ? {} : { harnessAccount: options.harnessAccount }),
          harnessPersistent: options.harnessPersistent,
          harnessProtocol: options.harnessProtocol,
          harnessLaunch: options.harnessLaunch,
    pi: options.pi,
    approval: options.approval,
    model: options.model,
    fallbackModel: options.fallbackModel,
    modelCommand: options.modelCommand,
    modelCatalog: options.modelCatalog,
    modelSelection: options.modelSelection,
    budget: options.budget,
    onUsage: options.onUsage,
    context: options.context,
    ...(options.defaultSystemPrompt === false ? { defaultSystemPrompt: false } : {}), ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }), ...(options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars }),
    metrics: options.metrics,
    cache: options.cache,
    mcpClients: options.mcpClients,
    mcpLoadResources: options.mcpLoadResources,
    piExtensions: options.piExtensions,
    ...(options.transcriptStore === undefined ? {} : { transcriptStore: options.transcriptStore }),
    ...(options.sessionBehaviorFile === false ? { sessionBehaviorFile: false } : {}),
  })
  const snapshot = session.snapshot
  const nifra = nifraNotice(session.nifraUse())
  if (nifra !== undefined) options.onNotice?.(nifra)
  const events: RunrailEvent[] = []
  let seq = 0
  const add = (event: Omit<RunrailEvent, "seq">): void => {
    // The CLI owns the run-level start marker while a backend may also emit
    // its session lifecycle marker. Keep the public summary deterministic and
    // avoid presenting one logical start twice.
    if (event.type === "session.started" && events.some((entry) => entry.type === "session.started")) return
    if (event.type === "session.failed" && events.some((entry) => entry.type === "session.failed" && entry.code === event.code)) return
    if (event.type === "session.stopped" && events.some((entry) => entry.type === "session.stopped" && entry.reason === event.reason)) return
    events.push(Object.freeze({ seq: seq++, ...event }))
  }
  add({ type: "session.started" })
  let lastVerification: RunrailRunResult["verification"]
  let status: RunrailTerminalStatus = "unrecoverable"
  let repeatedFailure = false
  let denied = false
  let streamError: AgentError | undefined
  let lastFailureFingerprint: string | undefined
  let observedRepairEvents = 0
  let timedOut = false
  try {
    for await (const event of session.prompt(options.task ?? "Complete the bounded coding task.", options.signal)) {
      options.onEvent?.(event)
      projectEvent(event, add)
      if (event.type === "repair.required") observedRepairEvents += 1
      if (event.type === "session.failed") {
        streamError = event.error
        break
      }
      if (event.type === "tool.completed" && event.error?.code === "APPROVAL_DENIED") {
        denied = true
        break
      }
      // A one-shot run has no one to answer a coding tool's approval; native already declines at once.
      if (event.type === "approval.required" && options.backend !== "native") {
        if (session.backend.resolveApproval === undefined) {
          denied = true
          break
        }
        await session.resolveApproval(event.approvalId, false, UNANSWERED_APPROVAL)
      }
      if (event.type !== "verification.completed") continue
      lastVerification = verificationView(event)
      if (event.ok) continue
      if (verificationTimedOut(event.report)) {
        timedOut = true
        break
      }
      const fingerprint = failureFingerprint(event)
      if (lastFailureFingerprint === fingerprint) {
        repeatedFailure = true
        break
      }
      lastFailureFingerprint = fingerprint
    }
  } catch (error) {
    streamError = asAgentError(error)
  }
  if (repeatedFailure) {
    status = "exhausted"
    add({ type: "repair.required", reason: "repeated_failure" })
    add({ type: "session.failed", code: "REPAIR_EXHAUSTED" })
  } else if (denied) {
    status = "denied"
    add({ type: "session.failed", code: "APPROVAL_DENIED" })
  } else if (streamError !== undefined) {
    status = terminalForError(streamError)
    if (status === "cancelled") add({ type: "session.stopped", reason: "cancelled" })
    else add({ type: terminalEvent(status), code: streamError.code })
  } else if (options.signal?.aborted) {
    status = "cancelled"
    add({ type: "session.stopped", reason: "cancelled" })
  } else if (timedOut) {
    status = "timed_out"
    add({ type: "session.failed", code: "VERIFICATION_TIMEOUT" })
  } else if (options.backend === "replay") {
    status = "succeeded"
  } else if (lastVerification?.ok === true) {
    status = "succeeded"
  } else if (lastVerification?.ok === false) {
    status = "exhausted"
    add({ type: "session.failed", code: "REPAIR_EXHAUSTED" })
  } else if (lastVerification === undefined && events.some((event) => event.type === "session.completed") && !verificationGateAvailable({ command: options.verificationCommand, cwd: options.cwd, ...(options.nifra === undefined ? {} : { nifra: options.nifra }) })) {
    // No check applies here: the task finished, and the result carries no verification.
    status = "succeeded"
  }
  const repairAttempts = Math.min(
    maxRepairAttempts,
    observedRepairEvents,
  )
  session.metrics?.recordRun(status === "succeeded", repairAttempts)
  await session.saveMetrics()
  await session.stop(status)
  return {
    backend: options.backend,
    cwd: session.policy.root,
    sessionId: snapshot.id,
    status,
    ...(lastVerification === undefined ? {} : { verification: lastVerification }),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.usage === undefined ? {} : { usage: session.usage.snapshot() }),
    repairAttempts,
    events: Object.freeze(events),
    digest: digestEvents(events),
  }
}

async function createCliPiExtensionHost(options: CliOptions): Promise<PiExtensionHost | undefined> {
  const paths = options.piExtensionPaths ?? []
  if (paths.length === 0) return undefined
  const host = createPiExtensionHost({
    cwd: options.cwd,
    trustedCapabilities: options.piExtensionCapabilities ?? [],
  })
  try {
    for (const path of paths) await host.activate(path, { approvalGranted: true })
    return host
  } catch (error) {
    try {
      await host.close()
    } catch {
      // Preserve the activation error; cleanup is best effort after a failed staged load.
    }
    throw error
  }
}

function projectEvent(event: AgentEvent, add: (event: Omit<RunrailEvent, "seq">) => void): void {
  switch (event.type) {
    case "tool.started":
      add({ type: event.type, tool: event.name })
      break
    case "tool.completed":
      add({ type: event.type, tool: event.name, ok: event.ok, ...(event.error === undefined ? {} : { code: event.error.code }) })
      break
    case "session.failed":
      add({ type: event.type, code: event.error.code })
      break
    case "assistant.message":
      add({ type: event.type, ok: event.text.length > 0 })
      break
    case "assistant.delta":
      add({ type: event.type, ok: event.text.length > 0 })
      break
    case "verification.completed":
      add({ type: event.type, ok: event.ok, status: verificationStatus(event.report) })
      break
    case "repair.required":
      add({ type: event.type })
      break
    case "session.stopped":
      add({ type: event.type, reason: event.reason })
      break
    default:
      add({ type: event.type })
  }
}

function verificationView(
  event: Extract<AgentEvent, { readonly type: "verification.completed" }>,
): RunrailRunResult["verification"] {
  return {
    name: asVerificationName(event.name),
    ok: event.ok,
    status: verificationStatus(event.report),
  }
}

function verificationStatus(report: unknown): number | null {
  if (!isRecord(report)) return null
  return report.status === null || typeof report.status === "number" ? report.status : null
}

function verificationTimedOut(report: unknown): boolean {
  return isRecord(report) && typeof report.error === "string" && report.error.includes("timed out")
}

function failureFingerprint(
  event: Extract<AgentEvent, { readonly type: "verification.completed" }>,
): string {
  const report = isRecord(event.report) ? event.report : {}
  return verificationFingerprint({
    name: asVerificationName(event.name),
    ok: event.ok,
    status: verificationStatus(report),
    ...(typeof report.error === "string" ? { error: report.error } : {}),
    ...(Object.hasOwn(report, "report") ? { report: report.report } : {}),
  })
}

function asVerificationName(value: string): VerificationName {
  if (value === "check" || value === "assure" || value === "test") return value
  throw new Error(`unknown verification gate: ${value}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function digestEvents(events: readonly RunrailEvent[]): string {
  const normalized = events.map(({ seq: _seq, ...event }) => event)
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

const UNANSWERED_APPROVAL = "runrail run cannot answer approvals; choose what the tool may do with --harness-permission-mode"

function terminalForError(error: AgentError): RunrailTerminalStatus {
  if (error.code.includes("CANCEL")) return "cancelled"
  if (error.code.includes("TIMEOUT")) return "timed_out"
  if (error.code.includes("APPROVAL") || error.code.includes("DENIED")) return "denied"
  return "unrecoverable"
}

function terminalEvent(status: RunrailTerminalStatus): string {
  return status === "cancelled" ? "session.stopped" : "session.failed"
}

function asAgentError(error: unknown): AgentError {
  return {
    code: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "RUNRAIL_RUN_FAILED",
    message: error instanceof Error ? error.message : String(error),
  }
}

function parseModelListCliArgs(argv: readonly string[]): CliOptions {
  let json = false
  let discover = false
  let provider: ProviderDiscoveryOptions["provider"] | undefined
  let credentialEnvironment: string | undefined
  let endpoint: string | undefined
  let allowRemote = false
  let allowInsecureRemote = false
  let protocol: ProviderDiscoveryOptions["protocol"] | undefined
  let timeoutMs: number | undefined
  let maxRetries: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === "--json") json = true
    else if (arg === "--discover") discover = true
    else if (arg === "--provider") provider = parseCliProvider(value())
    else if (arg === "--provider-credential-env") {
      const next = value()
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(next)) throw new Error("provider credential environment is invalid")
      credentialEnvironment = next
    } else if (arg === "--provider-endpoint") endpoint = boundedText(value(), "provider-endpoint", 2_048)
    else if (arg === "--provider-allow-remote") allowRemote = true
    else if (arg === "--provider-allow-insecure-remote") allowInsecureRemote = true
    else if (arg === "--provider-protocol") {
      const next = value()
      if (next !== "responses" && next !== "chat") throw new Error("invalid provider protocol")
      protocol = next
    } else if (arg === "--provider-timeout-ms") timeoutMs = parseBoundedInteger(value(), "provider-timeout-ms", 1, 120_000)
    else if (arg === "--provider-max-retries") maxRetries = parseBoundedInteger(value(), "provider-max-retries", 0, 5)
    else throw new Error(`models received an unknown option: ${arg}`)
  }
  if (!discover) {
    if (provider !== undefined || credentialEnvironment !== undefined || endpoint !== undefined || allowRemote || allowInsecureRemote || protocol !== undefined || timeoutMs !== undefined || maxRetries !== undefined) throw new Error("provider model options require --discover")
    return { command: "models", cwd: resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json, task: "", piArgs: Object.freeze([]) }
  }
  if (provider === undefined) throw new Error("--provider is required with --discover")
  const providerDiscovery: ProviderDiscoveryOptions = Object.freeze({ provider, credential: Object.freeze({ kind: "environment", environment: credentialEnvironment ?? defaultCredentialEnvironment(provider) }), ...(endpoint === undefined ? {} : { endpoint }), ...(allowRemote ? { allowRemote: true } : {}), ...(allowInsecureRemote ? { allowInsecureRemote: true } : {}), ...(protocol === undefined ? {} : { protocol }), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(maxRetries === undefined ? {} : { maxRetries }) })
  return { command: "models", cwd: resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json, task: "", piArgs: Object.freeze([]), providerDiscovery }
}

function parseSignInCliArgs(command: "login" | "logout", argv: readonly string[]): CliOptions {
  let accountsDir: string | undefined
  let credentialVault: CliCredentialVault | undefined
  let json = false
  let list = false
  let acceptUnofficial = false
  let openBrowser = true
  let label: string | undefined
  let connectionId: string | undefined
  let target: string | undefined
  const connection = (value: string): string => {
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error("connection id is invalid")
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === "--json") json = true
    else if (arg === "--accounts-dir") accountsDir = resolve(boundedText(value(), "accounts-dir", 4_096))
    else if (arg === "--credential-vault") credentialVault = parseCredentialVault(value())
    else if (command === "login" && arg === "--list") list = true
    else if (command === "login" && arg === "--accept-unofficial") acceptUnofficial = true
    else if (command === "login" && arg === "--no-browser") openBrowser = false
    else if (command === "login" && arg === "--label") label = boundedText(value(), "label", 160)
    else if (command === "login" && arg === "--connection") connectionId = connection(value())
    else if (arg.startsWith("-") || target !== undefined) throw new Error(SIGN_IN_CLI_USAGE)
    else target = arg
  }
  let signIn: SignInCliOptions
  if (command === "logout") {
    if (target === undefined) throw new Error(SIGN_IN_CLI_USAGE)
    signIn = { action: "logout", connectionId: connection(target), json }
  } else if (list) {
    if (target !== undefined || acceptUnofficial || label !== undefined || connectionId !== undefined) throw new Error(SIGN_IN_CLI_USAGE)
    signIn = { action: "list", json }
  } else {
    if (target === undefined || !/^[a-z][a-z0-9._:-]{0,63}$/.test(target)) throw new Error(SIGN_IN_CLI_USAGE)
    if (label !== undefined && /[\r\n\0]/.test(label)) throw new Error("label is invalid")
    signIn = { action: "login", target, ...(connectionId === undefined ? {} : { connectionId }), ...(label === undefined ? {} : { label }), acceptUnofficial, json }
  }
  return {
    command,
    cwd: resolve("."),
    backend: "native",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json,
    task: "",
    piArgs: Object.freeze([]),
    ...(accountsDir === undefined ? {} : { accountsDir }),
    ...(credentialVault === undefined ? {} : { credentialVault }),
    signIn: Object.freeze(signIn),
    openBrowser,
  }
}

function parseAuthCliArgs(argv: readonly string[]): CliOptions {
  if (argv[0] !== "doctor") throw new Error(AUTH_DOCTOR_USAGE)
  let accountsDir: string | undefined
  let credentialVault: CliCredentialVault | undefined
  let json = false
  let connectionId: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === "--json") json = true
    else if (arg === "--accounts-dir") accountsDir = resolve(boundedText(value(), "accounts-dir", 4_096))
    else if (arg === "--credential-vault") credentialVault = parseCredentialVault(value())
    else if (arg.startsWith("-") || connectionId !== undefined) throw new Error(AUTH_DOCTOR_USAGE)
    else connectionId = arg
  }
  if (connectionId === undefined) throw new Error(AUTH_DOCTOR_USAGE)
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(connectionId)) throw new Error("connection id is invalid")
  return {
    command: "auth",
    cwd: resolve("."),
    backend: "native",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json,
    task: "",
    piArgs: Object.freeze([]),
    ...(accountsDir === undefined ? {} : { accountsDir }),
    ...(credentialVault === undefined ? {} : { credentialVault }),
    doctor: Object.freeze({ connectionId, json }),
  }
}

/** `browser-mcp`, `connectors-mcp`, `threads-mcp`, `computer-mcp` or `images-mcp --endpoint-file <path>`: started by Claude Code, never by a person. */
function parseBrowserMcpCliArgs(argv: readonly string[], command: "browser-mcp" | "connectors-mcp" | "threads-mcp" | "computer-mcp" | "images-mcp" = "browser-mcp"): CliOptions {
  if (argv.length !== 2 || argv[0] !== "--endpoint-file") throw new Error(`${command} accepts only --endpoint-file <path>`)
  return {
    command,
    cwd: resolve("."),
    backend: "native",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json: false,
    task: "",
    piArgs: Object.freeze([]),
    browserEndpointFile: resolve(boundedText(argv[1] as string, "endpoint-file", 4_096)),
  }
}

function parseServiceCliArgs(argv: readonly string[]): CliOptions {
  if (argv.length !== 2 || argv[0] !== "--app") throw new Error("service accepts only --app <path to the app: the .app bundle on macOS, the program on Linux>")
  return {
    command: "service",
    cwd: resolve("."),
    backend: "native",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json: false,
    task: "",
    piArgs: Object.freeze([]),
    serviceApp: boundedText(argv[1] as string, "app", 1_024),
  }
}

const SESSIONS_USAGE = "usage: runrail sessions [--cwd <path>] [--limit <n>] [--json]"
const EXPORT_USAGE = "usage: runrail export <session id> [--format json|markdown] [--out <file>]"
const DOCTOR_USAGE = "usage: runrail doctor [--cwd <path>] [--json]"

function parseSessionsCliArgs(argv: readonly string[]): CliOptions {
  let cwd: string | undefined
  let limit = 20
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--json") json = true
    else if (arg === "--cwd" && next !== undefined) {
      cwd = resolve(boundedText(next, "cwd", 4_096))
      index += 1
    } else if (arg === "--limit" && next !== undefined) {
      limit = parseBoundedInteger(next, "limit", 1, 1_000)
      index += 1
    } else throw new Error(SESSIONS_USAGE)
  }
  return { command: "sessions", cwd: cwd ?? resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json, task: "", piArgs: Object.freeze([]), sessionList: Object.freeze({ ...(cwd === undefined ? {} : { cwd }), limit }) }
}

function parseExportCliArgs(argv: readonly string[]): CliOptions {
  let ref: string | undefined
  let format: "json" | "markdown" = "json"
  let out: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const next = argv[index + 1]
    if (arg === "--format" && (next === "json" || next === "markdown")) {
      format = next
      index += 1
    } else if (arg === "--out" && next !== undefined) {
      out = resolve(boundedText(next, "out", 4_096))
      index += 1
    } else if (!arg.startsWith("--") && ref === undefined) ref = boundedText(arg, "session id", 64)
    else throw new Error(EXPORT_USAGE)
  }
  if (ref === undefined) throw new Error(EXPORT_USAGE)
  return { command: "export", cwd: resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json: false, task: "", piArgs: Object.freeze([]), sessionExport: Object.freeze({ ref, format, ...(out === undefined ? {} : { out }) }) }
}

function parseDoctorCliArgs(argv: readonly string[]): CliOptions {
  let cwd: string | undefined
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--json") json = true
    else if (arg === "--cwd" && next !== undefined) {
      cwd = resolve(boundedText(next, "cwd", 4_096))
      index += 1
    } else throw new Error(DOCTOR_USAGE)
  }
  return { command: "doctor", cwd: cwd ?? resolve("."), backend: "native", maxSteps: DEFAULT_MAX_STEPS, maxRepairAttempts: 2, verify: "check", json, task: "", piArgs: Object.freeze([]), ...(cwd === undefined ? {} : { doctorCwd: cwd }) }
}

async function runSessionsCli(options: CliOptions): Promise<void> {
  const list = options.sessionList ?? { limit: 20 }
  const sessions = await listCliSessions(resolveSessionsRoot(), list)
  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }
  if (sessions.length === 0) {
    console.error(list.cwd === undefined ? "No saved sessions." : `No saved sessions for ${list.cwd}.`)
    return
  }
  const home = homedir()
  for (const session of sessions) {
    const folder = session.cwd.startsWith(`${home}/`) ? `~${session.cwd.slice(home.length)}` : session.cwd
    console.log([shortId(session.id), localMinute(session.updatedAt), routeBackend(session.route), terminalText(folder), terminalText(session.title ?? "")].join("\t"))
  }
}

async function runExportCli(options: CliOptions): Promise<void> {
  const asked = options.sessionExport
  if (asked === undefined) throw new Error(EXPORT_USAGE)
  const text = await exportCliSession(resolveSessionsRoot(), asked.ref, asked.format)
  if (asked.out === undefined) {
    process.stdout.write(text)
    return
  }
  // Never over another file: an export holds the whole conversation, and only this user may read it.
  await writeFile(asked.out, text, { encoding: "utf8", mode: 0o600, flag: "wx" })
  console.error(`Wrote ${asked.out}`)
}

async function runDoctorCli(options: CliOptions): Promise<number> {
  const store = options.credentialVault ?? parseCredentialVault(process.env.RUNRAIL_CREDENTIAL_VAULT ?? (osKeychainReachable() ? "keychain" : "file"))
  const checks = await runDoctor({
    ...(options.doctorCwd === undefined ? {} : { cwd: options.doctorCwd }),
    accountsDir: resolveAccountsRoot(options.accountsDir),
    sessionsDir: resolveSessionsRoot(),
    credentialStore: { detail: storeNote(store), fallback: store === "file" && !osKeychainReachable() },
  })
  if (options.json) console.log(JSON.stringify({ version: RUNRAIL_VERSION, checks }, null, 2))
  else process.stdout.write(doctorText(checks))
  return checks.some((check) => check.level === "fail") ? 1 : 0
}

function localMinute(ms: number): string {
  const at = new Date(ms)
  const two = (value: number): string => String(value).padStart(2, "0")
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/** Where a saved session can be picked up again. `--json` output already carries the id. */
function sessionHint(saved: OpenCliSession | undefined, command: "run" | "console", json: boolean): void {
  if (saved === undefined || json) return
  console.error(`Session ${shortId(saved.id)} saved. Continue it with: runrail ${command} --resume ${shortId(saved.id)}`)
}

function parseMcpCliArgs(argv: readonly string[]): CliOptions {
  let cwd = resolve(".")
  let maxMessageBytes: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--cwd") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--cwd requires a value")
      cwd = resolve(value)
      index += 1
      continue
    }
    if (arg === "--max-message-bytes") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--max-message-bytes requires a value")
      maxMessageBytes = parseBoundedInteger(value, "max-message-bytes", 1, 16 * 1024 * 1024)
      index += 1
      continue
    }
    throw new Error(`mcp accepts only --cwd and --max-message-bytes: ${arg}`)
  }
  return {
    command: "mcp",
    cwd,
    backend: "native",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json: false,
    task: "",
    piArgs: Object.freeze([]),
    ...(maxMessageBytes === undefined ? {} : { mcpMaxMessageBytes: maxMessageBytes }),
  }
}

function parseBenchmarkCliArgs(argv: readonly string[]): CliOptions {
  let json = false
  let repeats = 1
  let concurrency = 1
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--repeats") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--repeats requires a value")
      repeats = parseBoundedInteger(value, "repeats", 1, 32)
      index += 1
      continue
    }
    if (arg === "--concurrency") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--concurrency requires a value")
      concurrency = parseBoundedInteger(value, "concurrency", 1, 32)
      index += 1
      continue
    }
    throw new Error(`benchmark accepts only --json, --repeats, and --concurrency: ${arg}`)
  }
  return {
    command: "benchmark",
    cwd: resolve("."),
    backend: "replay",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json,
    task: "",
    piArgs: Object.freeze([]),
    benchmarkRepeats: repeats,
    benchmarkConcurrency: concurrency,
  }
}

function parsePackageCliArgs(argv: readonly string[]): CliOptions {
  let cwd = resolve(".")
  let json = false
  let replace = false
  let approvalGranted = false
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--cwd") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--cwd requires a value")
      cwd = resolve(value)
      index += 1
      continue
    }
    if (arg === "--replace") {
      replace = true
      continue
    }
    if (arg === "--approval") {
      approvalGranted = true
      continue
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`)
    positional.push(arg)
  }
  const action = parsePackageAction(positional[0])
  const rest = positional.slice(1)
  if ((action === "list" || action === "lock" || action === "verify" || action === "audit" || action === "doctor") && rest.length !== 0) throw new Error(`packages ${action} accepts no arguments`)
  if (action === "search" && rest.length > 1) throw new Error("packages search accepts at most <query>")
  if (action === "install" && rest.length !== 1) throw new Error("packages install requires <path>")
  if (action === "update" && rest.length !== 2) throw new Error("packages update requires <id> <path>")
  if ((action === "remove" || action === "activate" || action === "rollback" || action === "enable" || action === "disable") && rest.length !== 1) throw new Error(`packages ${action} requires <id>`)
  return {
    command: "packages",
    cwd,
    backend: "native",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json,
    task: "",
    piArgs: Object.freeze([]),
    package: Object.freeze({
      action,
      ...(action === "search" && rest[0] === undefined ? {} : action === "search" ? { source: boundedText(rest[0]!, "query", 256) } : {}),
      ...(action === "install" ? { source: boundedText(rest[0]!, "source", 4_096), replace } : {}),
      ...(action === "update" ? { id: boundedText(rest[0]!, "id", 128), source: boundedText(rest[1]!, "source", 4_096) } : {}),
      ...((action === "remove" || action === "activate" || action === "rollback" || action === "enable" || action === "disable") ? { id: boundedText(rest[0]!, "id", 128) } : {}),
      ...(action === "activate" ? { approvalGranted } : {}),
    }),
  }
}

function parsePackageAction(value: string | undefined): PackageCliAction {
  if (value === "search" || value === "install" || value === "update" || value === "remove" || value === "list" || value === "lock" || value === "verify" || value === "audit" || value === "activate" || value === "rollback" || value === "doctor" || value === "enable" || value === "disable") return value
  throw new Error("packages requires search|install|update|remove|list|lock|verify|audit|activate|rollback|doctor|enable|disable")
}

function parsePluginCliArgs(argv: readonly string[]): CliOptions {
  let cwd = resolve(".")
  let json = false
  const positional: string[] = []
  const capabilities: string[] = []
  const permissions: PluginPermission[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--cwd") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--cwd requires a value")
      cwd = resolve(value)
      index += 1
      continue
    }
    if (arg === "--capability") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--capability requires a value")
      capabilities.push(boundedText(value, "capability", 128))
      index += 1
      continue
    }
    if (arg === "--permission") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--permission requires a value")
      permissions.push(parsePluginPermission(value))
      index += 1
      continue
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`)
    positional.push(arg)
  }
  const action = parsePluginAction(positional[0])
  const rest = positional.slice(1)
  if (action === "list" && rest.length !== 0) throw new Error("plugins list accepts no arguments")
  if (action === "install" && rest.length !== 1) throw new Error("plugins install requires <path>")
  if ((action === "inspect-pi" || action === "migrate-pi") && rest.length !== 1) throw new Error(`plugins ${action} requires <path>`)
  if (action === "update" && rest.length !== 2) throw new Error("plugins update requires <id> <path>")
  if (action === "rollback" && rest.length !== 1) throw new Error("plugins rollback requires <id>")
  if ((action === "rollback" || action === "remove" || action === "enable" || action === "disable" || action === "activate" || action === "deactivate" || action === "test") && rest.length !== 1)
    throw new Error(`plugins ${action} requires <id>`)
  if (action === "configure" && rest.length !== 2) throw new Error("plugins configure requires <id> <json>")
  return {
    command: "plugins",
    cwd,
    backend: "native",
    maxSteps: DEFAULT_MAX_STEPS,
    maxRepairAttempts: 2,
    verify: "check",
    json,
    task: "",
    piArgs: Object.freeze([]),
    plugin: Object.freeze({
      action,
      capabilities: Object.freeze([...new Set(capabilities)]),
      permissions: Object.freeze([...new Set(permissions)]),
      ...((action === "install" || action === "inspect-pi" || action === "migrate-pi") ? { source: rest[0] } : {}),
      ...(action === "update" ? { id: rest[0], source: rest[1] } : {}),
      ...((action === "rollback" || action === "remove" || action === "enable" || action === "disable" || action === "activate" || action === "deactivate" || action === "test" || action === "configure") ? { id: rest[0] } : {}),
      ...(action === "configure" ? { config: parsePluginConfig(rest[1]) } : {}),
    }),
  }
}

function parsePluginAction(value: string | undefined): PluginCliAction {
  if (value === "list" || value === "install" || value === "inspect-pi" || value === "migrate-pi" || value === "update" || value === "rollback" || value === "remove" || value === "enable" || value === "disable" || value === "activate" || value === "deactivate" || value === "configure" || value === "test") return value
  throw new Error("plugins requires list|install|inspect-pi|migrate-pi|update|rollback|remove|enable|disable|activate|deactivate|configure|test")
}

function parsePluginPermission(value: string): PluginPermission {
  if (value === "filesystem.read" || value === "filesystem.write" || value === "process.exec" || value === "network.request" || value === "credentials.read") return value
  throw new Error("invalid plugin permission")
}

function parsePluginConfig(value: string | undefined): unknown {
  if (value === undefined || value.length === 0 || value.length > 256 * 1024) throw new Error("plugin configuration is invalid")
  try {
    return JSON.parse(value)
  } catch {
    throw new Error("plugin configuration JSON cannot be parsed")
  }
}


async function runPackageCli(options: CliOptions): Promise<void> {
  const request = options.package
  if (request === undefined) throw new Error("package action is missing")
  if (request.action === "search") {
    const result = { query: request.source ?? "", remote: false, results: Object.freeze([]) }
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else console.log(`search\t${result.query}\toffline\t0`)
    return
  }
  const manager = new NativePackageManager({ workspaceRoot: options.cwd })
  let result: unknown
  if (request.action === "list") result = await manager.list()
  else if (request.action === "install") result = await manager.install(requirePackageValue(request.source, "source"), { replace: request.replace === true })
  else if (request.action === "update") result = await manager.update(requirePackageValue(request.id, "id"), requirePackageValue(request.source, "source"))
  else if (request.action === "remove") {
    await manager.remove(requirePackageValue(request.id, "id"))
    result = { removed: true }
  } else if (request.action === "lock") result = await manager.lock()
  else if (request.action === "verify") result = await manager.verify()
  else if (request.action === "audit") result = await manager.audit()
  else if (request.action === "doctor") result = await manager.doctor()
  else if (request.action === "activate") result = await manager.activate(requirePackageValue(request.id, "id"), { approvalGranted: request.approvalGranted === true, allowTrusted: true, allowIsolated: true })
  else if (request.action === "rollback") result = await manager.rollback(requirePackageValue(request.id, "id"))
  else result = await manager.setEnabled(requirePackageValue(request.id, "id"), request.action === "enable")
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (request.action === "list" && Array.isArray(result)) {
    for (const item of result) if (isRecord(item) && isRecord(item.manifest)) console.log(`${item.manifest.id}\t${item.manifest.version}\t${item.active ? "active" : item.enabled ? "enabled" : "disabled"}`)
    return
  }
  console.log(JSON.stringify(result))
}

function requirePackageValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`package ${name} is required`)
  return value
}

async function runPluginCli(options: CliOptions): Promise<void> {
  const request = options.plugin
  if (request === undefined) throw new Error("plugin action is missing")
  if (request.action === "inspect-pi" || request.action === "migrate-pi") {
    const bundle = await new PiResourceAdapter().discover(requirePluginValue(request.source, "source"))
    const migration = request.action === "migrate-pi" ? createPiMigrationPlan(bundle) : undefined
    if (options.json) {
      console.log(JSON.stringify({ manifest: bundle.manifest, entries: bundle.entries, ...(migration === undefined ? {} : { migration }) }, null, 2))
    } else if (migration === undefined) {
      for (const entry of bundle.entries) console.log(`${entry.kind}\t${entry.path}\t${entry.activation}`)
    } else {
      console.log(`migration\t${migration.packageId}\t${migration.packageVersion}\tnext=${migration.nextAction}`)
      for (const step of migration.steps) console.log(`${step.status}\t${step.action}\t${step.path}`)
    }
    return
  }
  const manager = await createPluginManager({ workspaceRoot: options.cwd, trustDir: join(homedir(), ".runrail", "plugin-trust") })
  let result: unknown
  if (request.action === "list") result = await manager.list()
  else if (request.action === "install") result = await manager.install(requirePluginValue(request.source, "source"))
  else if (request.action === "update") result = await manager.update(requirePluginValue(request.id, "id"), requirePluginValue(request.source, "source"))
  else if (request.action === "rollback") {
    result = await manager.rollback(requirePluginValue(request.id, "id"))
  } else if (request.action === "remove") {
    await manager.remove(requirePluginValue(request.id, "id"))
    result = { removed: true }
  } else if (request.action === "enable" || request.action === "disable") {
    result = await manager.setEnabled(requirePluginValue(request.id, "id"), request.action === "enable")
  } else if (request.action === "activate") {
    result = await manager.activate(requirePluginValue(request.id, "id"), {
      capabilities: request.capabilities,
      permissions: request.permissions,
      allowTrusted: true,
      allowIsolated: true,
    }, true)
  } else if (request.action === "deactivate") {
    result = await manager.deactivate(requirePluginValue(request.id, "id"))
  } else if (request.action === "configure") {
    await manager.configure(requirePluginValue(request.id, "id"), request.config)
    result = { configured: true }
  } else {
    result = await manager.test(requirePluginValue(request.id, "id"), {
      capabilities: request.capabilities,
      permissions: request.permissions,
      allowTrusted: true,
      allowIsolated: true,
    })
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (request.action === "list" && Array.isArray(result)) {
    for (const plugin of result) {
      if (isRecord(plugin) && isRecord(plugin.manifest)) console.log(`${plugin.manifest.id}\t${plugin.manifest.version}\t${plugin.enabled ? "enabled" : "disabled"}`)
    }
    return
  }
  console.log(JSON.stringify(result))
}

function requirePluginValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`plugin ${name} is required`)
  return value
}

type CliCredentialVault = "keychain" | "file" | "memory" | "none"

function parseCredentialVault(value: string): CliCredentialVault {
  if (value !== "keychain" && value !== "file" && value !== "memory" && value !== "none") throw new Error("invalid credential vault")
  return value
}

/**
 * `keychain` is the OS credential store. `file` keeps owner-only files under the accounts directory,
 * for builds whose signature changes on every rebuild and for hosts without a credential service.
 * `memory` forgets on exit. `none` leaves accounts resolving from environment variables only.
 */
function createCliCredentialVault(kind: CliCredentialVault, accountsDir: string): CredentialVault | undefined {
  if (kind === "none") return undefined
  if (kind === "memory") return new MemoryCredentialVault()
  if (kind === "file") return new FileCredentialVault({ root: join(accountsDir, "vault") })
  return new KeychainCredentialVault()
}

function boundedText(value: string, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${name} is invalid`)
  return value
}

function parseModelCapability(value: string): ModelCapability {
  if (value === "streaming" || value === "tools" || value === "multimodal" || value === "reasoning") return value
  throw new Error("invalid model capability")
}

function parseBoundedNumber(value: string, name: string, min: number, max: number): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`${name} must be a number`)
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return parsed
}
function parseBoundedInteger(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return parsed
}
function defaultCredentialEnvironment(provider: ProviderModelOptions["provider"]): string {
  if (provider === "openai-compatible") return "OPENAI_COMPATIBLE_API_KEY"
  const environment = getProviderPreset(provider)?.environment
  if (environment === undefined) throw new Error("--provider-credential-env is required for this provider")
  return environment
}

/** A provider family (`openai`, `anthropic`, ...) or a preset id from the connection table (`openrouter`, `deepseek`, ...). */
function parseCliProvider(value: string): ProviderModelOptions["provider"] {
  if (!isProviderFamilyId(value) && getProviderPreset(value) === undefined && getCustomProviderPreset(value) === undefined) throw new Error("invalid provider")
  return value
}

interface CliAccountStorage {
  readonly accountsDir: string
  readonly vault: CredentialVault | undefined
  /** Which store `vault` is, which `auth doctor` names. */
  readonly store: CliCredentialVault
}

function createCliAccountStorage(options: Pick<CliOptions, "accountsDir" | "credentialVault">): CliAccountStorage {
  const accountsDir = resolveAccountsRoot(options.accountsDir)
  // Where no keychain can answer (Linux without a session bus), keys go to the owner-only file vault.
  const fallback = osKeychainReachable() ? "keychain" : "file"
  const store = options.credentialVault ?? parseCredentialVault(process.env.RUNRAIL_CREDENTIAL_VAULT ?? fallback)
  return { accountsDir, vault: createCliCredentialVault(store, accountsDir), store }
}

function storeNote(store: CliCredentialVault): string {
  if (store === "keychain") return process.platform === "linux" ? "Keys are read from the system keyring (Secret Service)." : "Keys are read from the system keychain."
  if (store === "file") return `Keys are read from Runrail's file vault, which only your user can read.${osKeychainReachable() ? "" : " No session bus answers here, so there is no keyring to use."}`
  if (store === "memory") return "Keys are kept in memory for this run only."
  return "No credential store: keys come only from the environment."
}

/**
 * The sign-ins the `runrail` command line offers: the documented ones, plus the opt-in pack of
 * plan sign-ins a vendor runs for its own tool. A library host gets the second group only by
 * passing it; the command line is where a person chose Runrail and is told which is which.
 */
export function cliSignInFlows(): readonly SignInFlow[] {
  return Object.freeze([...defaultSignInFlows(), ...vendorSignInFlows()])
}

/** Opens a sign-in page. The address is an argument of its own, never part of a shell line. */
function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url]
  try {
    Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref()
  } catch {
    // The page is printed as well; the person opens it by hand.
  }
}

async function runSignInCommand(options: CliOptions, storage: CliAccountStorage): Promise<number> {
  if (options.signIn === undefined) throw new Error(SIGN_IN_CLI_USAGE)
  if (storage.vault === undefined) throw new Error("a credential vault is required; --credential-vault none keeps no key or sign-in")
  // Questions and pasted addresses need a person at both ends of the terminal.
  const terminal = process.stdin.isTTY === true && process.stderr.isTTY === true ? createInterface({ input: process.stdin, output: process.stderr }) : undefined
  const interrupt = new AbortController()
  const onInterrupt = (): void => interrupt.abort()
  process.once("SIGINT", onInterrupt)
  terminal?.on("SIGINT", onInterrupt)
  try {
    return await runSignInCli(options.signIn, {
      flows: cliSignInFlows(),
      accounts: new FileAccountStore({ root: storage.accountsDir }),
      vault: storage.vault,
      accountsDir: storage.accountsDir,
      out: (line) => console.log(line),
      note: (line) => console.error(line),
      ...(terminal === undefined
        ? {}
        : {
            confirm: async (question: string) => /^y(es)?$/i.test((await terminal.question(`${question} [y/N] `).catch(() => "")).trim()),
            readLine: () => terminal.question("").catch(() => undefined),
            ...(options.openBrowser === false ? {} : { openUrl: openInBrowser }),
          }),
      signal: interrupt.signal,
    })
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    terminal?.close()
  }
}

/** `runrail auth doctor`: the same stores and sign-in renewal a run would use, and one request. */
async function runAuthDoctorCommand(options: CliOptions, storage: CliAccountStorage): Promise<number> {
  if (options.doctor === undefined) throw new Error(AUTH_DOCTOR_USAGE)
  if (!options.doctor.json) console.error(storeNote(storage.store))
  const accounts = new FileAccountStore({ root: storage.accountsDir })
  const fallback = new EnvironmentCredentialBroker()
  const broker = storage.vault === undefined ? fallback : new VaultCredentialBroker({ vault: storage.vault, accounts, lockRoot: `${storage.accountsDir}/locks`, fallback, refreshers: credentialRefreshersFor(cliSignInFlows()) })
  return runAuthDoctor(options.doctor, {
    accounts,
    credentialResolver: createAccountCredentialResolver(accounts, broker),
    out: (line) => console.log(line),
    note: (line) => console.error(line),
  })
}

/**
 * Holds a tool backend to the connection it runs as: on, for this tool, with its own folder or key
 * when it has them. Without a model on the command line the connection's first chosen model is used.
 */
async function applyToolConnection(options: CliOptions, storage: CliAccountStorage): Promise<CliOptions> {
  const directory = new ConnectionDirectory(new FileAccountStore({ root: storage.accountsDir }), new FileConnectionSettingsStore({ root: storage.accountsDir }))
  let connection: Awaited<ReturnType<ConnectionDirectory["requireTool"]>>
  let account: HarnessAccountOptions | undefined
  try {
    connection = await directory.requireTool(options.toolConnection!, options.backend)
    account = await toolConnectionAccount(connection, { accountsRoot: storage.accountsDir, ...(storage.vault === undefined ? {} : { vault: storage.vault }) })
  } catch (error) {
    if (error instanceof ConnectionSettingsError) throw new Error(`the tool connection cannot be used (${error.code})`)
    throw error
  }
  if (account?.apiKey !== undefined && options.harnessAuth !== undefined) throw new Error("--harness-auth cannot be combined with a key connection")
  const chosen = options.modelSelection?.id
  if (chosen !== undefined && connection.models !== undefined && !connection.models.includes(chosen)) throw new Error("the model is not one of the connection's models (CONNECTION_MODEL_NOT_CHOSEN)")
  const route = { connectionId: connection.connectionId, ...(connection.models === undefined ? {} : { models: connection.models }) }
  const withAccount = { ...options, ...(account === undefined ? {} : { harnessAccount: account }), toolConnectionRoute: route }
  if (chosen !== undefined || connection.models === undefined) return withAccount
  return { ...withAccount, modelSelection: { ...options.modelSelection, id: connection.models[0]! } }
}

/** Looks a saved connection up and turns it into provider options. The key is read only when a request is made. */
async function resolveCliConnection(connection: NonNullable<CliOptions["connection"]>, storage: CliAccountStorage): Promise<ProviderModelOptions> {
  const accounts = new FileAccountStore({ root: storage.accountsDir })
  const record = await accounts.get(connection.id)
  // The code ends the message: a host that starts this process reads the last code on stderr.
  if (record === undefined || record.status === "revoked") throw new Error("connection was not found (CONNECTION_NOT_FOUND)")
  try {
    await new ConnectionDirectory(accounts, new FileConnectionSettingsStore({ root: storage.accountsDir })).requireProviderModel(connection.id, connection.model)
  } catch (error) {
    if (error instanceof ConnectionSettingsError) throw new Error(`the connection cannot be used (${error.code})`)
    throw error
  }
  const fallback = new EnvironmentCredentialBroker()
  const broker = storage.vault === undefined ? fallback : new VaultCredentialBroker({ vault: storage.vault, accounts, lockRoot: `${storage.accountsDir}/locks`, fallback, refreshers: credentialRefreshersFor(cliSignInFlows()) })
  let resolved: ReturnType<typeof resolveConnection>
  try {
    resolved = resolveConnection(record, createAccountCredentialResolver(accounts, broker))
  } catch (error) {
    if (error instanceof ProviderError && error.code === "PROVIDER_ENDPOINT_DENIED") throw new Error("the connection's address is not allowed (ENDPOINT_DENIED)")
    if (error instanceof ProviderError || error instanceof AccountError) throw new Error("this connection cannot be used as it is stored (CONNECTION_INVALID)")
    throw error
  }
  // The bundled facts give the context window and list price the endpoint's own options lack.
  const facts = modelDescriptorFacts(createModelMetadataSource(), resolved.presetId, connection.model)
  return Object.freeze({ ...resolved.options, model: connection.model, ...(connection.thinking === undefined ? {} : { thinking: connection.thinking }), ...(facts === undefined ? {} : { descriptor: { ...resolved.options.descriptor, ...facts } }) })
}

function createCliEventRenderer(): (event: AgentEvent) => void {
  let streamed = false
  // A reply past one event's text arrives as consecutive messages, printed as one.
  let continuing = false
  return (event) => {
    const continues = continuing
    continuing = false
    if (continues && event.type !== "assistant.message") process.stdout.write("\n")
    if (event.type === "assistant.delta") {
      streamed = true
      process.stdout.write(terminalText(event.text))
    } else if (event.type === "assistant.message") {
      continuing = mayContinue(event.text)
      if (!streamed) process.stdout.write(`${continues ? "" : "assistant> "}${terminalText(event.text)}`)
      if (!continuing) process.stdout.write("\n")
    } else if (event.type === "tool.started") console.log(`[tool ${terminalText(event.name)}]`)
    else if (event.type === "approval.required") console.log(`[approval ${terminalText(event.approvalId)}]`)
    else if (event.type === "approval.resolved" && !event.approved) console.log(`[approval ${terminalText(event.approvalId)} declined${event.reason === undefined ? "" : `: ${terminalText(event.reason)}`}]`)
    else if (event.type === "verification.completed") console.log(`[verification ${terminalText(event.name)}: ${event.ok ? "passed" : "failed"}]`)
  }
}

async function runCliHeadless(options: CliOptions, saved?: OpenCliSession): Promise<RunrailRunResult> {
  const client = options.mcpCommand === undefined
    ? undefined
    : await McpClient.connect({ command: options.mcpCommand, args: options.mcpArgs, cwd: options.cwd })
  let piExtensions: PiExtensionHost | undefined
  try {
    piExtensions = await createCliPiExtensionHost(options)
    return await runRunrail({
      cwd: options.cwd,
      backend: options.backend,
      requiredCapabilities: options.requiredCapabilities,
      maxSteps: options.maxSteps,
      maxRepairAttempts: options.maxRepairAttempts,
      verify: options.verify,
      task: options.task,
      verificationCommand: options.verificationCommand,
      verificationTimeoutMs: options.verificationTimeoutMs,
      sessionDir: saved?.dir ?? options.sessionDir,
      sessionId: saved?.id ?? options.sessionId,
      ...(saved === undefined ? {} : { transcriptStore: saved.transcriptStore, sessionBehaviorFile: false }),
      behaviorConfigPath: options.behaviorConfigPath,
      ...(options.userSkills === undefined ? {} : { userSkills: options.userSkills }),
      ...(options.nifra === undefined ? {} : { nifra: options.nifra }),
      provider: options.provider,
    harnessCommand: options.harnessCommand,
    harnessArgs: options.harnessArgs,
        harnessAuth: options.harnessAuth,
        ...(options.harnessAccount === undefined ? {} : { harnessAccount: options.harnessAccount }),
        harnessPersistent: options.harnessPersistent,
        harnessProtocol: options.harnessProtocol,
        harnessLaunch: options.harnessLaunch,
    modelCommand: options.modelCommand,
      modelSelection: options.modelSelection,
      budget: options.budget,
      context: options.context,
      ...(options.defaultSystemPrompt === false ? { defaultSystemPrompt: false } : {}), ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }), ...(options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars }),
      onEvent: options.json ? undefined : createCliEventRenderer(),
      onNotice: (line) => console.error(line),
      mcpClients: client === undefined ? undefined : Object.freeze([client]),
      mcpLoadResources: options.mcpLoadResources,
      piExtensions,
      pi: {
        ...(options.piOptions ?? {}),
        ...(options.piCommand === undefined ? {} : { command: options.piCommand }),
      },
    })
  } finally {
    await client?.close()
    await piExtensions?.close()
  }
}

export const CLI_HELP = `Runrail ${RUNRAIL_VERSION}: a local-first coding agent engine.

usage: runrail <command> [options]

Run work
  run         Run one task: runrail run --backend <backend> --cwd <path> [task]
  console     A terminal workbench for a session in a workspace
  pi          Run Pi with its own arguments, unchanged
  new         Start an app from a starter: runrail new <dir> [--starter nifra|vite|next|empty]

Sessions (run and console save each one unless --no-session)
  --continue      With run or console: carry on the latest session in --cwd
  --resume <id>   With run or console: carry on that session, in its folder and on its backend
  --fork <id>     With run or console: start a new session from a copy of that one
  sessions    List saved sessions, newest first: [--cwd <path>] [--limit <n>] [--json]
  export      Print or save one: runrail export <id> [--format json|markdown] [--out <file>]

Serve
  control     The authenticated loopback control RPC the desktop app drives
  serve       An authenticated RPC server for one session
  mcp         Runrail's bounded native tools over MCP stdio
  service     Keep scheduled work running after the desktop app quits: --app <path>

Sign-ins
  login       Sign in to a provider (runrail login --list shows what is offered)
  logout      Remove a stored sign-in
  auth        Check a connection: runrail auth doctor <connection>

Inspect
  backends, models, providers, harnesses, compatibility   List what is available (--json)
  plugins, packages   Manage local plugins and packages
  benchmark   Deterministic replay benchmarks
  doctor      Check this machine for Runrail: [--cwd <path>] [--json]

Backends: replay, native, pi, codex, claude-code, copilot, opencode, gemini, goose
Docs: https://github.com/TechDev009/runrail#readme

runrail --version prints the version; runrail --help prints this.`

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h", "help"])

/** Help or the version, asked for anywhere but inside Pi's own arguments. */
function informationAsked(argv: readonly string[]): "help" | "version" | undefined {
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") return argv.length === 1 ? "version" : undefined
  if (argv[0] !== undefined && HELP_FLAGS.has(argv[0])) return "help"
  if (argv[0] === "pi") return undefined
  return argv.slice(1).some((arg) => arg === "--help" || arg === "-h") ? "help" : undefined
}

/**
 * Runs the command line. Exported for a build that composes the CLI, such as a desktop sidecar that
 * registers a bundled Agent SDK first; `import.meta.main` is false in a module such a build imports.
 */
// A check that fails in a project it does not fit would have the agent edit code after any message, even "hi".
function askedToVerify(options: CliOptions): boolean {
  return options.verifyAfterTurn === true || options.verificationCommand !== undefined
}

export async function runCliMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const asked = informationAsked(argv)
  if (asked !== undefined) {
    console.log(asked === "version" ? RUNRAIL_VERSION : CLI_HELP)
    return
  }
  if (argv.length === 0) {
    console.error(CLI_HELP)
    process.exitCode = 2
    return
  }
  try {
    if (argv[0] === "new") {
      const stop = new AbortController()
      process.once("SIGINT", () => stop.abort())
      process.exitCode = await runNewCli(parseNewCliArgs(argv.slice(1)), { out: (line) => console.log(line), note: (line) => console.error(line), signal: stop.signal })
      return
    }
    const plan: CliSessionPlan = await prepareCliSession(argv)
    const parsed = parseCliArgs(plan.argv)
    // One vault object per process: a connection named on the command line and the control server read the same store.
    const accountStorage = parsed.connection !== undefined || parsed.toolConnection !== undefined || parsed.command === "control" || parsed.command === "login" || parsed.command === "logout" || parsed.command === "auth" ? createCliAccountStorage(parsed) : undefined
    const connected: CliOptions = parsed.connection === undefined || accountStorage === undefined ? parsed : { ...parsed, provider: await resolveCliConnection(parsed.connection, accountStorage) }
    const options: CliOptions = connected.toolConnection === undefined || accountStorage === undefined ? connected : await applyToolConnection(connected, accountStorage)
    if (options.command === "pi") {
      process.exitCode = await runPiPassthrough(options.piArgs, {
        command: options.piCommand,
      })
    } else if (options.command === "login" || options.command === "logout") {
      process.exitCode = await runSignInCommand(options, accountStorage ?? createCliAccountStorage(options))
    } else if (options.command === "auth") {
      process.exitCode = await runAuthDoctorCommand(options, accountStorage ?? createCliAccountStorage(options))
    } else if (options.command === "backends") {
      const adapters = createDefaultBackendRegistry().list().map(({ create: _create, ...adapter }) => adapter)
      console.log(JSON.stringify(adapters, null, 2))
    } else if (options.command === "models") {
      const models = options.providerDiscovery === undefined ? createDefaultModelCatalog().list() : await discoverProviderModels(options.providerDiscovery)
      console.log(JSON.stringify(models, null, 2))
    } else if (options.command === "benchmark") {
      const result = await runReferenceBenchmark({ repeats: options.benchmarkRepeats, maxConcurrency: options.benchmarkConcurrency })
      if (options.json) console.log(JSON.stringify(result, null, 2))
      else {
        const cost = result.totalCostUsd === undefined ? "unknown" : result.totalCostUsd.toFixed(6)
        console.log(`benchmark\t${result.successfulCases}/${result.totalCases}\tuseful=${result.usefulResults}\tcost=${cost}\t${result.totalDurationMs.toFixed(2)}ms`)
      }
    } else if (options.command === "providers") {
      console.log(JSON.stringify(createDefaultProviderCatalog().list(), null, 2))
    } else if (options.command === "harnesses") {
      console.log(JSON.stringify(new HarnessRegistry(createDefaultHarnessAdapters()).list(), null, 2))
    } else if (options.command === "compatibility") {
      const matrix = createDefaultPiCompatibilityMatrix()
      const nativeMatrix = createDefaultNativeCapabilityMatrix()
      const harnessMatrix = createDefaultHarnessCompatibilityMatrix()
      if (options.json) console.log(JSON.stringify({ ...nativeMatrix, piMatrix: matrix, harnessMatrix }, null, 2))
      else {
        const nativeSummary = summarizeNativeCapabilityMatrix(nativeMatrix)
        const summary = summarizePiCompatibilityMatrix(matrix)
        const harnessSummary = summarizeHarnessCompatibilityMatrix(harnessMatrix)
        console.log(`compatibility\tnative=${nativeSummary.verified}/${nativeSummary.total}\tnative-active=${nativeSummary.active}\tnative-gaps=${nativeSummary.gaps.length}\tPi ${matrix.piVersion}\tfeatures=${summary.total}\tharness-rows=${harnessSummary.total}`)
      }
    } else if (options.command === "mcp") {
      await runRunrailMcpServer({ cwd: options.cwd, ...(options.mcpMaxMessageBytes === undefined ? {} : { maxMessageBytes: options.mcpMaxMessageBytes }) })
    } else if (options.command === "browser-mcp" && options.browserEndpointFile !== undefined) {
      await runBrowserMcpServer({ endpointFile: options.browserEndpointFile })
    } else if (options.command === "connectors-mcp" && options.browserEndpointFile !== undefined) {
      await runConnectorsMcpServer({ endpointFile: options.browserEndpointFile })
    } else if (options.command === "threads-mcp" && options.browserEndpointFile !== undefined) {
      await runThreadsMcpServer({ endpointFile: options.browserEndpointFile })
    } else if (options.command === "computer-mcp" && options.browserEndpointFile !== undefined) {
      await runComputerMcpServer({ endpointFile: options.browserEndpointFile })
    } else if (options.command === "images-mcp" && options.browserEndpointFile !== undefined) {
      await runImagesMcpServer({ endpointFile: options.browserEndpointFile })
    } else if (options.command === "service" && options.serviceApp !== undefined) {
      const stop = new AbortController()
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort())
      // A moved or deleted app ends the service with success, so launchd does not restart it every minute.
      await runWakeService({ app: options.serviceApp, signal: stop.signal }).catch((error: unknown) => console.error(error instanceof Error ? error.message : "the service stopped"))
    } else if (options.command === "packages") {
      await runPackageCli(options)
    } else if (options.command === "plugins") {
      await runPluginCli(options)
    } else if (options.command === "sessions") {
      await runSessionsCli(options)
    } else if (options.command === "export") {
      await runExportCli(options)
    } else if (options.command === "doctor") {
      process.exitCode = await runDoctorCli(options)
    } else if (options.command === "console") {
      let piExtensions: PiExtensionHost | undefined
      const saved = await openCliSession(plan, { cwd: options.cwd, backend: options.backend, route: routeArgs(plan.argv) })
      try {
        piExtensions = await createCliPiExtensionHost(options)
        const status = await runRunrailTui({
          cwd: options.cwd,
          backend: options.backend,
          requiredCapabilities: options.requiredCapabilities,
          maxSteps: options.maxSteps,
          maxRepairAttempts: options.maxRepairAttempts,
          verify: options.verify,
          verificationCommand: options.verificationCommand,
          verificationTimeoutMs: options.verificationTimeoutMs,
          verifyAfterTurn: askedToVerify(options),
          sessionDir: saved?.dir ?? options.sessionDir,
          sessionId: saved?.id ?? options.sessionId,
          ...(saved === undefined ? {} : { transcriptStore: saved.transcriptStore, sessionBehaviorFile: false }),
          behaviorConfigPath: options.behaviorConfigPath,
          ...(options.userSkills === undefined ? {} : { userSkills: options.userSkills }),
          ...(options.nifra === undefined ? {} : { nifra: options.nifra }),
          provider: options.provider,
          harnessCommand: options.harnessCommand,
          harnessArgs: options.harnessArgs,
          harnessAuth: options.harnessAuth,
          ...(options.harnessAccount === undefined ? {} : { harnessAccount: options.harnessAccount }),
          harnessPersistent: options.harnessPersistent,
          harnessProtocol: options.harnessProtocol,
          harnessLaunch: options.harnessLaunch,
          modelCommand: options.modelCommand,
          modelSelection: options.modelSelection,
          budget: options.budget,
          context: options.context,
          ...(options.defaultSystemPrompt === false ? { defaultSystemPrompt: false } : {}), ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }), ...(options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars }),
          piExtensions,
          pi: {
            ...(options.piOptions ?? {}),
            ...(options.piCommand === undefined ? {} : { command: options.piCommand }),
          },
        })
        process.exitCode = status === "failed" ? 1 : 0
      } finally {
        await piExtensions?.close()
        sessionHint(saved, "console", options.json)
      }
    } else if (options.command === "control") {
      const pluginManager = await timed("plugins", () => createPluginManager({ workspaceRoot: options.cwd, trustDir: join(homedir(), ".runrail", "plugin-trust") }))
      let piExtensions: PiExtensionHost | undefined
      const terminalBridge = options.terminal === true ? createPtyTerminalBridge(options.terminalShell === undefined ? {} : { shell: options.terminalShell }) : undefined
      const { accountsDir, vault: credentialVault } = accountStorage ?? createCliAccountStorage(options)
      try {
        piExtensions = await timed("pi-extensions", () => createCliPiExtensionHost(options))
        const transcriptStore = options.transcriptDir === undefined ? undefined : new FileTranscriptStore({ root: options.transcriptDir })
        // Before the session opens, so it starts with the conversation it continues.
        if (transcriptStore !== undefined && options.continueFrom !== undefined && options.sessionId !== undefined)
          await continueTranscript(new FileTranscriptStore({ root: options.continueFrom.transcriptDir }), options.continueFrom.sessionId, transcriptStore, options.sessionId).catch(() => false)
        const server = await timed("control-server", () => startRunrailControlRpcServer({
          cwd: options.cwd,
          backend: options.backend,
          requiredCapabilities: options.requiredCapabilities,
          maxSteps: options.maxSteps,
          maxRepairAttempts: options.maxRepairAttempts,
          verifyAfterTurn: askedToVerify(options),
          verify: options.verify,
          verificationCommand: options.verificationCommand,
          verificationTimeoutMs: options.verificationTimeoutMs,
          sessionDir: options.sessionDir,
          sessionId: options.sessionId,
          ...(options.checkpoints === true ? { checkpoints: true } : {}),
          ...(options.folders === undefined ? {} : { folders: options.folders }),
          ...(transcriptStore === undefined ? {} : { transcriptStore }),
          ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
          ...(options.threadsDir === undefined ? {} : { threadsDir: options.threadsDir }),
          nativeAccountsDir: accountsDir,
          ...(credentialVault === undefined ? {} : { nativeCredentialVault: credentialVault, nativeSignInFlows: cliSignInFlows() }),
          ...(options.behaviorConfigPath === undefined ? {} : { behaviorConfigPath: options.behaviorConfigPath }),
          ...(options.userSkills === undefined ? {} : { userSkills: options.userSkills }),
          ...(options.nifra === undefined ? {} : { nifra: options.nifra }),
          provider: options.provider,
          harnessCommand: options.harnessCommand,
          harnessArgs: options.harnessArgs,
          harnessAuth: options.harnessAuth,
          ...(options.harnessAccount === undefined ? {} : { harnessAccount: options.harnessAccount }),
          ...(options.toolConnectionRoute === undefined ? {} : { toolConnection: options.toolConnectionRoute }),
          harnessPersistent: options.harnessPersistent,
          harnessProtocol: options.harnessProtocol,
          harnessLaunch: options.harnessLaunch,
          modelCommand: options.modelCommand,
          modelSelection: options.modelSelection,
          budget: options.budget,
          context: options.context,
          ...(options.defaultSystemPrompt === false ? { defaultSystemPrompt: false } : {}), ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }), ...(options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars }),
          pluginManager,
          ...(terminalBridge === undefined
            ? { unavailableTerminalCapabilities: ["terminal.describe", "terminal.create", "terminal.write", "terminal.read", "terminal.resize", "terminal.close"] as const }
            : { terminalBridge }),
          piExtensions,
          pi: {
            ...(options.piOptions ?? {}),
            ...(options.piCommand === undefined ? {} : { command: options.piCommand }),
          },
          ...(options.host === undefined ? {} : { hostname: options.host }),
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
          ...(options.browserTools === true ? { browserTools: { anySite: options.browserAnySite === true, mcpCommand: browserMcpCommand() } } : {}),
          connectorsFile: join(homedir(), ".runrail", "connectors.json"),
          connectorTools: { mcpCommand: browserMcpCommand() },
          ...(options.threadTools === true ? { threadTools: { mcpCommand: browserMcpCommand() } } : {}),
          ...(options.computerTools === true ? { computerTools: { mcpCommand: browserMcpCommand() } } : {}),
          ...(options.imageTools === true ? { imageTools: { mcpCommand: browserMcpCommand() } } : {}),
        }))
        const ready = { type: "control.ready", ...server.contract, url: server.handle.url, token: server.handle.token }
        if (options.json) console.log(JSON.stringify(ready))
        else console.error(`Runrail control RPC listening at ${ready.url} (use --json for the authentication handshake)`)
        let resolveStopped: () => void = () => {}
        const stopped = new Promise<void>((resolve) => {
          resolveStopped = resolve
        })
        let stopping = false
        const stop = async (code: number): Promise<void> => {
          if (stopping) return
          stopping = true
          try {
            await server.handle.stop()
          } catch {
            process.exitCode = 1
          } finally {
            if (process.exitCode === undefined) process.exitCode = code
            resolveStopped()
          }
        }
        process.once("SIGINT", () => void stop(130))
        process.once("SIGTERM", () => void stop(143))
        if (options.exitOnStdinClose === true) {
          // The host holds the write end of stdin. It closes when the host exits for any reason,
          // including a crash or a kill that skips the host's own cleanup.
          process.stdin.once("end", () => void stop(0))
          process.stdin.once("error", () => void stop(0))
          process.stdin.resume()
        }
        await stopped
        if (options.exitOnStdinClose === true) process.stdin.pause()
      } finally {
        await terminalBridge?.dispose()
        await piExtensions?.close()
      }
    } else if (options.command === "serve") {
      let piExtensions: PiExtensionHost | undefined
      try {
        piExtensions = await createCliPiExtensionHost(options)
        const server = await startRunrailRpcServer({
          cwd: options.cwd,
          backend: options.backend,
          requiredCapabilities: options.requiredCapabilities,
          maxSteps: options.maxSteps,
          maxRepairAttempts: options.maxRepairAttempts,
          verify: options.verify,
          verificationCommand: options.verificationCommand,
          verificationTimeoutMs: options.verificationTimeoutMs,
          verifyAfterTurn: askedToVerify(options),
          sessionDir: options.sessionDir,
          sessionId: options.sessionId,
          behaviorConfigPath: options.behaviorConfigPath,
          ...(options.userSkills === undefined ? {} : { userSkills: options.userSkills }),
          ...(options.nifra === undefined ? {} : { nifra: options.nifra }),
          provider: options.provider,
          harnessCommand: options.harnessCommand,
          harnessArgs: options.harnessArgs,
          harnessAuth: options.harnessAuth,
          ...(options.harnessAccount === undefined ? {} : { harnessAccount: options.harnessAccount }),
          harnessPersistent: options.harnessPersistent,
          harnessProtocol: options.harnessProtocol,
          harnessLaunch: options.harnessLaunch,
          modelCommand: options.modelCommand,
          modelSelection: options.modelSelection,
          budget: options.budget,
          context: options.context,
          ...(options.defaultSystemPrompt === false ? { defaultSystemPrompt: false } : {}), ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }), ...(options.maxReplyChars === undefined ? {} : { maxReplyChars: options.maxReplyChars }),
          piExtensions,
          pi: {
            ...(options.piOptions ?? {}),
            ...(options.piCommand === undefined ? {} : { command: options.piCommand }),
          },
          ...(options.host === undefined ? {} : { hostname: options.host }),
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
        })
        const ready = { type: "rpc.ready", url: server.handle.url, token: server.handle.token, protocol: 1, runrailVersion: RUNRAIL_VERSION }
        if (options.json) console.log(JSON.stringify(ready))
        else console.error(`Runrail RPC listening at ${ready.url} (use --json for the authentication handshake)`)
        const stop = async (code: number): Promise<void> => {
          await server.handle.stop()
          await piExtensions?.close()
          process.exit(code)
        }
        process.once("SIGINT", () => void stop(130))
        process.once("SIGTERM", () => void stop(143))
        await new Promise<void>(() => {})
      } finally {
        await piExtensions?.close()
      }
    } else {
      const saved = await openCliSession(plan, { cwd: options.cwd, backend: options.backend, route: routeArgs(plan.argv) })
      const result = await runCliHeadless(options, saved)
      if (options.json) console.log(JSON.stringify(result, null, 2))
      else {
        for (const event of result.events) console.log(`${event.seq}\t${event.type}`)
        console.log(`${result.status}\t${result.digest}`)
      }
      sessionHint(saved, "run", options.json)
      process.exitCode = result.status === "succeeded" ? 0 : 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}

if (import.meta.main) await runCliMain()

function readTokenFile(path: string): string {
  const info = statSync(path)
  if (!info.isFile() || info.size > 1_024) throw new Error("token-file must be a small regular file")
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("token-file must not be readable by other users (chmod 600)")
  return readFileSync(path, "utf8").trim()
}
