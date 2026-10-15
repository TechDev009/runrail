import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import type { NativeModelChunk, NativeModelResponse } from "@nifrajs/coding-agent"
import { createAnthropicModelPort, createCallerCredentialResolver, createOpenAIModelPort, LiveFrameCursorError, LiveFrameHub, mapClaudeCodeEvent, mapCodexEvent } from "../../src/index.ts"
import type { RunrailLiveFrameInput } from "../../src/index.ts"
import type { RunrailContentModelRequest } from "../../src/model/content.ts"

function event(seq: number, body: Record<string, unknown>): AgentEvent {
  return { version: 1, sessionId: "live-session", seq, at: 0, ...body } as AgentEvent
}

describe("live frame hub", () => {
  test("assigns cursors, stamps the active turn, and replays after a cursor", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.sink({ type: "reasoning.delta", text: "thinking" })
    hub.sink({ type: "reasoning.completed", itemId: "r1", text: "thought" })
    const frames = hub.since(0)
    expect(frames.map((frame) => frame.liveSeq)).toEqual([1, 2])
    expect(frames[0]).toMatchObject({ version: 1, type: "reasoning.delta", sessionId: "live-session", turnId: "turn-1", text: "thinking", afterSeq: 0 })
    expect(hub.since(1)).toHaveLength(1)
    expect(hub.lastLiveSeq).toBe(2)
    expect(Object.isFrozen(frames[0])).toBe(true)
  })

  test("carries a refused reasoning level with its stable code and nothing else", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.sink({ type: "model.notice", code: "THINKING_REFUSED", thinking: "high", detail: "not carried" } as RunrailLiveFrameInput)
    expect(hub.since(0)).toEqual([expect.objectContaining({ type: "model.notice", turnId: "turn-1", code: "THINKING_REFUSED", thinking: "high" })])
    expect(hub.since(0)[0]).not.toHaveProperty("detail")
  })

  test("carries a request Runrail refused for the person, on one bounded line, with or without a turn", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.sink({ type: "request.refused", source: "codex", message: "Runrail refused a Codex request:\nno turn was running." })
    hub.observe(event(0, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.sink({ type: "request.refused", source: "codex", message: `  ${"x".repeat(5_000)}`, params: "not carried" } as RunrailLiveFrameInput)
    const [between, during] = hub.since(0)
    expect(between).toMatchObject({ type: "request.refused", source: "codex", message: "Runrail refused a Codex request: no turn was running." })
    expect(between).not.toHaveProperty("turnId")
    expect(during).toMatchObject({ type: "request.refused", turnId: "turn-1", source: "codex" })
    expect(during).not.toHaveProperty("params")
    expect((during as { message: string }).message.length).toBeLessThanOrEqual(1_024)
  })

  test("carries a coding tool's retry as counts and a known kind of error on the active turn", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.sink({ type: "api.retry", source: "claude-code", attempt: 2, maxRetries: 10, delayMs: 1_200, status: 529, error: "overloaded", message: "not carried" } as RunrailLiveFrameInput)
    hub.sink({ type: "api.retry", source: "claude-code", attempt: 1, maxRetries: 1, delayMs: 0, status: null, error: "some new kind", waitedMs: 30_000 } as unknown as RunrailLiveFrameInput)
    expect(hub.since(0)).toEqual([
      expect.objectContaining({ type: "api.retry", turnId: "turn-1", source: "claude-code", attempt: 2, maxRetries: 10, delayMs: 1_200, status: 529, error: "overloaded" }),
      expect.objectContaining({ type: "api.retry", turnId: "turn-1", attempt: 1, maxRetries: 1, delayMs: 0, waitedMs: 30_000 }),
    ])
    expect(hub.since(0)[0]).not.toHaveProperty("message")
    expect(hub.since(0)[1]).not.toHaveProperty("status")
    expect(hub.since(0)[1]).not.toHaveProperty("error")
    for (const bad of [{ attempt: 0 }, { attempt: 1.5 }, { delayMs: -1 }, { source: "codex" }]) {
      expect(() => hub.sink({ type: "api.retry", source: "claude-code", attempt: 1, maxRetries: 10, delayMs: 500, ...bad } as RunrailLiveFrameInput)).not.toThrow()
    }
    expect(hub.since(0)).toHaveLength(2)
  })

  test("carries context usage as counts on the active turn", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.sink({ type: "context.usage", usedTokens: 42_000, windowTokens: 200_000, estimated: false, prompt: "not carried" } as RunrailLiveFrameInput)
    hub.sink({ type: "context.usage", usedTokens: 900, windowTokens: 0, estimated: true })
    expect(hub.since(0)).toEqual([
      expect.objectContaining({ type: "context.usage", turnId: "turn-1", usedTokens: 42_000, windowTokens: 200_000, estimated: false }),
      expect.objectContaining({ type: "context.usage", turnId: "turn-1", usedTokens: 900, estimated: true }),
    ])
    expect(hub.since(0)[0]).not.toHaveProperty("prompt")
    expect(hub.since(0)[1]).not.toHaveProperty("windowTokens")
  })

  test("carries plan limits as bounded shares with no turn and no vendor detail", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.sink({ type: "plan.limits", source: "codex", plan: "pro", accountId: "not carried", windows: [{ id: "five-hour", usedPercent: 140, resetsAt: 1_790_000_000_000, windowMinutes: 300, balance: "9" }, { id: "monthly", usedPercent: 3 }] } as unknown as RunrailLiveFrameInput)
    expect(hub.since(0)).toEqual([expect.objectContaining({ type: "plan.limits", source: "codex", plan: "pro", windows: [{ id: "five-hour", usedPercent: 100, resetsAt: 1_790_000_000_000, windowMinutes: 300 }] })])
    expect(hub.since(0)[0]).not.toHaveProperty("turnId")
    expect(hub.since(0)[0]).not.toHaveProperty("accountId")
    expect(hub.since(0)[0]).not.toHaveProperty("extraUsage")
    hub.sink({ type: "plan.limits", source: "claude-code", windows: [{ id: "weekly", usedPercent: 100 }], extraUsage: false })
    hub.sink({ type: "plan.limits", source: "claude-code", windows: [{ id: "weekly", usedPercent: 100 }], extraUsage: "no" } as unknown as RunrailLiveFrameInput)
    expect(hub.since(1)[0]).toMatchObject({ extraUsage: false })
    expect(hub.since(2)[0]).not.toHaveProperty("extraUsage")
  })

  test("keeps a model's own weekly window with its name, and drops one without a usable name", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    const named = Array.from({ length: 12 }, (_, index) => ({ id: "weekly-model", model: `Model ${String(index + 1)}`, usedPercent: index }))
    hub.sink({ type: "plan.limits", source: "claude-code", windows: [{ id: "weekly-model", model: "Fable", usedPercent: 63 }, { id: "weekly-model", usedPercent: 5 }, { id: "weekly-model", model: "x".repeat(41), usedPercent: 5 }, { id: "five-hour", model: "Fable", usedPercent: 4 }] } as unknown as RunrailLiveFrameInput)
    hub.sink({ type: "plan.limits", source: "claude-code", windows: named } as unknown as RunrailLiveFrameInput)
    const [first, second] = hub.since(0) as unknown as { windows: { id: string; model?: string; usedPercent: number }[] }[]
    expect(first?.windows).toEqual([{ id: "weekly-model", model: "Fable", usedPercent: 63 }, { id: "five-hour", usedPercent: 4 }])
    expect(second?.windows).toHaveLength(12)
  })

  test("derives plan and subagent frames from observed tool calls with lineage", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.observe(event(1, { type: "tool.started", turnId: "turn-1", callId: "todo-1", name: "TodoWrite", input: { todos: [{ content: "inspect", status: "completed" }, { content: "edit", status: "in_progress" }] } }))
    hub.observe(event(2, { type: "tool.started", turnId: "turn-1", callId: "task-1", name: "Task", input: { description: "Review auth", subagent_type: "reviewer", prompt: "look" } }))
    hub.sink({ type: "lineage", parentCallId: "task-1", callId: "task-2" })
    hub.observe(event(3, { type: "tool.started", turnId: "turn-1", callId: "task-2", name: "Task", input: { description: "Nested" } }))
    hub.observe(event(4, { type: "tool.completed", turnId: "turn-1", callId: "task-2", name: "Task", ok: false }))
    hub.observe(event(5, { type: "tool.completed", turnId: "turn-1", callId: "task-1", name: "Task", ok: true }))
    const frames = hub.since(0)
    expect(frames.find((frame) => frame.type === "plan.updated")).toMatchObject({ callId: "todo-1", steps: [{ text: "inspect", status: "completed" }, { text: "edit", status: "in_progress" }], afterSeq: 1 })
    expect(frames.filter((frame) => frame.type === "agent.spawned")).toEqual([
      expect.objectContaining({ callId: "task-1", title: "Review auth", agentType: "reviewer" }),
      expect.objectContaining({ callId: "task-2", title: "Nested", parentCallId: "task-1" }),
    ])
    expect(frames.filter((frame) => frame.type === "agent.completed").map((frame) => frame.type === "agent.completed" && [frame.callId, frame.ok])).toEqual([["task-2", false], ["task-1", true]])
  })

  test("a Codex spawn returning does not finish the running agent", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "tool.started", turnId: "turn-1", callId: "spawn-1", name: "collabAgentToolCall", input: { tool: "spawnAgent" } }))
    hub.observe(event(1, { type: "tool.completed", turnId: "turn-1", callId: "spawn-1", name: "collabAgentToolCall", ok: true }))
    expect(hub.since(0).filter((frame) => frame.type === "agent.completed")).toHaveLength(0)
    hub.sink({ type: "agent.completed", callId: "spawn-1", ok: true })
    expect(hub.since(0).filter((frame) => frame.type === "agent.completed")).toHaveLength(1)
  })

  test("waiting for or messaging a Codex agent does not count as another spawn", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(0, { type: "tool.started", turnId: "turn-1", callId: "wait-1", name: "collabAgentToolCall", input: { tool: "wait" } }))
    hub.observe(event(1, { type: "tool.started", turnId: "turn-1", callId: "send-1", name: "collabAgentToolCall", input: { tool: "sendInput" } }))
    expect(hub.since(0).filter((frame) => frame.type === "agent.spawned")).toHaveLength(0)
  })

  test("keeps subagent reasoning attached through the live frame boundary", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.sink({ type: "reasoning.delta", turnId: "child-turn", parentCallId: "spawn-1", text: "Checking files" })
    hub.sink({ type: "reasoning.completed", turnId: "child-turn", parentCallId: "spawn-1", text: "Found it" })
    expect(hub.since(0).map((frame) => frame.type === "reasoning.delta" || frame.type === "reasoning.completed" ? frame.parentCallId : undefined)).toEqual(["spawn-1", "spawn-1"])
  })

  test("agent completion settles its background entry so list refresh cannot revive it", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.sink({ type: "background.state", entry: { id: "claude:task-1", kind: "agent", callId: "task-1", label: "Review", status: "running" } })
    hub.sink({ type: "agent.completed", callId: "task-1", ok: true })
    expect(hub.backgroundEntries()).toEqual([expect.objectContaining({ id: "claude:task-1", status: "completed" })])
  })

  test("bounds text, steps, and frame count, and expires old cursors", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session", maxFrames: 2 })
    hub.sink({ type: "reasoning.delta", text: "x".repeat(40_000) })
    const steps = Array.from({ length: 100 }, (_, index) => ({ text: `step ${index}`, status: "pending" as const }))
    hub.sink({ type: "plan.updated", steps })
    hub.sink({ type: "reasoning.delta", text: "tail" })
    expect(hub.lastLiveSeq).toBe(3)
    expect(() => hub.since(0)).toThrow(LiveFrameCursorError)
    expect(hub.oldestCursor()).toBe(1)
    const [plan] = hub.since(1)
    expect(plan?.type === "plan.updated" ? plan.steps.length : 0).toBe(64)
    const bounded = new LiveFrameHub()
    const frame = bounded.emit({ type: "reasoning.delta", text: "y".repeat(40_000) })
    expect(frame.type === "reasoning.delta" ? Buffer.byteLength(frame.text) : 0).toBeLessThanOrEqual(16 * 1024)
  })

  test("carries a coding tool's reviews and reviewer notices on the active turn, bounded", () => {
    const hub = new LiveFrameHub({ sessionId: "live-session" })
    hub.observe(event(3, { type: "turn.started", turnId: "turn-1", prompt: "" }))
    hub.sink({ type: "approval.reviewed", reviewId: "codex-review-1", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec", risk: "low", detail: "curl\nhttps://example.com", rationale: "Reads a public page.", extra: "not carried" } as RunrailLiveFrameInput)
    hub.sink({ type: "reviewer.notice", turnId: "turn-1", reviewer: "claude-code", notice: "unavailable" })
    const [review, notice] = hub.since(0)
    expect(review).toMatchObject({ type: "approval.reviewed", turnId: "turn-1", afterSeq: 3, reviewId: "codex-review-1", decision: "approved", risk: "low", detail: "curl https://example.com" })
    expect(review).not.toHaveProperty("extra")
    expect(notice).toMatchObject({ type: "reviewer.notice", turnId: "turn-1", reviewer: "claude-code", notice: "unavailable" })
    for (const input of [
      { type: "approval.reviewed", reviewId: "bad id!", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec" },
      { type: "approval.reviewed", reviewId: "r1", reviewer: "someone", decision: "approved", action: "command", capability: "process.exec" },
      { type: "approval.reviewed", reviewId: "r1", reviewer: "codex", decision: "maybe", action: "command", capability: "process.exec" },
      { type: "reviewer.notice", reviewer: "codex", notice: "shouting" },
      { type: "reviewer.notice", reviewId: "r1", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec" },
    ]) expect(() => hub.emit(input as RunrailLiveFrameInput)).toThrow(RangeError)
    expect(hub.lastLiveSeq).toBe(2)
  })

  test("rejects malformed frames without throwing through the sink", () => {
    const hub = new LiveFrameHub()
    const invalid: unknown[] = [
      { type: "unknown" },
      { type: "reasoning.delta", text: 42 },
      { type: "agent.spawned", callId: "bad\nid", title: "x" },
      { type: "lineage", parentCallId: "a" },
      { type: "lineage", parentCallId: "a", callId: "a" },
      { type: "plan.updated", steps: "inspect" },
      { type: "model.notice", code: "THINKING_REFUSED", thinking: "persistent" },
      { type: "model.notice", code: "SOMETHING_ELSE", thinking: "high" },
      { type: "request.refused", source: "gemini", message: "refused" },
      { type: "request.refused", source: "codex", message: " \n " },
      { type: "request.refused", source: "codex", message: "nul\0byte" },
      { type: "request.refused", source: "codex" },
      { type: "context.usage", usedTokens: -1, estimated: false },
      { type: "context.usage", usedTokens: 1.5, estimated: false },
      { type: "context.usage", usedTokens: "12", estimated: false },
      { type: "plan.limits", source: "gemini", windows: [{ id: "weekly", usedPercent: 3 }] },
      { type: "plan.limits", source: "codex", windows: [{ id: "weekly", usedPercent: Number.NaN }] },
      { type: "plan.limits", source: "codex", windows: "weekly" },
    ]
    for (const input of invalid) {
      expect(() => hub.emit(input as RunrailLiveFrameInput)).toThrow()
      expect(() => hub.sink(input as RunrailLiveFrameInput)).not.toThrow()
    }
    expect(hub.lastLiveSeq).toBe(0)
    expect(() => hub.since(-1)).toThrow(RangeError)
    expect(() => hub.since(0, 0)).toThrow(RangeError)
  })

  test("isolates listener failures and rebinds on a new session", () => {
    const hub = new LiveFrameHub({ sessionId: "first" })
    const seen: string[] = []
    hub.subscribe(() => { throw new Error("listener failure") })
    const unsubscribe = hub.subscribe((frame) => seen.push(frame.sessionId))
    hub.sink({ type: "reasoning.delta", text: "a" })
    hub.observe({ version: 1, sessionId: "second", seq: 0, at: 0, type: "turn.started", turnId: "t", prompt: "" } as AgentEvent)
    hub.sink({ type: "reasoning.delta", text: "b" })
    unsubscribe()
    hub.sink({ type: "reasoning.delta", text: "c" })
    expect(seen).toEqual(["first", "second"])
  })
})

describe("harness live mapping", () => {
  const previous = { version: 1 as const, id: "fixture", backend: "claude-code", cwd: "/tmp", status: "idle" as const, createdAt: 0, updatedAt: 0, lastSeq: -1, capabilities: ["sessions" as const, "streaming" as const] }

  test("keeps Claude child thinking associated with the child tool call", () => {
    const frames: RunrailLiveFrameInput[] = []
    const context = { sessionId: "fixture", cwd: "/tmp", backend: "claude-code", nextSeq: 3, previous, turnId: "turn-1", onLive: (frame: RunrailLiveFrameInput) => frames.push(frame) }
    mapClaudeCodeEvent({ type: "stream_event", parent_tool_use_id: "task-1", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Checking files" } } }, context)
    mapClaudeCodeEvent({ type: "assistant", parent_tool_use_id: "task-1", message: { content: [{ type: "thinking", thinking: "Found it" }] } }, context)
    expect(frames).toEqual([
      { type: "reasoning.delta", turnId: "task-1", parentCallId: "task-1", text: "Checking files" },
      { type: "reasoning.completed", turnId: "task-1", parentCallId: "task-1", text: "Found it" },
    ])
  })

  test("maps Claude Code thinking and subagent lineage to live frames", () => {
    const frames: RunrailLiveFrameInput[] = []
    const context = { sessionId: "fixture", cwd: "/tmp", backend: "claude-code", nextSeq: 3, previous, turnId: "turn-1", onLive: (frame: RunrailLiveFrameInput) => frames.push(frame) }
    expect(mapClaudeCodeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "step" } } }, context)).toBeUndefined()
    expect(mapClaudeCodeEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "full thought" }, { type: "text", text: "answer" }] } }, context)).toMatchObject({ type: "assistant.message", text: "answer" })
    expect(mapClaudeCodeEvent({ type: "assistant", parent_tool_use_id: "task-1", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "a.ts" } }] } }, context)).toMatchObject({ type: "tool.started", callId: "read-1" })
    expect(mapClaudeCodeEvent({ type: "assistant", parent_tool_use_id: "task-1", message: { content: [{ type: "text", text: "sub answer" }] } }, context)).toMatchObject({ type: "assistant.message" })
    expect(frames).toEqual([
      { type: "reasoning.delta", turnId: "turn-1", text: "step" },
      { type: "reasoning.completed", turnId: "turn-1", text: "full thought" },
      { type: "lineage", parentCallId: "task-1", callId: "read-1" },
      { type: "lineage", parentCallId: "task-1", eventSeq: 3 },
    ])
  })

  test("maps Codex exec reasoning items and tolerates a throwing sink", () => {
    const frames: RunrailLiveFrameInput[] = []
    const context = { sessionId: "fixture", cwd: "/tmp", backend: "codex", nextSeq: 0, previous, turnId: "turn-1", onLive: (frame: RunrailLiveFrameInput) => frames.push(frame) }
    expect(mapCodexEvent({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "**Plan** read files" } }, context)).toBeUndefined()
    expect(frames).toEqual([{ type: "reasoning.completed", turnId: "turn-1", itemId: "r1", text: "**Plan** read files" }])
    const throwing = { ...context, onLive: () => { throw new Error("sink failure") } }
    expect(() => mapCodexEvent({ type: "item.completed", item: { id: "r2", type: "reasoning", summary: [{ text: "a" }, "b"] } }, throwing)).not.toThrow()
  })
})

