import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseCliArgs } from "../../src/cli.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { PTY_TERMINAL_CHUNK_BYTES, createPtyTerminalBridge } from "../../src/terminal/pty.ts"

const token = "control-pty-token-1234567890abcdef"
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<{ status: number; body: any }>

async function startWithTerminal(env: Record<string, string> = {}) {
  const cwd = await mkdtemp("/tmp/runrail-control-pty-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, "sub"))
  const bridge = createPtyTerminalBridge({ shell: "/bin/sh", shellArgs: [], env: { PS1: "$ ", ...env } })
  cleanup.push(() => bridge.dispose())
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", authToken: token, loadExtensions: false, terminalBridge: bridge, model: { complete: () => ({ type: "text", text: "done" }) } })
  cleanup.push(() => running.handle.stop())
  const rpc: Rpc = async (method, params = {}) => {
    const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() }
  }
  const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
  return { rpc, health, bridge, cwd }
}

/** Reads until `pattern` appears in the accumulated output or the deadline passes. */
async function readUntil(rpc: Rpc, sessionId: string, cursor: { seq: number }, pattern: RegExp, maxBytes = 64 * 1024): Promise<{ text: string; closed: boolean; chunks: { seq: number; data: string }[] }> {
  let text = ""
  let closed = false
  const all: { seq: number; data: string }[] = []
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const read = await rpc("terminal.read", { sessionId, afterSeq: cursor.seq, maxBytes })
    expect(read.status).toBe(200)
    for (const chunk of read.body.result.chunks as { seq: number; data: string }[]) {
      all.push(chunk)
      text += chunk.data
    }
    cursor.seq = read.body.result.nextSeq
    closed = read.body.result.closed
    if (pattern.test(text) || closed) break
    await Bun.sleep(25)
  }
  return { text, closed, chunks: all }
}

test("PTY bridge runs a real shell through terminal.* with resize, cwd, and close", async () => {
  process.env.RUNRAIL_PTY_TEST_SECRET = "must-not-leak"
  cleanup.push(async () => { delete process.env.RUNRAIL_PTY_TEST_SECRET })
  const { rpc, health, bridge } = await startWithTerminal()
  for (const capability of ["terminal.describe", "terminal.create", "terminal.write", "terminal.read", "terminal.resize", "terminal.close"])
    expect(health.capabilityStatus[capability]).toBe("available")
  expect((await rpc("terminal.describe")).body.result).toMatchObject({ id: "runrail.pty", capabilities: ["create", "write", "read", "resize", "close"] })

  const created = await rpc("terminal.create", { sessionId: "term-1", cols: 80, rows: 24 })
  expect(created.body.result).toEqual({ sessionId: "term-1", cols: 80, rows: 24, status: "running" })
  const cursor = { seq: -1 }
  expect((await rpc("terminal.write", { sessionId: "term-1", data: "echo runrail-$((40+2))\n" })).body.result.acceptedBytes).toBe(23)
  expect((await readUntil(rpc, "term-1", cursor, /runrail-42/)).text).toMatch(/runrail-42/)

  expect((await rpc("terminal.resize", { sessionId: "term-1", cols: 100, rows: 30 })).body.result).toMatchObject({ cols: 100, rows: 30 })
  await rpc("terminal.write", { sessionId: "term-1", data: "stty size\n" })
  expect((await readUntil(rpc, "term-1", cursor, /30 100/)).text).toMatch(/30 100/)

  await rpc("terminal.write", { sessionId: "term-1", data: "echo \"k=${RUNRAIL_PTY_TEST_SECRET:-unset} t=$TERM\"\n" })
  const env = await readUntil(rpc, "term-1", cursor, /k=[a-z-]+ t=[a-z0-9-]+\r?\n/)
  expect(env.text).toMatch(/k=unset t=xterm-256color/)
  expect(env.text).not.toContain("must-not-leak")

  // Re-creating a running session reattaches instead of spawning a second shell.
  const again = await rpc("terminal.create", { sessionId: "term-1", cols: 90, rows: 20 })
  expect(again.body.result).toEqual({ sessionId: "term-1", cols: 90, rows: 20, status: "running" })
  expect(bridge.size).toBe(1)

  // Replay from the start returns earlier output again.
  const replay = await rpc("terminal.read", { sessionId: "term-1", afterSeq: -1, maxBytes: 64 * 1024 })
  expect((replay.body.result.chunks as { data: string }[]).map((chunk) => chunk.data).join("")).toContain("runrail-42")

  const sub = await rpc("terminal.create", { sessionId: "term-2", cwd: "sub", cols: 80, rows: 24 })
  expect(sub.status).toBe(200)
  await rpc("terminal.write", { sessionId: "term-2", data: "pwd\n" })
  expect((await readUntil(rpc, "term-2", { seq: -1 }, /\/sub\r?\n/)).text).toMatch(/\/sub\r?\n/)
  expect((await rpc("terminal.create", { sessionId: "term-3", cwd: "../" })).status).toBeGreaterThanOrEqual(400)

  const closed = await rpc("terminal.close", { sessionId: "term-1" })
  expect(closed.body.result.status).toBe("closed")
  const tail = await readUntil(rpc, "term-1", cursor, /$^/)
  expect(tail.closed).toBe(true)
  const late = await rpc("terminal.write", { sessionId: "term-1", data: "echo late\n" })
  expect(late.status).toBe(502)
  expect(late.body.error.code).toBe("CONTROL_TERMINAL_FAILED")
  expect((await rpc("terminal.read", { sessionId: "missing" })).status).toBe(502)
})

