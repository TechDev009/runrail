import { Database } from "bun:sqlite"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { listExternalSessions, readExternalSession, type ExternalSessionRoots } from "../../src/session/external.ts"
import { observeReads } from "../../src/session/external/common.ts"
import { readStore } from "../../src/session/external/sqlite.ts"

/**
 * The readers for OpenCode, Gemini CLI, Goose and Copilot CLI, on fixtures written in
 * each tool's own format. Every tool's sign-in sits beside its sessions as a canary: no test
 * may see it read.
 */

const CANARY = "CANARY-SECRET-do-not-read"
const cleanup: string[] = []
afterAll(async () => {
  for (const path of cleanup) await rm(path, { recursive: true, force: true })
})
afterEach(() => observeReads(undefined))

async function writeAt(path: string, text: string, seconds?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, "utf8")
  if (seconds !== undefined) await utimes(path, seconds, seconds)
}

const lines = (...values: unknown[]) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`

async function fixtures(): Promise<{ base: string; cwd: string; roots: ExternalSessionRoots }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "runrail-readers-")))
  cleanup.push(base)
  const cwd = join(base, "repo")
  await mkdir(join(cwd, "web"), { recursive: true })
  const roots = {
    claudeCode: join(base, "claude", "projects"),
    codex: join(base, "codex", "sessions"),
    pi: join(base, "pi", "sessions"),
    opencode: join(base, "share", "opencode"),
    gemini: join(base, "gemini", "tmp"),
    goose: join(base, "share", "goose", "sessions"),
    copilot: join(base, "copilot", "session-state"),
  }

  // OpenCode: its store, with an account table and auth.json beside it that must stay unread.
  await mkdir(roots.opencode, { recursive: true })
  await writeFile(join(roots.opencode, "auth.json"), JSON.stringify({ anthropic: { key: CANARY } }))
  const opencode = new Database(join(roots.opencode, "opencode.db"))
  opencode.exec("PRAGMA journal_mode = WAL")
  opencode.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE credential (id TEXT, secret TEXT);
    CREATE TABLE account (id TEXT, token TEXT);`)
  opencode.query("INSERT INTO credential VALUES ('c', ?)").run(CANARY)
  opencode.query("INSERT INTO account VALUES ('a', ?)").run(CANARY)
  const session = opencode.query("INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, 'p', ?, ?, ?, 1, ?, ?)")
  session.run("ses_main1", null, cwd, "Fix the checkout total", 3_000_000_000_000, null)
  session.run("ses_child1", "ses_main1", cwd, "Subagent search", 3_000_000_000_500, null)
  session.run("ses_old1", null, cwd, "Archived work", 3_000_000_000_600, 5)
  session.run("ses_else1", null, join(base, "elsewhere"), "Another folder", 3_000_000_000_700, null)
  const message = opencode.query("INSERT INTO message VALUES (?, 'ses_main1', ?, ?, ?)")
  const part = opencode.query("INSERT INTO part VALUES (?, ?, 'ses_main1', ?, ?, ?)")
  message.run("msg_1", 10, 10, JSON.stringify({ role: "user" }))
  part.run("prt_1a", "msg_1", 10, 10, JSON.stringify({ type: "text", text: "Why is the checkout total wrong?" }))
  part.run("prt_1b", "msg_1", 10, 10, JSON.stringify({ type: "text", text: "Called the Read tool with cart.ts", synthetic: true }))
  message.run("msg_2", 20, 20, JSON.stringify({ role: "assistant" }))
  part.run("prt_2a", "msg_2", 20, 20, JSON.stringify({ type: "reasoning", text: "thinking aloud" }))
  part.run("prt_2b", "msg_2", 20, 20, JSON.stringify({ type: "tool", tool: "read", callID: "call_1", state: { status: "completed", input: { filePath: "src/cart.ts" }, output: "export const total = 0" } }))
  part.run("prt_2c", "msg_2", 20, 20, JSON.stringify({ type: "tool", tool: "bash", callID: "call_2", state: { status: "error", input: { command: "bun test" }, error: "1 failing" } }))
  part.run("prt_2d", "msg_2", 20, 20, JSON.stringify({ type: "text", text: "Tax is added twice." }))
  opencode.close()

  // Gemini CLI: one project folder naming its root, one older folder named for its path's hash.
  await writeAt(join(base, "gemini", "oauth_creds.json"), CANARY)
  await writeAt(join(roots.gemini, "repo", ".project_root"), `${cwd}\n`)
  const geminiId = "4a649dec-1111-4222-8333-944455556666"
  const prompt = { id: "m1", timestamp: "2026-10-01T10:00:00.000Z", type: "user", content: [{ text: "<session_context>\nThis is the Gemini CLI.\n</session_context>" }] }
  const ask = { id: "m2", timestamp: "2026-10-01T10:00:01.000Z", type: "user", content: [{ text: "List the failing tests" }] }
  const answer = {
    id: "m3",
    timestamp: "2026-10-01T10:00:05.000Z",
    type: "gemini",
    content: [{ text: "considering", thought: true }, { text: "Two tests fail in cart." }],
    toolCalls: [
      { id: "t1", name: "run_shell_command", args: { command: "bun test" }, status: "success", timestamp: "2026-10-01T10:00:03.000Z", result: [{ functionResponse: { id: "t1", name: "run_shell_command", response: { output: "2 failing" } } }] },
      { id: "t2", name: "read_file", args: { path: "missing.ts" }, status: "error", timestamp: "2026-10-01T10:00:04.000Z", result: [{ functionResponse: { id: "t2", name: "read_file", response: { error: "not found" } } }] },
    ],
  }
  await writeAt(join(roots.gemini, "repo", "chats", "session-2026-10-01T10-00-4a649dec.jsonl"), lines(
    { sessionId: geminiId, projectHash: "x", startTime: "2026-10-01T10:00:00.000Z", lastUpdated: "2026-10-01T10:00:00.000Z", kind: "main" },
    { $set: { messages: [prompt], lastUpdated: "2026-10-01T10:00:00.000Z" } },
    { $set: { messages: [prompt, ask], lastUpdated: "2026-10-01T10:00:01.000Z" } },
    { $set: { messages: [prompt, ask, answer], lastUpdated: "2026-10-01T10:00:05.000Z" } },
  ), 3_000_000_100)
  const hashed = createHash("sha256").update(cwd).digest("hex")
  await writeAt(join(roots.gemini, hashed, "chats", "session-2026-09-01T10-00-9b1d2c3e.json"), JSON.stringify({
    sessionId: "9b1d2c3e-1111-4222-8333-944455556666",
    projectHash: hashed,
    startTime: "2026-09-01T10:00:00.000Z",
    messages: [{ id: "a", timestamp: "2026-09-01T10:00:00.000Z", type: "user", content: "Rename the store module" }, { id: "b", timestamp: "2026-09-01T10:00:02.000Z", type: "gemini", content: "Renamed." }],
  }), 3_000_000_050)

  // Goose: its store, with a session it ran for a subagent.
  await mkdir(roots.goose, { recursive: true })
  const goose = new Database(join(roots.goose, "sessions.db"))
  goose.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at TIMESTAMP, parent_session_id TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, metadata_json TEXT);`)
  const gooseSession = goose.query("INSERT INTO sessions (id, name, description, session_type, working_dir, updated_at) VALUES (?, ?, '', ?, ?, ?)")
  gooseSession.run("20261001_1", "", "user", join(cwd, "web"), "2066-01-24 10:00:00")
  gooseSession.run("20261001_2", "Helper", "sub_agent", cwd, "2066-01-24 11:00:00")
  const gooseMessage = goose.query("INSERT INTO messages (session_id, role, content_json, created_timestamp, metadata_json) VALUES ('20261001_1', ?, ?, ?, ?)")
  gooseMessage.run("user", JSON.stringify([{ type: "text", text: "Add a dark mode toggle" }]), 1_800_000_000, JSON.stringify({ userVisible: true, agentVisible: true }))
  gooseMessage.run("assistant", JSON.stringify([{ type: "text", text: "Looking at the header." }, { type: "toolRequest", id: "tr_1", toolCall: { status: "success", value: { name: "developer__shell", arguments: { command: "rg toggle" } } } }]), 1_800_000_001, null)
  gooseMessage.run("user", JSON.stringify([{ type: "toolResponse", id: "tr_1", toolResult: { status: "success", value: [{ type: "text", text: "src/header.tsx" }] } }]), 1_800_000_002, null)
  gooseMessage.run("user", JSON.stringify([{ type: "text", text: "Summary Goose made for itself" }]), 1_800_000_003, JSON.stringify({ userVisible: false, agentVisible: true }))
  gooseMessage.run("assistant", JSON.stringify([{ type: "text", text: "Added the toggle." }]), 1_800_000_004, null)
  goose.close()

  // Copilot CLI: a session with its workspace file, one without, a folder with no events, and its sign-in beside.
  await writeAt(join(base, "copilot", "config.json"), JSON.stringify({ token: CANARY }))
  await writeAt(join(base, "copilot", "session-store.db"), CANARY)
  const copilotId = "25ea3725-dc58-429f-b3bd-a570e501bb9b"
  await writeAt(join(roots.copilot, copilotId, "workspace.yaml"), `id: ${copilotId}\ncwd: ${cwd}\nname: "Speed up: the build"\nuser_named: true\nbranch: feat/build\nsummary_count: 0\n`)
  await writeAt(join(roots.copilot, copilotId, "events.jsonl"), lines(
    { type: "session.start", data: { sessionId: copilotId, context: { cwd } }, id: "e1", timestamp: "2026-10-02T09:00:00.000Z", parentId: null },
    { type: "system.message", data: { role: "system", content: "You are Copilot" }, id: "e2", timestamp: "2026-10-02T09:00:00.000Z" },
    { type: "user.message", data: { content: "Make the build faster", transformedContent: "<context>...</context> Make the build faster" }, id: "e3", timestamp: "2026-10-02T09:00:01.000Z" },
    { type: "assistant.message", data: { content: "", toolRequests: [{ toolCallId: "tc1", name: "bash", arguments: { command: "time bun run build" }, type: "function" }] }, id: "e4", timestamp: "2026-10-02T09:00:02.000Z" },
    { type: "tool.execution_complete", data: { toolCallId: "tc1", success: true, result: { content: "real 41s" } }, id: "e5", timestamp: "2026-10-02T09:00:44.000Z" },
    { type: "assistant.message", data: { content: "The build takes 41s; caching the deps halves it.", toolRequests: [] }, id: "e6", timestamp: "2026-10-02T09:00:45.000Z" },
  ), 3_000_000_200)
  const bareId = "31168bf1-fe2b-4857-8abf-9f7680d955dc"
  await writeAt(join(roots.copilot, bareId, "events.jsonl"), lines(
    { type: "session.start", data: { sessionId: bareId, context: { cwd: join(cwd, "web") } }, id: "e1", timestamp: "2026-10-02T08:00:00.000Z" },
    { type: "user.message", data: { content: "Check the web tests" }, id: "e2", timestamp: "2026-10-02T08:00:01.000Z" },
  ), 3_000_000_150)
  await mkdir(join(roots.copilot, "72636338-359b-4a5d-bc47-5d95f850feb1"), { recursive: true })
  return { base, cwd, roots }
}

function watch(): { reads: { path: string; detail?: string }[] } {
  const reads: { path: string; detail?: string }[] = []
  observeReads((path, detail) => reads.push({ path, ...(detail === undefined ? {} : { detail }) }))
  return { reads }
}

/** No path outside the tools' session stores, no sign-in file, and no query of another table. */
function expectOnlySessions(reads: readonly { path: string; detail?: string }[], roots: ExternalSessionRoots): void {
  expect(reads.length).toBeGreaterThan(0)
  const stores = [roots.opencode, roots.gemini, roots.goose, roots.copilot, roots.claudeCode, roots.codex, roots.pi].filter((root): root is string => root !== undefined)
  for (const read of reads) {
    expect(stores.some((root) => read.path.startsWith(`${root}/`))).toBe(true)
    expect(read.path).not.toMatch(/auth\.json|oauth_creds|config\.json|session-store\.db/)
    // Anything but a file slice is a query: a read of sessions, never of an account or a credential.
    if (read.detail === undefined || read.detail === "head" || read.detail === "whole") continue
    expect(read.detail).toMatch(/^\s*(SELECT|PRAGMA table_info\(sessions\))/)
    expect(read.detail).not.toMatch(/credential|account|auth/i)
  }
}

describe("sessions from OpenCode, Gemini CLI, Goose and Copilot CLI", () => {
  test("list in this workspace, newest first, with titles, counts and branches, reading only session stores and only bounded slices", async () => {
    const { cwd, roots } = await fixtures()
    const { reads } = watch()
    const listed = await listExternalSessions({ cwd, roots })
    expect(listed.sessions.map((session) => [session.source, session.id, session.title, session.messages ?? session.bytes !== undefined])).toEqual([
      ["goose", "20261001_1", "Add a dark mode toggle", 5],
      ["copilot", "25ea3725-dc58-429f-b3bd-a570e501bb9b", "Speed up: the build", true],
      ["copilot", "31168bf1-fe2b-4857-8abf-9f7680d955dc", "Check the web tests", true],
      ["gemini", "4a649dec-1111-4222-8333-944455556666", "List the failing tests", true],
      ["gemini", "9b1d2c3e-1111-4222-8333-944455556666", "Rename the store module", true],
      ["opencode", "ses_main1", "Fix the checkout total", 2],
    ])
    expect(listed.sessions.find((session) => session.source === "copilot")).toMatchObject({ branch: "feat/build", cwd })
    expectOnlySessions(reads, roots)
    // A listing reads heads and tails only, never a whole session file.
    expect(reads.filter((read) => read.detail === "whole")).toEqual([])

    const everywhere = await listExternalSessions({ cwd, roots, everywhere: true })
    expect(everywhere.sessions.find((session) => session.id === "ses_else1")).toMatchObject({ source: "opencode", missing: true })
    expect(everywhere.sessions.some((session) => session.id === "ses_child1" || session.id === "ses_old1" || session.id === "20261001_2")).toBe(false)
  })

  test("a session read after its mark gives only what came later, and one changed before it is not taken as grown", async () => {
    const { cwd, roots } = await fixtures()
    const first = await readExternalSession({ cwd, source: "opencode", id: "ses_main1", roots })
    expect(first.mark.records).toBe(6)
    const store = new Database(join(roots.opencode!, "opencode.db"))
    store.query("INSERT INTO message VALUES ('msg_3', 'ses_main1', 30, 30, ?)").run(JSON.stringify({ role: "user" }))
    store.query("INSERT INTO part VALUES ('prt_3a', 'msg_3', 'ses_main1', 30, 30, ?)").run(JSON.stringify({ type: "text", text: "Fix it then" }))
    store.query("INSERT INTO message VALUES ('msg_4', 'ses_main1', 40, 40, ?)").run(JSON.stringify({ role: "assistant" }))
    store.query("INSERT INTO part VALUES ('prt_4a', 'msg_4', 'ses_main1', 40, 40, ?)").run(JSON.stringify({ type: "text", text: "Fixed." }))
    const later = await readExternalSession({ cwd, source: "opencode", id: "ses_main1", roots, after: first.mark })
    expect(later.grew).toBe(true)
    expect(later.first).toBe(6)
    expect(later.bundle.records.map((record) => (record.payload as { text?: string }).text)).toEqual(["Fix it then", "Fixed."])
    expect(later.bundle.records.map((record) => (record.payload as { turnId?: string }).turnId)).toEqual([undefined, "import-2"])
    expect(later.mark.records).toBe(8)
    expect((await readExternalSession({ cwd, source: "opencode", id: "ses_main1", roots, after: later.mark })).bundle.records).toEqual([])

    store.query("UPDATE part SET data = ? WHERE id = 'prt_2d'").run(JSON.stringify({ type: "text", text: "Tax is added once." }))
    store.close()
    expect((await readExternalSession({ cwd, source: "opencode", id: "ses_main1", roots, after: later.mark })).grew).toBe(false)
    await expect(readExternalSession({ cwd, source: "opencode", id: "ses_main1", roots, after: { records: 0, digest: "x" } })).rejects.toThrow("session mark is invalid")
  })

  test("OpenCode: the prompt without what the tool added, tool calls with outcomes, and the reply; reasoning is dropped", async () => {
    const { cwd, roots } = await fixtures()
    const { reads } = watch()
    const read = await readExternalSession({ cwd, source: "opencode", id: "ses_main1", roots })
    expect(read.title).toBe("Fix the checkout total")
    expect(read.bundle.records.map((record) => [record.kind, (record.payload as { text?: string; name?: string; ok?: boolean; output?: string }).text ?? (record.payload as { name?: string }).name, (record.payload as { ok?: boolean }).ok, (record.payload as { output?: string }).output])).toEqual([
      ["message.user", "Why is the checkout total wrong?", undefined, undefined],
      ["tool.started", "read", undefined, undefined],
      ["tool.completed", "read", true, "export const total = 0"],
      ["tool.started", "bash", undefined, undefined],
      ["tool.completed", "bash", false, "1 failing"],
      ["assistant.message", "Tax is added twice.", undefined, undefined],
    ])
    // A failed call carries a whole agent error: the event protocol needs its message, in the tool's words.
    const failed = read.bundle.records.find((record) => record.kind === "tool.completed" && (record.payload as { ok?: boolean }).ok === false)
    expect(failed?.payload).toMatchObject({ error: { code: "TOOL_FAILED", message: "1 failing" } })
    expectOnlySessions(reads, roots)
    await expect(readExternalSession({ cwd, source: "opencode", id: "ses_child1", roots })).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND" })
    await expect(readExternalSession({ cwd, source: "opencode", id: "ses_else1", roots })).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND" })
  })

  test("Gemini CLI: the latest message list, without injected context or thoughts, and an older single-file chat", async () => {
    const { cwd, roots } = await fixtures()
    const { reads } = watch()
    const read = await readExternalSession({ cwd, source: "gemini", id: "4a649dec-1111-4222-8333-944455556666", roots })
    expect(read.bundle.records.map((record) => [record.kind, (record.payload as { text?: string; name?: string }).text ?? (record.payload as { name?: string }).name, (record.payload as { ok?: boolean }).ok, (record.payload as { output?: string }).output])).toEqual([
      ["message.user", "List the failing tests", undefined, undefined],
      ["assistant.message", "Two tests fail in cart.", undefined, undefined],
      ["tool.started", "run_shell_command", undefined, undefined],
      ["tool.completed", "run_shell_command", true, "2 failing"],
      ["tool.started", "read_file", undefined, undefined],
      ["tool.completed", "read_file", false, "not found"],
    ])
    const old = await readExternalSession({ cwd, source: "gemini", id: "9b1d2c3e-1111-4222-8333-944455556666", roots })
    expect(old.bundle.records.map((record) => record.kind)).toEqual(["message.user", "assistant.message"])
    expectOnlySessions(reads, roots)
  })

  test("Goose: text, tool requests and their responses, without what Goose hid from the person", async () => {
    const { cwd, roots } = await fixtures()
    const { reads } = watch()
    const read = await readExternalSession({ cwd, source: "goose", id: "20261001_1", roots })
    expect(read.bundle.records.map((record) => [record.kind, (record.payload as { text?: string; name?: string }).text ?? (record.payload as { name?: string }).name, (record.payload as { ok?: boolean }).ok])).toEqual([
      ["message.user", "Add a dark mode toggle", undefined],
      ["assistant.message", "Looking at the header.", undefined],
      ["tool.started", "developer__shell", undefined],
      ["tool.completed", "developer__shell", true],
      ["assistant.message", "Added the toggle.", undefined],
    ])
    expect(read.bundle.records[0]?.at).toBe(1_800_000_000_000)
    await expect(readExternalSession({ cwd, source: "goose", id: "20261001_2", roots })).rejects.toMatchObject({ code: "EXTERNAL_NOT_FOUND" })
    expectOnlySessions(reads, roots)
  })

  test("Copilot CLI: what the person typed, tool calls and replies; a session with no workspace file takes its folder from its start", async () => {
    const { cwd, roots } = await fixtures()
    const { reads } = watch()
    const read = await readExternalSession({ cwd, source: "copilot", id: "25ea3725-dc58-429f-b3bd-a570e501bb9b", roots })
    expect(read.bundle.records.map((record) => [record.kind, (record.payload as { text?: string; name?: string }).text ?? (record.payload as { name?: string }).name, (record.payload as { ok?: boolean }).ok])).toEqual([
      ["message.user", "Make the build faster", undefined],
      ["tool.started", "bash", undefined],
      ["tool.completed", "bash", true],
      ["assistant.message", "The build takes 41s; caching the deps halves it.", undefined],
    ])
    const bare = await readExternalSession({ cwd: join(cwd, "web"), source: "copilot", id: "31168bf1-fe2b-4857-8abf-9f7680d955dc", roots })
    expect(bare.bundle.records.map((record) => record.kind)).toEqual(["message.user"])
    await expect(readExternalSession({ cwd, source: "copilot", id: "../../copilot", roots })).rejects.toMatchObject({ code: "EXTERNAL_INVALID" })
    expectOnlySessions(reads, roots)
  })

  test("a store the tool holds locked is read from a copy in a temporary folder, which is deleted after", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "runrail-locked-")))
    cleanup.push(base)
    const path = join(base, "sessions.db")
    const writer = new Database(path)
    writer.exec("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('kept')")
    writer.exec("BEGIN EXCLUSIVE")
    writer.exec("INSERT INTO sessions VALUES ('uncommitted')")
    try {
      const { reads } = watch()
      const before = new Set(await readdir(tmpdir()))
      const rows = await readStore(path, (store) => store.all<{ id: string }>("SELECT id FROM sessions"))
      expect(rows?.map((row) => row.id)).toEqual(["kept"])
      const copy = reads.find((read) => read.path !== path && read.path.endsWith("sessions.db"))?.path
      expect(copy).toContain("runrail-import-")
      // The copy's folder is gone again.
      expect([...(await readdir(tmpdir()))].filter((name) => name.startsWith("runrail-import-") && !before.has(name))).toEqual([])
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
  })

  test("a host that names only the first three tools' folders reads no other tool", async () => {
    const { cwd, roots } = await fixtures()
    const { reads } = watch()
    const listed = await listExternalSessions({ cwd, roots: { claudeCode: roots.claudeCode, codex: roots.codex, pi: roots.pi } })
    expect(listed.sessions).toEqual([])
    expect(reads).toEqual([])
  })
})
