import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConnectorSetupStore } from "../../src/connectors/setup.ts"
import { createPluginManager } from "../../src/plugins/manager.ts"
import { vapidKeys } from "../../src/push/web-push.ts"
import { createShareReference, revokeShare } from "../../src/share/index.ts"
import { FileNativeEventJournal } from "../../src/task/persistence.ts"
import { FileShareStore } from "../../src/share/store.ts"
import { describeToolCall } from "../../src/tools/presentation.ts"
import { FileTranscriptStore } from "../../src/transcript/store.ts"
import { LiveFrameHub } from "../../src/live/hub.ts"
import { createWorkspacePolicy, filteredEnvironment, isSensitiveWorkspacePath, type WorkspaceReport } from "../../src/workspace/policy.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function folder(prefix: string, under = tmpdir()): Promise<string> {
  const dir = await realpath(await mkdtemp(join(under, prefix)))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("search reaches past 2,048 files, and a listing that stops early says so", async () => {
  const root = await folder("runrail-audit-search-")
  await mkdir(join(root, "a"))
  await Promise.all(Array.from({ length: 2_200 }, (_, index) => writeFile(join(root, "a", `f${String(index).padStart(4, "0")}.txt`), index === 2_199 ? "needle\n" : "hay\n")))
  const policy = await createWorkspacePolicy(root)
  const search: WorkspaceReport = { truncated: false, skipped: 0 }
  expect((await policy.search("", "needle", 10, undefined, search)).map((match) => match.path)).toEqual(["a/f2199.txt"])
  expect(search.truncated).toBe(false)
  const listing: WorkspaceReport = { truncated: false, skipped: 0 }
  expect((await policy.list("a", 1, 5, listing)).length).toBe(5)
  expect(listing.truncated).toBe(true)
})

test("file tools do not write the config that other coding tools and hook runners execute", async () => {
  const root = await folder("runrail-audit-control-")
  const policy = await createWorkspacePolicy(root)
  for (const path of [".husky/pre-commit", ".githooks/pre-push", ".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/run.sh", ".codex/config.toml", ".vscode/tasks.json"])
    await expect([path, await policy.write(path, "x").then(() => "written", () => "refused")]).toEqual([path, "refused"])
  await policy.write(".claude/commands/review.md", "ok")
  await policy.write(".vscode/settings.json", "{}")
})

test("env templates are readable, and a project under a credential-looking folder is not off limits", async () => {
  expect(isSensitiveWorkspacePath(".env.example")).toBe(false)
  expect(isSensitiveWorkspacePath("config/.env.sample")).toBe(false)
  expect(isSensitiveWorkspacePath(".env.local")).toBe(true)
  expect(isSensitiveWorkspacePath("id_ed25519")).toBe(true)
  const parent = await folder("runrail-audit-parent-")
  const root = join(parent, ".ssh", "project")
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "notes.txt"), "hello")
  expect(await (await createWorkspacePolicy(root)).read("notes.txt")).toBe("hello")
})

test("a link swapped in for the file is not followed on read or write", async () => {
  const root = await folder("runrail-audit-link-")
  const outside = await folder("runrail-audit-outside-")
  await writeFile(join(outside, "secret.txt"), "outside")
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"))
  const policy = await createWorkspacePolicy(root)
  await expect(policy.read("link.txt")).rejects.toThrow()
  await expect(policy.write("link.txt", "overwritten")).rejects.toThrow()
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside")
})

test("a relative PATH entry is not handed to the programs the agent runs", () => {
  const original = process.env.PATH
  process.env.PATH = `/usr/bin:./node_modules/.bin::bin:/bin`
  try {
    expect(filteredEnvironment().PATH).toBe("/usr/bin:/bin")
  } finally {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
  }
})

test("an approval card for a command in another folder names the folder", () => {
  const card = describeToolCall("run_command", { program: "make", args: ["deploy"], cwd: "/work/api" })
  expect(card.command).toBe("cd /work/api && make deploy")
})

