import { AcpAgentBackend, type AcpAgentBackendOptions, type AcpProcessSettings } from "../backend/acp-agent.ts"
import { CommandAgentBackendError } from "../backend/command-agent.ts"
import { RUNRAIL_VERSION } from "../version.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"

/**
 * Google's Gemini CLI through its Agent Client Protocol mode (`gemini --acp`, Gemini CLI 0.33 and
 * later). Runrail starts the unmodified `gemini` binary with the Google sign-in or key it already
 * has, and never reads its credential files.
 */
export interface GeminiHarnessOptions extends Omit<AcpAgentBackendOptions, "name" | "label" | "command" | "settingArgs" | "routeEnv" | "authenticate"> {
  readonly command?: string
  /** Gemini CLI's home for this connection (`GEMINI_CLI_HOME`). Absent: `~/.gemini`. */
  readonly configDir?: string
  /**
   * A Gemini API key, sent with Gemini's own `authenticate` request on stdin. Gemini writes the
   * sign-in kind it was given into its home's settings and drops a cached Google sign-in there, so
   * a key is taken only with a `configDir` of the connection's own.
   */
  readonly apiKey?: () => Promise<string>
}

export const GEMINI_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "gemini",
  name: "Gemini CLI",
  version: RUNRAIL_VERSION,
  runtimeVersion: "caller-installed",
  protocolVersion: "acp.v1",
  kind: "gemini",
  classification: "adapter",
  firstParty: true,
  authModes: Object.freeze(["caller", "environment", "subscription"] as const),
  defaultAuthMode: "subscription",
  controls: Object.freeze(["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "model", "inspect", "close"] as const),
  events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "cancellation", "failure"] as const),
  features: Object.freeze(["sessions", "streaming", "tools", "approvals", "reload", "verification", "repair"] as HarnessFeature[]),
  capabilities: Object.freeze(["sessions", "streaming", "persistent", "tools", "approvals", "resume", "models", "reload"]),
})

export function createGeminiHarnessAdapter(options: GeminiHarnessOptions = {}): HarnessAdapter {
  return createJsonlHarnessAdapter(GEMINI_HARNESS_DESCRIPTOR, () => createGeminiHarness(options))
}

export function createGeminiHarness(options: GeminiHarnessOptions = {}): AcpAgentBackend {
  const { configDir, apiKey, ...rest } = options
  if (apiKey !== undefined && configDir === undefined) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "a Gemini API key needs a Gemini home of its own")
  return new AcpAgentBackend({
    ...rest,
    ...(configDir === undefined ? {} : { routeEnv: { GEMINI_CLI_HOME: configDir } }),
    ...(apiKey === undefined ? {} : { authenticate: async () => ({ methodId: "gemini-api-key", meta: { "api-key": await apiKey() } }) }),
    name: "gemini",
    label: "Gemini CLI",
    command: options.command ?? "gemini",
    // A default approval mode the user set in Gemini's settings could skip the questions; this keeps them.
    args: options.args ?? ["--acp", "--approval-mode", "default"],
    capabilities: options.capabilities ?? GEMINI_HARNESS_DESCRIPTOR.capabilities,
    settingArgs: geminiSettingArguments,
  })
}

/** The model as a `gemini` flag. Gemini CLI takes no effort on its command line. */
export function geminiSettingArguments(settings: AcpProcessSettings): readonly string[] {
  return Object.freeze(settings.model === undefined ? [] : ["--model", settings.model])
}
