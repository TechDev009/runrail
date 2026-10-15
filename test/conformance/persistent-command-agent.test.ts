import { describe, expect, test } from "bun:test"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"
import { PersistentCommandAgentBackend, createClaudeCodeHarness, createCodexHarness } from "../../src/index.ts"
import { UNANSWERABLE } from "../../src/backend/command-agent.ts"

const fixture = new URL("../fixtures/persistent-agent-jsonl.ts", import.meta.url).pathname

async function collect(backend: AgentBackend, sessionId: string, message: string) {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message })) events.push(event)
  return events
}

describe("persistent command agent backend", () => {
  test("keeps one normalized JSONL process across multiple turns", async () => {
    const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture], name: "persistent-fixture" })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "persistent-session" })
    const first = await collect(backend, session.id, "first")
    const second = await collect(backend, session.id, "second")
    expect(first.at(-1)?.type).toBe("session.completed")
    expect(second.find((event) => event.type === "assistant.message")).toMatchObject({ text: "second" })
    expect((await backend.snapshot(session.id)).lastSeq).toBe(5)
    await backend.close(session.id)
  })

  test("correlates persistent turns and rejects echoed request drift", async () => {
    const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture, "echo-correlation"], name: "persistent-correlation" })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "persistent-correlation-session" })
    const events = await collect(backend, session.id, "correlated")
    const turn = events.find((event) => event.type === "turn.started")
    expect(turn).toMatchObject({ turnId: expect.stringMatching(/^runrail-turn-/) })
    await backend.close(session.id)

    const drift = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture, "correlation-drift"], name: "persistent-correlation-drift" })
    const driftSession = await drift.createSession({ cwd: "/tmp", sessionId: "persistent-correlation-drift" })
    await expect(collect(drift, driftSession.id, "drift")).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })
    await drift.close(driftSession.id)
  })

  test("cancellation tears down a held process and yields a terminal stop", async () => {
    const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture, "hold"], name: "persistent-hold" })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "persistent-hold-session" })
    const controller = new AbortController()
    const events: AgentEvent[] = []
    const running = (async () => { for await (const event of backend.send({ sessionId: session.id, message: "hold", signal: controller.signal })) events.push(event) })()
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await running
    expect(events.at(-1)?.type).toBe("session.stopped")
    await backend.close(session.id)
  })

  test("a turn after a cancelled one runs on a fresh process", async () => {
    const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture], name: "persistent-restart" })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "persistent-restart-session" })
    const controller = new AbortController()
    const held = (async () => { for await (const _event of backend.send({ sessionId: session.id, message: "hold-this-turn", signal: controller.signal })) { /* drain */ } })()
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    await held
    const next = await Promise.race([collect(backend, session.id, "after cancel"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("turn hung")), 5_000))])
    expect(next.find((event) => event.type === "assistant.message")).toMatchObject({ text: "after cancel" })
    await backend.close(session.id)
  })

  test("the output limit applies to each turn, not to the life of the process", async () => {
    const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture], name: "persistent-output", maxOutputBytes: 4_096 })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "persistent-output-session" })
    for (let index = 0; index < 4; index += 1) {
      const events = await collect(backend, session.id, `${index}`.padEnd(1_000, "x"))
      expect(events.at(-1)?.type).toBe("session.completed")
    }
    await expect(collect(backend, session.id, "y".repeat(5_000))).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })
    await backend.close(session.id)
  })

  test("rejects a persistent turn that exceeds its event bound", async () => {
    const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture], name: "persistent-event-bound", maxEvents: 2 })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "persistent-event-bound" })
    await expect(collect(backend, session.id, "bounded")).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })
    await backend.close(session.id)
  })

  test("Codex and Claude adapters opt into the shared persistent backend", async () => {
    for (const create of [createCodexHarness, createClaudeCodeHarness]) {
      const backend = create({ command: process.execPath, args: [fixture], persistent: true })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `${backend.info.name}-persistent` })
      const events: AgentEvent[] = []
      for await (const event of backend.send({ sessionId: session.id, message: "vendor-persistent" })) events.push(event)
      expect(events.at(-1)?.type).toBe("session.completed")
      await backend.close(session.id)
    }
  })

  test("a process that dies mid-turn says why, with its exit code and its own error line", async () => {
    const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture, "die"], name: "persistent-die" })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "persistent-die-session" })
    await expect(collect(backend, session.id, "go")).rejects.toMatchObject({ code: "COMMAND_AGENT_FAILED", reason: "persistent agent exited with code 4: fatal: model server unreachable" })
    await backend.close(session.id)
  })

  test("a request is settled at once unless an approval handler can carry the answer", async () => {
    for (const handled of [false, true]) {
      const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: [fixture], name: "persistent-approval", ...(handled ? { controlHandlers: { resolveApproval: async () => true } } : {}) })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `persistent-approval-${String(handled)}` })
      const events = await collect(backend, session.id, "approval")
      expect([handled, events.map((event) => event.type)]).toEqual([handled, handled ? ["turn.started", "approval.required", "session.completed"] : ["turn.started", "approval.required", "approval.resolved", "session.completed"]])
      if (!handled) expect(events[2]).toMatchObject({ approvalId: "fixture-approval", approved: false, withdrawn: true, reason: UNANSWERABLE, seq: 2 })
      await backend.close(session.id)
    }
  })

  test("tracks vendor identities and preserves persistent authentication failures", async () => {
    const vendorFixture = new URL("../fixtures/persistent-vendor-harness.ts", import.meta.url).pathname
    for (const [create, mode] of [[createCodexHarness, "codex"], [createClaudeCodeHarness, "claude"]] as const) {
      const backend = create({ command: process.execPath, args: [vendorFixture, mode], persistent: true })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `${mode}-vendor-session` })
      const events = await collect(backend, session.id, "vendor identity")
      expect(events.some((event) => event.type === "assistant.message")).toBe(true)
      expect(events.at(-1)?.type).toBe("session.completed")
      await backend.close(session.id)
    }

    const auth = createClaudeCodeHarness({ command: process.execPath, args: [vendorFixture, "claude-auth"], persistent: true })
    const authSession = await auth.createSession({ cwd: "/tmp", sessionId: "persistent-auth-session" })
    await expect(collect(auth, authSession.id, "auth failure")).rejects.toMatchObject({ code: "COMMAND_AGENT_AUTH_FAILED" })
    await auth.close(authSession.id)
  })
})
