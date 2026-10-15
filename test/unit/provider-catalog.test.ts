import { describe, expect, test } from "bun:test"
import {
  ProviderCatalog,
  createCallerCredentialResolver,
  createCallerOwnedProviderModelAdapter,
  createDefaultProviderCatalog,
  discoverProviderModels,
} from "../../src/index.ts"

describe("provider catalog", () => {
  test("lists provider families without contacting a network", () => {
    const catalog = createDefaultProviderCatalog()
    expect(catalog.list().map((provider) => provider.id)).toEqual(["anthropic", "bedrock", "google", "llama.cpp", "openai", "openai-compatible", "vertex", "xai"])
    expect(catalog.list().every((provider) => provider.configured === false)).toBe(true)
    expect(catalog.get("google")?.descriptor).toMatchObject({ ownership: "caller-owned", protocols: ["google-generative-ai"] })
  })

  test("wraps an explicit caller-owned model without taking over its transport", async () => {
    let creates = 0
    const adapter = createCallerOwnedProviderModelAdapter({
      provider: "google",
      providerName: "Google",
      protocols: ["google-generative-ai"],
      model: "gemini-fixture",
      port: () => {
        creates += 1
        return { complete: () => ({ type: "text", text: "caller-owned" }) }
      },
    })
    const catalog = new ProviderCatalog([{ descriptor: adapter.provider, models: [adapter] }])
    const created = await catalog.modelCatalog().create({ id: "gemini-fixture" }, { cwd: "/tmp" })
    expect(created.descriptor).toMatchObject({ id: "gemini-fixture", provider: "google" })
    expect(created.port.complete({ sessionId: "fixture", cwd: "/tmp", signal: new AbortController().signal, messages: [], tools: [] })).toEqual({ type: "text", text: "caller-owned" })
    expect(creates).toBe(1)
    expect(() => createCallerOwnedProviderModelAdapter({
      provider: "google",
      providerName: "Google\nfixture",
      protocols: ["google-generative-ai"],
      model: "gemini-fixture",
      port: { complete: () => ({ type: "text", text: "unused" }) },
    })).toThrow("caller-owned provider name is invalid")
  })

  test("discovers bounded model descriptors only when explicitly requested", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requests += 1
        expect(request.method).toBe("GET")
        expect(request.headers.get("authorization")).toBe("Bearer fixture")
        return Response.json({ data: [{ id: "z-model" }, { id: "a-model" }] })
      },
    })
    try {
      const models = await discoverProviderModels({ provider: "openai", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture"), allowRemote: false })
      expect(requests).toBe(1)
      expect(models.map((model) => model.id)).toEqual(["a-model", "z-model"])
      expect(models.every((model) => model.provider === "openai" && model.version === "discovered")).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test("discovery keeps an aggregator's long model list, once per id", async () => {
    const data = [...Array.from({ length: 400 }, (_, index) => ({ id: `vendor/model-${index}` })), { id: "vendor/model-0" }]
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data }) })
    try {
      const models = await discoverProviderModels({ provider: "openai", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture"), allowRemote: false })
      expect(models).toHaveLength(400)
    } finally {
      await server.stop()
    }
  })
})
