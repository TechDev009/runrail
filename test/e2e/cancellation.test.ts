import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { runRunrail } from "../../src/cli.ts"
import { ScriptedModel } from "../../src/model/scripted-model.ts"

describe("cancellation", () => {
  test("ends the native run as cancelled", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, "../.tmp-cancel-"))
    const controller = new AbortController()
    try {
      await cp(resolve(import.meta.dir, "../fixtures/repair-project"), cwd, { recursive: true })
      setTimeout(() => controller.abort("test cancellation"), 10)
      const result = await runRunrail({
        cwd,
        backend: "native",
        signal: controller.signal,
        model: new ScriptedModel({ delayMs: 100 }),
      })
      expect(result.status).toBe("cancelled")
      expect(result.events.some((event) => event.type === "session.stopped")).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
