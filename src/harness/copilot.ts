import { AcpAgentBackend, type AcpAgentBackendOptions, type AcpProcessSettings } from "../backend/acp-agent.ts"
import { RUNRAIL_VERSION } from "../version.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import type { HarnessEffort } from "./launch.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"

/**
 * GitHub Copilot through GitHub's own command-line tool, run in its Agent Client Protocol mode.
 *
 * Runrail starts the unmodified `copilot` binary with the login it already has. It never signs in
 * to GitHub, never reads the tool's credential files, and sends no editor identity: what GitHub
 * sees is its own tool. A Copilot subscription is used the way GitHub built it to be used.
 */
export interface CopilotHarnessOptions extends Omit<AcpAgentBackendOptions, "name" | "label" | "command" | "settingArgs"> {
  readonly command?: string
}

/** The effort levels the Copilot CLI takes on its command line. */
export const COPILOT_EFFORTS: readonly HarnessEffort[] = Object.freeze(["low", "medium", "high", "xhigh", "max"])

export const COPILOT_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "copilot",
  name: "GitHub Copilot CLI",
  version: RUNRAIL_VERSION,
  runtimeVersion: "caller-installed",
  protocolVersion: "acp.v1",
  kind: "copilot",
  classification: "adapter",
  firstParty: true,
  authModes: Object.freeze(["caller", "environment", "subscription"] as const),
  defaultAuthMode: "subscription",
  controls: Object.freeze(["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "model", "thinking", "inspect", "close"] as const),
  events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "cancellation", "failure"] as const),
  features: Object.freeze(["sessions", "streaming", "tools", "approvals", "reload", "verification", "repair"] as HarnessFeature[]),
  capabilities: Object.freeze(["sessions", "streaming", "persistent", "tools", "approvals", "resume", "models", "thinking", "reload"]),
})

export function createCopilotHarnessAdapter(options: CopilotHarnessOptions = {}): HarnessAdapter {
  return createJsonlHarnessAdapter(COPILOT_HARNESS_DESCRIPTOR, () => createCopilotHarness(options))
}

export function createCopilotHarness(options: CopilotHarnessOptions = {}): AcpAgentBackend {
  return new AcpAgentBackend({
    ...options,
    name: "copilot",
    label: "Copilot",
    command: options.command ?? "copilot",
    args: options.args ?? ["--acp"],
    capabilities: options.capabilities ?? COPILOT_HARNESS_DESCRIPTOR.capabilities,
    settingArgs: copilotSettingArguments,
  })
}

/** The model and effort as `copilot` flags. A model id never starts with a hyphen, so it cannot be read as a flag. */
export function copilotSettingArguments(settings: AcpProcessSettings): readonly string[] {
  return Object.freeze([
    ...(settings.model === undefined ? [] : ["--model", settings.model]),
    ...(settings.effort === undefined ? [] : ["--effort", settings.effort === "minimal" ? "low" : settings.effort]),
  ])
}
