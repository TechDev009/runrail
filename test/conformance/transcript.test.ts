import { expect, test } from "bun:test"
import { appendFile, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSession } from "../../src/session.ts"
import {
  FileTranscriptStore,
  TranscriptStoreError,
  parseTranscriptBundle,
} from "../../src/transcript/index.ts"

test("the caller-owned transcript store appends, branches, compacts, exports, imports, and replays", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-transcript-"))
  try {
    const store = new FileTranscriptStore({ root: join(root, "store") })
    await store.append("session", { kind: "message.user", payload: { text: "secret prompt" } })
    await store.append("session", { kind: "message.assistant", payload: { text: "secret answer" } })
    // A conversation is private: only its owner can read the folder or the files.
    expect((await stat(join(root, "store"))).mode & 0o777).toBe(0o700)
    for (const name of await readdir(join(root, "store"))) expect((await stat(join(root, "store", name))).mode & 0o777).toBe(0o600)

    const records = await store.read("session")
    expect(records.map((record) => record.kind)).toEqual(["message.user", "message.assistant"])
    expect(records[0]?.payload).toEqual({ text: "secret prompt" })

    const exported = await store.export("session")
    expect(exported).toContain("secret prompt")
    expect(parseTranscriptBundle(exported).records).toHaveLength(2)

    const replayed: string[] = []
    await store.replay("session", (record) => { replayed.push(record.kind) })
    expect(replayed).toEqual(["message.user", "message.assistant"])

    await expect(store.branch("session", "branch")).resolves.toBe("branch")
    expect((await store.read("branch")).map((record) => record.sessionId)).toEqual(["branch", "branch"])

    await store.compact("session", {
      throughSeq: 0,
      replacement: { kind: "message.summary", payload: { text: "summary" } },
    })
    expect((await store.read("session")).map((record) => record.kind)).toEqual(["message.summary", "message.assistant"])

    await expect(store.import(exported, "imported")).resolves.toMatchObject({ sessionId: "imported", imported: 2 })
    await expect(store.import(exported, "imported")).resolves.toMatchObject({ sessionId: "imported", imported: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("transcript migration and trust boundaries fail closed", async () => {
  expect(() => parseTranscriptBundle(JSON.stringify({ version: 9, sessionId: "session", records: [] }))).toThrow("TRANSCRIPT_MIGRATION_UNSUPPORTED")
  expect(() => parseTranscriptBundle(JSON.stringify({ version: 1, sessionId: "session", records: [{ version: 1, sessionId: "session", seq: 0, id: "session:0", kind: "message.user", payload: {}, unknown: true }] }))).toThrow("TRANSCRIPT_INVALID")

  const root = await mkdtemp(join("/tmp", "runrail-transcript-invalid-"))
  try {
    const store = new FileTranscriptStore({ root })
    await expect(store.append("../escape", { kind: "message.user", payload: {} })).rejects.toBeInstanceOf(TranscriptStoreError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("transcript recovery survives a restart after a truncated final append", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-transcript-recovery-"))
  try {
    const store = new FileTranscriptStore({ root })
    await store.append("session", { kind: "message.user", payload: { text: "complete" } })
    await appendFile(join(root, "session.jsonl"), '{"version":1,"sessionId":"session","seq":1,"id":"session:1","kind":"message.assistant","payload":{"text":"truncated', "utf8")

    const restarted = new FileTranscriptStore({ root })
    await expect(restarted.read("session")).rejects.toMatchObject({ code: "TRANSCRIPT_INVALID" })
    await expect(restarted.recover("session")).resolves.toMatchObject({ sessionId: "session", retainedRecords: 1 })
    expect((await restarted.read("session")).map((record) => record.kind)).toEqual(["message.user"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("transcript recovery refuses a complete but corrupt final record", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-transcript-recovery-corrupt-"))
  try {
    const store = new FileTranscriptStore({ root })
    await store.append("session", { kind: "message.user", payload: { text: "complete" } })
    await appendFile(join(root, "session.jsonl"), JSON.stringify({ version: 1, sessionId: "session", seq: 99, id: "session:99", kind: "message.assistant", payload: { text: "complete but corrupt" }, at: 1 }), "utf8")

    const restarted = new FileTranscriptStore({ root })
    await expect(restarted.recover("session")).rejects.toMatchObject({ code: "TRANSCRIPT_INVALID" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("session startup recovers a truncated caller-owned transcript before resuming", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-transcript-session-recovery-cwd-"))
  const root = await mkdtemp(join("/tmp", "runrail-transcript-session-recovery-store-"))
  try {
    const transcript = new FileTranscriptStore({ root })
    await transcript.append("restart-session", { kind: "message.user", payload: { text: "complete" } })
    await appendFile(join(root, "restart-session.jsonl"), '{"version":1,"sessionId":"restart-session","seq":1,"id":"restart-session:1","kind":"assistant.message","payload":{"text":"truncated', "utf8")

    const session = await createRunrailSession({
      cwd,
      backend: "native",
      sessionId: "restart-session",
      loadExtensions: false,
      transcriptStore: transcript,
      model: { complete: () => ({ type: "text", text: "resumed" }) },
    })
    try {
      expect((await transcript.read("restart-session")).map((record) => record.kind)).toEqual(["message.user"])
    } finally {
      await session.stop("recovery test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("a session writes payloads only when the caller opts into transcript storage", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-session-transcript-"))
  const root = await mkdtemp(join("/tmp", "runrail-session-transcript-store-"))
  try {
    const transcript = new FileTranscriptStore({ root })
    const session = await createRunrailSession({
      cwd,
      backend: "native",
      loadExtensions: false,
      transcriptStore: transcript,
      model: { complete: () => ({ type: "text", text: "transcript answer" }) },
    })
    try {
      for await (const _event of session.prompt("transcript prompt")) {
        // Consume the stream to commit every event to the caller-owned store.
      }
      const records = await transcript.read(session.snapshot.id)
      expect(records.some((record) => record.kind === "message.user")).toBe(true)
      expect(records.some((record) => record.kind === "assistant.message")).toBe(true)
      await expect(session.recoverTranscript()).resolves.toMatchObject({ sessionId: session.snapshot.id, retainedRecords: records.length, discardedBytes: 0 })
      expect(await session.exportTranscript()).toContain("transcript prompt")
    } finally {
      await session.stop("transcript test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("two branches between the same sessions in opposite directions both finish", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-transcript-cross-branch-"))
  try {
    const store = new FileTranscriptStore({ root })
    await store.append("left", { kind: "message.user", payload: { text: "left" } })
    await store.append("right", { kind: "message.user", payload: { text: "right" } })
    const settled = await Promise.race([
      Promise.allSettled([store.branch("left", "right"), store.branch("right", "left")]),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 2_000)),
    ])
    expect(settled).not.toBe("stuck")
    expect((settled as PromiseSettledResult<string>[]).map((result) => result.status)).toEqual(["rejected", "rejected"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a turn that fills the transcript stops with the transcript's limit, and the model is not asked again", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-session-transcript-full-"))
  const root = await mkdtemp(join("/tmp", "runrail-session-transcript-full-store-"))
  let calls = 0
  try {
    const session = await createRunrailSession({
      cwd,
      backend: "native",
      loadExtensions: false,
      transcriptStore: new FileTranscriptStore({ root, maxRecords: 6 }),
      model: { complete: () => { calls += 1; return calls < 50 ? { type: "tool", name: "list_files", input: { path: "." } } : { type: "text", text: "done" } } },
    })
    try {
      const run = (async () => { for await (const _event of session.prompt("keep listing")) void _event })()
      await expect(run).rejects.toMatchObject({ code: "TRANSCRIPT_LIMIT" })
      const asked = calls
      await Bun.sleep(50)
      expect(calls).toBe(asked)
      expect(calls).toBeLessThan(50)
    } finally {
      await session.stop("transcript test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("a rewind cuts the transcript before a record, found by id after a compaction renumbered it", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-transcript-truncate-"))
  try {
    const store = new FileTranscriptStore({ root })
    for (const text of ["one", "two", "three"]) await store.append("session", { kind: "message.user", payload: { text } })
    const three = (await store.read("session")).at(-1)!
    await store.compact("session", { throughSeq: 0, replacement: { kind: "message.summary", payload: { text: "one, briefly" } } })
    expect(await store.truncate("session", { beforeId: three.id })).toEqual({ sessionId: "session", removed: 1, retained: 2 })
    expect((await store.read("session")).map((record) => (record.payload as { text: string }).text)).toEqual(["one, briefly", "two"])
    await expect(store.truncate("session", { beforeId: three.id })).rejects.toThrow(TranscriptStoreError)
    const appended = await store.append("session", { kind: "message.user", payload: { text: "four" } })
    expect(appended.seq).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
