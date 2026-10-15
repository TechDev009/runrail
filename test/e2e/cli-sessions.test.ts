import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

interface CliRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

let root: string
let sessions: string
let project: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-cli-sessions-"))
  sessions = join(root, "sessions")
  project = join(root, "project")
  await mkdir(project)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runCli(args: readonly string[]): Promise<CliRun> {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUNRAIL_SESSIONS_DIR: sessions },
  })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { status, stdout, stderr }
}

/** A native run on a model that answers with every user message it was sent. */
const ECHO = ["--backend", "native", "--model-command", process.execPath, "--model-command-arg", resolve(import.meta.dir, "../fixtures/history-echo-model.ts"), "--no-nifra"]

async function listed(...args: string[]): Promise<readonly { readonly id: string; readonly cwd: string; readonly title?: string; readonly forkedFrom?: string; readonly route: readonly string[] }[]> {
  const run = await runCli(["sessions", "--json", ...args])
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout)
}

function reply(run: CliRun): string {
  return run.stdout.slice(run.stdout.indexOf("assistant> "), run.stdout.indexOf("\n0\tsession.started"))
}

test("a run is saved, listed with its first message, and continued with its history", async () => {
  const first = await runCli(["run", ...ECHO, "--cwd", project, "alpha"])
  expect(first.status).toBe(0)
  expect(first.stderr).toMatch(/Session [0-9a-f]{8} saved\. Continue it with: runrail run --resume [0-9a-f]{8}/)
  const [saved] = await listed()
  expect(saved?.cwd).toBe(project)
  expect(saved?.title).toBe("alpha")
  expect(saved?.route).toContain("--model-command")

  const text = await runCli(["sessions"])
  expect(text.stdout).toContain(`${saved!.id.slice(0, 8)}\t`)
  expect(text.stdout).toContain("\tnative\t")

  // The saved route is reused, so the continued run reaches the same model without its flags.
  const second = await runCli(["run", "--continue", "--cwd", project, "--no-nifra", "beta"])
  expect(second.status).toBe(0)
  expect(reply(second)).toContain("alpha")
  expect(reply(second)).toContain("beta")
  expect(await listed()).toHaveLength(1)
})

test("a fork starts from a copy and leaves the original as it was", async () => {
  await runCli(["run", ...ECHO, "--cwd", project, "alpha"])
  const [source] = await listed()
  const other = join(root, "other")
  await mkdir(other)
  const fork = await runCli(["run", "--fork", source!.id.slice(0, 8), "--cwd", other, "--no-nifra", "gamma"])
  expect(fork.status).toBe(0)
  expect(reply(fork)).toContain("alpha")
  expect(reply(fork)).toContain("gamma")
  const all = await listed()
  expect(all).toHaveLength(2)
  expect(all.find((session) => session.forkedFrom === source!.id)?.cwd).toBe(other)

  const resumed = await runCli(["run", "--resume", source!.id, "--no-nifra", "delta"])
  expect(resumed.status).toBe(0)
  expect(reply(resumed)).toContain("delta")
  expect(reply(resumed)).not.toContain("gamma")
  expect((await listed("--cwd", other))).toHaveLength(1)
})

test("a session is resumed only in its own folder", async () => {
  await runCli(["run", ...ECHO, "--cwd", project, "alpha"])
  const [saved] = await listed()
  const elsewhere = await runCli(["run", "--resume", saved!.id, "--cwd", root, "beta"])
  expect(elsewhere.status).toBe(2)
  expect(elsewhere.stderr).toContain("--fork it to work in another folder")
})

