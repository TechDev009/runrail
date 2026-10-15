import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { McpClient } from "../../src/mcp/index.ts"
import { createConnectorRegistry } from "../../src/connectors/index.ts"
import { createRunrailSession } from "../../src/session.ts"

const mcpFixture = resolve(import.meta.dir, "../fixtures/mcp-server.ts")

test("native sessions integrate MCP tools/resources and caller-owned connectors", async () => {
  const cwd = await mkdtemp("/tmp/runrail-session-integrations-")
  const client = await McpClient.connect({ command: process.execPath, args: [mcpFixture], cwd })
  const connectors = createConnectorRegistry([{
    descriptor: { id: "fixture-connector", version: "1.0.0", capabilities: ["fixture.read"] },
    actions: [{ name: "lookup", description: "Lookup fixture", kind: "read", capabilities: ["fixture.read"], execute: () => "connector result" }],
  }])
  let observedTools: readonly string[] = []
  let observedContext = ""
  const session = await createRunrailSession({
    cwd,
    backend: "native",
    loadExtensions: false,
    mcpClients: [client],
    mcpLoadResources: true,
    connectorRegistry: connectors,
    connectorToolOptions: { allowedCapabilities: ["fixture.read"] },
    model: {
      complete: (request) => {
        observedTools = request.tools.map((tool) => tool.name)
        observedContext = request.messages[0]?.text ?? ""
        return { type: "text", text: "integration complete" }
      },
    },
  })
  try {
    expect(session.listMcpPrompts().map((prompt) => prompt.name)).toContain("fixture_prompt")
    await expect(session.getMcpPrompt("fixture_prompt")).resolves.toMatchObject({ messages: [{ content: { text: "fixture prompt text" } }] })
    const events = []
    for await (const event of session.prompt("finish")) events.push(event)
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "integration complete" }))
    expect(observedTools).toContain("fixture-mcp.echo")
    expect(observedTools).toContain("connector.fixture-connector.lookup")
    expect(observedContext).toContain("fixture resource context")
  } finally {
    await session.stop("integration test complete")
    await client.close()
    await connectors.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
