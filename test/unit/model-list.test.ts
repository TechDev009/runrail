import { describe, expect, test } from "bun:test"
import { MODELS_SNAPSHOT, ProviderError, createCallerCredentialResolver, createModelMetadataSource, fetchModelList, isChatModelId, mergeModelList, modelDescriptorFacts, parseModelList } from "../../src/index.ts"

const credential = { kind: "caller", account: "fixture" } as const
const credentialResolver = createCallerCredentialResolver(() => "fixture-secret")

async function failure(work: () => unknown): Promise<string> {
  try {
    await work()
  } catch (error) {
    return error instanceof ProviderError ? error.code : "not a provider error"
  }
  return "no error"
}

describe("model list parsing", () => {
  test("reads the list shapes endpoints return", () => {
    expect(parseModelList({ data: [{ id: "b-model" }, { id: "a-model" }] }).map((model) => model.id)).toEqual(["a-model", "b-model"])
    expect(parseModelList({ models: [{ name: "models/gemini-fixture" }] })).toEqual([{ id: "models/gemini-fixture", source: "live" }])
    expect(parseModelList(["plain-a", "plain-b"])).toEqual([{ id: "plain-a", source: "live" }, { id: "plain-b", source: "live" }])
    expect(parseModelList({ data: [] })).toEqual([])
  })

  test("keeps only the facts it understands", () => {
    expect(parseModelList({ data: [{ id: "router/model", name: "Router Model", context_length: 200_000, top_provider: { max_completion_tokens: 8_192 }, supported_parameters: ["tools", "reasoning"], pricing: { prompt: "0.000003", completion: "0.000015", image: "0.01" }, owned_by: "someone" }] })).toEqual([
      { id: "router/model", name: "Router Model", contextTokens: 200_000, maxOutputTokens: 8_192, reasoning: true, pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 }, source: "live" },
    ])
    expect(parseModelList({ data: [{ id: "claude-fixture", display_name: "Claude Fixture", max_input_tokens: 1_000, max_output_tokens: 64, supported_parameters: [] }] })).toEqual([
      { id: "claude-fixture", name: "Claude Fixture", contextTokens: 1_000, maxOutputTokens: 64, reasoning: false, source: "live" },
    ])
    expect(parseModelList({ data: [{ id: "odd", name: "two\nlines", context_window: -1, max_completion_tokens: 1.5 }] })).toEqual([{ id: "odd", source: "live" }])
  })

  test("reads a per-token list price as dollars per million and drops one it cannot trust", () => {
    const priced = (pricing: unknown) => parseModelList({ data: [{ id: "router/model", pricing }] })[0]?.pricing
    expect(priced({ prompt: "0", completion: "0" })).toEqual({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 })
    expect(priced({ prompt: "0.00000015" })).toEqual({ inputUsdPerMillionTokens: 0.15 })
    // A router whose price depends on the model it picks reports -1.
    for (const pricing of [{ prompt: "-1", completion: "-1" }, { prompt: "1e-6" }, { prompt: "0.5" }, { prompt: " 0.1" }, "0.1", null]) expect(priced(pricing)).toBeUndefined()
  })

  test("skips entries it cannot use and refuses an answer that is not a list", () => {
    const listed = parseModelList({ data: [{ id: "keep" }, { id: "keep" }, { id: "" }, { id: "x".repeat(257) }, { id: "bad\u0000id" }, { object: "model" }, 7, null, { id: "text-embedding-3-small" }] })
    expect(listed.map((model) => model.id)).toEqual(["keep"])
    expect(Object.isFrozen(listed)).toBe(true)
    expect(parseModelList(Array.from({ length: 2_500 }, (_, index) => `model-${index}`)).length).toBe(2_000)
    for (const value of [{}, { data: "models" }, "models", null, 7]) expect(() => parseModelList(value)).toThrow(ProviderError)
  })

  test("filters models that cannot hold a conversation", () => {
    for (const id of ["text-embedding-3-small", "whisper-1", "tts-1-hd", "dall-e-3", "omni-moderation-latest", "gpt-4o-realtime-preview", "gpt-image-1", "imagen-4.0", "models/veo-3", "sora-2", "jina-reranker-v2", "gpt-4o-transcribe", "davinci-002", "voyage/embed-3"]) expect(isChatModelId(id)).toBe(false)
    for (const id of ["gpt-5", "claude-sonnet-4-5", "deepseek-reasoner", "models/gemini-2.5-pro", "qwen3-coder", "imaginary-chat", "embedded-systems-tutor", "moonshot-v1-8k"]) expect(isChatModelId(id)).toBe(true)
  })
})

