import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SuiteStore } from "../../src/evals/suite.ts"
import { PluginManager } from "../../src/plugins/manager.ts"
import { LocalGitWorktreeManager } from "../../src/worktree/manager.ts"
import { FileTranscriptStore, peekTranscript } from "../../src/transcript/store.ts"
import { SetupStore } from "../../src/setups/store.ts"
import { FileNativeTaskStore } from "../../src/task/store.ts"
import { FileNativeCommandLedger } from "../../src/task/persistence.ts"
import { parseNativeCommand, type NativeCommandResult } from "../../src/native/commands.ts"
import type { NativeTaskRecord } from "../../src/task/types.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runrail-security-storage-"))
  roots.push(root)
  return root
}
const suite = { name: "safe", check: "true", cases: [{ id: "case", base: "a".repeat(40), fix: "b".repeat(40), tests: ["test/a.ts"] }] }

test("eval suites reject linked directories and files without external changes", async () => {
  const root = await temporary()
  const outside = await temporary()
  await mkdir(join(root, ".runrail"))
  await writeFile(join(outside, "safe.yaml"), "unchanged")
  await symlink(outside, join(root, ".runrail", "evals"))
  const store = new SuiteStore(root)
  await expect(store.save(suite)).rejects.toMatchObject({ code: "EVAL_STORE_FAILED" })
  await expect(store.get("safe")).rejects.toMatchObject({ code: "EVAL_STORE_FAILED" })
  await expect(store.list()).rejects.toMatchObject({ code: "EVAL_STORE_FAILED" })
  expect(await readFile(join(outside, "safe.yaml"), "utf8")).toBe("unchanged")
  await rm(join(root, ".runrail", "evals"))
  await mkdir(join(root, ".runrail", "evals"))
  await symlink(join(outside, "safe.yaml"), join(root, ".runrail", "evals", "safe.yaml"))
  await expect(store.save(suite)).rejects.toMatchObject({ code: "EVAL_STORE_FAILED" })
  await expect(store.get("safe")).rejects.toMatchObject({ code: "EVAL_STORE_FAILED" })
})

test("plugin and worktree initialization reject linked ancestors before mkdir", async () => {
  const root = await temporary()
  const outside = await temporary()
  await symlink(outside, join(root, ".runrail"))
  await expect(new PluginManager({ workspaceRoot: root }).initialize()).rejects.toMatchObject({ code: "PLUGIN_MANAGER_INVALID" })
  await expect(new LocalGitWorktreeManager({ workspaceRoot: root }).create({ id: "child" })).rejects.toMatchObject({ code: "WORKTREE_INVALID" })
  expect(await readdir(outside)).toEqual([])
})

test("transcript append, read, recovery, import, and peek refuse symlink files", async () => {
  const root = await temporary()
  const source = new FileTranscriptStore({ root: await temporary() })
  await source.append("session", { kind: "text", payload: "private fixture" })
  const bundle = await source.export("session")
  const outside = join(await temporary(), "outside.jsonl")
  await writeFile(outside, `${JSON.stringify(JSON.parse(bundle).records[0])}\n`)
  const original = await readFile(outside, "utf8")
  await symlink(outside, join(root, "session.jsonl"))
  const store = new FileTranscriptStore({ root })
  await expect(store.append("session", { kind: "text", payload: "must not write" })).rejects.toMatchObject({ code: "TRANSCRIPT_IO" })
  await expect(store.read("session")).rejects.toMatchObject({ code: "TRANSCRIPT_IO" })
  await expect(store.recover("session")).rejects.toMatchObject({ code: "TRANSCRIPT_IO" })
  await expect(store.import(bundle)).rejects.toMatchObject({ code: "TRANSCRIPT_IO" })
  await expect(peekTranscript(join(root, "session.jsonl"), "session")).rejects.toMatchObject({ code: "TRANSCRIPT_IO" })
  expect(await readFile(outside, "utf8")).toBe(original)
})

test("transcript writes reject linked roots and restore private permissions", async () => {
  const parent = await temporary()
  const outside = await temporary()
  await symlink(outside, join(parent, "transcripts"))
  await expect(new FileTranscriptStore({ root: join(parent, "transcripts") }).append("s", { kind: "text", payload: "x" })).rejects.toMatchObject({ code: "TRANSCRIPT_IO" })
  expect(await readdir(outside)).toEqual([])
  const root = await temporary()
  const store = new FileTranscriptStore({ root })
  await store.append("s", { kind: "text", payload: "first" })
  await chmod(join(root, "s.jsonl"), 0o666)
  await store.append("s", { kind: "text", payload: "second" })
  expect((await stat(join(root, "s.jsonl"))).mode & 0o777).toBe(0o600)
})

test("transcript storage creates a missing root through canonical OS ancestors", async () => {
  const parent = await temporary()
  const store = new FileTranscriptStore({ root: join(parent, "missing", "transcripts") })
  await store.append("s", { kind: "text", payload: "fixture" })
  expect((await store.read("s")).map((record) => record.payload)).toEqual(["fixture"])
})

