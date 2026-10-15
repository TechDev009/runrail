import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { NativeModelPort } from "@nifrajs/coding-agent"
import type { NativeApprovalPort } from "@nifrajs/coding-agent"
import { runRunrail } from "../../src/cli.ts"

const fixture = resolve(import.meta.dir, "../fixtures/repair-project")
const slowVerifier = resolve(import.meta.dir, "../fixtures/slow-verifier")
const allowLocalToolApproval: NativeApprovalPort = { request: ({ signal }) => !signal.aborted }

describe("declared terminal failure states", () => {
  test("reports denied approval distinctly", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, "../.tmp-denied-"))
    const model: NativeModelPort = {
      complete: () => ({ type: "tool", name: "run_verification", input: { name: "check" } }),
    }
    try {
      await cp(fixture, cwd, { recursive: true })
      const result = await runRunrail({ cwd, backend: "native", model })
      expect(result.status).toBe("denied")
      expect(result.events.some((event) => event.code === "APPROVAL_DENIED")).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("reports verification timeout distinctly", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, "../.tmp-timeout-"))
    try {
      await cp(fixture, cwd, { recursive: true })
      const result = await runRunrail({
        cwd,
        backend: "native",
        verificationCommand: slowVerifier,
        verificationTimeoutMs: 20,
        approval: allowLocalToolApproval,
      })
      expect(result.status).toBe("timed_out")
      expect(result.repairAttempts).toBe(0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
