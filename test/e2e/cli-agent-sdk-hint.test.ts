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
    env: { ...process.env, PATH: cwd },
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr }
}

test("a Claude Code run without the SDK says it cannot ask before tools, with the command and the npm page", async () => {
  const { stderr } = await runCli(["run", "--backend", "claude-code", "--cwd", cwd, "--no-session", "--harness-auth", "subscription", "hi"])
  expect(stderr).toContain("Claude Code is running in print mode, so it cannot ask before it uses a tool.")
  expect(stderr).toContain("bun add --no-save @anthropic-ai/claude-agent-sdk@^0.3.288")
  expect(stderr).toContain("https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk")
})

test("--json, print mode asked for by name, and other backends say nothing about the SDK", async () => {
  for (const args of [["--backend", "claude-code", "--json"], ["--backend", "claude-code", "--harness-protocol", "print"], ["--backend", "replay"]]) {
    const { stderr, stdout } = await runCli(["run", ...args, "--cwd", cwd, "--no-session", "--harness-auth", "subscription", "hi"])
    expect(`${stdout}${stderr}`).not.toContain("Claude Agent SDK")
  }
})
