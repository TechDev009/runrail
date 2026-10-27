import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAgentEvent, type AgentBackend, type AgentEvent } from "@nifrajs/agent-protocol"
import {
  AcpAgentBackend,
  acpPermissionDecision,
  createCopilotHarness,
  createDefaultBackendRegistry,
  createDefaultHarnessAdapters,
  createFileVendorSessionStore,
  createGeminiHarness,
  createGooseHarness,
  createOpenCodeHarness,
  geminiSettingArguments,
  openCodePermission,
  type AcpAgentBackendOptions,
  type CopilotHarnessOptions,
} from "../../src/index.ts"
import type { RunrailLiveFrameInput } from "../../src/live/types.ts"
import { describeToolCall } from "../../src/tools/presentation.ts"

const fixture = new URL("../fixtures/acp-agent.ts", import.meta.url).pathname

interface Echo {
  readonly argv: readonly string[]
  readonly session: { readonly method: string; readonly params: Record<string, unknown> }
  readonly prompt: readonly { readonly type: string; readonly text: string }[]
  readonly setModel: readonly string[]
  readonly setMode: readonly string[]
  readonly setConfig: readonly string[]
  readonly forked: readonly string[]
  readonly env: { readonly OPENCODE_PERMISSION: string | null; readonly GOOSE_MODE: string | null }
}

function copilot(mode: string, options: CopilotHarnessOptions = {}): AcpAgentBackend {
  return createCopilotHarness({ command: process.execPath, args: [fixture, mode, "--acp"], ...options })
}

async function collect(backend: AgentBackend, sessionId: string, message: string, decide?: boolean): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message })) {
    events.push(event)
    if (event.type === "approval.required" && decide !== undefined) await backend.resolveApproval?.(sessionId, event.approvalId, decide, decide ? "approved by test" : "declined by test")
  }
  return events
}

const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type)

test.each([createCopilotHarness, createOpenCodeHarness, createGeminiHarness, createGooseHarness])("ACP tools report a model quota rejection without exposing vendor payloads: %p", async (create) => {
  const backend = create({ command: process.execPath, args: [fixture, "prompt-quota"] })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-quota" })
  try {
    const events = await collect(backend, session.id, "hello")
    expect(events.at(-1)).toMatchObject({ type: "session.failed", recoverable: false, error: { code: "COMMAND_AGENT_RATE_LIMITED", message: expect.stringContaining("weekly usage limit reached") } })
    expect(JSON.stringify(events)).not.toContain("sk-fixture")
  } finally {
    await backend.close?.(session.id)
  }
})

function answer(events: readonly AgentEvent[]): string {
  const message = events.filter((event) => event.type === "assistant.message").at(-1)
  if (message?.type !== "assistant.message") throw new Error("the fixture gave no answer")
  return message.text
}

const echo = (events: readonly AgentEvent[]): Echo => JSON.parse(answer(events)) as Echo

async function failure(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : `unexpected:${String(error)}`
  }
  return "no error"
}

let state: string

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "runrail-acp-state-"))
})

afterAll(async () => {
  await rm(state, { recursive: true, force: true })
})

