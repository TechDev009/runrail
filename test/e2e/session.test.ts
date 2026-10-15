import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createRunrailSession } from "../../src/session.ts"
import { createReplayBackend } from "../../src/backend/replay.ts"

describe("Runrail session surface", () => {
  test("exposes lifecycle controls and persists bounded evidence", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-session-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-session-store-"))
    try {
      const session = await createRunrailSession({
        cwd,
        backend: "native",
        sessionDir,
        sessionId: "session-e2e",
        model: { complete: () => ({ type: "text", text: "done" }) },
      })
      expect(session.snapshot.id).toBe("session-e2e")
      for await (const event of session.prompt("finish")) {
        if (event.type === "assistant.message") expect(event.text).toBe("done")
      }
      await session.checkpoint()
      expect((await session.history()).some((entry) => entry.type === "session.checkpoint")).toBe(true)
      await expect(session.fork("session-fork")).resolves.toMatchObject({
        sessionId: "session-fork",
        parentSessionId: "session-e2e",
      })
      expect((await session.compact()).after).toBeGreaterThanOrEqual(0)
      await expect(session.reload()).resolves.toMatchObject({ rolledBack: false })
      await session.stop("test complete")
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  test("accepts a caller-supplied backend adapter through the same session factory", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-custom-session-"))
    const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
    try {
      const session = await createRunrailSession({
        cwd,
        backend: "custom",
        adapter: {
          name: "custom",
          version: "1.0.0",
          capabilities: ["sessions"],
          create: () => createReplayBackend(),
        },
        verify: "check",
        verificationCommand: verifier,
        loadExtensions: false,
      })
      try {
        const events = []
        for await (const event of session.prompt("replay")) events.push(event)
        expect(events.some((event) => event.type === "assistant.message")).toBe(true)
      } finally {
        await session.stop("test complete")
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
