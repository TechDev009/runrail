import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"
import { MODEL_HISTORY_HEADER } from "../../src/session/history.ts"
import type { ExternalSessionRoots } from "../../src/session/external.ts"
import { registerClaudeAgentSdk } from "../../src/index.ts"
import { forkAware, scriptedSdk } from "../fixtures/scripted-claude-sdk.ts"

const token = "control-external-token-1234567890"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>

function rpcFor(url: string): Rpc {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  return async (method, params = {}) => {
    const response = await fetch(`${url}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
}

interface ModelRequest {
  readonly sessionId: string
  readonly messages: readonly { readonly role: string; readonly text: string }[]
}

function capturingModel(requests: ModelRequest[]) {
  return {
    complete(request: ModelRequest) {
      requests.push(request)
      return { type: "text" as const, text: "continued" }
    },
  }
}

const CLAUDE_ID = "5b0e8e53-7f7c-4d8e-9a55-0c4f5a8e1a01"
const CLAUDE_SUBDIR_ID = "5b0e8e53-7f7c-4d8e-9a55-0c4f5a8e1a02"
const CLAUDE_SIBLING_ID = "5b0e8e53-7f7c-4d8e-9a55-0c4f5a8e1a03"
const CODEX_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const CODEX_SUBAGENT_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"
const CODEX_OTHER_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d"
const PI_ID = "pisession01"

const lines = (...values: unknown[]) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`

async function writeAt(path: string, text: string, mtimeSeconds: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, "utf8")
  await utimes(path, mtimeSeconds, mtimeSeconds)
}

/** Writes one fixture session per harness, plus sessions that must stay hidden from this workspace. */
async function fixtures(): Promise<{ cwd: string; roots: ExternalSessionRoots }> {
  const base = await realpath(await mkdtemp("/tmp/runrail-external-"))
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const cwd = join(base, "repo")
  await mkdir(join(cwd, "packages", "app"), { recursive: true })
  const roots = { claudeCode: join(base, "claude", "projects"), codex: join(base, "codex", "sessions"), pi: join(base, "pi", "sessions") }
  const claudeFolder = (path: string) => join(roots.claudeCode, path.replace(/[^A-Za-z0-9]/g, "-"))
  const at = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`

  await writeAt(join(claudeFolder(cwd), `${CLAUDE_ID}.jsonl`), lines(
    { type: "summary", summary: "Fix the flaky login test", leafUuid: "leaf" },
    { type: "user", cwd, gitBranch: "main", sessionId: CLAUDE_ID, timestamp: at(0), message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { type: "user", cwd, isMeta: true, timestamp: at(0), message: { role: "user", content: "Caveat: the messages below were generated locally" } },
    { type: "user", cwd, timestamp: at(1), message: { role: "user", content: "Why does the login test fail?" } },
    { type: "assistant", cwd, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/login.ts" } }] } },
    { type: "user", cwd, timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export function login() {}" }] } },
    { type: "assistant", cwd, isSidechain: true, timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "sidechain noise" }] } },
    { type: "assistant", cwd, timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: "The test races the session cookie." }] } },
  ), 1_000_400)
  await writeAt(join(claudeFolder(join(cwd, "packages", "app")), `${CLAUDE_SUBDIR_ID}.jsonl`), lines(
    { type: "user", cwd: join(cwd, "packages", "app"), timestamp: at(5), message: { role: "user", content: "Bump the app version" } },
  ), 1_000_100)
  // A sibling folder shares the encoded prefix but lives outside the workspace.
  await writeAt(join(claudeFolder(`${cwd}-other`), `${CLAUDE_SIBLING_ID}.jsonl`), lines(
    { type: "user", cwd: `${cwd}-other`, timestamp: at(6), message: { role: "user", content: "Secret sibling work" } },
  ), 1_000_500)

  const codexDir = join(roots.codex, "2026", "09", "02")
  await writeAt(join(codexDir, `rollout-2026-09-02T10-00-00-${CODEX_ID}.jsonl`), lines(
    { timestamp: at(10), type: "session_meta", payload: { id: CODEX_ID, cwd, git: { branch: "feature/health" }, source: "cli" } },
    { timestamp: at(10), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/somewhere</cwd>\n</environment_context>" }] } },
    { timestamp: at(11), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a health check endpoint" }] } },
    { timestamp: at(12), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bun", "test"] }), call_id: "call_1" } },
    { timestamp: at(13), type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ output: "1 failing", metadata: { exit_code: 1 } }) } },
    { timestamp: at(14), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added /health; one test still fails." }] } },
  ), 1_000_300)
  await writeAt(join(codexDir, `rollout-2026-09-02T11-00-00-${CODEX_SUBAGENT_ID}.jsonl`), lines(
    { type: "session_meta", payload: { id: CODEX_SUBAGENT_ID, cwd, source: { subagent: "review" } } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review this" }] } },
  ), 1_000_600)
  await writeAt(join(codexDir, `rollout-2026-09-02T12-00-00-${CODEX_OTHER_ID}.jsonl`), lines(
    { type: "session_meta", payload: { id: CODEX_OTHER_ID, cwd: "/elsewhere/project", source: "cli" } },
  ), 1_000_700)

  const piFolder = join(roots.pi, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)
  await writeAt(join(piFolder, `2026-09-03T10-00-00-000Z_${PI_ID}.jsonl`), lines(
    { type: "session", version: 3, id: PI_ID, timestamp: at(20), cwd },
    { type: "message", id: "a1", parentId: null, timestamp: at(21), message: { role: "user", content: [{ type: "text", text: "Rename the config loader" }] } },
    { type: "message", id: "a2", parentId: "a1", timestamp: at(22), message: { role: "assistant", content: [{ type: "text", text: "Abandoned branch answer" }] } },
    { type: "message", id: "b2", parentId: "a1", timestamp: at(23), message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls src" } }] } },
    { type: "message", id: "b3", parentId: "b2", timestamp: at(24), message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "config.ts" }], isError: false } },
    { type: "message", id: "b4", parentId: "b3", timestamp: at(25), message: { role: "assistant", content: [{ type: "text", text: "Renamed to loadConfig." }] } },
    { type: "session_info", id: "b5", parentId: "b4", timestamp: at(26), name: "Config loader rename" },
  ), 1_000_200)
  return { cwd, roots }
}

async function start(cwd: string, roots: ExternalSessionRoots, transcriptRoot: string, sessionId: string, requests: ModelRequest[]) {
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    sessionId,
    transcriptStore: new FileTranscriptStore({ root: transcriptRoot }),
    externalSessionRoots: roots,
    model: capturingModel(requests),
  })
  return running
}

test("external sessions list only this workspace, newest first, with titles and branches", async () => {
  const { cwd, roots } = await fixtures()
  const running = await start(cwd, roots, join(cwd, "..", "transcripts"), "thread-list", [])
  cleanup.push(() => running.handle.stop())
  const rpc = rpcFor(running.handle.url)

  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["session.external"]).toBe("available")

  const listed = await rpc("session.external.list")
  expect(listed.status).toBe(200)
  const result = listed.body.result as { sessions: { source: string; id: string; title?: string; branch?: string; updatedAt: number; bytes: number }[]; truncated?: boolean }
  expect(result.truncated).toBeUndefined()
  expect(result.sessions.map((session) => [session.source, session.id])).toEqual([
    ["claude-code", CLAUDE_ID],
    ["codex", CODEX_ID],
    ["pi", PI_ID],
    ["claude-code", CLAUDE_SUBDIR_ID],
  ])
  expect(result.sessions[0]).toMatchObject({ title: "Fix the flaky login test", branch: "main", updatedAt: 1_000_400_000 })
  expect(result.sessions[1]).toMatchObject({ title: "Add a health check endpoint", branch: "feature/health" })
  expect(result.sessions[2]).toMatchObject({ title: "Config loader rename" })
  expect(result.sessions[3]).toMatchObject({ title: "Bump the app version" })
  expect(JSON.stringify(result)).not.toContain("Secret sibling")

  const limited = await rpc("session.external.list", { limit: 1 })
  expect(limited.body.result).toMatchObject({ sessions: [{ id: CLAUDE_ID }], truncated: true })
  expect((await rpc("session.external.list", { limit: 0 })).status).toBe(400)
})

test("every folder's sessions list with their folders, a gone folder is marked, and one from another folder still does not import here", async () => {
  const { cwd, roots } = await fixtures()
  await mkdir(`${cwd}-other`)
  const running = await start(cwd, roots, join(cwd, "..", "transcripts"), "thread-everywhere", [])
  cleanup.push(() => running.handle.stop())
  const rpc = rpcFor(running.handle.url)

  const listed = await rpc("session.external.list", { scope: "all" })
  expect(listed.status).toBe(200)
  const sessions = (listed.body.result as { sessions: { source: string; id: string; cwd?: string; missing?: true }[] }).sessions
  expect(sessions.map((session) => [session.id, session.cwd, session.missing])).toEqual([
    [CODEX_OTHER_ID, "/elsewhere/project", true],
    [CLAUDE_SIBLING_ID, `${cwd}-other`, undefined],
    [CLAUDE_ID, cwd, undefined],
    [CODEX_ID, cwd, undefined],
    [PI_ID, cwd, undefined],
    [CLAUDE_SUBDIR_ID, join(cwd, "packages", "app"), undefined],
  ])
  // This workspace's own listing gives each session's folder too.
  expect(((await rpc("session.external.list")).body.result as { sessions: unknown[] }).sessions[0]).toMatchObject({ id: CLAUDE_ID, cwd })
  expect((await rpc("session.external.list", { scope: "everywhere" })).status).toBe(400)

  // Listing is not importing: a session from another folder is found only by a thread in a workspace that holds it.
  const refused = await rpc("session.external.import", { source: "claude-code", id: CLAUDE_SIBLING_ID })
  expect(refused.status).toBe(404)
  const there = await start(`${cwd}-other`, roots, join(cwd, "..", "transcripts"), "thread-other", [])
  cleanup.push(() => there.handle.stop())
  const imported = await rpcFor(there.handle.url)("session.external.import", { source: "claude-code", id: CLAUDE_SIBLING_ID })
  expect(imported.status).toBe(200)
  expect(imported.body.result).toMatchObject({ source: "claude-code", imported: 1 })
})

test("importing a session fills an empty thread and becomes model history", async () => {
  const { cwd, roots } = await fixtures()
  const transcripts = join(cwd, "..", "transcripts")
  const requests: ModelRequest[] = []
  const running = await start(cwd, roots, transcripts, "thread-import", requests)
  const rpc = rpcFor(running.handle.url)

  for (const [params, status, code] of [
    [{ source: "cursor", id: CLAUDE_ID }, 400, "CONTROL_INVALID_INPUT"],
    [{ source: "claude-code", id: "../../etc/passwd" }, 400, "CONTROL_INVALID_INPUT"],
    [{ source: "claude-code", id: "missing-session" }, 404, "CONTROL_NOT_FOUND"],
    [{ source: "claude-code", id: CLAUDE_SIBLING_ID }, 404, "CONTROL_NOT_FOUND"],
    [{ source: "codex", id: CODEX_SUBAGENT_ID }, 404, "CONTROL_NOT_FOUND"],
    [{ source: "codex", id: CODEX_OTHER_ID }, 404, "CONTROL_NOT_FOUND"],
  ] as const) {
    const refused = await rpc("session.external.import", params)
    expect([refused.status, (refused.body.error as { code: string }).code]).toEqual([status, code])
  }

  const imported = await rpc("session.external.import", { source: "claude-code", id: CLAUDE_ID })
  expect(imported.status).toBe(200)
  expect(imported.body.result).toMatchObject({ sessionId: "thread-import", source: "claude-code", title: "Fix the flaky login test", imported: 5 })
  // The question, the first answer, the tool call with its result, and the last answer.
  expect((imported.body.result as { historyMessages: number }).historyMessages).toBe(4)

  const read = await rpc("session.conversation.read")
  const items = (read.body.result as { items: { kind: string; text?: string; status?: string; code?: string; name?: string }[] }).items
  expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant", "notice"])
  expect(items[0]?.text).toBe("Why does the login test fail?")
  expect(items[2]?.status).toBe("ok")
  expect(items[4]).toMatchObject({ code: "session.imported", name: "Claude Code" })
  expect(JSON.stringify(items)).not.toContain("sidechain noise")
  expect(JSON.stringify(items)).not.toContain("/clear")

  const again = await rpc("session.external.import", { source: "pi", id: PI_ID })
  expect([again.status, (again.body.error as { code: string }).code]).toEqual([409, "CONTROL_TRANSCRIPT_CONFLICT"])

  expect((await rpc("turn.enqueue", { message: "Fix it then" })).status).toBe(200)
  const first = requests[0]
  expect(first?.sessionId).toBe("thread-import")
  const texts = first?.messages.map((message) => message.text) ?? []
  const start0 = texts.findIndex((text) => text.startsWith(MODEL_HISTORY_HEADER))
  expect(start0).toBeGreaterThanOrEqual(0)
  expect(texts[start0]).toContain("Why does the login test fail?")
  expect(first?.messages.slice(start0, start0 + 4).map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
  expect(texts[start0 + 3]).toContain("The test races the session cookie.")
  expect(texts[texts.length - 1]).toBe("Fix it then")
  await running.handle.stop()

  // A restarted engine reloads the imported turns and the turn it ran after them.
  const restartedRequests: ModelRequest[] = []
  const restarted = await start(cwd, roots, transcripts, "thread-import", restartedRequests)
  cleanup.push(() => restarted.handle.stop())
  expect((await rpcFor(restarted.handle.url)("turn.enqueue", { message: "Now add a test" })).status).toBe(200)
  const restored = restartedRequests[0]?.messages.map((message) => message.text).join("\n\n") ?? ""
  expect(restored).toContain("Why does the login test fail?")
  expect(restored).toContain("Fix it then")
  expect(restored).toContain("continued")
  expect(restored.indexOf(MODEL_HISTORY_HEADER)).toBe(restored.lastIndexOf(MODEL_HISTORY_HEADER))
})

test("codex and pi sessions import with tool outcomes and the active pi branch", async () => {
  const { cwd, roots } = await fixtures()
  const transcripts = join(cwd, "..", "transcripts")
  const codex = await start(cwd, roots, transcripts, "thread-codex", [])
  cleanup.push(() => codex.handle.stop())
  expect((await rpcFor(codex.handle.url)("session.external.import", { source: "codex", id: CODEX_ID })).status).toBe(200)
  const codexItems = ((await rpcFor(codex.handle.url)("session.conversation.read")).body.result as { items: { kind: string; text?: string; status?: string; name?: string }[] }).items
  expect(codexItems.map((item) => item.kind)).toEqual(["user", "tool", "assistant", "notice"])
  expect(codexItems[0]?.text).toBe("Add a health check endpoint")
  expect(codexItems[1]?.status).toBe("failed")
  expect(codexItems[3]?.name).toBe("Codex")

  const pi = await start(cwd, roots, transcripts, "thread-pi", [])
  cleanup.push(() => pi.handle.stop())
  const piImport = await rpcFor(pi.handle.url)("session.external.import", { source: "pi", id: PI_ID })
  expect(piImport.body.result).toMatchObject({ title: "Config loader rename" })
  const piItems = ((await rpcFor(pi.handle.url)("session.conversation.read")).body.result as { items: { kind: string; text?: string; status?: string }[] }).items
  expect(piItems.map((item) => item.kind)).toEqual(["user", "tool", "assistant", "notice"])
  expect(piItems[1]?.status).toBe("ok")
  expect(piItems[2]?.text).toBe("Renamed to loadConfig.")
  expect(JSON.stringify(piItems)).not.toContain("Abandoned branch")
})

test("a Claude Code session continued in Claude Code forks it there, keeps the copy readable, and sends no recap", async () => {
  const { cwd, roots } = await fixtures()
  const { sdk, queries } = scriptedSdk(forkAware)
  registerClaudeAgentSdk(sdk)
  cleanup.push(async () => registerClaudeAgentSdk(undefined))
  const original = join(roots.claudeCode, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${CLAUDE_ID}.jsonl`)
  const before = await readFile(original, "utf8")
  const sessionDir = join(cwd, "..", "session")
  const running = await startRunrailControlRpcServer({ cwd, backend: "claude-code", harnessCommand: process.execPath, harnessProtocol: "sdk", authToken: token, loadExtensions: false, verifyAfterTurn: false, sessionId: "thread-in-tool", sessionDir, transcriptStore: new FileTranscriptStore({ root: join(cwd, "..", "transcripts") }), externalSessionRoots: roots })
  cleanup.push(() => running.handle.stop())
  const rpc = rpcFor(running.handle.url)

  for (const [params, status, code] of [
    [{ source: "claude-code", id: CLAUDE_ID, continueIn: "elsewhere" }, 400, "CONTROL_INVALID_INPUT"],
    [{ source: "codex", id: CODEX_ID, continueIn: "tool" }, 409, "CONTROL_CAPABILITY_UNAVAILABLE"],
  ] as const) {
    const refused = await rpc("session.external.import", params)
    expect([refused.status, (refused.body.error as { code: string }).code]).toEqual([status, code])
  }
  const imported = await rpc("session.external.import", { source: "claude-code", id: CLAUDE_ID, continueIn: "tool" })
  expect(imported.status).toBe(200)
  expect(imported.body.result).toMatchObject({ sessionId: "thread-in-tool", source: "claude-code", imported: 5, inTool: true })
  const items = ((await rpc("session.conversation.read")).body.result as { items: { kind: string; code?: string; inTool?: boolean }[] }).items
  expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant", "notice"])
  expect(items[4]).toMatchObject({ code: "session.imported", inTool: true })

  expect((await rpc("turn.enqueue", { message: "What did we find?" })).status).toBe(200)
  for (let waited = 0; queries[0]?.prompts.length !== 1 && waited < 100; waited += 1) await Bun.sleep(20)
  expect(queries[0]!.options).toMatchObject({ resume: CLAUDE_ID, forkSession: true })
  expect(queries[0]!.prompts).toEqual(["What did we find?"])
  expect(await readFile(original, "utf8")).toBe(before)
})

