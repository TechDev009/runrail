import { describe, expect, test } from "bun:test"
import { createHttpAgentBackend, HttpAgentBackendError } from "../../src/backend/http-agent.ts"
import type { AgentSessionSnapshot } from "@nifrajs/agent-protocol"

function snapshot(id: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq: number): AgentSessionSnapshot {
  return { version: 1, id, backend: "fixture-remote", cwd, status, createdAt: 0, updatedAt: lastSeq, lastSeq, capabilities: ["sessions", "streaming", "approvals", "reload"] }
}

describe("provider-neutral HTTP agent backend", () => {
  test("maps local HTTP lifecycle and streamed events", async () => {
    const sessions = new Map<string, AgentSessionSnapshot>()
    const listener = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/sessions") {
          const body = await request.json() as { readonly cwd?: string; readonly sessionId?: string }
          const id = body.sessionId ?? "remote-1"
          const value = snapshot(id, body.cwd ?? "", "idle", -1)
          sessions.set(id, value)
          return Response.json(value)
        }
        const match = /^\/sessions\/([^/]+)(?:\/(messages|reload|cancel|approvals\/[^/]+))?$/.exec(url.pathname)
        if (match === null) return new Response("not found", { status: 404 })
        const id = decodeURIComponent(match[1]!)
        const current = sessions.get(id)
        if (current === undefined) return new Response("not found", { status: 404 })
        if (request.method === "GET") return Response.json(current)
        if (request.method === "DELETE") { sessions.delete(id); return Response.json({ ok: true }) }
        if (match[2] === "reload") return Response.json({ revision: "fixture:reload", loaded: [], disabled: [], rolledBack: false })
        if (match[2] === "cancel") { sessions.set(id, snapshot(id, current.cwd, "stopped", current.lastSeq)); return Response.json({ ok: true }) }
        if (match[2]?.startsWith("approvals/")) return Response.json({ resolved: true })
        if (match[2] === "messages") {
          const events = [
            { version: 1, sessionId: id, seq: 0, at: 0, type: "turn.started", turnId: "turn", prompt: "fixture" },
            { version: 1, sessionId: id, seq: 1, at: 1, type: "assistant.delta", turnId: "turn", text: "remote" },
            { version: 1, sessionId: id, seq: 2, at: 2, type: "session.completed", snapshot: snapshot(id, current.cwd, "completed", 2) },
          ]
          sessions.set(id, snapshot(id, current.cwd, "completed", 2))
          return Response.json({ events })
        }
        return new Response("bad", { status: 400 })
      },
    })
    const backend = createHttpAgentBackend({ url: listener.url.toString(), name: "fixture-remote", capabilities: ["sessions", "streaming", "approvals", "reload"], headers: { authorization: "Bearer fixture" } })
    try {
      const created = await backend.createSession({ cwd: "/tmp" })
      const events = []
      for await (const event of backend.send({ sessionId: created.id, message: "finish" })) events.push(event)
      expect(events.map((event) => event.type)).toEqual(["turn.started", "assistant.delta", "session.completed"])
      await expect(backend.snapshot(created.id)).resolves.toMatchObject({ status: "completed" })
      await expect(backend.reload(created.id)).resolves.toMatchObject({ revision: "fixture:reload" })
      await expect(backend.resolveApproval(created.id, "approval-1", true)).resolves.toBe(true)
      await backend.close(created.id)
    } finally {
      await listener.stop()
    }
  })

  test("a streamed answer past the byte limit is refused without being read to its end", async () => {
    let sent = 0
    const listener = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 64 * 1024 * 1024) return controller.close()
            sent += 64 * 1024
            controller.enqueue(new Uint8Array(64 * 1024).fill(32))
          },
        })
        return new Response(stream, { headers: { "content-type": "application/json" } })
      },
    })
    try {
      const backend = createHttpAgentBackend({ url: listener.url.toString(), maxResponseBytes: 1024 * 1024 })
      await expect(backend.createSession({ cwd: "/tmp" })).rejects.toMatchObject({ code: "HTTP_AGENT_RESPONSE_INVALID" })
      expect(sent).toBeLessThan(16 * 1024 * 1024)
    } finally {
      await listener.stop(true)
    }
  })

  test("requires explicit remote opt-in and bounds response size", () => {
    expect(() => createHttpAgentBackend({ url: "https://example.test/agent" })).toThrow(HttpAgentBackendError)
    expect(() => createHttpAgentBackend({ url: "http://127.0.0.1:1", maxResponseBytes: 0 })).toThrow(HttpAgentBackendError)
  })
  test("a refused request says why in the remote agent's words, never a header it was sent", async () => {
    const answers: Record<string, () => Response> = {
      json: () => Response.json({ error: { message: "model pool exhausted\nretry later; token fixture-token-123" } }, { status: 503 }),
      text: () => new Response("no such route", { status: 404 }),
      html: () => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502, headers: { "content-type": "text/html" } }),
    }
    let kind = "json"
    const listener = Bun.serve({ port: 0, fetch: () => answers[kind]!() })
    const backend = createHttpAgentBackend({ url: listener.url.toString(), headers: { authorization: "Bearer fixture-token-123" } })
    try {
      const reasons: unknown[] = []
      for (kind of ["json", "text", "html"]) reasons.push(await backend.createSession({ cwd: "/tmp" }).then(() => undefined, (error: unknown) => error))
      expect(reasons).toEqual([
        expect.objectContaining({ code: "HTTP_AGENT_FAILED", reason: "remote agent answered 503: model pool exhausted retry later; token ***" }),
        expect.objectContaining({ code: "HTTP_AGENT_FAILED", reason: "remote agent answered 404: no such route" }),
        // A proxy's error page is markup: the status alone.
        expect.objectContaining({ code: "HTTP_AGENT_FAILED", reason: "remote agent answered 502" }),
      ])
      expect(JSON.stringify(reasons.map(String))).not.toContain("fixture-token-123")
    } finally {
      await listener.stop(true)
    }
  })

  test("a turn whose signal was already aborted stops without waiting on the remote agent", async () => {
    const listener = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/sessions") return Response.json(snapshot("remote-aborted", "/tmp", "idle", -1))
        if (request.method === "POST" && url.pathname.endsWith("/messages")) await new Promise((resolve) => setTimeout(resolve, 3_000))
        return Response.json({ ok: true, events: [] })
      },
    })
    const backend = createHttpAgentBackend({ url: listener.url.toString(), timeoutMs: 10_000 })
    try {
      const session = await backend.createSession({ cwd: "/tmp" })
      const controller = new AbortController()
      controller.abort()
      const started = Date.now()
      const events = []
      for await (const event of backend.send({ sessionId: session.id, message: "go", signal: controller.signal })) events.push(event)
      expect(events.at(-1)?.type).toBe("session.stopped")
      expect(Date.now() - started).toBeLessThan(1_500)
    } finally {
      await listener.stop(true)
    }
  })

  test("cancels a delayed remote request with a terminal stopped event", async () => {
    const listener = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/sessions") return Response.json(snapshot("remote-cancel", "/tmp", "idle", -1))
        if (request.method === "POST" && url.pathname.endsWith("/cancel")) return Response.json({ ok: true })
        if (request.method === "DELETE") return Response.json({ ok: true })
        if (request.method === "POST" && url.pathname.endsWith("/messages")) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          return Response.json({ events: [] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const backend = createHttpAgentBackend({ url: listener.url.toString(), timeoutMs: 5_000 })
    try {
      const session = await backend.createSession({ cwd: "/tmp" })
      const stream = backend.send({ sessionId: session.id, message: "hold" })
      setTimeout(() => void backend.cancel(session.id, "test cancellation"), 10)
      const events = []
      for await (const event of stream) events.push(event)
      expect(events.at(-1)?.type).toBe("session.stopped")
      await backend.close(session.id)
    } finally {
      await listener.stop()
    }
  })
})
