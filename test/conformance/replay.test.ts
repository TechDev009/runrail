import { expect, test } from "bun:test"
import { runRunrail } from "../../src/cli.ts"

test("replay produces a deterministic terminal digest", async () => {
  const first = await runRunrail({ cwd: process.cwd(), backend: "replay" })
  const second = await runRunrail({ cwd: process.cwd(), backend: "replay" })
  expect(first.status).toBe("succeeded")
  expect(second.digest).toBe(first.digest)
})
