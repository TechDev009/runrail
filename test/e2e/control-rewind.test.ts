import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createFileVendorSessionStore } from "../../src/harness/vendor-session-store.ts"
import { registerClaudeAgentSdk } from "../../src/index.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"
import { forkAware, scriptedSdk } from "../fixtures/scripted-claude-sdk.ts"

/** A thread goes back to before a message, its files with it. */

const token = "control-rewind-token-1234567890abcdef"
const harness = resolve(import.meta.dir, "../fixtures/prompt-capture-harness.ts")
const cleanup: (() => Promise<void>)[] = []

setDefaultTimeout(30_000)

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Runrail Test", "-c", "user.email=test@runrail.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(`/tmp/${prefix}`))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

type Options = Partial<Parameters<typeof startRunrailControlRpcServer>[0]>

interface Folders {
  readonly repo: string
  readonly sessionDir: string
  readonly transcripts: string
}

async function folders(): Promise<Folders> {
  const repo = await tempDir("runrail-rewind-")
  git(repo, "init", "-q", "-b", "main")
  await writeFile(join(repo, "a.txt"), "one\n")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", "first")
  return { repo, sessionDir: await tempDir("runrail-rewind-session-"), transcripts: await tempDir("runrail-rewind-transcripts-") }
}

async function start(options: Options, existing?: Folders) {
  const { repo, sessionDir, transcripts } = existing ?? (await folders())
  const running = await startRunrailControlRpcServer({
    cwd: repo,
    authToken: token,
    loadExtensions: false,
    sessionDir,
    sessionId: "th-rewind-1",
    transcriptStore: new FileTranscriptStore({ root: transcripts }),
    nativeAccountsDir: await tempDir("runrail-rewind-accounts-"),
    githubCli: false,
    checkpoints: true,
    ...options,
  } as Parameters<typeof startRunrailControlRpcServer>[0])
  let stopped = false
  const stop = async () => {
    if (!stopped) await running.handle.stop()
    stopped = true
  }
  cleanup.push(stop)
  const rpc = async (method: string, params: Readonly<Record<string, unknown>> = {}): Promise<{ readonly status: number; readonly body: any }> => {
    const response = await fetch(`${running.handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
  const health = (await (await fetch(`${running.handle.url}/health`)).json()) as { capabilityStatus: Record<string, string> }
  return { repo, sessionDir, rpc, health, stop, folders: { repo, sessionDir, transcripts } }
}

const conversation = async (rpc: Awaited<ReturnType<typeof start>>["rpc"]) =>
  ((await rpc("session.conversation.read")).body.result.items as { kind: string; text?: string; code?: string; turnId?: string }[])
    .filter((item) => item.kind === "user" || item.kind === "assistant" || item.code === "session.rewound")
    .map((item) => (item.kind === "notice" ? `notice:${item.code}` : `${item.kind}:${item.text}`))

test("Runrail's own loop: the files and the conversation go back, and the next turn reads only what is left", async () => {
  const seen: string[][] = []
  const { repo, rpc, health } = await start({
    backend: "native",
    model: {
      complete: (request: { messages: readonly { role: string; text?: string }[] }) => {
        const users = request.messages.filter((message) => message.role === "user").map((message) => message.text ?? "")
        seen.push(users)
        return { type: "text", text: `answer ${users.length}` }
      },
    },
  })
  expect(health.capabilityStatus["session.rewind"]).toBe("available")
  expect((await rpc("turn.enqueue", { message: "first" })).body.ok).toBe(true)
  await writeFile(join(repo, "a.txt"), "after first\n")
  expect((await rpc("turn.enqueue", { message: "second" })).body.ok).toBe(true)
  await writeFile(join(repo, "a.txt"), "after second\n")
  await writeFile(join(repo, "b.txt"), "new\n")

  const items = (await rpc("session.conversation.read")).body.result.items as { kind: string; text?: string; seq: number; turnId?: string }[]
  const second = items.find((item) => item.kind === "user" && item.text === "second")!
  expect(typeof second.turnId).toBe("string")
  const changes = await rpc("session.checkpoint.changes", { userSeq: second.seq })
  expect(changes.body.result.files).toEqual([
    { path: "a.txt", change: "modified" },
    { path: "b.txt", change: "added" },
  ])

  const rewound = await rpc("session.rewind", { userSeq: second.seq, files: ["a.txt", "b.txt"] })
  expect(rewound.body).toMatchObject({ ok: true, result: { restored: ["a.txt", "b.txt"], failed: [] } })
  expect(rewound.body.result.removed).toBeGreaterThan(1)
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("after first\n")
  expect(existsSync(join(repo, "b.txt"))).toBe(false)
  expect(await conversation(rpc)).toEqual(["user:first", "assistant:answer 1", "notice:session.rewound"])
  expect((await rpc("session.checkpoints.list")).body.result.checkpoints).toHaveLength(1)

  expect((await rpc("turn.enqueue", { message: "second, again" })).body.ok).toBe(true)
  const read = seen.at(-1)!
  expect(read).toHaveLength(2)
  expect(read[0]).toContain("first")
  expect(read[0]).not.toContain("second")
  expect(read[1]).toBe("second, again")
  expect(await conversation(rpc)).toEqual(["user:first", "assistant:answer 1", "notice:session.rewound", "user:second, again", "assistant:answer 2"])
})

test("a coding tool forgets its own conversation and starts again from a recap of what is left", async () => {
  const capture = join(await tempDir("runrail-rewind-capture-"), "prompts.log")
  const { sessionDir, rpc } = await start({ backend: "claude-code", harnessCommand: "bun", harnessArgs: ["run", harness, capture] })
  expect((await rpc("turn.enqueue", { message: "plan the index" })).body.ok).toBe(true)
  expect((await rpc("turn.enqueue", { message: "drop the table" })).body.ok).toBe(true)
  // What a tool route that continues its own conversation keeps: that conversation's id.
  await createFileVendorSessionStore(join(sessionDir, "harness"), "claude-code").save("th-rewind-1", "capture-session")
  const remembered = async () => await readdir(join(sessionDir, "harness")).catch(() => [] as string[])
  expect(await remembered()).toHaveLength(1)

  const items = (await rpc("session.conversation.read")).body.result.items as { kind: string; text?: string; turnId?: string }[]
  const drop = items.find((item) => item.kind === "user" && item.text === "drop the table")
  expect((await rpc("session.rewind", { turnId: drop!.turnId })).body).toMatchObject({ ok: true, result: { restored: [], failed: [] } })
  expect(await remembered()).toEqual([])

  expect((await rpc("turn.enqueue", { message: "add a column instead" })).body.ok).toBe(true)
  const sent = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string)
  const last = sent.at(-1)!
  expect(last).toContain("the user took the thread back to here")
  expect(last).toContain("User: plan the index")
  expect(last).not.toContain("drop the table")
  expect(last).toContain("add a column instead")
})

test("Claude Code cuts its own conversation: the next turn continues a copy from the turn before, with no recap", async () => {
  const { sdk, queries } = scriptedSdk(forkAware)
  registerClaudeAgentSdk(sdk)
  cleanup.push(async () => registerClaudeAgentSdk(undefined))
  const { rpc } = await start({ backend: "claude-code", harnessProtocol: "sdk", harnessCommand: process.execPath })
  for (const message of ["plan the index", "drop the table"]) expect((await rpc("turn.enqueue", { message })).body.ok).toBe(true)
  const items = (await rpc("session.conversation.read")).body.result.items as { kind: string; text?: string; turnId?: string }[]
  const drop = items.find((item) => item.kind === "user" && item.text === "drop the table")
  expect((await rpc("session.rewind", { turnId: drop!.turnId })).body.ok).toBe(true)

  expect((await rpc("turn.enqueue", { message: "add a column instead" })).body.ok).toBe(true)
  const last = queries.at(-1)!
  expect(last.options).toMatchObject({ resume: "vendor-new", forkSession: true, resumeSessionAt: "msg-1" })
  expect(last.prompts).toHaveLength(1)
  expect(last.prompts[0]).toContain("add a column instead")
  expect(last.prompts[0]).not.toContain("took the thread back")
  expect(last.prompts[0]).not.toContain("plan the index")
})

test("Codex reverts its own thread to before the turn and continues it, with no recap", async () => {
  const dir = await tempDir("runrail-rewind-codex-")
  const log = join(dir, "codex-stdin.log")
  const codex = join(dir, "codex")
  const fixture = resolve(import.meta.dir, "../fixtures/codex-app-server.ts")
  await writeFile(codex, `#!/bin/sh\ntee -a '${log}' | '${process.execPath}' '${fixture}' normal "$@"\n`, { mode: 0o755 })
  const { rpc } = await start({ backend: "codex", harnessProtocol: "app-server", harnessCommand: codex })
  for (const message of ["plan the index", "drop the table"]) expect((await rpc("turn.enqueue", { message })).body.ok).toBe(true)
  const items = (await rpc("session.conversation.read")).body.result.items as { kind: string; text?: string; turnId?: string }[]
  const drop = items.find((item) => item.kind === "user" && item.text === "drop the table")
  expect((await rpc("session.rewind", { turnId: drop!.turnId })).body.ok).toBe(true)
  expect((await rpc("turn.enqueue", { message: "add a column instead" })).body.ok).toBe(true)

  const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
  expect(requests.find((request) => request.method === "thread/revert")?.params).toEqual({ threadId: "fixture-codex-thread", beforeTurnId: "fixture-turn-2" })
  expect(requests.filter((request) => request.method === "thread/resume").at(-1)?.params).toMatchObject({ threadId: "fixture-codex-thread" })
  const sent = JSON.stringify(requests.filter((request) => request.method === "turn/start").at(-1)?.params?.input)
  expect(sent).toContain("add a column instead")
  expect(sent).not.toContain("took the thread back")
  expect(sent).not.toContain("plan the index")
})

test("a revert Codex refuses after the cut leaves it a new thread and a recap of what is left", async () => {
  const dir = await tempDir("runrail-rewind-codex-")
  const log = join(dir, "codex-stdin.log")
  const codex = join(dir, "codex")
  const fixture = resolve(import.meta.dir, "../fixtures/codex-app-server.ts")
  await writeFile(codex, `#!/bin/sh\ntee -a '${log}' | '${process.execPath}' '${fixture}' revert-refused "$@"\n`, { mode: 0o755 })
  const { rpc } = await start({ backend: "codex", harnessProtocol: "app-server", harnessCommand: codex })
  for (const message of ["plan the index", "drop the table"]) expect((await rpc("turn.enqueue", { message })).body.ok).toBe(true)
  const items = (await rpc("session.conversation.read")).body.result.items as { kind: string; text?: string; turnId?: string }[]
  const drop = items.find((item) => item.kind === "user" && item.text === "drop the table")
  expect((await rpc("session.rewind", { turnId: drop!.turnId })).body.ok).toBe(true)
  expect((await rpc("turn.enqueue", { message: "add a column instead" })).body.ok).toBe(true)

  const requests = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
  expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2)
  const sent = JSON.stringify(requests.filter((request) => request.method === "turn/start").at(-1)?.params?.input)
  expect(sent).toContain("took the thread back")
  expect(sent).toContain("plan the index")
  expect(sent).not.toContain("drop the table")
})

