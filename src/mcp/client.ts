import { RUNRAIL_VERSION } from "../version.ts"
import {
  assertJsonSize,
  isRecord,
  McpProtocolError,
  parseMcpJsonRpcMessage,
  type McpJsonRpcResponse,
  type McpPromptDescriptor,
  type McpPromptGetResult,
  type McpRequestId,
  type McpResourceDescriptor,
  type McpResourceReadResult,
  type McpServerInfo,
  type McpToolCallResult,
  type McpToolDescriptor,
  isMcpRequestMessage,
} from "./protocol.ts"
import { McpStdioTransport, McpTransportError, type McpStdioTransportOptions, type McpTransport } from "./transport.ts"
import { McpHttpTransport, type McpHttpTransportOptions } from "./http.ts"

export interface McpClientOptions {
  readonly clientName?: string
  readonly clientVersion?: string
  readonly protocolVersion?: string
  /** Bounds the handshake and listings. */
  readonly timeoutMs?: number
  /** Bounds one `tools/call`, which can run far longer than a listing. Defaults to `timeoutMs`. */
  readonly callTimeoutMs?: number
  readonly maxMessageBytes?: number
  readonly maxTools?: number
  readonly maxResources?: number
  readonly maxPrompts?: number
}

export interface McpStdioClientOptions extends McpStdioTransportOptions, McpClientOptions {}
export interface McpHttpClientOptions extends McpHttpTransportOptions, McpClientOptions {}

export type McpClientErrorCode = "MCP_CLIENT_INVALID" | "MCP_CLIENT_TIMEOUT" | "MCP_CLIENT_CANCELLED" | "MCP_CLIENT_CLOSED" | "MCP_REMOTE_ERROR" | "MCP_RESPONSE_INVALID"

export class McpClientError extends Error {
  constructor(readonly code: McpClientErrorCode, reason: string) {
    super(`MCP client: ${reason}`)
    this.name = "McpClientError"
  }
}

