import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-presentation-token-1234567890"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

test("tool starts carry a bounded presentation over turn results and the event stream", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-presentation-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, "notes.txt"), "hello\n", "utf8")
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    model: {
      complete: (request) => request.messages.some((message) => message.role === "tool")
        ? { type: "text", text: "read it" }
        : { type: "tool", name: "read_file", input: { path: "notes.txt" } },
    },
  })
  cleanup.push(() => running.handle.stop())
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["tool.presentation"]).toBe("available")

  const turn = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "turn.enqueue", params: { message: "read the notes" } }) })
  expect(turn.status).toBe(200)
  const body = await turn.json() as { result: { events: { type: string; presentation?: unknown }[] } }
  const started = body.result.events.find((event) => event.type === "tool.started")
  expect(started).toMatchObject({ name: "read_file", presentation: { kind: "read", path: "notes.txt", title: "Read notes.txt", truncated: false } })
  expect(body.result.events.filter((event) => event.type !== "tool.started").every((event) => event.presentation === undefined)).toBe(true)

  const abort = new AbortController()
  const stream = await fetch(`${running.handle.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal })
  expect(stream.status).toBe(200)
  const reader = stream.body?.getReader()
  if (reader === undefined) throw new Error("event stream has no body")
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 5_000
  while (!text.includes('"presentation"') && Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  abort.abort()
  const frame = text.split("\n\n").find((item) => item.includes('"type":"tool.started"'))
  const data = frame?.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
  expect(data === undefined ? undefined : JSON.parse(data)).toMatchObject({ presentation: { kind: "read", path: "notes.txt" } })
})

test("a test run names its intent, and its completion says whether the tests passed", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-intent-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    approval: { request: () => true },
    model: {
      complete: (request) => request.messages.at(-1)?.role === "tool"
        ? { type: "text", text: "ran them" }
        : { type: "tool", name: "run_command", input: { program: "bun", args: ["test"] } },
    },
  })
  cleanup.push(() => running.handle.stop())
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  type Item = { kind?: string; type?: string; [key: string]: unknown }
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
    return await response.json() as { ok: boolean; result: { events?: Item[]; items?: Item[] } }
  }
  const last = (events: readonly Item[] | undefined, type: string) => events?.filter((event) => event.type === type).at(-1)

  // No test files yet, so `bun test` exits 1.
  const failing = await rpc("turn.enqueue", { message: "run the tests" })
  expect(last(failing.result.events, "tool.started")).toMatchObject({ name: "run_command", presentation: { kind: "shell", command: "bun test", intent: "test" } })
  expect(last(failing.result.events, "tool.completed")).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED", message: "command exited with status 1" } })

  await writeFile(join(cwd, "sum.test.ts"), 'import { expect, test } from "bun:test"\ntest("adds", () => expect(1 + 1).toBe(2))\n', "utf8")
  const passing = await rpc("turn.enqueue", { message: "run them again" })
  expect(last(passing.result.events, "tool.completed")).toMatchObject({ ok: true })

  const read = await rpc("session.conversation.read")
  expect(read.result.items?.filter((item) => item.kind === "tool")).toMatchObject([
    { status: "failed", errorCode: "COMMAND_FAILED", presentation: { intent: "test" } },
    { status: "ok", presentation: { intent: "test" } },
  ])
})
