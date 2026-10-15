import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { NativeModelPort } from "@nifrajs/coding-agent"
import { MultiAgentCoordinator, createRunrailSessionAgentExecutor } from "../../src/agents/runner.ts"
import { createRunrailSession } from "../../src/session.ts"
import { createMcpNativeTools } from "../../src/mcp/bridge.ts"
import { grantConfiguredMcp } from "../../src/mcp/configured.ts"
import { McpClient } from "../../src/mcp/client.ts"
import { createMcpHttpTransport } from "../../src/mcp/http.ts"

async function inWorkspace(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "runrail-authority-"))
  try { await run(cwd) } finally { await rm(cwd, { recursive: true, force: true }) }
}

test("read child never offers or executes parent writes even with parent approval", async () => inWorkspace(async (cwd) => {
  let offered: string[] = []
  let calls = 0
  const model: NativeModelPort = { complete(request) {
    offered.push(...request.tools.map((tool) => tool.name))
    return ++calls === 1 ? { type: "tool", name: "write_file", input: { path: "forbidden.txt", content: "bad" } } : { type: "text", text: "done" }
  } }
  const executor = createRunrailSessionAgentExecutor({ session: { backend: "native", model, approval: { request: () => true }, tools: [{ name: "unclassified", description: "fixture", execute: () => "bad" }] } })
  const coordinator = new MultiAgentCoordinator({ cwd, executor, profiles: [{ id: "reader", role: "reader", capabilities: ["read"] }], allowedCapabilities: ["read"] })
  const result = await coordinator.run({ id: "child", profile: "reader", prompt: "read" })
  expect(result).toMatchObject({ ok: true })
  expect(offered).toContain("read_file")
  expect(offered).not.toContain("write_file")
  expect(offered).not.toContain("run_command")
  expect(offered).not.toContain("unclassified")
  expect(await Bun.file(join(cwd, "forbidden.txt")).exists()).toBe(false)
}))

test("native authority ceiling refuses external and caller-owned backends", async () => {
  await expect(createRunrailSession({ cwd: tmpdir(), backend: "replay", allowedToolCapabilities: ["filesystem.read"] })).rejects.toThrow("TOOL_CAPABILITIES_UNSUPPORTED_BACKEND")
})

test("coordinator reserves child admission across calls and releases on completion", async () => {
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const wait = new Promise<void>((resolve) => { release = resolve })
  const coordinator = new MultiAgentCoordinator({ cwd: tmpdir(), maxChildren: 1, profiles: [{ id: "reader", role: "reader", capabilities: [] }], executor: { run: async () => { entered(); await wait; return {} } } })
  const first = coordinator.run({ id: "one", profile: "reader", prompt: "read" })
  await ready
  try { await expect(coordinator.run({ id: "two", profile: "reader", prompt: "read" })).rejects.toMatchObject({ code: "AGENT_LIMIT" }) } finally { release(); await first }
  expect((await coordinator.run({ id: "two", profile: "reader", prompt: "read" })).ok).toBe(true)
})

test("MCP hints cannot grant Read authority; caller-owned allowlist can", async () => {
  const client = new McpClient({ send: async () => {}, receive: () => ({ async *[Symbol.asyncIterator]() {} }), close: async () => {} })
  client.listTools = async () => [{ name: "delete", inputSchema: {}, annotations: { readOnlyHint: true } }, { name: "inspect", inputSchema: {}, annotations: { readOnlyHint: true } }]
  const tools = await createMcpNativeTools(client, { namespace: "fixture" })
  const configured = { tools, status: [], close: async () => {} }
  expect(tools.every((tool) => tool.requiresApproval === true)).toBe(true)
  expect(grantConfiguredMcp(configured, { "mcp:fixture": "read" }).tools).toHaveLength(0)
  const trusted = await createMcpNativeTools(client, { namespace: "fixture", readOnlyTools: ["inspect"] })
  expect(grantConfiguredMcp({ ...configured, tools: trusted }, { "mcp:fixture": "read" }).tools.map((tool) => tool.name)).toEqual(["fixture.inspect"])
  await client.close()
})

test("MCP HTTP rejects aggregate notification floods and cancels the stream", async () => {
  const original = globalThis.fetch
  let cancelled = 0
  const notice = 'data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n'
  globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(notice.repeat(1000))) }, cancel() { cancelled++ } }), { headers: { "content-type": "text/event-stream" } }), { preconnect: original.preconnect })
  const transport = createMcpHttpTransport({ url: "http://127.0.0.1:1", maxMessageBytes: 128 })
  try {
    await expect(transport.send('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).rejects.toMatchObject({ code: "MCP_MESSAGE_LIMIT" })
    expect(cancelled).toBe(1)
    await expect(transport.receive()[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "MCP_MESSAGE_LIMIT" })
  } finally { await transport.close(); globalThis.fetch = original }
})
