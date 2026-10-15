import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkTerminalShell, listLoginShells } from "../../src/terminal/pty.ts"

let root = ""
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-terminal-shell-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

test("the login shells are the existing absolute paths the system lists", async () => {
  const file = join(root, "shells")
  const zsh = join(root, "zsh")
  await writeFile(zsh, "")
  await writeFile(file, ["# List of acceptable shells", "/bin/sh", "/bin/sh", `  ${zsh}  `, "relative/sh", join(root, "missing-shell"), ""].join("\n"))
  expect(listLoginShells(file)).toEqual(["/bin/sh", zsh])
  expect(listLoginShells(join(root, "no-such-file"))).toEqual([])
})

test("a terminal shell must be one of them", () => {
  expect(checkTerminalShell("/bin/zsh", ["/bin/sh", "/bin/zsh"])).toBe("/bin/zsh")
  for (const shell of ["/usr/bin/python3", "zsh", "/bin/zsh -c id", ""]) expect(() => checkTerminalShell(shell, ["/bin/sh", "/bin/zsh"])).toThrow("login shells")
})

test("the control command takes --terminal-shell only with --terminal and only a listed shell", async () => {
  const cli = join(import.meta.dir, "../../src/cli.ts")
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([process.execPath, cli, "control", ...args, "--cwd", root, "--port", "0"], { stdout: "ignore", stderr: "pipe", stdin: "ignore" })
    const timer = setTimeout(() => child.kill(), 5_000)
    const stderr = await new Response(child.stderr).text()
    clearTimeout(timer)
    return { code: await child.exited, stderr }
  }
  expect((await run(["--terminal-shell", "/bin/sh"])).stderr).toContain("--terminal-shell requires --terminal")
  expect((await run(["--terminal", "--terminal-shell", "/usr/bin/true"])).stderr).toContain("login shells")
})
