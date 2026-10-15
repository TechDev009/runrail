import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CommandModelPort } from "../../src/model/command.ts"
import { PersistentCommandAgentBackend } from "../../src/backend/persistent-command-agent.ts"
import { CommandAgentBackend } from "../../src/backend/command-agent.ts"
import { PtyAgentBackend } from "../../src/backend/pty-agent.ts"
import { CheckRuns } from "../../src/check/run.ts"
import { NativeBackgroundCommands } from "../../src/background/native-commands.ts"

async function workspace(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "runrail-process-security-"))
  try { await run(cwd) } finally { await rm(cwd, { recursive: true, force: true }) }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

for (const action of ["cancel", "close", "abort"] as const) test(`persistent startup ${action} spawns no process`, async () => workspace(async (cwd) => {
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const wait = new Promise<void>((resolve) => { release = resolve })
  const controller = new AbortController()
  const marker = join(cwd, "started")
  const backend = new PersistentCommandAgentBackend({ command: process.execPath, args: ["-e", `await Bun.write(${JSON.stringify(marker)},'bad');setInterval(()=>{},1000)`], timeoutMs: 200,
    auth: { mode: "caller", credentialEnvironment: ["FIXTURE_KEY"], credentialResolver: async () => { entered(); await wait; return { FIXTURE_KEY: "fake" } } } })
  await backend.createSession({ cwd, sessionId: "fixture" })
  const iterator = backend.send({ sessionId: "fixture", message: "fixture prompt", signal: controller.signal })[Symbol.asyncIterator]()
  const pending = iterator.next()
  await ready
  try {
    if (action === "abort") controller.abort()
    else await backend[action]("fixture")
    release()
    await pending.catch(() => undefined)
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally { release(); await iterator.return?.(); if (action !== "close") await backend.close("fixture") }
}))

test("one-shot command reserves a session before startup awaits", async () => workspace(async (cwd) => {
  const backend = new CommandAgentBackend({ command: process.execPath, args: ["-e", "let s='';for await(const c of Bun.stdin.stream())s+=new TextDecoder().decode(c);const p=JSON.parse(s);console.log(JSON.stringify({version:1,sessionId:p.sessionId,seq:0,at:Date.now(),type:'session.stopped',reason:'done'}))"] })
  await backend.createSession({ cwd, sessionId: "fixture" })
  const one = backend.send({ sessionId: "fixture", message: "one" })[Symbol.asyncIterator]()
  const two = backend.send({ sessionId: "fixture", message: "two" })[Symbol.asyncIterator]()
  try {
    const first = one.next()
    await expect(two.next()).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    await first
  } finally { await one.return?.(); await two.return?.(); await backend.close("fixture") }
}))

test("pre-aborted command model sends no prompt and yields no response", async () => workspace(async (cwd) => {
  const marker = join(cwd, "started")
  const signal = AbortSignal.abort()
  const model = new CommandModelPort({ command: process.execPath, args: ["-e", `await Bun.write(${JSON.stringify(marker)},'bad');console.log(JSON.stringify({type:'text',text:'bad'}))`] })
  await expect(model.complete({ sessionId: "fixture", cwd, messages: [], tools: [], signal }).next()).rejects.toMatchObject({ code: "MODEL_COMMAND_CANCELLED" })
  expect(await Bun.file(marker).exists()).toBe(false)
}))

test("PTY consumer abandonment terminates a signal-resistant child", async () => workspace(async (cwd) => {
  const backend = new PtyAgentBackend({ command: process.execPath, args: ["-e", "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});console.log(JSON.stringify({version:1,sessionId:'fixture',seq:0,at:Date.now(),type:'assistant.delta',turnId:'turn',text:String(process.pid)}));setInterval(()=>{},1000)"], timeoutMs: 1000 })
  await backend.createSession({ cwd, sessionId: "fixture" })
  const iterator = backend.send({ sessionId: "fixture", message: "fixture" })[Symbol.asyncIterator]()
  let pid = 0
  try {
    const event = (await iterator.next()).value
    if (event?.type === "assistant.delta") pid = Number(event.text)
    expect(pid).toBeGreaterThan(0)
    await iterator.return?.()
    expect(alive(pid)).toBe(false)
  } finally { if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL"); await backend.close("fixture") }
}))

test("a finished check kills helpers that retain its output pipes", async () => workspace(async (cwd) => {
  const marker = join(cwd, "helper.pid")
  const checks = new CheckRuns()
  let pid = 0
  try {
    await checks.run({ id: "fixture", cwd, command: `/bin/sleep 60 & echo $! > '${marker}'; echo done`, timeoutMs: 2000 })
    pid = Number((await readFile(marker, "utf8")).trim())
    await checks.close()
    expect(alive(pid)).toBe(false)
  } finally { if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL"); await checks.close() }
}))

test("background helpers retain their command admission slot", async () => workspace(async (cwd) => {
  const commands = new NativeBackgroundCommands({ root: cwd })
  try {
    for (let index = 0; index < 4; index++) { commands.start("/bin/sh", ["-c", "/bin/sleep 60 &"], "fixture"); await Bun.sleep(50) }
    expect(() => commands.start("/bin/sh", ["-c", "/bin/sleep 60 &"], "overflow")).toThrow(expect.objectContaining({ code: "BACKGROUND_LIMIT" }))
  } finally { await commands.close() }
}))
