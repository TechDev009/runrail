import { RUNRAIL_VERSION } from "../version.ts"
import type { AgentBackend } from "@nifrajs/agent-protocol"
import {
  type NativeApprovalPort,
  type PiBackendOptions,
} from "@nifrajs/coding-agent"
import { RunrailBackend } from "./runrail-backend.ts"
import { createPiBackend } from "./pi.ts"
import { createReplayBackend } from "./replay.ts"
import { CommandAgentBackend } from "./command-agent.ts"
import { PersistentCommandAgentBackend } from "./persistent-command-agent.ts"
import { CodexAppServerBackend } from "./codex-app-server.ts"
import { mapClaudeCodeEvent, mapCodexEvent } from "../harness/mappers.ts"
import type { RunrailLiveSink } from "../live/types.ts"
import type { HarnessMetadataSink } from "../harness/types.ts"
import { parseHarnessAuthOptions } from "../harness/auth.ts"
import { harnessAccountEnvironment, parseHarnessAccountOptions, type HarnessAccountOptions } from "../harness/account.ts"
import type { HarnessAuthOptions } from "../harness/types.ts"
import { createClaudeCodeHarness, createClaudeCodeSdkHarness } from "../harness/claude-code.ts"
import { CLAUDE_AGENT_SDK, claudeAgentSdkStatus, loadClaudeAgentSdk } from "./claude-agent-sdk.ts"
import { createCodexHarness } from "../harness/codex.ts"
import { resolveCodexCommand } from "../harness/detect.ts"
import { createCopilotHarness } from "../harness/copilot.ts"
import { createOpenCodeHarness } from "../harness/opencode.ts"
import { createGeminiHarness } from "../harness/gemini.ts"
import { createGooseHarness } from "../harness/goose.ts"
import type { AcpAgentBackend, AcpMcpServer } from "./acp-agent.ts"
import { parseHarnessLaunchOptions } from "../harness/launch.ts"
import { createFileVendorSessionStore, type VendorSessionStore } from "../harness/vendor-session-store.ts"
import { createHash } from "node:crypto"
import { BrowserBridge } from "../browser/bridge.ts"
import { ConnectorRegistry } from "../connectors/registry.ts"
import { ThreadsBridge } from "../threads/bridge.ts"
import { ComputerBridge } from "../computer/bridge.ts"
import { ImageService } from "../images/service.ts"
import type { GrantedConnectorTool } from "../connectors/tools.ts"
import { ScriptedModel } from "../model/scripted-model.ts"
import { createToolCatalog } from "../tools/catalog.ts"
import { createWorkspacePolicy } from "../workspace/policy.ts"
import {
  createBackendRegistry,
  createSecurityManifest,
  type RunrailBackendAdapter,
  type RunrailBackendContext,
  type BackendRegistry,
} from "./registry.ts"

const externalCapabilities = Object.freeze(["sessions", "streaming", "tools", "reload", "verification", "repair"])

export interface DefaultBackendFactories {
  readonly native?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly pi?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly replay?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly codex?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly claudeCode?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly copilot?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly opencode?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly gemini?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
  readonly goose?: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>
}

