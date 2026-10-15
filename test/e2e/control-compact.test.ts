import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"
import { createRunrailSessionController } from "../../src/control.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createReplayBackend } from "../../src/backend/replay.ts"
import { CommandAgentBackendError } from "../../src/backend/command-agent.ts"
import type { RunrailUsageReading } from "../../src/live/types.ts"

const token = "control-compact-token-1234567890abcdef"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** A coding tool stand-in: the replay backend's turns, with or without a compaction of its own. */
function toolBackend(options: { readonly compact?: (sessionId: string, reason: string) => Promise<unknown>; readonly usage?: RunrailUsageReading } = {}): AgentBackend {
  const inner = createReplayBackend()
  return {
    info: { ...inner.info, name: "tool", capabilities: [...inner.info.capabilities, ...(options.compact === undefined ? [] : ["compact"])] },
    createSession: (input) => inner.createSession(input),
    send: (input) => inner.send(input),
    cancel: (sessionId, reason) => inner.cancel(sessionId, reason),
    snapshot: (sessionId) => inner.snapshot(sessionId),
    reload: (sessionId) => inner.reload(sessionId),
    close: (sessionId) => inner.close(sessionId),
    ...(options.compact === undefined ? {} : { compact: options.compact }),
    ...(options.usage === undefined ? {} : { readUsage: async () => options.usage }),
  } as AgentBackend
}

function compactedEvent(sessionId: string, reason: string): AgentEvent {
  return { version: 1, sessionId, seq: 40, at: Date.now(), type: "memory.compacted", before: 900, after: 120, reason } as AgentEvent
}

async function controllerFor(backend: AgentBackend) {
  const cwd = await mkdtemp("/tmp/runrail-control-compact-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const controller = await createRunrailSessionController({ cwd, backend: "tool", adapter: { name: "tool", version: "1.0.0", capabilities: ["sessions"], create: () => backend }, loadExtensions: false })
  cleanup.push(() => controller.close("test complete"))
  return controller
}

describe("compaction through the controller", () => {
  test("a coding tool's compaction holds the queue and its notice reaches the event log", async () => {
    let release: (() => void) | undefined
    const reasons: string[] = []
    const controller = await controllerFor(toolBackend({
      compact: async (sessionId, reason) => {
        reasons.push(reason)
        await new Promise<void>((resolve) => { release = resolve })
        return compactedEvent(sessionId, reason)
      },
    }))
    const seen: string[] = []
    controller.subscribe((event) => seen.push(event.type))
    expect(controller.session.canCompact).toBe(true)
    const compacting = controller.compact("manual")
    while (release === undefined) await Bun.sleep(1)
    expect(controller.snapshot().active).toBe(true)
    await expect(controller.compact()).rejects.toMatchObject({ code: "CONTROL_SESSION_BUSY" })
    // A message sent meanwhile waits and then runs on the compacted conversation.
    const turn = controller.enqueue("after")
    await Bun.sleep(5)
    expect(seen).toEqual([])
    release()
    await expect(compacting).resolves.toEqual({ before: 900, after: 120, reason: "manual" })
    await expect(turn).resolves.toContainEqual(expect.objectContaining({ type: "assistant.message" }))
    expect(seen[0]).toBe("memory.compacted")
    expect(controller.eventsSince(39).map((event) => event.type)).toEqual(["memory.compacted"])
    expect(reasons).toEqual(["manual"])
  })

  test("a coding tool without compaction is refused rather than compacting Runrail's unused window", async () => {
    const controller = await controllerFor(toolBackend())
    expect(controller.session.canCompact).toBe(false)
    await expect(controller.compact()).rejects.toMatchObject({ code: "SESSION_COMPACT_UNSUPPORTED" })
    expect(await controller.session.readUsage()).toEqual({})
  })

  test("the tool's own failures reach the caller in Runrail's words; bad counts are refused", async () => {
    let failure: unknown = new CommandAgentBackendError("COMMAND_AGENT_TIMEOUT", "Claude Code did not finish compacting")
    const controller = await controllerFor(toolBackend({
      compact: async (sessionId, reason) => {
        if (failure !== undefined) throw failure
        return { ...compactedEvent(sessionId, reason), after: -1 }
      },
    }))
    await expect(controller.compact()).rejects.toMatchObject({ code: "SESSION_COMPACT_FAILED", message: "the coding tool did not finish compacting in time" })
    failure = new CommandAgentBackendError("COMMAND_AGENT_INVALID", "the conversation has nothing to compact yet")
    await expect(controller.compact()).rejects.toMatchObject({ code: "SESSION_COMPACT_FAILED", message: "the conversation has nothing to compact yet" })
    failure = undefined
    await expect(controller.compact()).rejects.toMatchObject({ code: "SESSION_COMPACT_INVALID" })
    // A failed compaction leaves the controller free for the next turn.
    expect(controller.snapshot().active).toBe(false)
    await expect(controller.enqueue("next")).resolves.toContainEqual(expect.objectContaining({ type: "assistant.message" }))
  })

  test("Runrail's own loop still compacts its prompt window", async () => {
    const cwd = await mkdtemp("/tmp/runrail-control-compact-native-")
    cleanup.push(() => rm(cwd, { recursive: true, force: true }))
    const controller = await createRunrailSessionController({ cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) } })
    cleanup.push(() => controller.close("test complete"))
    expect(controller.session.canCompact).toBe(true)
    await expect(controller.compact()).resolves.toMatchObject({ reason: "manual", removed: expect.any(Number) })
  })
})

