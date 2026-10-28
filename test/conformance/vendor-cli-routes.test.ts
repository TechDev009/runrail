import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"
import { HarnessLaunchError, createClaudeCodeHarness, createCodexHarness, createFileVendorSessionStore } from "../../src/index.ts"
import { createVendorShims, type VendorShims } from "../fixtures/vendor-shim.ts"

interface Seen {
  readonly argv: readonly string[]
  readonly prompt: string
}

async function collect(backend: AgentBackend, sessionId: string, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message })) events.push(event)
  return events
}

/** What the fake binary says it was started with. */
function seen(events: readonly AgentEvent[]): Seen {
  const message = events.find((event) => event.type === "assistant.message")
  if (message?.type !== "assistant.message") throw new Error("the fixture gave no answer")
  return JSON.parse(message.text) as Seen
}

let shims: VendorShims
let state: string
const command: Record<string, string> = {}

beforeAll(async () => {
  shims = await createVendorShims()
  state = await mkdtemp(join(tmpdir(), "runrail-vendor-state-"))
  for (const kind of ["claude", "codex"] as const) {
    for (const mode of ["normal", "resume-missing", "unknown-event", "signed-out"] as const) {
      command[`${kind}:${mode}`] = await shims.add(`${kind}-${mode}`, [kind, mode])
    }
  }
})

afterAll(async () => {
  await shims.remove()
  await rm(state, { recursive: true, force: true })
})

