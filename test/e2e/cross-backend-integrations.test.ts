import { describe, expect, test } from "bun:test"
import type { AgentBackend, AgentEvent, AgentSessionSnapshot, ReloadResult } from "@nifrajs/agent-protocol"
import { createConnectorRegistry, createRunrailSession } from "../../src/index.ts"

function snapshot(id: string, backend: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq = -1): AgentSessionSnapshot {
  return { version: 1, id, backend, cwd, status, createdAt: 0, updatedAt: Date.now(), lastSeq, capabilities: ["sessions", "streaming", "tools", "mcp", "connectors"] }
}

function backend(name: string): AgentBackend {
  const sessions = new Map<string, AgentSessionSnapshot>()
  return {
    info: { name, version: "fixture", capabilities: ["sessions", "streaming", "tools", "mcp", "connectors"] },
    createSession: async (input) => {
      const value = snapshot(input.sessionId ?? "external-session", name, input.cwd, "idle")
      sessions.set(value.id, value)
      return value
    },
    send: (_input): AsyncIterable<AgentEvent> => (async function* () {})(),
    cancel: async () => {},
    snapshot: async (id) => sessions.get(id) ?? snapshot(id, name, "/tmp", "stopped"),
    reload: async (): Promise<ReloadResult> => ({ revision: "fixture", loaded: [], disabled: [], rolledBack: false }),
    close: async (id) => { sessions.delete(id) },
  }
}

describe("cross-backend Runrail integrations", () => {
  test("passes MCP and connector bundles through an explicitly advertised hook", async () => {
    let seenMcp = 0
    let seenConnectors = 0
    const connectors = createConnectorRegistry([{ descriptor: { id: "fixture", version: "1.0.0", capabilities: ["fixture.read"] }, actions: [{ name: "lookup", description: "Lookup", kind: "read", capabilities: ["fixture.read"], execute: () => "ok" }] }])
    const mcp = { server: { name: "fixture-mcp" }, listTools: async () => [{ name: "echo", description: "Echo" }], callTool: async () => ({ content: [{ type: "text", text: "mcp" }] }) } as never
    const adapter = {
      name: "external",
      version: "1.0.0",
      capabilities: ["sessions", "streaming", "tools", "mcp", "connectors"],
      create: () => backend("external"),
      integrationHook: (value: AgentBackend, context: { readonly bundle: { readonly mcpClients?: readonly unknown[]; readonly connectorRegistry?: unknown } }) => {
        seenMcp = context.bundle.mcpClients?.length ?? 0
        seenConnectors = context.bundle.connectorRegistry === undefined ? 0 : 1
        return value
      },
    }
    const session = await createRunrailSession({ cwd: "/tmp", backend: "external", adapter, mcpClients: [mcp], connectorRegistry: connectors })
    try {
      expect(seenMcp).toBe(1)
      expect(seenConnectors).toBe(1)
      expect(session.backend.info.name).toBe("external")
    } finally {
      await session.stop("test complete")
      await connectors.close()
    }
  })

  test("rejects advertised external integrations without an explicit bridge", async () => {
    const mcp = { listTools: async () => [], callTool: async () => ({ content: [] }) } as never
    await expect(createRunrailSession({ cwd: "/tmp", backend: "external", adapter: { name: "external", version: "1.0.0", capabilities: ["sessions", "streaming", "mcp"], create: () => backend("external") }, mcpClients: [mcp] })).rejects.toThrow("INTEGRATION_BRIDGE_UNAVAILABLE")
  })
})
