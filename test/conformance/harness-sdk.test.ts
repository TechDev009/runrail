import { describe, expect, test } from "bun:test"
import {
  createCandidateHarness,
  createHarnessAdapterModule,
  parseHarnessAdapterManifest,
  type HarnessAdapterManifest,
} from "../../src/index.ts"

const manifest: HarnessAdapterManifest = {
  manifestVersion: 1,
  id: "external.fixture",
  name: "External Fixture",
  apiVersion: "1.0",
  adapterVersion: "1.0.0",
  runtimeVersion: "fixture.1",
  protocolVersion: "fixture.jsonl/1",
  kind: "custom",
  classification: "adapter",
  features: ["sessions", "streaming"],
  capabilities: ["sessions", "streaming", "fixture"],
  controls: ["follow-up", "cancel", "inspect", "close"],
  events: ["lifecycle", "assistant", "failure"],
  authModes: ["caller"],
  security: ["caller-process", "bounded-jsonl"],
}

describe("third-party harness SDK", () => {
  test("parses and registers an external adapter manifest", () => {
    const parsed = parseHarnessAdapterManifest(manifest)
    const adapter = createHarnessAdapterModule(parsed, () => createCandidateHarness("gemini", { command: process.execPath, args: ["fixture"] }))
    expect(adapter.descriptor).toMatchObject({ id: "external.fixture", version: "1.0.0", protocolVersion: "fixture.jsonl/1", classification: "adapter" })
  })

  test("a backend may advertise only what its manifest declares, and is asked only for declared features", async () => {
    const backend = (capabilities: readonly string[]) => ({ ...createCandidateHarness("gemini", { command: process.execPath, args: ["fixture"] }), info: { name: "fixture", version: "1.0.0", capabilities } })
    const honest = createHarnessAdapterModule(manifest, () => backend(["sessions", "streaming"]))
    await expect(Promise.resolve(honest.create({ cwd: "/tmp", requestedFeatures: ["sessions"] }))).resolves.toMatchObject({ info: { name: "fixture" } })
    await expect(Promise.resolve(honest.create({ cwd: "/tmp", requestedFeatures: ["mcp"] }))).rejects.toThrow("HARNESS_SDK_UNSUPPORTED")
    const overclaiming = createHarnessAdapterModule(manifest, () => backend(["sessions", "approvals"]))
    await expect(Promise.resolve(overclaiming.create({ cwd: "/tmp", requestedFeatures: [] }))).rejects.toThrow("does not declare")
  })

  test("rejects unsupported API versions and unsafe identifiers", () => {
    expect(() => parseHarnessAdapterManifest({ ...manifest, apiVersion: "2.0" })).toThrow("HARNESS_SDK_UNSUPPORTED")
    expect(() => parseHarnessAdapterManifest({ ...manifest, id: "../escape" })).toThrow("HARNESS_SDK_INVALID")
    expect(() => parseHarnessAdapterManifest({ ...manifest, capabilities: ["bad value"] })).toThrow("HARNESS_SDK_INVALID")
  })
})