/** Shipped adapters. A caller can replace any factory without changing registry semantics. */
export function createDefaultBackendRegistry(
  factories: DefaultBackendFactories = {},
): BackendRegistry {
  const native = adapter(
    "native",
    ["sessions", "streaming", "approvals", "reload", "workspace.tools", "tools", "verification", "repair", "models", "model.routing", "context.resources", "console", "budgets", "metrics", "cache.hooks", "plugins", "session.transfer", "mcp", "skills", "agents", "connectors", "worktrees"],
    createSecurityManifest(["filesystem.read", "filesystem.write", "process.exec"]),
    factories.native ?? defaultNative,
  )
  const pi = adapter(
    "pi",
    [
      "sessions",
      "streaming",
      "approvals",
      "reload",
      "interactive",
      "providers",
      "extensions",
      "skills",
      "themes",
      "models",
      "context.resources",
      "console",
      "plugins",
      "session.transfer",
      "budgets",
      "metrics",
      "cache.hooks",
      "workspace.tools",
      "verification",
      "repair",
    ],
    createSecurityManifest([
      "filesystem.read",
      "filesystem.write",
      "process.exec",
      "network.request",
      "credentials.read",
    ]),
    factories.pi ?? defaultPi,
  )
  const replay = adapter(
    "replay",
    ["sessions", "streaming", "deterministic.replay", "evidence"],
    createSecurityManifest([]),
    factories.replay ?? (() => createReplayBackend()),
  )
  const codex = adapter(
    "codex",
    externalCapabilities,
    createSecurityManifest(["filesystem.read", "filesystem.write", "process.exec"]),
    factories.codex ?? (async (context) => createCommandBackend(context, "codex", mapCodexEvent, typeof context.options.harnessCommand === "string" ? "codex" : await resolveCodexCommand())),
  )
  const claudeCode = adapter(
    "claude-code",
    externalCapabilities,
    createSecurityManifest(["filesystem.read", "filesystem.write", "process.exec"]),
    factories.claudeCode ?? createClaudeCodeBackend,
  )
  const copilot = adapter(
    "copilot",
    [...externalCapabilities, "approvals"],
    createSecurityManifest(["filesystem.read", "filesystem.write", "process.exec", "network.request"]),
    factories.copilot ?? ((context) => createAcpRouteBackend(context, "copilot", createCopilotHarness)),
  )
  const opencode = adapter(
    "opencode",
    [...externalCapabilities, "approvals"],
    createSecurityManifest(["filesystem.read", "filesystem.write", "process.exec", "network.request"]),
    factories.opencode ?? ((context) => createAcpRouteBackend(context, "opencode", createOpenCodeHarness)),
  )
  const gemini = adapter(
    "gemini",
    [...externalCapabilities, "approvals"],
    createSecurityManifest(["filesystem.read", "filesystem.write", "process.exec", "network.request"]),
    factories.gemini ?? ((context) => createAcpRouteBackend(context, "gemini", (options) => {
      const account = parseHarnessAccountOptions(context.options.harnessAccount)
      return createGeminiHarness({ ...options, ...(account?.configDir === undefined ? {} : { configDir: account.configDir }), ...(account?.apiKey === undefined ? {} : { apiKey: account.apiKey }) })
    })),
  )
  const goose = adapter(
    "goose",
    [...externalCapabilities, "approvals"],
    createSecurityManifest(["filesystem.read", "filesystem.write", "process.exec", "network.request"]),
    factories.goose ?? ((context) => createAcpRouteBackend(context, "goose", createGooseHarness)),
  )
  return createBackendRegistry([native, pi, replay, codex, claudeCode, copilot, opencode, gemini, goose])
}

function adapter(
  name: string,
  capabilities: readonly string[],
  securityManifest: ReturnType<typeof createSecurityManifest>,
  create: (context: RunrailBackendContext) => AgentBackend | PromiseLike<AgentBackend>,
): RunrailBackendAdapter {
  return { name, version: RUNRAIL_VERSION, capabilities, securityManifest, create }
}

async function defaultNative(context: RunrailBackendContext): Promise<AgentBackend> {
  const policy = await createWorkspacePolicy(context.cwd)
  const tools = createToolCatalog(policy)
  const model = new ScriptedModel()
  // A bare registry has no person to ask, so a scripted edit is refused unless the caller supplies its own port.
  const approval: NativeApprovalPort = { request: () => false }
  return new RunrailBackend({ model, tools, approval })
}

function defaultPi(context: RunrailBackendContext): AgentBackend {
  if (hasAccount(parseHarnessAccountOptions(context.options.harnessAccount))) throw new Error("HARNESS_ACCOUNT_UNSUPPORTED")
  const value = context.options.pi
  return createPiBackend(isPiOptions(value) ? value : {})
}

