import { AcpAgentBackend, type AcpAgentBackendOptions } from "../backend/acp-agent.ts"
import { RUNRAIL_VERSION } from "../version.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import type { HarnessPermissionMode } from "./launch.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessFeature } from "./types.ts"

/**
 * OpenCode through its own Agent Client Protocol mode (`opencode acp`).
 *
 * Runrail starts the unmodified `opencode` binary with the providers it is already signed in to.
 * It never runs `opencode auth`, never reads OpenCode's credential files, and sends no editor
 * identity.
 */
export interface OpenCodeHarnessOptions extends Omit<AcpAgentBackendOptions, "name" | "label" | "command" | "settingArgs" | "routeEnv" | "trailingUpdateMs"> {
  readonly command?: string
}

export const OPENCODE_HARNESS_DESCRIPTOR: HarnessDescriptor = Object.freeze({
  id: "opencode",
  name: "OpenCode",
  version: RUNRAIL_VERSION,
  runtimeVersion: "caller-installed",
  protocolVersion: "acp.v1",
  kind: "opencode",
  classification: "adapter",
  firstParty: true,
  authModes: Object.freeze(["caller", "environment", "subscription"] as const),
  defaultAuthMode: "subscription",
  controls: Object.freeze(["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "fork", "model", "inspect", "close"] as const),
  events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "approval", "cancellation", "failure"] as const),
  features: Object.freeze(["sessions", "streaming", "tools", "approvals", "fork", "reload", "verification", "repair"] as HarnessFeature[]),
  capabilities: Object.freeze(["sessions", "streaming", "persistent", "tools", "approvals", "resume", "fork", "models", "reload"]),
})

/** OpenCode tools that run something or reach the network. */
const OPENCODE_COMMAND_TOOLS = Object.freeze(["bash", "webfetch", "websearch", "codesearch"])

export function createOpenCodeHarnessAdapter(options: OpenCodeHarnessOptions = {}): HarnessAdapter {
  return createJsonlHarnessAdapter(OPENCODE_HARNESS_DESCRIPTOR, () => createOpenCodeHarness(options))
}

export function createOpenCodeHarness(options: OpenCodeHarnessOptions = {}): AcpAgentBackend {
  const permission = openCodePermission(options.launch?.permissionMode)
  return new AcpAgentBackend({
    ...options,
    name: "opencode",
    label: "OpenCode",
    command: options.command ?? "opencode",
    args: options.args ?? ["acp"],
    capabilities: options.capabilities ?? OPENCODE_HARNESS_DESCRIPTOR.capabilities,
    // OpenCode 1.2.26 answers the prompt before it sends the last of the reply.
    trailingUpdateMs: 300,
    ...(permission === undefined ? {} : { routeEnv: { OPENCODE_PERMISSION: permission } }),
  })
}

/**
 * The OpenCode tools that ask first under the thread's permission mode, as `OPENCODE_PERMISSION`.
 * OpenCode allows every tool its config does not restrict, so without this an Ask thread would
 * edit and run commands unasked. OpenCode applies it over the user's own rules, so a rule there
 * that denies one of these tools becomes a question instead. Bypass leaves OpenCode's config alone.
 */
export function openCodePermission(mode: HarnessPermissionMode | undefined): string | undefined {
  if (mode === "bypass") return undefined
  // Plan changes nothing: edits and commands are refused outright, and only look-ups ask.
  if (mode === "plan") return JSON.stringify({ edit: "deny", bash: "deny", ...Object.fromEntries(OPENCODE_COMMAND_TOOLS.filter((tool) => tool !== "bash").map((tool) => [tool, "ask"])) })
  // Edits run unasked under Auto-edit and Auto, so only commands and network tools ask there.
  const gated = mode === "accept-edits" || mode === "auto" ? OPENCODE_COMMAND_TOOLS : ["edit", ...OPENCODE_COMMAND_TOOLS]
  return JSON.stringify(Object.fromEntries(gated.map((tool) => [tool, "ask"])))
}
