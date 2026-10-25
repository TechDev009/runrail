import { ConnectorError, type ConnectorDefinition } from "./registry.ts"
import {
  createHttpConnector,
  type ConnectorHttpAction,
  type ConnectorHttpCredential,
  type ConnectorHttpOptions,
} from "./http.ts"

export interface ServiceConnectorOptions {
  readonly endpoint?: string
  readonly credential: ConnectorHttpCredential
  readonly id?: string
  readonly version?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly allowRemote?: boolean
  readonly allowInsecureRemote?: boolean
  readonly allowedHosts?: readonly string[]
  readonly timeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxRetries?: number
  readonly retryDelayMs?: number
}

const serviceCapabilities = Object.freeze(["connector.read", "connector.search", "connector.write", "connector.notify"])

/** Caller-owned GitHub REST actions. The caller supplies endpoint, account, and credential resolver. */
export function createGitHubConnector(options: ServiceConnectorOptions): ConnectorDefinition {
  return createHttpConnector(serviceOptions(options, "github", "GitHub", "https://api.github.com/", "github", "bearer", [
    {
      name: "searchIssues",
      description: "Search GitHub issues in an optional repository.",
      kind: "search",
      capabilities: ["connector.read", "connector.search"],
      method: "GET",
      path: "/search/issues",
      query: (input) => {
        const value = record(input)
        const query = requiredText(value.query, "query", 4_096)
        const repository = optionalRepository(value.owner, value.repo)
        return { q: repository === undefined ? query : `${query} repo:${repository}`, per_page: boundedOptional(value.limit, 1, 100, "limit") ?? 30 }
      },
      retryable: true,
    },
    {
      name: "listIssues",
      description: "List issues for a GitHub repository.",
      kind: "read",
      capabilities: ["connector.read"],
      method: "GET",
      path: (input) => `/repos/${repositoryPath(input)}/issues`,
      query: (input) => {
        const value = record(input)
        return { state: optionalChoice(value.state, ["open", "closed", "all"], "state") ?? "open", per_page: boundedOptional(value.limit, 1, 100, "limit") ?? 30 }
      },
      retryable: true,
    },
    {
      name: "createIssue",
      description: "Create a GitHub issue after approval.",
      kind: "write",
      capabilities: ["connector.write"],
      requiresApproval: true,
      method: "POST",
      path: (input) => `/repos/${repositoryPath(input)}/issues`,
      body: (input) => {
        const value = record(input)
        return { title: requiredText(value.title, "title", 256), ...(multilineText(value.body, "body", 65_536) === undefined ? {} : { body: multilineText(value.body, "body", 65_536) }), ...(value.labels === undefined ? {} : { labels: textList(value.labels, "labels", 16, 128) }) }
      },
    },
    {
      name: "listPullRequests",
      description: "List pull requests for a GitHub repository, optionally for one head branch.",
      kind: "read",
      capabilities: ["connector.read"],
      method: "GET",
      path: (input) => `/repos/${repositoryPath(input)}/pulls`,
      query: (input) => {
        const value = record(input)
        return {
          state: optionalChoice(value.state, ["open", "closed", "all"], "state") ?? "open",
          per_page: boundedOptional(value.limit, 1, 100, "limit") ?? 30,
          ...(value.head === undefined ? {} : { head: branchRef(value.head, "head", true) }),
          ...(value.base === undefined ? {} : { base: branchRef(value.base, "base", false) }),
        }
      },
      retryable: true,
    },
    {
      name: "createPullRequest",
      description: "Open a GitHub pull request after approval.",
      kind: "write",
      capabilities: ["connector.write"],
      requiresApproval: true,
      method: "POST",
      path: (input) => `/repos/${repositoryPath(input)}/pulls`,
      body: (input) => {
        const value = record(input)
        const body = multilineText(value.body, "body", 65_536)
        return {
          title: requiredText(value.title, "title", 256),
          head: branchRef(value.head, "head", true),
          base: branchRef(value.base, "base", false),
          ...(body === undefined ? {} : { body }),
          ...(value.draft === undefined ? {} : { draft: booleanValue(value.draft, "draft") }),
        }
      },
    },
  ]))
}

