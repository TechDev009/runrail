import { expect, test } from "bun:test"
import { MODEL_HISTORY_HEADER, ModelHistory, createHistoryModelPort, historyFromTranscript } from "../../src/session/history.ts"
import type { TranscriptRecord } from "../../src/transcript/index.ts"

let seq = 0
const record = (kind: string, payload: unknown): TranscriptRecord => ({ version: 1, sessionId: "s", seq, id: `s:${seq++}`, kind, payload, at: 1 }) as TranscriptRecord
const user = (text: string) => record("message.user", { text })
const assistant = (text: string) => record("assistant.message", { type: "assistant.message", turnId: "t", text, at: 1 })
const started = (callId: string, name: string, input: unknown) => record("tool.started", { type: "tool.started", turnId: "t", callId, name, input, at: 1 })
const completed = (callId: string, name: string, ok: boolean, output = "file output") => record("tool.completed", ok
  ? { type: "tool.completed", turnId: "t", callId, name, ok, output, at: 1 }
  : { type: "tool.completed", turnId: "t", callId, name, ok, error: { code: "TOOL_FAILED", message: "exit code 1" }, at: 1 })
const delta = (text: string) => record("assistant.delta", { type: "assistant.delta", turnId: "t", text, at: 1 })

test("history keeps each tool call with its result, and what the model said before the call", () => {
  const messages = historyFromTranscript([
    user("first"),
    user("second"),
    delta("Let me "),
    delta("look."),
    started("c1", "read_file", { path: "src/a.ts" }),
    completed("c1", "read_file", true, "export const a = 1"),
    started("c2", "run_command", { command: "bun test" }),
    completed("c2", "run_command", false),
    // A result whose call was never seen still counts, without a call to replay.
    completed("c9", "search_files", true, "no matches"),
    assistant("done"),
    record("assistant.message", { type: "tool.started" }),
    record("verification.passed", { type: "verification.passed" }),
  ])
  expect(messages.map((message) => message.role)).toEqual(["user", "tool", "tool", "tool", "assistant"])
  expect(messages[0]?.text).toBe(`${MODEL_HISTORY_HEADER}\nfirst\n\nsecond`)
  expect(messages[1]).toEqual({ role: "tool", name: "read_file", text: "export const a = 1", call: { input: { path: "src/a.ts" }, text: "Let me look." } } as never)
  expect(messages[2]).toEqual({ role: "tool", name: "run_command", text: "TOOL_FAILED: exit code 1", call: { input: { command: "bun test" } } } as never)
  expect(messages[3]).toEqual({ role: "tool", name: "search_files", text: "no matches" })
  expect(messages[4]?.text).toBe("done")
})

test("long call arguments and results are clipped, and the bounds count them", () => {
  const big = "x".repeat(10_000)
  const messages = historyFromTranscript([user("go"), started("c1", "write_file", { path: "a.ts", content: big }), completed("c1", "write_file", true, big)])
  const call = (messages[1] as { call?: { input: { content: string } } }).call
  expect(call?.input.content.length).toBeLessThan(4_100)
  expect(messages[1]?.text.length).toBeLessThan(8_100)
  // A call too large for what is left is dropped with everything older than it.
  const bounded = historyFromTranscript([user("old"), started("c1", "write_file", { content: big }), completed("c1", "write_file", true, "ok"), user("new")], { maxChars: 1_000 })
  expect(bounded.map((message) => message.text)).toEqual([`${MODEL_HISTORY_HEADER}\nnew`])
})

test("history keeps the newest turns within its bounds and starts with a user message", () => {
  const records = Array.from({ length: 30 }, (_, index) => index % 2 === 0 ? user(`u${index}`) : assistant(`a${index}`))
  const limited = historyFromTranscript(records, { maxMessages: 4 })
  expect(limited.map((message) => message.text)).toEqual([`${MODEL_HISTORY_HEADER}\nu26`, "a27", "u28", "a29"])
  const oddStart = historyFromTranscript(records, { maxMessages: 3 })
  expect(oddStart.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])
  expect(oddStart[0]?.text).toBe(MODEL_HISTORY_HEADER)
  const clipped = historyFromTranscript([user("x".repeat(100))], { maxMessageChars: 10 })
  expect(clipped[0]?.text).toBe(`${MODEL_HISTORY_HEADER}\n${"x".repeat(10)}\n[...]`)
  expect(historyFromTranscript([user("a".repeat(50)), assistant("b".repeat(50))], { maxChars: 60 }).map((message) => message.role)).toEqual(["user", "assistant"])
  expect(historyFromTranscript([])).toEqual([])
})

test("the history port prepends only for its own session and forwards usage", async () => {
  const history = new ModelHistory()
  const seen: { sessionId: string; messages: readonly { role: string; text: string }[] }[] = []
  const port = createHistoryModelPort({
    complete: (request: { sessionId: string; messages: readonly { role: string; text: string }[] }) => {
      seen.push(request)
      return { type: "text", text: "ok" }
    },
    takeUsage: () => ({ inputTokens: 3 }),
  } as never, history)
  const request = (sessionId: string) => ({ sessionId, cwd: "/", messages: [{ role: "user" as const, text: "now" }], tools: [], signal: new AbortController().signal })
  history.set("a", [{ role: "user", text: "before" }])
  await port.complete(request("a"))
  await port.complete(request("b"))
  expect(seen[0]?.messages.map((message) => message.text)).toEqual(["before", "now"])
  expect(seen[1]?.messages.map((message) => message.text)).toEqual(["now"])
  expect(port.takeUsage()).toEqual({ inputTokens: 3 })
  history.clear()
  expect(history.size).toBe(0)
})

test("many unanswered messages in a row stay one bounded message that keeps the newest", () => {
  const records = Array.from({ length: 20 }, (_, index) => user(`${String(index).padStart(2, "0")}${"x".repeat(7_990)}`))
  const messages = historyFromTranscript([user("earlier"), assistant("answer"), ...records])
  expect(messages.length).toBeGreaterThan(1)
  const last = messages.at(-1)!
  expect(last.role).toBe("user")
  expect(last.text.length).toBeLessThanOrEqual(8_000 + 16)
  expect(last.text).toContain(`19${"x".repeat(100)}`)
  expect(messages.map((message) => message.text).join("")).toContain("answer")
})
