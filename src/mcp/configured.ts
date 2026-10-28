import type { NativeTool } from "@nifrajs/coding-agent"
import type { BehaviorMcpServer } from "../behavior/config.ts"
import { grantOf, mcpGrantKey, type IntegrationGrants } from "../connectors/tools.ts"
import { createMcpNativeTools } from "./bridge.ts"
import { McpClient, type McpHttpClientOptions, type McpStdioClientOptions } from "./client.ts"
import type { McpSignIns } from "./oauth.ts"

/**
 * MCP servers named in the behavior file, started for Runrail's own loop. A server that does not
 * start or list its tools is reported and left out; it never stops the session from opening.
 */

export type McpServerState = "ready" | "failed" | "off"

export interface McpServerStatus {
  readonly name: string
  readonly state: McpServerState
  readonly tools: number
  /** Stable code only; a server's own error text can carry paths or tokens. */
  readonly code?: string
}

export interface ConfiguredMcp {
  readonly tools: readonly NativeTool[]
  readonly status: readonly McpServerStatus[]
  close(): Promise<void>
}

export type McpConnect = (options: McpStdioClientOptions) => Promise<Pick<McpClient, "listTools" | "callTool" | "close" | "server">>
export type McpConnectHttp = (options: McpHttpClientOptions) => Promise<Pick<McpClient, "listTools" | "callTool" | "close" | "server">>

const CONNECT_TIMEOUT_MS = 20_000
// A tool call is a build or a browser run, not a handshake; this is the longest the client allows.
const CALL_TIMEOUT_MS = 120_000

export const NO_CONFIGURED_MCP: ConfiguredMcp = Object.freeze({ tools: Object.freeze([]), status: Object.freeze([]), close: async () => undefined })

export async function connectConfiguredMcp(
  servers: readonly BehaviorMcpServer[],
  cwd: string,
  connect: McpConnect = (options) => McpClient.connect(options),
  connectHttp: McpConnectHttp = (options) => McpClient.connectHttp(options),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  signIns?: McpSignIns,
): Promise<ConfiguredMcp> {
  if (servers.length === 0) return NO_CONFIGURED_MCP
  const clients: Pick<McpClient, "close">[] = []
  const results = await Promise.all(servers.map(async (server): Promise<{ readonly status: McpServerStatus; readonly tools: readonly NativeTool[] }> => {
    if (!server.enabled) return { status: Object.freeze({ name: server.name, state: "off", tools: 0 }), tools: [] }
    let client: Awaited<ReturnType<McpConnect>> | undefined
    try {
      if (server.transport === "http") {
        const token = server.bearerEnv === undefined ? undefined : environment[server.bearerEnv]
        if (server.bearerEnv !== undefined && (token === undefined || token.length === 0)) return { status: Object.freeze({ name: server.name, state: "failed", tools: 0, code: "MCP_TOKEN_MISSING" }), tools: [] }
        // A token named in the environment wins over a sign-in; the person set it on purpose.
        const signedIn = token === undefined && signIns !== undefined && (await signIns.stored(server.url))
        const url = server.url
        // The address was confirmed by the person who added the server, so a remote one is allowed.
        client = await connectHttp({
          url,
          allowRemote: true,
          timeoutMs: CONNECT_TIMEOUT_MS,
          callTimeoutMs: CALL_TIMEOUT_MS,
          ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
          ...(signedIn ? { authorization: (signal: AbortSignal) => signIns!.token(url, signal) } : {}),
        })
      } else {
        client = await connect({ command: server.command, args: server.args, cwd, inherit: server.env, timeoutMs: CONNECT_TIMEOUT_MS, callTimeoutMs: CALL_TIMEOUT_MS })
      }
      // The configured name, not the one the server reports, so two servers can never claim one name.
      const tools = await createMcpNativeTools(client as McpClient, { namespace: server.name, ...(server.readOnlyTools === undefined ? {} : { readOnlyTools: server.readOnlyTools }) })
      clients.push(client)
      return { status: Object.freeze({ name: server.name, state: "ready", tools: tools.length }), tools }
    } catch (error) {
      await client?.close().catch(() => undefined)
      const code = codeOf(error)
      // A refused request to a server with no token named for it is one a sign-in can fix.
      const shown = code === "MCP_UNAUTHORIZED" && server.transport === "http" ? (server.bearerEnv === undefined ? "MCP_SIGN_IN_REQUIRED" : "MCP_TOKEN_REJECTED") : code
      return { status: Object.freeze({ name: server.name, state: "failed", tools: 0, code: shown }), tools: [] }
    }
  }))
  return Object.freeze({
    tools: Object.freeze(results.flatMap((result) => result.tools)),
    status: Object.freeze(results.map((result) => result.status)),
    close: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
    },
  })
}

function codeOf(error: unknown): string {
  const code = error !== null && typeof error === "object" && "code" in error ? (error as { readonly code?: unknown }).code : undefined
  return typeof code === "string" && /^MCP_[A-Z_]{1,60}$/.test(code) ? code : "MCP_START_FAILED"
}

/**
 * The servers' tools as this thread's role may use them: Off leaves a server out, Read keeps
 * the tools admitted by the person's readOnlyTools list, Ask makes every tool ask.
 */
export function grantConfiguredMcp(configured: ConfiguredMcp, grants: IntegrationGrants | undefined): ConfiguredMcp {
  if (grants === undefined) return configured
  const serverOf = (tool: NativeTool): string => tool.name.slice(0, tool.name.indexOf("."))
  const tools = configured.tools.flatMap((tool): NativeTool[] => {
    const grant = grantOf(grants, mcpGrantKey(serverOf(tool)))
    if (grant === "off" || (grant === "read" && tool.requiresApproval === true)) return []
    return grant === "ask" ? [Object.freeze({ ...tool, requiresApproval: true })] : [tool]
  })
  const status = configured.status.map((entry) => (entry.state === "ready" && grantOf(grants, mcpGrantKey(entry.name)) === "off" ? Object.freeze({ name: entry.name, state: "off" as const, tools: 0 }) : entry))
  return Object.freeze({ tools: Object.freeze(tools), status: Object.freeze(status), close: configured.close })
}
