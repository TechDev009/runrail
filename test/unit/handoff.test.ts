import { expect, test } from "bun:test"
import {
  createPortableHandoff,
  parsePortableHandoff,
} from "../../src/handoff.ts"

test("portable handoffs preserve progress without retaining prompt content", async () => {
  const packet = await createPortableHandoff({
    handoffId: "handoff-1",
    runId: "run-1",
    source: "pi",
    target: "native",
    objective: "private objective that must not cross the boundary",
    acceptance: "private acceptance criteria",
    completedNodeIds: ["inspect"],
    remainingNodeIds: ["repair"],
    changedPaths: ["src/index.ts"],
    workspaceRef: "repo:example/runrail",
    verification: { name: "check", ok: false, status: 1 },
    blockerCode: "VERIFY_FAILED",
    nextActionCode: "REPAIR",
  })
  expect(packet.objectiveDigest).toHaveLength(64)
  expect(JSON.stringify(packet)).not.toContain("private objective")
  expect(JSON.stringify(packet)).not.toContain("acceptance criteria")
  expect(parsePortableHandoff(packet)).toEqual(packet)
})

test("portable handoff parsing rejects content fields and unsafe paths", async () => {
  const packet = await createPortableHandoff({
    handoffId: "handoff-2",
    runId: "run-2",
    source: "native",
    target: "pi",
    objective: "objective",
    acceptance: "acceptance",
  })
  expect(() => parsePortableHandoff({ ...packet, prompt: "do not persist me" })).toThrow()
  expect(() => parsePortableHandoff({ ...packet, changedPaths: ["../secret.ts"] })).toThrow()
  expect(() => parsePortableHandoff({ ...packet, changedPaths: [".env"] })).toThrow()
})
