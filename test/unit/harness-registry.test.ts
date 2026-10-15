import { describe, expect, test } from "bun:test"
import { createHarnessRegistry, HarnessRegistryError, negotiateHarnessFeatures, PI_HARNESS_DESCRIPTOR } from "../../src/index.ts"

describe("harness registry", () => {
  test("negotiates features and rejects invalid or duplicate descriptors", () => {
    const registry = createHarnessRegistry([{ descriptor: PI_HARNESS_DESCRIPTOR, create: () => ({}) as never }])
    expect(registry.list().map((descriptor) => descriptor.id)).toEqual(["pi"])
    expect(negotiateHarnessFeatures(PI_HARNESS_DESCRIPTOR, ["sessions", "mcp", "tools"])).toEqual({ granted: ["sessions", "tools"], unsupported: ["mcp"] })
    expect(() => registry.register({ descriptor: PI_HARNESS_DESCRIPTOR, create: () => ({}) as never })).toThrow(HarnessRegistryError)
    expect(() => registry.select("pi", ["connectors"])).toThrow(HarnessRegistryError)
  })
})
