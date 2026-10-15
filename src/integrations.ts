import type { AgentBackend } from "@nifrajs/agent-protocol"
import type { NativeTool } from "@nifrajs/coding-agent"
import type { ConnectorNativeToolOptions, ConnectorRegistry } from "./connectors/registry.ts"
import type { ContextResourceOptions } from "./context/resources.ts"
import type { McpClient } from "./mcp/client.ts"
import type { PluginHost } from "./plugins/sdk.ts"
import type { PiExtensionHost } from "./plugins/pi/extensions.ts"
import type { SkillRegistry } from "./skills/registry.ts"

export type RunrailIntegrationName = "mcp" | "skills" | "plugins" | "connectors" | "tools" | "agents" | "worktrees" | "verification" | "repair" | "budgets" | "metrics" | "session.transfer"

export interface RunrailIntegrationBundle {
  readonly mcpClients?: readonly McpClient[]
  readonly mcpLoadResources?: boolean
  readonly connectorRegistry?: ConnectorRegistry
  readonly connectorToolOptions?: Omit<ConnectorNativeToolOptions, "cwd">
  readonly pluginHost?: PluginHost
  readonly piExtensions?: PiExtensionHost
  readonly skillRegistry?: SkillRegistry
  readonly tools?: readonly NativeTool[]
  readonly context?: ContextResourceOptions
}

export interface RunrailIntegrationContext {
  readonly cwd: string
  readonly bundle: RunrailIntegrationBundle
  readonly requested: readonly RunrailIntegrationName[]
}

export type RunrailIntegrationHook = (backend: AgentBackend, context: RunrailIntegrationContext) => AgentBackend | PromiseLike<AgentBackend>

export function integrationRequirements(bundle: RunrailIntegrationBundle): readonly RunrailIntegrationName[] {
  const required: RunrailIntegrationName[] = []
  if ((bundle.mcpClients?.length ?? 0) > 0) required.push("mcp")
  if (bundle.skillRegistry !== undefined) required.push("skills")
  if (bundle.pluginHost !== undefined || bundle.piExtensions !== undefined) required.push("plugins")
  if (bundle.connectorRegistry !== undefined) required.push("connectors")
  if ((bundle.tools?.length ?? 0) > 0) required.push("tools" as RunrailIntegrationName)
  return Object.freeze([...new Set(required)].sort())
}

export function unsupportedIntegrations(capabilities: readonly string[], bundle: RunrailIntegrationBundle): readonly RunrailIntegrationName[] {
  const offered = new Set(capabilities)
  return Object.freeze(integrationRequirements(bundle).filter((name) => !offered.has(name)))
}

export function mergeIntegrationBundles(...bundles: readonly (RunrailIntegrationBundle | undefined)[]): RunrailIntegrationBundle {
  const values = bundles.filter((bundle): bundle is RunrailIntegrationBundle => bundle !== undefined)
  const mcpClients = values.flatMap((bundle) => bundle.mcpClients ?? [])
  const tools = values.flatMap((bundle) => bundle.tools ?? [])
  const connector = values.find((bundle) => bundle.connectorRegistry !== undefined)?.connectorRegistry
  const pluginHost = values.find((bundle) => bundle.pluginHost !== undefined)?.pluginHost
  const piExtensions = values.find((bundle) => bundle.piExtensions !== undefined)?.piExtensions
  const skillRegistry = values.find((bundle) => bundle.skillRegistry !== undefined)?.skillRegistry
  const context = values.find((bundle) => bundle.context !== undefined)?.context
  return Object.freeze({
    ...(mcpClients.length === 0 ? {} : { mcpClients: Object.freeze(mcpClients) }),
    mcpLoadResources: values.some((bundle) => bundle.mcpLoadResources === true),
    ...(connector === undefined ? {} : { connectorRegistry: connector }),
    ...(pluginHost === undefined ? {} : { pluginHost }),
    ...(piExtensions === undefined ? {} : { piExtensions }),
    ...(skillRegistry === undefined ? {} : { skillRegistry }),
    ...(tools.length === 0 ? {} : { tools: Object.freeze(tools) }),
    ...(context === undefined ? {} : { context }),
  })
}
