import type { NativeTool } from "@nifrajs/coding-agent"
import type { ConnectorAction, ConnectorRegistry } from "./registry.ts"

/**
 * Who may use what: one grant per Runrail-provided integration, set per role on the desktop and
 * handed to each thread's engine in its behavior file. Off hides the integration, Read offers its
 * read and search actions, Ask offers every action and each use waits for the person, and Write
 * offers every action with writes still asking first. Without a grant an integration is Write, as
 * before grants existed.
 */

export type IntegrationGrant = "off" | "read" | "ask" | "write"
export const INTEGRATION_GRANTS: readonly IntegrationGrant[] = ["off", "read", "ask", "write"]
export type IntegrationGrants = Readonly<Record<string, IntegrationGrant>>

/** The grant for an MCP server the session starts is keyed by its name. */
export function mcpGrantKey(server: string): string {
  return `mcp:${server}`
}

export function grantOf(grants: IntegrationGrants | undefined, key: string): IntegrationGrant {
  return grants?.[key] ?? "write"
}

/** One connector action a role may use, named for MCP and Codex as `<connector>_<action>`. */
export interface GrantedConnectorTool {
  readonly name: string
  readonly connector: string
  readonly action: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly capabilities: readonly string[]
  /** Each use waits for the person. */
  readonly approval: boolean
}

export function grantedConnectorTools(registry: ConnectorRegistry, grants: IntegrationGrants | undefined): readonly GrantedConnectorTool[] {
  const tools: GrantedConnectorTool[] = []
  for (const descriptor of registry.list()) {
    const grant = grantOf(grants, descriptor.id)
    if (grant === "off") continue
    for (const action of registry.actions(descriptor.id)) {
      const reads = action.kind === "read" || action.kind === "search"
      if (grant === "read" && !reads) continue
      tools.push(Object.freeze({
        name: `${descriptor.id}_${action.name}`,
        connector: descriptor.id,
        action: action.name,
        description: action.description,
        inputSchema: inputSchemaOf(descriptor.id, action),
        capabilities: action.capabilities,
        approval: grant === "ask" || action.requiresApproval === true,
      }))
    }
  }
  return Object.freeze(tools)
}

/** Runrail's own loop: the granted actions as native tools, named `connector.<id>.<action>` as before. */
export function connectorNativeTools(registry: ConnectorRegistry, granted: readonly GrantedConnectorTool[]): readonly NativeTool[] {
  return Object.freeze(granted.map((tool): NativeTool => Object.freeze({
    name: `connector.${tool.connector}.${tool.action}`,
    description: `${tool.description} Input: ${inputSummary(tool.inputSchema)}.`,
    capabilities: tool.capabilities,
    ...(tool.approval ? { requiresApproval: true } : {}),
    // The native approval gate already asked when this tool needs it.
    execute: (input: unknown, context: { readonly cwd: string; readonly signal: AbortSignal }) => callConnector(registry, tool, input, context),
  })))
}

/** One call, past whatever gate the route asked at; a grant it was not given never reaches here. */
export function callConnector(registry: ConnectorRegistry, tool: GrantedConnectorTool, input: unknown, context: { readonly cwd: string; readonly signal: AbortSignal }): Promise<unknown> {
  return registry.invoke(tool.connector, tool.action, input ?? {}, {
    cwd: context.cwd,
    signal: context.signal,
    allowedCapabilities: ["connector.read", "connector.search", "connector.write", "connector.notify"],
    approve: () => true,
  })
}

const object = (properties: Record<string, unknown>, required: readonly string[] = []) => Object.freeze({ type: "object", properties, required, additionalProperties: false })
const text = (description: string, maxLength = 4_096) => ({ type: "string", maxLength, description })
const limit = (max: number) => ({ type: "integer", minimum: 1, maximum: max, description: "How many to return." })
const OWNER = text("Repository owner.", 100)
const REPO = text("Repository name.", 100)
const STATE = { type: "string", enum: ["open", "closed", "all"] }

/** The input each built-in action takes, as JSON Schema, for routes that need one. */
const INPUT_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "github.searchIssues": object({ query: text("GitHub search query."), owner: OWNER, repo: REPO, limit: limit(100) }, ["query"]),
  "github.listIssues": object({ owner: OWNER, repo: REPO, state: STATE, limit: limit(100) }, ["owner", "repo"]),
  "github.createIssue": object({ owner: OWNER, repo: REPO, title: text("Title.", 256), body: text("Body in Markdown.", 65_536), labels: { type: "array", items: text("Label.", 128), maxItems: 16 } }, ["owner", "repo", "title"]),
  "github.listPullRequests": object({ owner: OWNER, repo: REPO, state: STATE, head: text("owner:branch", 256), base: text("Base branch.", 256), limit: limit(100) }, ["owner", "repo"]),
  "github.createPullRequest": object({ owner: OWNER, repo: REPO, title: text("Title.", 256), body: text("Body in Markdown.", 65_536), head: text("owner:branch or branch", 256), base: text("Base branch.", 256), draft: { type: "boolean" } }, ["owner", "repo", "title", "head", "base"]),
  "linear.searchIssues": object({ query: text("Text to search for."), limit: limit(100) }, ["query"]),
  "linear.createIssue": object({ title: text("Title.", 256), description: text("Description in Markdown.", 65_536), teamId: text("Team id.", 256) }, ["title"]),
  "jira.searchIssues": object({ jql: text("JQL query."), limit: limit(100) }, ["jql"]),
  "jira.createComment": object({ issueKey: text("Issue key, such as ABC-12.", 64), body: text("Comment text.", 65_536) }, ["issueKey", "body"]),
  "slack.listChannels": object({ limit: limit(200), cursor: text("Cursor from the previous page.") }),
  "slack.searchMessages": object({ query: text("Slack search query."), limit: limit(100) }, ["query"]),
  "slack.sendMessage": object({ channel: text("Channel id.", 256), text: text("Message text.", 40_000), threadTs: text("Reply in this thread.", 128) }, ["channel", "text"]),
}

function inputSchemaOf(connector: string, action: ConnectorAction): Readonly<Record<string, unknown>> {
  return INPUT_SCHEMAS[`${connector}.${action.name}`] ?? object({})
}

function inputSummary(schema: Readonly<Record<string, unknown>>): string {
  const properties = schema.properties !== null && typeof schema.properties === "object" ? Object.keys(schema.properties) : []
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  return properties.length === 0 ? "{}" : `{${properties.map((name) => (required.has(name) ? name : `${name}?`)).join(", ")}}`
}
