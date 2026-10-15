import { describe, expect, test } from "bun:test"
import type { AgentSessionSnapshot } from "@nifrajs/agent-protocol"
import {
  CLAUDE_CODE_HARNESS_DESCRIPTOR,
  CODEX_HARNESS_DESCRIPTOR,
  createDefaultHarnessCompatibilityMatrix,
  mapClaudeCodeEvent,
  mapCodexEvent,
  type HarnessEventFamily,
  type HarnessEventMappingContext,
} from "../../src/index.ts"

const fixtureRoot = new URL("../fixtures/", import.meta.url)

describe("harness fixture catalog", () => {
  test("resolves every compatibility matrix fixture to a checked-in artifact", async () => {
    const matrix = createDefaultHarnessCompatibilityMatrix()
    expect(matrix.rows.length).toBe(18)
    for (const row of matrix.rows) {
      expect(await Bun.file(new URL(row.fixture, fixtureRoot)).exists()).toBe(true)
    }
  })

  test("covers every advertised Codex and Claude event family", async () => {
    const cases = [
      { descriptor: CODEX_HARNESS_DESCRIPTOR, fixture: "harnesses/codex-lifecycle.jsonl", mapper: mapCodexEvent },
      { descriptor: CLAUDE_CODE_HARNESS_DESCRIPTOR, fixture: "harnesses/claude-code-lifecycle.jsonl", mapper: mapClaudeCodeEvent },
    ] as const

    for (const entry of cases) {
      const values = await readJsonLines(entry.fixture)
      const previous: AgentSessionSnapshot = { version: 1, id: "fixture-session", backend: entry.descriptor.id, cwd: "/tmp", status: "idle", createdAt: 0, updatedAt: 0, lastSeq: -1, capabilities: ["sessions", "streaming"] }
      const context: HarnessEventMappingContext = { sessionId: previous.id, cwd: previous.cwd, backend: previous.backend, nextSeq: 0, previous }
      let vendorSessionId: string | undefined
      const families = new Set<HarnessEventFamily>()
      let mappedCount = 0
      for (const [index, value] of values.entries()) {
        const family = eventFamily(entry.descriptor.id, value)
        if (family !== undefined) families.add(family)
        const mappingContext: HarnessEventMappingContext = { ...context, nextSeq: index, ...(vendorSessionId === undefined ? {} : { vendorSessionId }) }
        const event = entry.mapper(value, mappingContext)
        vendorSessionId = mappingContext.vendorSessionId
        if (event !== undefined) mappedCount += 1
      }
      for (const family of entry.descriptor.events ?? []) expect(families.has(family)).toBe(true)
      expect(mappedCount).toBeGreaterThan(0)
    }
  })
})

async function readJsonLines(path: string): Promise<readonly unknown[]> {
  const text = await Bun.file(new URL(path, fixtureRoot)).text()
  return text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown)
}

function eventFamily(harness: string, value: unknown): HarnessEventFamily | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const type = (value as { type?: unknown }).type
  if (typeof type !== "string") return undefined
  if (type === "thread.started" || type === "system") return "lifecycle"
  if (type === "turn.started" || type === "message_start") return "turn"
  if (type === "assistant" || type === "stream_event" || (type.startsWith("item.") && itemIsAssistant(value))) return "assistant"
  if (type === "tool_use" || type === "user" || (type.startsWith("item.") && !itemIsAssistant(value))) return "tool"
  if (type === "permission_request" || type === "approval.required") return "approval"
  if (type === "rate_limit_event") return "rate-limit"
  if (type === "turn.interrupted" || type === "turn.cancelled" || (harness === "claude-code" && type === "result" && isCancelled(value))) return "cancellation"
  if (type === "turn.failed" || type === "error" || type === "failure") return "failure"
  return undefined
}

function itemIsAssistant(value: object): boolean {
  const item = (value as { item?: unknown }).item
  return item !== null && typeof item === "object" && !Array.isArray(item) && (item as { type?: unknown }).type === "agent_message"
}

function isCancelled(value: object): boolean {
  const record = value as { subtype?: unknown; stop_reason?: unknown }
  return record.subtype === "cancelled" || record.subtype === "canceled" || record.stop_reason === "cancelled" || record.stop_reason === "canceled"
}
