import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { createRunrailSessionController } from "../../src/control.ts"
import { ScriptedModel } from "../../src/model/scripted-model.ts"

/**
 * P4 enforcement matrix: behavior config actually governs live turns.
 * No provider credentials needed — the scripted model always calls
 * apply_patch, a mutating tool, on its first turn.
 */

interface Fixture {
  readonly cwd: string
  readonly configPath: string
}

async function fixture(): Promise<Fixture> {
  const cwd = await mkdtemp(join("/tmp", "runrail-behavior-e2e-"))
  const configPath = join(cwd, "config.json")
  return { cwd, configPath }
}

async function writeConfig(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value))
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.cwd, { recursive: true, force: true })
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
}

/** Enqueue a turn, capture the first approval.required, and leave the turn pending. */
async function enqueueUntilApproval(
  controller: Awaited<ReturnType<typeof createRunrailSessionController>>,
  message: string,
  timeoutMs = 15_000,
): Promise<{ approvalId: string; done: Promise<readonly AgentEvent[]> }> {
  let captured: string | undefined
  const seen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for approval")), timeoutMs)
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === "approval.required" && event.approvalId !== undefined) {
        captured = event.approvalId
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  })
  const done = controller.enqueue(message)
  await seen
  return { approvalId: captured ?? "", done }
}

describe("behavior enforcement", () => {
  test("ask raises approval and denied writes never land", async () => {
    const fx = await fixture()
    try {
      await writeConfig(fx.configPath, { version: 1, mode: "ask" })
      const controller = await createRunrailSessionController({
        cwd: fx.cwd,
        backend: "native",
        loadExtensions: false,
        model: new ScriptedModel(),
        behaviorConfigPath: fx.configPath,
      })
      try {
        const { approvalId, done } = await enqueueUntilApproval(controller, "do work")
        expect(approvalId.length).toBeGreaterThan(0)
        controller.resolveApproval(approvalId, false, "e2e denied")
        const events = await done
        // Denial fails the tool call; the turn still completes.
        expect(events.some((event) => event.type === "tool.completed" && event.ok === false)).toBe(true)
        expect(events.some((event) => event.type === "session.completed")).toBe(true)
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(false)
      } finally {
        await controller.close("test complete")
      }
    } finally {
      await cleanup(fx)
    }
  })

  test("ask waits for the caller and an approved write lands", async () => {
    const fx = await fixture()
    try {
      await writeConfig(fx.configPath, { version: 1, mode: "ask" })
      const controller = await createRunrailSessionController({
        cwd: fx.cwd,
        backend: "native",
        loadExtensions: false,
        model: new ScriptedModel(),
        behaviorConfigPath: fx.configPath,
      })
      try {
        const { approvalId, done } = await enqueueUntilApproval(controller, "do work")
        // The request is still open: nothing was written and the turn has not moved on.
        expect(await Promise.race([done.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))])).toBe("waiting")
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(false)
        controller.resolveApproval(approvalId, true)
        const events = await done
        expect(events.some((event) => event.type === "session.completed")).toBe(true)
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(true)
      } finally {
        await controller.close("test complete")
      }
    } finally {
      await cleanup(fx)
    }
  })

  test("allow rule in ask mode proceeds without approval and writes", async () => {
    const fx = await fixture()
    try {
      await writeConfig(fx.configPath, {
        version: 1,
        mode: "ask",
        permissions: { default: "ask", rules: [{ tool: "apply_patch", match: "*", policy: "allow" }] },
      })
      const controller = await createRunrailSessionController({
        cwd: fx.cwd,
        backend: "native",
        loadExtensions: false,
        model: new ScriptedModel(),
        behaviorConfigPath: fx.configPath,
      })
      try {
        // The turn must complete with NO manual resolution: the allow rule
        // auto-approves. (approval.required is still emitted by the engine
        // before auto-approval; the proof is unassisted completion + write.)
        const events = await controller.enqueue("do work")
        expect(events.some((event) => event.type === "session.completed")).toBe(true)
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(true)
      } finally {
        await controller.close("test complete")
      }
    } finally {
      await cleanup(fx)
    }
  })

  test("auto proceeds without approval and writes", async () => {
    const fx = await fixture()
    try {
      await writeConfig(fx.configPath, { version: 1, mode: "auto" })
      const controller = await createRunrailSessionController({
        cwd: fx.cwd,
        backend: "native",
        loadExtensions: false,
        model: new ScriptedModel(),
        behaviorConfigPath: fx.configPath,
      })
      try {
        const events = await controller.enqueue("do work")
        expect(events.some((event) => event.type === "session.completed")).toBe(true)
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(true)
      } finally {
        await controller.close("test complete")
      }
    } finally {
      await cleanup(fx)
    }
  })

  test("plan mode never writes and never asks", async () => {
    const fx = await fixture()
    try {
      await writeConfig(fx.configPath, { version: 1, mode: "plan" })
      const controller = await createRunrailSessionController({
        cwd: fx.cwd,
        backend: "native",
        loadExtensions: false,
        model: new ScriptedModel(),
        behaviorConfigPath: fx.configPath,
      })
      try {
        const seen: string[] = []
        const unsubscribe = controller.subscribe((event) => seen.push(event.type))
        await controller.enqueue("do work")
        unsubscribe()
        expect(seen).not.toContain("approval.required")
        // apply_patch is not in the plan catalog: the model cannot reach a
        // writer, so nothing lands on disk.
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(false)
      } finally {
        await controller.close("test complete")
      }
    } finally {
      await cleanup(fx)
    }
  })

  test("rewritten config applies after session reload", async () => {
    const fx = await fixture()
    try {
      await writeConfig(fx.configPath, { version: 1, mode: "ask" })
      const controller = await createRunrailSessionController({
        cwd: fx.cwd,
        backend: "native",
        loadExtensions: false,
        model: new ScriptedModel(),
        behaviorConfigPath: fx.configPath,
      })
      try {
        const first = await enqueueUntilApproval(controller, "do work")
        controller.resolveApproval(first.approvalId, false, "e2e denied")
        await first.done
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(false)

        await writeConfig(fx.configPath, { version: 1, mode: "auto" })
        await controller.refreshSession()
        // The shared scripted model is spent after turn one, so this turn is
        // text-only — which is exactly the point: in ask mode it would still
        // raise approval for nothing, but the reloaded auto config sails
        // through with no approval and no manual resolution.
        const seen: string[] = []
        const unsubscribe = controller.subscribe((event) => seen.push(event.type))
        const events = await controller.enqueue("do more work")
        unsubscribe()
        expect(seen).not.toContain("approval.required")
        expect(events.some((event) => event.type === "session.completed")).toBe(true)
        // Turn one's denial still holds: nothing was ever written.
        expect(await fileExists(join(fx.cwd, "index.ts"))).toBe(false)
      } finally {
        await controller.close("test complete")
      }
    } finally {
      await cleanup(fx)
    }
  })

  test("corrupt config fails controller creation recoverably", async () => {
    const fx = await fixture()
    try {
      await writeFile(fx.configPath, "broken")
      await expect(
        createRunrailSessionController({
          cwd: fx.cwd,
          backend: "native",
          loadExtensions: false,
          model: new ScriptedModel(),
          behaviorConfigPath: fx.configPath,
        }),
      ).rejects.toThrow()
    } finally {
      await cleanup(fx)
    }
  })
})
