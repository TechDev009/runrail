import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCliArgs } from "../../src/cli.ts"
import { staleSourceCount } from "../../src/memory/sources.ts"
import { appRunning, checkAppBundle, checkLinuxApp, FAILED_GAP_MS, NOTE_FRESH_MS, parseAppNote, SOURCE_SYNC_MS, WAKE_GAP_MS, wakeReason, wakeTick, type WakeState } from "../../src/service/wake.ts"
import { parseWorkflow } from "../../src/workflows/schema.ts"
import { PR_POLL_MS, WorkflowStore } from "../../src/workflows/store.ts"

/** Run after Quit: the service only looks, and opens the app when work is due. */

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "runrail-wake-test-"))
  cleanup.push(path)
  return path
}

const AT = new Date(2026, 9, 5, 8, 0).getTime()
const role = { route: "claude-code", model: "sonnet" } as const
const agent = [{ id: "a", kind: "agent", title: "A", prompt: "p", runsOn: role }]
const hourly = { kind: "schedule", schedule: { kind: "interval", minutes: 60 } }
const SCHEDULED = { workflowId: "wf", name: "Nightly", root: "/one", trigger: "schedule" } as const

test("it opens the app only when the app is not running, for due work, and not again too soon", () => {
  const state: WakeState = {}
  expect(wakeReason({ now: AT, appRunning: true, due: [SCHEDULED], staleSources: 3 }, state)).toBeUndefined()
  expect(wakeReason({ now: AT, appRunning: false, due: [], staleSources: 0 }, state)).toBeUndefined()
  expect(wakeReason({ now: AT, appRunning: false, due: [{ ...SCHEDULED, trigger: "pr-opened", pr: { number: 4 } }, SCHEDULED], staleSources: 0 }, state)).toBe("schedule")
  expect(wakeReason({ now: AT, appRunning: false, due: [{ ...SCHEDULED, trigger: "pr-opened", pr: { number: 4 } }], staleSources: 0 }, state)).toBe("pull-request")
  expect(wakeReason({ now: AT, appRunning: false, due: [], staleSources: 1 }, state)).toBe("memory-sync")

  // Just opened: not again for a while, and longer when the open failed.
  expect(wakeReason({ now: AT + WAKE_GAP_MS - 1, appRunning: false, due: [SCHEDULED], staleSources: 0 }, { lastWake: AT })).toBeUndefined()
  expect(wakeReason({ now: AT + WAKE_GAP_MS, appRunning: false, due: [SCHEDULED], staleSources: 0 }, { lastWake: AT })).toBe("schedule")
  expect(wakeReason({ now: AT + WAKE_GAP_MS, appRunning: false, due: [SCHEDULED], staleSources: 0 }, { lastWake: AT, lastWakeFailed: true })).toBeUndefined()
  expect(wakeReason({ now: AT + FAILED_GAP_MS, appRunning: false, due: [SCHEDULED], staleSources: 0 }, { lastWake: AT, lastWakeFailed: true })).toBe("schedule")

  // A source the app cannot sync opens it once an hour, not every few minutes.
  expect(wakeReason({ now: AT + WAKE_GAP_MS, appRunning: false, due: [], staleSources: 1 }, { lastWake: AT, lastMemoryWake: AT })).toBeUndefined()
  expect(wakeReason({ now: AT + SOURCE_SYNC_MS, appRunning: false, due: [], staleSources: 1 }, { lastWake: AT, lastMemoryWake: AT })).toBe("memory-sync")
})

test("the app counts as running only on a fresh note from a live process", () => {
  const alive = (pid: number): boolean => pid === 42
  expect(appRunning({ pid: 42, at: AT }, AT + NOTE_FRESH_MS, alive)).toBe(true)
  expect(appRunning({ pid: 42, at: AT }, AT + NOTE_FRESH_MS + 1, alive)).toBe(false)
  expect(appRunning({ pid: 7, at: AT }, AT, alive)).toBe(false)
  expect(appRunning({ at: AT }, AT, alive)).toBe(false)
  expect(appRunning(undefined, AT, alive)).toBe(false)

  expect(parseAppNote(JSON.stringify({ pid: 42, at: AT }))).toEqual({ pid: 42, at: AT })
  expect(parseAppNote(JSON.stringify({ pid: null, at: AT }))).toEqual({ at: AT })
  for (const text of ["", "null", "[]", "{}", JSON.stringify({ pid: 42 }), JSON.stringify({ pid: -1, at: AT, pad: "x".repeat(5_000) })]) expect(parseAppNote(text)).toBeUndefined()
  expect(parseAppNote(JSON.stringify({ pid: -1, at: AT }))).toEqual({ at: AT })
})

