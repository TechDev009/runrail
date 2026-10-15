import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { NativeModelRequest, NativeModelResponse } from "@nifrajs/coding-agent"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer, type RunrailControlRpcServerOptions } from "../../src/control-server.ts"

/** Pictures from the image model the person picked from their own connections. */

const token = "control-images-token-1234567890abcdef"
// Distinct from every other string in the test so a leak is unambiguous.
const CANARY = "sk-image-canary-7d2c19e4b05a"
// A 2x3 PNG: signature, then the IHDR chunk that names its size.
const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000003080600000000000000", "hex")
const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body?: Record<string, unknown>
}

function provider() {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const url = new URL(incoming.url)
      const body = incoming.method === "POST" ? await incoming.json() as Record<string, unknown> : undefined
      seen.push({ method: incoming.method, path: url.pathname, authorization: incoming.headers.get("authorization"), ...(body === undefined ? {} : { body }) })
      if (incoming.method === "GET") return Response.json({ data: [{ id: "chat-model" }, { id: "gpt-image-1" }, { id: "text-embedding-3-small" }] })
      if (url.pathname === "/v1/images/generations") return Response.json({ created: 1, data: [{ b64_json: PNG.toString("base64") }] })
      return Response.json({ error: "not here" }, { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  return { seen, baseUrl: `http://127.0.0.1:${server.port}/v1` }
}

/** The agent calls the image tool once, then replies with what the tool said. */
async function start(call: Record<string, unknown> | undefined, extra: Partial<RunrailControlRpcServerOptions> = { imageTools: {} }) {
  const cwd = await mkdtemp("/tmp/runrail-control-images-")
  const accountsDir = await mkdtemp("/tmp/runrail-control-images-accounts-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(accountsDir, { recursive: true, force: true }))
  const requests: NativeModelRequest[] = []
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    approval: { request: () => true },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: new MemoryCredentialVault(),
    connectionEnvironment: {},
    ...extra,
    model: {
      complete: (request): NativeModelResponse => {
        requests.push(request)
        const answer = [...request.messages].reverse().find((message) => message.role === "tool")
        if (answer !== undefined || call === undefined) return { type: "text", text: answer?.text ?? "nothing to do" }
        return { type: "tool", name: "image_generate", input: call }
      },
    },
  })
  cleanup.push(() => running.handle.stop())
  const send = async (path: string, payload: unknown) => {
    const response = await fetch(`${running.handle.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) })
    const text = await response.text()
    return { status: response.status, text, body: JSON.parse(text) as { ok: boolean; result?: any; error?: { code: string; message: string } } }
  }
  const rpc = (method: string, params: Record<string, unknown> = {}) => send("/rpc", { method, params })
  const toolText = () => requests.flatMap((request) => request.messages).reverse().find((message) => message.role === "tool")?.text ?? ""
  return { running, cwd, accountsDir, rpc, send, requests, toolText }
}

async function connect(rpc: Awaited<ReturnType<typeof start>>["rpc"], send: Awaited<ReturnType<typeof start>>["send"], baseUrl: string) {
  expect((await rpc("account.create", { accountId: "conn-local", provider: "custom-openai-chat", label: "Local relay", authMode: "api-key", baseUrl })).status).toBe(200)
  expect((await send("/secret", { accountId: "conn-local", secret: CANARY })).status).toBe(200)
}

test("the connection's own list names its image models, and the person's pick is kept", async () => {
  const endpoint = provider()
  const { rpc, send, accountsDir } = await start(undefined)
  await connect(rpc, send, endpoint.baseUrl)
  const models = await rpc("connection.models", { connectionId: "conn-local" })
  expect(models.body.result).toMatchObject({ models: [{ id: "chat-model" }], images: [{ id: "gpt-image-1", route: "images" }] })
  // A chat model, or a model the list does not name, is not an image model.
  expect(await rpc("connection.setImageModel", { connectionId: "conn-local", model: "chat-model" })).toMatchObject({ status: 400, body: { error: { code: "CONNECTION_MODEL_NOT_CHOSEN" } } })
  const chosen = await rpc("connection.setImageModel", { connectionId: "conn-local", model: "gpt-image-1" })
  expect(chosen.body.result).toEqual({ image: { connectionId: "conn-local", model: "gpt-image-1", route: "images" } })
  expect((await rpc("connection.list")).body.result.image).toEqual({ connectionId: "conn-local", model: "gpt-image-1", route: "images", usable: true })
  // Turned off, it stays chosen but cannot be used; removed, it is gone.
  await rpc("connection.update", { connectionId: "conn-local", enabled: false })
  expect((await rpc("connection.list")).body.result.image).toMatchObject({ usable: false })
  expect(JSON.parse(await readFile(join(accountsDir, "connections.json"), "utf8")).image).toEqual({ connectionId: "conn-local", model: "gpt-image-1", route: "images" })
  expect((await rpc("connection.setImageModel", { connectionId: null })).body.result).toEqual({ image: null })
  expect((await rpc("connection.list")).body.result.image).toBeUndefined()
})

test("the agent's picture is made with the stored key and saved in the workspace", async () => {
  const endpoint = provider()
  const { running, rpc, send, cwd, requests, toolText } = await start({ prompt: "a lighthouse at dusk", path: "art/hero.png", shape: "landscape" })
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["image.tools"]).toBe("available")
  await connect(rpc, send, endpoint.baseUrl)
  await rpc("connection.setImageModel", { connectionId: "conn-local", model: "gpt-image-1" })
  endpoint.seen.length = 0
  expect((await rpc("turn.enqueue", { message: "make a hero picture" })).body.ok).toBe(true)
  expect(requests[0]?.tools.map((tool) => tool.name)).toContain("image_generate")
  expect(endpoint.seen).toEqual([{ method: "POST", path: "/v1/images/generations", authorization: `Bearer ${CANARY}`, body: { model: "gpt-image-1", prompt: "a lighthouse at dusk", n: 1, size: "1536x1024" } }])
  expect(toolText()).toContain("Saved a 2x3 PNG to art/hero.png, made by gpt-image-1 through Custom (OpenAI Chat).")
  expect(Buffer.from(await readFile(join(cwd, "art/hero.png")))).toEqual(PNG)
  expect(await readdir(join(cwd, "art"))).toEqual(["hero.png"])
  const conversation = await rpc("session.conversation.read")
  expect(conversation.text).not.toContain(CANARY)
})

test("with no image model chosen the agent hears where the person picks one, and nothing is sent", async () => {
  const endpoint = provider()
  const { rpc, send, cwd, toolText } = await start({ prompt: "a cat", path: "cat.png" })
  await connect(rpc, send, endpoint.baseUrl)
  endpoint.seen.length = 0
  expect((await rpc("turn.enqueue", { message: "draw a cat" })).body.ok).toBe(true)
  expect(toolText()).toContain("Settings > Connections > Image model")
  expect(endpoint.seen).toEqual([])
  expect(await readdir(cwd)).not.toContain("cat.png")
})

test("a picture is never saved outside the workspace", async () => {
  const endpoint = provider()
  const { rpc, send, toolText } = await start({ prompt: "a cat", path: "../outside.png" })
  await connect(rpc, send, endpoint.baseUrl)
  await rpc("connection.setImageModel", { connectionId: "conn-local", model: "gpt-image-1" })
  expect((await rpc("turn.enqueue", { message: "draw a cat" })).body.ok).toBe(true)
  expect(toolText()).toContain("only be saved inside the workspace")
})

test("without the switch the capability is configurable and the tool is not offered", async () => {
  const { running, rpc, requests } = await start({ prompt: "a cat", path: "cat.png" }, {})
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["image.tools"]).toBe("configurable")
  expect((await fetch(`${running.handle.url}/images`, { method: "POST", body: "{}" })).status).toBe(404)
  await rpc("turn.enqueue", { message: "hello" })
  expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("image_generate")
})