test("a rewind that fails after the cut still leaves the tool without the removed turns", async () => {
  const capture = join(await tempDir("runrail-rewind-capture-"), "prompts.log")
  const existing = await folders()
  // The first notice of the cut fails to land, as a full disk would refuse it.
  class FlakyStore extends FileTranscriptStore {
    refused = false
    override async append(...args: Parameters<FileTranscriptStore["append"]>) {
      if (!this.refused && args[1].kind === "session.rewound") {
        this.refused = true
        throw new Error("disk full")
      }
      return super.append(...args)
    }
  }
  const { sessionDir, rpc } = await start({ backend: "claude-code", harnessCommand: "bun", harnessArgs: ["run", harness, capture], transcriptStore: new FlakyStore({ root: existing.transcripts }) }, existing)
  expect((await rpc("turn.enqueue", { message: "plan the index" })).body.ok).toBe(true)
  expect((await rpc("turn.enqueue", { message: "drop the table" })).body.ok).toBe(true)
  await createFileVendorSessionStore(join(sessionDir, "harness"), "claude-code").save("th-rewind-1", "capture-session")
  const items = (await rpc("session.conversation.read")).body.result.items as { kind: string; text?: string; turnId?: string }[]
  const drop = items.find((item) => item.kind === "user" && item.text === "drop the table")
  expect((await rpc("session.rewind", { turnId: drop!.turnId })).body.ok).toBe(false)
  expect(await readdir(join(sessionDir, "harness")).catch(() => [] as string[])).toEqual([])

  expect((await rpc("turn.enqueue", { message: "add a column instead" })).body.ok).toBe(true)
  const last = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string).at(-1)!
  expect(last).toContain("the user took the thread back to here")
  expect(last).toContain("User: plan the index")
  expect(last).not.toContain("drop the table")
})

