import { describe, expect, test } from "bun:test"
import { PROVIDER_PRESETS, ProviderError, RUNRAIL_USER_AGENT, createCallerCredentialResolver, createConfiguredProviderModelAdapter, isProviderFamilyId } from "../../src/index.ts"
import type { ProviderModelOptions, ProviderThinkingShape, ThinkingLevel } from "../../src/index.ts"
import type { NativeModelChunk, NativeModelPort, NativeModelResponse } from "@nifrajs/coding-agent"
import type { RunrailContentModelRequest } from "../../src/model/content.ts"

const request: RunrailContentModelRequest = {
  sessionId: "quirk-session",
  cwd: "/tmp",
  messages: [{ role: "user", text: "read it" }],
  tools: [{ name: "read_file", description: "Read a file", capabilities: ["filesystem.read"] }],
  signal: new AbortController().signal,
  parts: [],
}
const plain: RunrailContentModelRequest = { ...request, tools: [] }

const CHAT_TEXT = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"
const RESPONSES_TEXT = { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }
const MESSAGES_TEXT = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"ok\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

interface Seen {
  readonly path: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** A loopback endpoint that records what it was sent and answers as `reply` decides. */
function mock(reply: (seen: Seen, count: number) => Response) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(incoming) {
      const entry: Seen = { path: new URL(incoming.url).pathname, headers: incoming.headers, body: await incoming.json() as Record<string, unknown> }
      seen.push(entry)
      return reply(entry, seen.length)
    },
  })
  return { seen, url: server.url.toString(), stop: () => server.stop() }
}

const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } })
const refuse = (status: number) => Response.json({ error: { message: "unsupported parameter" } }, { status })

