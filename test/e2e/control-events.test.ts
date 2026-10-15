import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { RunrailSessionController } from "../../src/control.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

describe("Runrail control event stream", () => {
  test("replays completed events and rejects unauthenticated streams", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-events-"))
    const token = "control-events-test-token-123"
    const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
    const running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      authToken: token,
      verificationCommand: verifier,
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "streamed response" }) },
    })
    try {
      const unauthorized = await fetch(`${running.handle.url}/events`)
      expect(unauthorized.status).toBe(401)

      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const turn = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "turn.enqueue", params: { message: "stream fixture" } }),
      })
      expect(turn.status).toBe(200)

      const response = await fetch(`${running.handle.url}/events?afterSeq=-1`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      const first = await reader?.read()
      const text = new TextDecoder().decode(first?.value)
      expect(text).toContain('"type":"turn.started"')
      expect(text).toContain('"type":"session.completed"')
      await reader?.cancel()
    } finally {
      await running.handle.stop()
    }
  })

  test("an event over the frame limit is named and skipped, and the stream carries on", async () => {
    let calls = 0
    const cwd = await mkdtemp(join("/tmp", "runrail-control-events-"))
    const token = "control-events-test-token-123"
    const running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      authToken: token,
      loadExtensions: false,
      // Within one event's text, but each control character is six bytes of JSON: past the frame limit.
      model: { complete: () => (calls++ === 0 ? { type: "tool", name: "read_file", input: { path: "missing.txt" } } : { type: "text", text: "\u0001".repeat(200_000) }) },
    })
    try {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const turn = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method: "turn.enqueue", params: { message: "big" } }) })
      expect(turn.status).toBe(200)
      const response = await fetch(`${running.handle.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${token}` } })
      const reader = response.body!.getReader()
      let text = ""
      while (!text.includes('"type":"session.completed"')) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += new TextDecoder().decode(chunk.value)
      }
      await reader.cancel()
      expect(text).toContain("event: runrail.omitted")
      expect(text).toContain('"type":"assistant.message","bytes":')
      expect(text).toContain('"type":"tool.completed"')
      expect(text).toContain('"type":"session.completed"')
      expect(text).not.toContain("\\u0001".repeat(100))
    } finally {
      await running.handle.stop()
    }
  })

  test("opens at once when there is nothing to replay", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-events-"))
    const token = "control-events-test-token-123"
    const running = await startRunrailControlRpcServer({ cwd, backend: "replay", authToken: token, loadExtensions: false })
    try {
      const response = await fetch(`${running.handle.url}/events?afterSeq=-1`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      })
      expect(response.status).toBe(200)
      const reader = response.body?.getReader()
      const first = await reader?.read()
      expect(new TextDecoder().decode(first?.value)).toBe(": open\n\n")
      await reader?.cancel()
    } finally {
      await running.handle.stop()
    }
  })

  test("ends an open stream when the server stops", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-events-"))
    const token = "control-events-test-token-123"
    const running = await startRunrailControlRpcServer({ cwd, backend: "replay", authToken: token, loadExtensions: false })
    const response = await fetch(`${running.handle.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${token}` } })
    const reader = response.body?.getReader()
    await reader?.read()
    await running.handle.stop()
    expect((await reader?.read())?.done).toBe(true)
  })

  test("stops while a call is held open by a running turn", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-events-"))
    const token = "control-events-test-token-123"
    const running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      authToken: token,
      loadExtensions: false,
      model: { complete: () => new Promise(() => {}) },
    })
    const held = fetch(`${running.handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "turn.enqueue", params: { message: "held turn" } }),
    }).then((response) => response.json() as Promise<unknown>)
    await Bun.sleep(50)
    await running.handle.stop()
    expect(await held).toMatchObject({ ok: false, error: { code: "CONTROL_OPERATION_FAILED" } })
  })

  test("reports a stable cursor-expired error after the bounded journal rolls over", async () => {
    const session = {
      snapshot: { id: "fixture", status: "idle" },
      backend: { info: { name: "native" } },
      prompt: async function* (): AsyncIterable<AgentEvent> {
        for (let index = 0; index < 8_193; index += 1) {
          yield {
            version: 1,
            sessionId: "fixture",
            seq: index,
            at: index,
            type: "assistant.message",
            turnId: "turn",
            text: "fixture",
          }
        }
      },
    } as unknown as ConstructorParameters<typeof RunrailSessionController>[0]
    const controller = new RunrailSessionController(session)
    await controller.enqueue("fixture")

    expect(() => controller.eventsSince(-1)).toThrow("event cursor has expired")
    try {
      controller.eventsSince(-1)
    } catch (error) {
      expect(error).toMatchObject({ code: "CONTROL_CURSOR_EXPIRED" })
    }
  })
})
