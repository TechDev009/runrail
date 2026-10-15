import { RUNRAIL_VERSION } from "../version.ts"
import { createPiBackend } from "../backend/pi.ts"
import type { PiBackendOptions } from "@nifrajs/coding-agent"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"

export const PI_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({ id: "pi", name: "Pi", version: RUNRAIL_VERSION, runtimeVersion: "0.84.1", protocolVersion: "pi.cli", kind: "pi", classification: "pass-through", firstParty: true, controls: Object.freeze(["follow-up", "cancel", "approve", "reject", "resume", "fork", "compact", "model", "thinking", "inspect", "close"] as const), events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "usage", "compaction", "cancellation", "failure"] as const), features: Object.freeze(["sessions", "streaming", "tools", "approvals", "reload", "compact", "fork", "verification", "repair"] as HarnessFeature[]), capabilities: Object.freeze(["sessions", "streaming", "approvals", "reload", "workspace.tools", "verification", "repair", "models", "interactive", "providers", "extensions", "skills", "themes", "plugins", "session.transfer", "budgets", "metrics", "cache.hooks"]) })

export function createPiHarnessAdapter(options: PiBackendOptions = {}): HarnessAdapter {
  return Object.freeze({ descriptor: PI_HARNESS_DESCRIPTOR, create: () => createPiBackend(options) })
}