function createCommandBackend(
  context: RunrailBackendContext,
  defaultCommand: string,
  eventMapper: NonNullable<ConstructorParameters<typeof CommandAgentBackend>[0]["eventMapper"]>,
  executable = defaultCommand,
): AgentBackend {
  const customCommand = typeof context.options.harnessCommand === "string"
  const command = customCommand ? context.options.harnessCommand as string : executable
  const argsValue = context.options.harnessArgs
  const explicitArgs = Array.isArray(argsValue) && argsValue.every((value): value is string => typeof value === "string") ? argsValue : undefined
  const harnessProtocol = context.options.harnessProtocol
  if (harnessProtocol !== undefined && harnessProtocol !== "jsonl" && harnessProtocol !== "app-server" && harnessProtocol !== "print") throw new Error("HARNESS_PROTOCOL_INVALID")
  if (harnessProtocol === "app-server" && defaultCommand !== "codex") throw new Error("HARNESS_PROTOCOL_REQUIRES_CODEX")
  if (harnessProtocol === "print" && defaultCommand !== "claude") throw new Error("HARNESS_PROTOCOL_REQUIRES_CLAUDE_CODE")
  const name = defaultCommand === "codex" ? "codex" : "claude-code"
  const account = parseHarnessAccountOptions(context.options.harnessAccount)
  // The vendor's own CLI with nothing overridden: Runrail forwards the thread's settings and
  // continues its conversation. A custom command or argument list keeps the caller's shape.
  const vendorRoute = !customCommand && explicitArgs === undefined && context.options.harnessPersistent !== true
  const appServer = harnessProtocol === "app-server" || (vendorRoute && defaultCommand === "codex" && harnessProtocol === undefined)
  if (hasAccount(account) && !vendorRoute && !appServer) throw new Error("HARNESS_ACCOUNT_UNSUPPORTED")
  const routeEnv = harnessAccountEnvironment(name, account)
  const accountEnv = Object.keys(routeEnv).length === 0 ? {} : { routeEnv }
  if (appServer) {
    return new CodexAppServerBackend({
      command,
      args: explicitArgs ?? ["app-server", "--listen", "stdio://"],
      auth: parseHarnessAuthOptions(context.options.harnessAuth),
      ...accountEnv,
      // Codex reads no key from its environment here; it signs in with the key on stdin.
      ...(account?.apiKey === undefined ? {} : { apiKey: account.apiKey }),
      // The route is still "codex"; only a caller who asks for the protocol by name sees it.
      name: harnessProtocol === "app-server" ? "codex-app-server" : name,
      launch: parseHarnessLaunchOptions(context.options.harnessLaunch),
      ...vendorSessions(context, name, account),
      ...browserAccess(context, name),
      ...(context.options.threads instanceof ThreadsBridge ? { threads: context.options.threads } : {}),
      ...(context.options.computer instanceof ComputerBridge ? { computer: context.options.computer } : {}),
      ...(context.options.images instanceof ImageService ? { images: context.options.images } : {}),
      ...connectorAccess(context),
      ...liveSink(context),
      ...metadataSink(context),
    })
  }
  const auth = accountAuth(context, account, defaultCommand === "codex" ? "CODEX_API_KEY" : "ANTHROPIC_API_KEY")
  if (vendorRoute) {
    const options = { auth, ...accountEnv, capabilities: externalCapabilities, launch: parseHarnessLaunchOptions(context.options.harnessLaunch), ...vendorSessions(context, name, account), ...liveSink(context), ...metadataSink(context) }
    return defaultCommand === "codex" ? createCodexHarness({ ...options, protocol: "jsonl", executable }) : createClaudeCodeHarness(options)
  }
  const args = explicitArgs ?? (customCommand
    ? undefined
    : defaultCommand === "codex"
      ? ["exec", "--json"]
      : ["--print", "--output-format", "stream-json", "--verbose", "--setting-sources", "user"])
  const options = { command, ...(args === undefined ? {} : { args }), promptMode: customCommand ? "jsonl" as const : "argument" as const, auth, name, capabilities: externalCapabilities, eventMapper, ...liveSink(context), ...metadataSink(context) }
  return context.options.harnessPersistent === true ? new PersistentCommandAgentBackend(options) : new CommandAgentBackend(options)
}

/**
 * Claude Code over its Agent SDK when the SDK is installed or bundled, else print mode. Asking for
 * `sdk` by name fails without the SDK; asking for `print` never loads it.
 */
