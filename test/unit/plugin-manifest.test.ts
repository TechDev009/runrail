import { describe, expect, test } from "bun:test"
import { parsePluginManifest, validatePluginConfiguration } from "../../src/plugins/manifest.ts"

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "fixture",
    version: "1.0.0",
    apiVersion: "1.0",
    entry: "index.ts",
    mode: "trusted",
    capabilities: ["fixture.command"],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    contributes: ["commands"],
    enabled: true,
    ...overrides,
  }
}

describe("plugin manifest boundary", () => {
  test("requires supported API, boolean state, and declared approval capabilities", () => {
    expect(() => parsePluginManifest(manifest({ apiVersion: "2.0" }))).toThrow()
    expect(() => parsePluginManifest(manifest({ enabled: "yes" }))).toThrow()
    expect(() => parsePluginManifest(manifest({ approval: { required: true, capabilities: ["missing"] } }))).toThrow()
  })

  test("validates declared configuration without allowing extra fields", () => {
    const parsed = parsePluginManifest(manifest({
      configuration: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    }))
    expect(() => validatePluginConfiguration(parsed, { name: "fixture" })).not.toThrow()
    expect(() => validatePluginConfiguration(parsed, {})).toThrow()
    expect(() => validatePluginConfiguration(parsed, { name: "fixture", extra: true })).toThrow()
    expect(() => parsePluginManifest(manifest({ configuration: { type: "string", items: { type: "string" } } }))).toThrow()
    expect(() => parsePluginManifest(manifest({ configuration: { type: "object", additionalProperties: "yes" } }))).toThrow()
  })
})
