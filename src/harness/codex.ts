import { RUNRAIL_VERSION } from "../version.ts"
import type { AgentBackend } from "@nifrajs/agent-protocol"
import { CommandAgentBackend, type CommandAgentBackendOptions } from "../backend/command-agent.ts"
import { PersistentCommandAgentBackend, type PersistentCommandAgentControlHandlers } from "../backend/persistent-command-agent.ts"
import { CodexAppServerBackend, CODEX_APP_SERVER_PROTOCOL_VERSION, type CodexAppServerBackendOptions } from "../backend/codex-app-server.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import { HARNESS_ROUTE_LIMITS, HarnessLaunchError, codexExecLaunchArguments, parseHarnessLaunchOptions, type HarnessLaunchOptions } from "./launch.ts"
import { mapCodexEvent } from "./mappers.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"

export interface CodexHarnessOptions extends Omit<CommandAgentBackendOptions, "name" | "capabilities" | "command"> {
  readonly command?: string
  /** The Codex CLI to run when `command` is not set. Unlike `command`, it keeps Runrail's own launch arguments. */
  readonly executable?: string
  readonly capabilities?: readonly string[]
  /** Use a caller-supplied long-lived JSONL Codex protocol instead of exec mode. */
  readonly persistent?: boolean
  /** Select the documented bidirectional Codex app-server protocol explicitly. */
  readonly protocol?: "jsonl" | "app-server"
  readonly controlHandlers?: PersistentCommandAgentControlHandlers
  /** Model, effort, permission mode, appended instructions, and resume for exec mode and app-server. */
  readonly launch?: HarnessLaunchOptions
}

export const CODEX_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({ id: "codex", name: "Codex-compatible", version: RUNRAIL_VERSION, runtimeVersion: "caller-installed", protocolVersion: "codex.exec.json", kind: "codex", classification: "adapter", firstParty: true, authModes: Object.freeze(["caller", "environment", "subscription"] as const), defaultAuthMode: "subscription", controls: Object.freeze(["cancel", "inspect", "close"] as const), events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "rate-limit", "cancellation", "failure"] as const), features: Object.freeze(["sessions", "streaming", "tools", "reload", "verification", "repair"] as HarnessFeature[]), capabilities: Object.freeze(["sessions", "streaming", "tools", "reload"]) })

export function createCodexHarnessAdapter(options: CodexHarnessOptions = {}): HarnessAdapter {
  const descriptor = options.protocol === "app-server"
    ? appServerDescriptor()
    : options.persistent === true
      ? persistentDescriptor(options.controlHandlers)
      : CODEX_HARNESS_DESCRIPTOR
  return createJsonlHarnessAdapter(descriptor, () => createCodexHarness(options))
}

export function createCodexHarness(options: CodexHarnessOptions = {}): AgentBackend {
  if (options.protocol === "app-server") return new CodexAppServerBackend(normalizeAppServerOptions(options))
  const normalized = normalizeCodexOptions(options)
  return options.persistent === true ? new PersistentCommandAgentBackend(normalized) : new CommandAgentBackend(normalized)
}

function normalizeAppServerOptions({ executable, ...options }: CodexHarnessOptions): CodexAppServerBackendOptions {
  return {
    ...options,
    command: options.command ?? executable ?? "codex",
    args: options.args ?? ["app-server", "--listen", "stdio://"],
    name: "codex-app-server",
    capabilities: options.capabilities ?? appServerDescriptor().capabilities,
  }
}

