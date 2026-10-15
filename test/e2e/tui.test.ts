import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { runRunrailTui } from "../../src/tui.ts"
import type { WorkbenchKey } from "../../src/workbench/input.ts"

test("TUI uses the native workbench for an injected terminal transport", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-tui-"))
  try {
    async function* keys(): AsyncIterable<WorkbenchKey> {
      yield { type: "text", text: "tui" }
      yield { type: "submit" }
    }
    const output: string[] = []
    const status = await runRunrailTui({
      cwd,
      backend: "native",
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "tui complete" }) },
      keys: keys(),
      output: { write: (text) => output.push(text) },
    })
    expect(status).toBe("completed")
    expect(output.join("")).toContain("tui complete")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
