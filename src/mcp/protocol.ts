export type McpRequestId = string | number

export interface McpJsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: McpRequestId
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
}

export interface McpJsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly id?: never
  readonly params?: Readonly<Record<string, unknown>>
}

export interface McpJsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: McpRequestId | null
  readonly result?: unknown
  readonly error?: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
  readonly method?: never
  readonly params?: never
}

export type McpJsonRpcMessage = McpJsonRpcRequest | McpJsonRpcNotification | McpJsonRpcResponse

export interface McpToolAnnotations {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface McpToolDescriptor {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: Readonly<Record<string, unknown>>
  readonly annotations?: McpToolAnnotations
}

export interface McpResourceDescriptor {
  readonly uri: string
  readonly name: string
  readonly description?: string
  readonly mimeType?: string
}

export interface McpPromptArgument {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

export interface McpPromptDescriptor {
  readonly name: string
  readonly description?: string
  readonly arguments?: readonly McpPromptArgument[]
}

export interface McpTextContent {
  readonly type: "text"
  readonly text: string
}

export interface McpImageContent {
  readonly type: "image"
  readonly data: string
  readonly mimeType: string
}

export type McpContentBlock = McpTextContent | McpImageContent

export interface McpToolCallResult {
  readonly content?: readonly McpContentBlock[]
  readonly structuredContent?: Readonly<Record<string, unknown>>
  readonly isError?: boolean
}

export interface McpResourceContent {
  readonly uri: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
}

export interface McpResourceReadResult {
  readonly contents: readonly McpResourceContent[]
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant"
  readonly content: McpTextContent
}

export interface McpPromptGetResult {
  readonly description?: string
  readonly messages: readonly McpPromptMessage[]
}

export interface McpServerInfo {
  readonly name: string
  readonly version: string
}

export type McpProtocolErrorCode =
  | "MCP_INVALID"
  | "MCP_MESSAGE_LIMIT"
  | "MCP_REMOTE_ERROR"
  | "MCP_TRANSPORT_FAILED"
  | "MCP_TIMEOUT"
  | "MCP_CANCELLED"
  | "MCP_TOOL_FAILED"

export class McpProtocolError extends Error {
  constructor(readonly code: McpProtocolErrorCode, reason: string) {
    super(`MCP: ${reason}`)
    this.name = "McpProtocolError"
  }
}

export function parseMcpJsonRpcMessage(value: unknown, maxBytes = 1_048_576): McpJsonRpcMessage {
  assertJsonSize(value, maxBytes)
  if (!isRecord(value) || value.jsonrpc !== "2.0") throw new McpProtocolError("MCP_INVALID", "JSON-RPC message is invalid")
  if (typeof value.method === "string") {
    if (!validMethod(value.method)) throw new McpProtocolError("MCP_INVALID", "JSON-RPC method is invalid")
    if (value.id !== undefined && !validRequestId(value.id)) throw new McpProtocolError("MCP_INVALID", "JSON-RPC request id is invalid")
    if (value.params !== undefined && !isRecord(value.params)) throw new McpProtocolError("MCP_INVALID", "JSON-RPC parameters are invalid")
    return Object.freeze({
      jsonrpc: "2.0",
      ...(value.id === undefined ? {} : { id: value.id }),
      method: value.method,
      ...(value.params === undefined ? {} : { params: Object.freeze({ ...value.params }) }),
    })
  }
  if (!validId(value.id)) throw new McpProtocolError("MCP_INVALID", "JSON-RPC response id is invalid")
  const hasResult = Object.hasOwn(value, "result")
  const hasError = Object.hasOwn(value, "error")
  if (hasResult === hasError) throw new McpProtocolError("MCP_INVALID", "JSON-RPC response shape is invalid")
  if (hasError) return Object.freeze({ jsonrpc: "2.0", id: value.id, error: parseRpcError(value.error) })
  return Object.freeze({ jsonrpc: "2.0", id: value.id, result: value.result })
}

export function parseMcpJsonRpcResponse(value: unknown, maxBytes = 1_048_576): McpJsonRpcResponse {
  const message = parseMcpJsonRpcMessage(value, maxBytes)
  if (isMcpRequestMessage(message)) throw new McpProtocolError("MCP_INVALID", "expected a JSON-RPC response")
  return message
}

export function isMcpRequestMessage(value: McpJsonRpcMessage): value is McpJsonRpcRequest | McpJsonRpcNotification {
  return typeof value.method === "string"
}

function validRequestId(value: unknown): value is McpRequestId {
  return value !== null && validId(value)
}

export function assertJsonSize(value: unknown, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw new McpProtocolError("MCP_INVALID", "message limit is invalid")
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new McpProtocolError("MCP_INVALID", "message is not serializable")
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes)
    throw new McpProtocolError("MCP_MESSAGE_LIMIT", "message exceeds its byte limit")
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function validId(value: unknown): value is McpRequestId | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 256) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
}

export function validMethod(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(value)
}

function parseRpcError(value: unknown): NonNullable<McpJsonRpcResponse["error"]> {
  if (!isRecord(value) || typeof value.code !== "number" || !Number.isSafeInteger(value.code) || typeof value.message !== "string" || value.message.length > 512)
    throw new McpProtocolError("MCP_INVALID", "JSON-RPC error is invalid")
  return Object.freeze({ code: value.code, message: value.message, ...(value.data === undefined ? {} : { data: value.data }) })
}
