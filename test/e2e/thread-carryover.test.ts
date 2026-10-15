import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ConversationBuilder, transcriptEntry } from "../../src/conversation/index.ts"
import { carryoverText, continueTranscript } from "../../src/session/carryover.ts"
import { createRunrailSession } from "../../src/session.ts"
import { FileTranscriptStore, type TranscriptRecord } from "../../src/transcript/index.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
const harness = resolve(import.meta.dir, "../fixtures/prompt-capture-harness.ts")
const cleanup: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const checked = { loadExtensions: false, verify: "check" as const, verificationCommand: verifier, maxRepairAttempts: 0 }

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Run the turn to its end.
  }
}

test("a thread continued on a coding tool shows the earlier conversation and sends the tool a recap once", async () => {
  const cwd = await realpath(await mkdtemp(join("/tmp", "runrail-carry-")))
  const transcripts = await mkdtemp(join("/tmp", "runrail-carry-transcripts-"))
  const capture = join(cwd, "prompts.log")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(transcripts, { recursive: true, force: true }))
  const store = new FileTranscriptStore({ root: transcripts })

  // The thread so far, on a connected model.
  const parent = await createRunrailSession({ ...checked, cwd, backend: "native", sessionId: "parent-thread", transcriptStore: store, defaultSystemPrompt: false, model: { complete: () => ({ type: "text", text: "use a map, keyed by id" }) } })
  cleanup.push(() => parent.close())
  await drain(parent.prompt("how should I index the users?"))
  expect(await parent.branchTranscript("child-thread")).toBe("child-thread")

  // The same thread continued on Claude Code.
  const open = () => createRunrailSession({ ...checked, cwd, backend: "claude-code", sessionId: "child-thread", transcriptStore: store, harnessCommand: "bun", harnessArgs: ["run", harness, capture] })
  const child = await open()
  cleanup.push(() => child.close())
  await drain(child.prompt("now add a lookup by email"))
  await drain(child.prompt("and tests"))
  const sent = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string)
  expect(sent).toHaveLength(2)
  expect(sent[0]).toContain("User: how should I index the users?")
  expect(sent[0]).toContain("Assistant: use a map, keyed by id")
  expect(sent[0]).toContain("now add a lookup by email")
  // The tool holds the recap from then on.
  expect(sent[1]).not.toContain("how should I index the users?")

  // The thread reads as one conversation, with a marker where it moved; the recap is not a message.
  const builder = new ConversationBuilder()
  for (const record of await store.read("child-thread")) {
    const entry = transcriptEntry(record)
    if (entry !== undefined) builder.add(entry)
  }
  const items = builder.items().filter((item) => item.kind !== "notice" || item.code === "session.continued")
  expect(items.map((item) => item.kind === "user" ? `user:${item.text}` : item.kind === "notice" ? `notice:${item.code}` : item.kind)).toEqual([
    "user:how should I index the users?",
    "assistant",
    "notice:session.continued",
    "user:now add a lookup by email",
    "assistant",
    "user:and tests",
    "assistant",
  ])

  // An engine restart after the first turn does not send the recap again.
  await child.close()
  const again = await open()
  cleanup.push(() => again.close())
  await drain(again.prompt("one more"))
  const last = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string).at(-1)
  expect(last).not.toContain("how should I index the users?")
})

