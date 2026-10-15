import type { JsonRpcRequest, McpServer } from "@nifrajs/mcp"
import { rpcError } from "@nifrajs/mcp"
import { createWorkspacePolicy } from "../workspace/policy.ts"
import { createRunrailWorkspaceMcpServer } from "./server.ts"
import { McpProtocolError, isMcpRequestMessage, parseMcpJsonRpcMessage } from "./protocol.ts"

export interface McpStdioServerOptions {
  readonly maxMessageBytes?: number
}

/** Run one MCP server over bounded newline-delimited stdin/stdout. */
export async function runMcpStdioServer(server: McpServer, options: McpStdioServerOptions = {}): Promise<void> {
  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 16 * 1024 * 1024) throw new McpProtocolError("MCP_INVALID", "MCP message limit is invalid")
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of process.stdin) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    buffer += text
    if (Buffer.byteLength(buffer, "utf8") > maxMessageBytes && !buffer.includes("\n")) throw new McpProtocolError("MCP_MESSAGE_LIMIT", "MCP input exceeds its byte limit")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line, "utf8") > maxMessageBytes) throw new McpProtocolError("MCP_MESSAGE_LIMIT", "MCP input message exceeds its byte limit")
      if (line.trim().length > 0) await dispatchLine(server, line, maxMessageBytes)
    }
  }
  buffer += decoder.decode()
  if (Buffer.byteLength(buffer, "utf8") > maxMessageBytes) throw new McpProtocolError("MCP_MESSAGE_LIMIT", "MCP input message exceeds its byte limit")
  if (buffer.trim().length > 0) await dispatchLine(server, buffer.trim(), maxMessageBytes)
}

export async function runRunrailMcpServer(
  options: McpStdioServerOptions & { readonly cwd: string },
): Promise<void> {
  const policy = await createWorkspacePolicy(options.cwd)
  const server = createRunrailWorkspaceMcpServer(policy)
  await runMcpStdioServer(server, { ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }) })
}

async function dispatchLine(server: McpServer, line: string, maxMessageBytes: number): Promise<void> {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
    const message = parseMcpJsonRpcMessage(value, maxMessageBytes)
    if (!isMcpRequestMessage(message)) return
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: message.method,
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.params === undefined ? {} : { params: message.params }),
    }
    const response = await server.handle(request)
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`)
  } catch (error) {
    const id = isRecord(value) && isRpcId(value.id) ? value.id : null
    const response = rpcError(id, -32600, error instanceof McpProtocolError ? error.code : "invalid request")
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A request's own id, echoed in its error reply so the client can match the two. */
function isRpcId(id: unknown): id is string | number | null {
  return id === null || (typeof id === "string" && id.length > 0 && id.length <= 256) || (typeof id === "number" && Number.isSafeInteger(id))
}
