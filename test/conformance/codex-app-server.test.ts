import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAgentEvent, type AgentBackend, type AgentEvent } from "@nifrajs/agent-protocol"
import {
  CODEX_APP_SERVER_PROTOCOL_VERSION,
  CodexAppServerBackend,
  createCodexHarness,
  createCodexHarnessAdapter,
} from "../../src/index.ts"
import type { RunrailLiveFrameInput } from "../../src/index.ts"

const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname

async function collect(backend: AgentBackend, sessionId: string, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message })) events.push(event)
  return events
}

describe("Codex app-server adapter", () => {
  test("streams a known subagent's text and tools with lineage without completing its parent's turn", async () => {
    const frames: RunrailLiveFrameInput[] = []
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "subagent-output"], onLive: (frame) => frames.push(frame) })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-subagent-output" })
    const events: AgentEvent[] = []
    try {
      for await (const event of backend.send({ sessionId: session.id, message: "go" })) events.push(event)
      expect(events).toContainEqual(expect.objectContaining({ type: "assistant.delta", turnId: "child-turn", text: "Inspecting files" }))
      expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", turnId: "child-turn", text: "Found the parser" }))
      expect(events).toContainEqual(expect.objectContaining({ type: "tool.started", callId: "child-command" }))
      expect(events).toContainEqual(expect.objectContaining({ type: "tool.delta", callId: "child-command", text: "parser.ts" }))
      expect(frames).toContainEqual({ type: "lineage", parentCallId: "spawn-1", callId: "child-command" })
      const delta = events.find((event) => event.type === "assistant.delta" && event.turnId === "child-turn")
      expect(frames).toContainEqual({ type: "lineage", parentCallId: "spawn-1", eventSeq: delta?.seq })
      expect(frames).toContainEqual(expect.objectContaining({ type: "reasoning.delta", parentCallId: "spawn-1", text: "Checking the parser" }))
      expect(frames).toContainEqual(expect.objectContaining({ type: "background.state", entry: expect.objectContaining({ kind: "agent", callId: "spawn-1", status: "running" }) }))
      expect(frames).toContainEqual(expect.objectContaining({ type: "agent.completed", callId: "spawn-1", ok: true }))
      expect(events.filter((event) => event.type === "session.completed")).toHaveLength(1)
      expect(events.at(-2)).toMatchObject({ type: "assistant.message", text: "Parent summary" })
      expect(JSON.stringify(events)).not.toContain("Unrelated output")
      expect(events.every(isAgentEvent)).toBe(true)
    } finally {
      await backend.close(session.id)
    }
  })
  test("a reply past one event's text arrives whole as consecutive valid events", async () => {
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "long-reply"] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-long-reply" })
    try {
      const events = await collect(backend, session.id, "say a lot")
      expect(events.at(-1)?.type).toBe("session.completed")
      expect(events.every(isAgentEvent)).toBe(true)
      const text = (type: string): string[] => events.flatMap((event) => (event.type === type && "text" in event ? [event.text] : []))
      const expected = `${"r".repeat(300_000)}\uFFFDend`
      expect(text("assistant.message")).toHaveLength(2)
      expect(text("assistant.message").join("")).toBe(expected)
      expect(text("assistant.delta").join("")).toBe(expected)
    } finally {
      await backend.close(session.id)
    }
  })

  test("a command that exits nonzero is a failed tool call, though Codex calls it completed", async () => {
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "failed-command"] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-failed-command" })
    try {
      const events = await collect(backend, session.id, "run it")
      expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ ok: false, error: { code: "CODEX_TOOL_FAILED", message: "Exited with code 1" } })
    } finally {
      await backend.close(session.id)
    }
  })

  test("a failure says it in Codex's own words, on one line", async () => {
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "vendor-failure"] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-vendor-failure" })
    try {
      const events = await collect(backend, session.id, "search")
      expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ name: "search", ok: false, error: { code: "CODEX_TOOL_FAILED", message: "docs server said no" } })
      expect(events.at(-1)).toMatchObject({ type: "session.failed", error: { code: "COMMAND_AGENT_FAILED", message: "Codex turn failed: model overloaded retry later" } })
    } finally {
      await backend.close(session.id)
    }
  })

  test("a request Codex refuses says why", async () => {
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "turn-refused"] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-turn-refused" })
    try {
      await expect(collect(backend, session.id, "hello")).rejects.toMatchObject({ code: "COMMAND_AGENT_FAILED", reason: "Codex refused the request: thread not loaded start a new one" })
    } finally {
      await backend.close(session.id)
    }
  })

  test.each(["quota-retry", "quota-terminal"])("reports subscription exhaustion promptly: %s", async (mode) => {
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, mode], turnTimeoutMs: 300 })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-quota" })
    try {
      const events = await collect(backend, session.id, "hello")
      expect(events.at(-1)).toMatchObject({ type: "session.failed", recoverable: false, error: { code: "COMMAND_AGENT_RATE_LIMITED", message: expect.stringContaining("weekly usage limit reached") } })
      expect(JSON.stringify(events)).not.toContain("sk-fixture")
    } finally {
      await backend.close?.(session.id)
    }
  })

  test("stops a quota retry even when the vendor refuses interruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runrail-codex-quota-"))
    const pidPath = join(directory, "vendor-pid.json")
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "quota-stubborn", pidPath] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-stubborn-quota" })
    try {
      expect((await collect(backend, session.id, "hello")).at(-1)).toMatchObject({ type: "session.failed", error: { code: "COMMAND_AGENT_RATE_LIMITED" } })
      const pid: unknown = JSON.parse(await readFile(pidPath, "utf8"))
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid fixture process ID")
      let stopped = false
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") { stopped = true; break }
          throw error
        }
        await Bun.sleep(50)
      }
      expect(stopped).toBe(true)
      // Old process output must not fail a new turn after it restarts.
      expect((await collect(backend, session.id, "again")).at(-1)).toMatchObject({ type: "session.failed", error: { code: "COMMAND_AGENT_RATE_LIMITED" } })
    } finally {
      await backend.close(session.id)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("an empty assistant delta is skipped, not treated as broken output", async () => {
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "empty-delta"] })
    const session = await backend.createSession({ cwd: process.cwd(), sessionId: "codex-empty-delta" })
    try {
      const events = await collect(backend, session.id, "hello")
      expect(events.at(-1)?.type).toBe("session.completed")
      expect(events.filter((event) => event.type === "assistant.delta").map((event) => (event as { text: string }).text)).toEqual(["fixture answer 1"])
    } finally {
      await backend.close(session.id)
    }
  })

  test("advertises the versioned protocol and keeps one-shot defaults separate", () => {
    const appServer = createCodexHarnessAdapter({ protocol: "app-server" })
    const oneShot = createCodexHarnessAdapter()
    expect(appServer.descriptor.protocolVersion).toBe(CODEX_APP_SERVER_PROTOCOL_VERSION)
    expect(appServer.descriptor.controls).toEqual(expect.arrayContaining(["approve", "resume", "fork", "compact", "model", "thinking", "sandbox"]))
    expect(oneShot.descriptor.controls).not.toContain("compact")
    expect(oneShot.descriptor.protocolVersion).toBe("codex.exec.json")
  })

  test("runs bounded lifecycle, streaming, usage, resume, fork, and reload through JSON-RPC", async () => {
    const metadata: unknown[] = []
    const backend = createCodexHarness({
      command: process.execPath,
      args: [fixture, "normal"],
      protocol: "app-server",
      onMetadata: (event) => metadata.push(event),
    }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-session" })
    const first = await collect(backend, session.id, "first")
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started" }),
      expect.objectContaining({ type: "turn.started" }),
      expect.objectContaining({ type: "assistant.delta", text: "fixture answer 1" }),
      expect.objectContaining({ type: "assistant.message", text: "fixture answer 1" }),
      expect.objectContaining({ type: "session.completed" }),
    ]))
    expect(metadata).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "usage", totalTokens: 15 })]))
    await expect(backend.setModel?.(session.id, "fixture-model")).resolves.toBeUndefined()
    await expect(backend.setThinking?.(session.id, "high")).resolves.toBeUndefined()
    await expect(backend.setSandbox?.(session.id, "read-only")).resolves.toBeUndefined()
    // Without a store for the forked thread's id, nothing could open the copy, so no fork is made.
    await expect(backend.fork?.({ sessionId: session.id, targetSessionId: "codex-app-server-fork" })).rejects.toMatchObject({ code: "COMMAND_AGENT_UNSUPPORTED" })
    await backend.reload(session.id)
    await expect(backend.resume?.(session.id)).resolves.toMatchObject({ id: session.id, status: "idle" })
    const second = await collect(backend, session.id, "second")
    expect(second.at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close(session.id)
  })

  test("a fork keeps the forked thread for the target session, which then continues it", async () => {
    const kept = new Map<string, string>()
    const vendorSessions = { load: async (id: string) => kept.get(id), save: async (id: string, vendor: string | undefined) => void (vendor === undefined ? kept.delete(id) : kept.set(id, vendor)) }
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "normal"], protocol: "app-server", vendorSessions }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-fork-parent" })
    await collect(backend, session.id, "first")
    await expect(backend.fork({ sessionId: session.id, targetSessionId: session.id })).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    await expect(backend.fork({ sessionId: session.id, targetSessionId: "codex-fork-child" })).resolves.toEqual({ sessionId: "codex-fork-child", parentSessionId: session.id })
    expect(kept.get("codex-fork-child")).toBe(`${kept.get(session.id)}-fork`)
    await backend.close(session.id)
  })

  test("forwards reasoning and plan notifications as live frames", async () => {
    const frames: RunrailLiveFrameInput[] = []
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "reasoning"], protocol: "app-server", onLive: (frame) => frames.push(frame) }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-live" })
    const events = await collect(backend, session.id, "think")
    expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    expect(frames).toEqual([
      { type: "plan.updated", turnId: "fixture-turn-1", explanation: "fixture plan", steps: [{ text: "inspect", status: "completed" }, { text: "edit", status: "in_progress" }, { text: "verify", status: "pending" }] },
      { type: "reasoning.delta", turnId: "fixture-turn-1", itemId: "reasoning-1", text: "thinking " },
      { type: "reasoning.delta", turnId: "fixture-turn-1", itemId: "reasoning-1", text: "hard" },
      { type: "reasoning.completed", turnId: "fixture-turn-1", itemId: "reasoning-1", text: "thinking hard" },
      { type: "context.usage", turnId: "fixture-turn-1", usedTokens: 15, windowTokens: 1000, estimated: false },
    ])
    expect(JSON.stringify(events)).not.toContain("thinking hard")
    await backend.close(session.id)
    expect(() => createCodexHarness({ command: process.execPath, args: [fixture], protocol: "app-server", onLive: "nope" as never })).toThrow()
  })

  test("reads plan usage at start and passes updates on without account details", async () => {
    const frames: RunrailLiveFrameInput[] = []
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "limits"], protocol: "app-server", onLive: (frame) => frames.push(frame) }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-limits" })
    expect((await collect(backend, session.id, "go")).at(-1)).toMatchObject({ type: "session.completed" })
    const limits = frames.filter((frame) => frame.type === "plan.limits")
    expect(limits).toEqual([
      { type: "plan.limits", source: "codex", plan: "pro", windows: [{ id: "five-hour", usedPercent: 24, resetsAt: 1_790_000_000_000, windowMinutes: 300 }, { id: "weekly", usedPercent: 7, resetsAt: 1_790_400_000_000, windowMinutes: 10_080 }] },
      { type: "plan.limits", source: "codex", windows: [{ id: "five-hour", usedPercent: 31, windowMinutes: 300 }] },
    ])
    expect(JSON.stringify(frames)).not.toContain("fixture-account")
    expect(JSON.stringify(frames)).not.toContain("12.50")
    await backend.close(session.id)
  })

  test("resumes a restarted vendor process exactly once and drains diagnostics", async () => {
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "strict-resume"], protocol: "app-server" }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-restart" })
    await collect(backend, session.id, "first")
    await backend.reload(session.id)
    await expect(backend.resume(session.id)).resolves.toMatchObject({ id: session.id, status: "idle" })
    await expect(collect(backend, session.id, "second")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.completed" })]))
    await backend.close(session.id)

    const stderrBackend = createCodexHarness({ command: process.execPath, args: [fixture, "stderr"], protocol: "app-server" }) as CodexAppServerBackend
    const stderrSession = await stderrBackend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-stderr" })
    await expect(collect(stderrBackend, stderrSession.id, "stderr")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.completed" })]))
    await stderrBackend.close(stderrSession.id)
  })

  test("compacts with Codex's own compaction between turns and reports the compacted size as an estimate", async () => {
    const frames: RunrailLiveFrameInput[] = []
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "limits"], protocol: "app-server", onLive: (frame) => frames.push(frame) }) as CodexAppServerBackend
    expect(backend.info.capabilities).toContain("compact")
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-compact" })
    expect(await backend.readUsage(session.id)).toEqual({})
    // Codex would spend a model call compacting a thread with nothing in it.
    await expect(backend.compact(session.id)).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    await collect(backend, session.id, "first")
    expect(frames.filter((frame) => frame.type === "context.usage").at(-1)).toMatchObject({ usedTokens: 15, windowTokens: 1000, autoCompactAt: 800, estimated: false })
    frames.length = 0
    const compacted = await backend.compact(session.id, "manual")
    expect(compacted).toMatchObject({ type: "memory.compacted", before: 15, after: 9, reason: "manual" })
    // The summarizing request's own size is never shown as the context's.
    expect(frames.filter((frame) => frame.type === "context.usage")).toEqual([{ type: "context.usage", turnId: expect.any(String), usedTokens: 9, windowTokens: 1000, autoCompactAt: 800, estimated: true }])
    const usage = await backend.readUsage(session.id)
    expect(usage.context).toEqual({ usedTokens: 9, windowTokens: 1000, autoCompactAt: 800, estimated: true })
    // The update a turn brought is newer than the read before it; the plan's name is kept.
    expect(usage.plan).toEqual({ type: "plan.limits", source: "codex", plan: "pro", windows: [{ id: "five-hour", usedPercent: 31, windowMinutes: 300 }] })
    // The compaction's turn is not a turn of the conversation: the next one runs as usual.
    const next = await collect(backend, session.id, "second")
    expect(next.map((event) => event.type)).toEqual(expect.arrayContaining(["turn.started", "assistant.message", "session.completed"]))
    expect(next.filter((event) => event.type === "turn.started")).toHaveLength(1)
    await backend.close(session.id)
  })

  test("refuses to compact while a turn runs, since Codex would interrupt it", async () => {
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "approval"], protocol: "app-server" }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-compact-busy" })
    const events: AgentEvent[] = []
    for await (const event of backend.send({ sessionId: session.id, message: "approval" })) {
      events.push(event)
      if (event.type === "approval.required") {
        await expect(backend.compact(session.id)).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
        await backend.resolveApproval?.(session.id, event.approvalId, true, "approved by test")
      }
    }
    expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close(session.id)
  })

  test("surfaces server approval and sends an explicit decision back", async () => {
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "approval"], protocol: "app-server" })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-approval" })
    const events: AgentEvent[] = []
    const running = (async () => {
      for await (const event of backend.send({ sessionId: session.id, message: "approval" })) {
        events.push(event)
        if (event.type === "approval.required") await backend.resolveApproval?.(session.id, event.approvalId, true, "approved by test")
      }
    })()
    await running
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.required", approvalId: "fixture-approval", capability: "process.exec" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approvalId: "fixture-approval", approved: true }))
    expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close(session.id)
  })

  describe("a question Codex asks the person", () => {
    const ask = async (mode: string, respond: (backend: CodexAppServerBackend, sessionId: string, approvalId: string) => Promise<void>) => {
      const backend = createCodexHarness({ command: process.execPath, args: [fixture, mode], protocol: "app-server" }) as CodexAppServerBackend
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `codex-${mode}` })
      const events: AgentEvent[] = []
      for await (const event of backend.send({ sessionId: session.id, message: "ask" })) {
        events.push(event)
        if (event.type === "approval.required") await respond(backend, session.id, event.approvalId)
      }
      await backend.close(session.id)
      const reply = events.filter((event) => event.type === "assistant.message").map((event) => event.text).join("")
      return { events, reply, resolved: events.find((event) => event.type === "approval.resolved") }
    }

    test("is shown with its choices, and the answers go back by question id; a secret one is never recorded", async () => {
      const { events, reply, resolved } = await ask("question", async (backend, sessionId, approvalId) => {
        expect(() => backend.setApprovalAnswers(sessionId, approvalId, { env: ["staging", "prod"], token: ["s3cret-value"] })).toThrow("more than one answer")
        // Codex's answer holds only answers, so "ask me more" is refused and the question keeps waiting.
        expect(() => backend.setApprovalAnswers(sessionId, approvalId, { env: ["staging"] }, {})).toThrow("cannot be asked for more questions")
        expect(backend.setApprovalAnswers(sessionId, approvalId, { env: ["staging"], token: ["s3cret-value"] })).toBe(true)
        expect(await backend.resolveApproval(sessionId, approvalId, true)).toBe(true)
      })
      expect(events.find((event) => event.type === "approval.required")).toMatchObject({
        action: "question",
        capability: "user.input",
        reason: "Deploy where? (and 1 more)",
        questions: [
          { id: "env", header: "Target", question: "Deploy where?", options: [{ label: "staging", description: "Safe" }, { label: "prod", description: "Live" }] },
          { id: "token", header: "Token", question: "Paste the token", options: [], other: true, secret: true },
        ],
      })
      expect(reply).toContain(JSON.stringify({ answers: { env: { answers: ["staging"] }, token: { answers: ["s3cret-value"] } } }))
      expect(resolved).toMatchObject({ approved: true, answers: { env: ["staging"] } })
      expect(JSON.stringify(resolved)).not.toContain("s3cret")
      expect(events.every((event) => isAgentEvent(event))).toBe(true)
    })

    test("approving it without answers is refused, and it keeps waiting for the person", async () => {
      const { reply, resolved } = await ask("question", async (backend, sessionId, approvalId) => {
        await expect(backend.resolveApproval(sessionId, approvalId, true)).rejects.toThrow("answer it or decline it")
        expect(backend.setApprovalAnswers(sessionId, approvalId, { env: ["prod"], token: ["t"] })).toBe(true)
        expect(await backend.resolveApproval(sessionId, approvalId, true)).toBe(true)
      })
      expect(reply).toContain(JSON.stringify({ answers: { env: { answers: ["prod"] }, token: { answers: ["t"] } } }))
      expect(resolved).toMatchObject({ approved: true, answers: { env: ["prod"] } })
    })

    test("the person's own words stand in for any choice, since Codex leaves that box to the client", async () => {
      const { reply, events } = await ask("question", async (backend, sessionId, approvalId) => {
        expect(backend.setApprovalAnswers(sessionId, approvalId, { env: ["a canary first"], token: ["t"] })).toBe(true)
        expect(await backend.resolveApproval(sessionId, approvalId, true)).toBe(true)
      })
      expect(events.find((event) => event.type === "approval.required")).toMatchObject({ questions: [{ id: "env", other: true }, { id: "token", other: true, secret: true }] })
      expect(reply).toContain(JSON.stringify({ answers: { env: { answers: ["a canary first"] }, token: { answers: ["t"] } } }))
    })

    test("declined, Codex gets no answers and goes on", async () => {
      const { reply, resolved } = await ask("question", async (backend, sessionId, approvalId) => {
        await backend.resolveApproval(sessionId, approvalId, false)
      })
      expect(reply).toContain(JSON.stringify({ answers: {} }))
      expect(resolved).toMatchObject({ approved: false })
      expect(resolved).not.toHaveProperty("answers")
    })

    test("one Codex settles on its own is withdrawn, not left waiting", async () => {
      const { events, resolved } = await ask("question-withdrawn", async () => {})
      expect(resolved).toMatchObject({ approved: false, withdrawn: true, reason: "Codex no longer needs an answer" })
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    })
  })

  describe("an MCP server's form Codex passes on", () => {
    const ask = async (mode: string, respond: (backend: CodexAppServerBackend, sessionId: string, approvalId: string) => Promise<void> = async () => {}) => {
      const backend = createCodexHarness({ command: process.execPath, args: [fixture, mode], protocol: "app-server" }) as CodexAppServerBackend
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `codex-${mode}` })
      const events: AgentEvent[] = []
      for await (const event of backend.send({ sessionId: session.id, message: "ask" })) {
        events.push(event)
        if (event.type === "approval.required") await respond(backend, session.id, event.approvalId)
      }
      await backend.close(session.id)
      const reply = events.filter((event) => event.type === "assistant.message").map((event) => event.text).join("")
      return { events, reply, required: events.find((event) => event.type === "approval.required"), resolved: events.find((event) => event.type === "approval.resolved") }
    }

    test("is asked as questions, and the answers go back as the form's content", async () => {
      const { events, reply, required, resolved } = await ask("elicitation", async (backend, sessionId, approvalId) => {
        expect(() => backend.setApprovalAnswers(sessionId, approvalId, { q1: ["Production"], q2: ["ok"], q3: ["Yes"] })).toThrow("shorter than 3 characters")
        expect(() => backend.setApprovalAnswers(sessionId, approvalId, { q1: ["prd"], q2: ["Ship it"], q3: ["Yes"] })).toThrow("not one of the choices")
        expect(backend.setApprovalAnswers(sessionId, approvalId, { q1: ["Production"], q2: ["Ship it"], q3: ["Yes"] })).toBe(true)
        expect(await backend.resolveApproval(sessionId, approvalId, true)).toBe(true)
      })
      expect(required).toMatchObject({
        action: "question",
        capability: "user.input",
        reason: "deploys: Where should the release go?",
        questions: [
          { id: "q1", question: "Target", header: "deploys", options: [{ label: "Staging" }, { label: "Production" }] },
          { id: "q2", question: "Release notes: One line", header: "deploys", options: [], other: true },
          { id: "q3", question: "Notify the team", header: "deploys", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      })
      expect(reply).toContain(JSON.stringify({ action: "accept", content: { target: "prd", notes: "Ship it", notify: true }, _meta: null }))
      expect(resolved).toMatchObject({ approved: true, answers: { q1: ["Production"], q2: ["Ship it"], q3: ["Yes"] } })
      expect(events.every((event) => isAgentEvent(event))).toBe(true)
    })

    test("declined, the server hears decline; approved with no answers, cancel", async () => {
      const declined = await ask("elicitation", async (backend, sessionId, approvalId) => {
        await backend.resolveApproval(sessionId, approvalId, false)
      })
      expect(declined.reply).toContain(JSON.stringify({ action: "decline", content: null, _meta: null }))
      expect(declined.resolved).not.toHaveProperty("answers")
      const unanswered = await ask("elicitation", async (backend, sessionId, approvalId) => {
        await backend.resolveApproval(sessionId, approvalId, true)
      })
      expect(unanswered.reply).toContain(JSON.stringify({ action: "cancel", content: null, _meta: null }))
    })

    test("a form with no fields is a plain approval; approved, it is accepted", async () => {
      const { reply, required } = await ask("elicitation-confirm", async (backend, sessionId, approvalId) => {
        expect(backend.setApprovalAnswers(sessionId, approvalId, { q1: ["Yes"] })).toBe(false)
        await backend.resolveApproval(sessionId, approvalId, true)
      })
      expect(required).toMatchObject({ action: "Allow deploys to run ship?", capability: "user.input", reason: "deploys: Allow deploys to run ship?" })
      expect(required).not.toHaveProperty("questions")
      expect(reply).toContain(JSON.stringify({ action: "accept", content: {}, _meta: null }))
    })

    test("one Runrail cannot show is declined without asking, and the person sees it and why", async () => {
      const answered: boolean[] = []
      const { events, reply, required, resolved } = await ask("elicitation-unsupported", async (backend, sessionId, approvalId) => {
        answered.push(await backend.resolveApproval(sessionId, approvalId, true) === true)
      })
      expect(answered).toEqual([false])
      expect(required).toMatchObject({ action: "How many replicas?", capability: "user.input", reason: "deploys: How many replicas?" })
      expect(resolved).toMatchObject({ approvalId: required?.type === "approval.required" ? required.approvalId : "", approved: false, reason: "\"Replicas\" is not text, a number, a choice, or yes/no" })
      expect(reply).toContain(JSON.stringify({ action: "decline", content: null, _meta: null }))
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    })

    test("one Codex settles on its own is withdrawn, and one with no turn running is cancelled", async () => {
      const withdrawn = await ask("elicitation-withdrawn")
      expect(withdrawn.resolved).toMatchObject({ approved: false, withdrawn: true })
      expect(withdrawn.events.at(-1)).toMatchObject({ type: "session.completed" })
      const early = await ask("elicitation-early")
      expect(early.required).toBeUndefined()
      expect(JSON.parse(early.reply)).toEqual({ "early-elicitation": { action: "cancel", content: null, _meta: null } })
    })
  })

  describe("a request Codex makes of Runrail", () => {
    const reply = (events: AgentEvent[]): string => events.filter((event) => event.type === "assistant.message").map((event) => event.text).join("")
    const run = async (mode: string, onLive?: (frame: RunrailLiveFrameInput) => void) => {
      const backend = createCodexHarness({ command: process.execPath, args: [fixture, mode], protocol: "app-server", ...(onLive === undefined ? {} : { onLive }) }) as CodexAppServerBackend
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `codex-${mode}` })
      const events: AgentEvent[] = []
      try {
        for await (const event of backend.send({ sessionId: session.id, message: "go" })) {
          events.push(event)
          if (event.type === "approval.required" && mode === "subagent-approval") await backend.resolveApproval(session.id, event.approvalId, true)
        }
      } finally {
        await backend.close(session.id)
      }
      expect(events.every((event) => isAgentEvent(event))).toBe(true)
      return { events, reply: reply(events) }
    }

    test("from a sub-agent's thread reaches the person as the sub-agent's, under its spawn call", async () => {
      const frames: RunrailLiveFrameInput[] = []
      const { events, reply } = await run("subagent-approval", (frame) => frames.push(frame))
      const required = events.find((event) => event.type === "approval.required")
      expect(required).toMatchObject({ turnId: "fixture-turn-1", approvalId: "codex-request-approval-1", capability: "process.exec", reason: "Asked by Codex sub-agent Euclid: fixture command" })
      expect(frames).toContainEqual({ type: "lineage", parentCallId: "spawn-1", eventSeq: required?.seq })
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approvalId: "codex-request-approval-1", approved: true }))
      // Codex got the v2 decision for its sub-agent's command.
      expect(reply).toBe("decision accept")
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    })

    test("from a sub-agent that Codex settles itself is withdrawn, not left waiting", async () => {
      const { events } = await run("subagent-withdrawn")
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.required", approvalId: "codex-request-sub-patch-1", capability: "filesystem.write", reason: "Asked by Codex sub-agent Euclid" }))
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approvalId: "codex-request-sub-patch-1", approved: false, withdrawn: true }))
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    })

    const refused = (what: string, why: string) => `Runrail refused a Codex request ${what}: ${why}.`
    const foreignThread = "it came from a Codex thread that is neither this session's nor one of its sub-agents"
    const endedTurn = "it belongs to a Codex turn that has already ended"
    const noTurn = "no turn was running, so no one could answer it"

    test("from no thread or turn of this session is refused, the person is told why, and the turn goes on", async () => {
      const frames: RunrailLiveFrameInput[] = []
      const before = Math.floor(Date.now() / 1000)
      const { events, reply } = await run("foreign-approval", (frame) => frames.push(frame))
      const after = Math.floor(Date.now() / 1000)
      expect(events.filter((event) => event.type === "approval.required")).toEqual([])
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
      const messages = [
        refused("to run a command", foreignThread),
        refused("for wider access", foreignThread),
        refused("to change files", endedTurn),
        refused("to ask you a question", endedTurn),
      ]
      // Codex keeps its own fixed words for a refusal, so the person reads these in Runrail's frames.
      expect(frames.filter((frame) => frame.type === "request.refused")).toEqual(messages.map((message) => ({ type: "request.refused", source: "codex", turnId: "fixture-turn-1", message })))
      const answers = JSON.parse(reply) as Record<string, unknown>
      expect(answers).toEqual({
        "foreign-command-1": { code: -32000, message: messages[0] },
        "foreign-permissions-1": { code: -32000, message: messages[1] },
        "stale-patch-1": { code: -32000, message: messages[2] },
        "stale-question-1": { code: -32000, message: messages[3] },
        "turn-time-1": { currentTimeAt: expect.any(Number) },
      })
      const time = (answers["turn-time-1"] as { currentTimeAt: number }).currentTimeAt
      expect(Number.isInteger(time) && time >= before && time <= after).toBe(true)
    })

    test("with no turn running is refused and the person told why; the time is told and a token refresh is refused in words", async () => {
      const frames: RunrailLiveFrameInput[] = []
      const before = Math.floor(Date.now() / 1000)
      const { events, reply } = await run("early-requests", (frame) => frames.push(frame))
      const after = Math.floor(Date.now() / 1000)
      expect(events.filter((event) => event.type === "approval.required")).toEqual([])
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
      const approval = refused("to run a command", noTurn)
      const refresh = refused("to refresh its ChatGPT sign-in", "Runrail holds no ChatGPT tokens for Codex. Sign in to Codex again with `codex login`")
      expect(frames.filter((frame) => frame.type === "request.refused")).toEqual([approval, refresh].map((message) => ({ type: "request.refused", source: "codex", message })))
      const answers = JSON.parse(reply) as Record<string, unknown>
      expect(answers).toEqual({
        "early-approval": { code: -32000, message: approval },
        "early-time": { currentTimeAt: expect.any(Number) },
        "early-refresh": { code: -32000, message: refresh },
      })
      const time = (answers["early-time"] as { currentTimeAt: number }).currentTimeAt
      expect(Number.isInteger(time) && time >= before && time <= after).toBe(true)
    })

    test("an MCP server's form cancelled with no turn running tells the person why", async () => {
      const frames: RunrailLiveFrameInput[] = []
      const { reply } = await run("elicitation-early", (frame) => frames.push(frame))
      expect(JSON.parse(reply)).toEqual({ "early-elicitation": { action: "cancel", content: null, _meta: null } })
      expect(frames.filter((frame) => frame.type === "request.refused")).toEqual([{ type: "request.refused", source: "codex", message: refused("to show you an MCP server's form", noTurn) }])
    })
  })

  test("reports a command the user declined as denied, and one they allowed as done", async () => {
    for (const approved of [false, true]) {
      const backend = createCodexHarness({ command: process.execPath, args: [fixture, "approval"], protocol: "app-server" })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `codex-app-server-decline-${String(approved)}` })
      const events: AgentEvent[] = []
      for await (const event of backend.send({ sessionId: session.id, message: "approval" })) {
        events.push(event)
        if (event.type === "approval.required") await backend.resolveApproval?.(session.id, event.approvalId, approved)
      }
      const done = events.find((event) => event.type === "tool.completed")
      if (approved) expect(done).toMatchObject({ ok: true, name: "command" })
      else expect(done).toMatchObject({ ok: false, name: "command", error: { code: "APPROVAL_DENIED" } })
      await backend.close(session.id)
    }
  })

  test("surfaces Codex permission approval requests and returns a bounded grant", async () => {
    const permissionFixture = new URL("../fixtures/codex-permissions-app-server.ts", import.meta.url).pathname
    const backend = createCodexHarness({ command: process.execPath, args: [permissionFixture], protocol: "app-server" }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-permission" })
    const events: AgentEvent[] = []
    await (async () => {
      for await (const event of backend.send({ sessionId: session.id, message: "permission" })) {
        events.push(event)
        if (event.type === "approval.required") await backend.resolveApproval?.(session.id, event.approvalId, true)
      }
    })()
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.required", approvalId: "codex-request-fixture-permission-request", capability: "sandbox.permission" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approvalId: "codex-request-fixture-permission-request", approved: true }))
    expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close(session.id)
  })

  test("rejects unsupported controls and stale approval handles", async () => {
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "approval"], protocol: "app-server" }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-app-server-unsupported" })
    await expect(backend.configureMcp(session.id, {})).rejects.toMatchObject({ code: "COMMAND_AGENT_UNSUPPORTED" })
    const iterator = backend.send({ sessionId: session.id, message: "approval" })[Symbol.asyncIterator]()
    let approval: AgentEvent | undefined
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === "approval.required") {
        approval = next.value
        break
      }
    }
    expect(approval).toMatchObject({ type: "approval.required" })
    await backend.cancel(session.id, "test cleanup")
    await expect(backend.resolveApproval(session.id, "fixture-approval", true)).resolves.toBe(false)
    await backend.close(session.id)
  })
})