test("the recap keeps the newest messages within its limit and needs a marker", () => {
  const record = (seq: number, kind: string, payload: unknown): TranscriptRecord => ({ version: 1, sessionId: "s", seq, id: `s:${String(seq)}`, kind, payload, at: seq })
  const user = (seq: number, text: string) => record(seq, "message.user", { text })
  const records = Array.from({ length: 40 }, (_, index) => user(index, `message ${String(index)} ${"x".repeat(2_000)}`))
  expect(carryoverText(records)).toBeUndefined()
  const recap = carryoverText([...records, record(40, "session.continued", { type: "session.continued" })])!
  expect(Buffer.byteLength(recap, "utf8")).toBeLessThan(33 * 1024)
  expect(recap).toContain("message 39")
  expect(recap).not.toContain("message 0 ")
  expect(recap).toContain("(Earlier messages left out.)")
  // A turn after the marker: the route already has it.
  expect(carryoverText([...records, record(40, "session.continued", { type: "session.continued" }), record(41, "turn.started", { type: "turn.started", turnId: "t", prompt: "x", version: 1, sessionId: "s", seq: 41, at: 41 })])).toBeUndefined()
})

test("after a rewind the recap says the thread was taken back, and holds only what is left", () => {
  const record = (seq: number, kind: string, payload: unknown): TranscriptRecord => ({ version: 1, sessionId: "s", seq, id: `s:${String(seq)}`, kind, payload, at: seq })
  const recap = carryoverText([record(0, "message.user", { text: "plan the index" }), record(1, "session.rewound", { type: "session.rewound", removed: 4 })])!
  expect(recap).toContain("the user took the thread back to here")
  expect(recap).toContain("User: plan the index")
})

test("a thread continued on another connected model gives that model the earlier messages, with no recap", async () => {
  const cwd = await realpath(await mkdtemp(join("/tmp", "runrail-carry-native-")))
  const transcripts = await mkdtemp(join("/tmp", "runrail-carry-native-transcripts-"))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(transcripts, { recursive: true, force: true }))
  const store = new FileTranscriptStore({ root: transcripts })
  const parent = await createRunrailSession({ ...checked, cwd, backend: "native", sessionId: "parent-native", transcriptStore: store, defaultSystemPrompt: false, model: { complete: () => ({ type: "text", text: "use a map, keyed by id" }) } })
  cleanup.push(() => parent.close())
  await drain(parent.prompt("how should I index the users?"))
  await parent.branchTranscript("child-native")

  const seen: string[][] = []
  const child = await createRunrailSession({ ...checked, cwd, backend: "native", sessionId: "child-native", transcriptStore: store, defaultSystemPrompt: false, model: { complete: (request) => { seen.push(request.messages.map((message) => `${message.role}:${message.text}`)); return { type: "text", text: "ok" } } } })
  cleanup.push(() => child.close())
  await drain(child.prompt("now add a lookup by email"))
  // Restored history arrives as messages (the first labelled as earlier), not as a recap in the prompt.
  expect(seen[0]).toEqual(["user:[Earlier conversation in this thread]\nhow should I index the users?", "assistant:use a map, keyed by id", "user:now add a lookup by email"])
})

test("a thread kept in another store is copied in once, marked where it continued", async () => {
  const parentRoot = await mkdtemp(join("/tmp", "runrail-carry-parent-"))
  const childRoot = await mkdtemp(join("/tmp", "runrail-carry-child-"))
  cleanup.push(() => rm(parentRoot, { recursive: true, force: true }), () => rm(childRoot, { recursive: true, force: true }))
  const parent = new FileTranscriptStore({ root: parentRoot })
  const child = new FileTranscriptStore({ root: childRoot })
  await parent.append("parent", { kind: "message.user", payload: { text: "first" } })
  await parent.append("parent", { kind: "metrics.totals", payload: { sessionId: "parent", runs: 1 } })

  expect(await continueTranscript(parent, "missing", child, "child")).toBe(false)
  expect(await continueTranscript(parent, "parent", child, "child")).toBe(true)
  expect((await child.read("child")).map((record) => record.kind)).toEqual(["message.user", "metrics.totals", "session.continued"])
  // A restarted engine finds the thread started and copies nothing.
  expect(await continueTranscript(parent, "parent", child, "child")).toBe(false)
  expect(await child.read("child")).toHaveLength(3)
  expect(await continueTranscript(parent, "parent", parent, "parent")).toBe(false)
})
