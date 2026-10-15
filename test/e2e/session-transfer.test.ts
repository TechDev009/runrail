import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSession } from "../../src/session.ts"

describe("content-free session transfer", () => {
  test("exports and imports only evidence identity", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-transfer-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-transfer-store-"))
    try {
      const session = await createRunrailSession({
        cwd,
        backend: "native",
        sessionDir,
        sessionId: "transfer-source",
        model: { complete: () => ({ type: "text", text: "secret model text" }) },
        loadExtensions: false,
      })
      try {
        for await (const _event of session.prompt("secret prompt")) {}
        await session.checkpoint()
        const exported = await session.exportEvidence()
        expect(exported).not.toContain("secret model text")
        expect(exported).not.toContain("secret prompt")
        const imported = await session.importEvidence(exported, "transfer-copy")
        expect(imported.imported).toBeGreaterThan(0)
        expect(await session.importEvidence(exported, "transfer-copy")).toMatchObject({ imported: 0 })
        expect(await session.branch("transfer-branch")).toMatchObject({ parentSessionId: "transfer-source" })
        expect(session.tree()).toMatchObject({ sessionId: "transfer-source", children: ["transfer-branch"] })
      } finally {
        await session.stop("test complete")
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })
})
