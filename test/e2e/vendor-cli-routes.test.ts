import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// The installed-CLI routes through the real `runrail` entry point. Stand-ins named `claude`,
// `codex` and `copilot` go first on PATH; each records what Runrail handed it, because a run's own output
// deliberately carries no prompt or answer text.
const cli = resolve(import.meta.dir, "../../src/cli.ts")
const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
const claudeFixture = resolve(import.meta.dir, "../fixtures/vendor-cli.ts")
const codexFixture = resolve(import.meta.dir, "../fixtures/codex-app-server.ts")
const acpFixture = resolve(import.meta.dir, "../fixtures/acp-agent.ts")

let root: string
let bin: string
let empty: string
let workspace: string
let claudeLog: string
let codexLog: string
let copilotLog: string
let copilotArgv: string

interface Run {
  readonly status: number
  readonly result: { readonly status?: string; readonly events?: readonly { readonly type: string; readonly code?: string }[] }
  readonly raw: string
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function runCli(args: readonly string[], path: string): Promise<Run> {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: path } })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  let result: Run["result"] = {}
  try {
    result = JSON.parse(stdout) as Run["result"]
  } catch {
    // A rejected command line prints a message, not a result.
  }
  return { status, result, raw: `${stdout}\n${stderr}` }
}

function route(backend: string, sessionDir: string, extra: readonly string[] = []): string[] {
  return ["run", "--backend", backend, "--cwd", workspace, "--session-dir", sessionDir, "--session-id", "route-thread", "--verification-command", verifier, "--max-repair-attempts", "0", "--harness-auth", "subscription", ...extra, "--json", "say hi"]
}

async function claudeRuns(): Promise<string[][]> {
  const text = await readFile(claudeLog, "utf8").catch(() => "")
  return text.split("RUN\n").slice(1).map((run) => run.split("\n").filter((line) => line.length > 0))
}

