import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MultiAgentCoordinator } from "../../src/agents/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createConnectorRegistry } from "../../src/connectors/index.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"
import type { RunrailTerminalBridge, RunrailTerminalChunk, RunrailTerminalSession } from "../../src/control-terminal.ts"

const token = "desktop-parity-control-token-123456"

test("desktop control rejects unconfigured caller-owned bridges and exposes bounded workspace reads", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-desktop-unconfigured-")
  await writeFile(join(cwd, "safe.txt"), "safe workspace content\n", "utf8")
  await writeFile(join(cwd, ".env"), "SHOULD_NOT_BE_READ=1\n", "utf8")
  let running: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
  try {
    running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      authToken: token,
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "done" }) },
    })
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const rpc = async (method: string, params: Readonly<Record<string, unknown>> = {}): Promise<{ readonly response: Response; readonly body: unknown }> => {
      const response = await fetch(`${running!.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
      return { response, body: await response.json() }
    }

    const health = await fetch(`${running.handle.url}/health`)
    expect(await health.json()).toMatchObject({
      capabilityStatus: {
        connectors: "configurable",
        agents: "configurable",
        "session.transcript": "configurable",
        "terminal.create": "configurable",
        "workspace.list": "available",
        "workspace.read": "available",
      },
    })

    for (const [method, code] of [
      ["connector.list", "CONTROL_CONNECTOR_UNAVAILABLE"],
      ["agent.list", "CONTROL_AGENT_UNAVAILABLE"],
      ["session.transcript.status", "CONTROL_TRANSCRIPT_UNAVAILABLE"],
      ["terminal.describe", "CONTROL_TERMINAL_UNAVAILABLE"],
    ] as const) {
      const result = await rpc(method)
      expect(result.response.status).toBe(501)
      expect(result.body).toMatchObject({ ok: false, error: { code } })
    }

    const listed = await rpc("workspace.list", { path: "", maxDepth: 1, maxEntries: 16 })
    expect(listed.response.status).toBe(200)
    expect(listed.body).toMatchObject({ ok: true, result: { entries: [{ path: "safe.txt", type: "file" }] } })

    const read = await rpc("workspace.read", { path: "safe.txt", maxBytes: 128 })
    expect(read.response.status).toBe(200)
    expect(read.body).toMatchObject({ ok: true, result: { path: "safe.txt", content: "safe workspace content\n" } })

    const secret = await rpc("workspace.read", { path: ".env" })
    expect(secret.response.status).toBe(403)
    expect(secret.body).toMatchObject({ ok: false, error: { code: "CONTROL_WORKSPACE_FORBIDDEN" } })

    const escaped = await rpc("workspace.read", { path: "../outside.txt" })
    expect(escaped.response.status).toBe(403)
    expect(escaped.body).toMatchObject({ ok: false, error: { code: "CONTROL_WORKSPACE_FORBIDDEN" } })

    const tooSmall = await rpc("workspace.read", { path: "safe.txt", maxBytes: 1 })
    expect(tooSmall.response.status).toBe(413)
    expect(tooSmall.body).toMatchObject({ ok: false, error: { code: "CONTROL_WORKSPACE_LIMIT" } })
  } finally {
    await running?.handle.stop()
    await rm(cwd, { recursive: true, force: true })
  }
})

test("desktop control exposes configured connector, agent, transcript, workspace, and terminal bridges", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-desktop-configured-")
  const transcriptRoot = await mkdtemp("/tmp/runrail-control-desktop-transcript-")
  const connectors = createConnectorRegistry([{
    descriptor: { id: "fixture", version: "1.0.0", capabilities: ["fixture.read"] },
    actions: [{ name: "lookup", description: "Lookup", kind: "read", capabilities: ["fixture.read"], execute: () => ({ ok: true }) }],
  }])
  const agents = new MultiAgentCoordinator({
    cwd,
    profiles: [{ id: "reader", role: "reader", capabilities: ["fixture.read"] }],
    executor: { run: ({ spec }) => ({ output: `completed:${spec.id}` }) },
    allowedCapabilities: ["fixture.read"],
  })
  const sessions = new Map<string, { session: RunrailTerminalSession; chunks: RunrailTerminalChunk[] }>()
  let observedTerminalCwd = ""
  const bridge: RunrailTerminalBridge = {
    descriptor: { id: "fixture-terminal", version: "1.0.0", capabilities: ["create", "write", "read", "resize", "close"] },
    create: ({ sessionId, cwd: terminalCwd, cols, rows }) => {
      const session = { sessionId, cols, rows, status: "running" as const }
      sessions.set(sessionId, { session, chunks: [] })
      observedTerminalCwd = terminalCwd
      return session
    },
    write: ({ sessionId, data }) => {
      const current = sessions.get(sessionId)
      if (current === undefined) throw new Error("unknown terminal session")
      current.chunks.push({ seq: current.chunks.length, data: `echo:${data}` })
      return { acceptedBytes: Buffer.byteLength(data, "utf8") }
    },
    read: ({ sessionId, afterSeq, maxBytes, maxChunks }) => {
      const current = sessions.get(sessionId)
      if (current === undefined) throw new Error("unknown terminal session")
      const chunks: RunrailTerminalChunk[] = []
      let bytes = 0
      for (const chunk of current.chunks) {
        if (chunk.seq <= afterSeq || chunks.length >= maxChunks) continue
        const chunkBytes = Buffer.byteLength(chunk.data, "utf8")
        if (bytes + chunkBytes > maxBytes) break
        chunks.push(chunk)
        bytes += chunkBytes
      }
      return { session: current.session, chunks, nextSeq: current.chunks.length, closed: current.session.status === "closed" }
    },
    resize: ({ sessionId, cols, rows }) => {
      const current = sessions.get(sessionId)
      if (current === undefined) throw new Error("unknown terminal session")
      current.session = { ...current.session, cols, rows }
      return current.session
    },
    close: ({ sessionId }) => {
      const current = sessions.get(sessionId)
      if (current === undefined) throw new Error("unknown terminal session")
      current.session = { ...current.session, status: "closed" }
      return current.session
    },
  }
  const tokenForConfigured = "desktop-parity-configured-token-123456"
  let running: Awaited<ReturnType<typeof startRunrailControlRpcServer>> | undefined
  try {
    running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      authToken: tokenForConfigured,
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "desktop response" }) },
      transcriptStore: new FileTranscriptStore({ root: transcriptRoot }),
      connectorRegistry: connectors,
      agentCoordinator: agents,
      terminalBridge: bridge,
    })
    const headers = { authorization: `Bearer ${tokenForConfigured}`, "content-type": "application/json" }
    const rpc = async (method: string, params: Readonly<Record<string, unknown>> = {}): Promise<{ readonly response: Response; readonly body: unknown }> => {
      const response = await fetch(`${running!.handle.url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
      return { response, body: await response.json() }
    }

    const health = await fetch(`${running.handle.url}/health`)
    expect(await health.json()).toMatchObject({
      capabilityStatus: {
        connectors: "available",
        agents: "available",
        "session.transcript": "available",
        "terminal.create": "available",
        "terminal.read": "available",
      },
    })

    expect((await rpc("connector.list")).body).toMatchObject({ ok: true, result: [{ id: "fixture" }] })
    expect((await rpc("agent.list")).body).toMatchObject({ ok: true, result: [{ id: "reader" }] })
    expect((await rpc("connector.invoke", { id: "fixture", action: "lookup", capabilities: ["fixture.read"] })).body).toMatchObject({ ok: true, result: { ok: true } })
    expect((await rpc("agent.run", { id: "agent-1", profile: "reader", prompt: "inspect" })).body).toMatchObject({ ok: true, result: { id: "agent-1", ok: true } })

    const turn = await rpc("turn.enqueue", { message: "desktop transcript secret" })
    expect(turn.response.status).toBe(200)
    const transcriptStatus = await rpc("session.transcript.status")
    expect(transcriptStatus.body).toMatchObject({ ok: true, result: { configured: true, contentFreeEvidence: true } })
    const transcript = await rpc("session.transcript.read", { maxRecords: 64, maxBytes: 2 * 1024 * 1024 })
    expect(JSON.stringify(transcript.body)).toContain("desktop transcript secret")
    const transcriptTooSmall = await rpc("session.transcript.read", { maxRecords: 64, maxBytes: 1 })
    expect(transcriptTooSmall.response.status).toBe(413)
    expect(transcriptTooSmall.body).toMatchObject({ ok: false, error: { code: "CONTROL_BODY_LIMIT" } })
    const evidence = await rpc("session.export")
    expect(JSON.stringify(evidence.body)).not.toContain("desktop transcript secret")

    expect((await rpc("terminal.describe")).body).toMatchObject({ ok: true, result: { id: "fixture-terminal", capabilities: expect.arrayContaining(["create", "read"]) } })
    expect((await rpc("terminal.create", { sessionId: "terminal-1", cwd: "", cols: 80, rows: 24 })).body).toMatchObject({ ok: true, result: { sessionId: "terminal-1", cols: 80, rows: 24, status: "running" } })
    expect(observedTerminalCwd.length).toBeGreaterThan(0)
    expect((await rpc("terminal.write", { sessionId: "terminal-1", data: "pwd\n" })).body).toMatchObject({ ok: true, result: { acceptedBytes: 4 } })
    expect((await rpc("terminal.read", { sessionId: "terminal-1", afterSeq: -1, maxBytes: 256, maxChunks: 8 })).body).toMatchObject({ ok: true, result: { chunks: [{ seq: 0, data: "echo:pwd\n" }] } })
    expect((await rpc("terminal.resize", { sessionId: "terminal-1", cols: 100, rows: 30 })).body).toMatchObject({ ok: true, result: { cols: 100, rows: 30 } })
    expect((await rpc("terminal.close", { sessionId: "terminal-1" })).body).toMatchObject({ ok: true, result: { status: "closed" } })
  } finally {
    await running?.handle.stop()
    await connectors.close()
    await rm(cwd, { recursive: true, force: true })
    await rm(transcriptRoot, { recursive: true, force: true })
  }
})