test("a coding tool numbers its turns again after a restart: a turn id names this run's turn, a message's seq names any", async () => {
  const capture = join(await tempDir("runrail-rewind-capture-"), "prompts.log")
  const tool = { backend: "claude-code" as const, harnessCommand: "bun", harnessArgs: ["run", harness, capture] }
  const first = await start(tool)
  expect((await first.rpc("turn.enqueue", { message: "one" })).body.ok).toBe(true)
  expect((await first.rpc("turn.enqueue", { message: "two" })).body.ok).toBe(true)
  await first.stop()
  const again = await start(tool, first.folders)
  expect((await again.rpc("turn.enqueue", { message: "three" })).body.ok).toBe(true)
  const users = ((await again.rpc("session.conversation.read")).body.result.items as { kind: string; text: string; seq: number; turnId?: string }[]).filter((item) => item.kind === "user")
  expect(users.map((item) => [item.text, item.turnId])).toEqual([["one", "runrail-turn-1"], ["two", "runrail-turn-2"], ["three", "runrail-turn-1"]])

  expect((await again.rpc("session.rewind", { turnId: "runrail-turn-1" })).body.ok).toBe(true)
  expect(await conversation(again.rpc)).toEqual(["user:one", "assistant:tool answer", "user:two", "assistant:tool answer", "notice:session.rewound"])
  expect((await again.rpc("session.rewind", { userSeq: users[1]!.seq })).body.ok).toBe(true)
  expect(await conversation(again.rpc)).toEqual(["user:one", "assistant:tool answer", "notice:session.rewound"])
})

