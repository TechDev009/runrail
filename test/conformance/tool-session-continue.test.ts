import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { ClaudeAgentSdkBackend, createFileVendorSessionStore, createRunrailSession, registerClaudeAgentSdk } from "../../src/index.ts"
import { CodexAppServerBackend } from "../../src/backend/codex-app-server.ts"
import { CommandAgentBackend } from "../../src/backend/command-agent.ts"
import { SESSION_IMPORTED, SESSION_REWOUND } from "../../src/conversation/index.ts"
import { claudeCodeLaunchArguments } from "../../src/harness/launch.ts"
import { mapClaudeCodeEvent } from "../../src/harness/mappers.ts"
import { vendorSessionEntry, type VendorSessionStore } from "../../src/harness/vendor-session-store.ts"
import { carryoverText } from "../../src/session/carryover.ts"
import type { TranscriptRecord } from "../../src/transcript/store.ts"
import { forkAware, scriptedSdk } from "../fixtures/scripted-claude-sdk.ts"

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  registerClaudeAgentSdk(undefined)
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runrail-tool-session-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

describe("a session continued in its own tool", () => {
  test("the store keeps the fork mark until a plain save replaces it, and a store without marks reads as a continuation", async () => {
    const store = createFileVendorSessionStore(await folder(), "claude-code")
    await store.save("thread-1", "external-1", { fork: true })
    expect(await store.load("thread-1")).toBe("external-1")
    expect(await vendorSessionEntry(store, "thread-1")).toEqual({ vendorSessionId: "external-1", fork: true })
    await store.save("thread-1", "vendor-copy")
    expect(await vendorSessionEntry(store, "thread-1")).toEqual({ vendorSessionId: "vendor-copy", fork: false })
    const plain: VendorSessionStore = { load: async () => "kept-1", save: async () => {} }
    expect(await vendorSessionEntry(plain, "thread-1")).toEqual({ vendorSessionId: "kept-1", fork: false })
    expect(await vendorSessionEntry(undefined, "thread-1")).toBeUndefined()
  })

  test("Claude Code over the SDK forks the marked session once, then continues the copy", async () => {
    const store = createFileVendorSessionStore(await folder(), "claude-code")
    await store.save("thread-sdk", "external-1", { fork: true })
    const { sdk, queries } = scriptedSdk(forkAware)
    const first = new ClaudeAgentSdkBackend({ sdk, command: process.execPath, vendorSessions: store })
    const session = await first.createSession({ cwd: "/tmp", sessionId: "thread-sdk" })
    expect((await drain(first.send({ sessionId: session.id, message: "what did we find?" }))).at(-1)).toMatchObject({ type: "session.completed" })
    expect(queries[0]!.options).toMatchObject({ resume: "external-1", forkSession: true })
    await first.close(session.id)
    expect(await vendorSessionEntry(store, "thread-sdk")).toEqual({ vendorSessionId: "vendor-copy", fork: false })

    const restarted = new ClaudeAgentSdkBackend({ sdk, command: process.execPath, vendorSessions: store })
    await restarted.createSession({ cwd: "/tmp", sessionId: "thread-sdk" })
    await drain(restarted.send({ sessionId: "thread-sdk", message: "and then?" }))
    expect(queries[1]!.options.resume).toBe("vendor-copy")
    expect(queries[1]!.options.forkSession).toBeUndefined()
    await restarted.close("thread-sdk")
  })

  test("print-mode Claude Code adds --fork-session only to a marked resume", async () => {
    expect(claudeCodeLaunchArguments({}, "external-1", true).slice(-3)).toEqual(["--resume", "external-1", "--fork-session"])
    expect(claudeCodeLaunchArguments({}, "external-1")).not.toContain("--fork-session")
    expect(claudeCodeLaunchArguments({}, undefined, true)).not.toContain("--fork-session")

    const store = createFileVendorSessionStore(await folder(), "claude-code")
    const turns: unknown[] = []
    const script = `console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "vendor-copy" })); console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "vendor-copy" }))`
    const backend = new CommandAgentBackend({ command: process.execPath, args: ["-e", script], promptMode: "stdin", eventMapper: mapClaudeCodeEvent, vendorSessions: store, turnArgs: (turn) => { turns.push(turn); return [] } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "thread-print" })
    // Seeded after the session opened, as an import into an open thread does.
    await store.save("thread-print", "external-1", { fork: true })
    await drain(backend.send({ sessionId: session.id, message: "go on" }))
    await drain(backend.send({ sessionId: session.id, message: "and then?" }))
    expect(turns).toEqual([{ vendorSessionId: "external-1", fork: true }, { vendorSessionId: "vendor-copy" }])
    expect(await vendorSessionEntry(store, "thread-print")).toEqual({ vendorSessionId: "vendor-copy", fork: false })
  })

  test("Codex forks the marked thread with this thread's folder and settings, then continues the fork", async () => {
    const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname
    const store = createFileVendorSessionStore(await folder(), "codex")
    await store.save("thread-codex", "external-thread", { fork: true })
    const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "echo"], vendorSessions: store, launch: { model: "gpt-fixture" } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "thread-codex" })
    const events = await drain(backend.send({ sessionId: session.id, message: "what did we find?" }))
    const answer = events.find((event) => event.type === "assistant.message") as { readonly text: string } | undefined
    expect(JSON.parse(answer?.text ?? "{}").thread).toEqual({ method: "thread/fork", params: { threadId: "external-thread", cwd: "/tmp", excludeTurns: true, model: "gpt-fixture" } })
    expect(await vendorSessionEntry(store, "thread-codex")).toEqual({ vendorSessionId: "external-thread-fork", fork: false })
    await backend.close(session.id)
  })

  test("an import continued in the tool carries no recap; one continued in Runrail does", () => {
    const record = (seq: number, kind: string, payload: unknown): TranscriptRecord => ({ version: 1, seq, at: seq, sessionId: "t", kind, payload } as TranscriptRecord)
    const history = [
      record(1, "message.user", { text: "Why does the login test fail?" }),
      record(2, "assistant.message", { version: 1, sessionId: "t", seq: 2, at: 2, type: "assistant.message", turnId: "x", text: "The cookie races." }),
    ]
    expect(carryoverText([...history, record(3, SESSION_IMPORTED, { type: SESSION_IMPORTED, source: "claude-code" })])).toContain("The cookie races.")
    expect(carryoverText([...history, record(3, SESSION_IMPORTED, { type: SESSION_IMPORTED, source: "claude-code", inTool: true })])).toBeUndefined()
  })

  test("only a thread on the session's own tool, in its default config folder, can seed it", async () => {
    registerClaudeAgentSdk(scriptedSdk(forkAware).sdk)
    const sessionDir = await folder()
    const base = { cwd: "/tmp", loadExtensions: false, verifyAfterTurn: false, sessionDir, harnessCommand: process.execPath, harnessProtocol: "sdk" as const }
    const claude = await createRunrailSession({ ...base, backend: "claude-code", sessionId: "seed-claude" })
    try {
      expect(claude.continuesToolSessions("claude-code")).toBe(true)
      expect(claude.continuesToolSessions("codex")).toBe(false)
      await expect(claude.seedToolSession("codex", "external-1")).rejects.toMatchObject({ code: "SESSION_TOOL_SESSION_UNSUPPORTED" })
      await claude.seedToolSession("claude-code", "external-1")
      const [file] = await readdir(join(sessionDir, "harness"))
      expect(JSON.parse(await readFile(join(sessionDir, "harness", file!), "utf8"))).toMatchObject({ backend: "claude-code", sessionId: "seed-claude", vendorSessionId: "external-1", fork: true })
    } finally {
      await claude.close()
    }
    const account = await createRunrailSession({ ...base, backend: "claude-code", sessionId: "seed-account", harnessAccount: { configDir: join(sessionDir, "other-claude") } })
    try {
      expect(account.continuesToolSessions("claude-code")).toBe(false)
    } finally {
      await account.close()
    }
    // Over ACP only OpenCode copies a conversation; the others would continue the original.
    for (const [backend, continues] of [["opencode", true], ["gemini", false], ["goose", false], ["copilot", false]] as const) {
      const acp = await createRunrailSession({ cwd: "/tmp", loadExtensions: false, verifyAfterTurn: false, sessionDir, backend, sessionId: `seed-${backend}` })
      try {
        expect([backend, acp.continuesToolSessions(backend)]).toEqual([backend, continues])
      } finally {
        await acp.close()
      }
    }
    const wrapped = await createRunrailSession({ cwd: "/tmp", loadExtensions: false, verifyAfterTurn: false, sessionDir, backend: "opencode", harnessCommand: process.execPath, sessionId: "seed-opencode-wrapped" })
    try {
      expect(wrapped.continuesToolSessions("opencode")).toBe(false)
    } finally {
      await wrapped.close()
    }
    const native = await createRunrailSession({ cwd: "/tmp", loadExtensions: false, verifyAfterTurn: false, sessionDir, backend: "native", sessionId: "seed-native", model: { complete: () => ({ type: "text" as const, text: "ok" }) } })
    try {
      expect(native.continuesToolSessions("claude-code")).toBe(false)
    } finally {
      await native.close()
    }
  })
})

