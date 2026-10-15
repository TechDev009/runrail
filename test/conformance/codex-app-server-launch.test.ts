import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAgentEvent, type AgentBackend, type AgentEvent } from "@nifrajs/agent-protocol"
import { CodexAppServerBackend, createCodexHarness, createFileVendorSessionStore } from "../../src/index.ts"

const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname

interface Echo {
  readonly thread: { readonly method: string; readonly params: Record<string, unknown> }
  readonly turn: Record<string, unknown>
}

function server(mode: string, options: Partial<ConstructorParameters<typeof CodexAppServerBackend>[0]> = {}): CodexAppServerBackend {
  return createCodexHarness({ command: process.execPath, args: [fixture, mode], protocol: "app-server", ...options }) as CodexAppServerBackend
}

async function collect(backend: AgentBackend, sessionId: string, message: string, decide?: boolean): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message })) {
    events.push(event)
    if (event.type === "approval.required" && decide !== undefined) await backend.resolveApproval?.(sessionId, event.approvalId, decide, decide ? "approved by test" : "declined by test")
  }
  return events
}

/** Reviews and reviewer notices are live frames: the agent protocol takes only its own events. */
function live(frames: readonly unknown[], type: string): Record<string, unknown>[] {
  return frames.filter((frame) => (frame as { readonly type?: unknown }).type === type) as Record<string, unknown>[]
}

function answer(events: readonly AgentEvent[]): string {
  const message = events.find((event) => event.type === "assistant.message")
  if (message?.type !== "assistant.message") throw new Error("the fixture gave no answer")
  return message.text
}

let state: string

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "runrail-codex-state-"))
})

afterAll(async () => {
  await rm(state, { recursive: true, force: true })
})

