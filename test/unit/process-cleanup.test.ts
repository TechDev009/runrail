import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { NativeBackgroundCommands } from "../../src/background/native-commands.ts"
import { CommandAgentBackend } from "../../src/backend/command-agent.ts"
import { terminateProcessTree } from "../../src/backend/process-tree.ts"
import { CommandModelPort } from "../../src/model/command.ts"
import { createRunrailRuntime } from "../../src/session.ts"
import { createToolCatalog } from "../../src/tools/catalog.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

// A helper in the command's own group that ignores SIGTERM, as some build tools' workers do.
const STUBBORN_HELPER = "(trap '' TERM; exec sleep 30) & echo $! > helper.pid"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function helperPid(dir: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(join(dir, "helper.pid"), "utf8").catch(() => "")
    const pid = Number.parseInt(text, 10)
    if (Number.isSafeInteger(pid) && pid > 0) return pid
    await Bun.sleep(10)
  }
  throw new Error("helper did not start")
}

async function eventuallyDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) await Bun.sleep(10)
  return !alive(pid)
}

async function inTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join("/tmp", "runrail-process-cleanup-"))
  try {
    await run(dir)
  } finally {
    for (const pid of [await readFile(join(dir, "helper.pid"), "utf8").then((text) => Number.parseInt(text, 10), () => NaN)]) if (Number.isSafeInteger(pid) && alive(pid)) process.kill(pid, "SIGKILL")
    await rm(dir, { recursive: true, force: true })
  }
}

test("a group whose leader exits first still loses the helper that ignores SIGTERM", async () => {
  await inTemp(async (dir) => {
    const child = Bun.spawn(["sh", "-c", `${STUBBORN_HELPER}; wait`], { cwd: dir, detached: true, stdout: "ignore", stderr: "ignore" })
    const pid = await helperPid(dir)
    await terminateProcessTree(child, 100)
    expect(await eventuallyDead(pid)).toBe(true)
  })
})

test("a foreground command's timeout ends every process it started, on time", async () => {
  await inTemp(async (dir) => {
    const run = createToolCatalog(await createWorkspacePolicy(dir), { allowWrite: true }).find((tool) => tool.name === "run_command")!
    const started = performance.now()
    const result = await run.execute({ program: "sh", args: ["-c", `${STUBBORN_HELPER}; sleep 30`], timeoutMs: 200 }, { cwd: dir, signal: new AbortController().signal }) as { timedOut: boolean; ok: boolean }
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(result).toMatchObject({ ok: false, timedOut: true })
    expect(await eventuallyDead(await helperPid(dir))).toBe(true)
  })
})

test("a foreground command that leaves a helper holding its output still returns", async () => {
  await inTemp(async (dir) => {
    const run = createToolCatalog(await createWorkspacePolicy(dir), { allowWrite: true }).find((tool) => tool.name === "run_command")!
    const started = performance.now()
    const result = await run.execute({ program: "sh", args: ["-c", `${STUBBORN_HELPER}; echo finished`], timeoutMs: 60_000 }, { cwd: dir, signal: new AbortController().signal }) as { ok: boolean; stdout?: string }
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(result).toMatchObject({ ok: true, stdout: "finished\n" })
    expect(await eventuallyDead(await helperPid(dir))).toBe(true)
  })
})

test("closing background commands ends what an exited command left running", async () => {
  await inTemp(async (dir) => {
    const background = new NativeBackgroundCommands({ root: dir })
    const { id } = background.start("sh", ["-c", STUBBORN_HELPER], "helper")
    const pid = await helperPid(dir)
    for (let attempt = 0; attempt < 100 && background.output(id).running; attempt += 1) await Bun.sleep(10)
    expect(background.output(id).running).toBe(false)
    expect(background.running).toBe(1)
    expect(alive(pid)).toBe(true)
    await background.close()
    expect(await eventuallyDead(pid)).toBe(true)
    expect(background.running).toBe(0)
  })
})

test("a command model process is ended on a timeout it ignores and on output it cannot parse", async () => {
  await inTemp(async (dir) => {
    const request = { sessionId: "s", cwd: dir, messages: [{ role: "user" as const, text: "go" }], tools: [], signal: new AbortController().signal }
    const ignoring = new CommandModelPort({ command: "sh", args: ["-c", `trap '' TERM; ${STUBBORN_HELPER}; while true; do sleep 1; done`], timeoutMs: 100 })
    const started = performance.now()
    await expect((async () => { for await (const _chunk of ignoring.complete(request) as AsyncIterable<unknown>) {} })()).rejects.toMatchObject({ code: "MODEL_COMMAND_TIMEOUT" })
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(await eventuallyDead(await helperPid(dir))).toBe(true)
    await rm(join(dir, "helper.pid"), { force: true })

    const garbled = new CommandModelPort({ command: "sh", args: ["-c", `${STUBBORN_HELPER}; echo not-json; sleep 30`] })
    await expect((async () => { for await (const _chunk of garbled.complete(request) as AsyncIterable<unknown>) {} })()).rejects.toMatchObject({ code: "MODEL_COMMAND_OUTPUT_INVALID" })
    expect(await eventuallyDead(await helperPid(dir))).toBe(true)
  })
})

test("a command agent turn that sends invalid output ends its process", async () => {
  await inTemp(async (dir) => {
    const backend = new CommandAgentBackend({ command: "sh", args: ["-c", `${STUBBORN_HELPER}; echo not-json; sleep 30`] })
    const session = await backend.createSession({ cwd: dir, sessionId: "command-cleanup" })
    await expect((async () => { for await (const _event of backend.send({ sessionId: session.id, message: "go" })) {} })()).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })
    expect(await eventuallyDead(await helperPid(dir))).toBe(true)
    await backend.close(session.id)
  })
})

test("a runtime that fails to start stops the MCP servers its behavior file started", async () => {
  await inTemp(async (dir) => {
    const server = resolve(import.meta.dir, "../fixtures/mcp-server.ts")
    const config = join(dir, "config.json")
    await writeFile(config, JSON.stringify({ version: 1, mcp: { servers: [{ name: "fixture", command: "/bin/sh", args: ["-c", `echo $$ > helper.pid; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`] }] } }), "utf8")
    const duplicate = { name: "same_name", description: "Duplicate", execute: () => "x" }
    await expect(createRunrailRuntime({ cwd: dir, backend: "native", loadExtensions: false, behaviorConfigPath: config, model: { complete: () => ({ type: "text", text: "unused" }) }, tools: [duplicate, duplicate] })).rejects.toThrow()
    expect(await eventuallyDead(await helperPid(dir))).toBe(true)
  })
})
