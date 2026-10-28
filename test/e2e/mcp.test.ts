import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createMcpNativeTools, createMcpContextResources, createMcpPromptCatalog, McpClient, createMcpHttpTransport, createRunrailMcpServer } from "../../src/mcp/index.ts"
import type { NativeTool } from "@nifrajs/coding-agent"
import type { JsonRpcRequest } from "@nifrajs/mcp"

const fixture = resolve(import.meta.dir, "../fixtures/mcp-server.ts")

describe("MCP interoperability", () => {
  test("connects to a caller-owned stdio server and bridges tools, resources, and prompts", async () => {
    const client = await McpClient.connect({ command: process.execPath, args: [fixture], cwd: process.cwd() })
    try {
      expect(client.server).toMatchObject({ name: "fixture-mcp", version: "1.0.0" })
      const tools = await createMcpNativeTools(client, { namespace: "fixture", requiredCapabilities: ["network.request"], readOnlyTools: ["echo"] })
      expect(tools.map((tool) => tool.name)).toEqual(["fixture.echo", "fixture.mutate", "fixture.hold"])
      expect(tools[0]?.requiresApproval).toBeUndefined()
      expect(tools[1]?.requiresApproval).toBe(true)
      await expect(tools[0]!.execute({}, { cwd: process.cwd(), signal: new AbortController().signal })).resolves.toBe("fixture echo result")
      const resources = await createMcpContextResources(client)
      expect(resources).toEqual([{ id: "fixture://readme", kind: "mcp", path: "fixture://readme", content: "fixture resource context" }])
      const prompts = await createMcpPromptCatalog(client)
      expect(prompts.list().map((prompt) => prompt.name)).toEqual(["fixture_prompt"])
      await expect(prompts.get("fixture_prompt")).resolves.toMatchObject({ messages: [{ content: { text: "fixture prompt text" } }] })
    } finally {
      await client.close()
    }
  })

  test("exposes native tools through the public MCP server with approval and output bounds", async () => {
    const cwd = await mkdtemp("/tmp/runrail-mcp-server-")
    let approved = false
    try {
      const tool: NativeTool = {
        name: "read_fixture",
        description: "Read fixture",
        execute: () => ({ ok: true }),
      }
      const writeTool: NativeTool = {
        name: "write_fixture",
        description: "Write fixture",
        requiresApproval: true,
        execute: () => "changed",
      }
      const server = createRunrailMcpServer({
        cwd,
        tools: [tool, writeTool],
        approve: () => approved,
      })
      const initialize = await server.handle(request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }))
      expect(initialize).toMatchObject({ result: { serverInfo: { name: "runrail" } } })
      const listed = await server.handle(request(2, "tools/list", {}))
      expect(listed).toMatchObject({ result: { tools: [{ name: "read_fixture" }, { name: "write_fixture", annotations: { destructiveHint: true } }] } })
      const denied = await server.handle(request(3, "tools/call", { name: "write_fixture", arguments: {} }))
      expect(denied).toMatchObject({ result: { isError: true } })
      approved = true
      const allowed = await server.handle(request(4, "tools/call", { name: "write_fixture", arguments: {} }))
      expect(allowed).toMatchObject({ result: { content: [{ text: "changed" }] } })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("rejects malformed and oversized protocol values", async () => {
    const client = await McpClient.connect({ command: process.execPath, args: [fixture], cwd: process.cwd(), maxMessageBytes: 4_096 })
    try {
      await expect(client.callTool("bad name", {})).rejects.toMatchObject({ code: "MCP_CLIENT_INVALID" })
      await expect(createMcpNativeTools(client, { namespace: "bad namespace" })).rejects.toMatchObject({ code: "MCP_BRIDGE_INVALID" })
    } finally {
      await client.close()
    }
  })
  test("serves the bounded workspace tool catalog over the CLI MCP command", async () => {
    const cwd = await mkdtemp("/tmp/runrail-mcp-cli-")
    const client = await McpClient.connect({ command: process.execPath, args: [resolve(import.meta.dir, "../../src/cli.ts"), "mcp", "--cwd", cwd], cwd })
    try {
      await writeFile(resolve(cwd, "fixture.txt"), "mcp fixture content", "utf8")
      const tools = await client.listTools()
      expect(tools.map((tool) => tool.name)).toContain("read_file")
      const result = await client.callTool("read_file", { path: "fixture.txt" })
      expect(result.content?.find((block) => block.type === "text")?.text).toContain("mcp fixture content")
    } finally {
      await client.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })
  test("cancels a pending MCP request and signals the server", async () => {
    const client = await McpClient.connect({ command: process.execPath, args: [fixture], cwd: process.cwd(), timeoutMs: 5_000 })
    try {
      const controller = new AbortController()
      const request = client.callTool("hold", {}, controller.signal)
      controller.abort()
      await expect(request).rejects.toMatchObject({ code: "MCP_CLIENT_CANCELLED" })
    } finally {
      await client.close()
    }
  })
  test("a tool call is bounded by its own longer timeout, not the handshake's", async () => {
    const client = await McpClient.connect({ command: process.execPath, args: [fixture], cwd: process.cwd(), timeoutMs: 200, callTimeoutMs: 1_500 })
    try {
      const started = performance.now()
      await expect(client.callTool("hold")).rejects.toMatchObject({ code: "MCP_CLIENT_TIMEOUT" })
      expect(performance.now() - started).toBeGreaterThan(1_000)
    } finally {
      await client.close()
    }
  })

  test("a stdio server's error reply carries the id of the request it refuses", async () => {
    const cwd = await mkdtemp("/tmp/runrail-mcp-stdio-id-")
    const child = Bun.spawn([process.execPath, "-e", `import { runRunrailMcpServer } from ${JSON.stringify(resolve(import.meta.dir, "../../src/mcp/stdio.ts"))}; await runRunrailMcpServer({ cwd: ${JSON.stringify(cwd)} })`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: [] })}\n`)
      await child.stdin.flush()
      const reader = child.stdout.getReader()
      let text = ""
      while (!text.includes("\n")) {
        const { done, value } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
      }
      expect(JSON.parse(text.split("\n")[0]!)).toMatchObject({ id: 41, error: { code: -32600 } })
    } finally {
      child.kill()
      await child.exited
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("a stdio server that logs to stdout and pings still works, with its configured environment", async () => {
    const client = await McpClient.connect({ command: process.execPath, args: [resolve(import.meta.dir, "../fixtures/mcp-noisy-server.ts")], cwd: process.cwd(), env: { FIXTURE_SERVER_NAME: "configured" } })
    try {
      expect(client.server).toMatchObject({ name: "noisy-configured" })
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["pinged"])
    } finally {
      await client.close()
    }
  })

  test("uses the explicit loopback HTTP MCP transport", async () => {
    const cwd = await mkdtemp("/tmp/runrail-mcp-http-")
    const server = createRunrailMcpServer({
      cwd,
      tools: [{ name: "http_echo", description: "HTTP echo", execute: () => "http result" }, { name: "http_quiet", description: "Says nothing", execute: () => "" }],
      authorizeMessage: (_message, request) => request.headers.get("authorization") === "Bearer fixture",
    })
    const listener = Bun.serve({ port: 0, fetch: (request) => server.fetch(request) })
    const transport = createMcpHttpTransport({ url: `${listener.url.toString().replace(/\/$/, "")}/mcp`, headers: { authorization: "Bearer fixture" } })
    const client = new McpClient(transport)
    try {
      await expect(client.initialize()).resolves.toMatchObject({ name: "runrail" })
      await expect(client.callTool("http_echo", {})).resolves.toMatchObject({ content: [{ text: "http result" }] })
      // An empty text result is a valid answer, not a malformed one.
      await expect(client.callTool("http_quiet", {})).resolves.toMatchObject({ content: [{ type: "text", text: "" }] })
    } finally {
      await client.close()
      await listener.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("HTTP MCP sends Accept, echoes the session id, reads multi-line SSE events, and bounds the body", async () => {
    const seen: Array<{ readonly method: string; readonly accept: string | null; readonly session: string | null; readonly version: string | null }> = []
    let mode: "sse" | "huge" = "sse"
    const listener = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seen.push({ method: request.method, accept: request.headers.get("accept"), session: request.headers.get("mcp-session-id"), version: request.headers.get("mcp-protocol-version") })
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        const message = await request.json() as { id?: number; method: string }
        if (message.id === undefined) return new Response(null, { status: 202 })
        if (mode === "huge") return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(32)) } }), { headers: { "content-type": "application/json" } })
        const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } : { tools: [] }
        const json = JSON.stringify({ jsonrpc: "2.0", id: message.id, result }, null, 1).split("\n").map((line) => `data: ${line}`).join("\n")
        return new Response(`event: message\n${json}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "session-fixture" } })
      },
    })
    const transport = createMcpHttpTransport({ url: `${listener.url.toString().replace(/\/$/, "")}/mcp`, maxMessageBytes: 256 * 1024 })
    const client = new McpClient(transport)
    try {
      await expect(client.initialize()).resolves.toMatchObject({ name: "fixture" })
      await expect(client.listTools()).resolves.toEqual([])
      expect(seen[0]).toMatchObject({ accept: "application/json, text/event-stream", session: null })
      expect(seen.at(-1)).toMatchObject({ session: "session-fixture", version: "2025-06-18" })
      mode = "huge"
      await expect(client.listTools()).rejects.toThrow()
    } finally {
      await client.close()
      await listener.stop()
    }
  })

  test("HTTP MCP hands on SSE replies while the server keeps the stream open", async () => {
    const encoder = new TextEncoder()
    let cancelled = 0
    const listener = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        const message = await request.json() as { id?: number; method: string }
        if (message.id === undefined) return new Response(null, { status: 202 })
        const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "open-stream", version: "1" } } : { tools: [] }
        const notice = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })
        const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`: keep-alive\n\ndata: ${notice}\n\ndata: ${reply.slice(0, 10)}`))
            controller.enqueue(encoder.encode(`${reply.slice(10)}\n\n`))
          },
          cancel() { cancelled += 1 },
        }), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const transport = createMcpHttpTransport({ url: `${listener.url.toString().replace(/\/$/, "")}/mcp`, timeoutMs: 5_000 })
    const client = new McpClient(transport, { timeoutMs: 2_000 })
    try {
      const started = performance.now()
      await expect(client.initialize()).resolves.toMatchObject({ name: "open-stream" })
      await expect(client.listTools()).resolves.toEqual([])
      expect(performance.now() - started).toBeLessThan(1_500)
      for (let attempt = 0; attempt < 50 && cancelled < 2; attempt += 1) await Bun.sleep(10)
      expect(cancelled).toBe(2)
    } finally {
      await client.close()
      await listener.stop(true)
    }
  })
})

function request(id: number, method: string, params: Readonly<Record<string, unknown>>): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params }
}
