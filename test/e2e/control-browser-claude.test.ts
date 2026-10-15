import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// The whole Claude Code route: the CLI control server with browser tools on, a stand-in `claude`
// that records what it was handed, and the real `browser-mcp` started from that configuration,
// answered by a stand-in desktop through the event stream and `browser.take` / `browser.respond`.
const cli = resolve(import.meta.dir, "../../src/cli.ts")
const claudeFixture = resolve(import.meta.dir, "../fixtures/vendor-cli.ts")

let root: string
let claudeLog: string
let path: string

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-browser-claude-"))
  const bin = join(root, "bin")
  claudeLog = join(root, "claude-argv.log")
  await Promise.all([mkdir(bin), mkdir(join(root, "workspace")), mkdir(join(root, "home"))])
  await writeFile(join(bin, "claude"), `#!/bin/sh\n{ echo RUN; printf '%s\\n' "$@"; } >> ${quote(claudeLog)}\nexec ${quote(process.execPath)} ${quote(claudeFixture)} claude normal "$@"\n`, { mode: 0o755 })
  path = `${bin}:${process.env.PATH ?? ""}`
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("\n")) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  reader.releaseLock()
  return text.slice(0, text.indexOf("\n"))
}

test("Claude Code gets the browser MCP server, and its calls reach the desktop", async () => {
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", "claude-code", "--cwd", join(root, "workspace"), "--session-dir", join(root, "session"), "--session-id", "browser-thread", "--harness-auth", "subscription", "--browser-tools", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false" } })
  let endpointFile: string | undefined
  try {
    const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string; capabilityStatus: Record<string, string> }
    expect(ready.capabilityStatus.browser).toBe("available")
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
      return await response.json() as { ok: boolean; result?: any; error?: { code: string } }
    }

    const turn = await rpc("turn.enqueue", { message: "say hi" })
    expect(turn.ok).toBe(true)
    // A check that would fail is installed, but without --verify-after-turn nothing checks, and nothing repairs.
    expect((turn.result.events as { type: string }[]).map((event) => event.type)).not.toContain("verification.completed")
    expect((await readFile(claudeLog, "utf8")).split("RUN\n")).toHaveLength(2)
    const argv = (await readFile(claudeLog, "utf8")).split("RUN\n")[1]?.split("\n").filter((line) => line.length > 0) ?? []
    const config = argv[argv.indexOf("--mcp-config") + 1] ?? ""
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__runrail_browser")
    expect(argv.find((arg) => arg.startsWith("--append-system-prompt="))).toContain("mcp__runrail_browser tools")
    const server = (JSON.parse(config) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.runrail_browser
    expect(server?.args.slice(-3, -1)).toEqual(["browser-mcp", "--endpoint-file"])
    endpointFile = server?.args.at(-1)
    // The address and token live in the private file, never on a command line.
    expect(config).not.toContain(ready.url)

    // The stand-in desktop: claim each announced request and answer it.
    const events = await fetch(`${ready.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${ready.token}` } })
    const taken: unknown[] = []
    void (async () => {
      const reader = events.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value)
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data: ")) continue
          const frame = JSON.parse(line.slice(6)) as { type?: string; requestId?: string }
          if (frame.type !== "browser.request") continue
          const claim = await rpc("browser.take", { requestId: frame.requestId })
          taken.push(claim.result)
          await rpc("browser.respond", { requestId: frame.requestId, answer: { ok: true, result: { text: "Welcome to the app" } } })
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
      }
    })().catch(() => undefined)

    const mcp = Bun.spawn([server!.command, ...server!.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } })}\n`)
    await mcp.stdin.flush()
    const reply = JSON.parse(await firstLine(mcp.stdout)) as { id: number; result: { content: { type: string; text: string }[]; isError?: boolean } }
    mcp.stdin.end()
    await mcp.exited
    events.body?.cancel().catch(() => undefined)
    expect(reply.id).toBe(1)
    expect(reply.result.isError).toBeUndefined()
    expect(reply.result.content[0]?.text).toContain("Welcome to the app")
    expect(reply.result.content[0]?.text).toContain("Untrusted content")
    expect(taken).toEqual([expect.objectContaining({ action: "snapshot", params: {} })])
  } finally {
    control.stdin.end()
    await control.exited
  }
  // A stopped engine leaves no address or token behind.
  expect(endpointFile).toBeDefined()
  await expect(stat(endpointFile as string)).rejects.toThrow()
}, 30_000)

test("Claude Code gets the thread tools beside the browser's, and a list reaches the desktop", async () => {
  await rm(claudeLog, { force: true })
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", "claude-code", "--cwd", join(root, "workspace"), "--session-dir", join(root, "session-threads"), "--session-id", "threads-thread", "--harness-auth", "subscription", "--browser-tools", "--thread-tools", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false" } })
  let endpointFile: string | undefined
  try {
    const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string; capabilityStatus: Record<string, string> }
    expect(ready.capabilityStatus["threads.tools"]).toBe("available")
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
      return await response.json() as { ok: boolean; result?: any; error?: { code: string } }
    }
    expect((await rpc("turn.enqueue", { message: "say hi" })).ok).toBe(true)
    const argv = (await readFile(claudeLog, "utf8")).split("RUN\n")[1]?.split("\n").filter((line) => line.length > 0) ?? []
    const allowed = argv.slice(argv.indexOf("--allowedTools") + 1)
    expect(allowed.slice(0, 2)).toEqual(["mcp__runrail_browser", "mcp__runrail_threads"])
    // The log keeps one line per line of each argument, so the prompt's second hint has a line of its own.
    const prompt = argv.slice(argv.findIndex((arg) => arg.startsWith("--append-system-prompt="))).join("\n")
    expect(prompt).toContain("mcp__runrail_browser tools")
    expect(prompt).toContain("mcp__runrail_threads tools")
    const configs = argv.slice(argv.indexOf("--mcp-config") + 1, argv.indexOf("--mcp-config") + 3)
    const server = configs.map((config) => (JSON.parse(config) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.runrail_threads).find((entry) => entry !== undefined)
    expect(server?.args.slice(-3, -1)).toEqual(["threads-mcp", "--endpoint-file"])
    endpointFile = server?.args.at(-1)

    const events = await fetch(`${ready.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${ready.token}` } })
    const taken: unknown[] = []
    void (async () => {
      const reader = events.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value)
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data: ")) continue
          const frame = JSON.parse(line.slice(6)) as { type?: string; requestId?: string }
          if (frame.type !== "threads.request") continue
          const claim = await rpc("threads.take", { requestId: frame.requestId })
          taken.push(claim.result)
          await rpc("threads.respond", { requestId: frame.requestId, answer: { ok: true, result: { text: "t1\tTests\tidle" } } })
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
      }
    })().catch(() => undefined)

    const mcp = Bun.spawn([server!.command, ...server!.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_threads", arguments: {} } })}\n`)
    await mcp.stdin.flush()
    const reply = JSON.parse(await firstLine(mcp.stdout)) as { id: number; result: { content: { type: string; text: string }[]; isError?: boolean } }
    mcp.stdin.end()
    await mcp.exited
    events.body?.cancel().catch(() => undefined)
    expect(reply.result.isError).toBeUndefined()
    expect(reply.result.content[0]?.text).toBe("t1\tTests\tidle")
    expect(taken).toEqual([expect.objectContaining({ action: "list", params: {} })])
  } finally {
    control.stdin.end()
    await control.exited
  }
  expect(endpointFile).toBeDefined()
  await expect(stat(endpointFile as string)).rejects.toThrow()
}, 30_000)

