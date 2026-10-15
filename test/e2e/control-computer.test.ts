import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { ComputerBridge } from "../../src/computer/bridge.ts"
import type { RunrailLiveFrameInput } from "../../src/live/types.ts"

/** Computer use through the control server. */

const token = "control-computer-token-1234567890abc"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function start(withTools: boolean) {
  const cwd = await mkdtemp("/tmp/runrail-control-computer-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const frames: RunrailLiveFrameInput[] = []
  const bridge = new ComputerBridge()
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    ...(withTools ? { computer: { bridge } } : {}),
    onLive: (frame) => frames.push(frame),
    model: { complete: () => ({ type: "text", text: "ok" }) },
  })
  cleanup.push(() => running.handle.stop())
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: (await response.json()) as { ok: boolean; result?: any; error?: { code: string; message: string } } }
  }
  const capability = async () => ((await (await fetch(`${running.handle.url}/health`)).json()) as { capabilityStatus: Record<string, string> }).capabilityStatus["computer.tools"]
  return { running, rpc, frames, bridge, capability }
}

test("a computer call is announced, claimed once by the desktop, and answered with its screenshot", async () => {
  const { rpc, frames, bridge, capability } = await start(true)
  expect(await capability()).toBe("available")
  const pending = bridge.request("screenshot", { app: "Safari" })
  const frame = frames.find((item) => item.type === "computer.request") as { requestId: string; action: string } | undefined
  expect(frame?.action).toBe("screenshot")
  const claim = await rpc("computer.take", { requestId: frame?.requestId })
  expect(claim.body.result).toMatchObject({ action: "screenshot", params: { app: "Safari" } })
  expect(await rpc("computer.take", { requestId: frame?.requestId })).toMatchObject({ status: 404, body: { error: { code: "COMPUTER_REQUEST_NOT_FOUND" } } })
  expect(await rpc("computer.respond", { requestId: frame?.requestId, answer: { ok: true, result: { text: "Safari, 1280 by 800", image: { mediaType: "image/jpeg", dataBase64: "/9j/" } } } })).toMatchObject({ status: 200 })
  expect(await pending).toEqual({ text: "Safari, 1280 by 800", image: { mediaType: "image/jpeg", dataBase64: "/9j/" } })
})

test("the endpoint Claude Code's tools call takes only its own token", async () => {
  const { running, frames, bridge, rpc } = await start(true)
  const post = (authorization: string, body: unknown) => fetch(`${running.handle.url}/computer`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) })
  expect((await post(`Bearer ${token}`, { action: "apps", input: {} })).status).toBe(401)
  expect((await post(`Bearer ${bridge.endpointToken}`, { action: "rm", input: {} })).status).toBe(400)
  const answered = post(`Bearer ${bridge.endpointToken}`, { action: "apps", input: {} })
  let frame: { requestId: string } | undefined
  for (let tries = 0; tries < 200 && frame === undefined; tries += 1) {
    frame = frames.find((item) => item.type === "computer.request") as { requestId: string } | undefined
    if (frame === undefined) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await rpc("computer.take", { requestId: frame?.requestId })
  await rpc("computer.respond", { requestId: frame?.requestId, answer: { ok: false, code: "COMPUTER_PERMISSION", message: "Runrail needs Screen Recording access." } })
  const response = await answered
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ ok: false, error: { code: "COMPUTER_PERMISSION", message: "Runrail needs Screen Recording access." } })
})

test("without the switch the capability is configurable and the methods refuse", async () => {
  const { running, rpc, capability } = await start(false)
  expect(await capability()).toBe("configurable")
  expect(await rpc("computer.take", { requestId: `cu-${"0".repeat(32)}` })).toMatchObject({ status: 501, body: { error: { code: "CONTROL_CAPABILITY_UNAVAILABLE" } } })
  expect((await fetch(`${running.handle.url}/computer`, { method: "POST", body: "{}" })).status).toBe(404)
})
