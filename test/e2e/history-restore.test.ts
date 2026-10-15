import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { RunrailSessionController } from "../../src/control.ts"
import { createRunrailSession } from "../../src/session.ts"
import { FileTranscriptStore, type TranscriptStore } from "../../src/transcript/index.ts"

const cleanup: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function open(cwd: string, store: TranscriptStore) {
  const session = await createRunrailSession({
    cwd,
    backend: "native",
    sessionId: "kept-session",
    transcriptStore: store,
    loadExtensions: false,
    defaultSystemPrompt: false,
    model: { complete: () => ({ type: "text", text: "ok" }) },
  })
  const controller = new RunrailSessionController(session)
  cleanup.push(() => controller.close())
  return controller
}

test("a thread whose transcript cannot be read starts without its history, and says so", async () => {
  const cwd = await realpath(await mkdtemp(join("/tmp", "runrail-history-restore-")))
  const transcripts = await mkdtemp(join("/tmp", "runrail-history-restore-transcripts-"))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(transcripts, { recursive: true, force: true }))
  const store = new FileTranscriptStore({ root: transcripts })

  const first = await open(cwd, store)
  await first.enqueue("one")
  expect(first.snapshot().historyUnavailable).toBeUndefined()
  await first.close()

  const unreadable: TranscriptStore = Object.assign(Object.create(store) as TranscriptStore, { read: () => Promise.reject(new Error("transcript is corrupt")) })
  const second = await open(cwd, unreadable)
  expect(second.snapshot()).toMatchObject({ sessionId: "kept-session", historyUnavailable: true })
  await second.close()

  const third = await open(cwd, store)
  expect(third.snapshot().historyUnavailable).toBeUndefined()
})
