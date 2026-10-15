import type { AgentBackend } from "@nifrajs/agent-protocol"
import { PtyAgentBackend, type PtyAgentBackendOptions } from "../backend/pty-agent.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"
import { RUNRAIL_VERSION } from "../version.ts"

export interface PtyHarnessOptions extends Omit<PtyAgentBackendOptions, "name" | "capabilities"> {
  readonly capabilities?: readonly string[]
}

export const PTY_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "pty",
  name: "PTY JSONL",
  version: RUNRAIL_VERSION,
  runtimeVersion: "caller-installed",
  protocolVersion: "runrail.pty.jsonl",
  kind: "pty",
  classification: "caller-owned",
  firstParty: true,
  authModes: Object.freeze(["caller", "environment", "subscription"] as const),
  defaultAuthMode: "subscription",
  controls: Object.freeze(["follow-up", "cancel", "interrupt", "inspect", "close"] as const),
  events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "cancellation", "failure"] as const),
  features: Object.freeze(["sessions", "streaming", "reload"] as HarnessFeature[]),
  capabilities: Object.freeze(["sessions", "streaming", "pty"]),
})

export function createPtyHarnessAdapter(options: PtyHarnessOptions): HarnessAdapter {
  return createJsonlHarnessAdapter(PTY_HARNESS_DESCRIPTOR, () => createPtyHarness(options))
}

export function createPtyHarness(options: PtyHarnessOptions): AgentBackend {
  return new PtyAgentBackend({ ...options, name: "pty", capabilities: options.capabilities ?? PTY_HARNESS_DESCRIPTOR.capabilities })
}
