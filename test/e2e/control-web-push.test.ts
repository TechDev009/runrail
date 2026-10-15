import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { base64url } from "../../src/push/web-push.ts"

/** `push.vapid` and `push.send` for the desktop's phone access. */

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
  const body = (await response.json()) as { result?: Record<string, unknown>; error?: { code: string } }
  return { status: response.status, code: body.error?.code ?? null, result: body.result ?? {} }
}

describe("push", () => {
  test("gives phones this computer's key, keeps it, and posts only to a push service", async () => {
    const dirs = await Promise.all(["cwd", "state", "accounts", "push"].map((name) => mkdtemp(join("/tmp", `runrail-push-${name}-`))))
    for (const dir of dirs) cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const [cwd, sessionDir, accountsDir, pushDir] = dirs as [string, string, string, string]
    const posted: string[] = []
    let answer = 201
    const running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      sessionDir,
      sessionId: "system",
      loadExtensions: false,
      model: { complete: () => ({ type: "text" as const, text: "unused" }) },
      nativeAccountsDir: accountsDir,
      nativeCredentialVault: new MemoryCredentialVault(),
      pushDir,
      pushFetch: (async (url: string | URL | Request) => {
        posted.push(String(url))
        return new Response(null, { status: answer })
      }) as typeof fetch,
    })
    cleanup.push(() => running.handle.stop())
    const health = (await (await fetch(`${running.handle.url}/health`)).json()) as { capabilityStatus: Record<string, string> }
    expect(health.capabilityStatus.push).toBe("available")

    const first = await rpc(running, "push.vapid")
    expect(first.result.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    expect((await rpc(running, "push.vapid")).result.publicKey).toBe(first.result.publicKey)

    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair
    const subscription = { endpoint: "https://web.push.apple.com/QGuQyavXutnMH8eFmz8", keys: { p256dh: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) } }
    const send = { subscription, contact: "https://mac.tail1.ts.net:8443", message: { title: "Fix the parser", body: "Finished" } }
    expect(await rpc(running, "push.send", send)).toEqual({ status: 200, code: null, result: { delivered: true } })
    answer = 410
    expect((await rpc(running, "push.send", send)).result).toEqual({ delivered: false, gone: true })
    expect(posted).toEqual([subscription.endpoint, subscription.endpoint])

    expect((await rpc(running, "push.send", { ...send, subscription: { ...subscription, endpoint: "https://127.0.0.1/x" } })).code).toBe("CONTROL_INVALID_INPUT")
    answer = 500
    expect(await rpc(running, "push.send", send)).toMatchObject({ status: 502, code: "CONTROL_PUSH_FAILED" })
    expect(posted).toHaveLength(3)
  })
})
