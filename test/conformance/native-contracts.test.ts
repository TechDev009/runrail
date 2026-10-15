import { expect, test } from "bun:test"
import {
  InMemoryNativeCommandLedger,
  InMemoryNativeEventJournal,
  NativeContractError,
  createDefaultNativeCapabilityMatrix,
  parseNativeCapabilityMatrix,
  parseNativeCommand,
  parseNativeCommandResult,
  parseNativeEvent,
  parseNativeExtensionManifest,
  parseNativePackageManifest,
  summarizeNativeCapabilityMatrix,
} from "../../src/native/index.ts"

const integrity = { algorithm: "sha256", digest: "a".repeat(64) }

function extensionManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    apiVersion: "1.0",
    id: "fixture.extension",
    version: "1.0.0",
    entry: "dist/index.js",
    mode: "trusted",
    capabilities: ["filesystem.read"],
    permissions: ["filesystem.read"],
    approval: { required: true, capabilities: ["filesystem.read"] },
    integrity,
    dependencies: [],
    contributes: ["tools", "ui"],
    platforms: ["macos", "linux"],
    enabled: true,
    ...overrides,
  }
}

function command(overrides: Record<string, unknown> = {}) {
  return parseNativeCommand({
    contractVersion: 1,
    commandId: "command-1",
    idempotencyKey: "idem-1",
    taskId: "task-1",
    sessionId: "session-1",
    name: "task.enqueue",
    requestedAt: 1,
    timeoutMs: 10_000,
    ...overrides,
  })
}

function event(seq: number, overrides: Record<string, unknown> = {}) {
  return parseNativeEvent({
    contractVersion: 1,
    eventId: `event-${seq}`,
    taskId: "task-1",
    sessionId: "session-1",
    seq,
    at: seq + 1,
    type: "task.started",
    ...overrides,
  })
}

test("native manifests are strict, versioned, and package-aware", () => {
  expect(parseNativeExtensionManifest(extensionManifest())).toMatchObject({ id: "fixture.extension", apiVersion: "1.0" })
  expect(parseNativePackageManifest({ ...extensionManifest(), packageType: "extension", displayName: "Fixture", tags: ["fixture"] })).toMatchObject({ packageType: "extension", displayName: "Fixture" })
  expect(() => parseNativeExtensionManifest({ ...extensionManifest(), unknown: true })).toThrow("NATIVE_INVALID")
  expect(() => parseNativeExtensionManifest({ ...extensionManifest(), contractVersion: 9 })).toThrow("NATIVE_UNSUPPORTED_VERSION")
  expect(() => parseNativeExtensionManifest({ ...extensionManifest(), approval: { required: true, capabilities: ["process.exec"] } })).toThrow("NATIVE_INVALID")
  expect(() => parseNativePackageManifest({ ...extensionManifest(), packageType: "extension", displayName: "Fixture", tags: ["fixture"], entry: "../escape.js" })).toThrow("NATIVE_INVALID")
})

test("native events provide bounded replay cursors and expire safely", () => {
  const journal = new InMemoryNativeEventJournal({ maxEventsPerTask: 2 })
  journal.append(event(0))
  journal.append(event(1, { type: "turn.started" }))
  journal.append(event(2, { type: "task.completed", terminal: "completed" }))
  expect(journal.read("task-1", 1).map((item) => item.seq)).toEqual([2])
  expect(journal.cursor("task-1", 1)).toMatchObject({ nextSeq: 3 })
  expect(() => journal.read("task-1", -1)).toThrow("NATIVE_CURSOR_EXPIRED")
  expect(() => journal.append(event(2, { eventId: "different" }))).toThrow("NATIVE_STATE_CONFLICT")
  expect(() => parseNativeEvent({ ...event(3), metadata: { prompt: { secret: true } } })).toThrow("NATIVE_INVALID")
})

test("native command results enforce idempotency and bounded payloads", () => {
  const parsed = command({ payload: { branch: "main", dryRun: true, paths: ["src/index.ts"] } })
  expect(parsed.payload).toMatchObject({ branch: "main", dryRun: true })
  const result = parseNativeCommandResult({ contractVersion: 1, commandId: "command-1", idempotencyKey: "idem-1", status: "completed", acceptedAt: 1, completedAt: 2, firstEventSeq: 1, lastEventSeq: 2 })
  const ledger = new InMemoryNativeCommandLedger()
  ledger.put(parsed, result)
  expect(ledger.get("idem-1")).toEqual(result)
  ledger.put(parsed, result)
  expect(() => ledger.put(parsed, { ...result, code: "different" })).toThrow("NATIVE_IDEMPOTENCY_CONFLICT")
  expect(() => parseNativeCommand({ ...parsed, payload: { nested: { nope: true } } })).toThrow("NATIVE_INVALID")
})

test("a result pushed out of a full ledger takes its task's index entry with it", () => {
  const ledger = new InMemoryNativeCommandLedger({ maxEntries: 2 })
  for (let index = 0; index < 50; index += 1) {
    const key = `idem-${index}`
    const parsed = command({ idempotencyKey: key, taskId: `task-${index}` })
    ledger.put(parsed, parseNativeCommandResult({ contractVersion: 1, commandId: parsed.commandId, idempotencyKey: key, status: "completed", acceptedAt: 1, completedAt: 2, firstEventSeq: 1, lastEventSeq: 2 }))
  }
  expect(ledger.taskCount).toBe(2)
  expect(ledger.get("idem-0")).toBeUndefined()
  expect(ledger.get("idem-49")).toBeDefined()
})

test("native capability matrix covers product ownership and rejects gaps", () => {
  const matrix = createDefaultNativeCapabilityMatrix()
  const summary = summarizeNativeCapabilityMatrix(matrix)
  expect(summary.total).toBeGreaterThanOrEqual(15)
  expect(summary.gaps).toEqual([])
  expect(matrix.rows.find((row) => row.id === "extensions.native")).toMatchObject({ classification: "native", status: "active" })
  expect(matrix.rows.find((row) => row.id === "sandbox.isolation")).toMatchObject({ classification: "caller-owned", status: "caller-owned" })
  expect(() => parseNativeCapabilityMatrix({ ...matrix, rows: [matrix.rows[0], matrix.rows[0]] })).toThrow("NATIVE_DUPLICATE")
  expect(() => parseNativeCapabilityMatrix({ ...matrix, rows: [{ ...matrix.rows[0], status: "active" }] })).toThrow("NATIVE_INVALID")
})
