import { describe, expect, test } from "bun:test"
import { createAnthropicModelPort, createCallerCredentialResolver, createOpenAIModelPort } from "../../src/index.ts"
import type { NativeModelChunk, NativeModelResponse } from "@nifrajs/coding-agent"
import type { RunrailContentModelRequest } from "../../src/model/content.ts"

const request: RunrailContentModelRequest = {
  sessionId: "provider-session",
  cwd: "/tmp",
  messages: [{ role: "user", text: "inspect the image" }],
  tools: [{ name: "read_file", description: "Read a file", capabilities: ["filesystem.read"] }],
  signal: new AbortController().signal,
  parts: [{ kind: "text", text: "inspect the image" }, { kind: "image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=", bytes: 8 }],
}

async function collect(source: NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk>): Promise<readonly NativeModelChunk[]> {
  if (isAsyncIterable(source)) {
    const result: NativeModelChunk[] = []
    for await (const chunk of source) result.push(chunk)
    return result
  }
  return [{ type: "response", response: await source }]
}

function isAsyncIterable(value: unknown): value is AsyncIterable<NativeModelChunk> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function"
}

describe("first-party provider adapters", () => {
  test("maps OpenAI Chat streaming text, content, tools, auth, and usage", async () => {
    let body: Record<string, unknown> | undefined
    let auth = ""
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        body = await request.json() as Record<string, unknown>
        auth = request.headers.get("authorization") ?? ""
        const stream = [
          "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\n",
          "data: [DONE]\n\n",
        ].join("")
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const port = createOpenAIModelPort({ provider: "openai", model: "gpt-fixture", protocol: "openai-chat", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret"), allowRemote: false, thinking: "off" })
      const chunks = await collect(port.complete(request))
      expect(chunks).toContainEqual({ type: "text_delta", text: "hello" })
      expect(chunks.at(-1)).toEqual({ type: "response", response: { type: "text", text: "hello" } })
      expect(auth).toBe("Bearer fixture-secret")
      expect(body?.model).toBe("gpt-fixture")
      expect(body?.stream).toBe(true)
      expect(JSON.stringify(body)).toContain("image_url")
      expect(port.lastUsage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    } finally {
      await server.stop()
    }
  })

  test("an OpenAI Chat chunk carrying empty content beside its tool call keeps the call, and every call in a chunk is read", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = [
          "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}},{\"index\":1,\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{}\"}}]}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{\"content\":\"\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"a.ts\\\"}\"}}]}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\n",
          "data: [DONE]\n\n",
        ].join("")
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const port = createOpenAIModelPort({ provider: "openai", model: "gpt-fixture", protocol: "openai-chat", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret"), allowRemote: false, thinking: "off" })
      const chunks = await collect(port.complete({ ...request, parts: [] }))
      expect(chunks.at(-1)).toEqual({ type: "response", response: { type: "tool", name: "read_file", input: { path: "a.ts" } } })
      expect(chunks.some((chunk) => chunk.type === "text_delta")).toBe(false)
      expect(port.lastUsage).toMatchObject({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    } finally {
      await server.stop()
    }
  })

  test("maps OpenAI Responses tool arguments and Anthropic Messages streaming", async () => {
    let openaiBody: Record<string, unknown> | undefined
    const openai = Bun.serve({
      port: 0,
      fetch: async (request) => {
        openaiBody = await request.json() as Record<string, unknown>
        return Response.json({ output: [{ type: "function_call", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }], usage: { input_tokens: 3, output_tokens: 4 } })
      },
    })
    const anthropic = Bun.serve({
      port: 0,
      fetch: () => {
        const stream = [
          "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4}}}\n\n",
          "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"claude\"}}\n\n",
          "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2}}\n\n",
          "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ].join("")
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const openaiPort = createOpenAIModelPort({ provider: "openai", model: "responses-fixture", protocol: "openai-responses", endpoint: openai.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off" })
      const openaiChunks = await collect(openaiPort.complete({ ...request, parts: [] }))
      expect(openaiChunks.at(-1)).toEqual({ type: "response", response: { type: "tool", name: "read_file", input: { path: "a.ts" } } })
      expect(openaiBody?.model).toBe("responses-fixture")
      const anthropicPort = createAnthropicModelPort({ provider: "anthropic", model: "claude-fixture", endpoint: anthropic.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off" })
      const anthropicChunks = await collect(anthropicPort.complete(request))
      expect(anthropicChunks).toContainEqual({ type: "text_delta", text: "claude" })
      expect(anthropicChunks.at(-1)).toEqual({ type: "response", response: { type: "text", text: "claude" } })
      expect(anthropicPort.lastUsage).toMatchObject({ inputTokens: 4, outputTokens: 2 })
    } finally {
      await openai.stop()
      await anthropic.stop()
    }
  })

  test("a reply cut off at the output limit is marked, and a cut-off tool call is refused", async () => {
    const sse = (events: readonly string[]) => new Response(events.map((event) => `data: ${event}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    const replies: Record<string, () => Response> = {
      "chat-text": () => sse(['{"choices":[{"delta":{"content":"partial"}}]}', '{"choices":[{"delta":{},"finish_reason":"length"}]}', "[DONE]"]),
      "chat-tool": () => sse(['{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}', '{"choices":[{"delta":{},"finish_reason":"length"}]}', "[DONE]"]),
      "responses-text": () => sse(['{"type":"response.output_text.delta","delta":"partial"}', '{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}']),
      "anthropic-text": () => sse(['{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', '{"type":"content_block_delta","index":0,"delta":{"text":"partial"}}', '{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}']),
      "anthropic-tool": () => sse(['{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"read_file","input":{}}}', '{"type":"content_block_delta","index":0,"delta":{"partial_json":"{\\"pa"}}', '{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}']),
    }
    const server = Bun.serve({ port: 0, fetch: (incoming) => replies[new URL(incoming.url).pathname.split("/")[1] ?? ""]?.() ?? new Response("missing", { status: 404 }) })
    const credential = { credential: { kind: "caller" as const, account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off" as const }
    const openai = (name: string, protocol: "openai-chat" | "openai-responses") => createOpenAIModelPort({ provider: "openai", model: "fixture", protocol, endpoint: `${server.url.toString()}${name}`, ...credential })
    const anthropic = (name: string) => createAnthropicModelPort({ provider: "anthropic", model: "fixture", endpoint: `${server.url.toString()}${name}`, ...credential })
    try {
      for (const port of [openai("chat-text", "openai-chat"), openai("responses-text", "openai-responses"), anthropic("anthropic-text")]) {
        const chunks = await collect(port.complete({ ...request, parts: [] }))
        expect(chunks.at(-1)).toMatchObject({ type: "response", response: { type: "text", text: expect.stringContaining("partial\n\n[Runrail: this reply was cut off") } })
      }
      for (const port of [openai("chat-tool", "openai-chat"), anthropic("anthropic-tool")]) {
        await expect(collect(port.complete({ ...request, parts: [] }))).rejects.toMatchObject({ code: "PROVIDER_OUTPUT_TRUNCATED" })
      }
    } finally {
      await server.stop()
    }
  })

  test("a stream that ends before its protocol's last event is marked as cut, and its tool call is refused", async () => {
    const sse = (events: readonly string[]) => new Response(events.map((event) => `data: ${event}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    const replies: Record<string, () => Response> = {
      "chat-text": () => sse(['{"choices":[{"delta":{"content":"partial"}}]}']),
      "chat-tool": () => sse(['{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}']),
      "chat-empty": () => sse([]),
      "responses-text": () => sse(['{"type":"response.output_text.delta","delta":"partial"}']),
      "responses-tool": () => sse(['{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c","name":"read_file"}}', '{"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":\\"a\\"}"}']),
      "responses-done": () => sse(['{"type":"response.output_text.delta","delta":"whole"}', '{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}']),
      "anthropic-text": () => sse(['{"type":"content_block_delta","index":0,"delta":{"text":"partial"}}']),
      "anthropic-tool": () => sse(['{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"read_file","input":{}}}', '{"type":"content_block_delta","index":0,"delta":{"partial_json":"{\\"path\\":\\"a\\"}"}}']),
    }
    const server = Bun.serve({ port: 0, fetch: (incoming) => replies[new URL(incoming.url).pathname.split("/")[1] ?? ""]?.() ?? new Response("missing", { status: 404 }) })
    const credential = { credential: { kind: "caller" as const, account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off" as const }
    const openai = (name: string, protocol: "openai-chat" | "openai-responses") => createOpenAIModelPort({ provider: "openai", model: "fixture", protocol, endpoint: `${server.url.toString()}${name}`, ...credential })
    const anthropic = (name: string) => createAnthropicModelPort({ provider: "anthropic", model: "fixture", endpoint: `${server.url.toString()}${name}`, ...credential })
    try {
      for (const port of [openai("chat-text", "openai-chat"), openai("responses-text", "openai-responses"), anthropic("anthropic-text")]) {
        const chunks = await collect(port.complete({ ...request, parts: [] }))
        expect(chunks.at(-1)).toMatchObject({ type: "response", response: { type: "text", text: "partial\n\n[Runrail: the connection ended before the model finished this reply]" } })
      }
      for (const port of [openai("chat-tool", "openai-chat"), openai("responses-tool", "openai-responses"), anthropic("anthropic-tool"), openai("chat-empty", "openai-chat")]) {
        await expect(collect(port.complete({ ...request, parts: [] }))).rejects.toMatchObject({ code: "PROVIDER_STREAM_FAILED" })
      }
      const finished = openai("responses-done", "openai-responses")
      expect((await collect(finished.complete({ ...request, parts: [] }))).at(-1)).toEqual({ type: "response", response: { type: "text", text: "whole" } })
      expect(finished.lastUsage).toMatchObject({ inputTokens: 3, outputTokens: 1 })
    } finally {
      await server.stop()
    }
  })

  test("a reply streamed as far more than 8,192 token events completes", async () => {
    const deltas = 20_000
    const chat = Array.from({ length: deltas }, () => 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n').join("") + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const messages = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
      + Array.from({ length: deltas }, () => 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n').join("")
      + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n'
    const server = Bun.serve({ port: 0, fetch: (incoming) => new Response(new URL(incoming.url).pathname.startsWith("/chat") ? chat : messages, { headers: { "content-type": "text/event-stream" } }) })
    const credential = { credential: { kind: "caller" as const, account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off" as const }
    try {
      const openai = createOpenAIModelPort({ provider: "openai", model: "fixture", protocol: "openai-chat", endpoint: server.url.toString(), ...credential })
      const anthropic = createAnthropicModelPort({ provider: "anthropic", model: "fixture", endpoint: server.url.toString(), ...credential })
      for (const port of [openai, anthropic]) {
        const chunks = await collect(port.complete({ ...request, parts: [] }))
        expect(chunks.at(-1)).toEqual({ type: "response", response: { type: "text", text: "x".repeat(deltas) } })
      }
    } finally {
      await server.stop(true)
    }
  })

  test("a model request refused as overloaded before streaming is sent again; one cut mid-stream is not", async () => {
    let requests = 0
    let reply = (): Response => new Response("overloaded", { status: 529 })
    const server = Bun.serve({ port: 0, fetch: () => { requests += 1; const answer = reply(); reply = () => new Response('data: {"type":"content_block_delta","index":0,"delta":{"text":"done"}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } }); return answer } })
    try {
      const port = createAnthropicModelPort({ provider: "anthropic", model: "fixture", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off", retryDelayMs: 0 })
      expect((await collect(port.complete({ ...request, parts: [] }))).at(-1)).toEqual({ type: "response", response: { type: "text", text: "done" } })
      expect(requests).toBe(2)
      requests = 0
      reply = () => new Response('data: {"type":"content_block_delta","index":0,"delta":{"text":"partial"}}\n\n', { headers: { "content-type": "text/event-stream" } })
      expect((await collect(port.complete({ ...request, parts: [] }))).at(-1)).toMatchObject({ type: "response", response: { type: "text", text: expect.stringContaining("the connection ended") } })
      expect(requests).toBe(1)
    } finally {
      await server.stop(true)
    }
  })

  test("a 400 about the conversation itself is not sent again; one about an optional field is", async () => {
    let requests = 0
    let reply = (_body: Record<string, unknown>): Response => Response.json({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }, { status: 400 })
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        requests += 1
        return reply(await incoming.json() as Record<string, unknown>)
      },
    })
    try {
      const options = { provider: "anthropic", model: "claude-fixture", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off" } as const
      await expect(collect(createAnthropicModelPort(options).complete({ ...request, parts: [] }))).rejects.toMatchObject({ status: 400 })
      expect(requests).toBe(1)
      requests = 0
      reply = (body) => body.max_tokens === 16_384
        ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: 16384 > 8192, which is the maximum allowed" } }, { status: 400 })
        : new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
      const chunks = await collect(createAnthropicModelPort(options).complete({ ...request, parts: [] }))
      expect(chunks.at(-1)).toEqual({ type: "response", response: { type: "text", text: "ok" } })
      expect(requests).toBe(2)
    } finally {
      await server.stop()
    }
  })

  test("replays an OpenAI Chat tool call and its result as a call and answer pair", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        bodies.push(await incoming.json() as Record<string, unknown>)
        const stream = bodies.length === 1
          ? [
              "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_fixture\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n",
              "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"a.ts\\\"}\"}}]}}]}\n\n",
              "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_second\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}]}\n\n",
              "data: [DONE]\n\n",
            ].join("")
          : "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\ndata: [DONE]\n\n"
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const options = { provider: "openai", model: "gpt-fixture", protocol: "openai-chat", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret"), thinking: "off" } as const
      const port = createOpenAIModelPort(options)
      const first = await collect(port.complete({ ...request, parts: [] }))
      expect(first.at(-1)).toEqual({ type: "response", response: { type: "tool", name: "read_file", input: { path: "a.ts" } } })
      const followUp: RunrailContentModelRequest = { ...request, parts: [], messages: [...request.messages, { role: "tool", name: "read_file", text: "file body" }] }
      await collect(port.complete(followUp))
      expect(bodies[1]?.messages).toEqual([
        { role: "user", content: "inspect the image" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_fixture", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "file body" },
      ])
      expect(bodies[1]?.parallel_tool_calls).toBe(false)
      expect(bodies[1]?.tools).toEqual([{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path." } }, required: ["path"], additionalProperties: false } } }])
      // A result at the same ordinal but another position belongs to a call this port did not make.
      await collect(port.complete({ ...followUp, messages: [{ role: "assistant", text: "earlier" }, ...followUp.messages] }))
      expect((bodies[2]?.messages as unknown[]).at(-1)).toEqual({ role: "user", content: "[result of tool read_file]\nfile body" })
      bodies.length = 2
      // A port that never saw the call (a restart, a model switch) cannot name it, so the result goes as text.
      await collect(createOpenAIModelPort(options).complete(followUp))
      expect(bodies[2]?.messages).toEqual([{ role: "user", content: "inspect the image" }, { role: "user", content: "[result of tool read_file]\nfile body" }])
    } finally {
      await server.stop()
    }
  })

  test("drops the reasoning parameter once an OpenAI model refuses it", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        const body = await incoming.json() as Record<string, unknown>
        bodies.push(body)
        if ("reasoning_effort" in body) return Response.json({ error: { message: "unsupported parameter" } }, { status: 400 })
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const port = createOpenAIModelPort({ provider: "openai", model: "gpt-fixture", protocol: "openai-chat", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret"), thinking: "medium" })
      expect((await collect(port.complete({ ...request, parts: [] }))).at(-1)).toEqual({ type: "response", response: { type: "text", text: "ok" } })
      expect((await collect(port.complete({ ...request, parts: [] }))).at(-1)).toEqual({ type: "response", response: { type: "text", text: "ok" } })
      expect(bodies.map((body) => "reasoning_effort" in body)).toEqual([true, false, false])
    } finally {
      await server.stop()
    }
  })

  test("replays an OpenAI Responses tool call and marks assistant text as output", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        bodies.push(await incoming.json() as Record<string, unknown>)
        return Response.json(bodies.length === 1
          ? { output: [{ type: "function_call", call_id: "call_fixture", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }] }
          : { output_text: "done" })
      },
    })
    try {
      const port = createOpenAIModelPort({ provider: "openai", model: "responses-fixture", protocol: "openai-responses", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret"), thinking: "off" })
      await collect(port.complete({ ...request, parts: [] }))
      await collect(port.complete({ ...request, parts: [], messages: [...request.messages, { role: "tool", name: "read_file", text: "file body" }, { role: "assistant", text: "summary" }, { role: "user", text: "next" }] }))
      expect(bodies[1]?.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "inspect the image" }] },
        { type: "function_call", call_id: "call_fixture", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
        { type: "function_call_output", call_id: "call_fixture", output: "file body" },
        { role: "assistant", content: [{ type: "output_text", text: "summary" }] },
        { role: "user", content: [{ type: "input_text", text: "next" }] },
      ])
      expect(bodies[1]?.parallel_tool_calls).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test("replays an Anthropic tool call with its signed thinking block", async () => {
    const bodies: Record<string, unknown>[] = []
    const event = (value: Record<string, unknown>) => `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        bodies.push(await incoming.json() as Record<string, unknown>)
        const stream = bodies.length === 1
          ? [
              event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
              event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "look at the file" } }),
              event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-fixture" } }),
              event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_fixture", name: "read_file", input: {} } }),
              event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }),
              event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } }),
              event({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_second", name: "read_file", input: {} } }),
              event({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":\"b.ts\"}" } }),
              event({ type: "message_stop" }),
            ].join("")
          : event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const options = { provider: "anthropic", model: "claude-fixture", maxOutputTokens: 4_096, endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "secret") } as const
      const port = createAnthropicModelPort({ ...options, thinking: "high" })
      const first = await collect(port.complete({ ...request, parts: [] }))
      expect(first.at(-1)).toEqual({ type: "response", response: { type: "tool", name: "read_file", input: { path: "a.ts" } } })
      const followUp: RunrailContentModelRequest = { ...request, parts: [], messages: [...request.messages, { role: "tool", name: "read_file", text: "file body" }, { role: "assistant", text: "" }] }
      await collect(port.complete(followUp))
      expect(bodies[1]?.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "inspect the image" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "look at the file", signature: "sig-fixture" }, { type: "tool_use", id: "toolu_fixture", name: "read_file", input: { path: "a.ts" } }] },
        // The newest message carries the mark the endpoint may cache the conversation up to.
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "file body", cache_control: { type: "ephemeral" } }] },
      ])
      // High gives half the answer cap to thinking, at or above the API minimum and below the cap.
      expect(bodies[1]?.thinking).toEqual({ type: "enabled", budget_tokens: 2_048 })
      expect(bodies[1]?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true })
      await collect(createAnthropicModelPort({ ...options, thinking: "minimal" }).complete(followUp))
      expect(bodies[2]?.thinking).toEqual({ type: "enabled", budget_tokens: 1_024 })
      expect(bodies[2]?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "inspect the image" }] }, { role: "user", content: [{ type: "text", text: "[result of tool read_file]\nfile body", cache_control: { type: "ephemeral" } }] }])
      // A call rebuilt from the transcript has no signed thinking, so the request that answers it goes without thinking.
      const restored = { role: "tool", name: "read_file", text: "file body", call: { input: { path: "a.ts" } } } as unknown as RunrailContentModelRequest["messages"][number]
      await collect(createAnthropicModelPort({ ...options, thinking: "high" }).complete({ ...request, parts: [], messages: [...request.messages, restored] }))
      expect((bodies[3]?.messages as Record<string, unknown>[] | undefined)?.at(-2)).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "toolu_restored_0" }] })
      expect(bodies[3]?.thinking).toBeUndefined()
    } finally {
      await server.stop()
    }
  })
})
