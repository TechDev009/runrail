import { AcpAgentBackend, type AcpAgentBackendOptions } from "../backend/acp-agent.ts"
import { RUNRAIL_VERSION } from "../version.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"

/**
 * Goose through its Agent Client Protocol mode (`goose acp`). Runrail starts the unmodified
 * `goose` binary with the provider `goose configure` set up, and never reads its keyring or
 * config files. A model Runrail names goes to the conversation as Goose's `model` config option;
 * without one, Goose runs the model it is configured with.
 */
export interface GooseHarnessOptions extends Omit<AcpAgentBackendOptions, "name" | "label" | "command" | "settingArgs" | "routeEnv"> {
  readonly command?: string
}

export const GOOSE_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "goose",
  name: "Goose",
  version: RUNRAIL_VERSION,
  runtimeVersion: "caller-installed",
  protocolVersion: "acp.v1",
  kind: "goose",
  classification: "adapter",
  firstParty: true,
  authModes: Object.freeze(["caller", "environment", "subscription"] as const),
  defaultAuthMode: "subscription",
  controls: Object.freeze(["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "model", "inspect", "close"] as const),
  events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "cancellation", "failure"] as const),
  features: Object.freeze(["sessions", "streaming", "tools", "approvals", "reload", "verification", "repair"] as HarnessFeature[]),
  capabilities: Object.freeze(["sessions", "streaming", "persistent", "tools", "approvals", "resume", "models", "reload"]),
})

export function createGooseHarnessAdapter(options: GooseHarnessOptions = {}): HarnessAdapter {
  return createJsonlHarnessAdapter(GOOSE_HARNESS_DESCRIPTOR, () => createGooseHarness(options))
}

export function createGooseHarness(options: GooseHarnessOptions = {}): AcpAgentBackend {
  return new AcpAgentBackend({
    ...options,
    name: "goose",
    label: "Goose",
    command: options.command ?? "goose",
    args: options.args ?? ["acp"],
    capabilities: options.capabilities ?? GOOSE_HARNESS_DESCRIPTOR.capabilities,
    // Goose runs every tool unasked unless told otherwise; `approve` sends each one to Runrail,
    // which answers by the thread's permission mode. It replaces a mode the user configured.
    routeEnv: { GOOSE_MODE: "approve" },
  })
}
