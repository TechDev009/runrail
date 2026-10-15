import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSessionController } from "../../src/control.ts"

describe("Runrail session controller", () => {
  test("a failed backend switch leaves a working session behind", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-"))
    try {
      const controller = await createRunrailSessionController({ cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) } })
      try {
        await expect(controller.switchBackend("no-such-backend")).rejects.toThrow("unknown adapter")
        const events = await controller.enqueue("still here")
        expect(events.map((event) => event.type)).toContain("session.completed")
      } finally {
        await controller.close()
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("an aborted signal takes a queued turn out of the queue and cancels a running one", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-"))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    try {
      const controller = await createRunrailSessionController({
        cwd,
        backend: "native",
        loadExtensions: false,
        model: { complete: async () => { calls += 1; await gate; return { type: "tool" as const, name: "list_files", input: { path: "." } } } },
      })
      try {
        const running = new AbortController()
        const queued = new AbortController()
        const first = controller.enqueue("one", running.signal)
        const second = controller.enqueue("two", queued.signal)
        while (calls === 0) await Bun.sleep(5)
        queued.abort()
        await expect(second).rejects.toThrow("the turn was cancelled")
        expect(controller.snapshot().queued).toBe(0)
        running.abort()
        release()
        const events = await first.catch(() => [])
        expect(events.map((event) => event.type)).not.toContain("session.completed")
        expect(calls).toBe(1)
      } finally {
        release()
        await controller.close()
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("serializes queued follow-ups and publishes transient events", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-control-"))
    try {
      const controller = await createRunrailSessionController({
        cwd,
        backend: "native",
        loadExtensions: false,
        model: { complete: () => ({ type: "text", text: "done" }) },
      })
      const seen: string[] = []
      const unsubscribe = controller.subscribe((event) => seen.push(event.type))
      try {
        const first = controller.enqueue("one")
        const second = controller.steer("two")
        await expect(first).resolves.toContainEqual(expect.objectContaining({ type: "assistant.message" }))
        await expect(second).resolves.toContainEqual(expect.objectContaining({ type: "assistant.message" }))
        expect(seen).toContain("assistant.message")
        expect(controller.snapshot().queued).toBe(0)
      } finally {
        unsubscribe()
        await controller.close("test complete")
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
