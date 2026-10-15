import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * No test reaches the real `~/.runrail/accounts` or the OS keychain. A command line a test spawns
 * inherits these unless it names its own directory or vault; the in-process defaults read them too.
 */
const accounts = mkdtempSync(join(tmpdir(), "runrail-test-accounts-"))
process.env.RUNRAIL_ACCOUNTS_DIR = accounts
// Nor ~/.runrail/sessions, where every `run` and `console` keeps its conversation.
const sessions = mkdtempSync(join(tmpdir(), "runrail-test-sessions-"))
process.env.RUNRAIL_SESSIONS_DIR = sessions
process.env.RUNRAIL_CREDENTIAL_VAULT = "memory"
// Nor does any test run the Codex desktop app's own CLI in place of a PATH test double.
process.env.RUNRAIL_CODEX_APP_SEARCH = "off"
process.on("exit", () => {
  rmSync(accounts, { recursive: true, force: true })
  rmSync(sessions, { recursive: true, force: true })
})