/** Protocol client with bounded request correlation and no transcript or payload storage. */
export class McpClient {
  get serverInfo(): McpServerInfo | undefined {
    return this.serverInfoValue
  }
  get serverCapabilities(): Readonly<Record<string, unknown>> | undefined {
    return this.serverCapabilitiesValue
  }
  private readonly options: Required<Pick<McpClientOptions, "clientName" | "clientVersion" | "protocolVersion" | "timeoutMs" | "maxMessageBytes" | "maxTools" | "maxResources" | "maxPrompts">>
  private readonly callTimeoutMs: number
  private readonly pending = new Map<McpRequestId, { readonly resolve: (response: McpJsonRpcResponse) => void; readonly reject: (error: unknown) => void; readonly timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1
  private reader: Promise<void> | undefined
  private closed = false
  private terminalError: McpClientError | McpTransportError | undefined
  private initialized = false
  private serverInfoValue: McpServerInfo | undefined
  private serverCapabilitiesValue: Readonly<Record<string, unknown>> | undefined

  constructor(private readonly transport: McpTransport, options: McpClientOptions = {}) {
    validateOptions(options)
    this.options = {
      clientName: options.clientName ?? "runrail",
      clientVersion: options.clientVersion ?? RUNRAIL_VERSION,
      protocolVersion: options.protocolVersion ?? "2025-06-18",
      timeoutMs: options.timeoutMs ?? 30_000,
      maxMessageBytes: options.maxMessageBytes ?? 1_048_576,
      maxTools: options.maxTools ?? 256,
      maxResources: options.maxResources ?? 256,
      maxPrompts: options.maxPrompts ?? 256,
    }
    this.callTimeoutMs = options.callTimeoutMs ?? this.options.timeoutMs
  }

  static async connect(options: McpStdioClientOptions): Promise<McpClient> {
    const { command, args, cwd, env, inherit, maxMessageBytes, clientName, clientVersion, protocolVersion, timeoutMs, callTimeoutMs, maxTools, maxResources, maxPrompts } = options
    const transport = new McpStdioTransport({ command, args, cwd, env, inherit, maxMessageBytes })
    const client = new McpClient(transport, { clientName, clientVersion, protocolVersion, timeoutMs, callTimeoutMs, maxMessageBytes, maxTools, maxResources, maxPrompts })
    try {
      await client.initialize()
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }
  static async connectHttp(options: McpHttpClientOptions): Promise<McpClient> {
    const { url, headers, authorization, allowRemote, timeoutMs, callTimeoutMs, maxMessageBytes, clientName, clientVersion, protocolVersion, maxTools, maxResources, maxPrompts } = options
    // The transport bounds a whole POST, which carries a tool call's result, so it takes the longer limit.
    const transport = new McpHttpTransport({ url, headers, authorization, allowRemote, timeoutMs: callTimeoutMs ?? timeoutMs, maxMessageBytes })
    const client = new McpClient(transport, { clientName, clientVersion, protocolVersion, timeoutMs, callTimeoutMs, maxMessageBytes, maxTools, maxResources, maxPrompts })
    try {
      await client.initialize()
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  get server(): McpServerInfo | undefined {
    return this.serverInfoValue
  }

  get capabilities(): Readonly<Record<string, unknown>> | undefined {
    return this.serverCapabilitiesValue
  }

  async initialize(): Promise<McpServerInfo> {
    if (this.initialized) return this.serverInfoValue!
    this.ensureOpen()
    this.startReader()
    const result = await this.request("initialize", {
      protocolVersion: this.options.protocolVersion,
      capabilities: {},
      clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
    })
    if (!isRecord(result) || typeof result.protocolVersion !== "string" || !isRecord(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string")
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP initialize response is invalid")
    if (result.protocolVersion.length === 0 || result.protocolVersion.length > 64 || result.serverInfo.name.length === 0 || result.serverInfo.name.length > 128 || result.serverInfo.version.length === 0 || result.serverInfo.version.length > 64)
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP server metadata is invalid")
    this.serverInfoValue = Object.freeze({ name: result.serverInfo.name, version: result.serverInfo.version })
    this.serverCapabilitiesValue = result.capabilities === undefined ? undefined : parseRecord(result.capabilities, "MCP server capabilities")
    await this.notify("notifications/initialized", {})
    this.initialized = true
    return this.serverInfoValue
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    this.ensureInitialized()
    const result = await this.request("tools/list", {})
    if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.length > this.options.maxTools)
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP tool list is invalid")
    // One oddly named tool must not take the whole server with it.
    return Object.freeze(result.tools.flatMap((tool) => (isRecord(tool) && validName(tool.name) ? [parseTool(tool)] : [])))
  }

  async callTool(name: string, input: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<McpToolCallResult> {
    this.ensureInitialized()
    if (!validName(name)) throw new McpClientError("MCP_CLIENT_INVALID", "MCP tool name is invalid")
    if (!isRecord(input)) throw new McpClientError("MCP_CLIENT_INVALID", "MCP tool arguments are invalid")
    const result = await this.request("tools/call", { name, arguments: input }, signal, this.callTimeoutMs)
    return parseToolResult(result)
  }

  async listResources(): Promise<readonly McpResourceDescriptor[]> {
    this.ensureInitialized()
    const result = await this.request("resources/list", {})
    if (!isRecord(result) || !Array.isArray(result.resources) || result.resources.length > this.options.maxResources)
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP resource list is invalid")
    return Object.freeze(result.resources.map((resource) => parseResource(resource)))
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    this.ensureInitialized()
    if (typeof uri !== "string" || uri.length === 0 || uri.length > 2_048) throw new McpClientError("MCP_CLIENT_INVALID", "MCP resource URI is invalid")
    const result = await this.request("resources/read", { uri })
    if (!isRecord(result) || !Array.isArray(result.contents) || result.contents.length > 32)
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP resource response is invalid")
    return Object.freeze({ contents: Object.freeze(result.contents.map((content) => parseResourceContent(content))) })
  }

  async listPrompts(): Promise<readonly McpPromptDescriptor[]> {
    this.ensureInitialized()
    const result = await this.request("prompts/list", {})
    if (!isRecord(result) || !Array.isArray(result.prompts) || result.prompts.length > this.options.maxPrompts)
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP prompt list is invalid")
    return Object.freeze(result.prompts.map((prompt) => parsePrompt(prompt)))
  }

  async getPrompt(name: string, args: Readonly<Record<string, string>> = {}): Promise<McpPromptGetResult> {
    this.ensureInitialized()
    if (!validName(name)) throw new McpClientError("MCP_CLIENT_INVALID", "MCP prompt name is invalid")
    if (!isRecord(args) || Object.keys(args).length > 64 || Object.entries(args).some(([key, value]) => !validName(key) || typeof value !== "string" || value.length > 16 * 1024))
      throw new McpClientError("MCP_CLIENT_INVALID", "MCP prompt arguments are invalid")
    const result = await this.request("prompts/get", { name, arguments: args })
    if (!isRecord(result) || !Array.isArray(result.messages) || result.messages.length > 64)
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP prompt response is invalid")
    return Object.freeze({
      ...(result.description === undefined ? {} : { description: boundedString(result.description, "MCP prompt description", 16 * 1024) }),
      messages: Object.freeze(result.messages.map(parsePromptMessage)),
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const error = new McpClientError("MCP_CLIENT_CLOSED", "MCP client is closed")
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    await this.transport.close()
    await this.reader?.catch(() => undefined)
  }

  private async request(method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal, timeoutMs: number = this.options.timeoutMs): Promise<unknown> {
    try {
      return await this.requestOnce(method, params, signal, timeoutMs)
    } catch (error) {
      // The server dropped the session without running the request, so a new session and one retry is safe.
      if (!(error instanceof McpTransportError) || error.code !== "MCP_SESSION_EXPIRED" || method === "initialize") throw error
      this.initialized = false
      await this.initialize()
      return this.requestOnce(method, params, signal, timeoutMs)
    }
  }

  private async requestOnce(method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    this.ensureOpen()
    if (signal?.aborted) throw new McpClientError("MCP_CLIENT_CANCELLED", "MCP request was cancelled")
    const id = this.nextId++
    if (!Number.isSafeInteger(id)) throw new McpClientError("MCP_CLIENT_INVALID", "MCP request id exhausted")
    const request = { jsonrpc: "2.0", id, method, params }
    assertJsonSize(request, this.options.maxMessageBytes)
    let onAbort: (() => void) | undefined
    const response = await new Promise<McpJsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpClientError("MCP_CLIENT_TIMEOUT", "MCP request timed out"))
      }, timeoutMs)
      const rejectRequest = (error: unknown): void => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      onAbort = () => {
        rejectRequest(new McpClientError("MCP_CLIENT_CANCELLED", "MCP request was cancelled"))
        void this.transport.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })).catch(() => undefined)
      }
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, { resolve, reject, timer })
      void this.transport.send(JSON.stringify(request)).catch((error: unknown) => rejectRequest(error))
    }).finally(() => {
      if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort)
    })
    if (response.error !== undefined) throw new McpClientError("MCP_REMOTE_ERROR", `remote error ${response.error.code}`)
    return response.result
  }

  private async notify(method: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    this.ensureOpen()
    assertJsonSize({ jsonrpc: "2.0", method, params }, this.options.maxMessageBytes)
    await this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
  }

  private startReader(): void {
    if (this.reader !== undefined) return
    this.reader = (async () => {
      try {
        let junk = 0
        for await (const line of this.transport.receive()) {
          // A server that logs to stdout by mistake still works; only a stream of nothing but noise ends it.
          let message: ReturnType<typeof parseMcpJsonRpcMessage>
          try {
            message = parseMcpJsonRpcMessage(parseJson(line), this.options.maxMessageBytes)
          } catch (error) {
            junk += 1
            if (junk > 1_000) throw error
            continue
          }
          if (isMcpRequestMessage(message)) {
            if ("id" in message && message.id !== undefined && message.id !== null) void this.answerServer(message.id, message.method)
            continue
          }
          if (message.id !== null) {
            const pending = this.pending.get(message.id)
            if (pending === undefined) continue
            this.pending.delete(message.id)
            clearTimeout(pending.timer)
            pending.resolve(message)
          }
        }
        if (!this.closed) throw new McpClientError("MCP_CLIENT_CLOSED", "MCP server closed the transport")
      } catch (error) {
        // A refused credential keeps its code: the person can fix it by signing in.
        const normalized = error instanceof McpClientError || (error instanceof McpTransportError && error.code === "MCP_UNAUTHORIZED") ? error : new McpClientError("MCP_RESPONSE_INVALID", "MCP transport ended")
        if (!this.closed) this.terminalError = normalized
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer)
          entry.reject(normalized)
        }
        this.pending.clear()
      }
    })()
  }

  /** A server may ping, or ask for something this client does not offer; either way it gets an answer rather than a hang. */
  private async answerServer(id: string | number, method: string): Promise<void> {
    const reply = method === "ping" ? { jsonrpc: "2.0", id, result: {} } : { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }
    await this.transport.send(JSON.stringify(reply)).catch(() => undefined)
  }

  private ensureOpen(): void {
    if (this.closed) throw new McpClientError("MCP_CLIENT_CLOSED", "MCP client is closed")
    if (this.terminalError !== undefined) throw this.terminalError

  }
  private ensureInitialized(): void {
    this.ensureOpen()
    if (!this.initialized) throw new McpClientError("MCP_CLIENT_INVALID", "MCP client is not initialized")
  }
}

