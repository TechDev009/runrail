import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isAgentEvent, type AgentEvent } from "@nifrajs/agent-protocol"
import { parseCliArgs } from "../../src/cli.ts"
import { runRunrailConsole } from "../../src/console.ts"
import { createCallerCredentialResolver, createRunrailSession, type RunrailSessionOptions } from "../../src/index.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")

type Chunk = Record<string, unknown>

/** A provider that answers each request with the next list of stream chunks, and records what it was sent. */
async function withNativeSession(turns: readonly (readonly Chunk[])[], options: Partial<RunrailSessionOptions>, run: (session: Awaited<ReturnType<typeof createRunrailSession>>, cwd: string, requests: string[]) => Promise<void>): Promise<void> {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(await request.text())
      const chunks = turns[Math.min(requests.length - 1, turns.length - 1)] ?? []
      const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
      return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const cwd = mkdtempSync(join(tmpdir(), "runrail-long-text-"))
  const session = await createRunrailSession({
    cwd,
    backend: "native",
    verify: "check",
    verificationCommand: verifier,
    maxRepairAttempts: 0,
    loadExtensions: false,
    provider: {
      provider: "custom-openai-chat",
      model: "fixture-model",
      maxOutputTokens: 1_024,
      endpoint: `http://127.0.0.1:${server.port}/v1`,
      credential: { kind: "caller", account: "fixture" },
      credentialResolver: createCallerCredentialResolver(() => "fixture-secret"),
    },
    ...options,
  })
  try {
    await run(session, cwd, requests)
  } finally {
    await session.close()
    await server.stop(true)
    rmSync(cwd, { recursive: true, force: true })
  }
}

const text = (content: string): Chunk => ({ choices: [{ delta: { content }, finish_reason: null }] })
const stop: Chunk = { choices: [{ delta: {}, finish_reason: "stop" }] }
const replyChunks = (reply: string): Chunk[] => [...Array.from({ length: Math.ceil(reply.length / 50_000) }, (_, index) => text(reply.slice(index * 50_000, (index + 1) * 50_000))), stop]

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = []
  for await (const event of events) all.push(event)
  return all
}

const completed = (events: readonly AgentEvent[]): boolean => events.some((event) => event.type === "session.completed") && !events.some((event) => event.type === "session.failed")
const replies = (events: readonly AgentEvent[]): string => events.flatMap((event) => (event.type === "assistant.message" ? [event.text] : [])).join("")

describe("long text on the native backend", () => {
  test("a prompt past 64 KiB reaches the model whole", async () => {
    const prompt = `${"p".repeat(100_000)} end of prompt`
    await withNativeSession([[text("read"), stop]], {}, async (session, _cwd, requests) => {
      const events = await collect(session.prompt(prompt))
      expect(completed(events)).toBe(true)
      expect(events.every(isAgentEvent)).toBe(true)
      expect(requests[0]).toContain(prompt)
    })
  })

  test("a prompt past 256 KiB is refused before the turn starts", async () => {
    await withNativeSession([[text("unused"), stop]], {}, async (session, _cwd, requests) => {
      await expect(collect(session.prompt("p".repeat(256 * 1024 + 1)))).rejects.toThrow("prompt text is invalid")
      expect(requests).toHaveLength(0)
    })
  })

  test("a reply past one event's text ends the turn with valid events", async () => {
    const reply = "q".repeat(300_000)
    await withNativeSession([replyChunks(reply)], {}, async (session) => {
      const events = await collect(session.prompt("say a lot"))
      expect(completed(events)).toBe(true)
      expect(events.every(isAgentEvent)).toBe(true)
      expect(reply.startsWith(replies(events).slice(0, 200_000))).toBe(true)
    })
  })

  test("maxReplyChars belongs to the native backend and is bounded", async () => {
    await expect(createRunrailSession({ cwd: "/tmp", backend: "codex", loadExtensions: false, maxReplyChars: 4_096 })).rejects.toThrow("MAX_REPLY_CHARS_REQUIRES_NATIVE_BACKEND")
    await expect(createRunrailSession({ cwd: "/tmp", backend: "native", loadExtensions: false, maxReplyChars: 255 })).rejects.toThrow("maxReplyChars")
    expect(parseCliArgs(["run", "--cwd", "/tmp", "--max-reply-chars", "4096", "task"])).toMatchObject({ maxReplyChars: 4_096 })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp", "--backend", "codex", "--max-reply-chars", "4096", "task"])).toThrow("--max-reply-chars requires the native backend")
    expect(() => parseCliArgs(["run", "--cwd", "/tmp", "--max-reply-chars", "100", "task"])).toThrow("max-reply-chars must be between 256")
  })

  test("a write_file past 64 KiB writes the whole file", async () => {
    const content = "w".repeat(100_000)
    // A provider streams a tool call's arguments in pieces.
    const args = JSON.stringify({ path: "big.txt", content })
    const call: Chunk[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "" } }] }, finish_reason: null }] },
      ...Array.from({ length: Math.ceil(args.length / 16_000) }, (_, index): Chunk => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(index * 16_000, (index + 1) * 16_000) } }] }, finish_reason: null }] })),
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]
    await withNativeSession([call, [text("written"), stop]], { approval: { request: () => true } }, async (session, cwd) => {
      const events = await collect(session.prompt("write it"))
      expect(completed(events)).toBe(true)
      expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ name: "write_file", ok: true })
      expect(readFileSync(join(cwd, "big.txt"), "utf8")).toBe(content)
    })
  })

  test("the console prints a reply past one event's text as one", async () => {
    const reply = "q".repeat(300_000)
    const cwd = mkdtempSync(join(tmpdir(), "runrail-long-console-"))
    const output: string[] = []
    async function* input(): AsyncIterable<string> {
      yield "say a lot"
      const deadline = Date.now() + 10_000
      while (!output.join("").includes(`${reply}\n`) && Date.now() < deadline) await Bun.sleep(10)
      yield ":quit"
    }
    try {
      await runRunrailConsole({ cwd, backend: "native", input: input(), output: { write: (text) => output.push(text) }, loadExtensions: false, model: { complete: () => ({ type: "text", text: reply }) } })
      expect(output.join("")).toContain(`${reply}\n`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("a reply past one event's text arrives whole, and maxReplyChars cuts it", async () => {
    const reply = "q".repeat(300_000)
    await withNativeSession([replyChunks(reply)], {}, async (session) => {
      expect(replies(await collect(session.prompt("say a lot")))).toBe(reply)
    })
    await withNativeSession([replyChunks(reply)], { maxReplyChars: 1_000 }, async (session) => {
      const cut = replies(await collect(session.prompt("say a lot")))
      expect(cut).toHaveLength(1_000)
      expect(cut.endsWith("…[truncated]")).toBe(true)
    })
  })
})