function normalizeCodexOptions(options: CodexHarnessOptions): CommandAgentBackendOptions & Pick<CodexHarnessOptions, "controlHandlers"> {
  const { launch: requested, executable, ...rest } = options
  const launch = requested === undefined ? undefined : parseHarnessLaunchOptions(requested)
  if (launch?.mcpConfig !== undefined || launch?.allowedTools !== undefined) throw new HarnessLaunchError("MCP configuration and allowed tools are not supported by Codex")
  const nativeCommand = options.command === undefined
  const identity = {
    command: options.command ?? executable ?? "codex",
    name: "codex",
    capabilities: options.capabilities ?? CODEX_HARNESS_DESCRIPTOR.capabilities,
    eventMapper: mapCodexEvent,
  }
  // Exec mode as Runrail drives it: the prompt on stdin, the thread's settings and the
  // conversation to continue in the argument list. A hand-shaped command keeps its own shape.
  const execMode = options.persistent !== true && options.args === undefined && options.promptMode === undefined && options.turnArgs === undefined && (nativeCommand || launch !== undefined)
  if (execMode) {
    return {
      ...rest,
      ...identity,
      args: [],
      promptMode: "stdin",
      turnArgs: (turn) => codexExecLaunchArguments(launch ?? {}, turn.vendorSessionId),
      tolerateUnknownEvents: options.tolerateUnknownEvents ?? true,
      timeoutMs: options.timeoutMs ?? HARNESS_ROUTE_LIMITS.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? HARNESS_ROUTE_LIMITS.maxOutputBytes,
      maxEvents: options.maxEvents ?? HARNESS_ROUTE_LIMITS.maxEvents,
    }
  }
  if (launch !== undefined) throw new HarnessLaunchError("launch options need exec mode without custom arguments")
  return {
    ...rest,
    ...(nativeCommand && options.args === undefined ? { args: ["exec", "--json"] } : {}),
    ...(nativeCommand && options.promptMode === undefined ? { promptMode: "argument" as const } : {}),
    ...identity,
  }
}

function persistentDescriptor(handlers: PersistentCommandAgentControlHandlers | undefined): HarnessDescriptor {
  const controls = new Set<string>(["follow-up", "cancel", "inspect", "close"])
  const capabilities = new Set<string>([...CODEX_HARNESS_DESCRIPTOR.capabilities, "persistent"])
  const features = new Set(CODEX_HARNESS_DESCRIPTOR.features)
  if (handlers?.interrupt !== undefined) controls.add("interrupt")
  if (handlers?.resume !== undefined) controls.add("resume")
  if (handlers?.fork !== undefined) { controls.add("fork"); features.add("fork"); capabilities.add("fork") }
  if (handlers?.compact !== undefined) { controls.add("compact"); features.add("compact"); capabilities.add("compact") }
  if (handlers?.setModel !== undefined) { controls.add("model"); capabilities.add("models") }
  if (handlers?.setThinking !== undefined) { controls.add("thinking"); capabilities.add("thinking") }
  if (handlers?.setSandbox !== undefined) { controls.add("sandbox"); capabilities.add("sandbox") }
  if (handlers?.configureMcp !== undefined) { controls.add("mcp"); features.add("mcp"); capabilities.add("mcp") }
  if (handlers?.resolveApproval !== undefined) { controls.add("approve"); controls.add("reject"); features.add("approvals"); capabilities.add("approvals") }
  return Object.freeze({
    ...CODEX_HARNESS_DESCRIPTOR,
    controls: Object.freeze([...controls] as HarnessDescriptor["controls"]),
    features: Object.freeze([...features] as HarnessDescriptor["features"]),
    capabilities: Object.freeze([...capabilities]),
  })
}

function appServerDescriptor(): HarnessDescriptor {
  return Object.freeze({
    ...CODEX_HARNESS_DESCRIPTOR,
    protocolVersion: CODEX_APP_SERVER_PROTOCOL_VERSION,
    controls: Object.freeze(["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "fork", "compact", "model", "thinking", "sandbox", "inspect", "close"] as HarnessDescriptor["controls"]),
    events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "usage", "rate-limit", "cancellation", "failure"] as HarnessDescriptor["events"]),
    features: Object.freeze(["sessions", "streaming", "tools", "approvals", "fork", "reload", "compact", "verification", "repair"] as HarnessDescriptor["features"]),
    capabilities: Object.freeze(["sessions", "streaming", "persistent", "tools", "approvals", "resume", "fork", "models", "thinking", "sandbox", "reload", "compact"]),
  })
}