describe("provider reasoning sink", () => {
  const request: RunrailContentModelRequest = { sessionId: "provider-session", cwd: "/tmp", messages: [{ role: "user", text: "think" }], tools: [], signal: new AbortController().signal, parts: [{ kind: "text", text: "think" }] }
  const credential = { credential: { kind: "caller" as const, account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret"), allowRemote: false }

  async function drain(source: NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk>): Promise<NativeModelChunk[]> {
    const result: NativeModelChunk[] = []
    if (typeof source === "object" && source !== null && Symbol.asyncIterator in source) for await (const chunk of source) result.push(chunk)
    else result.push({ type: "response", response: await source })
    return result
  }

  async function withSse(lines: readonly string[], run: (url: string) => Promise<void>): Promise<void> {
    const server = Bun.serve({ port: 0, fetch: () => new Response(lines.join(""), { headers: { "content-type": "text/event-stream" } }) })
    try { await run(server.url.toString()) } finally { await server.stop() }
  }

  test("forwards Anthropic thinking deltas without entering the transcript", async () => {
    const reasoning: string[] = []
    await withSse([
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"weighing\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ], async (endpoint) => {
      const port = createAnthropicModelPort({ provider: "anthropic", model: "claude-fixture", endpoint, ...credential, onReasoning: (text) => reasoning.push(text) })
      const chunks = await drain(port.complete(request))
      expect(chunks.at(-1)).toEqual({ type: "response", response: { type: "text", text: "done" } })
    })
    expect(reasoning).toEqual(["weighing"])
  })

  test("forwards OpenAI Chat reasoning_content and Responses reasoning summaries", async () => {
    const reasoning: string[] = []
    await withSse([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"chat thought\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
      "data: [DONE]\n\n",
    ], async (endpoint) => {
      const port = createOpenAIModelPort({ provider: "openai-compatible", model: "fixture", protocol: "openai-chat", endpoint, ...credential, thinking: "low", onReasoning: (text) => reasoning.push(text) })
      const chunks = await drain(port.complete(request))
      expect(chunks.at(-1)).toEqual({ type: "response", response: { type: "text", text: "hi" } })
    })
    await withSse([
      "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"summary thought\"}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
    ], async (endpoint) => {
      const port = createOpenAIModelPort({ provider: "openai", model: "fixture", protocol: "openai-responses", endpoint, ...credential, thinking: "low", onReasoning: () => { throw new Error("sink failure") } })
      await expect(drain(port.complete(request))).resolves.toBeDefined()
      const recorded = createOpenAIModelPort({ provider: "openai", model: "fixture", protocol: "openai-responses", endpoint, ...credential, thinking: "low", onReasoning: (text) => reasoning.push(text) })
      await drain(recorded.complete(request))
    })
    expect(reasoning).toEqual(["chat thought", "summary thought"])
  })

  test("rejects a non-function reasoning sink", () => {
    expect(() => createAnthropicModelPort({ provider: "anthropic", model: "fixture", ...credential, onReasoning: "nope" as never })).toThrow()
    expect(() => createOpenAIModelPort({ provider: "openai", model: "fixture", protocol: "openai-chat", ...credential, thinking: "off", onReasoning: 1 as never })).toThrow()
  })
})