describe("Claude Code print-mode route", () => {
  test("forwards the thread's settings as flags and the prompt on stdin", async () => {
    const backend = createClaudeCodeHarness({
      command: command["claude:normal"] as string,
      launch: { model: "opus", effort: "high", permissionMode: "ask", appendSystemPrompt: "-Prefer small diffs.", mcpConfig: ["/tmp/runrail-mcp.json"] },
    })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "claude-forwarding" })
    const prompt = "--help is not a flag here\nsecond line"
    const events = await collect(backend, session.id, prompt)
    // The stream never says a turn began, so the route announces it, with its prompt, for the client to show as sent.
    expect(events.map((event) => event.type)).toEqual(["turn.started", "session.started", "assistant.delta", "assistant.message", "session.completed"])
    expect(events[0]).toMatchObject({ type: "turn.started", prompt })
    expect(seen(events)).toEqual({
      argv: [
        "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--setting-sources", "user",
        "--mcp-config", "/tmp/runrail-mcp.json",
        "--allowedTools", "Grep(./**)", "Glob(./**)",
        "--model", "opus",
        "--effort", "high",
        "--permission-mode", "manual",
        "--append-system-prompt=-Prefer small diffs.",
      ],
      prompt,
    })
    await backend.close(session.id)
  })

  test("continues the conversation the CLI reported, turn after turn", async () => {
    const backend = createClaudeCodeHarness({ command: command["claude:normal"] as string, launch: { resume: "launch-session" } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "claude-resume" })
    const first = seen(await collect(backend, session.id, "first"))
    expect(first.argv.slice(-2)).toEqual(["--resume", "launch-session"])

    const fresh = createClaudeCodeHarness({ command: command["claude:normal"] as string, launch: { model: "sonnet" } })
    const freshSession = await fresh.createSession({ cwd: "/tmp", sessionId: "claude-fresh" })
    expect(seen(await collect(fresh, freshSession.id, "first")).argv).not.toContain("--resume")
    expect(seen(await collect(fresh, freshSession.id, "second")).argv.slice(-2)).toEqual(["--resume", "fixture-claude-session"])
    await backend.close(session.id)
    await fresh.close(freshSession.id)
  })

  test("keeps the conversation across a new backend through the session store", async () => {
    const directory = join(state, "claude-store")
    const options = { command: command["claude:normal"] as string, launch: { model: "sonnet" }, vendorSessions: createFileVendorSessionStore(directory, "claude-code") }
    const before = createClaudeCodeHarness(options)
    const session = await before.createSession({ cwd: "/tmp", sessionId: "claude-stored" })
    expect(seen(await collect(before, session.id, "first")).argv).not.toContain("--resume")
    await before.close(session.id)

    const after = createClaudeCodeHarness(options)
    await after.createSession({ cwd: "/tmp", sessionId: "claude-stored" })
    expect(seen(await collect(after, "claude-stored", "second")).argv.slice(-2)).toEqual(["--resume", "fixture-claude-session"])
    const other = await after.createSession({ cwd: "/tmp", sessionId: "claude-other-thread" })
    expect(seen(await collect(after, other.id, "first")).argv).not.toContain("--resume")
  })

  test("runs the prompt once from a clean start when the stored conversation is gone", async () => {
    const directory = join(state, "claude-missing")
    const store = createFileVendorSessionStore(directory, "claude-code")
    await store.save("claude-gone", "stale-session")
    const backend = createClaudeCodeHarness({ command: command["claude:resume-missing"] as string, launch: { model: "sonnet" }, vendorSessions: store })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "claude-gone" })
    const events = await collect(backend, session.id, "after the conversation was deleted")
    expect(events.map((event) => event.type)).toEqual(["turn.started", "session.started", "assistant.delta", "assistant.message", "session.completed"])
    expect(seen(events).argv).not.toContain("--resume")
    expect(seen(events).prompt).toBe("after the conversation was deleted")
    await backend.close(session.id)
    expect(await store.load("claude-gone")).toBe("fixture-claude-session")
  })

  test("skips an event it does not know unless told to be strict", async () => {
    const tolerant = createClaudeCodeHarness({ command: command["claude:unknown-event"] as string, launch: {} })
    const session = await tolerant.createSession({ cwd: "/tmp", sessionId: "claude-tolerant" })
    expect((await collect(tolerant, session.id, "go")).at(-1)).toMatchObject({ type: "session.completed" })

    const strict = createClaudeCodeHarness({ command: command["claude:unknown-event"] as string, launch: {}, tolerateUnknownEvents: false })
    const strictSession = await strict.createSession({ cwd: "/tmp", sessionId: "claude-strict" })
    await expect(collect(strict, strictSession.id, "go")).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })
  })

  test("reports a signed-out CLI and a missing CLI with stable codes", async () => {
    const signedOut = createClaudeCodeHarness({ command: command["claude:signed-out"] as string, launch: {} })
    const session = await signedOut.createSession({ cwd: "/tmp", sessionId: "claude-signed-out" })
    await expect(collect(signedOut, session.id, "go")).rejects.toMatchObject({ code: "COMMAND_AGENT_AUTH_FAILED" })

    const missing = createClaudeCodeHarness({ command: join(shims.directory, "claude-not-installed"), launch: {} })
    const missingSession = await missing.createSession({ cwd: "/tmp", sessionId: "claude-missing" })
    await expect(collect(missing, missingSession.id, "go")).rejects.toMatchObject({ code: "COMMAND_AGENT_NOT_FOUND" })
  })

  test("refuses launch settings on a command line the caller shaped by hand", () => {
    const shaped = command["claude:normal"] as string
    expect(() => createClaudeCodeHarness({ command: shaped, args: ["--print"], launch: { model: "opus" } })).toThrow(HarnessLaunchError)
    expect(() => createClaudeCodeHarness({ command: shaped, promptMode: "argument", launch: { model: "opus" } })).toThrow(HarnessLaunchError)
    expect(() => createClaudeCodeHarness({ command: shaped, persistent: true, launch: { model: "opus" } })).toThrow(HarnessLaunchError)
    expect(() => createClaudeCodeHarness({ command: shaped, launch: { model: "--flag" } })).toThrow(HarnessLaunchError)
    expect(() => createClaudeCodeHarness({ command: shaped, launch: { unknown: true } as never })).toThrow(HarnessLaunchError)
  })
})

