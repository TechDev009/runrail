import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

// The person's edit from the desktop's file view: saved only over what they opened.
const token = "control-workspace-write-token-1234567"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function start() {
  const cwd = await mkdtemp("/tmp/runrail-control-workspace-write-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", authToken: token, loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) } })
  cleanup.push(() => running.handle.stop())
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: any; error?: { code: string } } }
  }
  return { cwd, rpc, running }
}

test("an edit is saved over the text that was opened, keeping the file's mode, and nothing else is left behind", async () => {
  const { cwd, rpc, running } = await start()
  await writeFile(join(cwd, "run.sh"), "#!/bin/sh\necho one\n")
  await chmod(join(cwd, "run.sh"), 0o755)
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["workspace.write"]).toBe("available")

  const read = await rpc("workspace.read", { path: "run.sh" })
  expect(read.body.result.hash).toMatch(/^[0-9a-f]{64}$/)
  const saved = await rpc("workspace.write", { path: "run.sh", content: "#!/bin/sh\necho two\n", baseHash: read.body.result.hash })
  expect(saved.body).toMatchObject({ ok: true, result: { path: "run.sh", bytes: 19 } })
  expect(await readFile(join(cwd, "run.sh"), "utf8")).toBe("#!/bin/sh\necho two\n")
  expect((await stat(join(cwd, "run.sh"))).mode & 0o777).toBe(0o755)
  expect(await readdir(cwd)).toEqual(["run.sh"])
  // The save's hash is the next save's base.
  expect((await rpc("workspace.read", { path: "run.sh" })).body.result.hash).toBe(saved.body.result.hash)
})

test("a file that changed since it was opened is not overwritten", async () => {
  const { cwd, rpc } = await start()
  await writeFile(join(cwd, "notes.md"), "# Notes\n")
  const read = await rpc("workspace.read", { path: "notes.md" })
  await writeFile(join(cwd, "notes.md"), "# Notes\n\nThe agent added this.\n")
  const conflict = await rpc("workspace.write", { path: "notes.md", content: "# My notes\n", baseHash: read.body.result.hash })
  expect(conflict).toMatchObject({ status: 409, body: { ok: false, error: { code: "CONTROL_WORKSPACE_CONFLICT" } } })
  expect(await readFile(join(cwd, "notes.md"), "utf8")).toBe("# Notes\n\nThe agent added this.\n")
})

test("the agent's file rules hold: no credential, control, outside, linked or non-text file is written", async () => {
  const { cwd, rpc } = await start()
  const hash = "0".repeat(64)
  await writeFile(join(cwd, ".env"), "SECRET=1\n")
  await mkdir(join(cwd, ".git"))
  await writeFile(join(cwd, ".git", "config"), "[core]\n")
  await writeFile(join(cwd, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  const outside = await mkdtemp("/tmp/runrail-control-workspace-outside-")
  cleanup.push(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, "target.txt"), "outside\n")
  await symlink(join(outside, "target.txt"), join(cwd, "link.txt"))

  expect((await rpc("workspace.write", { path: ".env", content: "x", baseHash: hash })).status).toBe(403)
  expect((await rpc("workspace.write", { path: ".git/config", content: "x", baseHash: hash })).status).toBe(403)
  expect((await rpc("workspace.write", { path: "../escape.txt", content: "x", baseHash: hash })).status).toBe(403)
  expect((await rpc("workspace.write", { path: "link.txt", content: "x", baseHash: hash })).status).toBe(403)
  expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside\n")
  const latin = await rpc("workspace.read", { path: "latin1.txt" })
  expect(await rpc("workspace.write", { path: "latin1.txt", content: "café\n", baseHash: latin.body.result.hash })).toMatchObject({ status: 415, body: { error: { code: "CONTROL_WORKSPACE_BINARY" } } })
  expect(await rpc("workspace.write", { path: "missing.txt", content: "x", baseHash: hash })).toMatchObject({ status: 404 })
  expect(await rpc("workspace.write", { path: "a.txt", content: "x", baseHash: "nope" })).toMatchObject({ status: 400 })
  expect(await rpc("workspace.write", { path: "a.txt", content: 42, baseHash: hash })).toMatchObject({ status: 400 })
})
