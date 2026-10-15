import {
  createCommandAgentBackend,
  createHarnessAdapterModule,
  type HarnessAdapter,
} from "runrail"

const manifest = {
  manifestVersion: 1 as const,
  id: "my-agent",
  name: "My agent",
  apiVersion: "1.0",
  adapterVersion: "1.0.0",
  runtimeVersion: "caller-installed",
  protocolVersion: "my-agent.jsonl/1",
  kind: "custom" as const,
  classification: "adapter" as const,
  features: ["sessions", "streaming"] as const,
  capabilities: ["sessions", "streaming"] as const,
  controls: ["follow-up", "cancel", "inspect", "close"] as const,
  events: ["lifecycle", "assistant", "failure"] as const,
  authModes: ["caller"] as const,
  security: ["caller-process", "bounded-jsonl"] as const,
}

/**
 * A complete adapter module authored outside Runrail internals. The caller
 * supplies the executable and owns its credentials and process boundary.
 */
export function createExternalHarnessAdapter(command: string, args: readonly string[] = []): HarnessAdapter {
  return createHarnessAdapterModule(manifest, () => createCommandAgentBackend({
    command,
    args,
    name: manifest.id,
    version: manifest.adapterVersion,
    capabilities: manifest.capabilities,
    promptMode: "jsonl",
  }))
}
