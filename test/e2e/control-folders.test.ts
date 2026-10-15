import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

// A project's related folders: the desktop reads and reviews each by `folder`.
const token = "control-folders-token-1234567890abcd"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function dir(prefix: string): Promise<string> {
  const path = await mkdtemp(`/tmp/${prefix}`)
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } })
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
}

async function start() {
  const cwd = await dir("runrail-control-folders-app-")
  const api = await dir("runrail-control-folders-api-")
  await git(api, "init", "-q", "-b", "main")
  await writeFile(join(api, "server.ts"), "export const port = 1\n")
  await git(api, "add", ".")
  await git(api, "commit", "-q", "-m", "first")
  const running = await startRunrailControlRpcServer({ cwd, folders: [api], backend: "native", authToken: token, loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) } })
  cleanup.push(() => running.handle.stop())
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: any; error?: { code: string } } }
  }
  return { cwd, api, rpc, running }
}

test("a related folder's files are listed, read and saved by folder, with paths relative to it", async () => {
  const { api, rpc, running } = await start()
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  expect(health.capabilityStatus["workspace.folders"]).toBe("available")
  const listed = await rpc("workspace.list", { folder: api })
  expect(listed.body.result.entries.map((entry: { path: string }) => entry.path).filter((path: string) => !path.startsWith(".git"))).toEqual(["server.ts"])
  const read = await rpc("workspace.read", { folder: api, path: "server.ts" })
  expect(read.body.result).toMatchObject({ path: "server.ts", content: "export const port = 1\n" })
  const saved = await rpc("workspace.write", { folder: await realpath(api), path: "server.ts", content: "export const port = 2\n", baseHash: read.body.result.hash })
  expect(saved.body).toMatchObject({ ok: true, result: { path: "server.ts" } })
  expect(await readFile(join(api, "server.ts"), "utf8")).toBe("export const port = 2\n")
  // Without `folder`, the same path is looked for in the working folder.
  expect((await rpc("workspace.read", { path: "server.ts" })).body.error?.code).toBe("CONTROL_WORKSPACE_NOT_FOUND")
})

test("git runs in the related folder it names, and an unknown folder is refused", async () => {
  const { cwd, api, rpc } = await start()
  await writeFile(join(api, "server.ts"), "export const port = 3\n")
  const status = await rpc("git.status", { folder: api })
  expect(status.body.result.branch).toBe("main")
  expect(status.body.result.entries.map((entry: { path: string }) => entry.path)).toEqual(["server.ts"])
  const diff = await rpc("git.diff", { folder: api, scope: "head" })
  expect(diff.body.result.files.map((file: { path: string }) => file.path)).toEqual(["server.ts"])
  // The working folder is not a repository; its own git answers for it.
  expect((await rpc("git.status")).status).not.toBe(200)
  for (const folder of [cwd, "/tmp", "relative", 7]) {
    const refused = await rpc("git.status", { folder })
    expect({ folder, status: refused.status, code: refused.body.error?.code }).toEqual({ folder, status: 400, code: "CONTROL_INVALID_INPUT" })
  }
  expect((await rpc("workspace.list", { folder: "/tmp" })).body.error?.code).toBe("CONTROL_INVALID_INPUT")
})
