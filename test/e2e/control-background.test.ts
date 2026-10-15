import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-background-token-1234567890ab"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function sleeping(marker: string): boolean {
  return Bun.spawnSync(["ps", "-A", "-o", "command="]).stdout.toString().split("\n").some((line) => line.trim() === `sleep ${marker}`)
}

async function start() {
  const cwd = await mkdtemp("/tmp/runrail-control-background-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const marker = `${30 + Math.floor(Math.random() * 1000) / 1000}`
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    approval: { request: () => true },
    model: {
      complete: (request) => request.messages.some((message) => message.role === "tool")
        ? { type: "text", text: "started" }
        : { type: "tool", name: "run_command", input: { program: "sleep", args: [marker], background: true } },
    },
  })
  cleanup.push(() => running.handle.stop())
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: any; error?: { code: string } } }
  }
  return { running, rpc, marker }
}

test("a background command is listed, read, and stopped with its process", async () => {
  const { running, rpc, marker } = await start()
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[]; capabilityStatus: Record<string, string> }
  expect(health.capabilities).toContain("background")
  expect(health.capabilityStatus.background).toBe("available")

  expect((await rpc("turn.enqueue", { message: "start the server" })).body.ok).toBe(true)
  const listed = await rpc("background.list")
  expect(listed.body.ok).toBe(true)
  const entry = listed.body.result.entries.find((candidate: { kind: string }) => candidate.kind === "command")
  expect(entry).toMatchObject({ id: "native:cmd-1", status: "running", label: `sleep ${marker}`, stoppable: true, hasOutput: true, foreground: false })
  expect(Array.isArray(listed.body.result.servers)).toBe(true)
  expect(typeof listed.body.result.serversAvailable).toBe("boolean")
  expect(sleeping(marker)).toBe(true)

  const output = await rpc("background.output", { id: entry.id })
  expect(output.body).toMatchObject({ ok: true, result: { id: entry.id, text: "", truncated: false } })

  const stopped = await rpc("background.stop", { id: entry.id })
  expect(stopped.body).toMatchObject({ ok: true, result: { id: entry.id, status: "stopped" } })
  expect(sleeping(marker)).toBe(false)
  // Stopping again is harmless.
  expect((await rpc("background.stop", { id: entry.id })).body).toMatchObject({ ok: true, result: { status: "stopped" } })
  const after = await rpc("background.list", { servers: false })
  expect(after.body.result.entries[0]).toMatchObject({ status: "stopped", stoppable: false })
  expect(after.body.result.servers).toBeUndefined()
})

test("background methods refuse unknown ids and bad input", async () => {
  const { rpc } = await start()
  expect(await rpc("background.stop", { id: "native:missing" })).toMatchObject({ status: 404, body: { ok: false, error: { code: "BACKGROUND_NOT_FOUND" } } })
  expect(await rpc("background.output", { id: "native:missing" })).toMatchObject({ status: 404, body: { ok: false, error: { code: "BACKGROUND_NOT_FOUND" } } })
  expect((await rpc("background.output", {})).body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
  expect((await rpc("background.stop", { id: "a\nb" })).body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
  expect((await rpc("background.output", { id: "x", maxBytes: 0 })).body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
  expect((await rpc("background.list", { servers: "yes" })).body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
})

test("closing the engine stops the commands its agent left running", async () => {
  const { running, rpc, marker } = await start()
  await rpc("turn.enqueue", { message: "start the server" })
  expect(sleeping(marker)).toBe(true)
  await running.handle.stop()
  expect(sleeping(marker)).toBe(false)
})
