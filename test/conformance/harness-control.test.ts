import { describe, expect, test } from "bun:test"
import type { AgentBackend, AgentEvent, AgentSessionSnapshot, CreateSessionInput, ForkSessionInput, ForkSessionResult, SendMessageInput } from "@nifrajs/agent-protocol"
import {
  HarnessControlError,
  CLAUDE_CODE_HARNESS_DESCRIPTOR,
  CODEX_HARNESS_DESCRIPTOR,
  createDefaultHarnessCompatibilityMatrix,
  createHarnessControlSession,
  parseHarnessCompatibilityMatrix,
  summarizeHarnessCompatibilityMatrix,
  validateHarnessCompatibilityMatrix,
  type HarnessControlBackend,
  type HarnessControlSnapshot,
  type HarnessControlStore,
} from "../../src/index.ts"

class FixtureBackend implements HarnessControlBackend {
  readonly info = Object.freeze({ name: "fixture", version: "1.0.0", capabilities: Object.freeze(["sessions", "streaming", "fork"]) })
  private current: AgentSessionSnapshot | undefined

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    this.current = snapshot(input.sessionId ?? "fixture-session", input.cwd, "idle", -1)
    return this.current
  }

  async *send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const current = this.requireCurrent()
    const startedSeq = current.lastSeq + 1
    const started = event(current.id, startedSeq, "session.started", { snapshot: snapshot(current.id, current.cwd, "running", startedSeq) })
    this.current = started.snapshot
    yield started
    const message = event(current.id, startedSeq + 1, "assistant.message", { turnId: "turn-1", text: input.message })
    yield message
    const completed = event(current.id, startedSeq + 2, "session.completed", { snapshot: snapshot(current.id, current.cwd, "completed", startedSeq + 2) })
    this.current = completed.snapshot
    yield completed
  }

  async cancel(): Promise<void> {
    const current = this.requireCurrent()
    this.current = snapshot(current.id, current.cwd, "stopped", current.lastSeq)
  }

  async snapshot(): Promise<AgentSessionSnapshot> {
    return this.requireCurrent()
  }

  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    return { sessionId: input.targetSessionId ?? "fixture-fork", parentSessionId: input.sessionId }
  }

  async reload(): Promise<{ revision: string; loaded: readonly string[]; disabled: readonly string[]; rolledBack: boolean }> {
    return { revision: "fixture", loaded: [], disabled: [], rolledBack: false }
  }

  async close(): Promise<void> {
    this.current = undefined
  }

  private requireCurrent(): AgentSessionSnapshot {
    if (this.current === undefined) throw new Error("fixture session missing")
    return this.current
  }
}

function snapshot(id: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq: number): AgentSessionSnapshot {
  return { version: 1, id, backend: "fixture", cwd, status, createdAt: 1, updatedAt: Date.now(), lastSeq, capabilities: ["sessions", "streaming", "fork"] }
}

function event<T extends AgentEvent["type"]>(sessionId: string, seq: number, type: T, value: Omit<Extract<AgentEvent, { type: T }>, "version" | "sessionId" | "seq" | "at" | "type">): Extract<AgentEvent, { type: T }> {
  return { version: 1, sessionId, seq, at: Date.now(), type, ...value } as Extract<AgentEvent, { type: T }>
}

