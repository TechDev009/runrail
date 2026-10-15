import { createMcpEndpoint, postToEndpoint, readMcpEndpoint, runLineMcpServer, type McpEndpoint } from "../mcp/endpoint.ts"
import { IMAGE_TOOL_SPECS } from "./tools.ts"

/** The image tool as an MCP server for Claude Code (`runrail images-mcp`); see `mcp/endpoint.ts`. */

export const IMAGES_MCP_SERVER = "runrail_images"
/** What Claude Code's `--allowedTools` names to let every tool of the server run. */
export const IMAGES_MCP_ALLOWED_TOOLS = `mcp__${IMAGES_MCP_SERVER}`
export const IMAGES_MCP_HINT = "This thread can make and change pictures with the image model the person chose (mcp__runrail_images__image_generate). Each picture is billed to their account: make one only when they asked for it or agreed."

// The picture rides in the answer.
const MAX_ANSWER_BYTES = 6 * 1024 * 1024
// Longer than the engine's own wait for the provider.
const CALL_TIMEOUT_MS = 200_000

export type ImagesEndpoint = McpEndpoint

export function createImagesEndpoint(command: readonly string[]): Promise<ImagesEndpoint> {
  return createMcpEndpoint(command, { name: IMAGES_MCP_SERVER, subcommand: "images-mcp", label: "images" })
}

export function readImagesEndpoint(file: string): Promise<{ readonly url: string; readonly token: string }> {
  return readMcpEndpoint(file, "images")
}

export interface ImagesMcpServerOptions {
  readonly endpointFile: string
  readonly input?: AsyncIterable<Uint8Array | string>
  readonly write?: (line: string) => void
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
}

/** Serves MCP over newline-delimited stdin and stdout until stdin closes. */
export function runImagesMcpServer(options: ImagesMcpServerOptions): Promise<void> {
  return runLineMcpServer({
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.write === undefined ? {} : { write: options.write }),
    serverName: "runrail-images",
    instructions: "Makes pictures with the image model the person chose from their own connections, billed to their account.",
    listTools: async () => IMAGE_TOOL_SPECS,
    callTool: async (name, input) => (IMAGE_TOOL_SPECS.some((spec) => spec.name === name) ? callImages(input, options) : undefined),
  })
}

async function callImages(input: unknown, options: ImagesMcpServerOptions): Promise<Record<string, unknown>> {
  const failed = (text: string) => ({ content: [{ type: "text", text }], isError: true })
  let answer: unknown
  try {
    answer = await postToEndpoint(options.endpointFile, "images", "/images", { input: input ?? {} }, { timeoutMs: CALL_TIMEOUT_MS, maxBytes: MAX_ANSWER_BYTES, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
  } catch {
    return failed("The image tool is not reachable: this thread's engine has stopped.")
  }
  const body = answer !== null && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {}
  if (body.ok !== true) {
    const error = body.error !== null && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {}
    return failed(typeof error.message === "string" && error.message.length > 0 ? error.message.slice(0, 500) : "the picture could not be made")
  }
  const result = body.result !== null && typeof body.result === "object" ? (body.result as Record<string, unknown>) : {}
  const text = typeof result.text === "string" && result.text.length > 0 ? result.text : "Done."
  const image = result.image !== null && typeof result.image === "object" ? (result.image as Record<string, unknown>) : undefined
  const picture = image !== undefined && (image.mediaType === "image/png" || image.mediaType === "image/jpeg" || image.mediaType === "image/webp") && typeof image.dataBase64 === "string" ? { type: "image", data: image.dataBase64, mimeType: image.mediaType } : undefined
  return { content: [{ type: "text", text }, ...(picture === undefined ? [] : [picture])] }
}
