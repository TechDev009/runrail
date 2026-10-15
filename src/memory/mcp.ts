import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { McpClient } from "../mcp/client.ts"
import type { McpToolCallResult } from "../mcp/protocol.ts"
import { MemoryError, memoryText, queryTerms, recallScore, type Memory, type MemoryAdd, type MemoryListInput, type MemoryProvider, type MemoryScope, type RecallHit } from "./types.ts"

/**
 * An external memory server reached over MCP. The server's tools are mapped to
 * recall, add, forget and list with argument templates; `{query}`, `{text}`, `{id}`, `{scope}` and
 * `{limit}` in a template are filled in. Results are read leniently: any objects with a text field.
 */

export interface McpMemoryCall {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface McpMemoryMapping {
  readonly recall: McpMemoryCall
  readonly add?: McpMemoryCall
  readonly forget?: McpMemoryCall
  readonly list?: McpMemoryCall
}

export interface McpMemoryConfig {
  readonly kind: "mcp"
  readonly name: string
  /** A local server, started with only the variables named in `inherit`. */
  readonly command?: string
  readonly args?: readonly string[]
  readonly inherit?: readonly string[]
  /** Or a server at a URL; anything but loopback must be https. */
  readonly url?: string
  readonly mapping: McpMemoryMapping
}

/** The official `@modelcontextprotocol/server-memory`, a knowledge graph of entities and observations. */
export const SERVER_MEMORY_PRESET: McpMemoryConfig = {
  kind: "mcp",
  name: "MCP memory server",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
  mapping: {
    recall: { tool: "search_nodes", args: { query: "{query}" } },
    add: { tool: "create_entities", args: { entities: [{ name: "{id}", entityType: "runrail:{scope}", observations: ["{text}"] }] } },
    forget: { tool: "delete_entities", args: { entityNames: ["{id}"] } },
    list: { tool: "read_graph", args: {} },
  },
}

const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/

function invalid(message: string): never {
  throw new MemoryError("MEMORY_INVALID", message)
}

function parseCall(value: unknown, where: string): McpMemoryCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${where} must be { tool, args }`)
  const item = value as Record<string, unknown>
  if (typeof item.tool !== "string" || !TOOL.test(item.tool)) invalid(`${where}.tool must be a tool name`)
  const args = item.args ?? {}
  if (typeof args !== "object" || args === null || Array.isArray(args) || JSON.stringify(args).length > 8_000) invalid(`${where}.args must be an object`)
  return { tool: item.tool, args: args as Record<string, unknown> }
}

export function parseMcpMemoryConfig(value: unknown): McpMemoryConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("an MCP memory server must be an object")
  const item = value as Record<string, unknown>
  const name = typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 80 ? item.name.trim() : invalid("name must be text up to 80 characters")
  const mapping = typeof item.mapping === "object" && item.mapping !== null ? (item.mapping as Record<string, unknown>) : invalid("mapping is required")
  const parsed: McpMemoryMapping = {
    recall: parseCall(mapping.recall, "mapping.recall"),
    ...(mapping.add === undefined ? {} : { add: parseCall(mapping.add, "mapping.add") }),
    ...(mapping.forget === undefined ? {} : { forget: parseCall(mapping.forget, "mapping.forget") }),
    ...(mapping.list === undefined ? {} : { list: parseCall(mapping.list, "mapping.list") }),
  }
  // The person approves one of them; naming both would let the other be the one used.
  if (item.url !== undefined && item.command !== undefined) invalid("name a command or a url, not both")
  if (typeof item.url === "string") {
    let url: URL
    try {
      url = new URL(item.url)
    } catch {
      invalid("url is not a URL")
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) invalid("url must be https, or http on this machine")
    return { kind: "mcp", name, url: url.toString(), mapping: parsed }
  }
  if (typeof item.command !== "string" || item.command.trim().length === 0 || item.command.length > 1_024 || item.command.includes("\0")) invalid("command or url is required")
  const args = item.args ?? []
  if (!Array.isArray(args) || args.length > 64 || !args.every((arg) => typeof arg === "string" && arg.length <= 4_096 && !arg.includes("\0"))) invalid("args must be a list of text")
  const inherit = item.inherit ?? []
  if (!Array.isArray(inherit) || inherit.length > 32 || !inherit.every((entry) => typeof entry === "string" && ENV_NAME.test(entry))) invalid("inherit must list variable names")
  return { kind: "mcp", name, command: item.command, args: args as string[], inherit: inherit as string[], mapping: parsed }
}

type Client = Pick<McpClient, "callTool" | "listTools" | "close">

export class McpMemory implements MemoryProvider {
  readonly kind = "mcp"
  #client: Promise<Client> | undefined

  constructor(
    readonly config: McpMemoryConfig,
    private readonly connect: (config: McpMemoryConfig) => Promise<Client> = connectServer,
  ) {}

  async recall(query: string, scopes: readonly MemoryScope[], limit: number): Promise<readonly RecallHit[]> {
    const terms = queryTerms(query)
    if (terms.length === 0) return []
    let found = await this.#call(this.config.mapping.recall, { query, limit: String(limit) })
    // Servers that search for the whole query as one phrase find nothing for a sentence; their list is scored here instead.
    if (found.length === 0 && this.config.mapping.list !== undefined) found = await this.#call(this.config.mapping.list, { limit: "500" })
    return found
      .filter((memory) => memory.scope === "external" || scopes.includes(memory.scope))
      .map((memory) => ({ memory, matched: matchedTerms(memory.text, terms) }))
      .filter((entry) => entry.matched > 0)
      .sort((a, b) => b.matched - a.matched)
      .slice(0, limit)
      .map((entry) => ({ ...entry.memory, score: recallScore(entry.matched, terms.length) }))
  }

  async add(input: MemoryAdd): Promise<Memory> {
    const mapping = this.config.mapping.add ?? unsupported("add")
    const text = memoryText(input.text)
    const id = `mem-${randomUUID()}`
    await this.#call(mapping, { id, text, scope: input.scope })
    const now = Date.now()
    return { id, scope: input.scope, text, source: input.source ?? { kind: "manual" }, createdAt: now, updatedAt: now }
  }

  async update(id: string, text: string): Promise<Memory> {
    const found = (await this.list({ limit: 500 })).find((memory) => memory.id === id)
    if (found === undefined) throw new MemoryError("MEMORY_NOT_FOUND", "no memory has that id")
    await this.forget(id)
    const added = await this.add({ scope: found.scope, text, source: found.source })
    return added
  }

  async forget(id: string): Promise<boolean> {
    await this.#call(this.config.mapping.forget ?? unsupported("forget"), { id })
    return true
  }

  async list(input: MemoryListInput): Promise<readonly Memory[]> {
    const found = await this.#call(this.config.mapping.list ?? unsupported("list"), { limit: String(input.limit) })
    return found.filter((memory) => input.scopes === undefined || memory.scope === "external" || input.scopes.includes(memory.scope)).slice(0, input.limit)
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    try {
      const tools = new Set((await (await this.#connected()).listTools()).map((tool) => tool.name))
      const missing = Object.values(this.config.mapping)
        .map((call: McpMemoryCall) => call.tool)
        .filter((tool) => !tools.has(tool))
      return missing.length === 0 ? { ok: true, detail: this.config.name } : { ok: false, detail: `the server has no ${missing.join(", ")} tool` }
    } catch (error) {
      this.#reset()
      return { ok: false, detail: error instanceof Error ? reason(error) : "the server did not answer" }
    }
  }

  async close(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    await client?.then((value) => value.close()).catch(() => undefined)
  }

  #connected(): Promise<Client> {
    this.#client ??= this.connect(this.config)
    return this.#client
  }

  #reset(): void {
    void this.close()
  }

  async #call(call: McpMemoryCall, values: Readonly<Record<string, string>>): Promise<readonly Memory[]> {
    let result: McpToolCallResult
    try {
      result = await (await this.#connected()).callTool(call.tool, fill(call.args, values) as Record<string, unknown>)
    } catch (error) {
      this.#reset()
      throw new MemoryError("MEMORY_UNAVAILABLE", `${this.config.name}: ${error instanceof Error ? reason(error) : "the server did not answer"}`)
    }
    if (result.isError === true) throw new MemoryError("MEMORY_UNAVAILABLE", `${this.config.name} refused ${call.tool}`)
    return memoriesIn(result)
  }
}

function unsupported(action: string): never {
  throw new MemoryError("MEMORY_UNAVAILABLE", `the memory server's mapping has no ${action}`)
}