function validateOptions(options: McpClientOptions): void {
  if (options === null || typeof options !== "object") throw new McpClientError("MCP_CLIENT_INVALID", "MCP options are invalid")
  for (const [name, value] of [["timeoutMs", options.timeoutMs], ["callTimeoutMs", options.callTimeoutMs], ["maxMessageBytes", options.maxMessageBytes], ["maxTools", options.maxTools], ["maxResources", options.maxResources], ["maxPrompts", options.maxPrompts]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > (name === "maxMessageBytes" ? 16 * 1024 * 1024 : name === "timeoutMs" || name === "callTimeoutMs" ? 120_000 : 4_096)))
      throw new McpClientError("MCP_CLIENT_INVALID", `${name} is invalid`)
  }
}

function parseJson(line: string): unknown {
  if (typeof line !== "string" || line.length === 0) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP response line is invalid")
  try {
    return JSON.parse(line) as unknown
  } catch {
    throw new McpClientError("MCP_RESPONSE_INVALID", "MCP response is not JSON")
  }
}

function parseTool(value: unknown): McpToolDescriptor {
  if (!isRecord(value) || !validName(value.name)) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP tool descriptor is invalid")
  return Object.freeze({
    name: value.name,
    ...(value.description === undefined ? {} : { description: boundedString(value.description, "MCP tool description", 16 * 1024) }),
    ...(value.inputSchema === undefined ? {} : { inputSchema: parseRecord(value.inputSchema, "MCP tool schema") }),
    ...(value.annotations === undefined ? {} : { annotations: parseAnnotations(value.annotations) }),
  })
}