function adapterFor(options: Partial<ProviderModelOptions> & Pick<ProviderModelOptions, "provider" | "endpoint">) {
  return createConfiguredProviderModelAdapter({ model: "fixture-model", credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret"), ...options })
}

async function portOf(adapter: ReturnType<typeof adapterFor>, thinking: ThinkingLevel = "off"): Promise<NativeModelPort> {
  return adapter.create({ cwd: process.cwd(), descriptor: adapter.descriptor, quality: "balanced", thinking })
}

async function run(port: NativeModelPort, input: RunrailContentModelRequest = request): Promise<NativeModelResponse> {
  const source = port.complete(input) as NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk>
  if (source !== null && typeof source === "object" && Symbol.asyncIterator in source) {
    let last: NativeModelResponse | undefined
    for await (const chunk of source) if (chunk.type === "response") last = chunk.response
    if (last === undefined) throw new Error("no response chunk")
    return last
  }
  return await source
}

async function failure(work: () => unknown): Promise<{ readonly code: string; readonly status?: number }> {
  try {
    await work()
  } catch (error) {
    if (error instanceof ProviderError) return { code: error.code, ...(error.status === undefined ? {} : { status: error.status }) }
    throw error
  }
  throw new Error("expected a provider error")
}

const THINKING_ON: Record<ProviderThinkingShape, Record<string, unknown>> = {
  effort: { reasoning_effort: "high" },
  "reasoning-object": { reasoning: { effort: "high" } },
  "thinking-type": { thinking: { type: "enabled" } },
  zhipu: { thinking: { type: "enabled", clear_thinking: false } },
  together: { reasoning: { enabled: true } },
  qwen: { enable_thinking: true },
  none: {},
}
const THINKING_OFF: Record<ProviderThinkingShape, Record<string, unknown>> = {
  effort: {},
  "reasoning-object": {},
  "thinking-type": { thinking: { type: "disabled" } },
  zhipu: { thinking: { type: "disabled" } },
  together: { reasoning: { enabled: false } },
  qwen: { enable_thinking: false },
  none: {},
}
const THINKING_KEYS = ["reasoning_effort", "reasoning", "thinking", "enable_thinking"]

function thinkingOf(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(THINKING_KEYS.filter((key) => key in body).map((key) => [key, body[key]]))
}

describe("provider preset quirks on the wire", () => {
  test("every chat row sends its own max tokens field, thinking switch and stream options", async () => {
    const endpoint = mock(() => sse(CHAT_TEXT))
    try {
      const chat = PROVIDER_PRESETS.filter((preset) => preset.protocol === "openai-chat")
      expect(chat.length).toBe(32)
      for (const preset of chat) {
        // `xai` is also a family id with its own defaults; its row is passed the way a connection passes it.
        const adapter = adapterFor({ provider: preset.id, endpoint: endpoint.url, maxOutputTokens: 512, ...(isProviderFamilyId(preset.id) ? { quirks: preset.quirks, displayName: preset.name } : {}) })
        expect(adapter.provider).toMatchObject({ id: preset.id, name: preset.name, protocols: ["openai-chat"] })
        const shape = preset.quirks.thinking ?? "effort"
        for (const [level, expected] of [["high", THINKING_ON[shape]], ["off", THINKING_OFF[shape]]] as const) {
          endpoint.seen.length = 0
          expect(await run(await portOf(adapter, level))).toEqual({ type: "text", text: "ok" })
          expect(endpoint.seen.length).toBe(1)
          const { body, path, headers } = endpoint.seen[0]!
          expect(path).toBe("/chat/completions")
          expect(headers.get("authorization")).toBe("Bearer fixture-secret")
          expect(headers.get("x-api-key")).toBeNull()
          const field = preset.quirks.maxTokensField!
          expect(body[field]).toBe(512)
          expect(body[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"]).toBeUndefined()
          expect(thinkingOf(body)).toEqual(expected)
          expect(body.stream_options).toEqual(preset.quirks.streamOptions === false ? undefined : { include_usage: true })
          expect(body.parallel_tool_calls).toBe(false)
          expect(body.store).toBeUndefined()
        }
      }
      // All seven spellings are exercised by at least one row.
      expect(new Set(chat.map((preset) => preset.quirks.thinking ?? "effort")).size).toBe(7)
    } finally {
      await endpoint.stop()
    }
  })

  test("sends no output cap on chat when the caller set none", async () => {
    const endpoint = mock(() => sse(CHAT_TEXT))
    try {
      await run(await portOf(adapterFor({ provider: "openrouter", endpoint: endpoint.url })))
      await run(await portOf(adapterFor({ provider: "custom-openai-chat", endpoint: endpoint.url, maxOutputTokens: 64 })))
      expect(endpoint.seen[0]?.body.max_tokens).toBeUndefined()
      expect(endpoint.seen[0]?.body.max_completion_tokens).toBeUndefined()
      expect(endpoint.seen[1]?.body.max_tokens).toBe(64)
    } finally {
      await endpoint.stop()
    }
  })

  test("Responses rows never store the conversation on the provider", async () => {
    const endpoint = mock(() => Response.json(RESPONSES_TEXT))
    try {
      for (const preset of PROVIDER_PRESETS.filter((row) => row.protocol === "openai-responses")) {
        // `openai` is also a family id whose default is Chat; the row's protocol is passed the way a connection passes it.
        await run(await portOf(adapterFor({ provider: preset.id, endpoint: endpoint.url, protocol: "responses", maxOutputTokens: 256 }), "medium"))
        const { body, path, headers } = endpoint.seen.at(-1)!
        expect(path).toBe("/responses")
        expect(body.store).toBe(false)
        expect(body.max_output_tokens).toBe(256)
        expect(body.reasoning).toEqual({ effort: "medium" })
        expect(body.stream_options).toBeUndefined()
        expect(headers.get("authorization")).toBe("Bearer fixture-secret")
      }
      await run(await portOf(adapterFor({ provider: "custom-openai-responses", endpoint: endpoint.url })))
      expect(endpoint.seen.at(-1)?.body.store).toBe(false)
      // OpenAI, Meta, the xAI plan address, and the custom row.
      expect(endpoint.seen.length).toBe(4)
    } finally {
      await endpoint.stop()
    }
  })

  test("replays DeepSeek thinking on every assistant message while thinking is on", async () => {
    const toolCall = [
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"look at \"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"the file\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"a.ts\\\"}\"}}]}}]}\n\n",
      "data: [DONE]\n\n",
    ].join("")
    const endpoint = mock((_, count) => sse(count % 2 === 1 ? toolCall : CHAT_TEXT))
    try {
      const adapter = adapterFor({ provider: "deepseek", endpoint: endpoint.url })
      const followUp: RunrailContentModelRequest = { ...request, messages: [{ role: "user", text: "first" }, { role: "assistant", text: "earlier answer" }, { role: "user", text: "read it" }, { role: "tool", name: "read_file", text: "file body" }] }
      const thinking = await portOf(adapter, "high")
      expect(await run(thinking, { ...request, messages: followUp.messages.slice(0, 3) })).toEqual({ type: "tool", name: "read_file", input: { path: "a.ts" } })
      await run(thinking, followUp)
      expect(endpoint.seen[1]?.body.messages).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "earlier answer", reasoning_content: "" },
        { role: "user", content: "read it" },
        { role: "assistant", content: null, reasoning_content: "look at the file", tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
        { role: "tool", tool_call_id: "call_a", content: "file body" },
      ])
      const quiet = await portOf(adapter, "off")
      await run(quiet, { ...request, messages: followUp.messages.slice(0, 3) })
      await run(quiet, followUp)
      expect(JSON.stringify(endpoint.seen[3]?.body.messages)).not.toContain("reasoning_content")
      expect(endpoint.seen[3]?.body.thinking).toEqual({ type: "disabled" })
    } finally {
      await endpoint.stop()
    }
  })

  for (const status of [400, 422]) {
    test(`drops the single-tool-call flag when an endpoint answers ${status} and remembers it`, async () => {
      const endpoint = mock((seen) => "parallel_tool_calls" in seen.body ? refuse(status) : sse(CHAT_TEXT))
      try {
        const adapter = adapterFor({ provider: "groq", endpoint: endpoint.url })
        expect(await run(await portOf(adapter))).toEqual({ type: "text", text: "ok" })
        expect(endpoint.seen.map((seen) => "parallel_tool_calls" in seen.body)).toEqual([true, false])
        expect(endpoint.seen[1]?.body.tools).toEqual(endpoint.seen[0]?.body.tools)
        // A new port of the same adapter does not probe again.
        await run(await portOf(adapter))
        expect(endpoint.seen.length).toBe(3)
        expect("parallel_tool_calls" in endpoint.seen[2]!.body).toBe(false)
      } finally {
        await endpoint.stop()
      }
    })
  }

  test("drops a refused thinking switch before the tool flag, and keeps what was accepted", async () => {
    const endpoint = mock((seen) => "reasoning_effort" in seen.body ? refuse(400) : sse(CHAT_TEXT))
    try {
      const adapter = adapterFor({ provider: "groq", endpoint: endpoint.url })
      await run(await portOf(adapter, "high"))
      expect(endpoint.seen.map((seen) => ["reasoning_effort" in seen.body, "parallel_tool_calls" in seen.body])).toEqual([[true, true], [false, true]])
      await run(await portOf(adapter, "high"))
      expect(endpoint.seen.length).toBe(3)
      expect(endpoint.seen[2]?.body.reasoning_effort).toBeUndefined()
      expect(endpoint.seen[2]?.body.parallel_tool_calls).toBe(false)
    } finally {
      await endpoint.stop()
    }
  })

  test("gives up after the last combination and never retries other failures", async () => {
    const always = mock(() => refuse(400))
    const broken = mock(() => refuse(500))
    const locked = mock(() => refuse(401))
    try {
      expect(await failure(async () => run(await portOf(adapterFor({ provider: "groq", endpoint: always.url }), "high")))).toEqual({ code: "PROVIDER_FAILED", status: 400 })
      expect(always.seen.map((seen) => ["reasoning_effort" in seen.body, "parallel_tool_calls" in seen.body])).toEqual([[true, true], [false, true], [true, false], [false, false]])
      // Nothing to drop: no tools and no thinking switch means one request.
      always.seen.length = 0
      expect(await failure(async () => run(await portOf(adapterFor({ provider: "groq", endpoint: always.url })), plain))).toEqual({ code: "PROVIDER_FAILED", status: 400 })
      expect(always.seen.length).toBe(1)
      // A server error is sent again as it was, up to the default two retries, never with fields dropped.
      expect(await failure(async () => run(await portOf(adapterFor({ provider: "groq", endpoint: broken.url, retryDelayMs: 0 }), "high")))).toEqual({ code: "PROVIDER_FAILED", status: 500 })
      expect(broken.seen.map((seen) => ["reasoning_effort" in seen.body, "parallel_tool_calls" in seen.body])).toEqual([[true, true], [true, true], [true, true]])
      expect(await failure(async () => run(await portOf(adapterFor({ provider: "groq", endpoint: locked.url }), "high")))).toEqual({ code: "PROVIDER_AUTH_FAILED", status: 401 })
      expect(locked.seen.length).toBe(1)
    } finally {
      await always.stop()
      await broken.stop()
      await locked.stop()
    }
  })

  test("Messages rows send the key in their own header to a versioned path", async () => {
    const endpoint = mock(() => sse(MESSAGES_TEXT))
    try {
      for (const preset of PROVIDER_PRESETS.filter((row) => row.protocol === "anthropic-messages" && row.id !== "anthropic")) {
        expect(await run(await portOf(adapterFor({ provider: preset.id, endpoint: endpoint.url })))).toEqual({ type: "text", text: "ok" })
        const { path, headers, body } = endpoint.seen.at(-1)!
        expect(path).toBe("/v1/messages")
        // A plan sign-in's token is a Bearer token; a pasted key goes in the vendor's own header.
        expect(headers.get("x-api-key")).toBe(preset.signInOnly === true ? null : "fixture-secret")
        expect(headers.get("authorization")).toBe(preset.signInOnly === true ? "Bearer fixture-secret" : null)
        expect(headers.get("anthropic-version")).toBe("2023-06-01")
        expect(body.max_tokens).toBe(16_384)
        expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true })
      }
      expect(endpoint.seen.length).toBe(5)
      await run(await portOf(adapterFor({ provider: "custom-anthropic-bearer", endpoint: `${endpoint.url}relay/v1` })))
      expect(endpoint.seen.at(-1)?.path).toBe("/relay/v1/messages")
      expect(endpoint.seen.at(-1)?.headers.get("authorization")).toBe("Bearer fixture-secret")
      expect(endpoint.seen.at(-1)?.headers.get("x-api-key")).toBeNull()
      await run(await portOf(adapterFor({ provider: "custom-anthropic", endpoint: `${endpoint.url}relay` })))
      expect(endpoint.seen.at(-1)?.path).toBe("/relay/v1/messages")
      expect(endpoint.seen.at(-1)?.headers.get("x-api-key")).toBe("fixture-secret")
      // The family id keeps the address exactly as written.
      await run(await portOf(adapterFor({ provider: "anthropic", endpoint: endpoint.url })))
      expect(endpoint.seen.at(-1)?.path).toBe("/messages")
    } finally {
      await endpoint.stop()
    }
  })

  test("falls back to the smaller Messages cap once, only when the caller set none", async () => {
    const endpoint = mock((seen) => (seen.body.max_tokens as number) > 4_096 ? refuse(400) : sse(MESSAGES_TEXT))
    try {
      const adapter = adapterFor({ provider: "kimi-for-coding", endpoint: endpoint.url })
      expect(await run(await portOf(adapter))).toEqual({ type: "text", text: "ok" })
      expect(endpoint.seen.map((seen) => seen.body.max_tokens)).toEqual([16_384, 4_096])
      await run(await portOf(adapter))
      expect(endpoint.seen.map((seen) => seen.body.max_tokens)).toEqual([16_384, 4_096, 4_096])
      endpoint.seen.length = 0
      expect(await failure(async () => run(await portOf(adapterFor({ provider: "kimi-for-coding", endpoint: endpoint.url, maxOutputTokens: 8_192 }))))).toEqual({ code: "PROVIDER_FAILED", status: 400 })
      // A cap the caller chose is never lowered. The one thing left that nobody chose is the cache
      // marks, so the request goes out once more without them before the refusal stands.
      expect(endpoint.seen.map((seen) => seen.body.max_tokens)).toEqual([8_192, 8_192])
      expect(endpoint.seen.map((seen) => JSON.stringify(seen.body).includes("cache_control"))).toEqual([true, false])
    } finally {
      await endpoint.stop()
    }
  })

  test("names Runrail on every request and passes plain caller headers through", async () => {
    const chat = mock(() => sse(CHAT_TEXT))
    const messages = mock(() => sse(MESSAGES_TEXT))
    try {
      await run(await portOf(adapterFor({ provider: "openrouter", endpoint: chat.url, headers: { "x-title": "fixture" } })))
      await run(await portOf(adapterFor({ provider: "minimax", endpoint: messages.url })))
      expect(RUNRAIL_USER_AGENT).toMatch(/^runrail\/\d+\.\d+\.\d+/)
      expect(chat.seen[0]?.headers.get("user-agent")).toBe(RUNRAIL_USER_AGENT)
      expect(chat.seen[0]?.headers.get("x-title")).toBe("fixture")
      expect(messages.seen[0]?.headers.get("user-agent")).toBe(RUNRAIL_USER_AGENT)
    } finally {
      await chat.stop()
      await messages.stop()
    }
  })

  test("refuses a redirect instead of carrying the key to another address", async () => {
    const elsewhere = mock(() => sse(CHAT_TEXT))
    const endpoint = mock(() => new Response(null, { status: 307, headers: { location: `${elsewhere.url}chat/completions` } }))
    try {
      expect(await failure(async () => run(await portOf(adapterFor({ provider: "openrouter", endpoint: endpoint.url })), plain))).toEqual({ code: "PROVIDER_ENDPOINT_DENIED", status: 307 })
      expect(endpoint.seen.length).toBe(1)
      expect(elsewhere.seen.length).toBe(0)
    } finally {
      await endpoint.stop()
      await elsewhere.stop()
    }
  })

  test("refuses credentials in headers, plain http to a remote host, and a preset on a foreign host", async () => {
    for (const provider of ["openrouter", "kimi-for-coding"]) {
      for (const name of ["authorization", "Authorization", "x-api-key", "api-key", "cookie", "proxy-authorization"]) {
        expect(await failure(() => adapterFor({ provider, endpoint: "http://127.0.0.1:9/v1", headers: { [name]: "value" } }))).toEqual({ code: "PROVIDER_CREDENTIALS" })
      }
      expect(await failure(() => createConfiguredProviderModelAdapter({ provider, model: "fixture-model", credential: { kind: "caller", account: "fixture" }, apiKey: "raw" } as never))).toEqual({ code: "PROVIDER_CREDENTIALS" })
      // Remote needs an explicit opt-in, and plain http to a remote host needs a second one.
      expect(await failure(async () => portOf(adapterFor({ provider, endpoint: undefined })))).toEqual({ code: "PROVIDER_ENDPOINT_DENIED" })
      expect(await failure(async () => portOf(adapterFor({ provider, endpoint: "http://relay.example.test/v1", allowRemote: true })))).toEqual({ code: "PROVIDER_ENDPOINT_DENIED" })
      expect(await failure(async () => portOf(adapterFor({ provider, endpoint: "https://user:pass@relay.example.test/v1", allowRemote: true })))).toEqual({ code: "PROVIDER_ENDPOINT_DENIED" })
      // A host allowlist pins the preset to its own address.
      const host = new URL(PROVIDER_PRESETS.find((preset) => preset.id === provider)!.baseUrl).hostname
      expect(await failure(async () => portOf(adapterFor({ provider, endpoint: "https://relay.example.test/v1", allowRemote: true, allowedHosts: [host] })))).toEqual({ code: "PROVIDER_ENDPOINT_DENIED" })
      await portOf(adapterFor({ provider, endpoint: undefined, allowRemote: true, allowedHosts: [host] }))
    }
  })

  test("refuses an id with no row unless it names its endpoint and protocol", async () => {
    expect(await failure(() => adapterFor({ provider: "example-relay", endpoint: undefined }))).toEqual({ code: "PROVIDER_INVALID" })
    expect(await failure(() => adapterFor({ provider: "example-relay", endpoint: "http://127.0.0.1:9/v1" }))).toEqual({ code: "PROVIDER_INVALID" })
    const endpoint = mock(() => sse(CHAT_TEXT))
    try {
      const adapter = adapterFor({ provider: "example-relay", endpoint: endpoint.url, protocol: "chat", quirks: { thinking: "qwen", streamOptions: false }, displayName: "Example Relay", maxOutputTokens: 32 })
      expect(adapter.provider).toMatchObject({ id: "example-relay", name: "Example Relay" })
      await run(await portOf(adapter, "low"))
      expect(endpoint.seen[0]?.body).toMatchObject({ max_tokens: 32, enable_thinking: true })
      expect(endpoint.seen[0]?.body.stream_options).toBeUndefined()
    } finally {
      await endpoint.stop()
    }
  })
})