/** An error's code or first line, never a payload. */
function reason(error: Error): string {
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : (error.message.split("\n")[0] ?? "").slice(0, 160)
}

async function connectServer(config: McpMemoryConfig): Promise<Client> {
  if (config.url !== undefined) return McpClient.connectHttp({ url: config.url, allowRemote: true, timeoutMs: 15_000 })
  return McpClient.connect({ command: config.command ?? "", args: config.args ?? [], cwd: homedir(), inherit: config.inherit ?? [], timeoutMs: 15_000 })
}

/** Fills `{name}` in every string of a template; a string that is only `{limit}` becomes a number. */
export function fill(template: unknown, values: Readonly<Record<string, string>>): unknown {
  if (typeof template === "string") {
    if (template === "{limit}" && values.limit !== undefined) return Number(values.limit)
    return template.replace(/\{(query|text|id|scope|limit)\}/g, (whole, name: string) => values[name] ?? whole)
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, values))
  if (typeof template === "object" && template !== null) return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fill(item, values)]))
  return template
}

/** Every object in the result with text: `text`, `content`, `memory`, or a list of `observations`. */
export function memoriesIn(result: McpToolCallResult): readonly Memory[] {
  const roots: unknown[] = []
  if (result.structuredContent !== undefined) roots.push(result.structuredContent)
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue
    try {
      roots.push(JSON.parse(block.text))
    } catch {
      if (block.text.trim().length > 0) roots.push({ text: block.text })
    }
  }
  const found: Memory[] = []
  const seen = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || found.length >= 200) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value !== "object" || value === null) return
    const item = value as Record<string, unknown>
    const text = textOf(item)
    if (text !== undefined) {
      const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : typeof item.uuid === "string" ? item.uuid : `ext-${String(found.length)}`
      if (seen.has(id)) return
      seen.add(id)
      const type = typeof item.entityType === "string" ? item.entityType : undefined
      const scope = typeof item.scope === "string" ? item.scope : type?.startsWith("runrail:") === true ? type.slice(8) : "external"
      found.push({ id, scope, text: text.slice(0, 4_000), source: { kind: "manual" }, createdAt: 0, updatedAt: 0 })
      return
    }
    for (const child of Object.values(item)) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  return found
}

function textOf(item: Record<string, unknown>): string | undefined {
  for (const key of ["text", "memory", "content"]) if (typeof item[key] === "string" && (item[key] as string).trim().length > 0) return item[key] as string
  if (Array.isArray(item.observations)) {
    const lines = item.observations.filter((line): line is string => typeof line === "string")
    if (lines.length > 0) return lines.join("\n")
  }
  return undefined
}

function matchedTerms(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase()
  return terms.filter((term) => lower.includes(term.length > 5 ? term.slice(0, term.length - 2) : term)).length
}
