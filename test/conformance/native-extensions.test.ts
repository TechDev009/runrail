import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createPluginIntegrity, createPluginManager } from "../../src/plugins/index.ts"
import { parseNativeEvent } from "../../src/native/index.ts"

async function writePackage(root: string, source: string, contributes: readonly string[]): Promise<void> {
  await writeFile(join(root, "index.ts"), source, "utf8")
  const manifest = {
    manifestVersion: 1,
    id: "native-fixture",
    version: "1.0.0",
    apiVersion: "1.0",
    entry: "index.ts",
    mode: "trusted",
    capabilities: [],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    contributes,
    enabled: true,
  }
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify(manifest), "utf8")
  const digest = await createPluginIntegrity(root)
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify({ ...manifest, integrity: { algorithm: "sha256", digest } }), "utf8")
}

test("native plugin actions, hooks, and declarative UI stay inside Runrail contracts", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-native-extension-workspace-"))
  const source = await mkdtemp(join("/tmp", "runrail-native-extension-source-"))
  try {
    await writePackage(source, `
export function activate(context) {
  return {
    actions: [{ id: "task.preview", label: "Preview task", approvalRequired: false, execute: (input) => ({ ok: true, input }) }],
    hooks: [{ event: "task.created", handle: (_event, hookContext) => { if (hookContext.cwd.length === 0) throw new Error("cwd") } }],
    nativeUI: [{ id: "timeline.progress", slot: "timeline", label: "Progress", capabilities: [] }]
  }
}
`, ["actions", "hooks", "native-ui"])
    const manager = await createPluginManager({ workspaceRoot: workspace })
    await manager.install(source)
    await manager.activate("native-fixture", { capabilities: [], permissions: [] })
    const snapshot = manager.host.snapshot()
    expect(snapshot.actions?.map((action) => action.id)).toEqual(["task.preview"])
    expect(snapshot.hooks?.map((hook) => hook.event)).toEqual(["task.created"])
    expect(snapshot.nativeUI?.map((ui) => ui.id)).toEqual(["timeline.progress"])
    await expect(manager.host.invokeNativeAction("task.preview", { task: "fixture" }, { cwd: workspace, capabilities: [] })).resolves.toEqual({ ok: true, input: { task: "fixture" } })
    await expect(manager.host.emitNativeEvent(parseNativeEvent({ contractVersion: 1, eventId: "event-1", taskId: "task-1", sessionId: "session-1", seq: 0, at: 1, type: "task.created" }), { cwd: workspace, capabilities: [] })).resolves.toBeUndefined()
    await manager.deactivate("native-fixture")
    expect(manager.host.snapshot().actions).toEqual([])
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test("native plugin manifest refuses undeclared native contributions", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-native-extension-invalid-workspace-"))
  const source = await mkdtemp(join("/tmp", "runrail-native-extension-invalid-source-"))
  try {
    await writePackage(source, `export function activate() { return { actions: [{ id: "undeclared", label: "bad", approvalRequired: false, execute: () => "bad" }] } }\n`, ["commands"])
    const manager = await createPluginManager({ workspaceRoot: workspace })
    await manager.install(source)
    await expect(manager.activate("native-fixture", { capabilities: [], permissions: [] })).rejects.toMatchObject({ code: "PLUGIN_CONTRIBUTION_UNDECLARED" })
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})
