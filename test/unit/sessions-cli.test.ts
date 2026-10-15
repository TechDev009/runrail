import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listCliSessions, newSessionId, prepareCliSession, routeArgs } from "../../src/sessions-cli.ts"

let root: string
let project: string
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100"

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-sessions-"))
  project = join(root, "project")
  await mkdir(join(root, ID), { recursive: true })
  await writeFile(join(root, ID, "session.json"), JSON.stringify({ version: 1, id: ID, cwd: project, createdAt: 1, route: ["--backend", "claude-code", "--model", "opus"] }))
  await mkdir(join(root, ID, "transcript"))
  await writeFile(join(root, ID, "transcript", `${ID}.jsonl`), "")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("routeArgs keeps only the flags that pick where a run goes", () => {
  expect(routeArgs(["run", "--backend", "codex", "--cwd", "/x", "--thinking", "high", "--max-steps", "4", "--harness-persistent", "fix it"])).toEqual(["--backend", "codex", "--thinking", "high", "--harness-persistent"])
})

test("resume fills in the saved folder and route, and new routing flags replace them", async () => {
  const saved = await prepareCliSession(["run", "--resume", "0f0e", "carry on"], root)
  expect(saved.kind).toBe("resume")
  expect(saved.argv).toEqual(["run", "--backend", "claude-code", "--model", "opus", "--cwd", project, "carry on"])
  const moved = await prepareCliSession(["console", "--resume", ID, "--backend", "codex"], root)
  expect(moved.argv).toEqual(["console", "--cwd", project, "--backend", "codex"])
})

test("a fork may name another folder; a plain run is a new session; other commands are left alone", async () => {
  const fork = await prepareCliSession(["run", "--fork", ID, "--cwd", root, "try another way"], root)
  expect(fork.kind).toBe("fork")
  expect(fork.session?.id).toBe(ID)
  expect(fork.argv).toEqual(["run", "--backend", "claude-code", "--model", "opus", "--cwd", root, "try another way"])
  expect((await prepareCliSession(["run", "--cwd", root, "x"], root)).kind).toBe("new")
  expect((await prepareCliSession(["control", "--cwd", root], root)).kind).toBe("none")
})

test("a broken session file and a session with no conversation are skipped; a missing folder lists nothing", async () => {
  const broken = "11111111-2222-4333-8444-555555555555"
  await mkdir(join(root, broken))
  await writeFile(join(root, broken, "session.json"), "{ not json")
  const empty = "a1111111-2222-4333-8444-555555555555"
  await mkdir(join(root, empty))
  await writeFile(join(root, empty, "session.json"), JSON.stringify({ version: 1, id: empty, cwd: project, createdAt: 2, route: [] }))
  expect((await listCliSessions(root)).map((session) => session.id)).toEqual([ID])
  expect(await listCliSessions(join(root, "missing"))).toEqual([])
})

test("a new session id always starts with a letter, as the coding-tool backends require", () => {
  for (let index = 0; index < 200; index += 1) expect(newSessionId()).toMatch(/^[a-f][0-9a-f]{7}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