describe("harness control and compatibility contract", () => {
  test("default matrix is conservative and content-free", () => {
    const matrix = createDefaultHarnessCompatibilityMatrix()
  expect(summarizeHarnessCompatibilityMatrix(matrix)).toMatchObject({ total: 18, gaps: [] })
    expect(matrix.rows.find((row) => row.id === "opencode.acp")).toMatchObject({ classification: "adapter", status: "live-verified", protocolVersion: "acp.v1" })
    expect(matrix.rows.find((row) => row.id === "goose.acp")).toMatchObject({ classification: "adapter", status: "live-verified", protocolVersion: "acp.v1" })
    expect(matrix.rows.find((row) => row.id === "gemini.acp")).toMatchObject({ classification: "adapter", status: "caller-owned" })
    expect(matrix.rows.find((row) => row.id === "claude-code.sdk")).toMatchObject({ classification: "adapter", status: "verified", protocolVersion: "claude.agent-sdk" })
    expect(matrix.rows.find((row) => row.id === "codex.lifecycle")).toMatchObject({ classification: "adapter", status: "verified" })
    expect(matrix.rows.find((row) => row.id === "codex.approval")).toMatchObject({ classification: "caller-owned", status: "caller-owned" })
    expect(matrix.rows.find((row) => row.id === "claude-code.approval")).toMatchObject({ classification: "caller-owned", status: "caller-owned" })
    expect(CODEX_HARNESS_DESCRIPTOR.features).not.toContain("approvals")
    expect(CLAUDE_CODE_HARNESS_DESCRIPTOR.features).not.toContain("approvals")
    expect(() => parseHarnessCompatibilityMatrix({ ...matrix, rows: [{ ...matrix.rows[0], id: "bad", fixture: "../escape" }] })).toThrow("HARNESS_MATRIX_INVALID")
    expect(() => parseHarnessCompatibilityMatrix({ ...matrix, rows: [{ ...matrix.rows[0], protocolVersion: "" }] })).toThrow("HARNESS_MATRIX_INVALID")
    expect(() => parseHarnessCompatibilityMatrix({ ...matrix, rows: [{ ...matrix.rows[0], authModes: ["caller", "caller"] }] })).toThrow("HARNESS_MATRIX_INVALID")
  })

  test("requires caller-supplied fixture, capability, and verification evidence", async () => {
    const matrix = createDefaultHarnessCompatibilityMatrix()
    const evidence = {
      fixtureExists: () => true,
      verifyCapability: () => true,
      verifyRow: () => true,
    }
    await expect(validateHarnessCompatibilityMatrix(matrix, evidence)).resolves.toMatchObject({ rows: matrix.rows })
    await expect(validateHarnessCompatibilityMatrix(matrix, { ...evidence, fixtureExists: () => false })).rejects.toMatchObject({ code: "HARNESS_MATRIX_INVALID" })
    await expect(validateHarnessCompatibilityMatrix(matrix, { ...evidence, verifyCapability: () => false })).rejects.toMatchObject({ code: "HARNESS_MATRIX_INVALID" })
    await expect(validateHarnessCompatibilityMatrix(matrix, { ...evidence, verifyRow: () => false })).rejects.toMatchObject({ code: "HARNESS_MATRIX_INVALID" })
  })

  test("shared control facade enforces ordering, persistence, fork, and close", async () => {
    const saved: HarnessControlSnapshot[] = []
    const store: HarnessControlStore = { save: (value) => { saved.push(value) } }
    const backend = new FixtureBackend()
    const control = await createHarnessControlSession(backend, { cwd: "/tmp", sessionId: "fixture-session" }, { controls: ["follow-up", "cancel", "fork", "close"], store })
    const events = await control.send("hello")
    expect(events.map((entry) => entry.type)).toEqual(["session.started", "assistant.message", "session.completed"])
    expect(control.snapshot()).toMatchObject({ sessionId: "fixture-session", status: "completed", lastSeq: 2 })
    await expect(control.continue("second turn")).resolves.toContainEqual(expect.objectContaining({ type: "assistant.message", text: "second turn" }))
    expect(control.snapshot()).toMatchObject({ status: "completed", lastSeq: 5 })
    await expect(control.fork("fixture-child")).resolves.toEqual({ sessionId: "fixture-child", parentSessionId: "fixture-session" })
    await expect(control.compact()).rejects.toMatchObject({ code: "HARNESS_CONTROL_UNSUPPORTED" })
    expect(saved.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "message"))).toBe(true)
    await control.close()
    await expect(control.send("after close")).rejects.toMatchObject({ code: "HARNESS_CONTROL_CLOSED" })
  })

  test("control facade refuses foreign or out-of-order events and stops the vendor turn", async () => {
    let turnSignal: AbortSignal | undefined
    const backend: AgentBackend = {
      info: { name: "bad-fixture", version: "1.0.0", capabilities: ["sessions"] },
      async createSession(input) { return snapshot(input.sessionId ?? "bad-session", input.cwd, "idle", -1) },
      async *send(input) {
        turnSignal = input.signal
        yield event(input.sessionId, 0, "session.started", { snapshot: snapshot(input.sessionId, "/tmp", "running", 0) })
        yield event(input.sessionId, 0, "session.completed", { snapshot: snapshot(input.sessionId, "/tmp", "completed", 0) })
      },
      async cancel() {},
      async snapshot(sessionId) { return snapshot(sessionId, "/tmp", "running", 0) },
      async reload() { return { revision: "bad", loaded: [], disabled: [], rolledBack: false } },
      async close() {},
    }
    const control = await createHarnessControlSession(backend, { cwd: "/tmp", sessionId: "bad-session" }, { controls: ["follow-up"] })
    await expect(control.send("hello")).rejects.toMatchObject({ code: "HARNESS_CONTROL_EVENT_INVALID" })
    expect(turnSignal?.aborted).toBe(true)
  })

  test("an interrupt during a send leaves the stop event to that send, and a provider/model id switches", async () => {
    let lastSeq = -1
    let release = (): void => undefined
    const stopped = new Promise<void>((resolve) => { release = resolve })
    const models: string[] = []
    const backend: HarnessControlBackend = {
      info: { name: "interrupt-fixture", version: "1.0.0", capabilities: ["sessions", "streaming"] },
      async createSession(input) { return snapshot(input.sessionId ?? "interrupt-session", input.cwd, "idle", lastSeq) },
      async *send(input) {
        lastSeq = 0
        yield event(input.sessionId, 0, "session.started", { snapshot: snapshot(input.sessionId, "/tmp", "running", 0) })
        await stopped
        yield event(input.sessionId, 1, "session.stopped", { reason: "interrupted" })
      },
      async cancel() {},
      // The backend queues its stop event and advertises it before the send has delivered it.
      async interrupt() {
        lastSeq = 1
        release()
      },
      async setModel(_sessionId, model) { models.push(model) },
      async snapshot(sessionId) { return snapshot(sessionId, "/tmp", lastSeq === 1 ? "stopped" : "running", lastSeq) },
      async reload() { return { revision: "fixture", loaded: [], disabled: [], rolledBack: false } },
      async close() {},
    }
    const control = await createHarnessControlSession(backend, { cwd: "/tmp", sessionId: "interrupt-session" }, { controls: ["follow-up", "interrupt", "model"] })
    const sending = control.send("hello")
    await Bun.sleep(10)
    await control.interrupt()
    await expect(sending).resolves.toMatchObject([{ type: "session.started" }, { type: "session.stopped" }])
    await control.setModel("anthropic/claude-sonnet-4-5")
    expect(models).toEqual(["anthropic/claude-sonnet-4-5"])
    await expect(control.setModel("bad model")).rejects.toMatchObject({ code: "HARNESS_CONTROL_INVALID" })
  })
})
