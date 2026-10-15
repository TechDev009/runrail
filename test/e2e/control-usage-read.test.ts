import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { UsageReadError, type UsageAccount } from "../../src/harness/usage-read.ts"
import type { RunrailPlanLimitsFrame } from "../../src/live/types.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function rpc(running: Running, method: string, params: Record<string, unknown> = {}): Promise<{ readonly status: number; readonly code: string | null; readonly result: Record<string, unknown> }> {
  const response = await fetch(`${running.handle.url}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  })
  const body = await response.json() as { result?: Record<string, unknown>; error?: { code: string } }
  return { status: response.status, code: body.error?.code ?? null, result: body.result ?? {} }
}

const claudePlan: RunrailPlanLimitsFrame = { type: "plan.limits", source: "claude-code", plan: "max", windows: [{ id: "five-hour", usedPercent: 40 }, { id: "weekly-model", model: "Fable", usedPercent: 63 }] }
const codexPlan: RunrailPlanLimitsFrame = { type: "plan.limits", source: "codex", windows: [{ id: "weekly", usedPercent: 7 }] }

async function start(codex: (account: UsageAccount) => Promise<RunrailPlanLimitsFrame | undefined> = async () => codexPlan) {
  const dirs = await Promise.all(["cwd", "state", "accounts"].map((name) => mkdtemp(join("/tmp", `runrail-usage-${name}-`))))
  for (const dir of dirs) cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const [cwd, sessionDir, accountsDir] = dirs as [string, string, string]
  const asked: UsageAccount[] = []
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "system",
    loadExtensions: false,
    model: { complete: () => ({ type: "text" as const, text: "unused" }) },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: new MemoryCredentialVault(),
    usageReaders: {
      "claude-code": async (account) => {
        asked.push(account)
        return claudePlan
      },
      codex,
    },
  })
  cleanup.push(() => running.handle.stop())
  return { running, asked, sessionDir, accountsDir }
}

describe("usage.read", () => {
  test("Codex sign-in changes are read again and identity stays outside the plan frame", async () => {
    let label = "first@example.invalid"
    const { running } = await start(async () => ({ ...codexPlan, account: { label } }))
    const first = await rpc(running, "usage.read", { tool: "codex" })
    expect(first.result).toEqual({ plan: codexPlan, account: { label } })
    label = "second@example.invalid"
    const second = await rpc(running, "usage.read", { tool: "codex" })
    expect(second.result).toEqual({ plan: codexPlan, account: { label } })
    expect(second.result.plan).not.toHaveProperty("account")
  })
  test("Codex usage uses the selected connection's own config directory", async () => {
    const seen: UsageAccount[] = []
    const { running, accountsDir } = await start(async (account) => { seen.push(account); return codexPlan })
    const first = await rpc(running, "connection.addTool", { tool: "codex", separateAccount: true, label: "First" })
    const second = await rpc(running, "connection.addTool", { tool: "codex", separateAccount: true, label: "Second" })
    await rpc(running, "usage.read", { tool: "codex", connectionId: first.result.connectionId })
    await rpc(running, "usage.read", { tool: "codex", connectionId: second.result.connectionId })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.configDir?.startsWith(join(accountsDir, "tool-homes"))).toBe(true)
    expect(seen[1]?.configDir?.startsWith(join(accountsDir, "tool-homes"))).toBe(true)
    expect(seen[0]?.configDir).not.toBe(seen[1]?.configDir)
  })
  test("refresh bypasses a fresh answer and rejects an invalid flag", async () => {
    const { running, asked } = await start()
    await rpc(running, "usage.read", { tool: "claude-code" })
    await rpc(running, "usage.read", { tool: "claude-code" })
    expect(asked).toHaveLength(1)
    expect(await rpc(running, "usage.read", { tool: "claude-code", refresh: true })).toMatchObject({ status: 200, result: { plan: claudePlan } })
    expect(asked).toHaveLength(2)
    expect(await rpc(running, "usage.read", { tool: "claude-code", refresh: "true" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(asked).toHaveLength(2)
  })
  test("reads the usual login, and a connection with its own folder, in an empty folder of the session's", async () => {
    const { running, asked, sessionDir, accountsDir } = await start()
    const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
    expect(health.capabilityStatus["usage.read"]).toBe("available")

    expect(await rpc(running, "usage.read", { tool: "claude-code" })).toEqual({ status: 200, code: null, result: { plan: claudePlan } })
    expect(asked).toEqual([{ cwd: join(sessionDir, "usage") }])
    expect(await rpc(running, "usage.read", { tool: "codex" })).toMatchObject({ status: 200, result: { plan: codexPlan } })

    const own = await rpc(running, "connection.addTool", { tool: "claude-code", separateAccount: true, label: "Work" })
    const connectionId = (own.result as { connectionId: string }).connectionId
    expect(await rpc(running, "usage.read", { tool: "claude-code", connectionId })).toMatchObject({ status: 200, result: { plan: claudePlan } })
    expect(asked).toHaveLength(2)
    expect(asked[1]?.configDir?.startsWith(join(accountsDir, "tool-homes"))).toBe(true)
    expect(asked[1]?.cwd).toBe(join(sessionDir, "usage"))
  })

  test("refuses a bad tool, an unknown or mismatched connection, and a key connection", async () => {
    const { running, asked } = await start()
    expect(await rpc(running, "usage.read", { tool: "gemini" })).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "usage.read", {})).toMatchObject({ status: 400, code: "CONTROL_INVALID_INPUT" })
    expect(await rpc(running, "usage.read", { tool: "codex", connectionId: "missing-connection" })).toMatchObject({ status: 404, code: "CONNECTION_NOT_FOUND" })
    const claude = (await rpc(running, "connection.addTool", { tool: "claude-code", separateAccount: true })).result as { connectionId: string }
    expect(await rpc(running, "usage.read", { tool: "codex", connectionId: claude.connectionId })).toMatchObject({ status: 400, code: "CONNECTION_INVALID" })
    const key = (await rpc(running, "connection.addTool", { tool: "codex", authMode: "api-key" })).result as { connectionId: string }
    expect(await rpc(running, "usage.read", { tool: "codex", connectionId: key.connectionId })).toMatchObject({ status: 409, code: "USAGE_UNAVAILABLE" })
    expect(asked).toEqual([])
  })

  test("a tool that is missing, or has no plan to report, says so", async () => {
    const missing = await start(async () => {
      throw new UsageReadError("TOOL_UNAVAILABLE", "Codex is not installed")
    })
    expect(await rpc(missing.running, "usage.read", { tool: "codex" })).toMatchObject({ status: 501, code: "TOOL_UNAVAILABLE" })
    const none = await start(async () => undefined)
    expect(await rpc(none.running, "usage.read", { tool: "codex" })).toMatchObject({ status: 409, code: "USAGE_UNAVAILABLE" })
  })
})
