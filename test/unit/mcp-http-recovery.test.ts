import { expect, test } from "bun:test"
import { McpClient } from "../../src/mcp/client.ts"
import { createMcpHttpTransport } from "../../src/mcp/http.ts"

type Handler = (request: Request, body: { id?: number; method?: string }) => Response | Promise<Response>

async function withFetch(handler: Handler, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return handler(request, (await request.json().catch(() => ({}))) as { id?: number; method?: string })
  }, { preconnect: original.preconnect })
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

const json = (value: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } })

test("a failed HTTP request fails that request only, and the next one is sent", async () => {
  let calls = 0
  await withFetch((_request, body) => (++calls === 1 ? new Response("boom", { status: 500 }) : json({ jsonrpc: "2.0", id: body.id, result: {} })), async () => {
    const transport = createMcpHttpTransport({ url: "http://127.0.0.1:1" })
    try {
      await expect(transport.send('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).rejects.toMatchObject({ code: "MCP_TRANSPORT_FAILED" })
      await transport.send('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
      const next = await transport.receive()[Symbol.asyncIterator]().next()
      expect(next.done).toBe(false)
    } finally {
      await transport.close()
    }
  })
})

test("a server that forgot the session gets a new one, and the request is asked again", async () => {
  let current = ""
  let started = 0
  await withFetch((request, body) => {
    if (body.method === "initialize") {
      current = `session-${String(++started)}`
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }, { "mcp-session-id": current })
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (request.headers.get("mcp-session-id") !== current) return new Response("unknown session", { status: 404 })
    return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })
  }, async () => {
    const client = await McpClient.connectHttp({ url: "http://127.0.0.1:1", timeoutMs: 5_000 })
    try {
      current = "forgotten"
      expect(await client.listTools()).toEqual([])
      expect(started).toBe(2)
    } finally {
      await client.close()
    }
  })
})

test("a tool result with blocks this client cannot show is still a result, and a badly named tool is skipped", async () => {
  await withFetch((_request, body) => {
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } })
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "_internal" }, { name: "build" }] } })
    return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "built" }, { type: "audio", data: "AAAA", mimeType: "audio/wav" }, { type: "resource_link", uri: "file:///out.log", name: "log" }] } })
  }, async () => {
    const client = await McpClient.connectHttp({ url: "http://127.0.0.1:1", timeoutMs: 5_000 })
    try {
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["build"])
      const result = await client.callTool("build")
      expect(result.content).toEqual([
        { type: "text", text: "built" },
        { type: "text", text: "[audio content not shown]" },
        { type: "text", text: "[resource link file:///out.log not shown]" },
      ])
    } finally {
      await client.close()
    }
  })
})
