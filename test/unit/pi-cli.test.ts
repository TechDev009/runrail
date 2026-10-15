import { describe, expect, test } from "bun:test"
import { parseCliArgs, runPiPassthrough } from "../../src/cli.ts"

describe("Pi compatibility command", () => {
  test("keeps Pi arguments opaque", () => {
    expect(parseCliArgs(["pi", "--model", "openai/gpt", "--", "inspect this"])).toMatchObject({
      command: "pi",
      piArgs: ["--model", "openai/gpt", "--", "inspect this"],
    })
  })

  test("returns the Pi process exit code", async () => {
    const status = await runPiPassthrough(["-e", "process.exit(17)"], {
      command: process.execPath,
    })
    expect(status).toBe(17)
  })
})
