import { expect, test } from "bun:test"
import { createPluginRegistry, PluginRegistryError } from "../../src/plugins/registry.ts"

const manifest = {
  manifestVersion: 1 as const,
  id: "fixture",
  version: "1.0.0",
  apiVersion: "1.0",
  entry: "index.ts",
  mode: "trusted" as const,
  capabilities: ["fixture.command"],
  permissions: [],
  approval: { required: false, capabilities: [] },
  integrity: { algorithm: "sha256" as const, digest: "0".repeat(64) },
  contributes: ["commands" as const],
  enabled: true,
}

test("plugin admission parses malformed runtime requests and policies fail-closed", () => {
  const registry = createPluginRegistry([manifest])
  expect(() => registry.admit({ id: "fixture", requiredCapabilities: "bad" } as never)).toThrow(PluginRegistryError)
  expect(() => registry.admit({ id: "fixture" }, { capabilities: ["fixture.command"], permissions: ["network.bad"] as never })).toThrow(PluginRegistryError)
  expect(() => registry.admit({ id: "fixture" }, {})).toThrow(PluginRegistryError)
})
