import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { MAX_TURN_EVENTS, RunrailSessionController } from "../../src/control.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-turn-keys-token-1234567890abcd"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

test("a message resent under the same key runs once and gets the first answer", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-turn-keys-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  let turns = 0
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    model: { complete: () => ({ type: "text", text: `answer ${String(++turns)}` }) },
  })
  cleanup.push(() => running.handle.stop())
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
    return (await response.json()) as { ok: boolean; result?: unknown; error?: { code: string } }
  }
  const first = await rpc("turn.enqueue", { message: "hello", idempotencyKey: "msg-1" })
  const again = await rpc("turn.enqueue", { message: "hello", idempotencyKey: "msg-1" })
  expect(first.ok).toBe(true)
  expect(again).toEqual(first)
  expect(turns).toBe(1)
  expect((await rpc("turn.enqueue", { message: "hello", idempotencyKey: "msg-2" })).ok).toBe(true)
  expect(turns).toBe(2)
  expect((await rpc("turn.enqueue", { message: "hello", idempotencyKey: "bad key with spaces" })).error?.code).toBe("CONTROL_INVALID_INPUT")
})

test("a key repeated after a large answer gets a bounded summary with the outcome, and still runs once", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-turn-keys-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  let turns = 0
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    verifyAfterTurn: false,
    model: { complete: () => { turns += 1; return { type: "text", text: "y".repeat(600_000) } } },
  })
  cleanup.push(() => running.handle.stop())
  const rpc = async (params: Record<string, unknown>) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "turn.enqueue", params }) })
    return await response.text()
  }
  const first = JSON.parse(await rpc({ message: "long", idempotencyKey: "msg-long" })) as { ok: boolean; result: { events: { type: string }[] } }
  expect(first.ok).toBe(true)
  expect(first.result.events.filter((event) => event.type === "assistant.message").length).toBeGreaterThan(1)
  const repeated = await rpc({ message: "long", idempotencyKey: "msg-long" })
  expect(repeated.length).toBeLessThanOrEqual(16 * 1024 + 64)
  const again = JSON.parse(repeated) as { ok: boolean; result: { events: { type: string }[]; omittedEvents?: number } }
  expect(again.ok).toBe(true)
  expect(again.result.events.at(-1)?.type).toBe("session.completed")
  expect(again.result.omittedEvents).toBe(first.result.events.length - again.result.events.length)
  expect(turns).toBe(1)
})

test("a turn hands back at most its newest events, and its outcome is among them", async () => {
  const total = MAX_TURN_EVENTS * 3 + 5
  const session = {
    snapshot: { id: "fixture", status: "idle" },
    backend: { info: { name: "native" } },
    prompt: async function* (): AsyncIterable<AgentEvent> {
      for (let seq = 0; seq < total - 1; seq += 1) yield { version: 1, sessionId: "fixture", seq, at: seq, type: "assistant.delta", turnId: "turn", text: "x" }
      yield { version: 1, sessionId: "fixture", seq: total - 1, at: total, type: "session.completed", turnId: "turn" } as unknown as AgentEvent
    },
  } as unknown as ConstructorParameters<typeof RunrailSessionController>[0]
  const events = await new RunrailSessionController(session).enqueue("fixture")
  expect(events.length).toBe(MAX_TURN_EVENTS)
  expect(events[0]?.seq).toBe(total - MAX_TURN_EVENTS)
  expect(events.at(-1)?.type).toBe("session.completed")
})
