import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAgentEvent, type AgentEvent } from "@nifrajs/agent-protocol"
import { ConversationBuilder, type ConversationEntry } from "../../src/conversation/index.ts"
import { EVENT_TEXT_MAX, eventText, eventTextPieces, mayContinue } from "../../src/harness/event-text.ts"
import { mapClaudeCodeEvent, mapCodexEvent } from "../../src/harness/mappers.ts"
import { boundToolInput } from "../../src/harness/tool-input.ts"
import type { HarnessEventMappingContext } from "../../src/harness/types.ts"
import { historyFromTranscript } from "../../src/session/history.ts"
import type { TranscriptRecord } from "../../src/transcript/index.ts"
import { FileTranscriptStore } from "../../src/transcript/store.ts"

const REPLACEMENT = String.fromCodePoint(0xfffd)
const long = `${"r".repeat(300_000)}\0end`
const whole = `${"r".repeat(300_000)}${REPLACEMENT}end`
const previous = { version: 1 as const, id: "session", backend: "harness", cwd: "/tmp", status: "idle" as const, createdAt: 1, updatedAt: 1, lastSeq: 0, capabilities: [] }
const context = (): HarnessEventMappingContext => ({ sessionId: "session", cwd: "/tmp", backend: "harness", nextSeq: 4, previous })

function list(result: AgentEvent | readonly AgentEvent[] | undefined): readonly AgentEvent[] {
  return result === undefined ? [] : Array.isArray(result) ? result : [result as AgentEvent]
}

function texts(events: readonly AgentEvent[], type: string): string[] {
  return events.flatMap((event) => (event.type === type && "text" in event ? [event.text] : []))
}

describe("event text pieces", () => {
  test("join back to the text, each within one event, NUL replaced", () => {
    const pieces = eventTextPieces(long)
    expect(pieces).toHaveLength(2)
    expect(pieces.join("")).toBe(whole)
    expect(pieces.every((piece) => piece.length <= EVENT_TEXT_MAX)).toBe(true)
    expect(eventTextPieces("")).toEqual([""])
  })

  test("only a piece that is not the last may continue", () => {
    const pieces = eventTextPieces(`${"line\n".repeat(120_000)}tail`)
    expect(pieces.slice(0, -1).every(mayContinue)).toBe(true)
    expect(mayContinue("a short reply")).toBe(false)
  })

  test("one field is cut with a marker", () => {
    expect(eventText(long)).toHaveLength(EVENT_TEXT_MAX)
    expect(eventText(long).endsWith("…[truncated]")).toBe(true)
    expect(eventText("a\0b")).toBe(`a${REPLACEMENT}b`)
  })
})

describe("harness mappers", () => {
  test("a Claude Code text block past one event becomes consecutive messages, numbered in order", () => {
    const events = list(mapClaudeCodeEvent({ type: "assistant", message: { content: [{ type: "text", text: long }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a.ts" } }] } }, context()))
    expect(events.map((event) => event.type)).toEqual(["assistant.message", "assistant.message", "tool.started"])
    expect(events.map((event) => event.seq)).toEqual([4, 5, 6])
    expect(texts(events, "assistant.message").join("")).toBe(whole)
    expect(events.every(isAgentEvent)).toBe(true)
  })

  test("a long Claude Code stream delta and a long Codex item split the same way", () => {
    const delta = list(mapClaudeCodeEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: long } } }, context()))
    expect(texts(delta, "assistant.delta").join("")).toBe(whole)
    const codex = list(mapCodexEvent({ type: "item.completed", item: { id: "m1", type: "agent_message", text: long } }, context()))
    expect(texts(codex, "assistant.message").join("")).toBe(whole)
    expect([...delta, ...codex].every(isAgentEvent)).toBe(true)
  })

  test("a long prompt is shown cut, not replaced", () => {
    const started = list(mapCodexEvent({ type: "turn.started", prompt: long }, context()))[0]
    expect(started).toMatchObject({ type: "turn.started" })
    expect((started as { prompt: string }).prompt.startsWith("rrrr")).toBe(true)
    expect(isAgentEvent(started)).toBe(true)
  })
})

describe("tool input copies", () => {
  test("stay inside the event protocol", () => {
    const wide = Array.from({ length: 128 }, () => Array.from({ length: 128 }, () => null))
    const odd = { "": 1, "a\0b": 2, nul: "x\0y", huge: 2 ** 60, ok: true }
    for (const input of [wide, odd]) {
      const bounded = boundToolInput(input)
      expect(isAgentEvent({ version: 1, sessionId: "s", seq: 1, at: 1, type: "tool.started", turnId: "t", callId: "c", name: "tool", input: bounded })).toBe(true)
    }
    expect(boundToolInput(odd)).toEqual({ nul: `x${REPLACEMENT}y`, huge: String(2 ** 60), ok: true })
  })
})

describe("a reply split across messages", () => {
  let seq = 0
  const entry = (payload: Record<string, unknown>): ConversationEntry => {
    seq += 1
    return { kind: "event", seq, at: seq, event: { version: 1, sessionId: "s", seq, at: seq, ...payload } as unknown as AgentEvent }
  }

  test("shows as one conversation item; separate short messages stay apart", () => {
    const builder = new ConversationBuilder({ maxTextBytes: 256 * 1024 })
    const reply = `${"word ".repeat(60_000)}end`
    builder.add(entry({ type: "turn.started", turnId: "t", prompt: "say a lot" }))
    for (const text of eventTextPieces(reply)) builder.add(entry({ type: "assistant.message", turnId: "t", text }))
    builder.add(entry({ type: "assistant.message", turnId: "t", text: "first" }))
    builder.add(entry({ type: "assistant.message", turnId: "t", text: "second" }))
    const assistant = builder.items().flatMap((item) => (item.kind === "assistant" ? [item as { text: string; truncated?: true }] : []))
    expect(assistant).toHaveLength(3)
    // The view holds the reply's opening, as it would for one long message.
    expect(assistant[0]?.truncated).toBe(true)
    expect(assistant[0]?.text.length).toBeGreaterThan(EVENT_TEXT_MAX - 16)
    expect(reply.startsWith(assistant[0]?.text ?? "x")).toBe(true)
    expect(assistant.slice(1).map((item) => item.text)).toEqual(["first", "second"])
  })

  test("reads back to the model as one message", () => {
    let recordSeq = 0
    const record = (kind: string, payload: unknown): TranscriptRecord => ({ version: 1, sessionId: "s", seq: recordSeq, id: `s:${recordSeq++}`, kind, payload, at: 1 }) as TranscriptRecord
    const pieces = eventTextPieces(`${"a".repeat(200_000)}${"b".repeat(200_000)}`)
    const messages = historyFromTranscript([
      record("message.user", { text: "say a lot" }),
      ...pieces.map((text) => record("assistant.message", { type: "assistant.message", turnId: "t", text, at: 1 })),
    ], { maxChars: 1_000_000, maxMessageChars: 1_000_000 })
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(messages[1]?.text).toBe(pieces.join(""))
  })
})

test("a transcript holds any one valid event, however its text escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runrail-long-transcript-"))
  try {
    const store = new FileTranscriptStore({ root })
    // Each control character is six bytes of JSON: the event is past 1.5 MiB once written.
    const event = { version: 1, sessionId: "s", seq: 1, at: 1, type: "assistant.message", turnId: "t", text: "\u0001".repeat(EVENT_TEXT_MAX) }
    expect(isAgentEvent(event)).toBe(true)
    const stored = await store.append("s", { kind: "assistant.message", payload: event })
    expect(stored.kind).toBe("assistant.message")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