test("PTY output is chunked on code points, bounded, and drops the oldest bytes first", async () => {
  const bridge = createPtyTerminalBridge({ shell: "/bin/sh", shellArgs: [], env: { PS1: "$ " }, maxBufferedBytes: 64 * 1024, maxSessions: 1 })
  cleanup.push(() => bridge.dispose())
  const cwd = await mkdtemp("/tmp/runrail-pty-unit-")
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  await bridge.create({ sessionId: "one", cwd, cols: 80, rows: 24 })
  expect(() => bridge.create({ sessionId: "two", cwd, cols: 80, rows: 24 })).toThrow("too many")

  await bridge.write({ sessionId: "one", data: "i=0; while [ $i -lt 40000 ]; do printf '\\303\\251'; i=$((i+1)); done; echo; echo END-$((6*7))\n" })
  let seq = -1
  let text = ""
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !/END-42\r?\n/.test(text)) {
    const read = await bridge.read({ sessionId: "one", afterSeq: seq, maxBytes: 16 * 1024, maxChunks: 64 })
    for (const chunk of read.chunks) {
      expect(Buffer.byteLength(chunk.data, "utf8")).toBeLessThanOrEqual(PTY_TERMINAL_CHUNK_BYTES)
      expect(chunk.data).not.toContain("�")
      text += chunk.data
    }
    seq = read.nextSeq
    if (read.chunks.length === 0) await Bun.sleep(20)
  }
  expect(text).toContain("END-42")
  expect(text).toContain("éé")
  // 80 KB of output with a 64 KiB buffer: a fresh reader no longer sees the first chunk.
  const fresh = await bridge.read({ sessionId: "one", afterSeq: -1, maxBytes: 1024 * 1024, maxChunks: 2_048 })
  expect(fresh.chunks[0]?.seq).toBeGreaterThan(1)
  expect(fresh.truncated).toBe(true)
  expect((await bridge.read({ sessionId: "one", afterSeq: fresh.nextSeq, maxBytes: 1024, maxChunks: 4 })).truncated).toBeUndefined()
  expect(fresh.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.data, "utf8"), 0)).toBeLessThanOrEqual(64 * 1024)

  await bridge.close({ sessionId: "one" })
  expect(() => bridge.create({ sessionId: "two", cwd, cols: 80, rows: 24 })).not.toThrow()
  expect(() => createPtyTerminalBridge({ shell: "sh" })).toThrow(TypeError)
  expect(() => createPtyTerminalBridge({ env: { "BAD-NAME": "x" } })).toThrow(TypeError)
  expect(() => createPtyTerminalBridge({ maxSessions: 0 })).toThrow(RangeError)
})

test("--terminal is a control-only flag", () => {
  expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--terminal"])).toMatchObject({ command: "control", terminal: true })
  expect(parseCliArgs(["control", "--cwd", "/tmp/project"])).not.toHaveProperty("terminal")
  expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--terminal", "task"])).toThrow("--terminal requires the control command")
  expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--exit-on-stdin-close"])).toMatchObject({ command: "control", exitOnStdinClose: true })
  expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--exit-on-stdin-close", "task"])).toThrow("--exit-on-stdin-close requires the control command")
})
