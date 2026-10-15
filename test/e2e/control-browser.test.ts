import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import type { NativeModelRequest, NativeModelResponse } from "@nifrajs/coding-agent"
import { BrowserBridge } from "../../src/browser/bridge.ts"
import { startRunrailControlRpcServer, type RunrailControlRpcServerOptions } from "../../src/control-server.ts"
import type { RunrailLiveFrameInput } from "../../src/live/types.ts"

const token = "control-browser-token-1234567890abcd"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<{ status: number; body: { ok: boolean; result?: any; error?: { code: string; message: string } } }>

/** The agent makes one browser call, then reports the tool's answer as its reply. */
async function start(call: { name: string; input: unknown } | undefined, desktop: ((frame: { requestId: string; action: string }, rpc: Rpc) => Promise<void>) | undefined, extra: Partial<RunrailControlRpcServerOptions> = { browserTools: { anySite: false } }) {
  const cwd = await mkdtemp("/tmp/runrail-control-browser-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const requests: NativeModelRequest[] = []
  const frames: RunrailLiveFrameInput[] = []
  const handled: Promise<void>[] = []
  let rpc: Rpc = async () => { throw new Error("not started") }
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    approval: { request: () => true },
    ...extra,
    onLive: (frame) => {
      frames.push(frame)
      if (frame.type === "browser.request" && desktop !== undefined) handled.push(desktop(frame, rpc))
    },
    model: {
      complete: (request): NativeModelResponse => {
        requests.push(request)
        const answer = [...request.messages].reverse().find((message) => message.role === "tool")
        if (answer !== undefined || call === undefined) return { type: "text", text: answer?.text ?? "nothing to do" }
        return { type: "tool", name: call.name, input: call.input }
      },
    },
  })
  cleanup.push(() => running.handle.stop())
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  rpc = async (method, params = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() as never }
  }
  const toolText = () => requests.flatMap((request) => request.messages).reverse().find((message) => message.role === "tool")?.text ?? ""
  return { running, rpc, requests, frames, handled, toolText }
}

test("the agent opens a local page through the desktop, which claims the request once", async () => {
  const taken: unknown[] = []
  const { running, rpc, requests, frames, handled, toolText } = await start({ name: "browser_open", input: { url: "http://localhost:5173/app" } }, async (frame, rpc) => {
    const claim = await rpc("browser.take", { requestId: frame.requestId })
    taken.push(claim.body.result)
    // A replayed announcement finds nothing to claim.
    expect(await rpc("browser.take", { requestId: frame.requestId })).toMatchObject({ status: 404, body: { ok: false, error: { code: "BROWSER_REQUEST_NOT_FOUND" } } })
    expect((await rpc("browser.respond", { requestId: frame.requestId, answer: { ok: true, result: { text: "Opened http://localhost:5173/app" } } })).body).toEqual({ ok: true, result: { ok: true } })
  })
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[]; capabilityStatus: Record<string, string> }
  expect(health.capabilities).toContain("browser")
  expect(health.capabilityStatus.browser).toBe("available")

  expect((await rpc("turn.enqueue", { message: "check the app" })).body.ok).toBe(true)
  await Promise.all(handled)
  expect(frames.filter((frame) => frame.type === "browser.request")).toHaveLength(1)
  expect(taken[0]).toMatchObject({ action: "open", params: { url: "http://localhost:5173/app" }, anySite: false })
  expect(toolText()).toContain("Opened http://localhost:5173/app")
  const offered = requests[0]?.tools.map((tool) => tool.name) ?? []
  expect(offered).toContain("browser_open")
  expect(offered).toContain("browser_eval")
  expect(offered).not.toContain("browser_screenshot")
  expect((await rpc("browser.respond", { requestId: "br-0123456789abcdef0123456789abcdef", answer: { ok: true } })).body).toMatchObject({ ok: false, error: { code: "BROWSER_REQUEST_NOT_FOUND" } })
})

test("a site the thread does not allow is refused before the desktop hears of it", async () => {
  const { rpc, frames, toolText } = await start({ name: "browser_open", input: { url: "https://example.com" } }, async () => { throw new Error("the desktop must not be asked") })
  expect((await rpc("turn.enqueue", { message: "open example" })).body.ok).toBe(true)
  expect(frames.some((frame) => frame.type === "browser.request")).toBe(false)
  expect(toolText()).toContain("this computer only")
})