describe("model list merge", () => {
  const bundle = [{ id: "known", name: "Known", contextTokens: 400_000, reasoning: true }, { id: "gemini-fixture", contextTokens: 1_000_000 }, { id: "unlisted", contextTokens: 8_000 }, { id: "text-embedding-fixture" }]

  test("a live list wins and the bundle fills its gaps", () => {
    const merged = mergeModelList([{ id: "known", contextTokens: 128_000, source: "live" }, { id: "models/gemini-fixture", source: "live" }, { id: "new-model", source: "live" }], bundle)
    expect(merged).toEqual([
      { id: "known", name: "Known", contextTokens: 128_000, reasoning: true, source: "live" },
      { id: "models/gemini-fixture", contextTokens: 1_000_000, source: "live" },
      { id: "new-model", source: "live" },
    ])
  })

  test("without a live list the bundle is the list", () => {
    expect(mergeModelList(undefined, bundle)).toEqual([
      { id: "gemini-fixture", contextTokens: 1_000_000, source: "snapshot" },
      { id: "known", name: "Known", contextTokens: 400_000, reasoning: true, source: "snapshot" },
      { id: "unlisted", contextTokens: 8_000, source: "snapshot" },
    ])
    expect(mergeModelList([], bundle)).toEqual([])
    expect(mergeModelList(undefined, [])).toEqual([])
  })

  test("the metadata source answers only for presets it holds", () => {
    const source = createModelMetadataSource({ generatedAt: "2026-01-01", providers: { openrouter: [{ id: "router/model" }] } })
    expect(source.generatedAt).toBe("2026-01-01")
    expect(source.models("openrouter")).toEqual([{ id: "router/model" }])
    expect(source.models("deepseek")).toEqual([])
    expect(source.models("constructor")).toEqual([])
    expect(MODELS_SNAPSHOT.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(createModelMetadataSource().models("openai").length).toBeGreaterThan(0)
  })

  test("gives a descriptor the bundled window and list price", () => {
    const source = createModelMetadataSource({ providers: { openrouter: [{ id: "router/model", contextTokens: 200_000, pricing: { inputUsdPerMillionTokens: 3 } }, { id: "router/plain", reasoning: true }] } })
    expect(modelDescriptorFacts(source, "openrouter", "router/model")).toEqual({ contextTokens: 200_000, pricing: { inputUsdPerMillionTokens: 3 } })
    expect(modelDescriptorFacts(source, "openrouter", "router/plain")).toBeUndefined()
    expect(modelDescriptorFacts(source, "openrouter", "router/missing")).toBeUndefined()
    expect(modelDescriptorFacts(source, "deepseek", "router/model")).toBeUndefined()
  })
})

describe("model list fetch", () => {
  test("asks each protocol for its list with the row's key header", async () => {
    const seen: { path: string; headers: Headers }[] = []
    const server = Bun.serve({
      port: 0,
      fetch(incoming) {
        const url = new URL(incoming.url)
        seen.push({ path: `${url.pathname}${url.search}`, headers: incoming.headers })
        return Response.json({ data: [{ id: "chat-model", context_length: 32_000 }, { id: "text-embedding-fixture" }] })
      },
    })
    try {
      const endpoint = server.url.toString()
      expect(await fetchModelList({ provider: "openrouter", endpoint, credential, credentialResolver })).toEqual([{ id: "chat-model", contextTokens: 32_000, source: "live" }])
      expect(seen[0]?.path).toBe("/models")
      expect(seen[0]?.headers.get("authorization")).toBe("Bearer fixture-secret")
      expect(seen[0]?.headers.get("anthropic-version")).toBeNull()
      await fetchModelList({ provider: "kimi-for-coding", endpoint, credential, credentialResolver })
      expect(seen[1]?.path).toBe("/v1/models?limit=1000")
      expect(seen[1]?.headers.get("x-api-key")).toBe("fixture-secret")
      expect(seen[1]?.headers.get("authorization")).toBeNull()
      expect(seen[1]?.headers.get("anthropic-version")).toBe("2023-06-01")
      await fetchModelList({ provider: "custom-anthropic-bearer", endpoint: `${endpoint}relay/v1`, credential, credentialResolver })
      expect(seen[2]?.path).toBe("/relay/v1/models?limit=1000")
      expect(seen[2]?.headers.get("authorization")).toBe("Bearer fixture-secret")
    } finally {
      await server.stop()
    }
  })

  test("reports a stable code for each way the list can fail", async () => {
    let status = 401
    let body: unknown = { error: "no" }
    let calls = 0
    const server = Bun.serve({ port: 0, fetch: () => { calls += 1; return Response.json(body, { status }) } })
    try {
      const options = { provider: "openrouter", endpoint: server.url.toString(), credential, credentialResolver, retryDelayMs: 1 } as const
      expect(await failure(() => fetchModelList(options))).toBe("PROVIDER_AUTH_FAILED")
      expect(calls).toBe(1)
      status = 404
      expect(await failure(() => fetchModelList(options))).toBe("PROVIDER_FAILED")
      status = 200
      body = { object: "error" }
      expect(await failure(() => fetchModelList(options))).toBe("PROVIDER_RESPONSE_INVALID")
      expect(await failure(() => fetchModelList({ ...options, credentialResolver: createCallerCredentialResolver(() => { throw new Error("locked") }) }))).toBe("PROVIDER_CREDENTIALS")
      expect(await failure(() => fetchModelList({ ...options, endpoint: "http://relay.example.test/v1", allowRemote: true }))).toBe("PROVIDER_ENDPOINT_DENIED")
      expect(await failure(() => fetchModelList({ provider: "example-org", credential, credentialResolver }))).toBe("PROVIDER_INVALID")
    } finally {
      await server.stop()
    }
  })
})
