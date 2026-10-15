import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { FileSessionStore } from "@nifrajs/coding-agent"
import { importSessionEvidence } from "../../src/session/transfer.ts"

test("importing the same evidence twice adds it once, gaps in its numbering or not", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-evidence-import-"))
  try {
    const store = new FileSessionStore({ root })
    await store.append("target", "session.started")
    const bundle = JSON.stringify({ version: 1, sessionId: "source", events: [{ version: 1, seq: 100, type: "turn.started" }, { version: 1, seq: 205, type: "turn.completed", pinned: true }] })
    expect(await importSessionEvidence(store, bundle, "target")).toEqual({ sessionId: "target", imported: 2 })
    expect(await importSessionEvidence(store, bundle, "target")).toEqual({ sessionId: "target", imported: 0 })
    const entries = await store.read("target")
    expect(entries.map((entry) => entry.type)).toEqual(["session.started", "turn.started", "turn.completed"])
    expect(entries.at(-1)?.pinned).toBe(true)
    // Into the session it came from, nothing is added twice either.
    const own = JSON.stringify({ version: 1, sessionId: "target", events: entries.map((entry) => ({ version: 1, seq: entry.seq, type: entry.type })) })
    expect(await importSessionEvidence(store, own, "target")).toEqual({ sessionId: "target", imported: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