test("a turn with no checkpoint, or a busy or unknown request, is refused and changes nothing", async () => {
  const { rpc } = await start({ backend: "native", model: { complete: () => ({ type: "text", text: "done" }) } })
  expect((await rpc("turn.enqueue", { message: "first" })).body.ok).toBe(true)
  expect((await rpc("session.rewind", { turnId: "turn-unknown" })).body).toMatchObject({ ok: false, error: { code: "CONTROL_REWIND_UNAVAILABLE" } })
  expect((await rpc("session.rewind", { turnId: "x", files: "a.txt" })).status).toBe(400)
  expect((await rpc("session.rewind", {})).status).toBe(400)
  expect((await rpc("session.rewind", { turnId: "x", userSeq: 0 })).status).toBe(400)
  expect((await rpc("session.rewind", { userSeq: 1 })).body).toMatchObject({ ok: false, error: { code: "CONTROL_REWIND_UNAVAILABLE" } })
  expect(await conversation(rpc)).toEqual(["user:first", "assistant:done"])
})

test("a rewind's kept copy: the system engine copies a thread's conversation to a new, empty thread", async () => {
  const threadsDir = await tempDir("runrail-rewind-threads-")
  const original = new FileTranscriptStore({ root: join(threadsDir, "th-original", "transcript") })
  await original.append("th-original", { kind: "message.user", payload: { text: "hello" } })
  const { rpc, health } = await start({ backend: "native", model: { complete: () => ({ type: "text", text: "done" }) }, threadsDir })
  expect(health.capabilityStatus["thread.copy"]).toBe("available")
  expect((await rpc("thread.copy", { from: "th-original", to: "th-copy" })).body).toEqual({ ok: true, result: { copied: true } })
  const copy = await new FileTranscriptStore({ root: join(threadsDir, "th-copy", "transcript") }).read("th-copy")
  expect(copy.map((record) => record.kind)).toEqual(["message.user", "session.continued"])
  expect((await rpc("thread.copy", { from: "th-original", to: "th-copy" })).body).toMatchObject({ ok: false, error: { code: "CONTROL_TRANSCRIPT_CONFLICT" } })
  expect((await rpc("thread.copy", { from: "th-original", to: "th-original" })).status).toBe(400)
  expect((await rpc("thread.copy", { from: "../x", to: "th-other" })).status).toBe(400)
  await mkdir(join(threadsDir, "th-empty"))
  expect((await rpc("thread.copy", { from: "th-empty", to: "th-copy-2" })).body).toEqual({ ok: true, result: { copied: false } })
})

