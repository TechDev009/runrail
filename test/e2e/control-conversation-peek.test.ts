import { afterEach, expect, test } from "bun:test"
import { appendFile, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
const token = "control-conversation-peek-token-1234567890"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(`/tmp/${prefix}`)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<{ readonly status: number; readonly body: any }>

async function start(options: Record<string, unknown>): Promise<{ readonly rpc: Rpc; readonly url: string }> {
  const running = await startRunrailControlRpcServer({ backend: "native", authToken: token, loadExtensions: false, verificationCommand: verifier, ...options } as Parameters<typeof startRunrailControlRpcServer>[0])
  cleanup.push(() => running.handle.stop())
  const rpc: Rpc = async (method, params = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() }
  }
  return { rpc, url: running.handle.url }
}

const toolModel = {
  complete: (request: { messages: readonly { role: string }[] }) => request.messages.some((message) => message.role === "tool")
    ? { type: "text" as const, text: "listed" }
    : { type: "tool" as const, name: "list_files", input: { path: "." } },
}

/** A thread that ran one turn, with its transcript where a client keeps its threads. */
async function threadWithHistory(threadsDir: string, threadId: string): Promise<{ readonly workspace: string; readonly read: any }> {
  const workspace = await tempDir("runrail-peek-workspace-")
  const thread = await start({ cwd: workspace, sessionId: threadId, model: toolModel, transcriptStore: new FileTranscriptStore({ root: join(threadsDir, threadId, "transcript") }) })
  expect((await thread.rpc("turn.enqueue", { message: "list the files" })).status).toBe(200)
  const read = await thread.rpc("session.conversation.read", { source: "auto", maxItems: 2048 })
  expect(read.status).toBe(200)
  return { workspace, read: read.body.result }
}

async function snapshotOf(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { recursive: true })
  return Promise.all(entries.sort().map(async (entry) => {
    const info = await stat(join(dir, entry))
    return `${entry} ${String(info.size)} ${String(info.mtimeMs)}`
  }))
}

test("peek gives what the thread's own read gives, and changes nothing on disk", async () => {
  const threadsDir = await tempDir("runrail-peek-threads-")
  const { workspace, read } = await threadWithHistory(threadsDir, "thread-a")
  expect(read.items.length).toBeGreaterThan(1)
  const system = await start({ cwd: await tempDir("runrail-peek-system-"), model: toolModel, threadsDir })
  const health = await (await fetch(`${system.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["conversation.peek"]).toBe("available")

  const before = await snapshotOf(threadsDir)
  const peek = await system.rpc("conversation.peek", { threadId: "thread-a", workspace, maxItems: 2048 })
  expect(peek.status).toBe(200)
  expect(peek.body.result).toEqual({ threadId: "thread-a", items: read.items, truncated: read.truncated, lastSeq: read.lastSeq })
  expect(await snapshotOf(threadsDir)).toEqual(before)

  const newest = await system.rpc("conversation.peek", { threadId: "thread-a", workspace, maxItems: 1 })
  expect(newest.body.result).toMatchObject({ items: [read.items.at(-1)], truncated: true, lastSeq: read.lastSeq })

  const never = await system.rpc("conversation.peek", { threadId: "thread-never-ran", workspace })
  expect(never.body.result).toEqual({ threadId: "thread-never-ran", items: [], truncated: false, lastSeq: -1 })
})

test("a last line still being written is left out, and the file is left as it is", async () => {
  const threadsDir = await tempDir("runrail-peek-torn-")
  const { workspace, read } = await threadWithHistory(threadsDir, "thread-b")
  const file = join(threadsDir, "thread-b", "transcript", "thread-b.jsonl")
  await appendFile(file, '{"version":1,"sessionId":"thread-b","seq":', "utf8")
  const before = await snapshotOf(threadsDir)
  const system = await start({ cwd: await tempDir("runrail-peek-system-"), model: toolModel, threadsDir })
  const peek = await system.rpc("conversation.peek", { threadId: "thread-b", workspace, maxItems: 2048 })
  expect(peek.status).toBe(200)
  expect(peek.body.result.items).toEqual(read.items)
  expect(peek.body.result.lastSeq).toBe(read.lastSeq)
  expect(await snapshotOf(threadsDir)).toEqual(before)
})

test("peek refuses bad input, and is unavailable without a threads folder", async () => {
  const threadsDir = await tempDir("runrail-peek-refuse-")
  const workspace = await tempDir("runrail-peek-workspace-")
  const system = await start({ cwd: await tempDir("runrail-peek-system-"), model: toolModel, threadsDir })
  const refused = async (params: Record<string, unknown>) => {
    const answer = await system.rpc("conversation.peek", params)
    return [answer.status, answer.body.error?.code]
  }
  expect(await refused({ threadId: "../thread-a", workspace })).toEqual([400, "CONTROL_INVALID_INPUT"])
  expect(await refused({ workspace })).toEqual([400, "CONTROL_INVALID_INPUT"])
  expect(await refused({ threadId: "thread-a", workspace: "relative/folder" })).toEqual([400, "CONTROL_INVALID_INPUT"])
  expect(await refused({ threadId: "thread-a", workspace: join(workspace, "missing") })).toEqual([400, "CONTROL_INVALID_INPUT"])
  expect(await refused({ threadId: "thread-a", workspace, maxItems: 0 })).toEqual([400, "CONTROL_INVALID_INPUT"])
  expect(await refused({ threadId: "thread-a", workspace, maxItems: 2049 })).toEqual([400, "CONTROL_INVALID_INPUT"])

  const plain = await start({ cwd: await tempDir("runrail-peek-plain-"), model: toolModel })
  const health = await (await fetch(`${plain.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["conversation.peek"]).toBe("configurable")
  const unavailable = await plain.rpc("conversation.peek", { threadId: "thread-a", workspace })
  expect([unavailable.status, unavailable.body.error?.code]).toEqual([501, "CONTROL_CAPABILITY_UNAVAILABLE"])
})

test("a malformed transcript is reported as invalid", async () => {
  const threadsDir = await tempDir("runrail-peek-invalid-")
  const { workspace } = await threadWithHistory(threadsDir, "thread-c")
  await appendFile(join(threadsDir, "thread-c", "transcript", "thread-c.jsonl"), "not json\n", "utf8")
  const system = await start({ cwd: await tempDir("runrail-peek-system-"), model: toolModel, threadsDir })
  const answer = await system.rpc("conversation.peek", { threadId: "thread-c", workspace })
  expect([answer.status, answer.body.error?.code]).toEqual([400, "CONTROL_TRANSCRIPT_INVALID"])
})
