import type { NativeTool } from "@nifrajs/coding-agent"
import type { ContextResource } from "../context/resources.ts"
import type { McpClient } from "./client.ts"
import { type McpPromptDescriptor, type McpPromptGetResult, type McpToolCallResult } from "./protocol.ts"

export interface McpNativeToolOptions {
  readonly namespace?: string
  readonly requiredCapabilities?: readonly string[]
  readonly requireApproval?: boolean
  /** Caller-owned admission by unqualified tool name; remote annotations never grant authority. */
  readonly readOnlyTools?: readonly string[]
  readonly maxResultBytes?: number
}

export interface McpContextResourceOptions {
  readonly maxResources?: number
  readonly maxResourceBytes?: number
}

export type McpBridgeErrorCode = "MCP_BRIDGE_INVALID" | "MCP_BRIDGE_LIMIT" | "MCP_TOOL_FAILED"

export class McpBridgeError extends Error {
  constructor(readonly code: McpBridgeErrorCode, reason: string) {
    super(`MCP bridge: ${reason}`)
    this.name = "McpBridgeError"
  }
}

/** Project MCP tools into Runrail's approval- and capability-aware native tool contract. */
export async function createMcpNativeTools(
  client: McpClient,
  options: McpNativeToolOptions = {},
): Promise<readonly NativeTool[]> {
  const namespace = options.namespace ?? client.server?.name ?? "mcp"
  if (!validName(namespace)) throw new McpBridgeError("MCP_BRIDGE_INVALID", "MCP namespace is invalid")
  const maxResultBytes = options.maxResultBytes ?? 256 * 1024
  assertBound(maxResultBytes, 1, 4 * 1024 * 1024, "maxResultBytes")
  const capabilities = Object.freeze([...(options.requiredCapabilities ?? [])])
  if (capabilities.length > 16 || capabilities.some((value) => !validCapability(value))) throw new McpBridgeError("MCP_BRIDGE_INVALID", "MCP bridge capabilities are invalid")
  const readOnlyTools = options.readOnlyTools ?? []
  if (!Array.isArray(readOnlyTools) || readOnlyTools.length > 256 || readOnlyTools.some((name) => !validName(name))) throw new McpBridgeError("MCP_BRIDGE_INVALID", "MCP read-only admission is invalid")
  const descriptors = await client.listTools()
  const names = new Set<string>()
  const tools: NativeTool[] = []
  // A server's tool text goes to the model unreviewed: each description is short, and all of them together are bounded.
  let descriptionBudget = MAX_TOTAL_DESCRIPTION_CHARS
  for (const descriptor of descriptors) {
    const name = `${namespace}.${descriptor.name}`
    if (!validName(name) || names.has(name)) throw new McpBridgeError("MCP_BRIDGE_INVALID", "MCP tool identity collides or is invalid")
    names.add(name)
    // A remote hint is not authorization. Only the caller can admit approval-free tools.
    const approval = options.requireApproval ?? (!readOnlyTools.includes(descriptor.name) || descriptor.annotations?.destructiveHint === true || descriptor.annotations?.openWorldHint === true)
    tools.push(Object.freeze({
      name,
      description: toolDescription(descriptor, descriptionBudget, (used) => { descriptionBudget -= used }),
      ...(capabilities.length === 0 ? {} : { capabilities }),
      ...(approval ? { requiresApproval: true } : {}),
      execute: async (input: unknown, context: Parameters<NativeTool["execute"]>[1]): Promise<unknown> => {
        if (!isRecord(input)) throw new McpBridgeError("MCP_BRIDGE_INVALID", "MCP tool input must be an object")
        const result = await client.callTool(descriptor.name, input, context.signal)
        return toolResultValue(result, maxResultBytes)
      },
    }))
  }
  return Object.freeze(tools)
}