test("a fork from earlier: the copy holds only what came before a message that started a turn", async () => {
  const threadsDir = await tempDir("runrail-fork-threads-")
  const original = new FileTranscriptStore({ root: join(threadsDir, "th-original", "transcript") })
  const first = await original.append("th-original", { kind: "message.user", payload: { text: "one" } })
  await original.append("th-original", { kind: "assistant.message", payload: { type: "assistant.message", turnId: "turn-1", text: "first answer" } })
  const second = await original.append("th-original", { kind: "message.user", payload: { text: "two" } })
  const steer = await original.append("th-original", { kind: "message.user", payload: { text: "nudge", steer: true } })
  await original.append("th-original", { kind: "assistant.message", payload: { type: "assistant.message", turnId: "turn-2", text: "second answer" } })
  const { rpc } = await start({ backend: "native", model: { complete: () => ({ type: "text", text: "done" }) }, threadsDir })
  const read = (id: string) => new FileTranscriptStore({ root: join(threadsDir, id, "transcript") }).read(id)

  expect((await rpc("thread.copy", { from: "th-original", to: "th-fork", beforeSeq: second.seq })).body).toEqual({ ok: true, result: { copied: true } })
  expect((await read("th-fork")).map((record) => record.kind)).toEqual(["message.user", "assistant.message", "session.continued"])
  expect((await read("th-original")).length).toBe(5)

  // From before the first message there is nothing to copy; the fork starts empty.
  expect((await rpc("thread.copy", { from: "th-original", to: "th-fork-empty", beforeSeq: first.seq })).body).toEqual({ ok: true, result: { copied: false } })
  expect(await read("th-fork-empty")).toEqual([])

  // A steer or a reply does not start a turn, and a seq past the end names nothing.
  for (const beforeSeq of [steer.seq, second.seq + 2, 99]) expect((await rpc("thread.copy", { from: "th-original", to: `th-fork-${String(beforeSeq)}`, beforeSeq })).body).toMatchObject({ ok: false, error: { code: "CONTROL_TRANSCRIPT_INVALID" } })
  expect((await rpc("thread.copy", { from: "th-original", to: "th-fork-bad", beforeSeq: -1 })).status).toBe(400)
})
