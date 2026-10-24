import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { ISOLATED_BUN_FLAGS } from "../isolated-bun.ts"
import { RUNRAIL_VERSION } from "../version.ts"

/**
 * Tools the engine serves to Claude Code, which takes extra tools only as MCP servers. Claude Code
 * starts this program again as a small stdio server (`runrail browser-mcp`, `runrail
 * connectors-mcp`); each call goes to one of the engine's own paths, authorized by a token that
 * opens that path and nothing else. The engine's address and token sit in a file only this user can
 * read, never on a command line.
 */

const PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"]
const MAX_LINE_BYTES = 1_048_576
const MAX_ENDPOINT_FILE_BYTES = 4_096
const MAX_MCP_CONFIG_CHARS = 4_096
const TOKEN = /^[0-9a-f]{64}$/

export interface McpEndpoint {
  readonly file: string
  /** One `--mcp-config` document that starts this server. */
  readonly mcpConfig: string
  publish(url: string, token: string): Promise<void>
  remove(): Promise<void>
}

/**
 * How to start this program again: a compiled binary runs itself, a script runs through Bun. The
 * caller starts it in the project folder, whose bunfig.toml and .env must not load.
 */
export function selfCommand(): readonly string[] {
  const main = Bun.main
  return main.startsWith("/$bunfs/") || main.includes("~BUN") ? [process.execPath] : [process.execPath, ...ISOLATED_BUN_FLAGS, main]
}

export async function createMcpEndpoint(command: readonly string[], server: { readonly name: string; readonly subcommand: string; readonly label: string }): Promise<McpEndpoint> {
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0 || part.length > 1_024 || part.includes("\0"))) throw new Error(`${server.label} MCP command is invalid`)
  const directory = await mkdtemp(join(tmpdir(), `runrail-${server.label}-`))
  await chmod(directory, 0o700)
  const file = join(directory, "endpoint.json")
  const mcpConfig = JSON.stringify({ mcpServers: { [server.name]: { type: "stdio", command: command[0], args: [...command.slice(1), server.subcommand, "--endpoint-file", file] } } })
  if (mcpConfig.length > MAX_MCP_CONFIG_CHARS) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`${server.label} MCP configuration is too long`)
  }
  return {
    file,
    mcpConfig,
    async publish(url, token) {
      endpointUrl(url, server.label)
      if (!TOKEN.test(token)) throw new Error(`${server.label} endpoint token is invalid`)
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, url, token }), { mode: 0o600, flag: "wx" })
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
    async remove() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function endpointUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 256) throw new Error(`${label} endpoint address is invalid`)
  const url = new URL(value)
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost"
  if (url.protocol !== "http:" || !loopback || url.port === "" || url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "")
    throw new Error(`${label} endpoint address must be this computer's control server`)
  return `http://${url.host}`
}

/** The engine's address and token, from a file only this user can read. */
export async function readMcpEndpoint(file: string, label: string): Promise<{ readonly url: string; readonly token: string }> {
  const info = await lstat(file)
  const uid = process.getuid?.()
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_ENDPOINT_FILE_BYTES || (uid !== undefined && info.uid !== uid)) throw new Error(`${label} endpoint file is not private`)
  const value = JSON.parse(await readFile(file, "utf8")) as unknown
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} endpoint file is invalid`)
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.token !== "string" || !TOKEN.test(record.token)) throw new Error(`${label} endpoint file is invalid`)
  return { url: endpointUrl(record.url, label), token: record.token }
}

export interface McpToolListing {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface LineMcpServerOptions {
  readonly input?: AsyncIterable<Uint8Array | string>
  readonly write?: (line: string) => void
  readonly serverName: string
  readonly instructions: string
  readonly listTools: () => Promise<readonly McpToolListing[]>
  /** `undefined` for a tool the server does not have. */
  readonly callTool: (name: string, input: unknown) => Promise<Record<string, unknown> | undefined>
}

type RpcId = string | number

/** Serves MCP over newline-delimited stdin and stdout until stdin closes. */
export async function runLineMcpServer(options: LineMcpServerOptions): Promise<void> {
  const write = options.write ?? ((line: string) => void process.stdout.write(line))
  const send = (message: Record<string, unknown>): void => write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  const running = new Set<Promise<void>>()
  const decoder = new TextDecoder()
  let buffer = ""
  const accept = (line: string): void => {
    if (line.trim().length === 0) return
    // A long call must not hold up a ping or a second call, so each line runs on its own.
    const task = handleLine(line, options, send).catch(() => undefined)
    running.add(task)
    void task.finally(() => running.delete(task))
  }
  for await (const chunk of options.input ?? process.stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) send({ id: null, error: { code: -32600, message: "message is too large" } })
      else accept(line)
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
      buffer = ""
      send({ id: null, error: { code: -32600, message: "message is too large" } })
    }
  }
  accept(buffer + decoder.decode())
  await Promise.allSettled([...running])
}

async function handleLine(line: string, options: LineMcpServerOptions, send: (message: Record<string, unknown>) => void): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line) as unknown
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } })
    return
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    send({ id: null, error: { code: -32600, message: "invalid request" } })
    return
  }
  const request = message as Record<string, unknown>
  const id = request.id
  // A notification, or a response to a request this server never makes.
  if (id === undefined || request.method === undefined) return
  if (!isRpcId(id) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    send({ id: isRpcId(id) ? id : null, error: { code: -32600, message: "invalid request" } })
    return
  }
  const params = request.params !== null && typeof request.params === "object" && !Array.isArray(request.params) ? (request.params as Record<string, unknown>) : {}
  switch (request.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined
      send({
        id,
        result: {
          protocolVersion: asked !== undefined && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.serverName, version: RUNRAIL_VERSION },
          instructions: options.instructions,
        },
      })
      return
    }
    case "ping":
      send({ id, result: {} })
      return
    case "tools/list":
      send({ id, result: { tools: (await options.listTools()).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } })
      return
    case "tools/call": {
      const result = typeof params.name === "string" ? await options.callTool(params.name, params.arguments) : undefined
      if (result === undefined) send({ id, error: { code: -32602, message: "unknown tool" } })
      else send({ id, result })
      return
    }
    default:
      send({ id, error: { code: -32601, message: "method not found" } })
  }
}

/** Posts one request to the engine's path and reads at most `maxBytes` of its JSON answer. */
export async function postToEndpoint(file: string, label: string, path: string, body: unknown, options: { readonly timeoutMs: number; readonly maxBytes: number; readonly fetch?: (input: string, init: RequestInit) => Promise<Response> }): Promise<unknown> {
  const endpoint = await readMcpEndpoint(file, label)
  const response = await (options.fetch ?? fetch)(`${endpoint.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  return JSON.parse(await boundedText(response, options.maxBytes)) as unknown
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error("answer is too large")
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function isRpcId(value: unknown): value is RpcId {
  return (typeof value === "string" && value.length > 0 && value.length <= 256) || (typeof value === "number" && Number.isSafeInteger(value))
}
