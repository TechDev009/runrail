import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { timed } from "../../src/startup-timings.ts"

const previous = process.env.RUNRAIL_TIMINGS

afterEach(() => {
  if (previous === undefined) delete process.env.RUNRAIL_TIMINGS
  else process.env.RUNRAIL_TIMINGS = previous
})

describe("startup phase timings", () => {
  test("with RUNRAIL_TIMINGS=1, a phase's name and milliseconds go to stderr, even when it fails", async () => {
    process.env.RUNRAIL_TIMINGS = "1"
    const written: string[] = []
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    try {
      expect(await timed("plugins", async () => 7)).toBe(7)
      await expect(timed("carryover", async () => { throw new Error("boom") })).rejects.toThrow("boom")
    } finally {
      spy.mockRestore()
    }
    expect(written).toHaveLength(2)
    expect(written[0]).toMatch(/^\[runrail-timing\] plugins \d+\.\dms\n$/)
    expect(written[1]).toMatch(/^\[runrail-timing\] carryover \d+\.\dms\n$/)
  })

  test("without it, nothing is written", async () => {
    delete process.env.RUNRAIL_TIMINGS
    const spy = spyOn(process.stderr, "write")
    try {
      expect(await timed("plugins", async () => "done")).toBe("done")
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