test("transcripts reject non-regular files and oversized sparse files before reading", async () => {
  const root = await temporary()
  await mkdir(join(root, "directory.jsonl"))
  const store = new FileTranscriptStore({ root, maxEntryBytes: 1024, maxRecords: 2 })
  await expect(store.append("directory", { kind: "text", payload: "x" })).rejects.toMatchObject({ code: "TRANSCRIPT_IO" })
  const path = join(root, "large.jsonl")
  const handle = await open(path, "w")
  try { await handle.truncate(4096) } finally { await handle.close() }
  await expect(store.read("large")).rejects.toMatchObject({ code: "TRANSCRIPT_LIMIT" })
  await expect(store.recover("large")).rejects.toMatchObject({ code: "TRANSCRIPT_LIMIT" })
  await expect(peekTranscript(path, "large", { maxEntryBytes: 1024, maxRecords: 2 })).rejects.toMatchObject({ code: "TRANSCRIPT_LIMIT" })
})

const setup = (id: string) => ({ id, name: id, roles: { executor: { route: "codex", access: "auto-edit" } }, rules: { reviewRounds: 0, check: "true" } })
test("independent setup stores serialize complete read-modify-write operations", async () => {
  const user = join(await temporary(), "setups.json")
  const stores = Array.from({ length: 8 }, () => new SetupStore({ user }))
  await Promise.all(stores.map((store, index) => store.save(setup(`setup-${index}`))))
  expect((await new SetupStore({ user }).list()).setups.map((item) => item.id)).toEqual(Array.from({ length: 8 }, (_, index) => `setup-${index}`))
  await Promise.all(stores.map((store, index) => store.delete(`setup-${index}`)))
  expect((await new SetupStore({ user }).list()).setups).toEqual([])
})

const task = (taskId: string, title = "task"): NativeTaskRecord => ({ contractVersion: 1, taskId, projectId: "p", sessionId: "s", title, status: "draft", createdAt: 1, updatedAt: 1, revision: 0, lastEventSeq: -1 })
test("rejected task writes never enter live state or poison subsequent persistence", async () => {
  const root = await temporary()
  const store = new FileNativeTaskStore({ root, maxBytes: 1024 })
  const large = task("bad", "\u754c".repeat(256))
  await store.put(task("ok"))
  await expect(store.put(large)).rejects.toMatchObject({ code: "NATIVE_LIMIT" })
  expect(await store.get("bad")).toBeUndefined()
  await store.put(task("next"))
  expect((await new FileNativeTaskStore({ root }).list()).map((item) => item.taskId).sort()).toEqual(["next", "ok"])
})

test("failed task deletion preserves committed state and queued writes recover", async () => {
  const root = await temporary()
  const store = new FileNativeTaskStore({ root })
  await store.put(task("keep"))
  await rename(join(root, "tasks.json"), join(root, "saved.json"))
  await mkdir(join(root, "tasks.json"))
  await expect(store.delete("keep")).rejects.toThrow()
  expect(await store.get("keep")).toEqual(task("keep"))
  await rm(join(root, "tasks.json"), { recursive: true })
  await rename(join(root, "saved.json"), join(root, "tasks.json"))
  await Promise.all([store.put(task("a")), store.put(task("b"))])
  expect((await new FileNativeTaskStore({ root }).list()).map((item) => item.taskId).sort()).toEqual(["a", "b", "keep"])
})

function ledgerEntry(key: string, digest = "ok") {
  const command = parseNativeCommand({ contractVersion: 1, commandId: "c-command", idempotencyKey: key, taskId: "t", sessionId: "s", name: "task.start", requestedAt: 1, timeoutMs: 1000 })
  const result: NativeCommandResult = { contractVersion: 1, commandId: command.commandId, idempotencyKey: key, status: "completed", acceptedAt: 1, digest }
  return { command, result }
}
test("command ledger failures cannot evict or clear committed entries", async () => {
  const root = await temporary()
  const ledger = new FileNativeCommandLedger({ root, maxEntries: 1, maxBytes: 1024 })
  const first = ledgerEntry("first")
  ledger.put(first.command, first.result)
  const oversized = ledgerEntry('"'.repeat(240), "\u754c".repeat(128))
  expect(() => ledger.put(oversized.command, oversized.result)).toThrow()
  expect(ledger.get("first")).toEqual(first.result)
  expect(ledger.get(oversized.command.idempotencyKey)).toBeUndefined()
  await rename(join(root, "commands.json"), join(root, "saved.json"))
  await mkdir(join(root, "commands.json"))
  expect(() => ledger.clear("t")).toThrow()
  expect(ledger.get("first")).toEqual(first.result)
  await rm(join(root, "commands.json"), { recursive: true })
  await rename(join(root, "saved.json"), join(root, "commands.json"))
  expect(new FileNativeCommandLedger({ root }).get("first")).toEqual(first.result)
})
