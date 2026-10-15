import { expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { ConversationBuilder, boundConversationItems, transcriptEntry, type ConversationEntry } from "../../src/conversation/index.ts"

let seq = 0
function event(payload: Record<string, unknown>): ConversationEntry {
  seq += 1
  return { kind: "event", seq, at: 1_000 + seq, event: { version: 1, sessionId: "s1", seq, at: 1_000 + seq, ...payload } as unknown as AgentEvent }
}

test("builds user, assistant, tool, approval, and notice items in order", () => {
  const builder = new ConversationBuilder()
  builder.add({ kind: "message.user", seq: 0, at: 1, payload: { text: "fix the bug", attachments: [{ kind: "image" }] } })
  builder.add(event({ type: "turn.started", turnId: "t1", prompt: "fix the bug" }))
  builder.add(event({ type: "assistant.delta", turnId: "t1", text: "Looking " }))
  builder.add(event({ type: "assistant.delta", turnId: "t1", text: "now." }))
  builder.add(event({ type: "tool.started", turnId: "t1", callId: "c1", name: "bash", input: { command: "bun test" } }))
  builder.add(event({ type: "tool.delta", turnId: "t1", callId: "c1", text: "1 pass\n" }))
  builder.add(event({ type: "tool.completed", turnId: "t1", callId: "c1", name: "bash", ok: true, output: { stdout: "1 pass", stderr: "" } }))
  builder.add(event({ type: "tool.started", turnId: "t1", callId: "c2", name: "read", input: { path: "src/a.ts" } }))
  builder.add(event({ type: "tool.completed", turnId: "t1", callId: "c2", name: "read", ok: false, error: { code: "NOT_FOUND", message: "secret detail" }, output: "file body" }))
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p1", action: "write src/a.ts", capability: "fs.write" }))
  builder.add(event({ type: "approval.resolved", approvalId: "p1", approved: false }))
  builder.add(event({ type: "assistant.message", turnId: "t1", text: "Done." }))
  builder.add(event({ type: "verification.completed", name: "check", ok: true }))
  builder.add(event({ type: "session.completed", snapshot: {} }))

  const items = builder.items()
  expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "tool", "approval", "assistant", "notice"])
  expect(items[0]).toMatchObject({ kind: "user", text: "fix the bug", attachments: 1 })
  expect(items[1]).toMatchObject({ kind: "assistant", text: "Looking now.", partial: true, turnId: "t1" })
  expect(items[2]).toMatchObject({ kind: "tool", status: "ok", output: "1 pass", presentation: { kind: "shell", command: "bun test" } })
  expect(items[3]).toMatchObject({ kind: "tool", status: "failed", errorCode: "NOT_FOUND" })
  // Non-shell output and error messages are not carried.
  expect(items[3]).not.toHaveProperty("output")
  expect(JSON.stringify(items)).not.toContain("secret detail")
  expect(items[4]).toMatchObject({ kind: "approval", status: "rejected", capability: "fs.write" })
  expect(items[5]).toMatchObject({ kind: "assistant", text: "Done.", partial: false })
  expect(items[6]).toMatchObject({ kind: "notice", code: "verification.passed", name: "check" })
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
  expect(builder.lastSequence).toBe(seq)
  expect(Object.isFrozen(items[0])).toBe(true)
})

test("uses the turn prompt when no user record precedes the turn and closes on failure", () => {
  const builder = new ConversationBuilder()
  builder.add(event({ type: "turn.started", turnId: "t2", prompt: "from prompt" }))
  builder.add(event({ type: "assistant.delta", turnId: "t2", text: "partial" }))
  builder.add(event({ type: "tool.started", turnId: "t2", callId: "c9", name: "bash", input: { command: "sleep 9" } }))
  builder.add(event({ type: "session.failed", error: { code: "MODEL_TIMEOUT", message: "raw provider text" }, recoverable: true }))
  builder.add(event({ type: "session.stopped" }))
  const items = builder.items()
  expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "notice", "notice"])
  expect(items[0]).toMatchObject({ text: "from prompt", turnId: "t2" })
  expect(items[1]).toMatchObject({ partial: true })
  expect(items[2]).toMatchObject({ status: "failed" })
  expect(items[3]).toMatchObject({ level: "error", code: "MODEL_TIMEOUT" })
  expect(JSON.stringify(items)).not.toContain("raw provider text")
  expect(items[4]).toMatchObject({ level: "info", code: "stopped" })
})