describe("an exact rewind in the tool's own conversation", () => {
  test("the store keeps a mark only beside a fork, and never a flag-like one", async () => {
    const store = createFileVendorSessionStore(await folder(), "claude-code")
    await store.save("thread-1", "kept-1", { fork: true, at: "msg-4" })
    expect(await vendorSessionEntry(store, "thread-1")).toEqual({ vendorSessionId: "kept-1", fork: true, at: "msg-4" })
    await store.save("thread-1", "kept-1", { at: "msg-4" })
    expect(await vendorSessionEntry(store, "thread-1")).toEqual({ vendorSessionId: "kept-1", fork: false })
    await store.save("thread-1", "kept-1", { fork: true, at: "--resume" })
    expect(await vendorSessionEntry(store, "thread-1")).toEqual({ vendorSessionId: "kept-1", fork: true })
  })

  test("print-mode Claude Code marks its last main-conversation message, and a rewind continues a copy from the one before", async () => {
    const store = createFileVendorSessionStore(await folder(), "claude-code")
    const turns: unknown[] = []
    // A sub-agent's message belongs to its own conversation, so it never becomes the mark.
    const records = [
      { type: "system", subtype: "init", session_id: "vendor-1" },
      { type: "assistant", session_id: "vendor-1", uuid: "main-1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } },
      { type: "assistant", session_id: "vendor-1", uuid: "side-1", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "looked" }] } },
      { type: "result", subtype: "success", is_error: false, session_id: "vendor-1" },
    ]
    const script = records.map((record) => `console.log(${JSON.stringify(JSON.stringify(record))})`).join(";")
    const backend = new CommandAgentBackend({ command: process.execPath, args: ["-e", script], promptMode: "stdin", eventMapper: mapClaudeCodeEvent, vendorSessions: store, turnArgs: (turn) => { turns.push(turn); return [] } })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "thread-print" })
    await drain(backend.send({ sessionId: session.id, message: "one" }))
    expect(backend.vendorMark(session.id)).toEqual({ session: "vendor-1", at: "main-1" })
    expect(await backend.prepareRewind(session.id, {})).toBeUndefined()
    expect(await backend.prepareRewind(session.id, { before: { session: "vendor-1", at: "--bad" } })).toBeUndefined()
    const keep = await backend.prepareRewind(session.id, { before: { session: "vendor-0", at: "main-0" } })
    await keep!()
    expect(await vendorSessionEntry(store, "thread-print")).toEqual({ vendorSessionId: "vendor-0", fork: true, at: "main-0" })
    await drain(backend.send({ sessionId: session.id, message: "two" }))
    expect(turns.at(-1)).toEqual({ vendorSessionId: "vendor-0", fork: true, at: "main-0" })
    expect(await vendorSessionEntry(store, "thread-print")).toEqual({ vendorSessionId: "vendor-1", fork: false })
  })

  test("Claude Code over the SDK continues a copy from the mark after a restart", async () => {
    const store = createFileVendorSessionStore(await folder(), "claude-code")
    const { sdk, queries } = scriptedSdk(forkAware)
    const first = new ClaudeAgentSdkBackend({ sdk, command: process.execPath, vendorSessions: store })
    const session = await first.createSession({ cwd: "/tmp", sessionId: "thread-sdk" })
    await drain(first.send({ sessionId: session.id, message: "one" }))
    await drain(first.send({ sessionId: session.id, message: "two" }))
    expect(first.vendorMark(session.id)).toEqual({ session: "vendor-new", at: "msg-2" })
    const keep = await first.prepareRewind(session.id, { before: { session: "vendor-new", at: "msg-1" } })
    await first.close(session.id)
    await keep!()

    const restarted = new ClaudeAgentSdkBackend({ sdk, command: process.execPath, vendorSessions: store })
    await restarted.createSession({ cwd: "/tmp", sessionId: "thread-sdk" })
    await drain(restarted.send({ sessionId: "thread-sdk", message: "two, again" }))
    expect(queries.at(-1)!.options).toMatchObject({ resume: "vendor-new", forkSession: true, resumeSessionAt: "msg-1" })
    expect(await vendorSessionEntry(store, "thread-sdk")).toEqual({ vendorSessionId: "vendor-copy", fork: false })
    await restarted.close("thread-sdk")
  })

  async function loggedCodex(mode: string): Promise<{ readonly command: string; readonly methods: () => Promise<{ readonly method: string; readonly params?: unknown }[]> }> {
    const dir = await folder()
    const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname
    const log = join(dir, "requests.log")
    const command = join(dir, "codex")
    await writeFile(command, `#!/bin/sh\ntee -a '${log}' | '${process.execPath}' '${fixture}' ${mode} "$@"\n`, { mode: 0o755 })
    const methods = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as { method: string; params?: unknown }).filter((request) => typeof request.method === "string")
    return { command, methods }
  }

  test("Codex reverts its own thread only in the step, on a server of its own, once the session's has stopped", async () => {
    const codex = await loggedCodex("normal")
    const store = createFileVendorSessionStore(await folder(), "codex")
    const backend = new CodexAppServerBackend({ command: codex.command, vendorSessions: store })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "thread-codex" })
    await drain(backend.send({ sessionId: session.id, message: "one" }))
    await drain(backend.send({ sessionId: session.id, message: "two" }))
    expect(backend.vendorMark(session.id)).toEqual({ session: "fixture-codex-thread", at: "fixture-turn-2" })
    expect(await backend.prepareRewind(session.id, { turn: { session: "another-thread", at: "fixture-turn-2" } })).toBeUndefined()
    const keep = await backend.prepareRewind(session.id, { turn: { session: "fixture-codex-thread", at: "fixture-turn-2" } })
    await backend.close(session.id)
    expect((await codex.methods()).some((request) => request.method === "thread/revert")).toBe(false)

    await store.save(session.id, undefined)
    await keep!()
    const after = (await codex.methods()).map((request) => request.method)
    expect(after.lastIndexOf("initialize")).toBeGreaterThan(0)
    expect(after.slice(after.lastIndexOf("initialize")).filter((method) => method.startsWith("thread/"))).toEqual(["thread/resume", "thread/revert"])
    expect((await codex.methods()).at(-1)?.params).toEqual({ threadId: "fixture-codex-thread", beforeTurnId: "fixture-turn-2" })
    expect(await vendorSessionEntry(store, "thread-codex")).toEqual({ vendorSessionId: "fixture-codex-thread", fork: false })
  })

  test("a revert Codex refuses fails the step and keeps no thread", async () => {
    const codex = await loggedCodex("revert-refused")
    const store = createFileVendorSessionStore(await folder(), "codex")
    const backend = new CodexAppServerBackend({ command: codex.command, vendorSessions: store })
    const session = await backend.createSession({ cwd: "/tmp", sessionId: "thread-codex" })
    await drain(backend.send({ sessionId: session.id, message: "one" }))
    const keep = await backend.prepareRewind(session.id, { turn: { session: "fixture-codex-thread", at: "fixture-turn-1" } })
    await backend.close(session.id)
    await store.save(session.id, undefined)
    await expect(keep!()).rejects.toBeDefined()
    expect(await vendorSessionEntry(store, "thread-codex")).toBeUndefined()
  })

  test("a rewind the tool made in its own conversation carries no recap; one it could not make does", () => {
    const record = (seq: number, kind: string, payload: unknown): TranscriptRecord => ({ version: 1, seq, at: seq, sessionId: "t", kind, payload } as TranscriptRecord)
    const history = [
      record(1, "message.user", { text: "Why does the login test fail?" }),
      record(2, "assistant.message", { version: 1, sessionId: "t", seq: 2, at: 2, type: "assistant.message", turnId: "x", text: "The cookie races." }),
    ]
    expect(carryoverText([...history, record(3, SESSION_REWOUND, { type: SESSION_REWOUND, removed: 2 })])).toContain("The cookie races.")
    expect(carryoverText([...history, record(3, SESSION_REWOUND, { type: SESSION_REWOUND, removed: 2, inTool: true })])).toBeUndefined()
  })
})
