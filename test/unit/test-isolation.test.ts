import { expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

test("tests run with a throwaway accounts directory and no keychain", () => {
  expect(process.env.RUNRAIL_ACCOUNTS_DIR).toBeDefined()
  expect(process.env.RUNRAIL_ACCOUNTS_DIR?.startsWith(join(homedir(), ".runrail"))).toBe(false)
  expect(process.env.RUNRAIL_CREDENTIAL_VAULT).toBe("memory")
})
