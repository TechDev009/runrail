import { RUNRAIL_VERSION } from "../version.ts"
import { createMcpServer, type JsonRpcRequest, type McpPrompt, type McpResource, type McpServer, type McpTool } from "@nifrajs/mcp"
import type { NativeTool } from "@nifrajs/coding-agent"
import { createToolCatalog } from "../tools/catalog.ts"
import type { WorkspacePolicy } from "../workspace/policy.ts"
import { toolInputSchema } from "../tools/schemas.ts"
import { type McpToolAnnotations } from "./protocol.ts"

export interface RunrailMcpServerOptions {
  readonly name?: string
  readonly version?: string
  readonly cwd: string
  readonly tools?: readonly NativeTool[]
  readonly resources?: readonly McpResource[]
  readonly prompts?: readonly McpPrompt[]
  readonly instructions?: string
  readonly maxResultBytes?: number
  readonly approve?: (input: { readonly tool: NativeTool; readonly args: Readonly<Record<string, unknown>>; readonly signal: AbortSignal }) => boolean | PromiseLike<boolean>
  readonly authorizeMessage?: (message: JsonRpcRequest, request: Request) => boolean | PromiseLike<boolean>
}

export type RunrailMcpServerErrorCode = "MCP_SERVER_INVALID" | "MCP_SERVER_LIMIT"

export class RunrailMcpServerError extends Error {
  constructor(readonly code: RunrailMcpServerErrorCode, reason: string) {
    super(`Runrail MCP server: ${reason}`)
    this.name = "RunrailMcpServerError"
  }
}

/** Expose explicitly supplied Runrail tools through the public MCP server contract. */
export function createRunrailMcpServer(options: RunrailMcpServerOptions): McpServer {
  validateOptions(options)
  const maxResultBytes = options.maxResultBytes ?? 256 * 1024
  const tools = Object.freeze((options.tools ?? []).map((tool) => toMcpTool(tool, options, maxResultBytes)))
  return createMcpServer({
    name: options.name ?? "runrail",
    version: options.version ?? RUNRAIL_VERSION,
    tools,
    ...(options.resources === undefined ? {} : { resources: options.resources }),
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.authorizeMessage === undefined ? {} : { authorizeMessage: async (message: JsonRpcRequest, request: Request) => await options.authorizeMessage!(message, request) }),
    maxBodyBytes: maxResultBytes,
  })
}

/** Build a local MCP server from the same bounded workspace tool catalog used by native sessions. */
export function createRunrailWorkspaceMcpServer(
  policy: WorkspacePolicy,
  options: Omit<RunrailMcpServerOptions, "cwd" | "tools"> = {},
): McpServer {
  return createRunrailMcpServer({
    ...options,
    cwd: policy.root,
    tools: createToolCatalog(policy),
  })
}

function toMcpTool(tool: NativeTool, options: RunrailMcpServerOptions, maxResultBytes: number): McpTool {
  const annotations: McpToolAnnotations = Object.freeze({
    readOnlyHint: tool.requiresApproval === undefined || tool.requiresApproval === false,
    destructiveHint: tool.requiresApproval === true,
  })
  return {
    name: tool.name,
    description: tool.description.slice(0, 64 * 1024),
    inputSchema: toolInputSchema(tool.name),
    annotations,
    handler: async (args, context) => {
      try {
        const requiresApproval = typeof tool.requiresApproval === "function" ? await tool.requiresApproval(args) : tool.requiresApproval === true
        if (requiresApproval) {
          const approved = options.approve === undefined ? false : await options.approve({ tool, args, signal: context.signal })
          if (!approved) return { content: [{ type: "text", text: "approval required" }], isError: true }
        }
        const value = await tool.execute(args, { cwd: options.cwd, signal: context.signal })
        const text = serializeToolResult(value, maxResultBytes)
        return { content: [{ type: "text", text }] }
      } catch {
        return { content: [{ type: "text", text: "tool execution failed" }], isError: true }
      }
    },
  }
}

function serializeToolResult(value: unknown, maxBytes: number): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text, "utf8") > maxBytes) throw new RunrailMcpServerError("MCP_SERVER_LIMIT", "tool result exceeds its byte limit")
  return text
}

function validateOptions(options: RunrailMcpServerOptions): void {
  if (options === null || typeof options !== "object" || typeof options.cwd !== "string" || options.cwd.length === 0 || options.cwd.length > 4_096)
    throw new RunrailMcpServerError("MCP_SERVER_INVALID", "server options are invalid")
  for (const [name, value] of [["name", options.name], ["version", options.version]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)))
      throw new RunrailMcpServerError("MCP_SERVER_INVALID", `${name} is invalid`)
  }
  if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length > 256)) throw new RunrailMcpServerError("MCP_SERVER_LIMIT", "tool count exceeds its limit")
  if (options.maxResultBytes !== undefined && (!Number.isSafeInteger(options.maxResultBytes) || options.maxResultBytes < 1 || options.maxResultBytes > 4 * 1024 * 1024)) throw new RunrailMcpServerError("MCP_SERVER_INVALID", "result limit is invalid")
}