async function createClaudeCodeBackend(context: RunrailBackendContext): Promise<AgentBackend> {
  const protocol = context.options.harnessProtocol
  const argsValue = context.options.harnessArgs
  const shaped = context.options.harnessPersistent === true || (Array.isArray(argsValue) && argsValue.length > 0)
  const vendorRoute = !shaped && typeof context.options.harnessCommand !== "string"
  if (protocol === "sdk" && shaped) throw new Error("HARNESS_PROTOCOL_SDK_UNSHAPED")
  if (protocol === "sdk" || (protocol === undefined && vendorRoute)) {
    const sdk = await loadClaudeAgentSdk()
    if (sdk !== undefined) {
      const account = parseHarnessAccountOptions(context.options.harnessAccount)
      const routeEnv = harnessAccountEnvironment("claude-code", account)
      return createClaudeCodeSdkHarness({
        sdk,
        ...(typeof context.options.harnessCommand === "string" ? { command: context.options.harnessCommand } : {}),
        auth: accountAuth(context, account, "ANTHROPIC_API_KEY"),
        ...(Object.keys(routeEnv).length === 0 ? {} : { routeEnv }),
        launch: parseHarnessLaunchOptions(context.options.harnessLaunch),
        ...vendorSessions(context, "claude-code", account),
        ...liveSink(context),
        ...metadataSink(context),
        ...approvalSink(context),
      })
    }
    if (protocol === "sdk") {
      const status = claudeAgentSdkStatus()
      throw new Error(`HARNESS_SDK_MISSING: the Claude Agent SDK is not installed. Install it with: ${status.downloadCommand ?? status.installCommand} (${CLAUDE_AGENT_SDK.npmUrl})`)
    }
  }
  return createCommandBackend(context, "claude", mapClaudeCodeEvent)
}

/** Backends that drive a coding tool over the Agent Client Protocol. */
export const ACP_ROUTE_BACKENDS: readonly string[] = Object.freeze(["copilot", "opencode", "gemini", "goose"])

export function isAcpRouteBackend(name: string): boolean {
  return ACP_ROUTE_BACKENDS.includes(name)
}

type AcpRouteOptions = Pick<Parameters<typeof createCopilotHarness>[0] & object, "command" | "args" | "auth" | "launch" | "mcpServers" | "vendorSessions" | "onLive">

/**
 * A coding tool in its Agent Client Protocol mode (Copilot, OpenCode, Gemini, Goose). A named command stands in
 * for the tool's own (a wrapper, another install); the protocol stays the same, so there is no
 * other mode to pick.
 */
function createAcpRouteBackend(context: RunrailBackendContext, backend: string, create: (options: AcpRouteOptions) => AcpAgentBackend): AgentBackend {
  if (context.options.harnessProtocol !== undefined) throw new Error("HARNESS_PROTOCOL_REQUIRES_CODEX")
  const account = parseHarnessAccountOptions(context.options.harnessAccount)
  if (backend !== "gemini" && hasAccount(account)) throw new Error("HARNESS_ACCOUNT_UNSUPPORTED")
  if (context.options.harnessPersistent === true) throw new Error("HARNESS_PERSISTENT_UNSUPPORTED")
  const argsValue = context.options.harnessArgs
  const args = Array.isArray(argsValue) && argsValue.every((value): value is string => typeof value === "string") ? argsValue : undefined
  return create({
    ...(typeof context.options.harnessCommand === "string" ? { command: context.options.harnessCommand } : {}),
    ...(args === undefined ? {} : { args }),
    auth: parseHarnessAuthOptions(context.options.harnessAuth),
    launch: parseHarnessLaunchOptions(context.options.harnessLaunch),
    ...(Array.isArray(context.options.harnessMcpServers) ? { mcpServers: context.options.harnessMcpServers as readonly AcpMcpServer[] } : {}),
    ...vendorSessions(context, backend, account),
    ...liveSink(context),
  })
}

function hasAccount(account: HarnessAccountOptions | undefined): boolean {
  return account?.configDir !== undefined || account?.apiKey !== undefined
}

/** The caller's own credential settings, or the connection's key as the one variable the tool reads. */
function accountAuth(context: RunrailBackendContext, account: HarnessAccountOptions | undefined, keyVariable: string): HarnessAuthOptions {
  const read = account?.apiKey
  if (read === undefined) return parseHarnessAuthOptions(context.options.harnessAuth)
  if (context.options.harnessAuth !== undefined) throw new Error("HARNESS_ACCOUNT_CONFLICT")
  return parseHarnessAuthOptions({ mode: "caller", credentialEnvironment: [keyVariable], credentialResolver: async () => ({ [keyVariable]: await read() }) })
}

/**
 * Where a vendor conversation id is kept, so a restarted engine continues the same conversation.
 * A conversation lives in the tool's config folder, so each account folder keeps its own ids.
 */
