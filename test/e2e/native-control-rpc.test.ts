import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { InMemoryCredentialBroker } from "../../src/accounts/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

type RpcBody = {
  readonly ok: boolean
  readonly result?: Record<string, unknown> | readonly Record<string, unknown>[]
  readonly error?: { readonly code: string }
}

async function rpc(
  running: Awaited<ReturnType<typeof startRunrailControlRpcServer>>,
  method: string,
  params: Record<string, unknown>,
): Promise<{ readonly response: Response; readonly body: RpcBody }> {
  const response = await fetch(`${running.handle.url}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  })
  return { response, body: await response.json() as RpcBody }
}

describe("native control RPC", () => {
  test("persists task idempotency across restart and keeps accounts/shares metadata-only", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-native-rpc-cwd-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-native-rpc-state-"))
    const broker = new InMemoryCredentialBroker()
    broker.set("account-test", "secret-value")
    let first: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
    let second: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
    try {
      const options = {
        cwd,
        backend: "native" as const,
        sessionDir,
        sessionId: "native-rpc-session",
        loadExtensions: false,
        nativeCredentialBroker: broker,
        model: { complete: () => ({ type: "text" as const, text: "private response" }) },
      }
      first = await startRunrailControlRpcServer(options)
      const created = await rpc(first, "task.create", { taskId: "task-rpc", title: "RPC task" })
      expect(created.response.status).toBe(200)
      expect(created.body).toMatchObject({ ok: true, result: { taskId: "task-rpc", status: "draft" } })

      const enqueued = await rpc(first, "task.enqueue", { taskId: "task-rpc", message: "private prompt", idempotencyKey: "rpc-enqueue-1" })
      expect(enqueued.response.status).toBe(200)
      expect(enqueued.body).toMatchObject({ ok: true, result: { status: "completed", task: { status: "completed" } } })
      expect(JSON.stringify(enqueued.body)).not.toContain("private response")
      expect(JSON.stringify(enqueued.body)).not.toContain("private prompt")

      const replay = await rpc(first, "task.enqueue", { taskId: "task-rpc", message: "private prompt", idempotencyKey: "rpc-enqueue-1" })
      expect(replay.body).toMatchObject({ ok: true, result: { status: "replayed" } })
      // A key is one command: reused with another message, it is refused rather than answered with the first result.
      const reused = await rpc(first, "task.enqueue", { taskId: "task-rpc", message: "a different prompt", idempotencyKey: "rpc-enqueue-1" })
      expect(reused.body).toMatchObject({ ok: false, error: { code: "NATIVE_IDEMPOTENCY_CONFLICT" } })

      const account = await rpc(first, "account.create", {
        accountId: "account-test",
        provider: "openai",
        label: "Test account",
        authMode: "caller",
        scopes: ["inference"],
        status: "ready",
      })
      expect(account.response.status).toBe(200)
      expect(JSON.stringify(account.body)).not.toContain("secret-value")
      const resolved = await rpc(first, "account.resolve", { accountId: "account-test" })
      expect(resolved.body).toMatchObject({ ok: true, result: { accountId: "account-test", resolved: true } })
      expect(JSON.stringify(resolved.body)).not.toContain("secret-value")

      const share = await rpc(first, "share.create", { taskId: "task-rpc", mode: "read-only-live" })
      expect(share.response.status).toBe(200)
      expect(share.body).toMatchObject({ ok: true, result: { share: { status: "active", eventCursor: -1 }, bundle: { artifacts: [] } } })
      const shareId = (share.body.result as Record<string, unknown>).share as Record<string, unknown>
      const advanced = await rpc(first, "share.advance", { shareId: shareId.shareId, cursor: 2, expectedRevision: 0 })
      expect(advanced.body).toMatchObject({ ok: true, result: { eventCursor: 2, revision: 1 } })
      expect((await rpc(first, "share.events", { shareId: shareId.shareId })).body).toMatchObject({ ok: true })
      const revoked = await rpc(first, "share.revoke", { shareId: shareId.shareId, expectedRevision: 1 })
      expect(revoked.body).toMatchObject({ ok: true, result: { status: "revoked", revision: 2 } })
      expect((await rpc(first, "share.events", { shareId: shareId.shareId })).body).toMatchObject({ ok: false, error: { code: "SHARE_REVOKED" } })
      // A revoke and an advance that both read revision 0: one wins, and a revoke is never undone.
      const raced = ((await rpc(first, "share.create", { taskId: "task-rpc", mode: "read-only-live" })).body.result as Record<string, Record<string, unknown>>).share!
      const [revokeRace, advanceRace] = await Promise.all([rpc(first, "share.revoke", { shareId: raced.shareId, expectedRevision: 0 }), rpc(first, "share.advance", { shareId: raced.shareId, cursor: 3, expectedRevision: 0 })])
      expect([revokeRace.body.ok, advanceRace.body.ok].filter(Boolean)).toHaveLength(1)
      const settled = (await rpc(first, "share.get", { shareId: raced.shareId })).body.result as Record<string, unknown>
      expect(settled.status).toBe(revokeRace.body.ok === true ? "revoked" : "active")
      expect(settled.revision).toBe(1)
      const brief = await rpc(first, "share.create", { taskId: "task-rpc", mode: "read-only-live", expiresAt: Date.now() + 200 })
      const briefShare = (brief.body.result as Record<string, unknown>).share as Record<string, unknown>
      await Bun.sleep(250)
      expect((await rpc(first, "share.grant", { shareId: briefShare.shareId, subjectId: "viewer", role: "viewer", expectedRevision: 0 })).body).toMatchObject({ ok: false, error: { code: "SHARE_EXPIRED" } })

      await first.handle.stop()
      first = undefined
      second = await startRunrailControlRpcServer(options)
      const listed = await rpc(second, "task.list", {})
      expect(listed.body).toMatchObject({ ok: true, result: [{ taskId: "task-rpc", status: "completed" }] })
      const replayAfterRestart = await rpc(second, "task.enqueue", { taskId: "task-rpc", message: "private prompt", idempotencyKey: "rpc-enqueue-1" })
      expect(replayAfterRestart.body).toMatchObject({ ok: true, result: { status: "replayed" } })
      expect((await rpc(second, "task.enqueue", { taskId: "task-rpc", message: "not executed", idempotencyKey: "rpc-enqueue-1" })).body).toMatchObject({ ok: false, error: { code: "NATIVE_IDEMPOTENCY_CONFLICT" } })
    } finally {
      await second?.handle.stop()
      await first?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })
})