describe("a coding tool over the Agent Client Protocol", () => {
  test("a reply past one event's text arrives whole as consecutive valid events", async () => {
    const backend = copilot("long-reply")
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-long-reply" })
    try {
      const events = await collect(backend, session.id, "say a lot")
      expect(events.at(-1)?.type).toBe("session.completed")
      expect(events.every(isAgentEvent)).toBe(true)
      const text = (type: string): string[] => events.flatMap((event) => (event.type === type && "text" in event ? [event.text] : []))
      const expected = `${"r".repeat(300_000)}\uFFFDend`
      expect(text("assistant.message")).toHaveLength(2)
      expect(text("assistant.message").join("")).toBe(expected)
      expect(text("assistant.delta").join("")).toBe(expected)
    } finally {
      await backend.close(session.id)
    }
  })

  test("a turn becomes Runrail events, with each stretch of text a message of its own", async () => {
    const live: RunrailLiveFrameInput[] = []
    const backend = copilot("normal", { onLive: (frame) => void live.push(frame) })
    expect(backend.info).toMatchObject({ name: "copilot", capabilities: ["approvals", "models", "persistent", "reload", "resume", "sessions", "streaming", "thinking", "tools"] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-normal" })
    expect(session).toMatchObject({ id: "acp-normal", backend: "copilot", status: "idle" })

    const events = await collect(backend, session.id, "what is in the package file?")
    expect(types(events)).toEqual(["session.started", "turn.started", "assistant.delta", "assistant.message", "tool.started", "tool.completed", "tool.started", "tool.completed", "assistant.delta", "assistant.message", "session.completed"])
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
    expect(events[1]).toMatchObject({ type: "turn.started", turnId: "turn-1", prompt: "what is in the package file?" })
    expect(events[3]).toMatchObject({ type: "assistant.message", text: "Looking. " })
    expect(events[4]).toMatchObject({ type: "tool.started", callId: "call-1", name: "read", input: { title: "Read package.json", input: { path: "package.json" }, locations: [{ path: "package.json" }] } })
    expect(events[5]).toMatchObject({ type: "tool.completed", callId: "call-1", name: "read", ok: true, output: "file text" })
    // A call first heard of when it failed is still one start and one end.
    expect(events[6]).toMatchObject({ type: "tool.started", callId: "late-1", name: "execute" })
    expect(events[7]).toMatchObject({ type: "tool.completed", callId: "late-1", ok: false, error: { code: "ACP_TOOL_FAILED" } })
    expect(answer(events)).toBe("fixture answer 1")
    expect(live).toEqual([
      { type: "reasoning.delta", turnId: "turn-1", text: "thinking it over" },
      { type: "plan.updated", turnId: "turn-1", steps: [{ text: "Read the file", status: "completed" }, { text: "Answer", status: "in_progress" }] },
    ])
    expect(await backend.snapshot(session.id)).toMatchObject({ status: "completed", lastSeq: 10 })

    // The same process and conversation serve the next turn.
    const second = await collect(backend, session.id, "again")
    expect(types(second)[0]).toBe("turn.started")
    expect(answer(second)).toBe("fixture answer 2")
    expect(second[0]!.seq).toBe(11)
    await backend.close(session.id)
    expect(await failure(() => backend.createSession({ cwd: "/tmp" }))).toBe("COMMAND_AGENT_INVALID")
  })

  test("offers the agent nothing to read, write, or run, and names itself", async () => {
    const recorder = join(state, "initialize.jsonl")
    // `tee` keeps what Runrail wrote; the fixture answers.
    const backend = new AcpAgentBackend({ name: "copilot", label: "Copilot", command: "/bin/sh", args: ["-c", `tee '${recorder}' | '${process.execPath}' '${fixture}' normal`] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-initialize" })
    expect(answer(await collect(backend, session.id, "hello"))).toBe("fixture answer 1")
    await backend.close(session.id)
    const sent = (await Bun.file(recorder).text()).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    expect(sent.map((message) => message.method)).toEqual(["initialize", "session/new", "session/prompt"])
    expect(sent[0]!.params).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "runrail", title: "Runrail", version: expect.any(String) } })
    expect(sent[1]!.params).toEqual({ cwd: "/tmp", mcpServers: [] })
    expect(sent[2]!.params).toEqual({ sessionId: "fixture-acp-session", prompt: [{ type: "text", text: "hello" }] })
  })

  test("the thread's model and effort ride on the command line; instructions open the conversation once", async () => {
    const backend = copilot("echo", { launch: { model: "gpt-fixture", effort: "max", appendSystemPrompt: "Prefer small diffs." } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-echo" })
    const first = echo(await collect(backend, session.id, "first"))
    expect(first.argv).toEqual(["--acp", "--model", "gpt-fixture", "--effort", "max"])
    expect(first.session).toEqual({ method: "session/new", params: { cwd: "/tmp", mcpServers: [] } })
    expect(first.prompt).toEqual([{ type: "text", text: "Instructions for this conversation, set by the user:\n\nPrefer small diffs." }, { type: "text", text: "first" }])
    expect(echo(await collect(backend, session.id, "second")).prompt).toEqual([{ type: "text", text: "second" }])

    // Another model or effort means another process; it opens the same conversation again.
    await backend.setModel(session.id, "gpt-other")
    await backend.setThinking(session.id, "off")
    const third = await collect(backend, session.id, "third")
    const restarted = echo(third)
    expect(restarted.argv).toEqual(["--acp", "--model", "gpt-other", "--effort", "low"])
    expect(restarted.session).toEqual({ method: "session/load", params: { sessionId: "fixture-acp-session", cwd: "/tmp", mcpServers: [] } })
    expect(restarted.prompt).toEqual([{ type: "text", text: "third" }])
    // What the agent replayed while loading is history, not part of this turn.
    expect(JSON.stringify(third)).not.toContain("replayed")
    expect(types(third)).toEqual(["turn.started", "assistant.delta", "assistant.message", "session.completed"])

    expect(await failure(() => backend.setModel(session.id, "--flag"))).toBe("COMMAND_AGENT_INVALID")
    expect(await failure(() => backend.setThinking(session.id, "extreme"))).toBe("COMMAND_AGENT_INVALID")
    await backend.close(session.id)
  })

  test("Runrail's own MCP servers go with every conversation the agent opens or loads", async () => {
    const connectors = { name: "runrail_connectors", command: "/opt/runrail", args: ["connectors-mcp", "--endpoint-file", "/tmp/endpoint.json"], env: [] }
    const backend = copilot("echo", { mcpServers: [connectors] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-mcp" })
    expect(echo(await collect(backend, session.id, "first")).session).toEqual({ method: "session/new", params: { cwd: "/tmp", mcpServers: [connectors] } })
    await backend.setModel(session.id, "gpt-other")
    expect(echo(await collect(backend, session.id, "second")).session).toEqual({ method: "session/load", params: { sessionId: "fixture-acp-session", cwd: "/tmp", mcpServers: [connectors] } })
    await backend.close(session.id)

    expect(await failure(() => copilot("echo", { mcpServers: [{ ...connectors, command: "" }] }))).toBe("COMMAND_AGENT_INVALID")
    expect(await failure(() => copilot("echo", { mcpServers: [{ ...connectors, args: ["a\0b"] }] }))).toBe("COMMAND_AGENT_INVALID")
  })

  test("a model the agent lists for the conversation is switched in place", async () => {
    const backend = copilot("models", { launch: { model: "fixture-small" } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-models" })
    const first = echo(await collect(backend, session.id, "first"))
    expect(first.setModel).toEqual(["fixture-small"])
    await backend.setModel(session.id, "fixture-large")
    const second = echo(await collect(backend, session.id, "second"))
    expect(second.setModel).toEqual(["fixture-small", "fixture-large"])
    // Still the first process: its command line is unchanged and nothing was loaded again.
    expect(second.argv).toEqual(["--acp", "--model", "fixture-small"])
    expect(second.session.method).toBe("session/new")
    await backend.close(session.id)

    // Without a command-line setting, a model the agent does not list has no way to reach it.
    const plain = (model: string): AcpAgentBackend => new AcpAgentBackend({ name: "acp-fixture", label: "Fixture", command: process.execPath, args: [fixture, "models"], launch: { model } })
    const unlisted = plain("fixture-unknown")
    const other = await unlisted.createSession({ cwd: "/tmp", sessionId: "acp-unlisted" })
    expect(await failure(() => collect(unlisted, other.id, "go"))).toBe("COMMAND_AGENT_INVALID")
    await unlisted.close(other.id)
    const listed = plain("fixture-small")
    const third = await listed.createSession({ cwd: "/tmp", sessionId: "acp-listed" })
    expect(echo(await collect(listed, third.id, "go"))).toMatchObject({ argv: [], setModel: ["fixture-small"] })
    await listed.close(third.id)
  })

  test("continues the stored conversation in a new process, and starts over when the agent no longer has it", async () => {
    const store = createFileVendorSessionStore(join(state, "stored"), "copilot")
    const before = copilot("echo", { vendorSessions: store, launch: { appendSystemPrompt: "Prefer small diffs." } })
    const session = await before.createSession({ cwd: "/tmp", sessionId: "acp-stored" })
    expect(echo(await collect(before, session.id, "first")).session.method).toBe("session/new")
    await before.close(session.id)
    expect(await store.load("acp-stored")).toBe("fixture-acp-session")

    await store.save("acp-stored", "stored-session-7")
    const after = copilot("echo", { vendorSessions: store, launch: { appendSystemPrompt: "Prefer small diffs." } })
    await after.createSession({ cwd: "/tmp", sessionId: "acp-stored" })
    const resumed = echo(await collect(after, "acp-stored", "second"))
    expect(resumed.session).toEqual({ method: "session/load", params: { sessionId: "stored-session-7", cwd: "/tmp", mcpServers: [] } })
    // The conversation already has its instructions.
    expect(resumed.prompt).toEqual([{ type: "text", text: "second" }])
    await after.close("acp-stored")

    const named = copilot("echo", { launch: { resume: "launch-session-3" } })
    await named.createSession({ cwd: "/tmp", sessionId: "acp-named" })
    expect(echo(await collect(named, "acp-named", "go")).session.params).toMatchObject({ sessionId: "launch-session-3" })
    await named.close("acp-named")

    const gone = createFileVendorSessionStore(join(state, "gone"), "copilot")
    await gone.save("acp-gone", "stale-session")
    const backend = copilot("load-missing", { vendorSessions: gone })
    await backend.createSession({ cwd: "/tmp", sessionId: "acp-gone" })
    expect((await collect(backend, "acp-gone", "go")).at(-1)).toMatchObject({ type: "session.completed" })
    await backend.close("acp-gone")
    expect(await gone.load("acp-gone")).toBe("fixture-acp-session-new")

    // An agent that cannot load is never asked to.
    const cannot = copilot("no-load", { launch: { resume: "launch-session-3" } })
    await cannot.createSession({ cwd: "/tmp", sessionId: "acp-no-load" })
    expect((await collect(cannot, "acp-no-load", "go")).at(-1)).toMatchObject({ type: "session.completed" })
    await cannot.close("acp-no-load")
  })
})

describe("permission requests", () => {
  test("the thread's mode decides: allow, refuse, or ask the user", () => {
    const table: readonly (readonly [Parameters<typeof acpPermissionDecision>[0], string, string])[] = [
      [undefined, "read", "ask"],
      [undefined, "execute", "ask"],
      ["ask", "edit", "ask"],
      ["ask", "read", "ask"],
      ["plan", "read", "allow"],
      ["plan", "search", "allow"],
      ["plan", "think", "allow"],
      ["plan", "edit", "reject"],
      ["plan", "execute", "reject"],
      ["plan", "fetch", "reject"],
      ["plan", "fixture_future_kind", "reject"],
      ["accept-edits", "edit", "allow"],
      ["accept-edits", "read", "allow"],
      ["accept-edits", "delete", "ask"],
      ["accept-edits", "execute", "ask"],
      ["accept-edits", "fetch", "ask"],
      ["auto", "edit", "allow"],
      ["auto", "execute", "ask"],
      ["auto", "other", "ask"],
      ["bypass", "execute", "allow"],
      ["bypass", "fixture_future_kind", "allow"],
      // Leaving plan mode is never refused unasked: the person reads the plan and decides.
      ["plan", "switch_mode", "ask"],
      ["ask", "switch_mode", "ask"],
      ["bypass", "switch_mode", "allow"],
    ]
    for (const [mode, kind, decision] of table) expect([mode, kind, acpPermissionDecision(mode, kind)]).toEqual([mode, kind, decision])
  })

  test("a one-time answer is never sent as the agent's standing one, and the card says why it was cancelled", async () => {
    for (const [mode, approved, verb] of [["approval-always-only", true, "allow"], ["approval-reject-always-only", false, "refuse"]] as const) {
      const backend = copilot(mode, { launch: { permissionMode: "ask" } })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-${mode}` })
      const events = await collect(backend, session.id, "build it", approved)
      // A standing no would stop the agent asking the person again; a cancel is a one-time no.
      expect([mode, answer(events)]).toEqual([mode, "decision cancelled"])
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approved: false, reason: `Copilot offered no way to ${verb} this once, so the request was cancelled` }))
      await backend.close(session.id)
    }
  })

  test("a question for the user is answered with one of the agent's own options", async () => {
    for (const [index, approved] of [true, false].entries()) {
      const backend = copilot("approval", { launch: { permissionMode: "ask" } })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-approval-${index}` })
      const events = await collect(backend, session.id, "build it", approved)
      const asked = events.find((event) => event.type === "approval.required")
      expect(asked).toMatchObject({ turnId: "turn-1", action: "command", capability: "process.exec", reason: "Run `make build`" })
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approved }))
      expect(answer(events)).toBe(`decision ${approved ? "allow-once" : "reject-once"}`)
      expect(events.at(-1)).toMatchObject({ type: "session.completed" })
      // An answer for a request that is no longer open changes nothing.
      expect(await backend.resolveApproval?.(session.id, asked?.type === "approval.required" ? asked.approvalId : "", true)).toBe(false)
      await backend.close(session.id)
    }
  })

  test("a mode that settles the question never asks, and says so to the agent", async () => {
    const cases: readonly (readonly [string, NonNullable<CopilotHarnessOptions["launch"]>["permissionMode"], string, boolean])[] = [
      ["approval", "bypass", "decision allow-once", false],
      ["approval", "plan", "decision reject-once", false],
      ["approval-edit", "accept-edits", "decision allow-once", false],
      ["approval-edit", "plan", "decision reject-once", false],
      ["approval-read", "plan", "decision allow-once", false],
      ["approval", "accept-edits", "decision allow-once", true],
      ["approval-fetch", "auto", "decision allow-once", true],
    ]
    for (const [index, [mode, permissionMode, said, asks]] of cases.entries()) {
      const backend = copilot(mode, { launch: { permissionMode } })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-mode-${index}` })
      const events = await collect(backend, session.id, "go", true)
      expect([mode, permissionMode, answer(events), events.some((event) => event.type === "approval.required")]).toEqual([mode, permissionMode, said, asks])
      await backend.close(session.id)
    }
    const fetch = copilot("approval-fetch", { launch: { permissionMode: "ask" } })
    const session = await fetch.createSession({ cwd: "/tmp", sessionId: "acp-fetch" })
    expect((await collect(fetch, session.id, "go", false)).find((event) => event.type === "approval.required")).toMatchObject({ action: "permission", capability: "network.request" })
    await fetch.close(session.id)
  })

  test("a request to leave plan mode shows its plan and is the person's call; after a yes each write is asked", async () => {
    for (const approved of [true, false]) {
      const backend = copilot("plan-switch", { launch: { permissionMode: "plan" } })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-plan-switch-${String(approved)}` })
      const first = await collect(backend, session.id, "plan it", approved)
      const started = first.find((event) => event.type === "tool.started")
      expect(started).toMatchObject({ callId: "plan-call", name: "switch_mode", input: { title: "Ready to code?", plan: "1. Fix the total\n2. Add a test" } })
      expect(describeToolCall("switch_mode", started?.type === "tool.started" ? started.input : undefined)).toMatchObject({ kind: "plan", title: "Proposed plan", content: "1. Fix the total\n2. Add a test" })
      expect(first.find((event) => event.type === "approval.required")).toMatchObject({ action: "plan", capability: "tool.use", reason: "Ready to code?" })
      expect(answer(first)).toBe(`decision ${approved ? "allow-once" : "reject-once"}`)
      // The edit that follows is asked after a yes; after a no, plan mode still refuses it unasked.
      const second = await collect(backend, session.id, "go", true)
      expect([approved, second.some((event) => event.type === "approval.required"), answer(second)]).toEqual([approved, approved, approved ? "decision allow-once" : "decision reject-once"])
      await backend.close(session.id)
    }
  })

  test("in the agent's own plan mode, what it asks goes to the person; its leaving after a yes lifts the refusal too", async () => {
    for (const approved of [true, false]) {
      const backend = copilot("plan-other", { launch: { permissionMode: "plan" } })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-plan-other-${String(approved)}` })
      const first = await collect(backend, session.id, "plan it", approved)
      // Gemini CLI asks for its plan's approval as a tool of kind `other`, naming the plan file.
      expect(first.find((event) => event.type === "approval.required")).toMatchObject({ action: "permission", reason: "Requesting plan approval for: /plans/fix.md" })
      expect(answer(first)).toBe(`decision ${approved ? "allow-once" : "reject-once"}`)
      const second = await collect(backend, session.id, "go", true)
      expect([approved, second.some((event) => event.type === "approval.required"), answer(second)]).toEqual([approved, approved, approved ? "decision allow-once" : "decision reject-once"])
      await backend.close(session.id)
    }
    // An agent with no plan mode of its own is not trusted the same way: plan mode refuses its tool unasked.
    const plain = copilot("approval-goose", { launch: { permissionMode: "plan" } })
    const session = await plain.createSession({ cwd: "/tmp", sessionId: "acp-plan-plain" })
    const events = await collect(plain, session.id, "go", true)
    expect([events.some((event) => event.type === "approval.required"), answer(events)]).toEqual([false, "decision reject-once"])
    await plain.close(session.id)
  })

  test("plan mode also puts the agent in its own plan mode when it has one", async () => {
    const backend = copilot("modes", { launch: { permissionMode: "plan" } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-plan" })
    expect(echo(await collect(backend, session.id, "plan it")).setMode).toEqual(["plan"])
    expect(echo(await collect(backend, session.id, "again")).setMode).toEqual(["plan"])
    await backend.close(session.id)
    const ask = copilot("modes", { launch: { permissionMode: "ask" } })
    const other = await ask.createSession({ cwd: "/tmp", sessionId: "acp-no-plan" })
    expect(echo(await collect(ask, other.id, "go")).setMode).toEqual([])
    await ask.close(other.id)
  })
})

describe("faults and stops", () => {
  test("opening a session runs no process; a missing tool fails the turn and the session stays", async () => {
    const backend = createCopilotHarness({ command: join(state, "not-installed") })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-lazy" })
    expect(session).toMatchObject({ id: "acp-lazy", status: "idle" })
    for (let attempt = 0; attempt < 2; attempt += 1) expect(await failure(() => collect(backend, session.id, "go"))).toBe("COMMAND_AGENT_NOT_FOUND")
    expect(await backend.snapshot(session.id)).toMatchObject({ id: "acp-lazy" })
    await backend.close(session.id)
  })

  test("a tool that is not signed in, or speaks another protocol version, fails the turn with its own code", async () => {
    const signedOut = copilot("auth")
    const session = await signedOut.createSession({ cwd: "/tmp", sessionId: "acp-auth" })
    try {
      await collect(signedOut, session.id, "go")
      throw new Error("expected a rejection")
    } catch (error) {
      expect(error).toMatchObject({ code: "COMMAND_AGENT_AUTH_FAILED" })
      // The agent's own message named an account; none of it is repeated.
      expect(String(error)).not.toContain("example.invalid")
    }
    await signedOut.close(session.id)

    const old = copilot("old-protocol")
    const other = await old.createSession({ cwd: "/tmp", sessionId: "acp-old" })
    expect(await failure(() => collect(old, other.id, "go"))).toBe("COMMAND_AGENT_UNSUPPORTED")
    await old.close(other.id)
  })

  test("a cancelled turn stops; an agent that does not listen is stopped", async () => {
    for (const mode of ["hang", "deaf"]) {
      const backend = copilot(mode)
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-cancel-${mode}` })
      const events: AgentEvent[] = []
      const started = Date.now()
      for await (const event of backend.send({ sessionId: session.id, message: "long job" })) {
        events.push(event)
        if (event.type === "assistant.delta") void backend.cancel(session.id, "stopped by test")
      }
      expect([mode, events.at(-1)]).toEqual([mode, expect.objectContaining({ type: "session.stopped", reason: "stopped by test" })])
      expect(types(events).filter((type) => type === "session.stopped")).toHaveLength(1)
      // Two seconds of grace for the agent to end the turn itself, then the process goes.
      if (mode === "hang") expect(Date.now() - started).toBeLessThan(1_500)
      else expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
      expect(await backend.snapshot(session.id)).toMatchObject({ status: "stopped" })
      await backend.close(session.id)
    }
  }, 20_000)

  test("cancelling while a question is open withdraws the question", async () => {
    const backend = copilot("approval", { launch: { permissionMode: "ask" } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-cancel-approval" })
    const events: AgentEvent[] = []
    let approvalId = ""
    for await (const event of backend.send({ sessionId: session.id, message: "build it" })) {
      events.push(event)
      if (event.type === "approval.required") {
        approvalId = event.approvalId
        void backend.cancel(session.id, "stopped by test")
      }
    }
    expect(events.at(-1)).toMatchObject({ type: "session.stopped" })
    // The agent was told "cancelled", not "allowed".
    expect(events.filter((event) => event.type === "assistant.message").map((event) => (event.type === "assistant.message" ? event.text : ""))).toEqual(["decision cancelled"])
    expect(await backend.resolveApproval?.(session.id, approvalId, true)).toBe(false)
    await backend.close(session.id)
  })

  test("what is not part of the turn is dropped, and a request for something never offered is refused", async () => {
    const backend = copilot("noise")
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "acp-noise" })
    const events = await collect(backend, session.id, "go")
    expect(types(events)).toEqual(["session.started", "turn.started", "assistant.delta", "assistant.message", "session.completed"])
    expect(JSON.stringify(events)).not.toContain("leaked")
    // The agent asked to read a file through Runrail and was told there is no such method.
    expect(answer(events)).toBe("refused -32601")
    await backend.close(session.id)
    // A permission request without its parameters is malformed, not a method Runrail lacks.
    const malformed = copilot("bad-permission")
    const other = await malformed.createSession({ cwd: "/tmp", sessionId: "acp-bad-permission" })
    expect(answer(await collect(malformed, other.id, "go"))).toBe("refused -32602")
    await malformed.close(other.id)
  })

  test("a failure says why in the agent's own words, with credentials masked", async () => {
    const words = async (mode: string): Promise<AgentEvent[]> => {
      const backend = copilot(mode)
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-words-${mode}` })
      try {
        return await collect(backend, session.id, "go")
      } finally {
        await backend.close(session.id)
      }
    }
    // A crash: the exit code and the error line from stderr, never its stack frames or the key it named.
    const crash = await words("crash")
    expect(crash.at(-1)).toMatchObject({ type: "session.failed", recoverable: true, error: { code: "COMMAND_AGENT_FAILED", message: "Copilot exited with code 3: fatal: upstream refused key ***" } })
    expect(JSON.stringify(crash)).not.toContain("sk-ant-fixturekey")
    // The agent's answer to the prompt was an error: its message, whole.
    expect((await words("prompt-error")).at(-1)).toMatchObject({ type: "session.failed", error: { code: "COMMAND_AGENT_FAILED", message: "Copilot reported an error: Model fixture-9 is not available Pick another model" } })
    // A failed tool says why from what it printed.
    expect((await words("tool-failed")).find((event) => event.type === "tool.completed")).toMatchObject({ ok: false, error: { code: "ACP_TOOL_FAILED", message: "error: Missing script: build" } })
  })

  test("a declined request, an unknown ending, a silent model failure, and a crash each fail the turn without losing the session", async () => {
    const cases: readonly (readonly [string, string])[] = [["refusal", "COMMAND_AGENT_FAILED"], ["odd-stop", "COMMAND_AGENT_OUTPUT_INVALID"], ["silent-failure", "COMMAND_AGENT_FAILED"], ["crash", "COMMAND_AGENT_FAILED"]]
    for (const [mode, code] of cases) {
      const backend = copilot(mode)
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `acp-fail-${mode}` })
      const events = await collect(backend, session.id, "go")
      expect([mode, events.at(-1)]).toEqual([mode, expect.objectContaining({ type: "session.failed", recoverable: true, error: expect.objectContaining({ code }) })])
      expect(await backend.snapshot(session.id)).toMatchObject({ status: "failed" })
      await backend.close(session.id)
    }
    const capped = copilot("max-tokens")
    const session = await capped.createSession({ cwd: "/tmp", sessionId: "acp-max-tokens" })
    expect((await collect(capped, session.id, "go")).at(-1)).toMatchObject({ type: "session.completed" })
    await capped.close(session.id)
  })

  test("rejects options the route cannot carry", async () => {
    const base: AcpAgentBackendOptions = { name: "copilot", label: "Copilot", command: "copilot" }
    const invalid: readonly Partial<AcpAgentBackendOptions>[] = [
      { launch: { mcpConfig: ["/tmp/mcp.json"] } },
      { launch: { model: "--flag" } },
      { launch: { effort: "extreme" } as never },
      { launch: { unknown: true } as never },
      { name: "bad name" },
      { label: "" },
      { command: "has space" },
      { command: "-rf" },
      { args: [""] },
      { timeoutMs: 0 },
      { turnTimeoutMs: -1 },
      { maxEvents: 0 },
      { vendorSessions: { load: "nope" } as never },
      { settingArgs: "nope" as never },
      { routeEnv: { lower: "x" } },
      { trailingUpdateMs: 5_000 },
      { routeEnv: { OK: "has\0nul" } },
    ]
    for (const options of invalid) expect([options, await failure(() => new AcpAgentBackend({ ...base, ...options }))]).toEqual([options, "COMMAND_AGENT_INVALID"])
    expect(await failure(() => new AcpAgentBackend({ ...base, auth: { mode: "environment" } }))).toBe("COMMAND_AGENT_AUTH_INVALID")
    // Arguments a caller computes are held to the same bounds as the fixed ones.
    const flagged = new AcpAgentBackend({ name: "acp-fixture", label: "Fixture", command: process.execPath, args: [fixture, "echo"], settingArgs: () => ["ok", ""] })
    const session = await flagged.createSession({ cwd: "/tmp", sessionId: "acp-setting-args" })
    expect(await failure(() => collect(flagged, session.id, "go"))).toBe("COMMAND_AGENT_INVALID")
    await flagged.close(session.id)
  })
})

describe("forking a conversation", () => {
  test("the agent's copy is kept for the target session, which then continues it", async () => {
    const store = createFileVendorSessionStore(join(state, "fork"), "copilot")
    const parent = copilot("echo", { args: [fixture, "echo", "--fixture-fork"], vendorSessions: store })
    const session = await parent.createSession({ cwd: "/tmp", sessionId: "acp-fork-parent" })
    await collect(parent, session.id, "first")
    expect(await failure(() => parent.fork({ sessionId: session.id, targetSessionId: session.id }))).toBe("COMMAND_AGENT_INVALID")
    await expect(parent.fork({ sessionId: session.id, targetSessionId: "acp-fork-child" })).resolves.toEqual({ sessionId: "acp-fork-child", parentSessionId: session.id })
    expect(echo(await collect(parent, session.id, "parent again")).forked).toEqual(["fixture-acp-session"])
    expect(await store.load("acp-fork-child")).toBe("fixture-acp-session-fork")
    expect(await store.load(session.id)).toBe("fixture-acp-session")
    await parent.close(session.id)

    const child = copilot("echo", { args: [fixture, "echo", "--fixture-fork"], vendorSessions: store })
    const opened = await child.createSession({ cwd: "/tmp", sessionId: "acp-fork-child" })
    expect(echo(await collect(child, opened.id, "continue the copy")).session).toEqual({ method: "session/load", params: { sessionId: "fixture-acp-session-fork", cwd: "/tmp", mcpServers: [] } })
    await child.close(opened.id)
  })

  test("is refused without a store or when the agent cannot fork", async () => {
    const storeless = copilot("echo", { args: [fixture, "echo", "--fixture-fork"] })
    await storeless.createSession({ cwd: "/tmp", sessionId: "acp-fork-storeless" })
    expect(await failure(() => storeless.fork({ sessionId: "acp-fork-storeless" }))).toBe("COMMAND_AGENT_UNSUPPORTED")
    await storeless.close("acp-fork-storeless")

    const store = createFileVendorSessionStore(join(state, "fork-unsupported"), "copilot")
    const plain = copilot("echo", { vendorSessions: store })
    await plain.createSession({ cwd: "/tmp", sessionId: "acp-fork-plain" })
    expect(await failure(() => plain.fork({ sessionId: "acp-fork-plain", targetSessionId: "acp-fork-plain-child" }))).toBe("COMMAND_AGENT_UNSUPPORTED")
    expect(await store.load("acp-fork-plain-child")).toBeUndefined()
    await plain.close("acp-fork-plain")
  })
})

describe("a conversation the tool recorded outside Runrail", () => {
  test("is continued as a copy, and the copy is the thread's own from then on", async () => {
    const store = createFileVendorSessionStore(join(state, "seeded"), "opencode")
    await store.save("acp-seeded", "ses_original", { fork: true })
    const agent = copilot("echo", { args: [fixture, "echo", "--fixture-fork"], vendorSessions: store })
    const session = await agent.createSession({ cwd: "/tmp", sessionId: "acp-seeded" })
    const first = echo(await collect(agent, session.id, "what did we find?"))
    expect(first.forked).toEqual(["ses_original"])
    // Neither loaded nor started afresh: the original is never opened for writing.
    expect(first.session).toBeUndefined()
    expect(await store.entry?.("acp-seeded")).toEqual({ vendorSessionId: "ses_original-fork", fork: false })
    await agent.close(session.id)

    const reopened = copilot("echo", { args: [fixture, "echo", "--fixture-fork"], vendorSessions: store })
    const again = await reopened.createSession({ cwd: "/tmp", sessionId: "acp-seeded" })
    expect(echo(await collect(reopened, again.id, "and then?")).session).toEqual({ method: "session/load", params: { sessionId: "ses_original-fork", cwd: "/tmp", mcpServers: [] } })
    await reopened.close(again.id)
  })

  test("an agent that cannot copy one fails the turn rather than loading the original", async () => {
    const store = createFileVendorSessionStore(join(state, "seeded-plain"), "copilot")
    await store.save("acp-seeded-plain", "copilot-original", { fork: true })
    const agent = copilot("echo", { vendorSessions: store })
    const session = await agent.createSession({ cwd: "/tmp", sessionId: "acp-seeded-plain" })
    expect(await failure(() => collect(agent, session.id, "what did we find?"))).toBe("COMMAND_AGENT_UNSUPPORTED")
    expect(await store.entry?.("acp-seeded-plain")).toEqual({ vendorSessionId: "copilot-original", fork: true })
    await agent.close(session.id)
  })
})

describe("OpenCode, Gemini CLI, and Goose presets", () => {
  test("OpenCode asks before edits, commands, and web tools by the thread's mode", async () => {
    expect(JSON.parse(openCodePermission(undefined)!)).toEqual({ edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask", codesearch: "ask" })
    expect(JSON.parse(openCodePermission("ask")!)).toEqual({ edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask", codesearch: "ask" })
    expect(JSON.parse(openCodePermission("plan")!)).toEqual({ edit: "deny", bash: "deny", webfetch: "ask", websearch: "ask", codesearch: "ask" })
    expect(JSON.parse(openCodePermission("accept-edits")!)).toEqual({ bash: "ask", webfetch: "ask", websearch: "ask", codesearch: "ask" })
    expect(openCodePermission("auto")).toBe(openCodePermission("accept-edits"))
    expect(openCodePermission("bypass")).toBeUndefined()

    const asking = createOpenCodeHarness({ command: process.execPath, args: [fixture, "echo"], launch: { permissionMode: "ask" } })
    expect(asking.info.name).toBe("opencode")
    expect(asking.info.capabilities).toContain("fork")
    const session = await asking.createSession({ cwd: "/tmp", sessionId: "opencode-ask" })
    expect(echo(await collect(asking, session.id, "go")).env).toEqual({ OPENCODE_PERMISSION: openCodePermission("ask")!, GOOSE_MODE: null })
    await asking.close(session.id)

    const bypass = createOpenCodeHarness({ command: process.execPath, args: [fixture, "echo"], launch: { permissionMode: "bypass" } })
    const open = await bypass.createSession({ cwd: "/tmp", sessionId: "opencode-bypass" })
    expect(echo(await collect(bypass, open.id, "go")).env).toEqual({ OPENCODE_PERMISSION: null, GOOSE_MODE: null })
    await bypass.close(open.id)
  })

  test("OpenCode's reply that ends after its answer to the prompt is kept whole", async () => {
    const opencode = createOpenCodeHarness({ command: process.execPath, args: [fixture, "late-text"] })
    const session = await opencode.createSession({ cwd: "/tmp", sessionId: "opencode-late-text" })
    const events = await collect(opencode, session.id, "go")
    expect([answer(events), events.at(-1)?.type]).toEqual(["the start and the end", "session.completed"])
    await opencode.close(session.id)
    // An agent that keeps to ACP's order is not waited for.
    const strict = copilot("late-text")
    const other = await strict.createSession({ cwd: "/tmp", sessionId: "copilot-late-text" })
    expect(answer(await collect(strict, other.id, "go"))).toBe("the start")
    await strict.close(other.id)
  })

  test("a request titled with a bare tool name names what it runs, from the request or the tool's own updates", async () => {
    for (const mode of ["approval-bare", "approval-late"]) {
      const backend = createOpenCodeHarness({ command: process.execPath, args: [fixture, mode] })
      const session = await backend.createSession({ cwd: "/tmp", sessionId: `opencode-${mode}` })
      const events = await collect(backend, session.id, "build it", true)
      expect([mode, events.find((event) => event.type === "approval.required")]).toEqual([mode, expect.objectContaining({ action: "command", reason: "bash: make build" })])
      await backend.close(session.id)
    }
  })

  test("a title the agent cut short gives way to the file it names", async () => {
    const backend = createGooseHarness({ command: process.execPath, args: [fixture, "approval-goose"] })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "goose-cut-title" })
    const events = await collect(backend, session.id, "write it", true)
    expect(events.find((event) => event.type === "approval.required")).toMatchObject({ reason: "write · /work/a/very/long/project/path/notes.txt" })
    await backend.close(session.id)
  })

  test("Gemini CLI takes the model as a flag and keeps its default approval mode; Goose is told to ask", async () => {
    expect(geminiSettingArguments({ model: "fixture-pro", effort: "high" })).toEqual(["--model", "fixture-pro"])
    expect(geminiSettingArguments({})).toEqual([])
    const gemini = createGeminiHarness({ command: process.execPath, args: [fixture, "echo", "--acp", "--approval-mode", "default"], launch: { model: "fixture-pro" } })
    expect(gemini.info.capabilities).not.toContain("fork")
    const asked = await gemini.createSession({ cwd: "/tmp", sessionId: "gemini-model" })
    expect(echo(await collect(gemini, asked.id, "go")).argv).toEqual(["--acp", "--approval-mode", "default", "--model", "fixture-pro"])
    await gemini.close(asked.id)

    const goose = createGooseHarness({ command: process.execPath, args: [fixture, "echo"] })
    const run = await goose.createSession({ cwd: "/tmp", sessionId: "goose-mode" })
    expect(echo(await collect(goose, run.id, "go")).env).toEqual({ OPENCODE_PERMISSION: null, GOOSE_MODE: "approve" })
    await goose.close(run.id)
  })

  test("Goose takes a model as its model config option, listed or not, and keeps its own without one", async () => {
    const goose = (model?: string, mode = "config-models"): AcpAgentBackend => createGooseHarness({ command: process.execPath, args: [fixture, mode], ...(model === undefined ? {} : { launch: { model } }) })
    expect(goose().info.capabilities).toContain("models")
    const typed = goose("lmstudio-qwen")
    const first = await typed.createSession({ cwd: "/tmp", sessionId: "goose-typed" })
    expect(echo(await collect(typed, first.id, "go"))).toMatchObject({ argv: [], setModel: [], setConfig: ["model=lmstudio-qwen"] })
    await typed.setModel(first.id, "fixture-listed")
    expect(echo(await collect(typed, first.id, "again")).setConfig).toEqual(["model=lmstudio-qwen", "model=fixture-listed"])
    await typed.close(first.id)

    // The model it is set up with needs no request.
    const own = goose()
    const second = await own.createSession({ cwd: "/tmp", sessionId: "goose-own" })
    expect(echo(await collect(own, second.id, "go")).setConfig).toEqual([])
    const same = goose("fixture-configured")
    const third = await same.createSession({ cwd: "/tmp", sessionId: "goose-same" })
    expect(echo(await collect(same, third.id, "go")).setConfig).toEqual([])
    await own.close(second.id)
    await same.close(third.id)

    // An agent that answers but keeps another model fails the turn instead of running on it.
    const stubborn = goose("lmstudio-qwen", "config-stubborn")
    const fourth = await stubborn.createSession({ cwd: "/tmp", sessionId: "goose-stubborn" })
    expect(await failure(() => collect(stubborn, fourth.id, "go"))).toBe("COMMAND_AGENT_INVALID")
    await stubborn.close(fourth.id)
  })

  test("each preset is a default harness and backend, replacing its JSONL candidate", () => {
    const harnesses = new Map(createDefaultHarnessAdapters().map((adapter) => [adapter.descriptor.id, adapter.descriptor]))
    for (const id of ["opencode", "gemini", "goose"]) expect([id, harnesses.get(id)?.protocolVersion]).toEqual([id, "acp.v1"])
    expect(harnesses.get("aider")?.protocolVersion).toBe("runrail.jsonl")
    const backends = createDefaultBackendRegistry().list().map((adapter) => adapter.name)
    expect(backends).toEqual(expect.arrayContaining(["copilot", "opencode", "gemini", "goose"]))
  })
})
