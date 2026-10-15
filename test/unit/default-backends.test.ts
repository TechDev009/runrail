import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDefaultBackendRegistry } from "../../src/backend/defaults.ts"

test("default backend registry describes the shipped adapters", () => {
  const registry = createDefaultBackendRegistry()
  expect(registry.list().map((adapter) => adapter.name)).toEqual(["claude-code", "codex", "copilot", "gemini", "goose", "native", "opencode", "pi", "replay"])
  for (const name of ["opencode", "gemini", "goose"]) expect([name, registry.get(name)?.capabilities]).toEqual([name, registry.get("copilot")?.capabilities])
  expect(registry.get("copilot")?.capabilities).toEqual(["approvals", "reload", "repair", "sessions", "streaming", "tools", "verification"])
  expect(registry.get("copilot")?.securityManifest?.requested).toEqual(expect.arrayContaining(["process.exec", "network.request"]))
  expect(registry.select({ requiredCapabilities: ["workspace.tools", "verification"] }).name).toBe("native")
  expect(registry.select({ requiredCapabilities: ["interactive", "providers"] }).name).toBe("pi")
  expect(registry.get("pi")?.securityManifest?.requested).toContain("network.request")
})

test("the bare registry's native stub never writes into the folder it is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "runrail-default-native-"))
  try {
    const backend = await createDefaultBackendRegistry().get("native")!.create({ cwd: root, requestedCapabilities: [], options: {} })
    const snapshot = await backend.createSession({ cwd: root })
    const types: string[] = []
    for await (const event of backend.send({ sessionId: snapshot.id, message: "edit" })) types.push(event.type)
    await backend.close(snapshot.id)
    expect(types).toContain("approval.required")
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
