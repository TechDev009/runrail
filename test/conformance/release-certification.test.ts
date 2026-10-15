import { expect, test } from "bun:test"
import { createDefaultPiCompatibilityMatrix } from "../../src/compatibility/index.ts"
import { createDefaultHarnessCompatibilityMatrix } from "../../src/harness/index.ts"
import {
  certifyRelease,
  type ReleaseCertificationProfile,
} from "../../src/certification/index.ts"

function profile(checks: ReleaseCertificationProfile["checks"]): ReleaseCertificationProfile {
  return {
    id: "runrail-release-fixture",
    version: "0.1.0-fixture",
    matrix: createDefaultPiCompatibilityMatrix(),
    checks,
  }
}

test("release certification passes verified local checks and records caller-owned gaps", async () => {
  const result = await certifyRelease(profile([
    { id: "packed-consumer", run: () => ({ status: "pass" as const }) },
    { id: "live-provider", required: false, run: () => ({ status: "unavailable" as const, code: "CALLER_OWNED_PROVIDER" }) },
  ]))

  expect(result.ok).toBe(true)
  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "compatibility-matrix", status: "pass" }),
    expect.objectContaining({ id: "packed-consumer", status: "pass" }),
    expect.objectContaining({ id: "live-provider", status: "unavailable", required: false, code: "CALLER_OWNED_PROVIDER" }),
  ]))
  expect(JSON.stringify(result)).not.toContain("secret")
})

test("release certification contains thrown and timed-out checks without leaking errors", async () => {
  const result = await certifyRelease({
    ...profile([
      { id: "throws", run: () => { throw new Error("secret release payload") } },
      { id: "times-out", run: () => new Promise(() => undefined) },
    ]),
    timeoutMs: 10,
  })

  expect(result.ok).toBe(false)
  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "throws", status: "failed", code: "RELEASE_CHECK_THROWN" }),
    expect.objectContaining({ id: "times-out", status: "failed", code: "RELEASE_CHECK_TIMEOUT" }),
  ]))
  expect(JSON.stringify(result)).not.toContain("secret release payload")
})

test("release certification digest changes when the certified matrix changes", async () => {
  const first = await certifyRelease(profile([]))
  const second = await certifyRelease({
    ...profile([]),
    matrix: { ...createDefaultPiCompatibilityMatrix(), runrailVersion: "0.1.0-other" },
  })
  expect(first.digest).not.toBe(second.digest)
})

test("release certification composes the harness matrix and refuses planned rows", async () => {
  const harnessValidation = {
    fixtureExists: () => true,
    verifyRow: () => true,
    verifyCapability: () => true,
  }
  const passed = await certifyRelease({ ...profile([]), harnessMatrix: createDefaultHarnessCompatibilityMatrix(), harnessValidation })
  expect(passed.ok).toBe(true)
  expect(passed.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "harness-compatibility", status: "pass" })]))

  const incomplete = createDefaultHarnessCompatibilityMatrix()
  const failed = await certifyRelease({
    ...profile([]),
    harnessMatrix: { ...incomplete, rows: [...incomplete.rows, { ...incomplete.rows[0], id: "planned.example", status: "planned" as const }] },
    harnessValidation,
  })
  expect(failed.ok).toBe(false)
  expect(failed.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "harness-compatibility", code: "RELEASE_HARNESS_MATRIX_INCOMPLETE" })]))
})