test("a related folder given to control reaches Claude Code as --add-dir", async () => {
  await rm(claudeLog, { force: true })
  await mkdir(join(root, "api"), { recursive: true })
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", "claude-code", "--cwd", join(root, "workspace"), "--add-dir", join(root, "api"), "--session-dir", join(root, "session-folders"), "--session-id", "folders-thread", "--harness-auth", "subscription", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false" } })
  try {
    const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string; capabilityStatus: Record<string, string> }
    expect(ready.capabilityStatus["workspace.folders"]).toBe("available")
    const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "turn.enqueue", params: { message: "say hi" } }) })
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
    const argv = (await readFile(claudeLog, "utf8")).split("RUN\n")[1]?.split("\n").filter((line) => line.length > 0) ?? []
    expect(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 2)).toEqual(["--add-dir", await realpath(join(root, "api"))])
  } finally {
    control.stdin.end()
    await control.exited
  }
}, 30_000)

test("Claude Code gets the computer tools, and a screenshot comes back as an image", async () => {
  await rm(claudeLog, { force: true })
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", "claude-code", "--cwd", join(root, "workspace"), "--session-dir", join(root, "session-computer"), "--session-id", "computer-thread", "--harness-auth", "subscription", "--computer-tools", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false" } })
  try {
    const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string; capabilityStatus: Record<string, string> }
    expect(ready.capabilityStatus["computer.tools"]).toBe("available")
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
      return await response.json() as { ok: boolean; result?: any; error?: { code: string } }
    }
    expect((await rpc("turn.enqueue", { message: "say hi" })).ok).toBe(true)
    const argv = (await readFile(claudeLog, "utf8")).split("RUN\n")[1]?.split("\n").filter((line) => line.length > 0) ?? []
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)[0]).toBe("mcp__runrail_computer")
    expect(argv.slice(argv.findIndex((arg) => arg.startsWith("--append-system-prompt="))).join("\n")).toContain("mcp__runrail_computer tools")
    const config = argv[argv.indexOf("--mcp-config") + 1] as string
    const server = (JSON.parse(config) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.runrail_computer
    expect(server?.args.slice(-3, -1)).toEqual(["computer-mcp", "--endpoint-file"])

    const events = await fetch(`${ready.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${ready.token}` } })
    void (async () => {
      const reader = events.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value)
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data: ")) continue
          const frame = JSON.parse(line.slice(6)) as { type?: string; requestId?: string }
          if (frame.type !== "computer.request") continue
          await rpc("computer.take", { requestId: frame.requestId })
          await rpc("computer.respond", { requestId: frame.requestId, answer: { ok: true, result: { text: "Notes, 800 by 600", image: { mediaType: "image/jpeg", dataBase64: "/9j/" } } } })
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
      }
    })().catch(() => undefined)

    const mcp = Bun.spawn([server!.command, ...server!.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_screenshot", arguments: { app: "Notes" } } })}\n`)
    await mcp.stdin.flush()
    const reply = JSON.parse(await firstLine(mcp.stdout)) as { id: number; result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean } }
    mcp.stdin.end()
    await mcp.exited
    events.body?.cancel().catch(() => undefined)
    expect(reply.result.isError).toBeUndefined()
    expect(reply.result.content[0]?.text).toContain("Notes, 800 by 600")
    expect(reply.result.content[1]).toEqual({ type: "image", data: "/9j/", mimeType: "image/jpeg" })
  } finally {
    control.stdin.end()
    await control.exited
  }
}, 30_000)

