import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { registerClaudeAgentSdkInstaller } from "../../src/backend/claude-agent-sdk.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  registerClaudeAgentSdkInstaller(undefined)
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function rpc(running: Running, method: string, params: Record<string, unknown> = {}): Promise<{ readonly status: number; readonly code: string | null; readonly message: string; readonly result: Record<string, unknown> }> {
  const response = await fetch(`${running.handle.url}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  })
  const body = await response.json() as { result?: Record<string, unknown>; error?: { code: string; message?: string } }
  return { status: response.status, code: body.error?.code ?? null, message: body.error?.message ?? "", result: body.result ?? {} }
}

async function start(): Promise<Running> {
  const dirs = await Promise.all(["cwd", "state", "accounts"].map((name) => mkdtemp(join("/tmp", `runrail-claude-sdk-${name}-`))))
  for (const dir of dirs) cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const [cwd, sessionDir, accountsDir] = dirs as [string, string, string]
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "system",
    loadExtensions: false,
    model: { complete: () => ({ type: "text" as const, text: "unused" }) },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: new MemoryCredentialVault(),
  })
  cleanup.push(() => running.handle.stop())
  return running
}

test("the desktop's engine reports a missing SDK and downloads it only when asked to", async () => {
  let downloaded = false
  registerClaudeAgentSdkInstaller({ version: "0.3.288", installed: () => downloaded, install: async () => { downloaded = true } })
  const running = await start()
  const status = await rpc(running, "claude.sdk.status")
  expect(status.result).toMatchObject({ ready: false, source: "installable", version: "0.3.288", npmUrl: "https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk" })
  expect(downloaded).toBe(false)

  expect((await rpc(running, "claude.sdk.install")).code).toBe("CONTROL_INVALID_INPUT")
  expect(downloaded).toBe(false)
  expect((await rpc(running, "claude.sdk.install", { confirm: true })).result).toMatchObject({ ready: true, source: "downloaded" })
  expect(downloaded).toBe(true)
})

test("a failed download says why, and an engine with no installer names the command instead", async () => {
  const running = await start()
  const none = await rpc(running, "claude.sdk.install", { confirm: true })
  expect([none.status, none.code]).toEqual([501, "CONTROL_CAPABILITY_UNAVAILABLE"])
  expect(none.message).toContain("bun add")

  registerClaudeAgentSdkInstaller({ version: "0.3.288", installed: () => false, install: async () => { throw new Error("agent SDK download failed: HTTP 503") } })
  const failed = await rpc(running, "claude.sdk.install", { confirm: true })
  expect([failed.status, failed.code, failed.message]).toEqual([502, "CONTROL_CLAUDE_SDK_INSTALL_FAILED", "agent SDK download failed: HTTP 503"])
})
