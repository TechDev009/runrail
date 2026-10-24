import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "runrail-sdk-hint-"))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

/** A run with no `claude` on PATH, so it ends at once; the hint comes before the run starts. */
async function runCli(args: readonly string[]): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: cwd, RUNRAIL_AGENT_SDK_DIR: join(cwd, "agent-sdk") },
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr }
}

test("a Claude Code run without the SDK says it cannot ask before tools, with the command and the npm page", async () => {
  const { stderr } = await runCli(["run", "--backend", "claude-code", "--cwd", cwd, "--no-session", "--harness-auth", "subscription", "hi"])
  expect(stderr).toContain("Claude Code is running in print mode, so it cannot ask before it uses a tool.")
  expect(stderr).toContain("\n  runrail sdk install\n")
  expect(stderr).toContain("https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk")
})

test("runrail sdk reports where it would download the SDK, and never downloads when no one can say yes", async () => {
  const status = await runCli(["sdk", "status", "--json"])
  expect(JSON.parse(status.stdout)).toMatchObject({ ready: false, source: "installable", version: "0.3.288", downloadCommand: "runrail sdk install", directory: join(cwd, "agent-sdk") })
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "sdk", "install"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, RUNRAIL_AGENT_SDK_DIR: join(cwd, "agent-sdk") } })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(code).toBe(2)
  expect(stderr).toContain("Runrail can download the Claude Agent SDK 0.3.288 from npm into")
  expect(stderr).toContain("runrail sdk install --yes")
  expect(await Bun.file(join(cwd, "agent-sdk")).exists()).toBe(false)
})

test("--json, print mode asked for by name, and other backends say nothing about the SDK", async () => {
  for (const args of [["--backend", "claude-code", "--json"], ["--backend", "claude-code", "--harness-protocol", "print"], ["--backend", "replay"]]) {
    const { stderr, stdout } = await runCli(["run", ...args, "--cwd", cwd, "--no-session", "--harness-auth", "subscription", "hi"])
    expect(`${stdout}${stderr}`).not.toContain("Claude Agent SDK")
  }
})