test("a session that grew in its tool brings in only its new turns, once, until the thread moves on", async () => {
  const { cwd, roots } = await fixtures()
  const path = join(roots.claudeCode, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${CLAUDE_ID}.jsonl`)
  const original = await readFile(path, "utf8")
  const requests: ModelRequest[] = []
  const running = await start(cwd, roots, join(cwd, "..", "transcripts"), "thread-refresh", requests)
  cleanup.push(() => running.handle.stop())
  const rpc = rpcFor(running.handle.url)
  const code = (response: { status: number; body: Record<string, unknown> }) => [response.status, (response.body.error as { code: string } | undefined)?.code]

  expect(code(await rpc("session.external.refresh", { dryRun: true }))).toEqual([404, "CONTROL_NOT_FOUND"])
  expect(code(await rpc("session.external.refresh", { dryRun: "yes" }))).toEqual([400, "CONTROL_INVALID_INPUT"])
  expect((await rpc("session.external.import", { source: "claude-code", id: CLAUDE_ID })).status).toBe(200)
  expect((await rpc("session.external.refresh", { dryRun: true })).body.result).toMatchObject({ source: "claude-code", turns: 0, imported: 0 })

  const turn = (minute: number, prompt: string, reply: string) => [
    { type: "user", cwd, timestamp: `2026-09-01T10:${minute}:00.000Z`, message: { role: "user", content: prompt } },
    { type: "assistant", cwd, timestamp: `2026-09-01T10:${minute + 1}:00.000Z`, message: { role: "assistant", content: [{ type: "text", text: reply }] } },
  ]
  await writeAt(path, original + lines(...turn(10, "Can you add a retry?", "Added a retry."), ...turn(12, "And a test?", "Test added.")), 1_000_500)
  expect((await rpc("session.external.refresh", { dryRun: true })).body.result).toMatchObject({ turns: 2, imported: 0 })
  expect((await rpc("session.conversation.read")).body.result).toMatchObject({ items: { length: 5 } })
  expect((await rpc("session.external.refresh")).body.result).toMatchObject({ sessionId: "thread-refresh", source: "claude-code", turns: 2, imported: 4 })
  expect((await rpc("session.external.refresh")).body.result).toMatchObject({ turns: 0, imported: 0 })

  const items = ((await rpc("session.conversation.read")).body.result as { items: { kind: string; text?: string; code?: string }[] }).items
  expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant", "notice", "user", "assistant", "user", "assistant", "notice"])
  expect(items[9]).toMatchObject({ code: "session.refreshed", name: "Claude Code", turns: 2 })
  expect(items.filter((item) => item.text === "Can you add a retry?")).toHaveLength(1)

  // The model gets the session once, with its new turns.
  expect((await rpc("turn.enqueue", { message: "Ship it" })).status).toBe(200)
  const history = requests[0]?.messages.map((message) => message.text).join("\n\n") ?? ""
  expect(history).toContain("Test added.")
  expect(history.split("Why does the login test fail?")).toHaveLength(2)
  expect(history.split("Can you add a retry?")).toHaveLength(2)

  // Once the thread has run a turn of its own, what the session gains later stays in its tool.
  await writeAt(path, original + lines(...turn(10, "Can you add a retry?", "Added a retry."), ...turn(12, "And a test?", "Test added."), ...turn(14, "Docs too?", "Done.")), 1_000_600)
  expect(code(await rpc("session.external.refresh", { dryRun: true }))).toEqual([409, "CONTROL_TRANSCRIPT_CONFLICT"])
  expect(await readFile(path, "utf8")).toContain("Docs too?")
})

test("a session changed in its tool before the point it was imported to is not brought in again", async () => {
  const { cwd, roots } = await fixtures()
  const path = join(roots.claudeCode, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${CLAUDE_ID}.jsonl`)
  const original = await readFile(path, "utf8")
  const running = await start(cwd, roots, join(cwd, "..", "transcripts"), "thread-changed", [])
  cleanup.push(() => running.handle.stop())
  const rpc = rpcFor(running.handle.url)
  expect((await rpc("session.external.import", { source: "claude-code", id: CLAUDE_ID })).status).toBe(200)
  await writeAt(path, original.replace("The test races the session cookie.", "The cookie is fine."), 1_000_500)
  const refused = await rpc("session.external.refresh")
  expect([refused.status, (refused.body.error as { code: string }).code]).toEqual([409, "CONTROL_EXTERNAL_CHANGED"])
  expect(((await rpc("session.conversation.read")).body.result as { items: unknown[] }).items).toHaveLength(5)
})