test("bounds item count, text size, output tail, and encoded bytes", () => {
  const builder = new ConversationBuilder({ maxItems: 3, maxTextBytes: 1_024 })
  for (let index = 0; index < 5; index += 1) builder.add(event({ type: "turn.started", turnId: `t${String(index)}`, prompt: `prompt ${String(index)}` }))
  expect(builder.truncated).toBe(true)
  expect(builder.items().map((item) => (item as { text: string }).text)).toEqual(["prompt 2", "prompt 3", "prompt 4"])
  expect(builder.items(1)).toHaveLength(1)

  const long = new ConversationBuilder({ maxTextBytes: 1_024 })
  long.add({ kind: "message.user", seq: 1, at: 1, payload: "é".repeat(2_000) })
  long.add(event({ type: "tool.started", turnId: "t", callId: "c", name: "bash", input: { command: "yes" } }))
  long.add(event({ type: "tool.delta", turnId: "t", callId: "c", text: "x".repeat(20_000) }))
  const [user, tool] = long.items()
  expect(user).toMatchObject({ truncated: true })
  expect(Buffer.byteLength((user as { text: string }).text, "utf8")).toBeLessThanOrEqual(1_024)
  expect(Buffer.byteLength((tool as { output: string }).output, "utf8")).toBeLessThanOrEqual(8 * 1024)

  const bounded = boundConversationItems(long.items(), 2_048)
  expect(bounded.truncated).toBe(true)
  expect(bounded.items.length).toBeLessThan(2)
  expect(() => boundConversationItems([], 0)).toThrow(RangeError)
})

