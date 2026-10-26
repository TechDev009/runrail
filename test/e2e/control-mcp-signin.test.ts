import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FileCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { MCP_CANARY, PRESET_APP, startMockMcpOAuth } from "../fixtures/mock-mcp-oauth.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>
interface Reply {
  readonly status: number
  readonly body: { readonly ok: boolean; readonly result?: Record<string, unknown>; readonly error?: { readonly code: string } }
}

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function rpc(running: Running, method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
  return { status: response.status, body: (await response.json()) as Reply["body"] }
}

async function secret(running: Running, body: Record<string, unknown>): Promise<Reply> {
  const response = await fetch(`${running.handle.url}/secret`, { method: "POST", headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  return { status: response.status, body: (await response.json()) as Reply["body"] }
}

async function finish(running: Running, mock: ReturnType<typeof startMockMcpOAuth>, started: Reply): Promise<string> {
  const snapshot = started.body.result as { loginId: string; events: { type: string; url?: string }[] }
  await (await mock.visit(snapshot.events.find((event) => event.type === "open-url")!.url!)).text()
  let state = ""
  for (let tries = 0; tries < 50 && !["done", "failed"].includes(state); tries += 1) state = ((await rpc(running, "auth.login.status", { loginId: snapshot.loginId, waitMs: 200 })).body.result as { state: string }).state
  return state
}

async function start(mcpUrl: string): Promise<{ readonly running: Running; readonly dirs: readonly string[] }> {
  const dirs = await Promise.all(["cwd", "state", "accounts"].map((name) => mkdtemp(join("/tmp", `runrail-mcp-signin-${name}-`))))
  for (const dir of dirs) cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const [cwd, sessionDir, accountsDir] = dirs as [string, string, string]
  const behaviorConfigPath = join(cwd, "behavior.json")
  await writeFile(behaviorConfigPath, JSON.stringify({ version: 1, mode: "ask", mcp: { servers: [{ name: "docs", url: mcpUrl }] } }))
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "mcp-signin-session",
    loadExtensions: false,
    model: { complete: () => ({ type: "text" as const, text: "ok" }) },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: new FileCredentialVault({ root: join(accountsDir, "vault") }),
    nativeSignInFlows: [],
    behaviorConfigPath,
  })
  cleanup.push(() => running.handle.stop())
  return { running, dirs }
}

test("an MCP server that wants a sign-in: refused until signed in through the control server, then ready", async () => {
  const mock = startMockMcpOAuth()
  cleanup.push(() => mock.stop())
  const { running, dirs } = await start(mock.mcpUrl)

  expect((await rpc(running, "mcp.status")).body.result?.servers).toEqual([{ name: "docs", state: "failed", tools: 0, code: "MCP_SIGN_IN_REQUIRED" }])
  expect((await rpc(running, "auth.mcp.list")).body.result).toEqual({ servers: [] })
  expect((await rpc(running, "auth.mcp.start", { url: "http://mcp.example.com/mcp" })).body.error?.code).toBe("CONTROL_INVALID_INPUT")

  const started = await rpc(running, "auth.mcp.start", { url: mock.mcpUrl, name: "docs" })
  expect(started.status).toBe(200)
  const snapshot = started.body.result as { loginId: string; flow: string; accountId: string; events: { type: string; url?: string }[] }
  // The host opens only a page on a host the running sign-in names.
  const flows = (await rpc(running, "auth.flows")).body.result as unknown as { id: string; browserHosts: string[] }[]
  expect(flows.find((flow) => flow.id === snapshot.flow)?.browserHosts).toEqual(["127.0.0.1"])
  const page = snapshot.events.find((event) => event.type === "open-url")?.url
  expect(page?.startsWith(`${mock.authOrigin}/authorize?`)).toBe(true)
  await (await mock.visit(page!)).text()

  let state = ""
  for (let tries = 0; tries < 50 && state !== "done"; tries += 1) state = ((await rpc(running, "auth.login.status", { loginId: snapshot.loginId, waitMs: 200 })).body.result as { state: string }).state
  expect(state).toBe("done")
  expect((await rpc(running, "auth.mcp.list")).body.result).toEqual({ servers: [{ url: mock.mcpUrl, signedIn: true, updatedAt: expect.any(Number) }] })
  expect((await rpc(running, "mcp.check", { name: "docs" })).body.result).toEqual({ name: "docs", state: "ready", tools: 1 })
  expect((await rpc(running, "account.list")).body.result).not.toContainEqual(expect.objectContaining({ accountId: snapshot.accountId }))

  // Tokens live in the vault's files only.
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.parentPath.includes(join(dirs[2]!, "vault"))) continue
      expect((await readFile(join(entry.parentPath, entry.name))).includes(MCP_CANARY)).toBe(false)
    }
  }

  expect((await rpc(running, "auth.mcp.signout", { url: mock.mcpUrl })).body.result).toEqual({ url: mock.mcpUrl, removed: true })
  expect((await rpc(running, "mcp.check", { name: "docs" })).body.result).toEqual({ name: "docs", state: "failed", tools: 0, code: "MCP_SIGN_IN_REQUIRED" })
})

test("a server whose authorization server registers no apps signs in with the person's own app; its secret goes through /secret only", async () => {
  const mock = startMockMcpOAuth()
  cleanup.push(() => mock.stop())
  mock.plan.serverMetadata = "no-registration"
  const { running } = await start(mock.mcpUrl)

  expect((await rpc(running, "auth.mcp.start", { url: mock.mcpUrl })).body.error?.code).toBe("AUTH_CLIENT_REQUIRED")
  expect((await rpc(running, "auth.mcp.client.set", { url: mock.mcpUrl, clientId: PRESET_APP.id, clientSecret: PRESET_APP.secret })).body.error?.code).toBe("CONTROL_INVALID_INPUT")
  const named = await rpc(running, "auth.mcp.client.set", { url: mock.mcpUrl, clientId: PRESET_APP.id })
  expect(named.body.result).toEqual({ id: expect.stringMatching(/^mcp-oauth:[0-9a-f]{32}$/), url: mock.mcpUrl, client: { id: PRESET_APP.id, secret: false } })
  expect((await secret(running, { mcpClientId: "mcp-oauth:nothex", secret: "x" })).status).toBe(400)
  const kept = await secret(running, { mcpClientId: named.body.result?.id, secret: PRESET_APP.secret })
  expect(kept.body.result).toEqual({ url: mock.mcpUrl, client: { id: PRESET_APP.id, secret: true } })
  expect(JSON.stringify(kept.body)).not.toContain(MCP_CANARY)

  expect(await finish(running, mock, await rpc(running, "auth.mcp.start", { url: mock.mcpUrl, name: "docs" }))).toBe("done")
  expect(mock.seen.token.at(-1)).toMatchObject({ client_id: PRESET_APP.id, client_secret: PRESET_APP.secret })
  expect((await rpc(running, "mcp.check", { name: "docs" })).body.result).toEqual({ name: "docs", state: "ready", tools: 1 })
  expect((await rpc(running, "auth.mcp.client.clear", { url: mock.mcpUrl })).body.result).toEqual({ url: mock.mcpUrl, removed: true })
  expect((await rpc(running, "auth.mcp.list")).body.result).toEqual({ servers: [{ url: mock.mcpUrl, signedIn: true, updatedAt: expect.any(Number) }] })
})
