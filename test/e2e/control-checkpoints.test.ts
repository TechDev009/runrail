import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

/** Each turn's work tree is kept, so a client can say what changed since a message. */

const token = "control-checkpoints-token-1234567890ab"
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
  const dir = await mkdtemp(`/tmp/${prefix}`)
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function start(checkpoints: boolean) {
  const repo = await tempDir("runrail-checkpoints-e2e-")
  git(repo, "init", "-q", "-b", "main")
  await writeFile(join(repo, "a.txt"), "one\n")
  git(repo, "add", "--all")
  git(repo, "commit", "-q", "-m", "first")
  const running = await startRunrailControlRpcServer({
    cwd: repo,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    sessionDir: await tempDir("runrail-checkpoints-session-"),
    sessionId: "th-checkpoints-1",
    transcriptStore: new FileTranscriptStore({ root: await tempDir("runrail-checkpoints-transcripts-") }),
    nativeAccountsDir: await tempDir("runrail-checkpoints-accounts-"),
    model: { complete: () => ({ type: "text", text: "done" }) },
    githubCli: false,
    ...(checkpoints ? { checkpoints: true } : {}),
  })
  cleanup.push(() => running.handle.stop())
  const rpc = async (method: string, params: Readonly<Record<string, unknown>> = {}): Promise<{ readonly status: number; readonly body: any }> => {
    const response = await fetch(`${running.handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
  const health = (await (await fetch(`${running.handle.url}/health`)).json()) as { capabilityStatus: Record<string, string> }
  return { repo, rpc, health }
}

test("a turn's checkpoint names its turn and user message, and lists what changed since", async () => {
  const { repo, rpc, health } = await start(true)
  expect(health.capabilityStatus.checkpoints).toBe("available")
  expect((await rpc("turn.enqueue", { message: "first" })).body.ok).toBe(true)
  await writeFile(join(repo, "a.txt"), "two\n")
  await writeFile(join(repo, "b.txt"), "new\n")

  const listed = await rpc("session.checkpoints.list")
  expect(listed.status).toBe(200)
  const [checkpoint] = listed.body.result.checkpoints
  expect(listed.body.result.checkpoints).toHaveLength(1)
  expect(checkpoint.n).toBe(1)
  expect(checkpoint.tree).toMatch(/^[0-9a-f]{40,64}$/)
  expect(Number.isSafeInteger(checkpoint.userSeq)).toBe(true)
  expect(typeof checkpoint.turnId).toBe("string")

  const changes = await rpc("session.checkpoint.changes", { turnId: checkpoint.turnId })
  expect(changes.body.result.files).toEqual([
    { path: "a.txt", change: "modified" },
    { path: "b.txt", change: "added" },
  ])
  expect((await rpc("session.checkpoint.changes", { turnId: "turn-unknown" })).body).toMatchObject({ ok: false, error: { code: "CONTROL_GIT_NOT_FOUND" } })
  expect((await rpc("session.checkpoint.changes", {})).status).toBe(400)
  // The snapshots live in the session's folder: the project's repository gets no refs.
  expect(git(repo, "for-each-ref", "refs/runrail/").trim()).toBe("")
})

test("an engine started without --checkpoints keeps none and says so", async () => {
  const { repo, rpc, health } = await start(false)
  expect(health.capabilityStatus.checkpoints).toBe("configurable")
  expect((await rpc("turn.enqueue", { message: "first" })).body.ok).toBe(true)
  expect((await rpc("session.checkpoints.list")).body).toMatchObject({ ok: false, error: { code: "CONTROL_CAPABILITY_UNAVAILABLE" } })
  expect(git(repo, "for-each-ref", "refs/runrail/").trim()).toBe("")
})
