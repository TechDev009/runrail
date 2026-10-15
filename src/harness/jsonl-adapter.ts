import type { AgentBackend } from "@nifrajs/agent-protocol"
import type { HarnessAdapter, HarnessDescriptor } from "./types.ts"

export function createJsonlHarnessAdapter(descriptor: HarnessDescriptor, createBackend: () => AgentBackend): HarnessAdapter {
  return Object.freeze({ descriptor, create: () => createBackend() })
}
