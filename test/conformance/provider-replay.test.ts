import { describe, expect, test } from "bun:test"
import type { NativeModelChunk, NativeModelPort, NativeModelResponse } from "@nifrajs/coding-agent"
import { createCallerCredentialResolver, createConfiguredProviderModelAdapter } from "../../src/index.ts"
import type { ProviderModelOptions, ThinkingLevel } from "../../src/index.ts"
import type { RunrailContentModelRequest } from "../../src/model/content.ts"
import { SHORTENED_TOOL_RESULT, type RestoredToolMessage } from "../../src/providers/tool-history.ts"

type Body = Record<string, unknown>

const base: RunrailContentModelRequest = {
  sessionId: "replay-session",
  cwd: "/tmp",
  messages: [{ role: "user", text: "read it" }],
  tools: [{ name: "read_file", description: "Read a file", capabilities: ["filesystem.read"] }],
  signal: new AbortController().signal,
  parts: [],
}

const named = (value: Record<string, unknown>): string => `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`
const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } })
const refuse = () => Response.json({ error: { message: "unsupported parameter" } }, { status: 400 })
const MESSAGES_TEXT = named({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) + named({ type: "message_stop" })

function mock(reply: (body: Body) => Response) {
  const bodies: Body[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const body = await incoming.json() as Body
      bodies.push(body)
      return reply(body)
    },
  })
  return { bodies, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

function adapterFor(options: Partial<ProviderModelOptions> & Pick<ProviderModelOptions, "provider" | "endpoint">) {
  return createConfiguredProviderModelAdapter({ model: "fixture-model", maxOutputTokens: 1_024, credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret"), ...options })
}

async function portOf(adapter: ReturnType<typeof adapterFor>, thinking: ThinkingLevel = "off"): Promise<NativeModelPort & { readonly lastUsage?: unknown }> {
  return adapter.create({ cwd: "/tmp", descriptor: adapter.descriptor, quality: "balanced", thinking }) as Promise<NativeModelPort & { readonly lastUsage?: unknown }>
}

async function run(port: NativeModelPort, input: RunrailContentModelRequest = base): Promise<NativeModelResponse> {
  let last: NativeModelResponse | undefined
  for await (const chunk of port.complete(input) as AsyncIterable<NativeModelChunk>) if (chunk.type === "response") last = chunk.response
  if (last === undefined) throw new Error("no response chunk")
  return last
}

const marked = (body: Body): boolean => JSON.stringify(body).includes("cache_control")

describe("prompt caching on Messages endpoints", () => {
  test("marks the instructions and the newest message; with no instructions, the tool list", async () => {
    const endpoint = mock(() => sse(MESSAGES_TEXT))
    try {
      const port = await portOf(adapterFor({ provider: "custom-anthropic", endpoint: endpoint.url }))
      await run(port, { ...base, system: "Be brief." })
      const [withSystem] = endpoint.bodies
      expect(withSystem?.system).toEqual([{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }])
      expect((withSystem?.tools as Body[])[0]).not.toHaveProperty("cache_control")
      expect(withSystem?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "read it", cache_control: { type: "ephemeral" } }] }])

      await run(port)
      const noSystem = endpoint.bodies[1]!
      expect(noSystem).not.toHaveProperty("system")
      expect((noSystem.tools as Body[]).at(-1)).toMatchObject({ name: "read_file", cache_control: { type: "ephemeral" } })
    } finally {
      await endpoint.stop()
    }
  })

  test("an endpoint that refuses the marks gets the turn again without them, and never sees them again", async () => {
    const endpoint = mock((body) => marked(body) ? refuse() : sse(MESSAGES_TEXT))
    try {
      const adapter = adapterFor({ provider: "custom-anthropic", endpoint: endpoint.url })
      expect(await run(await portOf(adapter), { ...base, system: "Be brief." })).toEqual({ type: "text", text: "ok" })
      expect(endpoint.bodies.map(marked)).toEqual([true, false])
      // The unmarked request still carries the instructions.
      expect(endpoint.bodies[1]?.system).toEqual([{ type: "text", text: "Be brief." }])
      // What was learned belongs to the adapter, so a later turn asks once.
      await run(await portOf(adapter), { ...base, system: "Be brief." })
      expect(endpoint.bodies.map(marked)).toEqual([true, false, false])
    } finally {
      await endpoint.stop()
    }
  })

  test("counts cached input inside the input total and reports it apart", async () => {
    const endpoint = mock(() => sse([
      named({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 1 } } }),
      named({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
      named({ type: "message_delta", usage: { output_tokens: 7 } }),
      named({ type: "message_stop" }),
    ].join("")))
    try {
      const port = await portOf(adapterFor({ provider: "custom-anthropic", endpoint: endpoint.url }))
      await run(port)
      expect(port.lastUsage).toMatchObject({ inputTokens: 960, outputTokens: 7, cacheReadTokens: 900, cacheWriteTokens: 50 })
    } finally {
      await endpoint.stop()
    }
  })
})

