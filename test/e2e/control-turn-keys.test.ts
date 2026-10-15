import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
