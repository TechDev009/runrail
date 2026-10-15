import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { NativeApprovalPort } from "@nifrajs/coding-agent"
import { runRunrail } from "../../src/cli.ts"
import { ScriptedModel } from "../../src/model/scripted-model.ts"

const fixture = resolve(import.meta.dir, "../fixtures/repair-project")
const localVerifier = resolve(import.meta.dir, "../fixtures/local-typecheck-verifier")
const allowLocalToolApproval: NativeApprovalPort = { request: ({ signal }) => !signal.aborted }

setDefaultTimeout(30_000)

describe("verification-guided repair", () => {
  test("fails a local verification gate, repairs, and passes", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, "../.tmp-repair-"))
    try {
      await cp(fixture, cwd, { recursive: true })
        const result = await runRunrail({ cwd, backend: "native", verificationCommand: localVerifier, approval: allowLocalToolApproval })
      expect(result.status).toBe("succeeded")
      expect(result.repairAttempts).toBe(1)
      expect(result.events.map((event) => event.type)).toContain("repair.required")
      expect(await readFile(resolve(cwd, "index.ts"), "utf8")).toContain("42")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("stops after a repeated failed verification", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, "../.tmp-repair-cap-"))
    try {
      await cp(fixture, cwd, { recursive: true })
      const result = await runRunrail({
        cwd,
        backend: "native",
        maxRepairAttempts: 2,
        verificationCommand: localVerifier,
        model: new ScriptedModel({ alwaysBroken: true }),
        approval: allowLocalToolApproval,
      })
      expect(result.status).toBe("exhausted")
      expect(result.repairAttempts).toBe(1)
      expect(result.events.some((event) => event.reason === "repeated_failure")).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