describe("Codex app-server launch settings", () => {
  test("starts the thread with the model, policy, and instructions, and each turn with the effort", async () => {
    const backend = server("echo", { launch: { model: "gpt-fixture", effort: "max", permissionMode: "ask", appendSystemPrompt: "Prefer small diffs." } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-launch-echo" })
    const first = JSON.parse(answer(await collect(backend, session.id, "first"))) as Echo
    expect(first.thread).toEqual({ method: "thread/start", params: { cwd: "/tmp", model: "gpt-fixture", approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write", developerInstructions: "Prefer small diffs." } })
    // The thread already has the model; a turn names one only when it changes.
    expect(first.turn).toEqual({ threadId: "fixture-codex-thread", effort: "max" })

    await backend.setModel(session.id, "gpt-other")
    await backend.setThinking(session.id, "low")
    expect((JSON.parse(answer(await collect(backend, session.id, "second"))) as Echo).turn).toEqual({ threadId: "fixture-codex-thread", model: "gpt-other", effort: "low" })
    // Codex keeps a turn's model for the turns after it; the effort is sent every time.
    expect((JSON.parse(answer(await collect(backend, session.id, "third"))) as Echo).turn).toEqual({ threadId: "fixture-codex-thread", effort: "low" })
    // A level changed mid-session maps as it does at launch.
    await backend.setThinking(session.id, "max")
    expect((JSON.parse(answer(await collect(backend, session.id, "fourth"))) as Echo).turn).toEqual({ threadId: "fixture-codex-thread", effort: "max" })
    await backend.setThinking(session.id, "off")
    expect((JSON.parse(answer(await collect(backend, session.id, "fifth"))) as Echo).turn).toEqual({ threadId: "fixture-codex-thread", effort: "low" })
    await expect(backend.setThinking(session.id, "extreme")).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    await backend.close(session.id)
  })

  test("Auto starts the thread with Codex's own reviewer answering its approvals (Approve for me)", async () => {
    const backend = server("echo", { launch: { permissionMode: "auto" } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-launch-auto" })
    const echo = JSON.parse(answer(await collect(backend, session.id, "first"))) as Echo
    expect(echo.thread).toEqual({ method: "thread/start", params: { cwd: "/tmp", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" } })
    await backend.close(session.id)
  })

  test("Auto shows what Codex's reviewer decided, on one line, and only for this thread", async () => {
    const frames: unknown[] = []
    const backend = server("auto-review", { launch: { permissionMode: "auto" }, onLive: (frame) => frames.push(frame) })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-auto-reviews" })
    const events = await collect(backend, session.id, "first")
    const turnId = "fixture-turn-1"
    expect(events.every((event) => isAgentEvent(event))).toBe(true)
    expect(live(frames, "approval.reviewed")).toEqual([
      { type: "approval.reviewed", turnId, reviewId: "codex-review-1", reviewer: "codex", decision: "reviewing", action: "command", capability: "process.exec", detail: "curl -sSI https://example.com" },
      { type: "approval.reviewed", turnId, reviewId: "codex-review-1", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec", risk: "low", detail: "curl -sSI https://example.com", rationale: "Reads a public page." },
      { type: "approval.reviewed", turnId, reviewId: "codex-review-2", reviewer: "codex", decision: "denied", action: "file_change", capability: "filesystem.write", risk: "high", detail: "a.ts, b.ts, c.ts and 2 more", rationale: "Rewrites files outside the task." },
    ])
    // Codex said it runs its reviewer, so nothing says it is missing.
    expect(live(frames, "reviewer.notice")).toEqual([{ type: "reviewer.notice", turnId, reviewer: "codex", notice: "warning", message: "Automatic approval review failed: reviewer unavailable" }])
    expect(events.some((event) => event.type === "approval.required")).toBe(false)
    // The patch the reviewer refused ends as its decision, not the person's.
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ callId: "patch-1", ok: false, error: { code: "REVIEW_DENIED" } })
    expect(answer(events)).toBe("fixture answer 1")
    await backend.close(session.id)
  })

  test("Auto says once a session when Codex comes back without its reviewer; Ask never does", async () => {
    const frames: unknown[] = []
    const auto = server("auto-review-refused", { launch: { permissionMode: "auto" }, onLive: (frame) => frames.push(frame) })
    const session = await auto.createSession({ cwd: "/tmp", sessionId: "codex-auto-refused" })
    const first = await collect(auto, session.id, "first")
    expect(answer(first)).toBe("fixture answer 1")
    expect(live(frames, "reviewer.notice")).toEqual([
      { type: "reviewer.notice", turnId: "fixture-turn-1", reviewer: "codex", notice: "unavailable" },
      { type: "reviewer.notice", turnId: "fixture-turn-1", reviewer: "codex", notice: "warning", message: "Automatic approval review failed: reviewer unavailable" },
    ])
    const before = frames.length
    await collect(auto, session.id, "second")
    expect(live(frames.slice(before), "reviewer.notice").filter((notice) => notice.notice === "unavailable")).toEqual([])
    await auto.close(session.id)

    const askFrames: unknown[] = []
    const ask = server("normal", { launch: { permissionMode: "ask" }, onLive: (frame) => askFrames.push(frame) })
    const asked = await ask.createSession({ cwd: "/tmp", sessionId: "codex-ask-reviewer" })
    await collect(ask, asked.id, "first")
    expect(live(askFrames, "reviewer.notice")).toEqual([])
    await ask.close(asked.id)
  })

  test("sends no policy when none was chosen, so the CLI's own configuration applies", async () => {
    const backend = server("echo")
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-launch-bare" })
    const echo = JSON.parse(answer(await collect(backend, session.id, "first"))) as Echo
    expect(echo.thread).toEqual({ method: "thread/start", params: { cwd: "/tmp" } })
    expect(echo.turn).not.toHaveProperty("effort")
    expect(echo.turn).not.toHaveProperty("model")
    await backend.close(session.id)
  })

  test("rejects launch settings the server route cannot carry", () => {
    expect(() => server("echo", { launch: { mcpConfig: ["/tmp/mcp.json"] } })).toThrow()
    expect(() => server("echo", { launch: { model: "--flag" } })).toThrow()
    expect(() => server("echo", { launch: { effort: "extreme" } as never })).toThrow()
    expect(() => server("echo", { vendorSessions: { load: "nope" } as never })).toThrow()
    try {
      server("echo", { launch: { unknown: true } as never })
      throw new Error("expected a rejection")
    } catch (error) {
      expect(error).toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    }
  })

  test("continues the stored thread in a new process with the same settings", async () => {
    const store = createFileVendorSessionStore(join(state, "stored"), "codex")
    const before = server("echo", { launch: { model: "gpt-fixture", permissionMode: "plan" }, vendorSessions: store })
    const session = await before.createSession({ cwd: "/tmp", sessionId: "codex-launch-stored" })
    expect((JSON.parse(answer(await collect(before, session.id, "first"))) as Echo).thread.method).toBe("thread/start")
    await before.close(session.id)
    expect(await store.load("codex-launch-stored")).toBe("fixture-codex-thread")

    await store.save("codex-launch-stored", "stored-thread-7")
    const after = server("echo", { launch: { model: "gpt-fixture", permissionMode: "plan" }, vendorSessions: store })
    await after.createSession({ cwd: "/tmp", sessionId: "codex-launch-stored" })
    const echo = JSON.parse(answer(await collect(after, "codex-launch-stored", "second"))) as Echo
    expect(echo.thread).toEqual({ method: "thread/resume", params: { threadId: "stored-thread-7", cwd: "/tmp", excludeTurns: true, model: "gpt-fixture", approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only" } })
    expect(echo.turn).toMatchObject({ threadId: "stored-thread-7" })
    await after.close("codex-launch-stored")

    const named = server("echo", { launch: { resume: "launch-thread-3" } })
    await named.createSession({ cwd: "/tmp", sessionId: "codex-launch-named" })
    expect((JSON.parse(answer(await collect(named, "codex-launch-named", "go"))) as Echo).thread.params).toMatchObject({ threadId: "launch-thread-3" })
    await named.close("codex-launch-named")
  })

  test("starts a new thread when the server no longer has the stored one", async () => {
    const store = createFileVendorSessionStore(join(state, "missing"), "codex")
    await store.save("codex-launch-gone", "stale-thread")
    const backend = server("resume-missing", { vendorSessions: store })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-launch-gone" })
    expect((await collect(backend, session.id, "go")).at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close(session.id)
    expect(await store.load("codex-launch-gone")).toBe("fixture-codex-thread-new")
  })
})

describe("Codex app-server start", () => {
  test("opening a session runs no process; a missing tool fails the turn and the session stays", async () => {
    const backend = createCodexHarness({ command: join(state, "not-installed"), protocol: "app-server", vendorSessions: createFileVendorSessionStore(join(state, "lazy"), "codex") }) as CodexAppServerBackend
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-lazy" })
    expect(session).toMatchObject({ id: "codex-lazy", status: "idle" })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(collect(backend, session.id, "go")).rejects.toMatchObject({ code: "COMMAND_AGENT_NOT_FOUND" })
    }
    await expect(backend.fork({ sessionId: session.id })).rejects.toMatchObject({ code: "COMMAND_AGENT_NOT_FOUND" })
    expect(await backend.snapshot(session.id)).toMatchObject({ id: "codex-lazy" })
    await backend.close(session.id)
  })

  test("a fork before the first turn starts the thread it needs", async () => {
    const backend = server("normal", { launch: { resume: "launch-thread-3" }, vendorSessions: createFileVendorSessionStore(join(state, "lazy-fork"), "codex") })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-lazy-fork" })
    const fork = await backend.fork({ sessionId: session.id })
    expect(fork.parentSessionId).toBe(session.id)
    expect((await collect(backend, session.id, "go")).at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close(session.id)
  })
})

describe("Codex app-server approvals and stray messages", () => {
  test("answers each approval family in its own shape, both ways", async () => {
    const cases = [
      { mode: "approval", approved: true, decision: "accept" },
      { mode: "approval", approved: false, decision: "decline" },
      { mode: "file-approval", approved: true, decision: "accept" },
      { mode: "file-approval", approved: false, decision: "decline" },
      { mode: "legacy-approval", approved: true, decision: "approved" },
      // The model hears who said no, and the person's note.
      { mode: "legacy-approval", approved: false, decision: "denied: The user declined this action: declined by test" },
    ] as const
    for (const [index, { mode, approved, decision }] of cases.entries()) {
      const backend = server(mode)
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `codex-approval-${index}` })
      const events = await collect(backend, session.id, "needs approval", approved)
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.required" }))
      // The command Codex wants to run is what the person sees, with where it runs.
      if (mode === "legacy-approval") expect(events).toContainEqual(expect.objectContaining({ type: "approval.required", action: "true\n(in /)", capability: "process.exec" }))
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approved }))
      expect(answer(events)).toBe(`decision ${decision}`)
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
      await backend.close(session.id)
    }
  })

  test("ignores messages that are not part of the turn and refuses requests it cannot serve", async () => {
    const backend = server("noise")
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-noise" })
    const events = await collect(backend, session.id, "go")
    expect(events.at(-1)).toMatchObject({ type: "session.completed" })
    expect(events.filter((event) => event.type === "session.failed")).toHaveLength(0)
    expect(JSON.stringify(events)).not.toContain("leaked")
    expect(answer(events)).toBe("fixture answer 1")
    // The thread is still the one Runrail started: a second turn works.
    expect((await collect(backend, session.id, "again")).at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close(session.id)
  })
})