test("unknown, ambiguous and conflicting session requests fail before anything runs", async () => {
  expect((await runCli(["run", "--continue", "--cwd", project, "x"])).stderr).toContain(`no saved session for ${project}`)
  expect((await runCli(["run", "--resume", "deadbeef", "x"])).stderr).toContain("no saved session deadbeef")
  expect((await runCli(["run", "--resume"])).stderr).toContain("--resume requires a session id")
  expect((await runCli(["run", "--continue", "x"])).stderr).toContain("--continue requires --cwd")
  expect((await runCli(["run", "--continue", "--fork", "abcd", "--cwd", project])).stderr).toContain("use one of --continue, --resume and --fork")
  expect((await runCli(["run", "--continue", "--no-session", "--cwd", project])).stderr).toContain("--no-session cannot be combined")
  for (const id of ["aaaa0000-0000-4000-8000-000000000001", "aaaa0000-0000-4000-8000-000000000002"]) {
    await mkdir(join(sessions, id), { recursive: true })
    await writeFile(join(sessions, id, "session.json"), JSON.stringify({ version: 1, id, cwd: project, createdAt: 1, route: [] }))
    await mkdir(join(sessions, id, "transcript"))
    await writeFile(join(sessions, id, "transcript", `${id}.jsonl`), "")
  }
  expect((await runCli(["run", "--resume", "aaaa", "x"])).stderr).toContain("aaaa matches 2 sessions")
})

test("--no-session and an explicit --session-dir keep nothing in the sessions folder", async () => {
  expect((await runCli(["run", "--backend", "replay", "--cwd", project, "--no-session", "x"])).status).toBe(0)
  const own = join(root, "own")
  expect((await runCli(["run", "--backend", "replay", "--cwd", project, "--session-dir", own, "x"])).status).toBe(0)
  expect(await readdir(sessions).catch(() => [])).toEqual([])
})

test("export prints the transcript bundle or a readable copy, and never writes over a file", async () => {
  await runCli(["run", ...ECHO, "--cwd", project, "alpha"])
  const [saved] = await listed()
  const json = await runCli(["export", saved!.id.slice(0, 8)])
  expect(json.status).toBe(0)
  const bundle = JSON.parse(json.stdout)
  expect(bundle.sessionId).toBe(saved!.id)
  expect(bundle.records.some((record: { readonly kind: string }) => record.kind === "message.user")).toBe(true)

  const markdown = await runCli(["export", saved!.id, "--format", "markdown"])
  expect(markdown.stdout).toContain("# alpha")
  expect(markdown.stdout).toContain("## You\n\nalpha")
  expect(markdown.stdout).toContain("## Assistant\n\nheard: alpha")

  const out = join(root, "session.md")
  expect((await runCli(["export", saved!.id, "--format", "markdown", "--out", out])).status).toBe(0)
  expect((await stat(out)).mode & 0o777).toBe(0o600)
  const again = await runCli(["export", saved!.id, "--out", out])
  expect(again.status).toBe(2)
  expect(again.stderr).toContain("EEXIST")
})

test("saved sessions are readable by their owner only", async () => {
  await runCli(["run", "--backend", "replay", "--cwd", project, "x"])
  const [saved] = await listed()
  expect((await stat(sessions)).mode & 0o777).toBe(0o700)
  expect((await stat(join(sessions, saved!.id))).mode & 0o777).toBe(0o700)
  expect((await stat(join(sessions, saved!.id, "session.json"))).mode & 0o777).toBe(0o600)
  expect((await stat(join(sessions, saved!.id, "transcript", `${saved!.id}.jsonl`))).mode & 0o777).toBe(0o600)
})

test("a session resumed on another backend hands that tool a recap, and keeps the new route", async () => {
  await runCli(["run", ...ECHO, "--cwd", project, "alpha"])
  const [saved] = await listed()
  const capture = join(root, "capture.jsonl")
  const tool = ["--backend", "claude-code", "--harness-auth", "subscription", "--harness-command", process.execPath, "--harness-arg", "run", "--harness-arg", resolve(import.meta.dir, "../fixtures/prompt-capture-harness.ts"), "--harness-arg", capture]
  const moved = await runCli(["run", "--resume", saved!.id, ...tool, "--verification-command", resolve(import.meta.dir, "../fixtures/env-verifier"), "--max-repair-attempts", "0", "beta"])
  expect(moved.status).toBe(0)
  const sent = await Bun.file(capture).text()
  expect(sent).toContain("before this thread moved to you")
  expect(sent).toContain("User: alpha")
  expect(sent).toContain("beta")
  expect((await listed())[0]?.route).toContain("claude-code")
})