test("rejects invalid options and ignores malformed transcript records", () => {
  expect(() => new ConversationBuilder({ maxItems: 0 })).toThrow(RangeError)
  expect(() => new ConversationBuilder({ maxItems: 5_000 })).toThrow(RangeError)
  expect(() => new ConversationBuilder({ maxTextBytes: 10 })).toThrow(RangeError)
  expect(transcriptEntry({ kind: "assistant.delta", seq: 1, at: 1, payload: { type: "assistant.delta", turnId: 3 } })).toBeUndefined()
  expect(transcriptEntry({ kind: "assistant.delta", seq: 1, at: 1, payload: { type: "tool.started" } })).toBeUndefined()
  expect(transcriptEntry({ kind: "custom.note", seq: 1, at: 1, payload: [] })).toBeUndefined()
  expect(transcriptEntry({ kind: "message.user", seq: 4, at: 9, payload: "hi" })).toEqual({ kind: "message.user", seq: 4, at: 9, payload: "hi" })
  const entry = transcriptEntry({ kind: "assistant.message", seq: 7, at: 9, payload: { type: "assistant.message", turnId: "t", text: "ok", seq: 3, at: 5 } })
  expect(entry).toMatchObject({ kind: "event", seq: 3, at: 5 })
  // A recorded live frame sits after the event it followed, not at its own record number.
  const review = { type: "approval.reviewed", reviewId: "codex-r1", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec" }
  expect(transcriptEntry({ kind: "approval.reviewed", seq: 12, at: 9, payload: { ...review, afterSeq: 4 } })).toMatchObject({ kind: "event", seq: 4, at: 9 })
  expect(transcriptEntry({ kind: "approval.reviewed", seq: 12, at: 9, payload: { ...review, afterSeq: -1 } })).toMatchObject({ kind: "event", seq: 12 })

  const builder = new ConversationBuilder()
  builder.add({ kind: "message.user", seq: 1, at: 1, payload: { nope: true } })
  builder.add({ kind: "message.user", seq: 2, at: 1, payload: "" })
  builder.add(event({ type: "approval.resolved", approvalId: "missing", approved: true }))
  builder.add(event({ type: "tool.completed", turnId: "t", callId: "orphan", name: "bash", ok: true, output: "done" }))
  expect(builder.items()).toHaveLength(1)
  expect(builder.items()[0]).toMatchObject({ kind: "tool", status: "ok", output: "done" })
})

test("carries the line counts a file write reported, and nothing out of range", () => {
  const builder = new ConversationBuilder()
  builder.add(event({ type: "tool.started", turnId: "t", callId: "w1", name: "write_file", input: { path: "a.txt", content: "a\nB\n" } }))
  builder.add(event({ type: "tool.completed", turnId: "t", callId: "w1", name: "write_file", ok: true, output: { path: "a.txt", bytes: 4, created: false, additions: 1, deletions: 1 } }))
  builder.add(event({ type: "tool.started", turnId: "t", callId: "w2", name: "write_file", input: { path: "b.txt", content: "b\n" } }))
  builder.add(event({ type: "tool.completed", turnId: "t", callId: "w2", name: "write_file", ok: true, output: { path: "b.txt", bytes: 2, additions: -1, deletions: 0 } }))
  builder.add(event({ type: "tool.started", turnId: "t", callId: "w3", name: "write_file", input: { path: "c.txt", content: "c\n" } }))
  builder.add(event({ type: "tool.completed", turnId: "t", callId: "w3", name: "write_file", ok: true, output: { path: "c.txt", bytes: 2, created: true, additions: 1.5, deletions: 0 } }))
  // The native loop's form: the result as JSON text.
  builder.add(event({ type: "tool.started", turnId: "t", callId: "w4", name: "write_file", input: { path: "d.txt", content: "d\n" } }))
  builder.add(event({ type: "tool.completed", turnId: "t", callId: "w4", name: "write_file", ok: true, output: JSON.stringify({ path: "d.txt", bytes: 2, created: false, additions: 2, deletions: 3 }) }))
  const [first, second, third, fourth] = builder.items()
  expect(first).toMatchObject({ additions: 1, deletions: 1, created: false })
  expect(fourth).toMatchObject({ additions: 2, deletions: 3, created: false })
  // The file body the tool wrote is not carried.
  expect(first).not.toHaveProperty("output")
  for (const item of [second, third]) {
    expect(item).not.toHaveProperty("additions")
    expect(item).not.toHaveProperty("created")
  }
})

test("names a coding tool's files relative to the workspace it was given", () => {
  const builder = new ConversationBuilder({ root: "/work/app" })
  builder.add(event({ type: "tool.started", turnId: "t", callId: "p1", name: "file_change", input: { type: "fileChange", changes: [{ path: "/work/app/n.txt", kind: { type: "add" }, diff: "hi\n" }] } }))
  expect(builder.items()[0]).toMatchObject({ presentation: { paths: ["n.txt"], additions: 1, deletions: 0, title: "Patch n.txt" } })
})

test("shows a coding tool's own review as one row its decision updates, and its notices with its words", () => {
  const builder = new ConversationBuilder()
  builder.add(event({ type: "turn.started", turnId: "t1", prompt: "fetch it" }))
  builder.add(event({ type: "reviewer.notice", turnId: "t1", reviewer: "codex", notice: "unavailable" }))
  builder.add(event({ type: "approval.reviewed", turnId: "t1", reviewId: "codex-r1", reviewer: "codex", decision: "reviewing", action: "command", capability: "process.exec", detail: "curl https://example.com" }))
  builder.add(event({ type: "reviewer.notice", turnId: "t1", reviewer: "codex", notice: "warning", message: "Auto-review\nis checking" }))
  builder.add(event({ type: "approval.reviewed", turnId: "t1", reviewId: "codex-r1", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec", risk: "low", rationale: "Reads a public page." }))
  // A late start never takes back a decision.
  builder.add(event({ type: "approval.reviewed", turnId: "t1", reviewId: "codex-r1", reviewer: "codex", decision: "reviewing", action: "command", capability: "process.exec" }))
  builder.add(event({ type: "approval.reviewed", turnId: "t1", reviewId: "claude-denied-toolu_1", reviewer: "claude-code", decision: "denied", action: "command", capability: "process.exec", source: "reviewer", detail: "git push --force" }))
  builder.add(event({ type: "approval.reviewed", turnId: "t1", reviewId: "bad id!", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec" }))
  builder.add(event({ type: "approval.reviewed", turnId: "t1", reviewId: "codex-r2", reviewer: "someone", decision: "approved", action: "command", capability: "process.exec" }))
  builder.add(event({ type: "approval.reviewed", turnId: "t1", reviewId: "codex-r3", reviewer: "codex", decision: "maybe", action: "command", capability: "process.exec" }))
  builder.add(event({ type: "reviewer.notice", turnId: "t1", reviewer: "codex", notice: "shouting" }))

  const items = builder.items()
  expect(items.map((item) => item.kind)).toEqual(["user", "notice", "review", "notice", "review"])
  expect(items[1]).toMatchObject({ kind: "notice", turnId: "t1", level: "info", code: "reviewer.unavailable", name: "codex" })
  expect(items[1]).not.toHaveProperty("message")
  expect(items[2]).toEqual({ kind: "review", id: items[2]!.id, seq: items[2]!.seq, at: items[2]!.at, turnId: "t1", reviewId: "codex-r1", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec", risk: "low", detail: "curl https://example.com", rationale: "Reads a public page." })
  expect(items[3]).toMatchObject({ kind: "notice", code: "reviewer.warning", name: "codex", message: "Auto-review is checking" })
  expect(items[4]).toMatchObject({ kind: "review", reviewer: "claude-code", decision: "denied", source: "reviewer", detail: "git push --force" })
})

test("shows a coding tool's retries of one request as one row that counts up", () => {
  const builder = new ConversationBuilder()
  builder.add(event({ type: "turn.started", turnId: "t1", prompt: "go" }))
  builder.add(event({ type: "api.retry", turnId: "t1", source: "claude-code", attempt: 1, maxRetries: 10, delayMs: 500, status: 529, error: "overloaded" }))
  builder.add(event({ type: "api.retry", turnId: "t1", source: "claude-code", attempt: 2, maxRetries: 10, delayMs: 1_100, status: 529, error: "overloaded" }))
  builder.add(event({ type: "api.retry", turnId: "t1", source: "claude-code", attempt: 3, maxRetries: 10, delayMs: 2_300, error: "unknown" }))
  builder.add(event({ type: "assistant.message", turnId: "t1", text: "done" }))
  // Another request's retries start their own row.
  builder.add(event({ type: "api.retry", turnId: "t1", source: "claude-code", attempt: 1, maxRetries: 1, delayMs: 0, waitedMs: 30_000 }))
  builder.add(event({ type: "api.retry", turnId: "t1", source: "codex", attempt: 2, maxRetries: 1, delayMs: 0 }))

  const notices = builder.items().filter((item) => item.kind === "notice")
  expect(notices).toEqual([
    expect.objectContaining({ turnId: "t1", level: "info", code: "api.retry", name: "claude-code", retry: { attempt: 3, maxRetries: 10, delayMs: 2_300, error: "unknown" } }),
    expect.objectContaining({ turnId: "t1", code: "api.retry", retry: { attempt: 1, maxRetries: 1, delayMs: 0, waitedMs: 30_000 } }),
  ])
  expect(builder.items().map((item) => item.kind)).toEqual(["user", "notice", "assistant", "notice"])
  expect(transcriptEntry({ kind: "api.retry", seq: 9, at: 5, payload: { type: "api.retry", turnId: "t1", source: "claude-code", attempt: 1, maxRetries: 10, delayMs: 500, afterSeq: 3 } })).toMatchObject({ kind: "event", seq: 3 })
})

test("shows a request Runrail refused for the person as a notice in Runrail's words", () => {
  const builder = new ConversationBuilder()
  builder.add(event({ type: "turn.started", turnId: "t1", prompt: "go" }))
  builder.add(event({ type: "request.refused", turnId: "t1", source: "codex", message: "Runrail refused a Codex request to run a command:\nit belongs to a Codex turn that has already ended." }))
  builder.add(event({ type: "request.refused", source: "codex", message: "Runrail refused a Codex request: no turn was running, so no one could answer it." }))
  builder.add(event({ type: "request.refused", turnId: "t1", source: "gemini", message: "not shown" }))
  builder.add(event({ type: "request.refused", turnId: "t1", source: "codex", message: " " }))

  const notices = builder.items().filter((item) => item.kind === "notice")
  expect(notices).toEqual([
    expect.objectContaining({ turnId: "t1", level: "info", code: "request.refused", name: "codex", message: "Runrail refused a Codex request to run a command: it belongs to a Codex turn that has already ended." }),
    expect.objectContaining({ level: "info", code: "request.refused", name: "codex", message: "Runrail refused a Codex request: no turn was running, so no one could answer it." }),
  ])
  expect(notices[1]).not.toHaveProperty("turnId")
})

test("a review still open when its turn ends reads as aborted, and survives a transcript round trip", () => {
  const builder = new ConversationBuilder()
  const record = (payload: Record<string, unknown>, at: number) => transcriptEntry({ kind: String(payload.type), seq: at, at, payload: { version: 1, sessionId: "s1", seq: at, at, ...payload } })
  for (const entry of [
    record({ type: "turn.started", turnId: "t1", prompt: "go" }, 1),
    record({ type: "approval.reviewed", turnId: "t1", reviewId: "codex-r1", reviewer: "codex", decision: "reviewing", action: "file_change", capability: "filesystem.write", detail: "a.ts" }, 2),
    record({ type: "session.failed", error: { code: "COMMAND_AGENT_EXITED" } }, 3),
  ]) if (entry !== undefined) builder.add(entry)
  expect(builder.items().filter((item) => item.kind === "review")).toMatchObject([{ reviewId: "codex-r1", decision: "aborted", detail: "a.ts" }])
})

test("a question keeps what was asked and the answers given, for a reloaded thread to show", () => {
  const builder = new ConversationBuilder()
  const questions = [
    { id: "q1", question: "Which library?", header: "Library", options: [{ label: "Luxon", description: "Zones" }, { label: "date-fns" }], other: true },
    { id: "token", question: "Paste the token", options: [], other: true, secret: true },
  ]
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p1", action: "question", capability: "user.input", reason: "Which library? (and 1 more)", questions }))
  builder.add(event({ type: "approval.resolved", approvalId: "p1", approved: true, answers: { q1: ["Luxon"] } }))
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p2", action: "question", capability: "user.input", questions: [{ id: "bad id!", question: "?", options: [] }] }))
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p3", action: "question", capability: "user.input", questions: [questions[1]] }))
  builder.add(event({ type: "approval.resolved", approvalId: "p3", approved: true, answers: {} }))
  const [answered, malformed, secretOnly] = builder.items()
  // Only a secret was answered: the answer is not kept, but that it was answered is.
  expect(secretOnly).toMatchObject({ status: "approved", answers: {} })
  expect(answered).toMatchObject({ kind: "approval", status: "approved", questions, answers: { q1: ["Luxon"] } })
  expect(malformed).toMatchObject({ kind: "approval", status: "pending" })
  expect(malformed).not.toHaveProperty("questions")
})

test("a request for more questions is kept with the answers so far and the note", () => {
  const builder = new ConversationBuilder()
  const questions = [{ id: "q1", question: "Which layout?", options: [{ label: "Grid" }, { label: "Stack" }], other: true }]
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p1", action: "question", capability: "user.input", questions, takesFollowUp: true }))
  expect(builder.items()[0]).toMatchObject({ status: "pending", takesFollowUp: true })
  builder.add(event({ type: "approval.resolved", approvalId: "p1", approved: true, answers: { q1: ["Grid"] }, followUp: true, note: "Ask about colours too" }))
  expect(builder.items()[0]).toMatchObject({ status: "approved", answers: { q1: ["Grid"] }, followUp: true, note: "Ask about colours too" })
  // Only a question set carries the offer.
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p2", action: "command", capability: "process.exec", takesFollowUp: true }))
  expect(builder.items()[1]).not.toHaveProperty("takesFollowUp")
})

test("an approval the coding tool took back reads as withdrawn, not denied", () => {
  const builder = new ConversationBuilder()
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p1", action: "command", capability: "process.exec" }))
  builder.add(event({ type: "approval.resolved", approvalId: "p1", approved: false, withdrawn: true, reason: "Claude Code withdrew the request" }))
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p2", action: "command", capability: "process.exec" }))
  builder.add(event({ type: "approval.resolved", approvalId: "p2", approved: false }))
  builder.add(event({ type: "approval.required", turnId: "t1", approvalId: "p3", action: "Sign in to GitHub", capability: "user.input" }))
  builder.add(event({ type: "approval.resolved", approvalId: "p3", approved: false, reason: "It asks you to open a web page, which Runrail cannot show yet" }))
  const [withdrawn, denied, declined] = builder.items()
  expect(withdrawn).toMatchObject({ status: "rejected", withdrawn: true })
  expect(withdrawn).not.toHaveProperty("denial")
  expect(denied).toMatchObject({ status: "rejected" })
  expect(denied).not.toHaveProperty("withdrawn")
  expect(denied).not.toHaveProperty("denial")
  expect(declined).toMatchObject({ status: "rejected", denial: "It asks you to open a web page, which Runrail cannot show yet" })
})

test("a message takes its turn's id, from the turn start or, when a tool reports none, its first reply; a rewind shows where it cut", () => {
  const builder = new ConversationBuilder()
  builder.add({ kind: "message.user", seq: 100, at: 1, payload: { text: "first" } })
  builder.add(event({ type: "turn.started", turnId: "t1", prompt: "first" }))
  builder.add(event({ type: "assistant.message", turnId: "t1", text: "one" }))
  builder.add({ kind: "message.user", seq: 101, at: 2, payload: { text: "second" } })
  builder.add(event({ type: "assistant.message", turnId: "t2", text: "two" }))
  builder.add({ kind: "message.user", seq: 102, at: 3, payload: { text: "steer", steer: true } })
  builder.add(event({ type: "assistant.message", turnId: "t2", text: "more" }))
  builder.add(transcriptEntry({ kind: "session.rewound", seq: 103, at: 4, payload: { type: "session.rewound", removed: 3 } })!)
  const items = builder.items()
  expect(items.filter((item) => item.kind === "user").map((item) => [item.text, item.turnId])).toEqual([["first", "t1"], ["second", "t2"], ["steer", undefined]])
  expect(items.at(-1)).toMatchObject({ kind: "notice", code: "session.rewound" })
})
