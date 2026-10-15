import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createFileVendorSessionStore, forgetVendorSessions } from "../../src/harness/vendor-session-store.ts"

/** A rewind forgets the tool's own conversation, for every tool and account folder, and only this session's. */

let dir: string
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("every conversation a session kept goes, and other sessions' stay", async () => {
  dir = await mkdtemp(join("/tmp", "runrail-vendor-forget-"))
  await createFileVendorSessionStore(dir, "claude-code").save("th-1", "vendor-a")
  await createFileVendorSessionStore(dir, "claude-code.0123456789abcdef").save("th-1", "vendor-b")
  await createFileVendorSessionStore(dir, "codex").save("th-2", "vendor-c")
  expect(await forgetVendorSessions(dir, "th-1")).toBe(2)
  expect(await createFileVendorSessionStore(dir, "claude-code").load("th-1")).toBeUndefined()
  expect(await createFileVendorSessionStore(dir, "codex").load("th-2")).toBe("vendor-c")
  expect(await readdir(dir)).toHaveLength(1)
  expect(await forgetVendorSessions(join(dir, "missing"), "th-1")).toBe(0)
})