/** Caller-owned Linear GraphQL actions. Query and mutation payloads are fixed by this adapter. */
export function createLinearConnector(options: ServiceConnectorOptions): ConnectorDefinition {
  return createHttpConnector(serviceOptions(options, "linear", "Linear", "https://api.linear.app/", "linear", "raw", [
    {
      name: "searchIssues",
      description: "Search Linear issues by text.",
      kind: "search",
      capabilities: ["connector.read", "connector.search"],
      method: "POST",
      path: "/graphql",
      body: (input) => {
        const value = record(input)
        return { query: "query RunrailIssueSearch($query: String!, $first: Int) { issueSearch(query: $query, first: $first) { nodes { id identifier title } } }", variables: { query: requiredText(value.query, "query", 4_096), first: boundedOptional(value.limit, 1, 100, "limit") ?? 30 } }
      },
      parse: parseGraphql,
    },
    {
      name: "createIssue",
      description: "Create a Linear issue after approval.",
      kind: "write",
      capabilities: ["connector.write"],
      requiresApproval: true,
      method: "POST",
      path: "/graphql",
      body: (input) => {
        const value = record(input)
        return { query: "mutation RunrailIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title } } }", variables: { input: { title: requiredText(value.title, "title", 256), ...(multilineText(value.description, "description", 65_536) === undefined ? {} : { description: multilineText(value.description, "description", 65_536) }), ...(optionalText(value.teamId, 256) === undefined ? {} : { teamId: optionalText(value.teamId, 256) }) } } }
      },
      parse: parseGraphql,
    },
  ]))
}

/** Caller-owned Jira Cloud REST actions. Basic auth combines a non-secret username with a resolved token. */
export function createJiraConnector(options: ServiceConnectorOptions): ConnectorDefinition {
  if (options.endpoint === undefined) throw new ConnectorError("CONNECTOR_INVALID", "Jira connector endpoint is required")
  return createHttpConnector(serviceOptions(options, "jira", "Jira", options.endpoint, "jira", "basic", [
    {
      name: "searchIssues",
      description: "Search Jira issues with JQL.",
      kind: "search",
      capabilities: ["connector.read", "connector.search"],
      method: "GET",
      path: "/rest/api/3/search",
      query: (input) => {
        const value = record(input)
        return { jql: requiredText(value.jql, "jql", 4_096), maxResults: boundedOptional(value.limit, 1, 100, "limit") ?? 30 }
      },
      retryable: true,
    },
    {
      name: "createComment",
      description: "Add a Jira issue comment after approval.",
      kind: "write",
      capabilities: ["connector.write"],
      requiresApproval: true,
      method: "POST",
      path: (input) => `/rest/api/3/issue/${segment(record(input).issueKey, "issueKey")}/comment`,
      body: (input) => ({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: requiredMultiline(record(input).body, "body", 65_536) }] }] } }),
    },
  ]))
}

/** Caller-owned Slack Web API actions. Mutating messages always require approval. */
export function createSlackConnector(options: ServiceConnectorOptions): ConnectorDefinition {
  return createHttpConnector(serviceOptions(options, "slack", "Slack", "https://slack.com/api/", "slack", "bearer", [
    {
      name: "listChannels",
      description: "List visible Slack conversations.",
      kind: "read",
      capabilities: ["connector.read"],
      method: "GET",
      path: "/conversations.list",
      query: (input) => ({ limit: boundedOptional(record(input).limit, 1, 200, "limit") ?? 100, ...(optionalText(record(input).cursor, 4_096) === undefined ? {} : { cursor: optionalText(record(input).cursor, 4_096) }) }),
      retryable: true,
      parse: parseSlack,
    },
    {
      name: "searchMessages",
      description: "Search Slack messages.",
      kind: "search",
      capabilities: ["connector.read", "connector.search"],
      method: "GET",
      path: "/search.messages",
      query: (input) => ({ query: requiredText(record(input).query, "query", 4_096), count: boundedOptional(record(input).limit, 1, 100, "limit") ?? 30 }),
      retryable: true,
      parse: parseSlack,
    },
    {
      name: "sendMessage",
      description: "Send a Slack message after approval.",
      kind: "notify",
      capabilities: ["connector.notify", "connector.write"],
      requiresApproval: true,
      method: "POST",
      path: "/chat.postMessage",
      body: (input) => {
        const value = record(input)
        return { channel: requiredText(value.channel, "channel", 256), text: requiredMultiline(value.text, "text", 40_000), ...(optionalText(value.threadTs, 128) === undefined ? {} : { thread_ts: optionalText(value.threadTs, 128) }) }
      },
      parse: parseSlack,
    },
  ]))
}

