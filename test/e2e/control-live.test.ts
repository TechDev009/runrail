import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-live-token-1234567890abcdef"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function readUntil(response: Response, done: (text: string) => boolean, abort: AbortController): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("event stream has no body")
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 5_000
  while (!done(text) && Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  abort.abort()
  return text
}

function liveFrames(text: string): { id: string; data: Record<string, unknown> }[] {
  return text.split("\n\n").filter((frame) => frame.startsWith("event: runrail.live")).map((frame) => {
    const lines = frame.split("\n")
    return { id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? "", data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}") as Record<string, unknown> }
  })
}

test("live frames flow over turn results, the live RPC, and the event stream", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-live-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const callerFrames: unknown[] = []
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    onLive: (frame) => {
      callerFrames.push(frame)
      throw new Error("caller sink failure is isolated")
    },
    model: {
      complete: (request) => request.messages.some((message) => message.role === "tool")
        ? { type: "text", text: "planned" }
        : { type: "tool", name: "update_plan", input: { explanation: "two steps", plan: [{ step: "inspect", status: "completed" }, { step: "edit", status: "in_progress" }] } },
    },
  })
  cleanup.push(() => running.handle.stop())
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  const rpc = (method: string, params: Record<string, unknown> = {}) => fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })

  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[]; capabilityStatus: Record<string, string> }
  expect(health.capabilities).toContain("live.frames")
  expect(health.capabilityStatus["live.frames"]).toBe("available")

  const turn = await rpc("turn.enqueue", { message: "plan the work" })
  expect(turn.status).toBe(200)
  const body = await turn.json() as { result: { live: { type: string; liveSeq: number; steps?: unknown; sessionId: string }[] } }
  const plan = body.result.live.find((frame) => frame.type === "plan.updated")
  expect(plan).toMatchObject({ version: 1, callId: expect.any(String), explanation: "two steps", steps: [{ text: "inspect", status: "completed" }, { text: "edit", status: "in_progress" }] })
  expect(plan?.sessionId.length).toBeGreaterThan(0)

  const listed = await (await rpc("live.frames", { afterLiveSeq: 0, maxFrames: 10 })).json() as { result: { frames: { liveSeq: number }[]; lastLiveSeq: number } }
  expect(listed.result.frames.map((frame) => frame.liveSeq)).toContain(plan?.liveSeq ?? -1)
  expect(listed.result.lastLiveSeq).toBeGreaterThanOrEqual(plan?.liveSeq ?? 0)
  const empty = await (await rpc("live.frames", { afterLiveSeq: listed.result.lastLiveSeq })).json() as { result: { frames: unknown[] } }
  expect(empty.result.frames).toEqual([])

  const abort = new AbortController()
  const stream = await fetch(`${running.handle.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal })
  expect(stream.status).toBe(200)
  const text = await readUntil(stream, (value) => value.includes('"type":"plan.updated"'), abort)
  const frames = liveFrames(text)
  // Each model request also reports context usage, so the plan is not the first frame.
  expect(frames[0]?.data).toMatchObject({ type: "context.usage", estimated: expect.any(Boolean) })
  const streamedPlan = frames.find((frame) => frame.data.type === "plan.updated")
  expect(streamedPlan?.id).toBe(`live-${String(plan?.liveSeq)}`)

  const tailAbort = new AbortController()
  const tail = await fetch(`${running.handle.url}/events?afterSeq=-1&afterLiveSeq=${String(listed.result.lastLiveSeq)}`, { headers: { authorization: `Bearer ${token}` }, signal: tailAbort.signal })
  const tailText = await readUntil(tail, (value) => value.includes('"type":"session.completed"'), tailAbort)
  expect(liveFrames(tailText)).toEqual([])
  // Plan frames derive from tool events inside the hub; the caller sink sees only frames the
  // session produces (here, context usage), and its throw does not stop them.
  expect(callerFrames.length).toBeGreaterThan(0)
  expect(callerFrames.every((frame) => (frame as { type?: unknown }).type === "context.usage")).toBe(true)
})

test("live frame requests reject malformed cursors and bounds", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-live-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", authToken: token, loadExtensions: false, model: { complete: () => ({ type: "text", text: "ok" }) } })
  cleanup.push(() => running.handle.stop())
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  const rpc = (params: Record<string, unknown>) => fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "live.frames", params }) })
  for (const params of [{ afterLiveSeq: -1 }, { afterLiveSeq: "1" }, { maxFrames: 0 }, { maxFrames: 5_000 }]) {
    const response = await rpc(params)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "CONTROL_INVALID_INPUT" } })
  }
  const badQuery = await fetch(`${running.handle.url}/events?afterLiveSeq=abc`, { headers: { authorization: `Bearer ${token}` } })
  expect(badQuery.status).toBe(400)
  const unauthorized = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "live.frames", params: {} }) })
  expect(unauthorized.status).toBe(401)
})
