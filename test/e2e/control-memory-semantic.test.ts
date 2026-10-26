import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>
interface Reply {
  readonly status: number
  readonly body: { readonly ok: boolean; readonly result?: Record<string, unknown>; readonly error?: { readonly code: string; readonly message?: string } }
}

const CANARY = "sk-canary-embeddings-5b7e2d91c4"
const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function send(running: Running, payload: unknown, path: "/rpc" | "/secret" = "/rpc"): Promise<Reply> {
  const response = await fetch(`${running.handle.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" }, body: JSON.stringify(payload) })
  return { status: response.status, body: (await response.json()) as Reply["body"] }
}
const rpc = (running: Running, method: string, params: Record<string, unknown> = {}): Promise<Reply> => send(running, { method, params })

// Two words that mean the same thing share an axis, so a paraphrase lands close to what it rephrases.
const AXES: readonly (readonly string[])[] = [["deploy", "deploys", "ship", "prod", "staging"], ["postgres", "migrations", "database"]]
function vectorFor(text: string): number[] {
  const vector = [0, 0, 0.1]
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const axis = AXES.findIndex((words) => words.includes(word))
    if (axis >= 0) vector[axis]! += 1
  }
  return vector
}

/** A loopback provider with one chat model and one embedding model. */
function provider() {
  const embedded: { readonly authorization: string | null; readonly input: readonly string[] }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const url = new URL(incoming.url)
      if (incoming.method === "GET") return Response.json({ data: [{ id: "chat-model" }, { id: "text-embedding-fixture" }] })
      const body = (await incoming.json()) as { model: string; input: string[] }
      if (url.pathname !== "/v1/embeddings" || body.model !== "text-embedding-fixture") return Response.json({ error: "not an embedding model" }, { status: 404 })
      embedded.push({ authorization: incoming.headers.get("authorization"), input: body.input })
      return Response.json({ data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })) })
    },
  })
  cleanup.push(() => server.stop(true))
  return { embedded, baseUrl: `http://127.0.0.1:${server.port}/v1` }
}

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(20)
  }
}

test("recall by meaning: picked from a connection's own list, embedded with its key, never stored with it", async () => {
  const dirs = await Promise.all(["cwd", "state", "accounts", "memory"].map((name) => mkdtemp(join("/tmp", `runrail-semantic-${name}-`))))
  for (const dir of dirs) cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const [cwd, sessionDir, accountsDir, memoryDir] = dirs as [string, string, string, string]
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "semantic-session",
    loadExtensions: false,
    model: { complete: () => ({ type: "text" as const, text: "from the fixture model" }) },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: new MemoryCredentialVault(),
    connectionEnvironment: {},
    memoryDir,
  })
  cleanup.push(() => running.handle.stop())
  const endpoint = provider()
  expect((await rpc(running, "account.create", { accountId: "conn-local", provider: "custom-openai-chat", label: "Local relay", authMode: "api-key", baseUrl: endpoint.baseUrl })).status).toBe(200)
  expect((await send(running, { accountId: "conn-local", secret: CANARY }, "/secret")).status).toBe(200)

  const listed = await rpc(running, "connection.models", { connectionId: "conn-local" })
  expect(listed.body.result?.embeddings).toEqual([{ id: "text-embedding-fixture" }])

  expect((await rpc(running, "memory.add", { scope: "project", text: "Deploys go to staging first." })).status).toBe(200)
  expect((await rpc(running, "memory.add", { scope: "project", text: "Migrations run against postgres." })).status).toBe(200)
  expect(endpoint.embedded).toEqual([])

  const refused = await rpc(running, "memory.settings.set", { embeddings: { connectionId: "conn-local", model: "chat-model" } })
  expect(refused.status).toBe(503)
  expect(refused.body.error?.message).toBe("This connection does not serve embeddings with this model.")

  const picked = await rpc(running, "memory.settings.set", { embeddings: { connectionId: "conn-local", model: "text-embedding-fixture" } })
  expect(picked.status).toBe(200)
  expect(picked.body.result).toEqual({ provider: "local", embeddings: { connectionId: "conn-local", model: "text-embedding-fixture", floor: expect.any(Number) } })
  await until(async () => ((await rpc(running, "memory.status")).body.result?.semantic as { pending?: number } | undefined)?.pending === 0)
  expect(endpoint.embedded.every((call) => call.authorization === `Bearer ${CANARY}`)).toBe(true)

  const recalled = await rpc(running, "memory.recall", { query: "how do we ship to prod?" })
  expect((recalled.body.result?.hits as { text: string; match: string }[]).map((hit) => [hit.text, hit.match])).toEqual([["Deploys go to staging first.", "meaning"]])

  for (const entry of await readdir(memoryDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) expect((await readFile(join(entry.parentPath, entry.name))).includes(CANARY)).toBe(false)
  }

  // A connection turned off sends nothing more; recall goes on by keyword.
  const calls = endpoint.embedded.length
  expect((await rpc(running, "connection.update", { connectionId: "conn-local", enabled: false })).status).toBe(200)
  const keywordOnly = await rpc(running, "memory.recall", { query: "how do we ship to prod?" })
  expect(keywordOnly.body.result?.hits).toEqual([])
  expect(endpoint.embedded.length).toBe(calls)
  expect((await rpc(running, "memory.status")).body.result?.semantic).toMatchObject({ problem: expect.stringContaining("connection is off") })
})