test("an eval the person declines, and a malformed answer, reach the agent as failures", async () => {
  const declined = await start({ name: "browser_eval", input: { expression: "document.title" } }, async (frame, rpc) => {
    const claim = await rpc("browser.take", { requestId: frame.requestId })
    expect(claim.body.result).toMatchObject({ action: "eval", params: { expression: "document.title" } })
    await rpc("browser.respond", { requestId: frame.requestId, answer: { ok: false, code: "BROWSER_DENIED", message: "The person declined." } })
  })
  await declined.rpc("turn.enqueue", { message: "read the title" })
  await Promise.all(declined.handled)
  expect(declined.toolText()).toContain("The person declined.")

  const malformed = await start({ name: "browser_snapshot", input: {} }, async (frame, rpc) => {
    await rpc("browser.take", { requestId: frame.requestId })
    expect(await rpc("browser.respond", { requestId: frame.requestId, answer: { ok: true, result: { text: 42 } } })).toMatchObject({ status: 400, body: { ok: false, error: { code: "BROWSER_RESULT_INVALID" } } })
  })
  await malformed.rpc("turn.enqueue", { message: "read the page" })
  await Promise.all(malformed.handled)
  expect(malformed.toolText()).not.toContain("42")
})

test("without the switch there are no browser tools, methods, or route", async () => {
  const { running, rpc, requests } = await start(undefined, undefined, {})
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus.browser).toBe("configurable")
  expect(await rpc("browser.take", { requestId: "br-0123456789abcdef0123456789abcdef" })).toMatchObject({ status: 501, body: { ok: false, error: { code: "CONTROL_CAPABILITY_UNAVAILABLE" } } })
  expect(await rpc("browser.respond", { requestId: "br-0123456789abcdef0123456789abcdef", answer: {} })).toMatchObject({ status: 501 })
  expect((await fetch(`${running.handle.url}/browser`, { method: "POST", body: "{}" })).status).toBe(404)
  await rpc("turn.enqueue", { message: "hello" })
  expect(requests[0]?.tools.some((tool) => tool.name.startsWith("browser_"))).toBe(false)
})

test("the browser route takes only its own token and a known action", async () => {
  const bridge = new BrowserBridge({ anySite: false })
  const { running } = await start(undefined, async (frame, rpc) => {
    await rpc("browser.take", { requestId: frame.requestId })
    await rpc("browser.respond", { requestId: frame.requestId, answer: { ok: true, result: { text: "Page text" } } })
  }, { browser: { bridge } })
  const call = (authorization: string, body: unknown, method = "POST") => fetch(`${running.handle.url}/browser`, { method, headers: { authorization, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) })
  expect((await call(`Bearer ${token}`, { action: "snapshot" })).status).toBe(401)
  expect((await call(`Bearer ${bridge.endpointToken}`, {}, "GET")).status).toBe(405)
  const unknown = await call(`Bearer ${bridge.endpointToken}`, { action: "download" })
  expect(unknown.status).toBe(400)
  expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "BROWSER_INVALID_INPUT" } })
  const refused = await call(`Bearer ${bridge.endpointToken}`, { action: "open", input: { url: "https://example.com" } })
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({ ok: false, error: { code: "BROWSER_SITE_REFUSED" } })
  const read = await call(`Bearer ${bridge.endpointToken}`, { action: "snapshot" })
  expect(await read.json()).toEqual({ ok: true, result: { text: "Page text" } })
  // The endpoint token opens nothing else.
  expect((await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${bridge.endpointToken}` }, body: JSON.stringify({ method: "background.list" }) })).status).toBe(401)
})

test("stopping the engine ends a call the desktop never answered", async () => {
  let announced: () => void = () => {}
  const seen = new Promise<void>((resolve) => { announced = resolve })
  const bridge = new BrowserBridge({ anySite: false })
  const { running } = await start(undefined, async () => announced(), { browser: { bridge } })
  const pending = fetch(`${running.handle.url}/browser`, { method: "POST", headers: { authorization: `Bearer ${bridge.endpointToken}` }, body: JSON.stringify({ action: "snapshot" }) })
  await seen
  await running.handle.stop()
  const response = await pending
  expect(await response.json()).toMatchObject({ ok: false, error: { code: "BROWSER_CLOSED" } })
})
