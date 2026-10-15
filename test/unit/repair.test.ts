import { describe, expect, test } from "bun:test"
import { RepairController } from "../../src/repair/controller.ts"

const failure = { name: "check" as const, ok: false, status: 1, error: "type mismatch" }

describe("repair controller", () => {
  test("bounds attempts and stops repeated failures", () => {
    const controller = new RepairController(2)
    expect(controller.next(failure, "/tmp/project").kind).toBe("repair")
    expect(controller.next(failure, "/tmp/project")).toEqual({ kind: "exhausted", reason: "repeated_failure" })
    expect(controller.attemptCount).toBe(1)
  })

  test("supports zero repair attempts", () => {
    expect(new RepairController(0).next(failure, "/tmp/project")).toEqual({ kind: "exhausted", reason: "attempt_cap" })
  })
})
