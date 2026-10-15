import { expect, test } from "bun:test"
import { parseAccountReference } from "../../src/accounts/types.ts"
import { parsePluginManifest, validatePluginConfiguration } from "../../src/plugins/manifest.ts"

test("names shared with Object's prototype are read as plain keys", () => {
  const reference = parseAccountReference({ accountId: "conn-1", provider: "openrouter", label: "Work", authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1, headers: { constructor: "a", toString: "b" } })
  expect(reference.headers).toEqual({ constructor: "a", tostring: "b" })
  const manifest = parsePluginManifest({
    manifestVersion: 1,
    id: "fixture-plugin",
    version: "1.0.0",
    apiVersion: "1.0",
    entry: "index.ts",
    mode: "trusted",
    capabilities: ["fixture.command"],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    contributes: ["commands"],
    configuration: { type: "object", properties: { toString: { type: "string" } }, required: ["toString"], additionalProperties: false },
    enabled: true,
  })
  expect(() => validatePluginConfiguration(manifest, {})).toThrow("required")
  expect(() => validatePluginConfiguration(manifest, { constructor: "x", toString: "y" })).toThrow()
  expect(() => validatePluginConfiguration(manifest, { toString: "y" })).not.toThrow()
})

test("an account can never take an id the vault keeps for a connector's key", async () => {
  const { parseAccountReference } = await import("../../src/accounts/types.ts")
  const reference = { accountId: "connector:slack", provider: "openai", label: "Mine", authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1 }
  expect(() => parseAccountReference(reference)).toThrow("account id is reserved")
  expect(() => parseAccountReference({ ...reference, accountId: "CONNECTOR:Slack" })).toThrow("account id is reserved")
  expect(parseAccountReference({ ...reference, accountId: "slack-connector" }).accountId).toBe("slack-connector")
})
