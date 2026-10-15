import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

/** A fixed check, so the turn ends the same way whether or not this machine has `nifra`. */
const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")

const token = "control-conversation-token-1234567890"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>

function rpcFor(url: string): Rpc {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  return async (method, params = {}) => {
    const response = await fetch(`${url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
}

const toolModel = {
  complete: (request: { messages: readonly { role: string }[] }) => request.messages.some((message) => message.role === "tool")
    ? { type: "text" as const, text: "listed" }
    : { type: "tool" as const, name: "list_files", input: { path: "." } },
}

test("conversation read rebuilds the live thread and task titles can be renamed", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-conversation-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", authToken: token, loadExtensions: false, model: toolModel, verificationCommand: verifier })
  cleanup.push(() => running.handle.stop())
  const rpc = rpcFor(running.handle.url)

  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["session.conversation"]).toBe("available")
  expect(health.capabilityStatus["task.rename"]).toBe("available")

  expect((await rpc("turn.enqueue", { message: "list the files" })).status).toBe(200)
  const read = await rpc("session.conversation.read")
  expect(read.status).toBe(200)
  const result = read.body.result as { source: string; sessionId: string; lastSeq: number; truncated: boolean; items: { kind: string; text?: string; status?: string; presentation?: { kind: string } }[] }
  expect(result.source).toBe("live")
  expect(result.truncated).toBe(false)
  expect(result.lastSeq).toBeGreaterThan(0)
  expect(result.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant", "notice"])
  expect(result.items[0]?.text).toBe("list the files")
  expect(result.items[1]).toMatchObject({ status: "ok", presentation: { kind: "list" } })
  expect(result.items[2]?.text).toBe("listed")

  const tail = await rpc("session.conversation.read", { maxItems: 1 })
  expect((tail.body.result as { items: unknown[]; truncated: boolean })).toMatchObject({ truncated: true, items: [{ kind: "notice", code: "verification.passed" }] })

  const created = await rpc("task.create", { title: "Untitled" })
  const taskId = (created.body.result as { taskId: string; revision: number }).taskId
  const renamed = await rpc("task.rename", { taskId, title: "List project files" })
  expect(renamed.status).toBe(200)
  expect(renamed.body.result).toMatchObject({ taskId, title: "List project files", revision: 1 })
  const listed = await rpc("task.list")
  expect((listed.body.result as { title: string }[]).map((task) => task.title)).toContain("List project files")
  const same = await rpc("task.rename", { taskId, title: "List project files" })
  expect(same.body.result).toMatchObject({ revision: 1 })

  for (const [method, params] of [
    ["session.conversation.read", { maxItems: 0 }],
    ["session.conversation.read", { maxItems: 5_000 }],
    ["session.conversation.read", { maxBytes: 10 }],
    ["session.conversation.read", { source: "disk" }],
    ["session.conversation.read", { sessionId: "../escape" }],
    ["session.conversation.read", { sessionId: "other-session", source: "live" }],
    ["task.rename", { taskId, title: "" }],
    ["task.rename", { taskId, title: "x".repeat(300) }],
    ["task.rename", { taskId: "bad id!", title: "ok" }],
  ] as const) {
    const response = await rpc(method, params)
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: { code: "CONTROL_INVALID_INPUT" } })
  }
  const transcript = await rpc("session.conversation.read", { source: "transcript" })
  expect(transcript.status).toBe(501)
  expect(transcript.body).toMatchObject({ error: { code: "CONTROL_TRANSCRIPT_UNAVAILABLE" } })
  const missing = await rpc("task.rename", { taskId: "task-missing", title: "ok" })
  expect(missing.status).toBe(404)
  const unauthorized = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "session.conversation.read", params: {} }) })
  expect(unauthorized.status).toBe(401)
})

test("conversation read reopens a thread from the transcript store after restart", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-conversation-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const transcriptRoot = join(cwd, ".transcripts")
  const start = () => startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    sessionId: "thread-reopen-1",
    transcriptStore: new FileTranscriptStore({ root: transcriptRoot }),
    model: toolModel,
    verificationCommand: verifier,
  })
  const first = await start()
  const firstRpc = rpcFor(first.handle.url)
  expect((await firstRpc("turn.enqueue", { message: { text: "list please", attachments: [] } })).status).toBe(200)
  await first.handle.stop()

  const second = await start()
  cleanup.push(() => second.handle.stop())
  const rpc = rpcFor(second.handle.url)
  const read = await rpc("session.conversation.read")
  expect(read.status).toBe(200)
  const result = read.body.result as { source: string; sessionId: string; items: { kind: string; text?: string }[] }
  expect(result.source).toBe("transcript")
  expect(result.sessionId).toBe("thread-reopen-1")
  expect(result.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant", "notice"])
  expect(result.items[0]?.text).toBe("list please")

  const live = await rpc("session.conversation.read", { source: "live" })
  expect((live.body.result as { items: unknown[] }).items).toEqual([])
  const other = await rpc("session.conversation.read", { sessionId: "never-written" })
  expect(other.status).toBe(200)
  expect((other.body.result as { items: unknown[] }).items).toEqual([])
})

test("a coding tool's reviews show in the live conversation and come back from the transcript", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-conversation-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const transcriptRoot = join(cwd, ".transcripts")
  const codexFixture = resolve(import.meta.dir, "../fixtures/codex-app-server.ts")
  const start = () => startRunrailControlRpcServer({
    cwd,
    backend: "codex",
    authToken: token,
    loadExtensions: false,
    sessionId: "thread-reviews-1",
    transcriptStore: new FileTranscriptStore({ root: transcriptRoot }),
    harnessCommand: process.execPath,
    harnessArgs: [codexFixture, "auto-review"],
    harnessProtocol: "app-server",
    harnessLaunch: { permissionMode: "auto" },
    verificationCommand: verifier,
  })
  type Item = { readonly kind: string; readonly reviewId?: string; readonly decision?: string; readonly code?: string }
  const reviews = (items: readonly Item[]) => items.filter((item) => item.kind === "review").map((item) => [item.reviewId, item.decision])
  const expected = [["codex-review-1", "approved"], ["codex-review-2", "denied"]]

  const first = await start()
  const firstRpc = rpcFor(first.handle.url)
  expect((await firstRpc("turn.enqueue", { message: "go" })).status).toBe(200)
  const live = (await firstRpc("session.conversation.read", { source: "live" })).body.result as { items: Item[] }
  expect(reviews(live.items)).toEqual(expected)
  expect(live.items.some((item) => item.kind === "notice" && item.code === "reviewer.warning")).toBe(true)
  expect(live.items.some((item) => item.kind === "assistant")).toBe(true)
  await first.handle.stop()

  const second = await start()
  cleanup.push(() => second.handle.stop())
  const stored = (await rpcFor(second.handle.url)("session.conversation.read")).body.result as { source: string; items: Item[] }
  expect(stored.source).toBe("transcript")
  expect(reviews(stored.items)).toEqual(expected)
  expect(stored.items.some((item) => item.kind === "notice" && item.code === "reviewer.warning")).toBe(true)
}, { timeout: 30_000 })

test("a Codex request Runrail refused shows in the live conversation in Runrail's words", async () => {
  const cwd = await mkdtemp("/tmp/runrail-control-conversation-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const started = await startRunrailControlRpcServer({
    cwd,
    backend: "codex",
    authToken: token,
    loadExtensions: false,
    sessionId: "thread-refusals-1",
    harnessCommand: process.execPath,
    harnessArgs: [resolve(import.meta.dir, "../fixtures/codex-app-server.ts"), "foreign-approval"],
    harnessProtocol: "app-server",
    verificationCommand: verifier,
  })
  cleanup.push(() => started.handle.stop())
  const rpc = rpcFor(started.handle.url)
  expect((await rpc("turn.enqueue", { message: "go" })).status).toBe(200)
  const live = (await rpc("session.conversation.read", { source: "live" })).body.result as { items: { readonly kind: string; readonly code?: string; readonly message?: string }[] }
  const refusals = live.items.filter((item) => item.kind === "notice" && item.code === "request.refused").map((item) => item.message)
  expect(refusals).toEqual([
    "Runrail refused a Codex request to run a command: it came from a Codex thread that is neither this session's nor one of its sub-agents.",
    "Runrail refused a Codex request for wider access: it came from a Codex thread that is neither this session's nor one of its sub-agents.",
    "Runrail refused a Codex request to change files: it belongs to a Codex turn that has already ended.",
    "Runrail refused a Codex request to ask you a question: it belongs to a Codex turn that has already ended.",
  ])
}, { timeout: 30_000 })
