import { describe, expect, jest, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { createRunrailSessionController } from "../../src/control.ts"
import { createRunrailSession } from "../../src/index.ts"
import { ScriptedModel } from "../../src/model/scripted-model.ts"

describe("how long a native approval waits", () => {
  test("reaches the native loop, which holds it to between 1 ms and a day", async () => {
    const session = await createRunrailSession({ cwd: "/tmp", backend: "native", loadExtensions: false, approvalTimeoutMs: 86_400_000 })
    await session.close()
    await expect(createRunrailSession({ cwd: "/tmp", backend: "native", loadExtensions: false, approvalTimeoutMs: 86_400_001 })).rejects.toThrow("approvalTimeoutMs")
  })

  test("unless told otherwise, it waits for an answer with no timer: the person may be away", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-approval-wait-"))
    const configPath = join(cwd, "config.json")
    await writeFile(configPath, JSON.stringify({ version: 1, mode: "ask" }))
    const controller = await createRunrailSessionController({ cwd, backend: "native", loadExtensions: false, model: new ScriptedModel(), behaviorConfigPath: configPath })
    const events: AgentEvent[] = []
    const unsubscribe = controller.subscribe((event) => events.push(event))
    jest.useFakeTimers()
    try {
      const done = controller.enqueue("do work")
      for (let tries = 0; tries < 200 && !events.some((event) => event.type === "approval.required"); tries += 1) await Promise.resolve().then(() => new Promise((resolve) => setImmediate(resolve)))
      const asked = events.find((event) => event.type === "approval.required") as Extract<AgentEvent, { type: "approval.required" }>
      jest.advanceTimersByTime(25 * 60 * 60_000)
      await new Promise((resolve) => setImmediate(resolve))
      expect(events.some((event) => event.type === "approval.resolved")).toBe(false)
      expect(controller.session.pendingApprovals.map((approval) => approval.id)).toEqual([asked.approvalId])
      jest.useRealTimers()
      await controller.resolveApproval(asked.approvalId, false, "not now")
      await done
      expect(events.find((event) => event.type === "approval.resolved")).toMatchObject({ approvalId: asked.approvalId, approved: false })
    } finally {
      jest.useRealTimers()
      unsubscribe()
      await controller.close("test complete")
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