function serviceOptions(options: ServiceConnectorOptions, id: string, _name: string, defaultEndpoint: string, kind: string, scheme: "bearer" | "basic" | "raw", actions: readonly ConnectorHttpAction[]): ConnectorHttpOptions {
  if (options === null || typeof options !== "object" || options.credential === undefined) throw new ConnectorError("CONNECTOR_CREDENTIALS", `${id} connector credential is required`)
  return {
    descriptor: { id: options.id ?? id, version: options.version ?? "1.0.0", kind, capabilities: serviceCapabilities },
    endpoint: options.endpoint ?? defaultEndpoint,
    credential: { ...options.credential, scheme },
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    actions,
    ...(options.allowRemote === undefined ? {} : { allowRemote: options.allowRemote }),
    ...(options.allowInsecureRemote === undefined ? {} : { allowInsecureRemote: options.allowInsecureRemote }),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  }
}

function repositoryPath(input: unknown): string {
  const value = record(input)
  return `${segment(value.owner, "owner")}/${segment(value.repo, "repo")}`
}

function optionalRepository(owner: unknown, repo: unknown): string | undefined {
  if (owner === undefined && repo === undefined) return undefined
  return `${segment(owner, "owner")}/${segment(repo, "repo")}`
}

function parseGraphql(value: unknown): unknown {
  const result = record(value)
  if (Array.isArray(result.errors) && result.errors.length > 0) throw new ConnectorError("CONNECTOR_FAILED", "GraphQL connector request failed")
  return value
}

function parseSlack(value: unknown): unknown {
  const result = record(value)
  if (result.ok !== true) throw new ConnectorError("CONNECTOR_FAILED", "Slack connector request failed")
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("CONNECTOR_INVALID", "connector input must be an object")
  return value as Record<string, unknown>
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return value
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, "text", max)
}

/** Branch name, or `owner:branch` for a fork head when `allowOwner` is set. */
function branchRef(value: unknown, name: string, allowOwner: boolean): string {
  const text = requiredText(value, name, 256)
  const pattern = allowOwner ? /^(?:[A-Za-z0-9][A-Za-z0-9-]{0,99}:)?[A-Za-z0-9][A-Za-z0-9._/-]*$/ : /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
  if (!pattern.test(text) || text.includes("..") || text.endsWith("/") || text.endsWith(".lock")) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return text
}

/** Free text that may span lines, such as a pull request description. */
function multilineText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return value
}

function requiredMultiline(value: unknown, name: string, max: number): string {
  const text = multilineText(value, name, max)
  if (text === undefined || text.length === 0) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return text
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return value
}

function segment(value: unknown, name: string): string {
  const text = requiredText(value, name, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return encodeURIComponent(text)
}

function textList(value: unknown, name: string, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > maxLength || /[\r\n\0]/.test(item))) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return Object.freeze([...value])
}

function boundedOptional(value: unknown, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return value
}

function optionalChoice(value: unknown, choices: readonly string[], name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !choices.includes(value)) throw new ConnectorError("CONNECTOR_INVALID", `connector ${name} is invalid`)
  return value
}
