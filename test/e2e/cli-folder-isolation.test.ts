import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { ISOLATED_BUN_FLAGS } from "../../src/isolated-bun.ts"
import { selfCommand } from "../../src/mcp/endpoint.ts"
import { RUNRAIL_VERSION } from "../../src/version.ts"

const cli = resolve(import.meta.dir, "../../src/cli.ts")
const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

/** A folder like a freshly cloned repository: its bunfig.toml preload leaves a mark, its .env moves the SDK folder. */
async function project(): Promise<{ readonly path: string; readonly mark: string; readonly env: Record<string, string | undefined> }> {
  const path = await mkdtemp(join(tmpdir(), "runrail-folder-isolation-"))
  folders.push(path)
  const mark = join(path, "preloaded")
  await writeFile(join(path, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
  await writeFile(join(path, "preload.ts"), `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(mark)}, "")\n`)
  await writeFile(join(path, ".env"), `RUNRAIL_AGENT_SDK_DIR=${join(path, "from-dotenv")}\n`)
  const { RUNRAIL_AGENT_SDK_DIR: _ignored, ...inherited } = process.env
  // The launcher runs the `bun` on PATH, as an installed command does.
  return { path, mark, env: { ...inherited, HOME: path, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` } }
}

async function output(command: readonly string[], cwd: string, env: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn([...command], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${String(code)}: ${stderr.trim()}`)
  return stdout
}

const sdkDirectory = async (command: readonly string[], cwd: string, env: Record<string, string | undefined>) =>
  (JSON.parse(await output([...command, "sdk", "status", "--json"], cwd, env)) as { directory?: unknown }).directory

test.skipIf(process.platform === "win32")("run as an installed command, the CLI loads neither the folder's bunfig.toml nor its .env", async () => {
  const { path, mark, env } = await project()
  const bin = await mkdtemp(join(tmpdir(), "runrail-folder-isolation-bin-"))
  folders.push(bin)
  // npm and Bun link the command to src/cli.ts, whose shebang the kernel follows.
  const runrail = [join(bin, "runrail")]
  await symlink(cli, runrail[0]!)
  expect((await output([...runrail, "--version"], path, env)).trim()).toBe(RUNRAIL_VERSION)
  expect(await sdkDirectory(runrail, path, env)).toBe(join(path, ".runrail", "agent-sdk"))
  expect(existsSync(mark)).toBe(false)
  // Plain `bun src/cli.ts` does load both, so the folder would show a regression.
  expect(await sdkDirectory([process.execPath, cli], path, env)).toBe(join(path, "from-dotenv"))
  expect(existsSync(mark)).toBe(true)
}, 30_000)

test.skipIf(process.platform === "win32")("the launcher line passes Bun the isolation flags", async () => {
  const [shebang, launcher] = (await readFile(cli, "utf8")).split("\n")
  expect(shebang).toBe("#!/bin/sh")
  expect(launcher).toBe(`// 2>/dev/null; exec bun ${ISOLATED_BUN_FLAGS.join(" ")} "$0" "$@"`)
})

test("the MCP servers Claude Code starts again run a script with the isolation flags", () => {
  expect(selfCommand()).toEqual([process.execPath, ...ISOLATED_BUN_FLAGS, Bun.main])
})
