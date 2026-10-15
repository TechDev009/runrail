import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { NativeModelPort } from "@nifrajs/coding-agent"
import { runRunrail } from "../../src/cli.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")

describe("provider and credential boundary", () => {
  test("scripted mode makes no provider request and filters credentials", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, "../.tmp-no-network-"))
    const originalSecret = process.env.RUNRAIL_TEST_SECRET
    const originalFetch = globalThis.fetch
    let networkCalls = 0
    const model: NativeModelPort = { complete: () => ({ type: "text", text: "done" }) }
    process.env.RUNRAIL_TEST_SECRET = "must-not-cross-process-boundary"
    globalThis.fetch = (async () => {
      networkCalls += 1
      throw new Error("network is forbidden in this test")
    }) as unknown as typeof fetch
    try {
      const result = await runRunrail({ cwd, backend: "native", model, verificationCommand: verifier })
      expect(result.status).toBe("succeeded")
      expect(networkCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      if (originalSecret === undefined) delete process.env.RUNRAIL_TEST_SECRET
      else process.env.RUNRAIL_TEST_SECRET = originalSecret
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