async function codexRequests(log: string = codexLog): Promise<{ readonly method: string; readonly params?: Record<string, unknown> }[]> {
  const text = await readFile(log, "utf8").catch(() => "")
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-route-e2e-"))
  bin = join(root, "bin")
  empty = join(root, "empty")
  workspace = join(root, "workspace")
  claudeLog = join(root, "claude-argv.log")
  codexLog = join(root, "codex-stdin.log")
  copilotLog = join(root, "copilot-stdin.log")
  copilotArgv = join(root, "copilot-argv.log")
  await Promise.all([mkdir(bin), mkdir(empty), mkdir(workspace)])
  await writeFile(join(bin, "claude"), `#!/bin/sh\n{ echo RUN; printf '%s\\n' "$@"; } >> ${quote(claudeLog)}\nexec ${quote(process.execPath)} ${quote(claudeFixture)} claude normal "$@"\n`, { mode: 0o755 })
  await writeFile(join(bin, "codex"), `#!/bin/sh\ntee -a ${quote(codexLog)} | ${quote(process.execPath)} ${quote(codexFixture)} echo "$@"\n`, { mode: 0o755 })
  await writeFile(join(bin, "copilot"), `#!/bin/sh\n{ echo RUN; printf '%s\\n' "$@"; } >> ${quote(copilotArgv)}\ntee -a ${quote(copilotLog)} | ${quote(process.execPath)} ${quote(acpFixture)} echo "$@"\n`, { mode: 0o755 })
  await Promise.all([chmod(join(bin, "claude"), 0o755), chmod(join(bin, "codex"), 0o755), chmod(join(bin, "copilot"), 0o755)])
  await writeFile(join(root, "ask.json"), JSON.stringify({ version: 1, mode: "ask", effort: "high", instructions: { text: "Prefer small diffs." }, permissions: { default: "ask", rules: [] }, compaction: { enabled: true } }))
  await writeFile(join(root, "full.json"), JSON.stringify({ version: 1, mode: "auto", effort: "low", permissions: { default: "allow", rules: [] }, compaction: { enabled: true } }))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("installed coding tool routes through the CLI", () => {
  test("Claude Code gets the thread's model, effort, permission mode, and instructions, then continues its conversation", async () => {
    const path = `${bin}:${process.env.PATH ?? ""}`
    const sessionDir = join(root, "claude-session")
    const first = await runCli(route("claude-code", sessionDir, ["--config", join(root, "ask.json"), "--model", "opus", "--thinking", "high"]), path)
    expect(first.result.status).toBe("succeeded")
    expect(first.result.events?.map((event) => event.type)).toEqual(["session.started", "turn.started", "assistant.delta", "assistant.message", "session.completed", "verification.completed"])
    // The run's output names events only; the prompt and the answer stay out of it.
    expect(first.raw).not.toContain("say hi")
    expect(first.raw).not.toContain("Prefer small diffs")

    expect(await claudeRuns()).toEqual([["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--setting-sources", "user", "--allowedTools", "Grep(./**)", "Glob(./**)", "--model", "opus", "--effort", "high", "--permission-mode", "manual", "--append-system-prompt=Prefer small diffs."]])
    const stored = await readdir(join(sessionDir, "harness"))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/^claude-code-[0-9a-f]{32}\.json$/)

    // A second engine process for the same thread picks the conversation up, with the settings of the day.
    const second = await runCli(route("claude-code", sessionDir, ["--config", join(root, "full.json"), "--model", "sonnet"]), path)
    expect(second.result.status).toBe("succeeded")
    expect((await claudeRuns())[1]).toEqual(["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--setting-sources", "user", "--allowedTools", "Grep(./**)", "Glob(./**)", "--model", "sonnet", "--effort", "low", "--permission-mode", "bypassPermissions", "--resume", "fixture-claude-session"])
  }, { timeout: 30_000 })

  test("explicit launch flags win over what the thread's settings imply", async () => {
    const path = `${bin}:${process.env.PATH ?? ""}`
    const before = (await claudeRuns()).length
    const run = await runCli(route("claude-code", join(root, "claude-explicit"), ["--config", join(root, "full.json"), "--harness-effort", "max", "--harness-permission-mode", "plan", "--harness-append-system-prompt", "Answer in one line.", "--harness-mcp-config", "/tmp/route-mcp.json", "--harness-resume", "chosen-session"]), path)
    expect(run.result.status).toBe("succeeded")
    expect((await claudeRuns())[before]).toEqual(["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--setting-sources", "user", "--mcp-config", "/tmp/route-mcp.json", "--allowedTools", "Grep(./**)", "Glob(./**)", "--effort", "max", "--permission-mode", "plan", "--append-system-prompt=Answer in one line.", "--resume", "chosen-session"])
  }, { timeout: 30_000 })

  test("Codex runs on its app-server by default and resumes its thread", async () => {
    const path = `${bin}:${process.env.PATH ?? ""}`
    const sessionDir = join(root, "codex-session")
    const first = await runCli(route("codex", sessionDir, ["--config", join(root, "ask.json"), "--model", "gpt-fixture", "--thinking", "high"]), path)
    expect(first.result.status).toBe("succeeded")
    expect(first.result.events?.map((event) => event.type)).toContain("turn.started")
    // Codex is also asked which levels each model takes; that request runs alongside the thread's.
    const asked = await codexRequests()
    expect(asked.map((request) => request.method)).toContain("model/list")
    const requests = asked.filter((request) => request.method !== "model/list")
    expect(requests.map((request) => request.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"])
    expect(requests[0]?.params).toMatchObject({ clientInfo: { name: "runrail", title: "Runrail" } })
    expect(requests[2]?.params).toEqual({ cwd: expect.stringContaining("workspace"), model: "gpt-fixture", approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write", developerInstructions: "Prefer small diffs." })
    expect(requests[3]?.params).toMatchObject({ threadId: "fixture-codex-thread", effort: "high" })
    expect((await readdir(join(sessionDir, "harness")))[0]).toMatch(/^codex-[0-9a-f]{32}\.json$/)

    const second = await runCli(route("codex", sessionDir, ["--config", join(root, "full.json")]), path)
    expect(second.result.status).toBe("succeeded")
    const resumed = (await codexRequests()).slice(asked.length).filter((request) => request.method !== "model/list")
    expect(resumed.map((request) => request.method)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"])
    expect(resumed[2]?.params).toEqual({ threadId: "fixture-codex-thread", cwd: expect.stringContaining("workspace"), excludeTurns: true, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" })
    expect(resumed[3]?.params).toMatchObject({ threadId: "fixture-codex-thread", effort: "low" })
  }, { timeout: 30_000 })

  test("a saved Codex session picked up with --resume continues the same Codex thread", async () => {
    const path = `${bin}:${process.env.PATH ?? ""}`
    const before = (await codexRequests()).length
    const first = await runCli(["run", "--backend", "codex", "--cwd", workspace, "--verification-command", verifier, "--max-repair-attempts", "0", "--harness-auth", "subscription", "--json", "say hi"], path)
    expect(first.result.status).toBe("succeeded")
    const id = (first.result as { readonly sessionId?: string }).sessionId
    expect(id).toMatch(/^[a-f][0-9a-f]{7}-/)
    expect(first.raw).not.toContain("Continue it with")
    const started = (await codexRequests()).slice(before).filter((request) => request.method !== "model/list")
    expect(started.map((request) => request.method)).toContain("thread/start")

    const asked = (await codexRequests()).length
    const second = await runCli(["run", "--resume", id!, "--verification-command", verifier, "--max-repair-attempts", "0", "--json", "and again"], path)
    expect(second.result.status).toBe("succeeded")
    const resumed = (await codexRequests()).slice(asked).map((request) => request.method).filter((method) => method.startsWith("thread/") || method.startsWith("turn/"))
    expect(resumed).toEqual(["thread/resume", "turn/start"])
  }, { timeout: 30_000 })

  test("Copilot runs in its protocol mode with the thread's settings and opens its conversation again", async () => {
    const path = `${bin}:${process.env.PATH ?? ""}`
    const sessionDir = join(root, "copilot-session")
    const first = await runCli(route("copilot", sessionDir, ["--config", join(root, "ask.json"), "--model", "gpt-fixture", "--thinking", "high"]), path)
    expect(first.result.status).toBe("succeeded")
    expect(first.result.events?.map((event) => event.type)).toEqual(["session.started", "turn.started", "assistant.delta", "assistant.message", "session.completed", "verification.completed"])
    expect(first.raw).not.toContain("say hi")
    expect(first.raw).not.toContain("Prefer small diffs")

    const argv = async (): Promise<string[][]> => (await readFile(copilotArgv, "utf8").catch(() => "")).split("RUN\n").slice(1).map((run) => run.split("\n").filter((line) => line.length > 0))
    expect(await argv()).toEqual([["--acp", "--model", "gpt-fixture", "--effort", "high"]])
    const requests = await codexRequests(copilotLog)
    expect(requests.map((request) => request.method)).toEqual(["initialize", "session/new", "session/prompt"])
    expect(requests[0]?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "runrail" } })
    expect(requests[1]?.params).toEqual({ cwd: expect.stringContaining("workspace"), mcpServers: [] })
    expect(requests[2]?.params).toEqual({ sessionId: "fixture-acp-session", prompt: [{ type: "text", text: "Instructions for this conversation, set by the user:\n\nPrefer small diffs." }, { type: "text", text: "say hi" }] })
    expect((await readdir(join(sessionDir, "harness")))[0]).toMatch(/^copilot-[0-9a-f]{32}\.json$/)

    // A second engine process for the same thread loads the conversation and does not repeat its instructions.
    const second = await runCli(route("copilot", sessionDir, ["--config", join(root, "full.json"), "--harness-effort", "max"]), path)
    expect(second.result.status).toBe("succeeded")
    expect((await argv())[1]).toEqual(["--acp", "--effort", "max"])
    const resumed = (await codexRequests(copilotLog)).slice(requests.length)
    expect(resumed.map((request) => request.method)).toEqual(["initialize", "session/load", "session/prompt"])
    expect(resumed[1]?.params).toEqual({ sessionId: "fixture-acp-session", cwd: expect.stringContaining("workspace"), mcpServers: [] })
    expect(resumed[2]?.params).toEqual({ sessionId: "fixture-acp-session", prompt: [{ type: "text", text: "say hi" }] })
  }, { timeout: 30_000 })

  test("a tool that is not installed fails the run with a stable code, and misuse is refused up front", async () => {
    // PATH holds nothing, so the developer's real tools cannot be reached from this test.
    for (const backend of ["claude-code", "codex", "copilot"]) {
      const missing = await runCli(route(backend, join(root, `missing-${backend}`)), empty)
      expect(missing.status).toBe(1)
      expect(missing.result.status).toBe("unrecoverable")
      expect(missing.result.events?.at(-1)).toMatchObject({ type: "session.failed", code: "COMMAND_AGENT_NOT_FOUND" })
    }
    const refused: readonly (readonly string[])[] = [
      ["run", "--backend", "native", "--cwd", workspace, "--harness-effort", "high", "task"],
      ["run", "--backend", "codex", "--cwd", workspace, "--harness-mcp-config", "/tmp/route-mcp.json", "task"],
      ["run", "--backend", "claude-code", "--cwd", workspace, "--harness-command", "anything", "--harness-effort", "high", "task"],
      ["run", "--backend", "claude-code", "--cwd", workspace, "--harness-persistent", "--harness-resume", "chosen-session", "task"],
      ["run", "--backend", "copilot", "--cwd", workspace, "--harness-mcp-config", "/tmp/route-mcp.json", "task"],
      ["run", "--backend", "copilot", "--cwd", workspace, "--harness-protocol", "jsonl", "task"],
      ["run", "--backend", "copilot", "--cwd", workspace, "--harness-persistent", "task"],
    ]
    for (const args of refused) {
      const run = await runCli(args, empty)
      expect(run.status).not.toBe(0)
      expect(run.result.status).toBeUndefined()
    }
  }, { timeout: 30_000 })
})

describe("a one-shot coding tool run ends on its own", () => {
  async function standIn(mode: string, ...args: string[]): Promise<string> {
    const dir = join(root, `bin-${mode}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "codex"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(codexFixture)} ${mode} ${args.map(quote).join(" ")}\n`, { mode: 0o755 })
    return `${dir}:${process.env.PATH ?? ""}`
  }

  test("an approval no one can answer is declined, and the run says how to allow it", async () => {
    const path = await standIn("approval")
    const run = await runCli(route("codex", join(root, "approval-session")), path)
    expect(run.status).toBe(1)
    expect(run.result.status).toBe("denied")
    expect(run.result.events?.at(-1)).toMatchObject({ type: "session.failed", code: "APPROVAL_DENIED" })

    const text = await runCli(route("codex", join(root, "approval-text")).filter((arg) => arg !== "--json"), path)
    expect(text.raw).toContain("declined: runrail run cannot answer approvals; choose what the tool may do with --harness-permission-mode")
  }, { timeout: 30_000 })

  test("a time budget ends a turn the tool never finishes and never lets go of", async () => {
    const pidFile = join(root, "silent.pid")
    const path = await standIn("silent", pidFile)
    const started = performance.now()
    const run = await runCli(route("codex", join(root, "silent-session"), ["--max-duration-ms", "1500"]), path)
    expect(performance.now() - started).toBeLessThan(15_000)
    expect(run.status).toBe(1)
    expect(run.result.status).toBe("unrecoverable")
    expect(run.result.events?.at(-1)).toMatchObject({ type: "session.failed", code: "BUDGET_TIME_EXCEEDED" })
    const pid = Number(await readFile(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  }, { timeout: 30_000 })

  test("token, cost, and tool-call limits are refused for a coding tool, which reports none of them first", async () => {
    const path = await standIn("echo")
    for (const flag of [["--max-total-tokens", "100"], ["--max-cost-usd", "1"], ["--max-tool-calls", "3"]]) {
      const run = await runCli(route("codex", join(root, "budget-refused"), flag), path)
      expect(run.status).toBe(2)
      expect(run.raw).toContain("need the native backend; a coding tool takes only maxDurationMs")
    }
  }, { timeout: 30_000 })
})
