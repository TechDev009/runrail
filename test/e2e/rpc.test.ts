import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailRpcServer } from "../../src/server.ts"

describe("Runrail loopback RPC", () => {
  test("requires authorization and serves a complete native turn", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-rpc-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-rpc-store-"))
    const token = "runrail-test-token-123456"
    let running: Awaited<ReturnType<typeof startRunrailRpcServer>> | undefined
    try {
      running = await startRunrailRpcServer({
        cwd,
        backend: "native",
        sessionDir,
        authToken: token,
        model: { complete: () => ({ type: "text", text: "rpc complete" }) },
      })
      const health = await fetch(`${running.handle.url}/health`)
      expect(health.status).toBe(200)
      const unauthorized = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        body: JSON.stringify({ method: "session.create", params: {} }),
      })
      expect(unauthorized.status).toBe(401)
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const created = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.create", params: { sessionId: "rpc-e2e" } }),
      })
      expect(created.status).toBe(200)
      expect(await created.json()).toMatchObject({ id: "rpc-e2e", backend: "runrail" })
      const turn = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "turn.send", params: { message: "finish" } }),
      })
      const body = await turn.text()
      expect(turn.status).toBe(200)
      expect(body).toContain('"type":"assistant.message"')
      expect(body).toContain('"type":"session.completed"')
      const checkpoint = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          method: "session.checkpoint",
          params: { payload: { prompt: "must not persist" } },
        }),
      })
      expect(checkpoint.status).toBe(200)
      const events = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.events", params: { limit: 64 } }),
      })
      const evidence = await events.text()
      expect(evidence).not.toContain("rpc complete")
    } finally {
      await running?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })
})
