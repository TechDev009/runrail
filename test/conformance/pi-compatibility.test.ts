import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  PI_COMPATIBILITY_MATRIX_VERSION,
  createDefaultPiCompatibilityMatrix,
  parsePiCompatibilityFixtureCorpus,
  parsePiCompatibilityMatrix,
  parsePiCompatibilityMatrixJson,
  runPiCompatibilityProbes,
  summarizePiCompatibilityMatrix,
} from "../../src/compatibility/index.ts"
import { runPiExecutableProbes } from "../../src/compatibility/index.ts"

const fixturePath = resolve(import.meta.dir, "../fixtures/pi-compatibility/0.84.1.json")
const executablePath = resolve(import.meta.dir, "../fixtures/pi-compatibility/probe.ts")

test("the pinned Pi matrix has explicit, bounded coverage", async () => {
  const matrix = createDefaultPiCompatibilityMatrix()
  const fixture = parsePiCompatibilityFixtureCorpus(await readFile(fixturePath, "utf8"))
  const summary = summarizePiCompatibilityMatrix(matrix)

  expect(matrix.schemaVersion).toBe(PI_COMPATIBILITY_MATRIX_VERSION)
  expect(matrix.piVersion).toBe("0.84.1")
  expect(summary.total).toBeGreaterThanOrEqual(20)
  expect(summary.gaps).toEqual([])
  expect(summary.nativeVerified).toBeGreaterThan(0)
  expect(summary.passThrough).toBeGreaterThan(0)
  expect(new Set(fixture.fixtures.map((entry) => entry.id)).size).toBe(fixture.fixtures.length)
  expect(matrix.features.every((feature) => fixture.fixtures.some((entry) => entry.id === feature.fixture))).toBe(true)
  const featureIds = new Set(matrix.features.map((feature) => feature.id))
  expect(fixture.fixtures.every((entry) => featureIds.has(entry.featureId))).toBe(true)
  expect(matrix.features.every((feature) => fixture.fixtures.some((entry) => entry.id === feature.fixture && entry.featureId === feature.id && entry.surface === feature.surface))).toBe(true)
})

test("the checked-in fixture corpus parses without accepting payload-bearing fields", async () => {
  const text = await readFile(fixturePath, "utf8")
  const fixture = parsePiCompatibilityFixtureCorpus(text)

  expect(fixture.piVersion).toBe("0.84.1")
  expect(fixture.fixtures.find((entry) => entry.id === "pi-rpc-refusal")).toMatchObject({
    outcome: "refused",
    refusalCode: "PI_UNSUPPORTED_PROTOCOL",
  })
  expect(() => parsePiCompatibilityFixtureCorpus(text.replace('"outcome": "pass"', '"prompt": "secret"'))).toThrow("PI_FIXTURE_INVALID")
})

test("matrix parsing refuses duplicate features and invalid fixture paths", () => {
  const matrix = createDefaultPiCompatibilityMatrix()
  const duplicate = { ...matrix, features: [...matrix.features, matrix.features[0]] }
  expect(() => parsePiCompatibilityMatrix(duplicate)).toThrow("PI_MATRIX_INVALID")

  const invalid = {
    ...matrix,
    features: matrix.features.map((feature, index) => index === 0 ? { ...feature, fixture: "../secret" } : feature),
  }
  expect(() => parsePiCompatibilityMatrix(invalid)).toThrow("PI_MATRIX_INVALID")
})

test("matrix JSON parsing is schema-validated and does not trust malformed input", () => {
  expect(() => parsePiCompatibilityMatrixJson("not json")).toThrow("PI_MATRIX_INVALID")
  expect(() => parsePiCompatibilityMatrixJson(JSON.stringify({ schemaVersion: 2 }))).toThrow("PI_MATRIX_INVALID")
})

test("compatibility probes preserve explicit refusals and contain thrown failures", async () => {
  const results = await runPiCompatibilityProbes([
    { id: "supported", featureId: "cli.options", run: () => ({ status: "pass" as const, code: "OK" }) },
    { id: "refused", featureId: "rpc", run: () => ({ status: "refused" as const, code: "PI_UNSUPPORTED_PROTOCOL" }) },
    { id: "throws", featureId: "sdk", run: () => { throw new Error("secret payload must not escape") } },
  ])

  expect(results.map((result) => result.status)).toEqual(["pass", "refused", "failed"])
  expect(results[1]?.code).toBe("PI_UNSUPPORTED_PROTOCOL")
  expect(results[2]?.code).toBe("PROBE_THROWN")
  expect(JSON.stringify(results)).not.toContain("secret payload")
})

test("compatibility probes stop at a cancelled boundary", async () => {
  const controller = new AbortController()
  controller.abort()
  const results = await runPiCompatibilityProbes([
    { id: "never-run", featureId: "cli.options", run: () => ({ status: "pass" as const }) },
  ], { signal: controller.signal })

  expect(results).toEqual([
    expect.objectContaining({ id: "never-run", status: "cancelled", code: "PROBE_CANCELLED" }),
  ])
})

test("executable probes exercise a public process boundary without returning output", async () => {
  const results = await runPiExecutableProbes([
    { id: "process-pass", featureId: "rpc.events", command: process.execPath, args: [executablePath, "pass"], outputMode: "jsonl" },
    { id: "process-refused", featureId: "rpc.refusal", command: process.execPath, args: [executablePath, "refuse"], expectation: "refused", refusalCode: "PI_UNSUPPORTED_PROTOCOL", outputMode: "jsonl" },
    { id: "process-failed", featureId: "rpc.events", command: process.execPath, args: [executablePath, "fail"] },
    { id: "process-malformed", featureId: "rpc.events", command: process.execPath, args: [executablePath, "malformed"], outputMode: "jsonl" },
    { id: "process-output-limit", featureId: "rpc.events", command: process.execPath, args: [executablePath, "huge"], maxOutputBytes: 1_024 },
  ])

  expect(results.map((result) => result.status)).toEqual(["pass", "refused", "failed", "failed", "failed"])
  expect(results[0]?.eventTypes).toEqual(["rpc.ready", "rpc.event"])
  expect(JSON.stringify(results)).not.toContain("fixture payload")
  expect(JSON.stringify(results)).not.toContain("fixture secret")
  expect(results[4]?.code).toBe("PROBE_OUTPUT_LIMIT")
})

test("executable probes report cancellation and timeout as bounded states", async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  const cancelledResults = await runPiExecutableProbes([
    { id: "already-cancelled", featureId: "rpc.events", command: process.execPath, args: [executablePath, "wait"] },
  ], { signal: cancelled.signal })
  expect(cancelledResults[0]).toMatchObject({ status: "cancelled", code: "PROBE_CANCELLED" })

  const timedOut = await runPiExecutableProbes([
    { id: "times-out", featureId: "rpc.events", command: process.execPath, args: [executablePath, "wait"], timeoutMs: 10 },
  ])
  expect(timedOut[0]).toMatchObject({ status: "failed", code: "PROBE_TIMEOUT" })
})
