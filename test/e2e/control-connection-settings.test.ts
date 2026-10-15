import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

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

async function rpc(running: Running, method: string, params: Record<string, unknown> = {}, token: string | null = running.handle.token): Promise<Reply> {
  const response = await fetch(`${running.handle.url}/rpc`, {
    method: "POST",
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  })
  const body = await response.json() as { result?: Record<string, unknown>; error?: { code: string } | string }
  return { status: response.status, code: response.headers.get("x-runrail-error-code") ?? (typeof body.error === "string" ? body.error : body.error?.code ?? null), result: body.result ?? {} }
}

async function start(): Promise<{ running: Running; accountsDir: string }> {
  const cwd = await mkdtemp(join("/tmp", "runrail-settings-cwd-"))
  const sessionDir = await mkdtemp(join("/tmp", "runrail-settings-state-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-settings-accounts-"))
  for (const dir of [cwd, sessionDir, accountsDir]) cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "settings-session",
    loadExtensions: false,
    model: { complete: () => ({ type: "text" as const, text: "from the fixture model" }) },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: new MemoryCredentialVault(),
    connectionEnvironment: { OPENROUTER_API_KEY: "sk-not-sent" },
  })
  cleanup.push(() => running.handle.stop())
  return { running, accountsDir }
}

const shellAccount = { accountId: "conn-router", provider: "openrouter", label: "OpenRouter", authMode: "environment", environmentName: "OPENROUTER_API_KEY" }

describe("connection settings over control", () => {
  test("advertises the capabilities; nothing is connected until someone adds it", async () => {
    const { running } = await start()
    const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[] }
    expect(health.capabilities).toEqual(expect.arrayContaining(["connection.settings", "connection.tools"]))
    expect(await rpc(running, "connection.list")).toMatchObject({ status: 200, result: { connections: [] } })
    for (const method of ["connection.list", "connection.update", "connection.setDefault", "connection.addTool", "connection.removeTool"]) {
      expect([method, (await rpc(running, method, {}, null)).status]).toEqual([method, 401])
    }
  })

  test("a provider is switched off, given models, and refused while off", async () => {
    const { running } = await start()
    expect((await rpc(running, "account.create", shellAccount)).status).toBe(200)
    expect((await rpc(running, "connection.list")).result).toEqual({ connections: [{ kind: "provider", connectionId: "conn-router", provider: "openrouter", label: "OpenRouter", authMode: "environment", status: "unconfigured", enabled: true }] })

    const updated = await rpc(running, "connection.update", { connectionId: "conn-router", enabled: false, models: ["router/large", "router/small"], label: "Work router" })
    expect(updated).toMatchObject({ status: 200, result: { enabled: false, models: ["router/large", "router/small"], label: "Work router" } })
    expect((await rpc(running, "connection.list", { enabledOnly: true })).result).toEqual({ connections: [] })
    expect(await rpc(running, "provider.select", { connectionId: "conn-router", model: "router/large" })).toMatchObject({ status: 409, code: "CONNECTION_DISABLED" })
    await rpc(running, "connection.update", { connectionId: "conn-router", enabled: true })
    expect(await rpc(running, "provider.select", { connectionId: "conn-router", model: "router/other" })).toMatchObject({ status: 400, code: "CONNECTION_MODEL_NOT_CHOSEN" })
    await rpc(running, "connection.update", { connectionId: "conn-router", enabled: false })

    expect(await rpc(running, "connection.update", { connectionId: "conn-router", models: [] })).toMatchObject({ status: 400, code: "CONNECTION_MODELS_EMPTY" })
    expect(await rpc(running, "connection.update", { connectionId: "conn-router", enabled: "yes" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "connection.update", { connectionId: "conn-missing", enabled: true })).toMatchObject({ status: 404, code: "CONNECTION_NOT_FOUND" })
    expect(await rpc(running, "connection.list", { enabledOnly: "yes" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
  })

  test("tools are added and removed; the default is set, refused when not chosen, and cleared with its connection", async () => {
    const { running, accountsDir } = await start()
    const added = await rpc(running, "connection.addTool", { tool: "claude-code", models: ["sonnet", "haiku"] })
    expect(added).toMatchObject({ status: 200, result: { kind: "tool", connectionId: "claude-code-1", tool: "claude-code", label: "Claude Code", authMode: "subscription", separateAccount: false, enabled: true, models: ["sonnet", "haiku"] } })
    expect(await rpc(running, "connection.addTool", { tool: "copilot", authMode: "api-key" })).toMatchObject({ status: 400, code: "CONNECTION_AUTH_UNSUPPORTED" })
    expect(await rpc(running, "connection.addTool", { tool: "claude-code", apiKey: "sk-never" })).toMatchObject({ status: 400 })
    // A tool connection's id cannot be reused by an account.
    expect(await rpc(running, "account.create", { ...shellAccount, accountId: "claude-code-1" })).toMatchObject({ status: 409, code: "CONNECTION_EXISTS" })

    expect(await rpc(running, "connection.setDefault", { connectionId: "claude-code-1", model: "opus" })).toMatchObject({ status: 400, code: "CONNECTION_MODEL_NOT_CHOSEN" })
    expect(await rpc(running, "connection.setDefault", { connectionId: "claude-code-1", model: "haiku" })).toMatchObject({ status: 200, result: { default: { connectionId: "claude-code-1", model: "haiku" } } })
    await rpc(running, "account.create", shellAccount)
    // Adding a provider leaves the default where it is.
    expect((await rpc(running, "connection.list")).result.default).toEqual({ connectionId: "claude-code-1", model: "haiku", usable: true })

    expect(await rpc(running, "connection.removeTool", { connectionId: "claude-code-1" })).toMatchObject({ status: 200, result: { removed: true, connectionId: "claude-code-1" } })
    expect(await rpc(running, "connection.removeTool", { connectionId: "claude-code-1" })).toMatchObject({ status: 404, code: "CONNECTION_NOT_FOUND" })
    expect((await rpc(running, "connection.list")).result).not.toHaveProperty("default")

    await rpc(running, "connection.setDefault", { connectionId: "conn-router", model: "router/any" })
    expect((await rpc(running, "account.remove", { accountId: "conn-router" })).status).toBe(200)
    expect((await rpc(running, "connection.list")).result).toEqual({ connections: [] })
    expect(await rpc(running, "connection.setDefault", { connectionId: null })).toMatchObject({ status: 200, result: { default: null } })
    expect(await rpc(running, "connection.setDefault", { connectionId: "conn-router" })).toMatchObject({ status: 400 })

    // Nothing secret reaches the settings file.
    expect(await readFile(join(accountsDir, "connections.json"), "utf8")).not.toContain("sk-")
  })
})