function vendorSessions(context: RunrailBackendContext, backend: string, account?: HarnessAccountOptions): { readonly vendorSessions?: VendorSessionStore } {
  const directory = context.options.harnessStateDir
  return typeof directory === "string" && directory.length > 0 ? { vendorSessions: vendorSessionStore(directory, backend, account) } : {}
}

/** The store a route's backend reads its vendor conversation from, under the session's `harness` folder. */
export function vendorSessionStore(directory: string, backend: string, account?: HarnessAccountOptions): VendorSessionStore {
  const name = account?.configDir === undefined ? backend : `${backend}.${createHash("sha256").update(account.configDir).digest("hex").slice(0, 16)}`
  return createFileVendorSessionStore(directory, name)
}

/** The browser bridge, and where to note which vendor threads started with its tools. */
function browserAccess(context: RunrailBackendContext, backend: string): { readonly browser?: BrowserBridge; readonly browserThreads?: VendorSessionStore } {
  const bridge = context.options.browser
  if (!(bridge instanceof BrowserBridge)) return {}
  const directory = context.options.harnessStateDir
  return { browser: bridge, ...(typeof directory === "string" && directory.length > 0 ? { browserThreads: createFileVendorSessionStore(directory, `${backend}.browser`) } : {}) }
}

/** The connector tools the session granted this Codex thread; checked again by the backend. */
function connectorAccess(context: RunrailBackendContext): { readonly connectors?: { readonly registry: ConnectorRegistry; readonly tools: readonly GrantedConnectorTool[] } } {
  const value = context.options.connectors as { readonly registry?: unknown; readonly tools?: unknown } | undefined
  return value !== undefined && value.registry instanceof ConnectorRegistry && Array.isArray(value.tools) ? { connectors: { registry: value.registry, tools: value.tools as readonly GrantedConnectorTool[] } } : {}
}

function liveSink(context: RunrailBackendContext): { readonly onLive?: RunrailLiveSink } {
  return typeof context.options.onLive === "function" ? { onLive: context.options.onLive as RunrailLiveSink } : {}
}

/** The session's sink for each call the person approved in a coding tool's prompt. */
function approvalSink(context: RunrailBackendContext): { readonly onApproved?: (toolName: string, input: Readonly<Record<string, unknown>>) => void } {
  return typeof context.options.onApproved === "function" ? { onApproved: context.options.onApproved as (toolName: string, input: Readonly<Record<string, unknown>>) => void } : {}
}

/** The session's sink for what a coding tool reports about a turn: token counts, rate limits. */
function metadataSink(context: RunrailBackendContext): { readonly onMetadata?: HarnessMetadataSink } {
  return typeof context.options.onMetadata === "function" ? { onMetadata: context.options.onMetadata as HarnessMetadataSink } : {}
}

function isPiOptions(value: unknown): value is PiBackendOptions {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (!isOptionalStringList(value.args) || !isOptionalStringList(value.rpcArgs)) return false
  if (value.command !== undefined && (typeof value.command !== "string" || value.command.length === 0 || value.command.length > 256)) return false
  if (value.sessionDir !== undefined && (typeof value.sessionDir !== "string" || value.sessionDir.length === 0 || value.sessionDir.length > 4096)) return false
  if (value.noSession !== undefined && typeof value.noSession !== "boolean") return false
  if (value.enableReloadBridge !== undefined && typeof value.enableReloadBridge !== "boolean") return false
  if (value.enableNifraTools !== undefined && typeof value.enableNifraTools !== "boolean") return false
  if (value.appendSystemPrompt !== undefined && (typeof value.appendSystemPrompt !== "string" || value.appendSystemPrompt.length > 256 * 1024)) return false
  if (value.reloadCommand !== undefined && value.reloadCommand !== "restart" && value.reloadCommand !== "prompt" && value.reloadCommand !== "rpc") return false
  if (value.maxEventQueueSize !== undefined && (typeof value.maxEventQueueSize !== "number" || !Number.isSafeInteger(value.maxEventQueueSize) || value.maxEventQueueSize < 1 || value.maxEventQueueSize > 16_384)) return false
  if (value.env !== undefined && !isEnvironment(value.env)) return false
  return true
}

function isOptionalStringList(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === "string" && item.length <= 4096))
}

function isEnvironment(value: unknown): value is Readonly<Record<string, string | undefined>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  return Object.entries(value).every(([name, entry]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && (entry === undefined || (typeof entry === "string" && entry.length <= 4096)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