test("a look marks nothing: what is due stays due until the app's scheduler starts it", async () => {
  const dir = await scratch()
  const store = new WorkflowStore(join(dir, "workflows.json"))
  await store.save(parseWorkflow({ id: "wf", name: "Nightly", trigger: hourly, steps: agent, state: "on" }), { project: "p1", root: "/one" }, AT)
  await store.save(parseWorkflow({ id: "pr", name: "Reviews", trigger: { kind: "pr-opened" }, steps: agent, state: "on" }), { project: "p2", root: "/two" }, AT)
  let open = [{ number: 1 }]
  const lister = async (): Promise<readonly { readonly number: number }[]> => open
  expect(await store.peek(AT + 30 * 60_000, lister)).toEqual([])
  // The app's first look learns what is open.
  await store.due(AT + 30 * 60_000, lister)
  open = [{ number: 1 }, { number: 2 }]
  const later = AT + 61 * 60_000
  const peeked = await store.peek(later, lister)
  expect(peeked.map((due) => [due.workflowId, due.pr?.number])).toEqual([
    ["wf", undefined],
    ["pr", 2],
  ])
  expect(await store.peek(later)).toEqual([SCHEDULED])
  expect(await store.peek(later, lister)).toEqual(peeked)
  expect((await store.due(later, lister)).map((due) => due.workflowId)).toEqual(["wf", "pr"])
  expect(await store.peek(later + PR_POLL_MS, lister)).toEqual([])
})

test("stale sources are counted from the sources file alone", async () => {
  const dir = await scratch()
  const path = join(dir, "sources.json")
  expect(await staleSourceCount(path, AT, SOURCE_SYNC_MS)).toBe(0)
  const source = { kind: "folder", scope: "person", name: "Notes", target: "/notes", addedAt: AT }
  await writeFile(path, JSON.stringify({ sources: [{ ...source, id: "s1" }, { ...source, id: "s2", lastSync: { at: AT, ok: true, added: 0, removed: 0, kept: 0 } }, { ...source, id: "s3", lastSync: { at: AT - SOURCE_SYNC_MS, ok: false, added: 0, removed: 0, kept: 0 } }] }))
  expect(await staleSourceCount(path, AT, SOURCE_SYNC_MS)).toBe(2)
  expect(await staleSourceCount(path, AT + SOURCE_SYNC_MS, SOURCE_SYNC_MS)).toBe(3)
  await writeFile(path, "not json")
  expect(await staleSourceCount(path, AT, SOURCE_SYNC_MS)).toBe(0)
})

test("a tick reads the app's note and the workflows, and opens the app hidden once", async () => {
  const home = await scratch()
  const app = join(home, "Runrail.app")
  await mkdir(join(app, "Contents"), { recursive: true })
  await writeFile(join(app, "Contents", "Info.plist"), "<plist/>")
  await new WorkflowStore(join(home, "workflows.json")).save(parseWorkflow({ id: "wf", name: "Nightly", trigger: hourly, steps: agent, state: "on" }), { project: "p1", root: "/one" }, AT)
  await mkdir(join(home, "service"))
  const opened: string[] = []
  let now = AT + 61 * 60_000
  const options = { app: await checkAppBundle(`${app}/`), home, now: () => now, alive: (pid: number) => pid === 42, open: async (path: string) => void opened.push(path) }
  const state: WakeState = {}

  // The app is running: it starts the work itself.
  await writeFile(join(home, "service", "app.json"), JSON.stringify({ pid: 42, at: now - 10_000 }))
  expect(await wakeTick(options, state)).toBeUndefined()
  // It quit.
  await writeFile(join(home, "service", "app.json"), JSON.stringify({ pid: null, at: now - 10_000 }))
  expect(await wakeTick(options, state)).toBe("schedule")
  expect(opened).toEqual([app])
  now += 30_000
  expect(await wakeTick(options, state)).toBeUndefined()
  expect(opened).toHaveLength(1)

  // An open that fails waits longer before the next.
  const failing = { ...options, open: async () => Promise.reject(new Error("gone")) }
  now += WAKE_GAP_MS
  expect(await wakeTick(failing, state)).toBe("schedule")
  expect(state.lastWakeFailed).toBe(true)
  now += WAKE_GAP_MS
  expect(await wakeTick(options, state)).toBeUndefined()
})

test("the command takes an app bundle and nothing else", async () => {
  expect(parseCliArgs(["service", "--app", "/Applications/Runrail.app"])).toMatchObject({ command: "service", serviceApp: "/Applications/Runrail.app" })
  for (const argv of [["service"], ["service", "--app"], ["service", "--app", "/A.app", "--x"], ["service", "/A.app"]]) expect(() => parseCliArgs(argv)).toThrow()
  for (const path of ["Runrail.app", "/Applications/Runrail", "/nowhere/Runrail.app"]) await expect(checkAppBundle(path)).rejects.toThrow()
})

// On Linux the service opens the AppImage or the installed program itself.
test("on Linux the app is an executable program, given by its absolute path", async () => {
  const dir = await scratch()
  const program = join(dir, "runrail-desktop")
  await writeFile(program, "#!/bin/sh\n")
  await expect(checkLinuxApp(program)).rejects.toThrow("not an executable")
  await chmod(program, 0o755)
  expect(await checkLinuxApp(program)).toBe(program)
  for (const path of ["runrail-desktop", dir, join(dir, "missing")]) await expect(checkLinuxApp(path)).rejects.toThrow()
})
