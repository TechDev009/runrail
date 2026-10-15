import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createConnectorRegistry } from "../../src/connectors/index.ts"
import { MultiAgentCoordinator } from "../../src/agents/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-integrations-token-123456"

test("control RPC exposes caller-owned connectors and bounded agents", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-integrations-")
  const connectors = createConnectorRegistry([{
    descriptor: { id: "fixture", version: "1.0.0", capabilities: ["fixture.read"] },
    actions: [
      { name: "lookup", description: "Lookup", kind: "read", capabilities: ["fixture.read"], execute: () => ({ ok: true }) },
      { name: "hang", description: "Never answers", kind: "read", capabilities: ["fixture.read"], execute: (_input, context) => new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("gave up")))) },
    ],
  }])
  const agents = new MultiAgentCoordinator({
    cwd,
    profiles: [{ id: "reader", role: "reader", capabilities: ["fixture.read"] }],
    executor: { run: ({ spec }) => ({ output: `completed:${spec.id}` }) },
    allowedCapabilities: ["fixture.read"],
  })
  let running: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
  try {
    running = await startRunrailControlRpcServer({ cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) }, authToken: token, connectorRegistry: connectors, agentCoordinator: agents })
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const health = await fetch(`${running.handle.url}/health`)
    expect(await health.json()).toMatchObject({ capabilities: expect.arrayContaining(["connectors", "agents"]) })
    const list = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "connector.list" }) })
    expect(await list.json()).toMatchObject({ ok: true, result: [{ id: "fixture" }] })
    const invoke = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "connector.invoke", params: { id: "fixture", action: "lookup", capabilities: ["fixture.read"] } }) })
    expect(await invoke.json()).toMatchObject({ ok: true, result: { ok: true } })
    const started = Date.now()
    const hung = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "connector.invoke", params: { id: "fixture", action: "hang", capabilities: ["fixture.read"], timeoutMs: 1_000 } }) })
    expect((await hung.json() as { ok: boolean }).ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
    const agentList = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "agent.list" }) })
    expect(await agentList.json()).toMatchObject({ ok: true, result: [{ id: "reader" }] })
    const agentRun = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "agent.run", params: { id: "agent-1", profile: "reader", prompt: "inspect" } }) })
    expect(await agentRun.json()).toMatchObject({ ok: true, result: { id: "agent-1", profile: "reader", ok: true } })
  } finally {
    await running?.handle.stop()
    await connectors.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
