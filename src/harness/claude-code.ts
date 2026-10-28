import { RUNRAIL_VERSION } from "../version.ts"
import type { AgentBackend } from "@nifrajs/agent-protocol"
import { ClaudeAgentSdkBackend, type ClaudeAgentSdkBackendOptions } from "../backend/claude-agent-sdk.ts"
import { CommandAgentBackend, type CommandAgentBackendOptions } from "../backend/command-agent.ts"
import { PersistentCommandAgentBackend, type PersistentCommandAgentControlHandlers } from "../backend/persistent-command-agent.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import { CLAUDE_CODE_PRINT_ARGS, HARNESS_ROUTE_LIMITS, HarnessLaunchError, claudeCodeLaunchArguments, parseHarnessLaunchOptions, type HarnessLaunchOptions } from "./launch.ts"
import { mapClaudeCodeEvent } from "./mappers.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"

export interface ClaudeCodeHarnessOptions extends Omit<CommandAgentBackendOptions, "name" | "capabilities" | "command"> {
  readonly command?: string
  readonly capabilities?: readonly string[]
  /** Use a caller-supplied long-lived JSONL Claude protocol instead of print mode. */
  readonly persistent?: boolean
  readonly controlHandlers?: PersistentCommandAgentControlHandlers
  /** Model, effort, permission mode, appended prompt, MCP configuration, and resume for print mode. */
  readonly launch?: HarnessLaunchOptions
}

export const CLAUDE_CODE_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({ id: "claude-code", name: "Claude Code-compatible", version: RUNRAIL_VERSION, runtimeVersion: "caller-installed", protocolVersion: "claude.stream-json", kind: "claude-code", classification: "adapter", firstParty: true, authModes: Object.freeze(["caller", "environment", "subscription"] as const), defaultAuthMode: "subscription", controls: Object.freeze(["cancel", "inspect", "close"] as const), events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "rate-limit", "cancellation", "failure"] as const), features: Object.freeze(["sessions", "streaming", "tools", "reload", "verification", "repair"] as HarnessFeature[]), capabilities: Object.freeze(["sessions", "streaming", "tools", "reload"]) })

/** Claude Code over Anthropic's Agent SDK: one long-lived process per session that can ask for approval. */
export const CLAUDE_CODE_SDK_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  ...CLAUDE_CODE_HARNESS_DESCRIPTOR,
  protocolVersion: "claude.agent-sdk",
  controls: Object.freeze(["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "fork", "compact", "model", "thinking", "inspect", "close"] as const),
  features: Object.freeze(["sessions", "streaming", "tools", "approvals", "fork", "reload", "compact", "verification", "repair"] as HarnessFeature[]),
  capabilities: Object.freeze(["sessions", "streaming", "persistent", "tools", "approvals", "resume", "fork", "models", "thinking", "reload", "compact"]),
})

export type ClaudeCodeSdkHarnessOptions = Omit<ClaudeAgentSdkBackendOptions, "name" | "capabilities">

export function createClaudeCodeSdkHarnessAdapter(options: ClaudeCodeSdkHarnessOptions): HarnessAdapter {
  return createJsonlHarnessAdapter(CLAUDE_CODE_SDK_HARNESS_DESCRIPTOR, () => createClaudeCodeSdkHarness(options))
}

export function createClaudeCodeSdkHarness(options: ClaudeCodeSdkHarnessOptions): ClaudeAgentSdkBackend {
  return new ClaudeAgentSdkBackend({ ...options, name: "claude-code", capabilities: CLAUDE_CODE_SDK_HARNESS_DESCRIPTOR.capabilities })
}

export function createClaudeCodeHarnessAdapter(options: ClaudeCodeHarnessOptions = {}): HarnessAdapter {
  const descriptor = options.persistent === true ? persistentDescriptor(options.controlHandlers) : CLAUDE_CODE_HARNESS_DESCRIPTOR
  return createJsonlHarnessAdapter(descriptor, () => createClaudeCodeHarness(options))
}

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions = {}): AgentBackend {
  const normalized = normalizeClaudeCodeOptions(options)
  return options.persistent === true ? new PersistentCommandAgentBackend(normalized) : new CommandAgentBackend(normalized)
}

function normalizeClaudeCodeOptions(options: ClaudeCodeHarnessOptions): CommandAgentBackendOptions & Pick<ClaudeCodeHarnessOptions, "controlHandlers"> {
  const { launch: requested, ...rest } = options
  const launch = requested === undefined ? undefined : parseHarnessLaunchOptions(requested)
  const nativeCommand = options.command === undefined
  const identity = {
    command: options.command ?? "claude",
    name: "claude-code",
    capabilities: options.capabilities ?? CLAUDE_CODE_HARNESS_DESCRIPTOR.capabilities,
    eventMapper: mapClaudeCodeEvent,
  }
  // Print mode as Runrail drives it: the prompt on stdin, the thread's settings and the
  // conversation to continue as flags. Anything the caller shaped by hand keeps its own shape.
  const printMode = options.persistent !== true && options.args === undefined && options.promptMode === undefined && options.turnArgs === undefined && (nativeCommand || launch !== undefined)
  if (printMode) {
    return {
      ...rest,
      ...identity,
      args: CLAUDE_CODE_PRINT_ARGS,
      promptMode: "stdin",
      turnArgs: (turn) => claudeCodeLaunchArguments(launch ?? {}, turn.vendorSessionId, turn.fork === true, turn.at),
      tolerateUnknownEvents: options.tolerateUnknownEvents ?? true,
      timeoutMs: options.timeoutMs ?? HARNESS_ROUTE_LIMITS.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? HARNESS_ROUTE_LIMITS.maxOutputBytes,
      maxEvents: options.maxEvents ?? HARNESS_ROUTE_LIMITS.maxEvents,
    }
  }
  if (launch !== undefined) throw new HarnessLaunchError("launch options need print mode without custom arguments")
  return {
    ...rest,
    ...(nativeCommand && options.args === undefined ? { args: ["--print", "--output-format", "stream-json", "--verbose", "--setting-sources", "user"] } : {}),
    ...(nativeCommand && options.promptMode === undefined ? { promptMode: "argument" as const } : {}),
    ...identity,
  }
}

function persistentDescriptor(handlers: PersistentCommandAgentControlHandlers | undefined): HarnessDescriptor {
  const controls = new Set<string>(["follow-up", "cancel", "inspect", "close"])
  const capabilities = new Set<string>([...CLAUDE_CODE_HARNESS_DESCRIPTOR.capabilities, "persistent"])
  const features = new Set(CLAUDE_CODE_HARNESS_DESCRIPTOR.features)
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
    ...CLAUDE_CODE_HARNESS_DESCRIPTOR,
    controls: Object.freeze([...controls] as HarnessDescriptor["controls"]),
    features: Object.freeze([...features] as HarnessDescriptor["features"]),
    capabilities: Object.freeze([...capabilities]),
  })
}
