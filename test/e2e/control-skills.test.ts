import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { NativeModelRequest } from "@nifrajs/coding-agent"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const token = "control-skills-token-1234567890abcdef"
const cleanup: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function start() {
  const cwd = await mkdtemp("/tmp/runrail-control-skills-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, ".agents", "skills", "tidy"), { recursive: true })
  await writeFile(join(cwd, ".agents", "skills", "tidy", "SKILL.md"), "---\nid: tidy\ndescription: Keep diffs small\n---\nTIDY-SKILL-BODY")
  const requests: NativeModelRequest[] = []
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    authToken: token,
    loadExtensions: false,
    model: { complete: (request: NativeModelRequest) => { requests.push(request); return { type: "text" as const, text: "ok" } } },
  })
  cleanup.push(() => running.handle.stop())
  const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<{ readonly status: number; readonly body: any }> => {
    const response = await fetch(`${running.handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() }
  }
  /** Whether the model's last request listed the skill. Its body is loaded on demand, never up front. */
  const sawSkill = (): boolean => {
    const messages = requests[requests.length - 1]!.messages
    expect(messages.some((message) => message.text.includes("TIDY-SKILL-BODY"))).toBe(false)
    return messages.some((message) => message.text.includes("- tidy: Keep diffs small"))
  }
  return { rpc, sawSkill }
}

test("a skill switched off leaves the running session's next request, and comes back when switched on", async () => {
  const { rpc, sawSkill } = await start()
  expect((await rpc("turn.enqueue", { message: "first" })).status).toBe(200)
  expect(sawSkill()).toBe(true)

  const off = await rpc("skills.setEnabled", { id: "tidy", enabled: false })
  expect(off.status).toBe(200)
  expect(off.body.result).toMatchObject({ id: "tidy", enabled: false })
  expect((await rpc("skills.list")).body.result).toEqual([expect.objectContaining({ id: "tidy", enabled: false })])
  expect((await rpc("turn.enqueue", { message: "second" })).status).toBe(200)
  expect(sawSkill()).toBe(false)

  expect((await rpc("skills.setEnabled", { id: "tidy", enabled: true })).status).toBe(200)
  expect((await rpc("turn.enqueue", { message: "third" })).status).toBe(200)
  expect(sawSkill()).toBe(true)
})

test("an unknown skill or a bad flag is refused and changes nothing", async () => {
  const { rpc } = await start()
  const unknown = await rpc("skills.setEnabled", { id: "missing", enabled: false })
  expect(unknown.status).toBe(400)
  expect(unknown.body.error.code).toBe("CONTROL_INVALID_INPUT")
  const flag = await rpc("skills.setEnabled", { id: "tidy", enabled: "no" })
  expect(flag.status).toBe(400)
  expect(flag.body.error.code).toBe("CONTROL_INVALID_INPUT")
  expect((await rpc("skills.list")).body.result).toEqual([expect.objectContaining({ id: "tidy", enabled: true })])
})
