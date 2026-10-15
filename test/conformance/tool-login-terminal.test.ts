import { afterEach, describe, expect, test } from "bun:test"
import { createToolLogins, type ToolLogins } from "../../src/harness/login-terminal.ts"

const open: ToolLogins[] = []
afterEach(async () => {
  for (const logins of open.splice(0)) await logins.dispose()
})

function logins(options: Parameters<typeof createToolLogins>[0] = {}): ToolLogins {
  const created = createToolLogins(options)
  open.push(created)
  return created
}

const sleeper = (connectionId: string) => ({ connectionId, command: "/bin/sleep", args: ["30"], env: {}, cols: 80, rows: 16 })

describe("coding-tool sign-in terminals", () => {
  test("runs the command it is given with its own environment, and reads back what it printed", async () => {
    const terminals = logins()
    process.env.RUNRAIL_TEST_SECRET = "must-not-pass"
    const { loginId } = terminals.start({ connectionId: "codex-1", command: "/usr/bin/env", args: [], env: { CODEX_HOME: "/tmp/runrail-login-home" }, cols: 80, rows: 16 })
    let text = ""
    let closed = false
    for (let tries = 0; tries < 100 && !closed; tries += 1) {
      const read = await terminals.read(loginId, 0, 64 * 1024)
      text = read.chunks.map((chunk) => chunk.data).join("")
      closed = read.closed
      if (!closed) await Bun.sleep(20)
    }
    delete process.env.RUNRAIL_TEST_SECRET
    expect([closed, text.includes("CODEX_HOME=/tmp/runrail-login-home")]).toEqual([true, true])
    // Nothing from this process's environment beyond the filtered set reaches the tool.
    expect(text).not.toContain("must-not-pass")
  })

  test("refuses a tool that is not installed, and more sign-ins than its limit", async () => {
    const terminals = logins({ maxLogins: 2 })
    expect(() => terminals.start({ ...sleeper("claude-code-1"), command: "runrail-no-such-tool" })).toThrow(expect.objectContaining({ code: "TOOL_LOGIN_TOOL_MISSING" }))
    expect(() => terminals.start({ ...sleeper("claude-code-1"), command: "/no/such/tool" })).toThrow(expect.objectContaining({ code: "TOOL_LOGIN_TOOL_MISSING" }))
    terminals.start(sleeper("claude-code-1"))
    terminals.start(sleeper("codex-1"))
    expect(() => terminals.start(sleeper("claude-code-2"))).toThrow(expect.objectContaining({ code: "TOOL_LOGIN_LIMIT" }))
  })

  test("a sign-in left open ends by itself", async () => {
    const terminals = logins({ timeoutMs: 50 })
    const { loginId } = terminals.start(sleeper("claude-code-1"))
    await Bun.sleep(300)
    await expect(terminals.read(loginId, 0, 4_096)).rejects.toMatchObject({ code: "TOOL_LOGIN_NOT_FOUND" })
  })
})