function parseAnnotations(value: unknown) {
  if (!isRecord(value)) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP tool annotations are invalid")
  const result: Record<string, boolean | string> = {}
  for (const key of ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    const item = value[key]
    if (item === undefined) continue
    if (key === "title") {
      result[key] = boundedString(item, "MCP annotation title", 512)
    } else if (typeof item !== "boolean") {
      throw new McpClientError("MCP_RESPONSE_INVALID", "MCP tool annotation flag is invalid")
    } else result[key] = item
  }
  return Object.freeze(result) as McpToolDescriptor["annotations"]
}

function parseResource(value: unknown): McpResourceDescriptor {
  if (!isRecord(value) || typeof value.uri !== "string" || value.uri.length === 0 || value.uri.length > 2_048 || typeof value.name !== "string" || value.name.length === 0 || value.name.length > 256)
    throw new McpClientError("MCP_RESPONSE_INVALID", "MCP resource descriptor is invalid")
  return Object.freeze({ uri: value.uri, name: value.name, ...(value.description === undefined ? {} : { description: boundedString(value.description, "MCP resource description", 16 * 1024) }), ...(value.mimeType === undefined ? {} : { mimeType: boundedString(value.mimeType, "MCP resource media type", 256) }) })
}

function parseResourceContent(value: unknown): McpResourceReadResult["contents"][number] {
  if (!isRecord(value) || typeof value.uri !== "string" || value.uri.length === 0 || value.uri.length > 2_048)
    throw new McpClientError("MCP_RESPONSE_INVALID", "MCP resource content is invalid")
  if (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 256 * 1024)) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP resource text is invalid")
  if (value.blob !== undefined && (typeof value.blob !== "string" || value.blob.length > 4 * 1024 * 1024)) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP resource binary content is invalid")
  if (value.text === undefined && value.blob === undefined) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP resource content is empty")
  return Object.freeze({ uri: value.uri, ...(value.mimeType === undefined ? {} : { mimeType: boundedString(value.mimeType, "MCP resource media type", 256) }), ...(value.text === undefined ? {} : { text: value.text }), ...(value.blob === undefined ? {} : { blob: value.blob }) })
}

