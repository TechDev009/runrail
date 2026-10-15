import { RUNRAIL_VERSION } from "../version.ts"
import type { HarnessDescriptor, HarnessFeature } from "./types.ts"

export const GROK_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({ id: "grok", name: "Grok-compatible", version: RUNRAIL_VERSION, kind: "grok", features: Object.freeze(["sessions", "streaming", "tools", "approvals"] as HarnessFeature[]), capabilities: Object.freeze(["sessions", "streaming", "tools", "approvals"]) })
