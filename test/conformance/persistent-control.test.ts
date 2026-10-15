import { describe, expect, test } from "bun:test"
import type { AgentBackend, AgentSessionSnapshot } from "@nifrajs/agent-protocol"
import {
  createClaudeCodeHarness,
  createClaudeCodeHarnessAdapter,
  createCodexHarness,
  createCodexHarnessAdapter,
  createHarnessControlSession,
  type PersistentCommandAgentControlHandlers,
} from "../../src/index.ts"

const fixture = new URL("../fixtures/persistent-agent-jsonl.ts", import.meta.url).pathname
const controls = ["follow-up", "cancel", "interrupt", "approve", "reject", "resume", "fork", "compact", "model", "thinking", "sandbox", "mcp", "inspect", "close"] as const

describe("persistent control contract", () => {
  test("advertises only persistent controls supplied by the caller", () => {
    const handlers: PersistentCommandAgentControlHandlers = {
      setModel: async () => undefined,
      configureMcp: async () => undefined,
    }
    const codex = createCodexHarnessAdapter({ persistent: true, controlHandlers: handlers })
    const claude = createClaudeCodeHarnessAdapter({ persistent: true, controlHandlers: handlers })
    expect(codex.descriptor.controls).toEqual(expect.arrayContaining(["model", "mcp"]))
    expect(codex.descriptor.controls).not.toContain("approve")
    expect(claude.descriptor.controls).toEqual(expect.arrayContaining(["model", "mcp"]))
    expect(claude.descriptor.controls).not.toContain("approve")
  })

  test("refuses an unprovided control before starting the vendor process", async () => {
    const backend = createCodexHarness({ command: process.execPath, args: [fixture], persistent: true })
    const control = await createHarnessControlSession(backend, { cwd: "/tmp", sessionId: "unsupported-control" }, { controls: ["compact", "close"] })
    await expect(control.compact()).rejects.toMatchObject({ code: "COMMAND_AGENT_UNSUPPORTED" })
    expect(control.snapshot()).toMatchObject({ status: "idle", lastSeq: -1 })
    await control.close()
  })

  test("runs the same restart, resume, fork, compact, and approval flow for Codex and Claude seams", async () => {
    for (const create of [createCodexHarness, createClaudeCodeHarness]) {
      let backend: AgentBackend | undefined
      const handlers = controlHandlers(() => {
        if (backend === undefined) throw new Error("fixture backend is not ready")
        return backend.snapshot("control-session")
      })
      backend = create({ command: process.execPath, args: [fixture, "hold-on-second"], persistent: true, controlHandlers: handlers })
      const control = await createHarnessControlSession(backend, { cwd: "/tmp", sessionId: "control-session" }, { controls })

      expect(control.inspect()).toMatchObject({ sessionId: "control-session", status: "idle" })
      await expect(control.send("first")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.completed" })]))

      const held = control.send("second")
      await new Promise((resolve) => setTimeout(resolve, 20))
      await control.cancel("fixture cancellation")
      await expect(held).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.stopped" })]))

      await expect(control.resume()).resolves.toMatchObject({ status: "idle", lastSeq: 3 })
      await expect(control.followUp("after restart")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.completed" })]))
      await expect(control.fork("control-branch")).resolves.toEqual({ sessionId: "control-branch", parentSessionId: "control-session" })
      await expect(control.compact("workflow")).resolves.toEqual({ before: 20, after: 8 })
      await expect(control.setModel("fixture-model")).resolves.toBeUndefined()
      await expect(control.setThinking("high")).resolves.toBeUndefined()
      await expect(control.setSandbox("workspace")).resolves.toBeUndefined()
      await expect(control.configureMcp({ fixture: true })).resolves.toBeUndefined()

      const approvalEvents = await control.send("approval")
      expect(approvalEvents).toContainEqual(expect.objectContaining({ type: "approval.required", approvalId: "fixture-approval" }))
      await expect(control.approve("fixture-approval", "approved by fixture")).resolves.toBe(true)
      await expect(control.reject("fixture-approval", "rejected by fixture")).resolves.toBe(true)
      await expect(control.interrupt()).resolves.toBeUndefined()
      await control.close()
    }
  })
})

function controlHandlers(readSnapshot: () => Promise<AgentSessionSnapshot>): PersistentCommandAgentControlHandlers {
  return {
    interrupt: async () => undefined,
    resume: async (sessionId) => ({ ...(await readSnapshot()), id: sessionId, status: "idle", updatedAt: Date.now() }),
    fork: async (input) => ({ sessionId: input.targetSessionId ?? "control-branch", parentSessionId: input.sessionId }),
    compact: async () => ({ before: 20, after: 8 }),
    setModel: async () => undefined,
    setThinking: async () => undefined,
    setSandbox: async () => undefined,
    configureMcp: async () => undefined,
    resolveApproval: async (_sessionId, approvalId) => approvalId === "fixture-approval",
  }
}
