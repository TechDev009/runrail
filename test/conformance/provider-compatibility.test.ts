import { expect, test } from "bun:test"
import {
  createDefaultProviderCompatibilityMatrix,
  parseProviderCompatibilityMatrix,
  summarizeProviderCompatibilityMatrix,
} from "../../src/providers/compatibility.ts"
import { createDefaultProviderCatalog } from "../../src/providers/catalog.ts"

test("provider compatibility matrix distinguishes native adapters from caller-owned breadth", () => {
  const matrix = createDefaultProviderCompatibilityMatrix()
  const summary = summarizeProviderCompatibilityMatrix(matrix)

  expect(matrix.piVersion).toBe("0.84.1")
  expect(summary.total).toBeGreaterThanOrEqual(8)
  expect(summary.nativeAdapter).toBeGreaterThanOrEqual(4)
  expect(summary.callerOwned).toBeGreaterThan(0)
  expect(summary.gaps).toEqual([])
  expect(matrix.entries.find((entry) => entry.id === "bedrock")?.classification).toBe("caller-owned")
  expect(matrix.entries.filter((entry) => entry.classification === "caller-owned").every((entry) => entry.status === "verified")).toBe(true)
  expect(createDefaultProviderCatalog().list().filter((provider) => provider.ownership === "caller-owned").map((provider) => provider.id)).toEqual(["bedrock", "google", "llama.cpp", "vertex"])
  expect(matrix.entries.find((entry) => entry.id === "openai")?.status).toBe("verified")
})

test("provider compatibility parsing refuses unknown fields and missing ownership reasons", () => {
  const matrix = createDefaultProviderCompatibilityMatrix()
  expect(() => parseProviderCompatibilityMatrix({ ...matrix, unexpected: true })).toThrow("PROVIDER_MATRIX_INVALID")
  expect(() => parseProviderCompatibilityMatrix({
    ...matrix,
    entries: matrix.entries.map((entry, index) => index === 0 ? { ...entry, classification: "caller-owned", reason: undefined } : entry),
  })).toThrow("PROVIDER_MATRIX_INVALID")
})
