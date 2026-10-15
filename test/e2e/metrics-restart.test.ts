import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { RunrailSessionController } from "../../src/control.ts"
import { RunrailMetrics } from "../../src/runtime/metrics.ts"
import { createRunrailSession } from "../../src/session.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
const cleanup: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function open(cwd: string, store: FileTranscriptStore, sessionId: string) {
  const session = await createRunrailSession({
    cwd,
    backend: "native",
    sessionId,
    transcriptStore: store,
    loadExtensions: false,
    verify: "check",
    verificationCommand: verifier,
    maxRepairAttempts: 0,
    defaultSystemPrompt: false,
    model: { complete: () => ({ type: "text", text: "ok" }) },
  })
  const controller = new RunrailSessionController(session)
  cleanup.push(() => controller.close())
  return { metrics: session.metrics!, turn: (text: string) => controller.enqueue(text), close: () => controller.close() }
}

test("a session's usage totals come back when its engine starts again, and a branch starts from zero", async () => {
  const cwd = await realpath(await mkdtemp(join("/tmp", "runrail-metrics-restart-")))
  const transcripts = await mkdtemp(join("/tmp", "runrail-metrics-restart-transcripts-"))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(transcripts, { recursive: true, force: true }))
  const store = new FileTranscriptStore({ root: transcripts })

  const first = await open(cwd, store, "kept-session")
  await first.turn("one")
  await first.turn("two")
  const before = first.metrics.snapshot()
  expect(before.runs).toBe(2)
  expect(before.modelCalls).toBeGreaterThan(0)
  await first.close()

  // The engine restarts on the same thread.
  const second = await open(cwd, store, "kept-session")
  expect(second.metrics.snapshot()).toEqual(before)
  await second.turn("three")
  expect(second.metrics.snapshot().runs).toBe(3)
  expect(second.metrics.snapshot().modelCalls).toBeGreaterThan(before.modelCalls)

  // Only counters are recorded; the prompt text is not.
  const raw = await readFile(join(transcripts, "kept-session.jsonl"), "utf8").catch(async () => JSON.stringify(await store.read("kept-session")))
  const saved = raw.split("\n").filter((line) => line.includes("metrics.totals"))
  expect(saved.length).toBeGreaterThan(0)
  expect(saved.join("\n")).not.toContain("three")

  // A branch copies the records but is another session: its stats start at zero.
  await store.branch("kept-session", "branched-session")
  const branch = await open(cwd, store, "branched-session")
  expect(branch.metrics.snapshot().runs).toBe(0)
})

test("saved totals that are not whole counters are ignored", () => {
  const metrics = new RunrailMetrics()
  const valid = { modelCalls: 2, cacheHits: 0, cacheMisses: 2, runs: 1, successfulRuns: 1, repairs: 0, inputTokens: 40, outputTokens: 5, costUsd: 0.01, toolCalls: 0, elapsedMs: 12 }
  expect(metrics.restore({ ...valid, runs: -1 })).toBe(false)
  expect(metrics.restore({ ...valid, inputTokens: 1.5 })).toBe(false)
  expect(metrics.restore({ ...valid, costUsd: Number.NaN })).toBe(false)
  expect(metrics.restore("totals")).toBe(false)
  expect(metrics.snapshot().runs).toBe(0)
  expect(metrics.restore(valid)).toBe(true)
  expect(metrics.snapshot()).toMatchObject({ runs: 1, inputTokens: 40, costUsd: 0.01 })
})