function parsePrompt(value: unknown): McpPromptDescriptor {
  if (!isRecord(value) || !validName(value.name)) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP prompt descriptor is invalid")
  if (value.arguments !== undefined && (!Array.isArray(value.arguments) || value.arguments.length > 64)) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP prompt arguments are invalid")
  return Object.freeze({ name: value.name, ...(value.description === undefined ? {} : { description: boundedString(value.description, "MCP prompt description", 16 * 1024) }), ...(value.arguments === undefined ? {} : { arguments: Object.freeze(value.arguments.map(parsePromptArgument)) }) })
}

function parsePromptArgument(value: unknown): NonNullable<McpPromptDescriptor["arguments"]>[number] {
  if (!isRecord(value) || !validName(value.name) || (value.description !== undefined && typeof value.description !== "string") || (value.required !== undefined && typeof value.required !== "boolean")) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP prompt argument is invalid")
  return Object.freeze({ name: value.name, ...(value.description === undefined ? {} : { description: boundedString(value.description, "MCP prompt argument description", 16 * 1024) }), ...(value.required === undefined ? {} : { required: value.required }) })
}

function parseToolResult(value: unknown): McpToolCallResult {
  if (!isRecord(value) || (value.isError !== undefined && typeof value.isError !== "boolean")) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP tool result is invalid")
  if (value.content !== undefined && (!Array.isArray(value.content) || value.content.length > 256)) throw new McpClientError("MCP_RESPONSE_INVALID", "MCP tool content is invalid")
  const content = value.content === undefined ? undefined : Object.freeze(value.content.map(parseContentBlock))
  const structuredContent = value.structuredContent === undefined ? undefined : parseRecord(value.structuredContent, "MCP structured tool content")
  return Object.freeze({ ...(content === undefined ? {} : { content }), ...(structuredContent === undefined ? {} : { structuredContent }), ...(value.isError === undefined ? {} : { isError: value.isError }) })
}

function parseContentBlock(value: unknown): NonNullable<McpToolCallResult["content"]>[number] {
  if (!isRecord(value) || typeof value.type !== "string") throw new McpClientError("MCP_RESPONSE_INVALID", "MCP content block is invalid")
  // The tool has already run, so a block this client cannot show is noted in the text, not refused:
  // refusing would report a finished side effect as a failure and invite a retry.
  if (value.type === "text") {
    if (typeof value.text !== "string") throw new McpClientError("MCP_RESPONSE_INVALID", "MCP text content is invalid")
    return Object.freeze({ type: "text", text: value.text.length > MAX_TEXT_BLOCK ? `${value.text.slice(0, MAX_TEXT_BLOCK)}\n[text cut at ${MAX_TEXT_BLOCK} characters]` : value.text })
  }
  if (value.type === "image") {
    if (typeof value.data === "string" && typeof value.mimeType === "string" && value.data.length <= 4 * 1024 * 1024) return Object.freeze({ type: "image", data: value.data, mimeType: value.mimeType })
    return omittedBlock("image too large or malformed")
  }
  if (value.type === "resource" && isRecord(value.resource) && typeof value.resource.text === "string") return Object.freeze({ type: "text", text: value.resource.text.slice(0, MAX_TEXT_BLOCK) })
  if (value.type === "resource_link" && typeof value.uri === "string") return omittedBlock(`resource link ${value.uri.slice(0, 256)}`)
  return omittedBlock(`${value.type.slice(0, 32)} content`)
}

const MAX_TEXT_BLOCK = 256 * 1024

function omittedBlock(what: string): NonNullable<McpToolCallResult["content"]>[number] {
  return Object.freeze({ type: "text", text: `[${what} not shown]` })
}

function parsePromptMessage(value: unknown): NonNullable<McpPromptGetResult["messages"]>[number] {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant") || !isRecord(value.content) || value.content.type !== "text") throw new McpClientError("MCP_RESPONSE_INVALID", "MCP prompt message is invalid")
  return Object.freeze({ role: value.role, content: Object.freeze({ type: "text", text: boundedContent(value.content.text, "MCP prompt message", 256 * 1024) }) })
}

function parseRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length > 256) throw new McpClientError("MCP_RESPONSE_INVALID", `${name} is invalid`)
  return Object.freeze({ ...value })
}

/** Content may be empty, as a tool with nothing to say returns; names and ids may not. */
function boundedContent(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new McpClientError("MCP_RESPONSE_INVALID", `${name} is invalid`)
  return value
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new McpClientError("MCP_RESPONSE_INVALID", `${name} is invalid`)
  return value
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

export function isMcpClientError(value: unknown): value is McpClientError {
  return value instanceof McpClientError
}
