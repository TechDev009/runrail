import { describe, expect, test } from "bun:test"
import { RunrailBackend } from "../../src/backend/runrail-backend.ts"
import { createReplayBackend } from "../../src/backend/replay.ts"
import { ScriptedModel } from "../../src/model/scripted-model.ts"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"

async function collect(backend: AgentBackend): Promise<readonly string[]> {
  const snapshot = await backend.createSession({ cwd: process.cwd() })
  const types: string[] = []
  for await (const event of backend.send({ sessionId: snapshot.id, message: "task" })) types.push(event.type)
  await backend.close(snapshot.id)
  return types
}

describe("backend conformance", () => {
  test("replay and native have monotonic ordered terminal events", async () => {
    const native = new RunrailBackend({
      model: new ScriptedModel(),
      tools: [
        {
          name: "apply_patch",
          description: "test tool",
          execute: async () => "ok",
        },
      ],
    })
    const replayTypes = await collect(createReplayBackend())
    const nativeTypes = await collect(native)
    expect(replayTypes.at(-1)).toBe("session.completed")
    expect(nativeTypes.at(-1)).toBe("session.completed")
  })

  test("native approval is resolvable through the Runrail wrapper", async () => {
    let executions = 0
    const native = new RunrailBackend({
      model: {
        complete: ({ messages }) =>
          messages.some((message) => message.role === "tool")
            ? { type: "text", text: "done" }
            : { type: "tool", name: "protected", input: { path: "safe.txt" } },
      },
      tools: [
        {
          name: "protected",
          description: "test approval tool",
          capabilities: ["filesystem.write"],
          requiresApproval: true,
          execute: () => {
            executions += 1
            return "ok"
          },
        },
      ],
    })
    const snapshot = await native.createSession({ cwd: process.cwd(), sessionId: "approval" })
    const events: AgentEvent[] = []
    for await (const event of native.send({ sessionId: snapshot.id, message: "approve" })) {
      events.push(event)
      if (event.type === "approval.required")
        expect(await native.resolveApproval(snapshot.id, event.approvalId, true)).toBe(true)
    }
    expect(events.map((event) => event.type)).toContain("approval.resolved")
    expect(executions).toBe(1)
    await native.close(snapshot.id)
  })
})
