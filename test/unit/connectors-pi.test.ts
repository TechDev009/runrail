import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PI_CONNECTORS_GUIDELINE, writePiConnectorsExtension } from "../../src/connectors/pi.ts"
import type { GrantedConnectorTool } from "../../src/connectors/tools.ts"

// The extension a Pi run loads: it declares the granted tools and calls each through a stand-in
// engine's `POST /connectors`, the way Pi would after the model picks one.

interface RegisteredTool {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly promptGuidelines: readonly string[]
  execute(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<{ content: { type: string; text: string }[]; details: unknown }>
}

const TOKEN = "a".repeat(64)
let root: string
let endpointFile: string
let server: ReturnType<typeof Bun.serve>
const received: { authorization: string | null; body: unknown }[] = []

const listChannels: GrantedConnectorTool = {
  name: "slack_listChannels",
  connector: "slack",
  action: "listChannels",
  // Quotes, a template, and a closing comment stay text in the extension's source.
  description: "List channels \"${process.exit(1)}\" `x` */ </script>",
  inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  capabilities: ["network.request"],
  approval: false,
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-pi-connectors-test-"))
  endpointFile = join(root, "endpoint.json")
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as { name: string }
      received.push({ authorization: request.headers.get("authorization"), body })
      return Response.json(body.name === "slack_listChannels" ? { ok: true, result: { text: "[\"general\"]" } } : { ok: false, error: { message: "this thread may not use that tool" } })
    },
  })
  await writeFile(endpointFile, JSON.stringify({ version: 1, url: `http://127.0.0.1:${server.port}`, token: TOKEN }))
})

afterAll(async () => {
  server.stop(true)
  await rm(root, { recursive: true, force: true })
})

async function load(tools: readonly GrantedConnectorTool[], file = endpointFile): Promise<{ tools: RegisteredTool[]; remove: () => Promise<void>; file: string }> {
  const extension = await writePiConnectorsExtension(file, tools)
  const registered: RegisteredTool[] = []
  const module = (await import(extension.file)) as { default: (pi: { registerTool(tool: RegisteredTool): void }) => void }
  module.default({ registerTool: (tool) => registered.push(tool) })
  return { tools: registered, remove: extension.remove, file: extension.file }
}

test("Pi gets each granted tool by name and calls it through the engine with the endpoint's token", async () => {
  const forbidden = { ...listChannels, name: "slack_postMessage", action: "postMessage", description: "Post a message." }
  const extension = await load([listChannels, forbidden])
  try {
    expect((await stat(extension.file)).mode & 0o777).toBe(0o600)
    const [list, post] = extension.tools
    expect(list).toMatchObject({ name: "slack_listChannels", label: "Slack: listChannels", description: listChannels.description, parameters: listChannels.inputSchema, promptGuidelines: [PI_CONNECTORS_GUIDELINE] })

    expect(await list!.execute("call-1", { limit: 5 })).toEqual({ content: [{ type: "text", text: "[\"general\"]" }], details: {} })
    expect(received.at(-1)).toEqual({ authorization: `Bearer ${TOKEN}`, body: { op: "call", name: "slack_listChannels", input: { limit: 5 } } })

    // The engine decides what the thread may run; its refusal reaches the model as the tool's error.
    await expect(post!.execute("call-2", undefined)).rejects.toThrow("this thread may not use that tool")
    expect(received.at(-1)?.body).toEqual({ op: "call", name: "slack_postMessage", input: {} })
  } finally {
    await extension.remove()
  }
  await expect(stat(extension.file)).rejects.toThrow()
})

test("a stopped engine is reported as unreachable, and Pi's abort stops the call", async () => {
  const stopped = await load([listChannels], join(root, "missing.json"))
  try {
    await expect(stopped.tools[0]!.execute("call-3", {})).rejects.toThrow("Runrail's connectors are not reachable")
  } finally {
    await stopped.remove()
  }

  const live = await load([listChannels])
  try {
    await expect(live.tools[0]!.execute("call-4", {}, AbortSignal.abort())).rejects.toThrow()
  } finally {
    await live.remove()
  }
})
