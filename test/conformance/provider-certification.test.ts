import { describe, expect, test } from "bun:test"
import {
  certifyProviderModel,
  certifyProviderModels,
  createAnthropicModelPort,
  createCallerCredentialResolver,
  createOpenAICompatibleModelAdapter,
  createOpenAIModelPort,
  createXaiGrokModelAdapter,
  type ProviderCertificationProfile,
  type ModelAdapter,
  type ProviderModelPort,
} from "../../src/index.ts"
import type { RunrailContentModelRequest } from "../../src/model/content.ts"

const credentialResolver = createCallerCredentialResolver(() => "provider-certification-secret")

function certificationRequest(): RunrailContentModelRequest {
  return {
    sessionId: "provider-certification-session",
    cwd: process.cwd(),
    messages: [{ role: "user", text: "provider certification prompt must not be persisted" }],
    tools: [{ name: "fixture_tool", description: "bounded fixture tool", capabilities: ["tools"] }],
    parts: [
      { kind: "text", text: "provider certification prompt must not be persisted" },
      { kind: "image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=", bytes: 8 },
    ],
    signal: new AbortController().signal,
  }
}

function adapterContext(adapter: ModelAdapter): ProviderModelPort | PromiseLike<ProviderModelPort> {
  return adapter.create({ cwd: process.cwd(), descriptor: adapter.descriptor, quality: "balanced", thinking: "off" })
}

describe("first-party provider certification", () => {
  test("certifies OpenAI, Anthropic, compatible, and xAI adapters from loopback fixtures", async () => {
    const requests: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requests.push(url.pathname)
        if (url.pathname === "/messages") {
          return new Response([
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"anthropic-certified\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
          ].join(""), { headers: { "content-type": "text/event-stream" } })
        }
        return new Response([
          "data: {\"choices\":[{\"delta\":{\"content\":\"openai-certified\"}}]}\r\n\r\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":13,\"completion_tokens\":5,\"total_tokens\":18}}\r\n\r\n",
          "data: [DONE]\r\n\r\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const endpoint = server.url.toString()
      const common = {
        model: "certification-model",
        endpoint,
        credential: { kind: "caller" as const, account: "certification" },
        credentialResolver,
        allowRemote: false,
        thinking: "off" as const,
      }
      const compatible = createOpenAICompatibleModelAdapter({ ...common, provider: "openai-compatible" })
      const xai = createXaiGrokModelAdapter({ ...common })
      const profiles: readonly ProviderCertificationProfile[] = [
        {
          id: "openai-certification",
          kind: "openai",
          version: "1.0.0",
          capabilities: ["streaming", "tools", "multimodal", "usage"],
          request: certificationRequest(),
          create: () => createOpenAIModelPort({ ...common, provider: "openai", protocol: "openai-chat", thinking: "off" }),
        },
        {
          id: "anthropic-certification",
          kind: "anthropic",
          version: "1.0.0",
          capabilities: ["streaming", "tools", "multimodal", "usage"],
          request: certificationRequest(),
          create: () => createAnthropicModelPort({ ...common, provider: "anthropic", thinking: "off" }),
        },
        {
          id: "compatible-certification",
          kind: "openai-compatible",
          version: "1.0.0",
          capabilities: ["streaming", "tools", "multimodal", "usage"],
          request: certificationRequest(),
          create: () => adapterContext(compatible),
        },
        {
          id: "xai-certification",
          kind: "xai",
          version: "1.0.0",
          capabilities: ["streaming", "tools", "multimodal", "usage"],
          request: certificationRequest(),
          create: () => adapterContext(xai),
        },
      ]
      const results = await certifyProviderModels(profiles, { cwd: process.cwd() })
      expect(results).toHaveLength(4)
      expect(results.every((result) => result.ok && result.terminal && result.streamedDeltas === 1 && result.chunkCount === 2)).toBe(true)
      expect(results.map((result) => result.usage?.inputTokens)).toEqual([13, 11, 13, 13])
      expect(requests).toEqual(["/chat/completions", "/messages", "/chat/completions", "/chat/completions"])
      const serialized = JSON.stringify(results)
      expect(serialized).not.toContain("provider-certification-secret")
      expect(serialized).not.toContain("provider certification prompt must not be persisted")
      expect(serialized).not.toContain("iVBORw0KGgo=")
      expect(results.every((result) => /^[a-f0-9]{64}$/.test(result.digest))).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test("rejects invalid provider certification profile lists", async () => {
    await expect(certifyProviderModels([], { maxProfiles: 4 })).rejects.toMatchObject({ code: "PROVIDER_CERTIFICATION_INVALID" })
  })

  test("keeps certification usage metadata bounded and secret-free", async () => {
    const result = await certifyProviderModel({
      id: "usage-sanitization",
      kind: "openai",
      version: "1.0.0",
      capabilities: ["streaming"],
      create: () => ({
        complete: () => ({ type: "text", text: "safe" }),
        takeUsage: () => ({ inputTokens: 2, outputTokens: 3, secret: "must-not-leak", raw: { prompt: "must-not-leak" } }),
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
    expect(JSON.stringify(result)).not.toContain("must-not-leak")
  })

  test("a check that times out aborts the request it was waiting on", async () => {
    let seen: AbortSignal | undefined
    const port = {
      complete: (request: RunrailContentModelRequest) => {
        seen = request.signal
        return new Promise<never>(() => undefined)
      },
    } as unknown as ProviderModelPort
    const result = await certifyProviderModel({ id: "hanging", kind: "openai", version: "1", capabilities: [], create: () => port, timeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.checks.at(-1)).toMatchObject({ name: "execution", ok: false })
    expect(seen?.aborted).toBe(true)
  })
})