test("Claude Code gets the image tool, whose calls reach the engine with their own token", async () => {
  await rm(claudeLog, { force: true })
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", "claude-code", "--cwd", join(root, "workspace"), "--session-dir", join(root, "session-images"), "--session-id", "images-thread", "--harness-auth", "subscription", "--image-tools", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false" } })
  try {
    const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string; capabilityStatus: Record<string, string> }
    expect(ready.capabilityStatus["image.tools"]).toBe("available")
    const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "turn.enqueue", params: { message: "say hi" } }) })
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
    const argv = (await readFile(claudeLog, "utf8")).split("RUN\n")[1]?.split("\n").filter((line) => line.length > 0) ?? []
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)[0]).toBe("mcp__runrail_images")
    expect(argv.slice(argv.findIndex((arg) => arg.startsWith("--append-system-prompt="))).join("\n")).toContain("mcp__runrail_images__image_generate")
    const config = argv[argv.indexOf("--mcp-config") + 1] as string
    const server = (JSON.parse(config) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.runrail_images
    expect(server?.args.slice(-3, -1)).toEqual(["images-mcp", "--endpoint-file"])

    // No image model is chosen in this home, so the engine answers without asking any provider.
    const mcp = Bun.spawn([server!.command, ...server!.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "image_generate", arguments: { prompt: "a fox", path: "fox.png" } } })}\n`)
    await mcp.stdin.flush()
    const reply = JSON.parse(await firstLine(mcp.stdout)) as { id: number; result: { content: { type: string; text?: string }[]; isError?: boolean } }
    mcp.stdin.end()
    await mcp.exited
    expect(reply.result.isError).toBe(true)
    expect(reply.result.content[0]?.text).toContain("Settings > Connections > Image model")
  } finally {
    control.stdin.end()
    await control.exited
  }
}, 30_000)
