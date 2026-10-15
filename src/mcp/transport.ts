import { filteredEnvironment } from "../workspace/policy.ts"
import { McpProtocolError } from "./protocol.ts"
import { terminateProcessTree } from "../backend/process-tree.ts"

export interface McpStdioTransportOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Only explicitly allowed process variables are forwarded. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Further variables of this process to forward, by name, such as a server's own access token. */
  readonly inherit?: readonly string[]
  readonly maxMessageBytes?: number
}

export interface McpTransport {
  send(message: string): Promise<void>
  receive(): AsyncIterable<string>
  close(): Promise<void>
}

export type McpTransportErrorCode = "MCP_TRANSPORT_INVALID" | "MCP_TRANSPORT_FAILED" | "MCP_MESSAGE_LIMIT"

export class McpTransportError extends Error {
  constructor(readonly code: McpTransportErrorCode, reason: string) {
    super(`MCP transport: ${reason}`)
    this.name = "McpTransportError"
  }
}

/** Newline-delimited JSON transport for an explicitly caller-owned local MCP process. */
export class McpStdioTransport implements McpTransport {
  private readonly maxMessageBytes: number
  private closed = false
  private readonly child: Bun.Subprocess<"pipe", "pipe", "ignore">

  constructor(private readonly options: McpStdioTransportOptions) {
    validateOptions(options)
    this.maxMessageBytes = options.maxMessageBytes ?? 1_048_576
    try {
      this.child = Bun.spawn([options.command, ...(options.args ?? [])], {
        cwd: options.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        // The configured values are the server's own settings (a token, a config path), so they are passed as given.
        env: { ...filteredEnvironment(options.env), ...inheritedEnvironment(options.inherit), ...configuredEnvironment(options.env) },
        // Its own process group, so closing the client also ends the helpers the server started.
        detached: true,
      })
    } catch (error) {
      throw new McpTransportError("MCP_TRANSPORT_FAILED", error instanceof Error ? error.message : "MCP process could not start")
    }
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new McpTransportError("MCP_TRANSPORT_FAILED", "transport is closed")
    if (typeof message !== "string" || message.length === 0 || Buffer.byteLength(message, "utf8") > this.maxMessageBytes)
      throw new McpTransportError("MCP_MESSAGE_LIMIT", "outgoing message exceeds its byte limit")
    try {
      await this.child.stdin.write(`${message}\n`)
    } catch (error) {
      throw new McpTransportError("MCP_TRANSPORT_FAILED", error instanceof Error ? error.message : "MCP message could not be written")
    }
  }

  async *receive(): AsyncIterable<string> {
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for await (const chunk of this.child.stdout) {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
        buffer += text
        if (Buffer.byteLength(buffer, "utf8") > this.maxMessageBytes && !buffer.includes("\n")) throw new McpTransportError("MCP_MESSAGE_LIMIT", "incoming MCP output exceeds its byte limit")
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          if (Buffer.byteLength(line, "utf8") > this.maxMessageBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "incoming MCP message exceeds its byte limit")
          if (line.trim().length > 0) yield line
        }
      }
      buffer += decoder.decode()
      if (Buffer.byteLength(buffer, "utf8") > this.maxMessageBytes) throw new McpTransportError("MCP_MESSAGE_LIMIT", "incoming MCP message exceeds its byte limit")
      if (buffer.trim().length > 0) yield buffer.trim()
      const status = await this.child.exited
      if (status !== 0 && !this.closed) throw new McpTransportError("MCP_TRANSPORT_FAILED", "MCP process exited unsuccessfully")
    } catch (error) {
      if (error instanceof McpTransportError) throw error
      throw new McpTransportError("MCP_TRANSPORT_FAILED", error instanceof Error ? error.message : "MCP output could not be read")
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.child.stdin.end()
    } catch {
      // The process may already have closed its input.
    }
    if (!this.child.killed) await terminateProcessTree(this.child)
    else await this.child.exited.catch(() => undefined)
  }
}

function validateOptions(options: McpStdioTransportOptions): void {
  if (options === null || typeof options !== "object" || typeof options.command !== "string" || options.command.length === 0 || options.command.length > 256 || /\s/.test(options.command) || options.command.startsWith("-"))
    throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP command is invalid")
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.length > 128 || options.args.some((arg) => typeof arg !== "string" || arg.length > 4_096)))
    throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP arguments are invalid")
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0 || options.cwd.length > 4_096))
    throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP working directory is invalid")
  if (options.maxMessageBytes !== undefined && (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes < 1 || options.maxMessageBytes > 16 * 1024 * 1024))
    throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP message limit is invalid")
  if (options.inherit !== undefined && (!Array.isArray(options.inherit) || options.inherit.length > 32 || options.inherit.some((name) => typeof name !== "string" || !ENVIRONMENT_NAME.test(name))))
    throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP inherited environment is invalid")
  if (options.env !== undefined) {
    if (options.env === null || typeof options.env !== "object" || Array.isArray(options.env)) throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP environment is invalid")
    for (const [name, value] of Object.entries(options.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || (value !== undefined && (typeof value !== "string" || value.length > 4_096)))
        throw new McpTransportError("MCP_TRANSPORT_INVALID", "MCP environment entry is invalid")
    }
  }
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function configuredEnvironment(values: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(values ?? {})) if (value !== undefined) result[name] = value
  return result
}

function inheritedEnvironment(names: readonly string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of names ?? []) {
    const value = process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

export function mcpTransportError(error: unknown): McpProtocolError {
  if (error instanceof McpProtocolError) return error
  return new McpProtocolError("MCP_TRANSPORT_FAILED", error instanceof Error ? error.message : "MCP transport failed")
}
