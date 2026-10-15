import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createVendorShims } from "../fixtures/vendor-shim.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>
interface Reply {
  readonly status: number
  readonly code: string | null
  readonly result: Record<string, unknown>
}

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function call(running: Running, path: string, body: Record<string, unknown>): Promise<Reply> {
  const response = await fetch(`${running.handle.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  const parsed = await response.json() as { result?: Record<string, unknown>; error?: { code: string } | string }
  return { status: response.status, code: response.headers.get("x-runrail-error-code") ?? (typeof parsed.error === "string" ? parsed.error : parsed.error?.code ?? null), result: parsed.result ?? {} }
}

const rpc = (running: Running, method: string, params: Record<string, unknown> = {}) => call(running, "/rpc", { method, params })

async function start(): Promise<{ running: Running; accountsDir: string; vault: MemoryCredentialVault }> {
  const cwd = await mkdtemp(join("/tmp", "runrail-signin-cwd-"))
  const sessionDir = await mkdtemp(join("/tmp", "runrail-signin-state-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-signin-accounts-"))
  const shims = await createVendorShims()
  for (const dir of [cwd, sessionDir, accountsDir]) cleanup.push(() => rm(dir, { recursive: true, force: true }))
  cleanup.push(() => shims.remove())
  const claude = await shims.add("claude-account", ["claude", "account"])
  const vault = new MemoryCredentialVault()
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "signin-session",
    loadExtensions: false,
    model: { complete: () => ({ type: "text" as const, text: "from the fixture model" }) },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: vault,
    harnessProbe: { commands: { "claude-code": { command: claude } } },
  })
  cleanup.push(() => running.handle.stop())
  return { running, accountsDir, vault }
}

describe("coding-tool sign-in over control", () => {
  test("a separate Claude Code account: its own folder, the tool's own login and status, and a confirmed sign-out", async () => {
    const { running, accountsDir } = await start()
    const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[] }
    expect(health.capabilities).toContain("connection.signin")

    const added = await rpc(running, "connection.addTool", { tool: "claude-code", separateAccount: true })
    expect(added).toMatchObject({ status: 200, result: { connectionId: "claude-code-1", authMode: "subscription", separateAccount: true } })
    expect(await rpc(running, "connection.addTool", { tool: "copilot", separateAccount: true })).toMatchObject({ status: 400, code: "CONNECTION_AUTH_UNSUPPORTED" })
    expect(await rpc(running, "connection.addTool", { tool: "codex", separateAccount: "yes" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })

    const login = await rpc(running, "connection.loginCommand", { connectionId: "claude-code-1" })
    const folder = (login.result.env as Record<string, string>).CLAUDE_CONFIG_DIR!
    expect(login).toMatchObject({ status: 200, result: { command: "claude", args: ["auth", "login", "--claudeai"] } })
    expect([folder.startsWith(join(accountsDir, "tool-homes")), ((await stat(folder)).mode & 0o777).toString(8)]).toEqual([true, "700"])

    expect(await rpc(running, "connection.status", { connectionId: "claude-code-1" })).toMatchObject({ status: 200, result: { tool: "claude-code", separateAccount: true, installed: true, signedIn: false } })
    // The person ran the login in a terminal; the tool now says this folder is signed in.
    await writeFile(join(folder, "fixture-signed-in"), "")
    const signedIn = await rpc(running, "connection.status", { connectionId: "claude-code-1" })
    expect([signedIn.result.signedIn, JSON.stringify(signedIn.result).includes("example.invalid")]).toEqual([true, false])

    expect(await rpc(running, "connection.vendorSignOut", { connectionId: "claude-code-1" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "connection.vendorSignOut", { connectionId: "claude-code-1", confirm: true })).toMatchObject({ status: 200, result: { signedOut: true } })
    expect((await rpc(running, "connection.status", { connectionId: "claude-code-1" })).result.signedIn).toBe(false)

    // Removing a connection signs nothing out and leaves its folder.
    expect((await rpc(running, "connection.removeTool", { connectionId: "claude-code-1" })).status).toBe(200)
    expect(await readdir(join(accountsDir, "tool-homes"))).toHaveLength(1)
    expect(await rpc(running, "connection.loginCommand", { connectionId: "claude-code-1" })).toMatchObject({ status: 404, code: "CONNECTION_NOT_FOUND" })
  })

  test("a sign-in terminal runs the tool's own login, takes what the person types, and ends", async () => {
    const { running } = await start()
    const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[] }
    expect(health.capabilities).toContain("connection.login")
    await rpc(running, "connection.addTool", { tool: "claude-code", separateAccount: true })

    // A command named by the caller is ignored: Runrail picks the tool's login.
    const started = await rpc(running, "connection.loginStart", { connectionId: "claude-code-1", cols: 80, rows: 16, command: "/bin/sh" })
    expect(started).toMatchObject({ status: 200, result: { connectionId: "claude-code-1" } })
    const loginId = started.result.loginId as string
    let seq = 0
    let text = ""
    const until = async (done: () => boolean): Promise<Reply> => {
      const deadline = Date.now() + 15_000
      for (;;) {
        const read = await rpc(running, "connection.loginRead", { loginId, afterSeq: seq })
        expect(read.status).toBe(200)
        for (const chunk of read.result.chunks as { seq: number; data: string }[]) text += chunk.data
        seq = read.result.nextSeq as number
        if (done() || read.result.closed === true || Date.now() > deadline) return read
        await Bun.sleep(50)
      }
    }
    await until(() => text.includes("Paste code here"))
    expect(text).toContain("argv auth login --claudeai")
    expect(text).toContain("https://claude.example.invalid/oauth/authorize")

    expect(await rpc(running, "connection.loginWrite", { loginId, data: "fixture-code\r" })).toMatchObject({ status: 200, result: { acceptedBytes: 13 } })
    const last = await until(() => false)
    expect([last.result.closed, text.includes("Login successful.")]).toEqual([true, true])
    expect((await rpc(running, "connection.status", { connectionId: "claude-code-1" })).result.signedIn).toBe(true)

    expect(await rpc(running, "connection.loginClose", { loginId })).toMatchObject({ status: 200, result: { loginId, closed: true } })
    expect(await rpc(running, "connection.loginRead", { loginId })).toMatchObject({ status: 404, code: "TOOL_LOGIN_NOT_FOUND" })
  })

  test("a sign-in terminal is refused for a key, a tool without one, and bad input", async () => {
    const { running } = await start()
    await rpc(running, "connection.addTool", { tool: "claude-code", authMode: "api-key" })
    await rpc(running, "connection.addTool", { tool: "copilot" })
    await rpc(running, "connection.addTool", { tool: "claude-code", separateAccount: true })
    expect(await rpc(running, "connection.loginStart", { connectionId: "claude-code-1" })).toMatchObject({ status: 400, code: "CONNECTION_AUTH_UNSUPPORTED" })
    expect(await rpc(running, "connection.loginStart", { connectionId: "copilot-1" })).toMatchObject({ status: 400, code: "CONNECTION_AUTH_UNSUPPORTED" })
    expect(await rpc(running, "connection.loginStart", { connectionId: "codex-9" })).toMatchObject({ status: 404, code: "CONNECTION_NOT_FOUND" })
    expect(await rpc(running, "connection.loginStart", { connectionId: "claude-code-2", cols: 5000 })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "connection.loginStart", { connectionId: "claude-code-1", rows: 1 })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "connection.loginRead", { loginId: "../x" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "connection.loginWrite", { loginId: "login-gone", data: "x" })).toMatchObject({ status: 404, code: "TOOL_LOGIN_NOT_FOUND" })
    expect(await rpc(running, "connection.loginClose", { loginId: "login-gone" })).toMatchObject({ status: 404, code: "TOOL_LOGIN_NOT_FOUND" })

    const { result } = await rpc(running, "connection.loginStart", { connectionId: "claude-code-2" })
    expect(await rpc(running, "connection.loginWrite", { loginId: result.loginId, data: "x".repeat(8 * 1024 + 1) })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    // Starting again replaces the sign-in left open.
    const again = await rpc(running, "connection.loginStart", { connectionId: "claude-code-2" })
    expect(again.status).toBe(200)
    expect(await rpc(running, "connection.loginRead", { loginId: result.loginId })).toMatchObject({ status: 404, code: "TOOL_LOGIN_NOT_FOUND" })
    expect((await rpc(running, "connection.loginClose", { loginId: again.result.loginId })).status).toBe(200)
  })

  test("a key connection: the key goes to /secret, a route needs it, and removing the connection deletes it", async () => {
    const { running, vault } = await start()
    expect(await rpc(running, "connection.addTool", { tool: "claude-code", authMode: "api-key", models: ["sonnet", "haiku"] })).toMatchObject({ status: 200, result: { separateAccount: true } })
    expect(await rpc(running, "connection.status", { connectionId: "claude-code-1" })).toMatchObject({ status: 200, result: { authMode: "api-key", keyStored: false } })
    expect(await rpc(running, "backend.switch", { backend: "claude-code", connectionId: "claude-code-1" })).toMatchObject({ status: 409, code: "CONNECTION_KEY_MISSING" })
    expect(await rpc(running, "connection.loginCommand", { connectionId: "claude-code-1" })).toMatchObject({ status: 400, code: "CONNECTION_AUTH_UNSUPPORTED" })
    expect(await rpc(running, "connection.vendorSignOut", { connectionId: "claude-code-1", confirm: true })).toMatchObject({ status: 400, code: "CONNECTION_AUTH_UNSUPPORTED" })

    expect(await call(running, "/secret", { connectionId: "claude-code-1", accountId: "claude-code-1", secret: "sk-ant-fixture" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    const stored = await call(running, "/secret", { connectionId: "claude-code-1", secret: " sk-ant-fixture\n" })
    expect([stored.status, stored.result.connectionId, JSON.stringify(stored.result).includes("sk-ant")]).toEqual([200, "claude-code-1", false])
    expect(await vault.get("claude-code-1")).toEqual({ kind: "api-key", secret: "sk-ant-fixture" })
    expect((await rpc(running, "connection.status", { connectionId: "claude-code-1" })).result.keyStored).toBe(true)

    await rpc(running, "connection.addTool", { tool: "claude-code" })
    expect(await call(running, "/secret", { connectionId: "claude-code-2", secret: "sk-ant-fixture" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "backend.switch", { backend: "codex", connectionId: "claude-code-1" })).toMatchObject({ status: 400, code: "CONNECTION_INVALID" })

    // The route is built without starting the tool; the session then runs as the connection.
    expect((await rpc(running, "backend.switch", { backend: "claude-code", connectionId: "claude-code-1" })).status).toBe(200)
    expect((await rpc(running, "session.snapshot")).result).toMatchObject({ backend: "claude-code", connectionId: "claude-code-1" })
    expect(await rpc(running, "model.switch", { id: "opus" })).toMatchObject({ status: 400, code: "CONNECTION_MODEL_NOT_CHOSEN" })
    expect((await rpc(running, "backend.switch", { backend: "claude-code" })).status).toBe(200)
    expect((await rpc(running, "session.snapshot")).result).not.toHaveProperty("connectionId")

    expect((await rpc(running, "connection.removeTool", { connectionId: "claude-code-1" })).status).toBe(200)
    expect(await vault.get("claude-code-1")).toBeUndefined()
  })
})
