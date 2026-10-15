import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { createRunrailSession, type RunrailSession, type RunrailSessionOptions } from "../../src/session.ts"

const mcpFixture = resolve(import.meta.dir, "../fixtures/mcp-server.ts")
const piFixture = resolve(import.meta.dir, "../fixtures/pi-rpc.ts")

let bin = ""
const saved = { path: process.env.PATH, command: process.env.RUNRAIL_NIFRA_COMMAND }
beforeAll(async () => {
  // PATH holds only a stand-in `nifra` whose `mcp` is the fixture MCP server.
  bin = await mkdtemp(join("/tmp", "runrail-nifra-mcp-path-"))
  await writeFile(join(bin, "nifra"), `#!/bin/sh\nexec '${process.execPath}' '${mcpFixture}'\n`)
  await chmod(join(bin, "nifra"), 0o755)
  process.env.PATH = bin
  delete process.env.RUNRAIL_NIFRA_COMMAND
})
afterAll(async () => {
  process.env.PATH = saved.path
  if (saved.command !== undefined) process.env.RUNRAIL_NIFRA_COMMAND = saved.command
  await rm(bin, { recursive: true, force: true })
})

async function workspace(manifest: Record<string, unknown>, behavior?: Record<string, unknown>): Promise<{ readonly cwd: string; readonly behaviorConfigPath?: string; readonly cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join("/tmp", "runrail-nifra-mcp-"))
  await writeFile(join(cwd, "package.json"), JSON.stringify(manifest))
  const cleanup = () => rm(cwd, { recursive: true, force: true })
  if (behavior === undefined) return { cwd, cleanup }
  const behaviorConfigPath = join(cwd, "behavior.json")
  await writeFile(behaviorConfigPath, JSON.stringify({ version: 1, mode: "ask", ...behavior }))
  return { cwd, behaviorConfigPath, cleanup }
}

async function opened<T>(manifest: Record<string, unknown>, options: Partial<RunrailSessionOptions>, read: (session: RunrailSession) => T): Promise<T> {
  const ws = await workspace(manifest)
  const session = await createRunrailSession({ cwd: ws.cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "ok" }) }, ...options })
  try {
    return read(session)
  } finally {
    await session.close()
    await ws.cleanup()
  }
}

const nifraProject = { dependencies: { "@nifrajs/core": "5.3.0" } }
const otherProject = { dependencies: { react: "19.2.0" } }

async function mcpStatus(manifest: Record<string, unknown>, options: Partial<RunrailSessionOptions> = {}, behavior?: Record<string, unknown>) {
  const ws = await workspace(manifest, behavior)
  const session = await createRunrailSession({ cwd: ws.cwd, backend: "native", loadExtensions: false, verifyAfterTurn: false, model: { complete: () => ({ type: "text", text: "ok" }) }, ...(ws.behaviorConfigPath === undefined ? {} : { behaviorConfigPath: ws.behaviorConfigPath }), ...options })
  try {
    return session.mcpStatus()
  } finally {
    await session.close()
    await ws.cleanup()
  }
}

describe("Nifra's MCP server", () => {
  test("starts for Runrail's own loop in a Nifra project", async () => {
    expect(await mcpStatus(nifraProject)).toEqual([{ name: "nifra", state: "ready", tools: 3 }])
  })

  test("stays out of any other project unless asked", async () => {
    expect(await mcpStatus(otherProject)).toEqual([])
    expect(await mcpStatus(otherProject, { nifra: true })).toEqual([{ name: "nifra", state: "ready", tools: 3 }])
  })

  test("nifra: false keeps it out of a Nifra project", async () => {
    expect(await mcpStatus(nifraProject, { nifra: false })).toEqual([])
  })

  test("a server the behavior file names `nifra` is used instead", async () => {
    const status = await mcpStatus(nifraProject, {}, { mcp: { servers: [{ name: "nifra", command: "/nonexistent/nifra", enabled: false }] } })
    expect(status).toEqual([{ name: "nifra", state: "off", tools: 0 }])
  })
})

describe("what Nifra adds is reported", () => {
  test("a session says what Nifra adds, and nothing once it is off", async () => {
    expect(await opened(nifraProject, { verifyAfterTurn: false }, (session) => session.nifraUse())).toEqual({ mcp: true, pi: false, check: false })
    expect(await opened(nifraProject, { nifra: false }, (session) => session.nifraUse())).toEqual({ mcp: false, pi: false, check: false })
    expect(await opened(otherProject, {}, (session) => session.nifraUse())).toEqual({ mcp: false, pi: false, check: false })
  })

  test("RUNRAIL_NIFRA=off turns it all off without a flag", async () => {
    process.env.RUNRAIL_NIFRA = "off"
    try {
      expect(await opened(nifraProject, {}, (session) => [session.nifraUse(), session.mcpStatus()])).toEqual([{ mcp: false, pi: false, check: false }, []])
    } finally {
      delete process.env.RUNRAIL_NIFRA
    }
  })

  test("the control server answers nifra.status and lists the capability", async () => {
    const ws = await workspace(nifraProject)
    const token = "nifra-status-test-token"
    const server = await startRunrailControlRpcServer({ cwd: ws.cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "ok" }) }, verifyAfterTurn: false, authToken: token })
    try {
      const health = (await (await fetch(`${server.handle.url}/health`)).json()) as { readonly capabilityStatus: Record<string, string> }
      expect(health.capabilityStatus.nifra).toBe("available")
      const response = await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "nifra.status", params: {} }) })
      expect(await response.json()).toEqual({ ok: true, result: { mcp: true, pi: false, check: false } })
    } finally {
      await server.handle.stop()
      await ws.cleanup()
    }
  })
})

describe("Pi's Nifra setup", () => {
  async function piArgs(manifest: Record<string, unknown>): Promise<readonly string[]> {
    const ws = await workspace(manifest)
    // Pi's own command line, as the fixture sees it after its mode argument.
    const pi = join(ws.cwd, "pi")
    await writeFile(pi, `#!/bin/sh\nexec '${process.execPath}' '${piFixture}' argv "$@"\n`)
    await chmod(pi, 0o755)
    const session = await createRunrailSession({ cwd: ws.cwd, backend: "pi", loadExtensions: false, verifyAfterTurn: false, pi: { command: pi } })
    try {
      let text = ""
      for await (const event of session.prompt("hello")) if (event.type === "assistant.message") text = event.text
      return JSON.parse(text) as string[]
    } finally {
      await session.stop("test complete")
      await ws.cleanup()
    }
  }
  const nifraSetup = (args: readonly string[]) => ({
    instructions: args.includes("--append-system-prompt"),
    tools: args.some((arg) => arg.endsWith(join("extensions", "nifra.ts"))),
  })

  test("Pi is told it works in a Nifra project, and gets Nifra's tools, only in one", async () => {
    expect(nifraSetup(await piArgs(nifraProject))).toEqual({ instructions: true, tools: true })
    expect(nifraSetup(await piArgs(otherProject))).toEqual({ instructions: false, tools: false })
  })
})
