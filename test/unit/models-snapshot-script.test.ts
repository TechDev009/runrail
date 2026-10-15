import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildModelsSnapshot, renderModelsSnapshot } from "../../scripts/models-snapshot.ts"
import { MODELS_SNAPSHOT } from "../../src/index.ts"

const catalog = {
  openrouter: {
    id: "openrouter",
    models: {
      "vendor/chat": { id: "vendor/chat", name: "Vendor Chat", reasoning: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 200_000, output: 8_192 }, cost: { input: 1, cache_read: 0.1, cache_write: 1.25 } },
      "vendor/plain": { id: "vendor/plain", name: "vendor/plain", reasoning: false, modalities: { input: ["text"], output: ["text"] }, limit: { context: -1, output: 1.5 }, cost: { input: -1, output: "3" } },
      "vendor/free": { id: "vendor/free", cost: { input: 0, output: 0.123456789 } },
      "vendor/painter": { id: "vendor/painter", modalities: { input: ["text"], output: ["image"] } },
      "text-embedding-fixture": { id: "text-embedding-fixture" },
      "keyed-only": { name: "two\nlines" },
      broken: "not a model",
    },
  },
  "example-cloud": { models: { "example-model": { id: "example-model" } } },
  deepseek: { models: {} },
  zai: "not a provider",
}

describe("models snapshot generator", () => {
  test("keeps the facts Runrail uses for providers it has a preset for", () => {
    const snapshot = buildModelsSnapshot(catalog, "2026-01-02")
    expect(snapshot).toEqual({
      generatedAt: "2026-01-02",
      providers: {
        openrouter: [
          { id: "keyed-only" },
          { id: "vendor/chat", name: "Vendor Chat", contextTokens: 200_000, maxOutputTokens: 8_192, reasoning: true, images: true, pricing: { inputUsdPerMillionTokens: 1, cacheReadUsdPerMillionTokens: 0.1, cacheWriteUsdPerMillionTokens: 1.25 } },
          { id: "vendor/free", pricing: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0.1235 } },
          { id: "vendor/plain", reasoning: false, images: false },
        ],
      },
    })
    // Only the list price is kept, under Runrail's own field names.
    expect(JSON.stringify(snapshot)).not.toContain("cost")
  })

  test("caps a provider's list and refuses input that is not a catalog", () => {
    const many = { openrouter: { models: Object.fromEntries(Array.from({ length: 450 }, (_, index) => [`model-${String(index).padStart(3, "0")}`, {}])) } }
    const capped = buildModelsSnapshot(many, "2026-01-02").providers.openrouter
    expect(capped?.length).toBe(400)
    expect(capped?.[0]?.id).toBe("model-000")
    expect(buildModelsSnapshot({}, "2026-01-02")).toEqual({ providers: {} })
    expect(buildModelsSnapshot(catalog, "2026-01-02", ["deepseek"])).toEqual({ providers: {} })
    for (const value of [null, [], "catalog", 7]) expect(() => buildModelsSnapshot(value, "2026-01-02")).toThrow()
    expect(() => buildModelsSnapshot(catalog, "yesterday")).toThrow()
  })

  test("renders the module that ships, byte for byte", async () => {
    const shipped = await readFile(resolve(import.meta.dir, "../../src/providers/models-snapshot.ts"), "utf8")
    expect(renderModelsSnapshot(MODELS_SNAPSHOT)).toBe(shipped)
    const rendered = renderModelsSnapshot(buildModelsSnapshot(catalog, "2026-01-02"))
    expect(rendered).toContain('generatedAt: "2026-01-02",')
    expect(rendered).toContain('      Object.freeze({ id: "vendor/chat", name: "Vendor Chat", contextTokens: 200000, maxOutputTokens: 8192, reasoning: true, images: true, pricing: Object.freeze({ inputUsdPerMillionTokens: 1, cacheReadUsdPerMillionTokens: 0.1, cacheWriteUsdPerMillionTokens: 1.25 }) }),')
    expect(rendered.startsWith(shipped.slice(0, shipped.indexOf("export const MODELS_SNAPSHOT")))).toBe(true)
  })
})