/** Load MCP text resources into transient Runrail context resources. Binary resources are rejected here. */
export async function createMcpContextResources(
  client: McpClient,
  options: McpContextResourceOptions = {},
): Promise<readonly ContextResource[]> {
  const maxResources = options.maxResources ?? 64
  const maxResourceBytes = options.maxResourceBytes ?? 256 * 1024
  assertBound(maxResources, 1, 256, "maxResources")
  assertBound(maxResourceBytes, 1, 4 * 1024 * 1024, "maxResourceBytes")
  const descriptors = await client.listResources()
  if (descriptors.length > maxResources) throw new McpBridgeError("MCP_BRIDGE_LIMIT", "MCP resources exceed their count limit")
  const resources: ContextResource[] = []
  for (const descriptor of descriptors) {
    const result = await client.readResource(descriptor.uri)
    const text = result.contents.filter((content) => content.text !== undefined).map((content) => content.text ?? "").join("\n")
    if (text.length === 0 || Buffer.byteLength(text, "utf8") > maxResourceBytes) throw new McpBridgeError("MCP_BRIDGE_LIMIT", "MCP resource text exceeds its byte limit")
    resources.push(Object.freeze({ id: descriptor.uri, kind: "mcp", path: descriptor.uri, content: text }))
  }
  return Object.freeze(resources)
}

export class McpPromptCatalog {
  constructor(private readonly client: McpClient, private readonly descriptors: readonly McpPromptDescriptor[]) {}

  list(): readonly McpPromptDescriptor[] {
    return this.descriptors
  }

  get(name: string, args: Readonly<Record<string, string>> = {}): Promise<McpPromptGetResult> {
    if (!this.descriptors.some((prompt) => prompt.name === name)) throw new McpBridgeError("MCP_BRIDGE_INVALID", "MCP prompt is not listed")
    return this.client.getPrompt(name, args)
  }
}

export async function createMcpPromptCatalog(client: McpClient): Promise<McpPromptCatalog> {
  return new McpPromptCatalog(client, await client.listPrompts())
}

const MAX_TOOL_DESCRIPTION_CHARS = 4_096
const MAX_TOTAL_DESCRIPTION_CHARS = 256 * 1024
/** Once the shared budget runs low, a description is cut to a line so the tools after it still get a name and a hint. */
const MIN_TOOL_DESCRIPTION_CHARS = 256

function toolDescription(descriptor: { readonly name: string; readonly description?: string }, budget: number, spend: (used: number) => void): string {
  const text = descriptor.description ?? `MCP tool ${descriptor.name}`
  const allowed = Math.max(MIN_TOOL_DESCRIPTION_CHARS, Math.min(MAX_TOOL_DESCRIPTION_CHARS, budget))
  const description = text.slice(0, allowed)
  spend(description.length)
  return description
}

function toolResultValue(result: McpToolCallResult, maxBytes: number): string {
  const text = result.content?.filter((block): block is Extract<NonNullable<McpToolCallResult["content"]>[number], { type: "text" }> => block.type === "text").map((block) => block.text).join("\n")
  // The server's own explanation is what lets the model correct its call; it is bounded, not dropped.
  if (result.isError === true) throw new McpBridgeError("MCP_TOOL_FAILED", text !== undefined && text.length > 0 ? `MCP tool reported an error: ${text.slice(0, 2_000)}` : "MCP tool reported an error")
  const base = text !== undefined && text.length > 0 ? text : result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent)
  const images = result.content?.filter((block) => block.type === "image").length ?? 0
  const value = images === 0 ? base : `${base}${base.length > 0 ? "\n" : ""}[${images} image${images === 1 ? "" : "s"} not shown]`
  if (value === undefined || Buffer.byteLength(value, "utf8") > maxBytes) throw new McpBridgeError("MCP_BRIDGE_LIMIT", "MCP tool result exceeds its byte limit")
  return value
}

function assertBound(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new McpBridgeError("MCP_BRIDGE_INVALID", `${name} is invalid`)
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