describe("thinking on Messages endpoints", () => {
  test("each level gives a larger share of the answer cap, and never all of it", async () => {
    const endpoint = mock(() => sse(MESSAGES_TEXT))
    try {
      const budgets: Record<string, unknown> = {}
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        await run(await portOf(adapterFor({ provider: "custom-anthropic", endpoint: endpoint.url, maxOutputTokens: 16_384 }), level))
        budgets[level] = (endpoint.bodies.at(-1)?.thinking as { budget_tokens?: number } | undefined)?.budget_tokens
      }
      expect(budgets).toEqual({ off: undefined, minimal: 1_024, low: 2_048, medium: 4_096, high: 8_192, xhigh: 12_288, max: 15_360 })
      // A small cap still leaves the answer 1,024 tokens, and a cap too small for both sends no thinking.
      await run(await portOf(adapterFor({ provider: "custom-anthropic", endpoint: endpoint.url, maxOutputTokens: 2_048 }), "max"))
      expect(endpoint.bodies.at(-1)?.thinking).toEqual({ type: "enabled", budget_tokens: 1_024 })
      await run(await portOf(adapterFor({ provider: "custom-anthropic", endpoint: endpoint.url, maxOutputTokens: 1_500 }), "high"))
      expect(endpoint.bodies.at(-1)).not.toHaveProperty("thinking")
    } finally {
      await endpoint.stop()
    }
  })

  test("levels past high run as high on OpenAI-style endpoints", async () => {
    const endpoint = mock(() => sse(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`))
    try {
      for (const level of ["xhigh", "max"] as const) await run(await portOf(adapterFor({ provider: "custom-openai-chat", endpoint: endpoint.url }), level))
      expect(endpoint.bodies.map((body) => body.reasoning_effort)).toEqual(["high", "high"])
    } finally {
      await endpoint.stop()
    }
  })
})

describe("cached input on OpenAI protocols", () => {
  test("Chat and Responses report the cached part of the prompt", async () => {
    const chat = mock(() => sse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103, prompt_tokens_details: { cached_tokens: 64 } } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")))
    const responses = mock(() => Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 80, output_tokens: 2, input_tokens_details: { cached_tokens: 32 } } }))
    try {
      const chatPort = await portOf(adapterFor({ provider: "custom-openai-chat", endpoint: chat.url }))
      await run(chatPort)
      expect(chatPort.lastUsage).toMatchObject({ inputTokens: 100, outputTokens: 3, cacheReadTokens: 64 })
      const responsesPort = await portOf(adapterFor({ provider: "custom-openai-responses", endpoint: responses.url }))
      await run(responsesPort)
      expect(responsesPort.lastUsage).toMatchObject({ inputTokens: 80, outputTokens: 2, cacheReadTokens: 32 })
    } finally {
      await chat.stop()
      await responses.stop()
    }
  })
})

describe("a reasoning level the model refuses", () => {
  const CHAT_TEXT = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`

  test("is learned for that level only, said once per port, and never sent again", async () => {
    // This model takes low, and refuses high.
    const endpoint = mock((body) => body.reasoning_effort === "high" ? refuse() : sse(CHAT_TEXT))
    const notices: unknown[] = []
    try {
      const adapter = adapterFor({ provider: "custom-openai-chat", endpoint: endpoint.url, onNotice: (notice) => notices.push(notice) })
      const high = await portOf(adapter, "high")
      expect(await run(high)).toEqual({ type: "text", text: "ok" })
      await run(high)
      expect(endpoint.bodies.map((body) => body.reasoning_effort ?? null)).toEqual(["high", null, null])
      expect(notices).toEqual([{ code: "THINKING_REFUSED", thinking: "high" }])

      // Another level is still tried; a new port for the refused one goes without at once, and says so.
      await run(await portOf(adapter, "low"))
      await run(await portOf(adapter, "high"))
      expect(endpoint.bodies.slice(3).map((body) => body.reasoning_effort ?? null)).toEqual(["low", null])
      expect(notices).toEqual([{ code: "THINKING_REFUSED", thinking: "high" }, { code: "THINKING_REFUSED", thinking: "high" }])
    } finally {
      await endpoint.stop()
    }
  })

  test("a notice sink that throws does not stop the turn, and a sink that is not a function is refused", async () => {
    const endpoint = mock((body) => body.reasoning_effort === undefined ? sse(CHAT_TEXT) : refuse())
    try {
      const adapter = adapterFor({ provider: "custom-openai-chat", endpoint: endpoint.url, onNotice: () => { throw new Error("sink failure") } })
      expect(await run(await portOf(adapter, "medium"))).toEqual({ type: "text", text: "ok" })
      expect(() => adapterFor({ provider: "custom-openai-chat", endpoint: endpoint.url, onNotice: "not a function" as never })).toThrow("provider notice sink is invalid")
    } finally {
      await endpoint.stop()
    }
  })
})

describe("sealed reasoning on Responses", () => {
  const TOOL_TURN = [
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ type: "summary_text", text: "check the file" }], encrypted_content: "sealed-1" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "read_file" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"path\":\"a.ts\"}" },
    { type: "response.completed", response: { status: "completed" } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  const TEXT_TURN = [{ type: "response.output_text.delta", delta: "done" }, { type: "response.completed", response: { status: "completed" } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  const afterTool: RunrailContentModelRequest = { ...base, messages: [...base.messages, { role: "tool", name: "read_file", text: "file body" }] }

  test("asks for sealed reasoning while thinking is on and sends it back before its call", async () => {
    const endpoint = mock((body) => sse((body.input as Body[]).some((item) => item.type === "function_call_output") ? TEXT_TURN : TOOL_TURN))
    try {
      const port = await portOf(adapterFor({ provider: "custom-openai-responses", endpoint: endpoint.url }), "high")
      expect(await run(port)).toEqual({ type: "tool", name: "read_file", input: { path: "a.ts" } })
      await run(port, afterTool)
      const [first, second] = endpoint.bodies
      expect(first).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "high" } })
      expect((second?.input as Body[]).slice(1)).toEqual([
        { type: "reasoning", summary: [{ type: "summary_text", text: "check the file" }], encrypted_content: "sealed-1" },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
        { type: "function_call_output", call_id: "call_1", output: "file body" },
      ])
    } finally {
      await endpoint.stop()
    }
  })

  test("with thinking off, nothing sealed is asked for or sent", async () => {
    const endpoint = mock((body) => sse((body.input as Body[]).some((item) => item.type === "function_call_output") ? TEXT_TURN : TOOL_TURN))
    try {
      const port = await portOf(adapterFor({ provider: "custom-openai-responses", endpoint: endpoint.url }), "off")
      await run(port)
      await run(port, afterTool)
      for (const body of endpoint.bodies) {
        expect(body).not.toHaveProperty("include")
        expect(JSON.stringify(body)).not.toContain("sealed-1")
      }
    } finally {
      await endpoint.stop()
    }
  })

  test("an endpoint that refuses the request for it is asked once, then never again", async () => {
    const endpoint = mock((body) => "include" in body ? refuse() : sse(TEXT_TURN))
    try {
      const adapter = adapterFor({ provider: "custom-openai-responses", endpoint: endpoint.url })
      expect(await run(await portOf(adapter, "high"))).toEqual({ type: "text", text: "done" })
      expect(endpoint.bodies.map((body) => "include" in body)).toEqual([true, false])
      // Thinking itself was not what the endpoint refused.
      expect(endpoint.bodies[1]?.reasoning).toEqual({ effort: "high" })
      await run(await portOf(adapter, "high"))
      expect(endpoint.bodies.map((body) => "include" in body)).toEqual([true, false, false])
    } finally {
      await endpoint.stop()
    }
  })
})

describe("long conversations", () => {
  const restored = (index: number, text: string, input: unknown): RestoredToolMessage => ({ role: "tool", name: "read_file", text, call: { input } }) as RestoredToolMessage
  const TEXT_OK = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`

  test("shortens the oldest tool results to fit, keeps the newest whole, and keeps the start stable", async () => {
    const endpoint = mock(() => sse(TEXT_OK))
    try {
      // The smallest window: 24,000 characters.
      const port = await portOf(adapterFor({ provider: "custom-openai-chat", endpoint: endpoint.url, descriptor: { contextTokens: 1_000 } }))
      const tools = Array.from({ length: 10 }, (_, index) => restored(index, `${index}:${"y".repeat(3_000)}`, { path: `f${index}.ts`, note: index === 0 ? "n".repeat(1_000) : "short" }))
      const first: RunrailContentModelRequest = { ...base, sessionId: "long", messages: [{ role: "user", text: "start" }, ...tools, { role: "user", text: "next" }] }
      await run(port, first)
      const body = endpoint.bodies[0]!
      const results = (body.messages as Body[]).filter((message) => message.role === "tool")
      // Messages 0-5 were over the line: the five oldest results. The six newest messages stay whole.
      expect(results.map((message) => message.content === SHORTENED_TOOL_RESULT)).toEqual([true, true, true, true, true, false, false, false, false, false])
      expect(String(results[5]?.content)).toStartWith("5:yyy")
      // The call stays, so the model still sees what it did; its long arguments are clipped.
      const oldestCall = ((body.messages as Body[])[1]?.tool_calls as Body[])[0]!.function as Body
      expect(JSON.parse(String(oldestCall.arguments))).toEqual({ path: "f0.ts", note: `${"n".repeat(400)} [...]` })
      expect(oldestCall.name).toBe("read_file")

      // One more exchange still fits: the start of the request does not move, so a provider's
      // prompt cache keeps matching.
      await run(port, { ...first, messages: [...first.messages, { role: "assistant", text: "ok" }, { role: "user", text: "again" }] })
      const again = endpoint.bodies[1]!.messages as Body[]
      const before = body.messages as Body[]
      expect(again.slice(0, before.length - 1)).toEqual(before.slice(0, -1))
    } finally {
      await endpoint.stop()
    }
  })

  test("a conversation that fits is sent whole", async () => {
    const endpoint = mock(() => sse(TEXT_OK))
    try {
      const port = await portOf(adapterFor({ provider: "custom-openai-chat", endpoint: endpoint.url }))
      const tools = Array.from({ length: 10 }, (_, index) => restored(index, `${index}:${"y".repeat(3_000)}`, { path: `f${index}.ts` }))
      await run(port, { ...base, sessionId: "fits", messages: [{ role: "user", text: "start" }, ...tools, { role: "user", text: "next" }] })
      expect(JSON.stringify(endpoint.bodies[0])).not.toContain(SHORTENED_TOOL_RESULT)
    } finally {
      await endpoint.stop()
    }
  })
})
