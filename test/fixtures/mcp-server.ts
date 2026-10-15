import { createInterface } from "node:readline"

const input = createInterface({ input: process.stdin })

function send(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

for await (const line of input) {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`)
    continue
  }
  if (!isRecord(value) || typeof value.method !== "string") continue
  const id = rpcId(value.id)
  if (value.method === "notifications/initialized") continue
  if (value.method === "initialize") {
    send(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "fixture-mcp", version: "1.0.0" },
    })
  } else if (value.method === "tools/list") {
    send(id, {
      tools: [
        { name: "echo", description: "Echo a bounded value", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: "mutate", description: "Mutation fixture", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
        { name: "hold", description: "Cancellation fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      ],
    })
  } else if (value.method === "tools/call") {
    const params = isRecord(value.params) ? value.params : {}
    const name = typeof params.name === "string" ? params.name : ""
    if (name === "hold") continue
    // Says whether a variable the server was given by name arrived, never its value.
    if (name === "env") {
      send(id, { content: [{ type: "text", text: process.env.FIXTURE_MCP_TOKEN === undefined ? "token absent" : "token present" }] })
      continue
    }
    send(id, { content: [{ type: "text", text: name === "echo" ? "fixture echo result" : "fixture mutation result" }] })
  } else if (value.method === "resources/list") {
    send(id, { resources: [{ uri: "fixture://readme", name: "Fixture Readme", mimeType: "text/plain" }] })
  } else if (value.method === "resources/read") {
    send(id, { contents: [{ uri: "fixture://readme", mimeType: "text/plain", text: "fixture resource context" }] })
  } else if (value.method === "prompts/list") {
    send(id, { prompts: [{ name: "fixture_prompt", description: "Fixture prompt" }] })
  } else if (value.method === "prompts/get") {
    send(id, { description: "Fixture prompt", messages: [{ role: "user", content: { type: "text", text: "fixture prompt text" } }] })
  } else if (id !== null) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })}\n`)
  }
}

function rpcId(value: unknown): string | number | null {
  return value === null || value === undefined ? null : typeof value === "string" && value.length > 0 && value.length <= 256 ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