describe("compaction and usage over the control RPC", () => {
  async function serverFor(backend: AgentBackend) {
    const cwd = await mkdtemp("/tmp/runrail-control-compact-rpc-")
    cleanup.push(() => rm(cwd, { recursive: true, force: true }))
    const running = await startRunrailControlRpcServer({ cwd, backend: "tool", adapter: { name: "tool", version: "1.0.0", capabilities: ["sessions"], create: () => backend }, authToken: token, loadExtensions: false })
    cleanup.push(() => running.handle.stop())
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
      return { status: response.status, body: await response.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string } } }
    }
    return { running, rpc }
  }

  test("the contract offers compaction where the backend has it, and the RPCs answer", async () => {
    const usage: RunrailUsageReading = { context: { usedTokens: 120, windowTokens: 1000, estimated: true }, plan: { type: "plan.limits", source: "claude-code", windows: [{ id: "five-hour", usedPercent: 12 }] } }
    const { running, rpc } = await serverFor(toolBackend({ compact: async (sessionId, reason) => compactedEvent(sessionId, reason), usage }))
    const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[]; capabilityStatus: Record<string, string> }
    expect(health.capabilities).toEqual(expect.arrayContaining(["session.compact", "session.usage"]))
    expect(health.capabilityStatus["session.compact"]).toBe("available")
    expect(health.capabilityStatus["session.usage"]).toBe("available")
    expect(await rpc("session.compact", { reason: "manual" })).toEqual({ status: 200, body: { ok: true, result: { before: 900, after: 120, reason: "manual" } } })
    expect((await rpc("session.usage.read")).body.result).toEqual(usage)
  })

  test("a backend without compaction is described as such and the RPC says why", async () => {
    const { rpc } = await serverFor(toolBackend())
    expect(((await rpc("control.describe")).body.result as { capabilityStatus: Record<string, string> }).capabilityStatus["session.compact"]).toBe("unavailable")
    const refused = await rpc("session.compact", { reason: "manual" })
    expect(refused.status).toBe(501)
    expect(refused.body.error).toEqual({ code: "CONTROL_CAPABILITY_UNAVAILABLE", message: "tool cannot compact its conversation" })
    expect((await rpc("session.usage.read")).body.result).toEqual({})
  })
})
