import { expect, test } from "bun:test"
import type { AgentEvent, AgentToolCompletedEvent } from "@nifrajs/agent-protocol"
import { RunrailBackend } from "../../src/backend/runrail-backend.ts"

/** Runs one native tool call per result through the real loop and returns the completions. */
async function completions(results: readonly (readonly [string, unknown])[]): Promise<readonly AgentToolCompletedEvent[]> {
  let step = 0
  const backend = new RunrailBackend({
    model: {
      complete: () => {
        const current = step
        step += 1
        const next = results[current]
        return next === undefined ? { type: "text", text: "done" } : { type: "tool", name: next[0], input: { step: current } }
      },
    },
    tools: [...new Set(results.map(([name]) => name))].map((name) => ({
      name,
      description: "test command tool",
      execute: (input: unknown) => results[(input as { step: number }).step]?.[1],
    })),
  })
  const snapshot = await backend.createSession({ cwd: process.cwd() })
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId: snapshot.id, message: "run" })) events.push(event)
  await backend.close(snapshot.id)
  return events.filter((event): event is AgentToolCompletedEvent => event.type === "tool.completed")
}

test("a native command that failed completes as failed, with its output kept", async () => {
  const command = { program: "sh", args: [], truncated: false, timedOut: false, cancelled: false }
  const [failed, passed, cut, slow, background, gate, other] = await completions([
    ["run_command", { ok: false, status: 3, ...command, stdout: "boom\n" }],
    ["run_command", { ok: true, status: 0, ...command, stdout: "fine\n" }],
    ["run_command", { ok: false, status: 1, ...command, stdout: "\"".repeat(40_000) }],
    ["run_command", { ok: false, status: 143, ...command, timedOut: true }],
    ["run_command", { ok: false, background: true, error: "BACKGROUND_LIMIT", message: "too many background commands" }],
    ["run_verification", { ok: false, status: 1, name: "test", output: "1 fail" }],
    ["read_file", { ok: false, status: 1 }],
  ])
  expect(failed).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED", message: "command exited with status 3" } })
  expect(String(failed?.output)).toContain("boom")
  expect(passed?.ok).toBe(true)
  expect(passed?.error).toBeUndefined()
  // The loop cut this result's text short; its first fields still say how it ended.
  expect(String(cut?.output)).toEndWith("[truncated]")
  expect(cut).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED", message: "command exited with status 1" } })
  expect(slow).toMatchObject({ ok: false, error: { message: "command timed out" } })
  expect(background).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED", message: "too many background commands" } })
  expect(gate).toMatchObject({ ok: false, error: { code: "VERIFICATION_FAILED", message: "verification exited with status 1" } })
  expect(other?.ok).toBe(true)
})
