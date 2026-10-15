import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

describe("Runrail control RPC", () => {
  test("authorizes controls, queues a turn, and exports redacted evidence", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-rpc-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-control-rpc-store-"))
    const transcriptDir = await mkdtemp(join("/tmp", "runrail-control-rpc-transcript-"))
    const token = "control-rpc-test-token-123"
    const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
    let running: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
    try {
      running = await startRunrailControlRpcServer({
        cwd,
        backend: "native",
        sessionDir,
        sessionId: "control-rpc-session",
        authToken: token,
        verificationCommand: verifier,
        transcriptStore: new FileTranscriptStore({ root: transcriptDir }),
        loadExtensions: false,
        model: { complete: () => ({ type: "text", text: "control secret response" }) },
      })
      const health = await fetch(`${running.handle.url}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ ok: true, protocol: 1 })
      const unauthorized = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "model.list", params: {} }),
      })
      expect(unauthorized.status).toBe(401)
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const models = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "model.list", params: {} }),
      })
      expect(models.status).toBe(200)
      expect(await models.json()).toMatchObject({ ok: true, result: [{ id: "caller" }] })
      const switched = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "model.switch", params: { id: "caller", thinking: "high" } }),
      })
      expect(switched.status).toBe(200)
      expect(await switched.json()).toMatchObject({ ok: true, result: { id: "caller" } })
      const turn = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "turn.enqueue", params: { message: "control secret prompt" } }),
      })
      const turnBody = await turn.text()
      expect(turn.status).toBe(200)
      expect(turnBody).toContain("control secret response")
      expect(turnBody).toContain("assistant.message")
      const transcriptExport = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.transcript.export", params: {} }),
      })
      const transcriptBody = await transcriptExport.text()
      expect(transcriptExport.status).toBe(200)
      expect(transcriptBody).toContain("control secret prompt")
      const transcriptImport = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.transcript.import", params: { transcript: JSON.parse(transcriptBody).result.transcript, targetSessionId: "control-transcript-copy" } }),
      })
      expect(await transcriptImport.json()).toMatchObject({ ok: true, result: { imported: expect.any(Number) } })
      const exported = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.export", params: {} }),
      })
      const evidence = await exported.text()
      expect(evidence).not.toContain("control secret response")
      expect(evidence).not.toContain("control secret prompt")
      const imported = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.import", params: { evidence: JSON.parse(evidence).result.evidence, targetSessionId: "control-copy" } }),
      })
      expect(imported.status).toBe(200)
      expect(await imported.json()).toMatchObject({ ok: true, result: { imported: expect.any(Number) } })
      const importedAgain = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.import", params: { evidence: JSON.parse(evidence).result.evidence, targetSessionId: "control-copy" } }),
      })
      expect(await importedAgain.json()).toMatchObject({ ok: true, result: { imported: 0 } })
      const history = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.history", params: { limit: 16 } }),
      })
      expect(history.status).toBe(200)
      expect(await history.text()).not.toContain("control secret")
      const backend = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "backend.switch", params: { backend: "replay" } }),
      })
      expect(backend.status).toBe(200)
      expect(await backend.json()).toMatchObject({ ok: true, result: { name: "replay" } })
      const current = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "backend.current", params: {} }),
      })
      expect(await current.json()).toMatchObject({ ok: true, result: { backend: "replay" } })
      const tree = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "session.tree", params: {} }),
      })
      expect(tree.status).toBe(200)
      expect(await tree.json()).toMatchObject({ ok: true, result: { children: [] } })
      const unknown = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "unknown.control", params: {} }),
      })
      expect(unknown.status).toBe(400)
      expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "CONTROL_UNKNOWN_METHOD" } })
    } finally {
      await running?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
      await rm(transcriptDir, { recursive: true, force: true })
    }
  })

  test("publishes a public contract and rejects unsupported or oversized requests", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-contract-"))
    const token = "control-contract-test-token-123"
    let running: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
    try {
      running = await startRunrailControlRpcServer({
        cwd,
        backend: "native",
        authToken: token,
        maxBodyBytes: 1_024,
        loadExtensions: false,
        model: { complete: () => ({ type: "text", text: "contract response" }) },
      })
      const health = await fetch(`${running.handle.url}/health`)
      const healthBody = await health.json() as Record<string, unknown>
      expect(health.status).toBe(200)
      expect(healthBody).toMatchObject({
        ok: true,
        protocol: 1,
        apiVersion: "1.0",
        scope: "single-session",
        eventRecovery: { live: "/events", durable: "task.events", cursor: "afterSeq" },
      })
      expect(healthBody.capabilities).toEqual(expect.arrayContaining(["control.describe", "events.durable", "tasks"]))

      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const described = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "control.describe", params: {} }),
      })
      expect(described.status).toBe(200)
      expect(await described.json()).toMatchObject({ ok: true, result: { protocol: 1, apiVersion: "1.0", scope: "single-session" } })

      const unsupported = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ protocol: 2, method: "control.describe", params: {} }),
      })
      expect(unsupported.status).toBe(400)
      expect(unsupported.headers.get("x-runrail-error-code")).toBe("CONTROL_UNSUPPORTED_VERSION")
      expect(await unsupported.json()).toMatchObject({ ok: false, error: { code: "CONTROL_UNSUPPORTED_VERSION" } })

      const malformed = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: "{ malformed",
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_JSON" } })

      const oversized = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "provider.discover", params: { provider: "openai", apiKey: "x".repeat(2_000) } }),
      })
      expect(oversized.status).toBe(413)
      expect(await oversized.json()).toMatchObject({ ok: false, error: { code: "CONTROL_BODY_LIMIT" } })
    } finally {
      await running?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("enforces project and session ownership for durable tasks", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-scope-"))
    const token = "control-scope-test-token-123"
    let running: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
    try {
      running = await startRunrailControlRpcServer({
        cwd,
        backend: "native",
        authToken: token,
        sessionId: "scope-session",
        nativeProjectId: "scope-project",
        loadExtensions: false,
        model: { complete: () => ({ type: "text", text: "scope response" }) },
      })
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const foreignCreate = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "task.create", params: { taskId: "foreign-task", projectId: "foreign-project", title: "foreign" } }),
      })
      expect(foreignCreate.status).toBe(403)
      expect(await foreignCreate.json()).toMatchObject({ ok: false, error: { code: "NATIVE_AUTH_REQUIRED" } })

      const created = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "task.create", params: { taskId: "owned-task", title: "owned" } }),
      })
      expect(created.status).toBe(200)
      const foreignList = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "task.list", params: { projectId: "foreign-project" } }),
      })
      expect(foreignList.status).toBe(403)
      expect(await foreignList.json()).toMatchObject({ ok: false, error: { code: "NATIVE_AUTH_REQUIRED" } })
    } finally {
      await running?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