describe("Codex exec route", () => {
  test("forwards the thread's settings and reads the prompt from stdin", async () => {
    const backend = createCodexHarness({ command: command["codex:normal"] as string, launch: { model: "gpt-fixture", effort: "max", permissionMode: "accept-edits", appendSystemPrompt: "Prefer small diffs." } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-forwarding" })
    const prompt = "-c sandbox_mode=danger-full-access"
    const events = await collect(backend, session.id, prompt)
    // Codex's own `turn.started` carries no prompt; the route's announcement replaces it.
    expect(events.map((event) => event.type)).toEqual(["turn.started", "session.started", "assistant.message", "session.completed"])
    expect(events[0]).toMatchObject({ type: "turn.started", prompt })
    expect(seen(events)).toEqual({
      argv: ["exec", "--json", "-m", "gpt-fixture", "-c", "model_reasoning_effort=max", "-c", "sandbox_mode=workspace-write", "-c", 'developer_instructions="Prefer small diffs."', "-"],
      prompt,
    })
    expect(seen(await collect(backend, session.id, "second")).argv).toEqual(["exec", "resume", "--json", "-m", "gpt-fixture", "-c", "model_reasoning_effort=max", "-c", "sandbox_mode=workspace-write", "-c", 'developer_instructions="Prefer small diffs."', "fixture-codex-thread", "-"])
    await backend.close(session.id)
  })

  test("keeps the thread across a new backend and recovers when the thread is gone", async () => {
    const directory = join(state, "codex-store")
    const store = createFileVendorSessionStore(directory, "codex")
    const before = createCodexHarness({ command: command["codex:normal"] as string, launch: {}, vendorSessions: store })
    const session = await before.createSession({ cwd: "/tmp", sessionId: "codex-stored" })
    expect(seen(await collect(before, session.id, "first")).argv).toEqual(["exec", "--json", "-"])
    await before.close(session.id)

    const after = createCodexHarness({ command: command["codex:normal"] as string, launch: {}, vendorSessions: store })
    await after.createSession({ cwd: "/tmp", sessionId: "codex-stored" })
    expect(seen(await collect(after, "codex-stored", "second")).argv).toEqual(["exec", "resume", "--json", "fixture-codex-thread", "-"])

    await store.save("codex-gone", "stale-thread")
    const gone = createCodexHarness({ command: command["codex:resume-missing"] as string, launch: {}, vendorSessions: store })
    await gone.createSession({ cwd: "/tmp", sessionId: "codex-gone" })
    const events = await collect(gone, "codex-gone", "after the thread was deleted")
    expect(seen(events)).toEqual({ argv: ["exec", "--json", "-"], prompt: "after the thread was deleted" })
    expect(events.filter((event) => event.type === "session.completed")).toHaveLength(1)
    await gone.close("codex-gone")
    expect(await store.load("codex-gone")).toBe("fixture-codex-thread")
  })

  test("skips an unknown event unless strict, and takes no MCP configuration", async () => {
    const tolerant = createCodexHarness({ command: command["codex:unknown-event"] as string, launch: {} })
    const session = await tolerant.createSession({ cwd: "/tmp", sessionId: "codex-tolerant" })
    expect((await collect(tolerant, session.id, "go")).at(-1)).toMatchObject({ type: "session.completed" })

    const strict = createCodexHarness({ command: command["codex:unknown-event"] as string, launch: {}, tolerateUnknownEvents: false })
    const strictSession = await strict.createSession({ cwd: "/tmp", sessionId: "codex-strict" })
    await expect(collect(strict, strictSession.id, "go")).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })

    const shaped = command["codex:normal"] as string
    expect(() => createCodexHarness({ command: shaped, launch: { mcpConfig: ["/tmp/mcp.json"] } })).toThrow(HarnessLaunchError)
    expect(() => createCodexHarness({ command: shaped, args: ["exec", "--json"], launch: { model: "gpt-fixture" } })).toThrow(HarnessLaunchError)
    expect(() => createCodexHarness({ command: shaped, persistent: true, launch: { model: "gpt-fixture" } })).toThrow(HarnessLaunchError)
  })

  test("a custom command without launch settings keeps its own prompt protocol", async () => {
    const fixture = new URL("../fixtures/vendor-harness.ts", import.meta.url).pathname
    const backend = createCodexHarness({ command: process.execPath, args: [fixture, "codex"] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-custom" })
    expect((await collect(backend, session.id, "legacy")).at(-1)).toMatchObject({ type: "session.completed" })
  })
})
