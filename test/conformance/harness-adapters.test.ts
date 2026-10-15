import { describe, expect, test } from "bun:test"
import { createClaudeCodeHarness, createCodexHarness, createPtyHarness, createPtyHarnessAdapter, PTY_HARNESS_DESCRIPTOR, mapClaudeCodeEvent, mapCodexEvent, decodeHarnessJsonl, HarnessJsonlError } from "../../src/index.ts"
import type { AgentSessionSnapshot } from "@nifrajs/agent-protocol"

const previous: AgentSessionSnapshot = { version: 1, id: "fixture", backend: "codex", cwd: "/tmp", status: "idle", createdAt: 0, updatedAt: 0, lastSeq: -1, capabilities: ["sessions", "streaming"] }
const context = { sessionId: "fixture", cwd: "/tmp", backend: "codex", nextSeq: 0, previous }

describe("first-party harness adapters", () => {
  test("maps Codex and Claude Code machine events and rejects unknown events", () => {
    expect(mapCodexEvent({ type: "thread.started" }, context)).toMatchObject({ type: "session.started", sessionId: "fixture" })
    expect(mapCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } }, { ...context, nextSeq: 1 })).toMatchObject({ type: "assistant.message", text: "done" })
    expect(mapClaudeCodeEvent({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }, context)).toMatchObject({ type: "assistant.message", text: "hello" })
    expect(mapClaudeCodeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "part" } } }, context)).toMatchObject({ type: "assistant.delta", text: "part" })
    expect(mapClaudeCodeEvent({ type: "rate_limit_event" }, context)).toBeUndefined()
    expect(mapClaudeCodeEvent({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 1 } } }, context)).toBeUndefined()
    expect(mapCodexEvent({ type: "item.completed", item: { type: "reasoning", text: "private reasoning" } }, { ...context, nextSeq: 2 })).toBeUndefined()
    expect(mapCodexEvent({ type: "permission_request", capability: "process.exec" }, { ...context, nextSeq: 3 })).toMatchObject({ type: "approval.required" })
    // "completed" is the command's lifecycle; its exit code says whether it worked.
    expect(mapCodexEvent({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "false", status: "completed", exit_code: 1 } }, { ...context, nextSeq: 4 })).toMatchObject({ type: "tool.completed", ok: false })
    expect(mapCodexEvent({ type: "item.completed", item: { id: "cmd-2", type: "command_execution", command: "true", status: "completed", exit_code: 0 } }, { ...context, nextSeq: 5 })).toMatchObject({ type: "tool.completed", ok: true })
    expect(() => mapClaudeCodeEvent({ type: "human_text", text: "guess" }, context)).toThrow()
  })

  test("maps every block of a vendor record, and keeps a Codex failure's own words", () => {
    const both = mapClaudeCodeEvent({ type: "assistant", message: { content: [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a.ts" } }] } }, { ...context, nextSeq: 5 })
    expect(both).toMatchObject([{ type: "assistant.message", seq: 5, text: "Reading it." }, { type: "tool.started", seq: 6, callId: "tu1", name: "Read" }])
    const results = mapClaudeCodeEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "x" }, { type: "tool_result", tool_use_id: "b", content: "y" }] } }, { ...context, nextSeq: 7 })
    expect(results).toMatchObject([{ type: "tool.completed", seq: 7, callId: "a" }, { type: "tool.completed", seq: 8, callId: "b" }])
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "model gpt-x is not available\nfor this account" } }, context)).toMatchObject({ type: "session.failed", error: { message: "model gpt-x is not available for this account" } })
    expect(mapClaudeCodeEvent({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" }, context)).toMatchObject({ type: "session.failed", error: { code: "HARNESS_FAILED", message: "API Error: 529 overloaded" } })
    expect(mapClaudeCodeEvent({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["tool crashed"] }, context)).toMatchObject({ error: { message: "Claude Code failed while running: tool crashed" } })
    expect(mapClaudeCodeEvent({ type: "result", subtype: "error_max_turns", is_error: true }, context)).toMatchObject({ error: { message: "Claude Code stopped at its turn limit" } })
    expect(mapClaudeCodeEvent({ type: "result", subtype: "error", is_error: true }, context)).toMatchObject({ error: { message: "harness reported a failure" } })
    expect(mapClaudeCodeEvent({ type: "system", subtype: "error", message: "MCP server crashed\nat startup" }, context)).toMatchObject({ type: "session.failed", error: { message: "MCP server crashed at startup" } })
    expect(mapClaudeCodeEvent({ type: "error", error: { message: "stream ended" } }, context)).toMatchObject({ type: "session.failed", error: { message: "stream ended" } })
    expect(mapCodexEvent({ type: "item.completed", item: { id: "m1", type: "mcp_tool_call", status: "failed", error: { message: "docs server said\tno" } } }, context)).toMatchObject({ type: "tool.completed", ok: false, error: { code: "HARNESS_TOOL_FAILED", message: "docs server said no" } })
    expect(mapCodexEvent({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "false", status: "failed", exit_code: 2 } }, context)).toMatchObject({ error: { message: "Exited with code 2" } })
  })

  test("a Claude Code tool result that failed says why in one short line; one that worked carries no text", () => {
    const result = (block: Record<string, unknown>) => mapClaudeCodeEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", ...block }] } }, context)
    expect(result({ is_error: true, content: "<tool_use_error>Error: No such tool available: Grep. Grep is not available in this session - search file contents with grep via the Bash tool instead.</tool_use_error>" })).toMatchObject({
      type: "tool.completed",
      ok: false,
      error: { code: "HARNESS_TOOL_FAILED", message: "Error: No such tool available: Grep. Grep is not available in this session - search file contents with grep via the Bash tool instead." },
    })
    expect(result({ is_error: true, content: [{ type: "text", text: "Exit code 1\n\u001b[31mfatal:\u0007 not a repo" }, { type: "image", source: {} }, { type: "text", text: "\tsecond" }] })).toMatchObject({ error: { message: "Exit code 1 [31mfatal: not a repo second" } })
    const long = result({ is_error: true, content: `Exit code 2\n${"file line\n".repeat(5_000)}` }) as { readonly error: { readonly message: string } }
    expect(long.error.message.length).toBe(300)
    expect(long.error.message.endsWith("…")).toBe(true)
    expect(result({ content: "secret file contents" })).not.toHaveProperty("error")
    expect(result({ is_error: true, content: " \n<tool_use_error></tool_use_error>" })).not.toHaveProperty("error")
    expect(result({ is_error: true })).toMatchObject({ ok: false })
    expect(result({ is_error: true })).not.toHaveProperty("error")
  })

  test("preserves bounded vendor metadata through the explicit transient sink", () => {
    const metadata: unknown[] = []
    const onMetadata = (event: unknown): void => { metadata.push(event) }
    const codexContext = { ...context, onMetadata }
    expect(mapCodexEvent({ type: "usage", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }, codexContext)).toBeUndefined()
    expect(mapCodexEvent({ type: "rate_limit_event", retry_after_ms: 2500 }, { ...codexContext, nextSeq: 1 })).toBeUndefined()
    expect(mapCodexEvent({ type: "item.completed", item: { type: "reasoning", effort: "high" } }, { ...codexContext, nextSeq: 2 })).toBeUndefined()
    expect(mapCodexEvent({ type: "item.completed", item: { type: "compaction", before: 20, after: 8 } }, { ...codexContext, nextSeq: 3 })).toBeUndefined()
    expect(mapClaudeCodeEvent({ type: "message_delta", usage: { output_tokens: 4 } }, { ...context, onMetadata, nextSeq: 4 })).toBeUndefined()
    expect(metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "usage", inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
      expect.objectContaining({ kind: "rate-limit", retryAfterMs: 2500 }),
      expect.objectContaining({ kind: "reasoning", level: "high" }),
      expect.objectContaining({ kind: "compaction", before: 20, after: 8 }),
      expect.objectContaining({ kind: "usage", outputTokens: 4 }),
    ]))
  })

  test("passes Claude Code plan usage on as shares and reset times only", () => {
    const frames: unknown[] = []
    const onLive = (frame: unknown): void => { frames.push(frame) }
    const info = { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.24, resetsAt: 1_790_000_000, overageStatus: "rejected", isUsingOverage: false }
    expect(mapClaudeCodeEvent({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" }, { ...context, onLive })).toBeUndefined()
    mapClaudeCodeEvent({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus" } }, { ...context, onLive })
    mapClaudeCodeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "overage", utilization: 0.5 } }, { ...context, onLive })
    mapClaudeCodeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day" } }, { ...context, onLive })
    expect(frames).toEqual([
      { type: "plan.limits", source: "claude-code", windows: [{ id: "five-hour", usedPercent: 24, resetsAt: 1_790_000_000_000 }], extraUsage: false },
      { type: "plan.limits", source: "claude-code", windows: [{ id: "weekly-opus", usedPercent: 100 }] },
    ])
  })

  test("reads Claude Code's context from the main agent's requests and its window from the result", () => {
    const frames: unknown[] = []
    const live = { ...context, onLive: (frame: unknown): void => { frames.push(frame) }, turnState: new Map<string, unknown>(), turnId: "turn-1" }
    const usage = { input_tokens: 3, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 40_000, output_tokens: 500 }
    mapClaudeCodeEvent({ type: "assistant", message: { model: "claude-opus", usage, content: [{ type: "text", text: "hi" }] } }, live)
    mapClaudeCodeEvent({ type: "assistant", message: { model: "claude-opus", usage, content: [{ type: "text", text: "again" }] } }, live)
    mapClaudeCodeEvent({ type: "assistant", parent_tool_use_id: "task-1", message: { model: "claude-haiku", usage: { input_tokens: 90_000 }, content: [{ type: "text", text: "sub" }] } }, live)
    mapClaudeCodeEvent({ type: "result", subtype: "success", modelUsage: { "claude-haiku": { contextWindow: 200_000 }, "claude-opus": { contextWindow: 1_000_000 } } }, live)
    expect(frames.filter((frame) => (frame as { type: string }).type === "context.usage")).toEqual([
      { type: "context.usage", turnId: "turn-1", usedTokens: 42_503, estimated: false },
      { type: "context.usage", turnId: "turn-1", usedTokens: 42_503, windowTokens: 1_000_000, estimated: false },
    ])
  })

  test("keeps vendor thread/session identities separate and rejects drift", () => {
    const codexContext = { ...context }
    expect(mapCodexEvent({ type: "thread.started", thread_id: "codex-thread" }, codexContext)).toMatchObject({ type: "session.started", sessionId: "fixture" })
    expect(mapCodexEvent({ type: "turn.completed", thread_id: "codex-thread" }, { ...codexContext, nextSeq: 1 })).toMatchObject({ type: "session.completed", sessionId: "fixture" })
    expect(() => mapCodexEvent({ type: "turn.completed", thread_id: "other-thread" }, { ...codexContext, nextSeq: 2 })).toThrow("vendor session")

    const claudeContext = { ...context }
    expect(mapClaudeCodeEvent({ type: "system", session_id: "claude-session" }, claudeContext)).toMatchObject({ type: "session.started", sessionId: "fixture" })
    expect(mapClaudeCodeEvent({ type: "result", session_id: "claude-session", is_error: false }, { ...claudeContext, nextSeq: 1 })).toMatchObject({ type: "session.completed", sessionId: "fixture" })
    expect(() => mapClaudeCodeEvent({ type: "result", session_id: "other-session", is_error: false }, { ...claudeContext, nextSeq: 2 })).toThrow("vendor session")
  })

  test("strictly decodes normalized JSONL with terminal and sequence rules", async () => {
    const started = { version: 1, sessionId: "fixture", seq: 0, at: 0, type: "turn.started", turnId: "turn", prompt: "transient" }
    const completed = { version: 1, sessionId: "fixture", seq: 1, at: 1, type: "session.completed", snapshot: { ...previous, status: "completed", lastSeq: 1 } }
    const events = []
    async function* source() { yield `${JSON.stringify(started)}\n`; yield JSON.stringify(completed) }
    for await (const event of decodeHarnessJsonl(source(), { sessionId: "fixture" })) events.push(event)
    expect(events).toHaveLength(2)
    await expect((async () => { for await (const _event of decodeHarnessJsonl((async function* () { yield JSON.stringify(started) })())) {} })()).rejects.toMatchObject({ code: "HARNESS_JSONL_TERMINAL" })
    expect(HarnessJsonlError).toBeDefined()
  })

  test("runs Codex and Claude Code command adapters over local fixtures", async () => {
    for (const mode of ["codex", "claude-code"] as const) {
      const harness = mode === "codex" ? createCodexHarness({ command: process.execPath, args: [new URL("../fixtures/vendor-harness.ts", import.meta.url).pathname, "codex"] }) : createClaudeCodeHarness({ command: process.execPath, args: [new URL("../fixtures/vendor-harness.ts", import.meta.url).pathname, "claude"] })
      const created = await harness.createSession({ cwd: "/tmp", sessionId: `${mode}-session` })
      const events = []
      for await (const event of harness.send({ sessionId: created.id, message: "run fixture" })) events.push(event)
      expect(events.some((event) => event.type === "assistant.message")).toBe(true)
      expect(events.at(-1)?.type).toBe("session.completed")
      await harness.close(created.id)
    }
  })

  test("classifies mapped vendor failures and authentication failures without passing verification", async () => {
    const failed = createClaudeCodeHarness({ command: process.execPath, args: [new URL("../fixtures/vendor-harness.ts", import.meta.url).pathname, "claude-failure"] })
    const failedSession = await failed.createSession({ cwd: "/tmp", sessionId: "claude-failure-session" })
    await expect((async () => { for await (const _event of failed.send({ sessionId: failedSession.id, message: "run failure" })) {} })()).rejects.toMatchObject({ code: "COMMAND_AGENT_FAILED" })
    await failed.close(failedSession.id)

    const auth = createClaudeCodeHarness({ command: process.execPath, args: [new URL("../fixtures/vendor-harness.ts", import.meta.url).pathname, "claude-auth"] })
    const authSession = await auth.createSession({ cwd: "/tmp", sessionId: "claude-auth-session" })
    await expect((async () => { for await (const _event of auth.send({ sessionId: authSession.id, message: "run auth" })) {} })()).rejects.toMatchObject({ code: "COMMAND_AGENT_AUTH_FAILED" })
    await auth.close(authSession.id)
  })

  test("delivers prompts through the native vendor argv mode", async () => {
    const fixture = new URL("../fixtures/vendor-argv-harness.ts", import.meta.url).pathname
    for (const mode of ["codex", "claude"] as const) {
      const harness = mode === "codex"
        ? createCodexHarness({ command: process.execPath, args: [fixture, mode], promptMode: "argument" })
        : createClaudeCodeHarness({ command: process.execPath, args: [fixture, mode], promptMode: "argument" })
      const created = await harness.createSession({ cwd: "/tmp", sessionId: `${mode}-argv-session` })
      const events = []
      for await (const event of harness.send({ sessionId: created.id, message: "argument prompt" })) events.push(event)
      expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: `${mode === "codex" ? "codex" : "claude"} argv received` }))
      expect(events.at(-1)?.type).toBe("session.completed")
      await harness.close(created.id)
    }
  })

  test("describes PTY as an explicit first-party harness and runs its factory", async () => {
    const adapter = createPtyHarnessAdapter({ command: process.execPath, args: ["fixture.ts"] })
    expect(adapter.descriptor).toEqual(PTY_HARNESS_DESCRIPTOR)
    expect(adapter.descriptor).toMatchObject({ id: "pty", kind: "pty", firstParty: true, capabilities: ["sessions", "streaming", "pty"] })
    const harness = createPtyHarness({ command: process.execPath, args: [new URL("../fixtures/agent-jsonl.ts", import.meta.url).pathname, "events"] })
    const created = await harness.createSession({ cwd: "/tmp", sessionId: "pty-harness-session" })
    const events = []
    for await (const event of harness.send({ sessionId: created.id, message: "run PTY fixture" })) events.push(event)
    expect(events.some((event) => event.type === "assistant.message")).toBe(true)
    expect(events.at(-1)?.type).toBe("session.completed")
    await harness.close(created.id)
  })
})
