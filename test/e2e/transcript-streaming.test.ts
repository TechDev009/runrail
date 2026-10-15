import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { ReplayBackend } from "@nifrajs/coding-agent"
import { createRunrailSession } from "../../src/session.ts"
import { FileTranscriptStore } from "../../src/transcript/store.ts"

const TOKENS = 200

function streamingTurn(): AgentEvent[] {
  const base = { version: 1 as const, sessionId: "stream", at: 0 }
  const events: AgentEvent[] = [{ ...base, seq: 0, type: "turn.started", turnId: "t", prompt: "go" }]
  for (let index = 0; index < TOKENS; index += 1) events.push({ ...base, seq: events.length, type: "assistant.delta", turnId: "t", text: "x" })
  events.push({ ...base, seq: events.length, type: "tool.started", turnId: "t", callId: "c1", name: "run_command", input: { program: "ls" } })
  events.push({ ...base, seq: events.length, type: "tool.delta", turnId: "t", callId: "c1", text: "a\n" })
  events.push({ ...base, seq: events.length, type: "tool.delta", turnId: "t", callId: "c1", text: "b\n" })
  events.push({ ...base, seq: events.length, type: "tool.completed", turnId: "t", callId: "c1", name: "run_command", ok: true, output: "a\nb\n" })
  events.push({ ...base, seq: events.length, type: "assistant.message", turnId: "t", text: "done" })
  return events
}

test("a streamed turn is kept as runs of text, not one record per token", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-transcript-stream-"))
  const root = await mkdtemp(join("/tmp", "runrail-transcript-store-"))
  try {
    const transcriptStore = new FileTranscriptStore({ root })
    const session = await createRunrailSession({
      cwd,
      backend: "custom",
      adapter: { name: "custom", version: "1.0.0", capabilities: ["sessions"], create: () => new ReplayBackend({ events: streamingTurn() }) },
      transcriptStore,
    })
    try {
      let seen = 0
      for await (const event of session.prompt("go")) if (event.type === "assistant.delta") seen += 1
      expect(seen).toBe(TOKENS)
      const records = await transcriptStore.read(session.snapshot.id)
      const deltas = records.filter((record) => record.kind === "assistant.delta").map((record) => (record.payload as { text: string }).text)
      expect(deltas.join("")).toBe("x".repeat(TOKENS))
      expect(deltas.length).toBeLessThanOrEqual(1)
      expect(records.filter((record) => record.kind === "tool.delta").map((record) => (record.payload as { text: string }).text)).toEqual(["a\nb\n"])
      expect(records.length).toBeLessThan(20)
    } finally {
      await session.stop("test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("an append after the file changed elsewhere reads it again instead of reusing a sequence", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-transcript-tail-"))
  try {
    const store = new FileTranscriptStore({ root })
    await store.append("s", { kind: "note", payload: 1 })
    await store.append("s", { kind: "note", payload: 2 })
    const other = new FileTranscriptStore({ root })
    await other.append("s", { kind: "note", payload: 3 })
    expect((await store.append("s", { kind: "note", payload: 4 })).seq).toBe(3)
    await writeFile(join(root, "s.jsonl"), "")
    expect((await store.append("s", { kind: "note", payload: 5 })).seq).toBe(0)
    await store.compact("s", { throughSeq: 0, replacement: { kind: "summary", payload: "s" } })
    expect((await store.append("s", { kind: "note", payload: 6 })).seq).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
