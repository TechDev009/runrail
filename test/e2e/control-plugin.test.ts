import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createPluginIntegrity, createPluginManager } from "../../src/plugins/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

async function makeToolPlugin(root: string): Promise<void> {
  await writeFile(join(root, "index.ts"), `export function activate() { return { tools: [{ name: "fixture_tool", description: "fixture", capabilities: ["fixture.tool"], execute: () => ({ ok: true }) }] } }\n`, "utf8")
  const manifest = {
    manifestVersion: 1,
    id: "control-plugin",
    version: "1.0.0",
    apiVersion: "1.0",
    entry: "index.ts",
    mode: "trusted",
    capabilities: ["fixture.tool"],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    contributes: ["tools"],
    enabled: true,
  }
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify(manifest), "utf8")
  const digest = await createPluginIntegrity(root)
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify({ ...manifest, integrity: { algorithm: "sha256", digest } }), "utf8")
}

describe("control RPC plugin integration", () => {
  test("refreshes native tools after trusted plugin activation", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-control-plugin-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-control-plugin-source-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-control-plugin-store-"))
    const verifier = resolve(import.meta.dir, "../fixtures/local-typecheck-verifier")
    const token = "control-plugin-token-123456"
    let running: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
    try {
      await writeFile(join(workspace, "index.ts"), "const answer: number = 42\n", "utf8")
      await makeToolPlugin(source)
      const manager = await createPluginManager({ workspaceRoot: workspace })
      running = await startRunrailControlRpcServer({
        cwd: workspace,
        backend: "native",
        sessionDir,
        authToken: token,
        verificationCommand: verifier,
        loadExtensions: false,
        pluginManager: manager,
        model: {
          complete: (request) => request.messages.some((message) => message.role === "tool")
            ? { type: "text", text: "plugin task complete" }
            : { type: "tool", name: "fixture_tool", input: {} },
        },
      })
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const install = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "plugin.install", params: { source } }) })
      expect(install.status).toBe(200)
      const activate = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "plugin.activate", params: { id: "control-plugin", capabilities: ["fixture.tool"], approvalGranted: true } }) })
      expect(activate.status).toBe(200)
      expect(await activate.json()).toMatchObject({ ok: true, result: { session: { model: { id: "caller" } } } })
      // A plugin tool waits for the caller under the default policy; approve it so it runs.
      const controller = running.controller
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === "approval.required" && event.approvalId !== undefined) controller.resolveApproval(event.approvalId, true)
      })
      const turn = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "turn.enqueue", params: { message: "use plugin" } }) })
      unsubscribe()
      const body = await turn.text()
      expect(turn.status).toBe(200)
      expect(body).toContain("fixture_tool")
      expect(body).toContain("plugin task complete")
      const deactivate = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "plugin.deactivate", params: { id: "control-plugin" } }) })
      expect(deactivate.status).toBe(200)
    } finally {
      await running?.handle.stop()
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })
})