test("external import needs caller-owned transcript storage", async () => {
  const { cwd, roots } = await fixtures()
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", authToken: token, loadExtensions: false, externalSessionRoots: roots, model: capturingModel([]) })
  cleanup.push(() => running.handle.stop())
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["session.external"]).toBe("configurable")
  const refused = await rpcFor(running.handle.url)("session.external.import", { source: "pi", id: PI_ID })
  expect([refused.status, (refused.body.error as { code: string }).code]).toEqual([501, "CONTROL_TRANSCRIPT_UNAVAILABLE"])
  expect((await rpcFor(running.handle.url)("session.external.list")).status).toBe(200)
})

test("a session longer than the record bound keeps its newest records, and an edited session is read again", async () => {
  const { listExternalSessions, readExternalSession } = await import("../../src/session/external.ts")
  const { cwd, roots } = await fixtures()
  const path = join(roots.claudeCode, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${CLAUDE_ID}.jsonl`)
  const turns = Array.from({ length: 50 }, (_, index) => ({ type: "user", cwd, timestamp: "2026-09-01T11:00:00.000Z", message: { role: "user", content: `message ${index}` } }))
  await writeAt(path, lines({ type: "summary", summary: "First title", leafUuid: "leaf" }, ...turns), 1_000_400)
  expect((await listExternalSessions({ cwd, roots })).sessions.find((item) => item.id === CLAUDE_ID)?.title).toBe("First title")
  const imported = await readExternalSession({ cwd, roots, source: "claude-code", id: CLAUDE_ID, maxRecords: 5 })
  expect(imported.bundle.records.map((record) => (record.payload as { text?: string }).text)).toEqual(["message 45", "message 46", "message 47", "message 48", "message 49"])
  expect(imported.bundle.records.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4])
  await writeAt(path, lines({ type: "summary", summary: "Second title", leafUuid: "leaf" }, ...turns), 1_000_401)
  expect((await listExternalSessions({ cwd, roots })).sessions.find((item) => item.id === CLAUDE_ID)?.title).toBe("Second title")
})

test("a Pi branch longer than the record bound keeps its newest records and reads only the tail", async () => {
  const { readExternalSession } = await import("../../src/session/external.ts")
  const { cwd, roots } = await fixtures()
  const piFolder = join(roots.pi, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)
  const huge = "x".repeat(200_000)
  const entries = Array.from({ length: 60 }, (_, index) => ({ type: "message", id: `m${index}`, parentId: index === 0 ? null : `m${index - 1}`, timestamp: "2026-09-03T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: index < 50 ? huge : `turn ${index}` }] } }))
  await writeAt(join(piFolder, `2026-09-03T10-00-00-000Z_${PI_ID}.jsonl`), lines({ type: "session", version: 3, id: PI_ID, timestamp: "2026-09-03T10:00:00.000Z", cwd }, ...entries), 1_000_900)
  const imported = await readExternalSession({ cwd, roots, source: "pi", id: PI_ID, maxRecords: 3 })
  expect(imported.bundle.records.map((record) => (record.payload as { text?: string }).text)).toEqual(["turn 57", "turn 58", "turn 59"])
  expect(imported.truncated).toBe(true)
})
