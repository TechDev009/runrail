import { describe, expect, test } from "bun:test"
import { CANDIDATE_HARNESS_DESCRIPTORS, createCandidateHarness, createCandidateHarnessAdapters } from "../../src/index.ts"

describe("caller-owned candidate harness adapters", () => {
  test("exposes conservative descriptors for the supported JSONL seam", () => {
    const adapters = createCandidateHarnessAdapters()
    expect(adapters.map((adapter) => adapter.descriptor.id).sort()).toEqual(["aider", "gemini", "goose", "opencode"])
    for (const descriptor of Object.values(CANDIDATE_HARNESS_DESCRIPTORS)) {
      expect(descriptor).toMatchObject({ classification: "caller-owned", protocolVersion: "runrail.jsonl", runtimeVersion: "caller-installed" })
      expect(descriptor.features).not.toContain("approvals")
    }
  })

  test("runs each candidate through an explicit normalized wrapper", async () => {
    const fixture = new URL("../fixtures/agent-jsonl.ts", import.meta.url).pathname
    for (const id of ["gemini", "opencode", "aider", "goose"] as const) {
      const backend = createCandidateHarness(id, { command: process.execPath, args: [fixture, "events"] })
      const created = await backend.createSession({ cwd: "/tmp", sessionId: `${id}-fixture` })
      const events = []
      for await (const event of backend.send({ sessionId: created.id, message: "candidate" })) events.push(event)
      expect(events.at(-1)?.type).toBe("session.completed")
      await backend.close(created.id)
    }
  })
})
