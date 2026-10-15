import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { MultiAgentCoordinator, AgentRegistryError, createAgentHandoff, createRunrailSessionAgentExecutor } from "../../src/agents/index.ts"
import type { SubagentExecutor } from "@nifrajs/coding-agent"

describe("bounded multi-agent runtime", () => {
  test("runs independent agents in parallel, retries declared failures, and preserves order", async () => {
    let active = 0
    let peak = 0
    let retryCalls = 0
    const executor: SubagentExecutor = {
      run: async ({ spec }) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        if (spec.id === "retry" && retryCalls++ === 0) throw new Error("temporary")
        return { output: spec.id, status: "completed" }
      },
    }
    const coordinator = new MultiAgentCoordinator({
      cwd: "/tmp",
      profiles: [
        { id: "analyst", role: "analyst", capabilities: ["inspect"] },
        { id: "writer", role: "writer", capabilities: ["edit"] },
      ],
      executor,
      maxChildren: 4,
      allowedCapabilities: ["inspect", "edit"],
    })
    const results = await coordinator.runMany([
      { id: "one", profile: "analyst", prompt: "inspect", requiredCapabilities: ["inspect"] },
      { id: "retry", profile: "writer", prompt: "edit", requiredCapabilities: ["edit"], retryable: true, maxRetries: 1 },
    ], { maxConcurrency: 2 })
    expect(peak).toBe(2)
    expect(results.map((result) => result.id)).toEqual(["one", "retry"])
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(results[1]?.attempts).toBe(2)
    expect(coordinator.listRuns()).toHaveLength(2)
    expect(coordinator.listRuns().every((run) => run.status === "completed" && run.errorCode === undefined && /^[0-9a-f]{64}$/.test(run.digest))).toBe(true)
  })

  test("a task that fails every try reports the tries it made and why it failed", async () => {
    let calls = 0
    const coordinator = new MultiAgentCoordinator({
      cwd: "/tmp",
      profiles: [{ id: "reader", role: "reader", capabilities: ["read"] }],
      executor: { run: async () => { calls += 1; throw new Error("request timed out") } },
      allowedCapabilities: ["read"],
    })
    const result = await coordinator.run({ id: "flaky", profile: "reader", prompt: "read", retryable: true, maxRetries: 2 })
    expect(calls).toBe(3)
    expect(result).toMatchObject({ ok: false, attempts: 3, errorCode: "AGENT_TIMEOUT" })
  })

  test("fails closed on capabilities and cancellation", async () => {
    const coordinator = new MultiAgentCoordinator({
      cwd: "/tmp",
      profiles: [{ id: "reader", role: "reader", capabilities: ["read"] }],
      executor: { run: () => ({ output: "never" }) },
      allowedCapabilities: ["read"],
    })
    await expect(coordinator.run({ id: "bad", profile: "reader", prompt: "write", requiredCapabilities: ["write"] })).rejects.toMatchObject({ code: "AGENT_CAPABILITY_DENIED" })
    const abort = new AbortController()
    abort.abort()
    const result = await coordinator.run({ id: "cancel", profile: "reader", prompt: "read" }, { signal: abort.signal })
    expect(result).toMatchObject({ id: "cancel", ok: false, errorCode: "AGENT_CANCELLED" })
    expect(() => new MultiAgentCoordinator({ cwd: "/tmp", profiles: [], executor: { run: () => ({}) }, maxChildren: 0 })).toThrow(AgentRegistryError)
  })

  test("a cancelled batch gives every task a cancelled result and leaves none queued", async () => {
    const coordinator = new MultiAgentCoordinator({
      cwd: "/tmp",
      profiles: [{ id: "reader", role: "reader", capabilities: ["read"] }],
      executor: { run: () => ({ output: "never" }) },
    })
    const abort = new AbortController()
    abort.abort()
    const tasks = ["one", "two", "three", "four"].map((id) => ({ id, profile: "reader", prompt: "read" }))
    const results = await coordinator.runMany(tasks, { signal: abort.signal, maxConcurrency: 1 })
    expect(results.map((result) => result?.errorCode)).toEqual(["AGENT_CANCELLED", "AGENT_CANCELLED", "AGENT_CANCELLED", "AGENT_CANCELLED"])
    expect(coordinator.listRuns().map((run) => run.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"])
  })

  test("creates content-free handoffs", async () => {
    const handoff = await createAgentHandoff({
      handoffId: "handoff-1",
      runId: "run-1",
      source: "analyst",
      target: "writer",
      objective: "inspect secret prompt content",
      acceptance: "write the fix",
      changedPaths: ["src/index.ts"],
    })
    expect(handoff).toMatchObject({ source: "analyst", target: "writer", changedPaths: ["src/index.ts"] })
    expect(JSON.stringify(handoff)).not.toContain("inspect secret prompt content")
    expect(JSON.stringify(handoff)).not.toContain("write the fix")
  })

  test("executes a subagent through the Runrail session boundary", async () => {
    const cwd = await mkdtemp("/tmp/runrail-agent-session-")
    try {
      const executor = createRunrailSessionAgentExecutor({
        session: {
          backend: "native",
          loadExtensions: false,
          model: { complete: () => ({ type: "text", text: "agent done" }) },
        },
      })
      const result = await executor.run({ spec: { id: "session-agent", role: "worker", prompt: "finish", capabilities: [] }, signal: new AbortController().signal, cwd })
      expect(result).toMatchObject({ status: "completed", text: "agent done" })
      // A streamed reply arrives as deltas and then as the whole message; it is kept once, and counted once.
      const streaming = createRunrailSessionAgentExecutor({
        maxOutputChars: 8,
        session: {
          backend: "native",
          loadExtensions: false,
          model: { complete: async function* () { yield { type: "text_delta" as const, text: "hel" }; yield { type: "text_delta" as const, text: "lo" }; yield { type: "response" as const, response: { type: "text" as const, text: "hello" } } } },
        },
      })
      await expect(streaming.run({ spec: { id: "session-stream", role: "worker", prompt: "finish", capabilities: [] }, signal: new AbortController().signal, cwd })).resolves.toMatchObject({ status: "completed", text: "hello" })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