test("two first calls to the share store cannot put old state over a revoked share", async () => {
  const root = await folder("runrail-audit-share-")
  const share = createShareReference({ taskId: "task-1", ownerId: "user-1", mode: "read-only-live", now: 100 })
  await new FileShareStore({ root }).put(share)
  const store = new FileShareStore({ root })
  const revoked = revokeShare(share, "user-1", share.revision)
  await Promise.all([store.put(revoked), store.get(share.shareId), store.list()])
  expect((await new FileShareStore({ root }).get(share.shareId))?.status).toBe("revoked")
})

test("a damaged VAPID file gets a new key, and two first callers share one", async () => {
  const dir = await folder("runrail-audit-vapid-")
  await writeFile(join(dir, "vapid.json"), '{"version":1,"publicKey":')
  const [first, second] = await Promise.all([vapidKeys(dir), vapidKeys(dir)])
  expect(first.publicKey).toBe(second.publicKey)
  expect((await vapidKeys(dir)).publicKey).toBe(first.publicKey)
})

test("connector settings saved at the same moment are all kept", async () => {
  const dir = await folder("runrail-audit-connectors-")
  const store = new ConnectorSetupStore(join(dir, "connectors.json"))
  await Promise.all([store.save("github", { on: true }), store.save("linear", { on: true }), store.save("slack", { on: true })])
  expect(Object.keys(await store.read()).sort()).toEqual(["github", "linear", "slack"])
  expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
})

test("a plugin folder that does not verify is listed as unavailable, can be removed, and does not stop the rest", async () => {
  const workspace = await folder("runrail-audit-plugin-")
  const bad = join(workspace, ".runrail", "plugins", "broken")
  await mkdir(bad, { recursive: true })
  await writeFile(join(bad, "runrail.plugin.json"), "{ not json")
  const manager = await createPluginManager({ workspaceRoot: workspace })
  expect(manager.unavailable().map((entry) => entry.name)).toEqual(["broken"])
  await manager.remove("broken")
  expect(manager.unavailable()).toEqual([])
  expect((await readdir(join(workspace, ".runrail", "plugins"))).includes("broken")).toBe(false)
})

test("a transcript read stops parsing at the records it was asked for", async () => {
  const root = await folder("runrail-audit-transcript-")
  const store = new FileTranscriptStore({ root })
  for (let index = 0; index < 3; index += 1) await store.append("s1", { kind: "note", payload: { index } })
  const path = join(root, (await readdir(root)).find((name) => name.includes("s1"))!)
  const lines = (await readFile(path, "utf8")).split("\n")
  await writeFile(path, [lines[0], lines[1], "{ broken"].join("\n") + "\n")
  expect((await store.read("s1", { maxRecords: 1 })).map((record) => record.seq)).toEqual([0])
  expect((await store.read("s1", { afterSeq: 0, maxRecords: 1 })).map((record) => record.seq)).toEqual([1])
})

test("live frames after a cursor are found in a ring that has dropped its oldest", () => {
  const hub = new LiveFrameHub({ sessionId: "s", maxFrames: 4 })
  for (let index = 0; index < 10; index += 1) hub.emit({ type: "reasoning.delta", text: `t${String(index)}` })
  expect(hub.since(hub.lastLiveSeq - 2).map((frame) => frame.liveSeq)).toEqual([hub.lastLiveSeq - 1, hub.lastLiveSeq])
  expect(hub.since(hub.oldestCursor()).length).toBe(4)
  expect(() => hub.since(0)).toThrow()
})

test("a damaged event journal is set aside instead of refusing every new session", async () => {
  const root = await folder("runrail-audit-journal-")
  const line = (seq: number): string => JSON.stringify({ contractVersion: 1, eventId: `t:${String(seq)}`, taskId: "t", sessionId: "s", seq, at: 1_000 + seq, type: "task.started" })
  await writeFile(join(root, "events.jsonl"), `${line(0)}\n{ not json\n${line(2)}\n`)
  const journal = new FileNativeEventJournal({ root })
  expect(journal.read("t")).toEqual([])
  expect((await readdir(root)).includes("events.jsonl.corrupt")).toBe(true)
  journal.append({ eventId: "t:3", taskId: "t", sessionId: "s", seq: 3, at: 2_000, type: "task.started" })
  expect(journal.read("t", 2).map((event) => event.seq)).toEqual([3])
})
