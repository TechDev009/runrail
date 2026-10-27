import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Connectors on the Claude Code route: the CLI control server reads which connectors are
// on from a private HOME, the thread's behavior file grants Slack as Read, a stand-in `claude`
// records what it was handed, and the real `connectors-mcp` lists and calls through the engine.
const cli = resolve(import.meta.dir, "../../src/cli.ts")
const claudeFixture = resolve(import.meta.dir, "../fixtures/vendor-cli.ts")

let root: string
let claudeLog: string
let path: string

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-connectors-claude-"))
  const bin = join(root, "bin")
  claudeLog = join(root, "claude-argv.log")
  await Promise.all([mkdir(bin), mkdir(join(root, "workspace")), mkdir(join(root, "session")), mkdir(join(root, "home", ".runrail"), { recursive: true })])
  await writeFile(join(bin, "claude"), `#!/bin/sh\n{ echo RUN; printf '%s\\n' "$@"; } >> ${quote(claudeLog)}\nexec ${quote(process.execPath)} ${quote(claudeFixture)} claude normal "$@"\n`, { mode: 0o755 })
  await writeFile(join(root, "home", ".runrail", "connectors.json"), JSON.stringify({ version: 1, connectors: { slack: { on: true, updatedAt: 1 }, linear: { on: false, updatedAt: 1 } } }))
  await writeFile(join(root, "session", "config.json"), JSON.stringify({ version: 1, integrations: { slack: "read" } }))
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

async function mcpRequest(server: { command: string; args: string[] }, messages: readonly Record<string, unknown>[]): Promise<Record<string, any>[]> {
  const child = Bun.spawn([server.command, ...server.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  for (const message of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  await child.stdin.flush()
  child.stdin.end()
  const text = await new Response(child.stdout).text()
  await child.exited
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, any>)
}

test("Claude Code gets the connectors its role may use, and a key is kept in the vault, never in the file", async () => {
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", "claude-code", "--cwd", join(root, "workspace"), "--session-dir", join(root, "session"), "--session-id", "connectors-thread", "--harness-auth", "subscription", "--accounts-dir", join(root, "accounts"), "--credential-vault", "file", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false" } })
  let endpointFile: string | undefined
  try {
    const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string; capabilityStatus: Record<string, string> }
    expect(ready.capabilityStatus.connectors).toBe("available")
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
      return (await response.json()) as { ok: boolean; result?: any; error?: { code: string } }
    }

    expect((await rpc("turn.enqueue", { message: "say hi" })).ok).toBe(true)
    const argv = (await readFile(claudeLog, "utf8")).split("RUN\n")[1]?.split("\n").filter((line) => line.length > 0) ?? []
    const config = argv[argv.indexOf("--mcp-config") + 1] ?? ""
    const server = (JSON.parse(config) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.runrail_connectors
    expect(server?.args.slice(-3, -1)).toEqual(["connectors-mcp", "--endpoint-file"])
    endpointFile = server?.args.at(-1)
    expect(config).not.toContain(ready.url)
    // Slack is Read: its reads run without asking and nothing that writes is listed (below).
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__runrail_connectors")
    expect(argv.find((arg) => arg.startsWith("--append-system-prompt="))).toContain("mcp__runrail_connectors tools")

    const [listed, called, refused] = await mcpRequest(server!, [
      { id: 1, method: "tools/list" },
      { id: 2, method: "tools/call", params: { name: "slack_listChannels", arguments: { limit: 5 } } },
      { id: 3, method: "tools/call", params: { name: "slack_sendMessage", arguments: { channel: "C1", text: "hi" } } },
    ]).then((replies) => [1, 2, 3].map((id) => replies.find((reply) => reply.id === id)))
    expect((listed?.result.tools as { name: string }[]).map((tool) => tool.name)).toEqual(["slack_listChannels", "slack_searchMessages"])
    // No key yet: the call reaches the connector and asks for one, without any network.
    expect(called?.result.isError).toBe(true)
    expect(called?.result.content[0].text).toContain("Connect Slack in Integrations")
    // A tool the role was not granted is refused by the engine.
    expect(refused?.result).toMatchObject({ isError: true, content: [{ text: "connector: this thread may not use that tool" }] })

    const statusOf = async () => ((await rpc("connector.setup.list")).result.connectors as { id: string; on: boolean; connected: boolean }[]).find((entry) => entry.id === "slack")
    expect(await statusOf()).toMatchObject({ on: true, connected: false })
    const stored = await fetch(`${ready.url}/secret`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ connectorId: "slack", secret: " xoxb-test-key\n" }) })
    expect(await stored.json()).toEqual({ ok: true, result: { connector: "slack", connected: true } })
    expect(await statusOf()).toMatchObject({ on: true, connected: true })
    expect(await readFile(join(root, "home", ".runrail", "connectors.json"), "utf8")).not.toContain("xoxb")
    // GitHub answers with the person's own gh sign-in, so it takes no key.
    const github = await fetch(`${ready.url}/secret`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ connectorId: "github", secret: "ghp_x" }) })
    expect(github.status).toBe(400)

    expect((await rpc("connector.setup.save", { id: "jira", on: true })).error?.code).toBe("CONTROL_INVALID_INPUT")
    expect((await rpc("connector.setup.save", { id: "jira", on: true, site: "your-team.atlassian.net", email: "me@example.com" })).result).toMatchObject({ id: "jira", on: true, site: "your-team.atlassian.net" })
    expect((await rpc("connector.setup.remove", { id: "slack" })).result).toEqual({ id: "slack", removed: true })
    expect(await statusOf()).toMatchObject({ on: false, connected: false })
  } finally {
    control.stdin.end()
    await control.exited
  }
  expect(endpointFile).toBeDefined()
  await expect(stat(endpointFile as string)).rejects.toThrow()
}, 30_000)

test("on Claude Code, a connector tool that asks runs only on an approval given in Claude Code's prompt", async () => {
  const sessionDir = join(root, "session-ask")
  await mkdir(sessionDir)
  await writeFile(join(sessionDir, "config.json"), JSON.stringify({ version: 1, integrations: { slack: "ask" } }))
  await writeFile(join(root, "home", ".runrail", "connectors.json"), JSON.stringify({ version: 1, connectors: { slack: { on: true, updatedAt: 2 } } }))
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", "claude-code", "--cwd", join(root, "workspace"), "--session-dir", sessionDir, "--session-id", "connectors-ask-thread", "--harness-auth", "subscription", "--accounts-dir", join(root, "accounts"), "--credential-vault", "file", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false" } })
  try {
    const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string }
    await writeFile(claudeLog, "")
    const enqueued = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "turn.enqueue", params: { message: "say hi" } }) })
    expect(((await enqueued.json()) as { ok: boolean }).ok).toBe(true)
    const argv = (await readFile(claudeLog, "utf8")).split("RUN\n")[1]?.split("\n").filter((line) => line.length > 0) ?? []
    const server = (JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "") as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.runrail_connectors
    // Print mode cannot ask, and the agent can reach the endpoint itself: neither is an approval.
    const [read, write] = await mcpRequest(server!, [
      { id: 1, method: "tools/call", params: { name: "slack_listChannels", arguments: { limit: 5 } } },
      { id: 2, method: "tools/call", params: { name: "slack_sendMessage", arguments: { channel: "C1", text: "hi" } } },
    ]).then((replies) => [1, 2].map((id) => replies.find((reply) => reply.id === id)))
    expect(read?.result).toMatchObject({ isError: true, content: [{ text: "connector: this tool waits for the person's approval, and none was given for this call" }] })
    expect(write?.result).toMatchObject({ isError: true, content: [{ text: "connector: this tool waits for the person's approval, and none was given for this call" }] })
  } finally {
    control.stdin.end()
    await control.exited
  }
}, 30_000)

async function waitFor(file: string, text: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const content = await readFile(file, "utf8").catch(() => "")
    if (content.includes(text)) return content
    await Bun.sleep(50)
  }
  throw new Error(`${file} never contained ${text}`)
}

async function controlFor(backend: string, sessionId: string, env: Record<string, string> = {}) {
  const sessionDir = join(root, sessionId)
  await mkdir(sessionDir)
  // Slack's reads run without asking; every Linear tool waits for the person.
  await writeFile(join(sessionDir, "config.json"), JSON.stringify({ version: 1, integrations: { slack: "read", linear: "ask" } }))
  await writeFile(join(root, "home", ".runrail", "connectors.json"), JSON.stringify({ version: 1, connectors: { slack: { on: true, updatedAt: 3 }, linear: { on: true, updatedAt: 3 } } }))
  const control = Bun.spawn([process.execPath, cli, "control", "--backend", backend, "--cwd", join(root, "workspace"), "--session-dir", sessionDir, "--session-id", sessionId, ...(backend === "pi" ? [] : ["--harness-auth", "subscription"]), "--accounts-dir", join(root, "accounts"), "--credential-vault", "file", "--exit-on-stdin-close", "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(root, "home"), PATH: path, RUNRAIL_NIFRA_COMMAND: "/usr/bin/false", ...env } })
  const ready = JSON.parse(await firstLine(control.stdout)) as { url: string; token: string }
  return {
    control,
    enqueue: async () => {
      const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "turn.enqueue", params: { message: "say hi" } }) })
      expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
    },
  }
}

test("an ACP agent starts the connectors server, which lists and runs only what needs no approval", async () => {
  const sent = join(root, "copilot-stdin.jsonl")
  await writeFile(join(root, "bin", "copilot"), `#!/bin/sh\ntee -a ${quote(sent)} | exec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../fixtures/acp-agent.ts"))} normal "$@"\n`, { mode: 0o755 })
  const { control, enqueue } = await controlFor("copilot", "connectors-acp-thread")
  try {
    await enqueue()
    const messages = (await waitFor(sent, "session/prompt")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as { method?: string; params?: Record<string, any> })
    const servers = messages.find((message) => message.method === "session/new")?.params?.mcpServers as { name: string; command: string; args: string[]; env: unknown[] }[]
    expect(servers.map((server) => server.name)).toEqual(["runrail_connectors"])
    expect(servers[0]!.args.slice(-3, -1)).toEqual(["connectors-mcp", "--endpoint-file"])
    expect(servers[0]!.env).toEqual([])
    expect(JSON.stringify(messages.find((message) => message.method === "session/prompt")?.params?.prompt)).toContain("runrail_connectors MCP server")

    const [listed, called, refused] = await mcpRequest(servers[0]!, [
      { id: 1, method: "tools/list" },
      { id: 2, method: "tools/call", params: { name: "slack_listChannels", arguments: { limit: 5 } } },
      { id: 3, method: "tools/call", params: { name: "linear_createIssue", arguments: { title: "x" } } },
    ]).then((replies) => [1, 2, 3].map((id) => replies.find((reply) => reply.id === id)))
    // The agent cannot ask Runrail's person first, so a Linear tool is neither listed nor run.
    expect((listed?.result.tools as { name: string }[]).map((tool) => tool.name)).toEqual(["slack_listChannels", "slack_searchMessages"])
    expect(called?.result.content[0].text).toContain("Connect Slack in Integrations")
    expect(refused?.result).toMatchObject({ isError: true, content: [{ text: "connector: this thread may not use that tool" }] })
  } finally {
    control.stdin.end()
    await control.exited
  }
}, 30_000)

test("Pi loads an extension that declares only the connector tools that need no approval", async () => {
  const argvLog = join(root, "pi-argv.log")
  const fakePi = join(root, "bin", "fake-pi")
  await writeFile(fakePi, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(argvLog)}\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../fixtures/pi-rpc.ts"))} events\n`, { mode: 0o755 })
  const { control, enqueue } = await controlFor("pi", "connectors-pi-thread", { RUNRAIL_PI_COMMAND: fakePi })
  let extension: string | undefined
  try {
    await enqueue()
    const argv = (await waitFor(argvLog, "connectors.js")).split("\n")
    extension = argv.find((arg) => arg.endsWith("connectors.js"))
    expect(argv[argv.indexOf(extension as string) - 1]).toBe("--extension")
    const source = await readFile(extension as string, "utf8")
    expect(source).toContain("\"slack_listChannels\"")
    expect(source).toContain("\"slack_searchMessages\"")
    expect(source).not.toContain("linear_")
    expect(source).toMatch(/runrail-connectors-[^"]+\/endpoint\.json/)
  } finally {
    control.stdin.end()
    await control.exited
  }
  // The run's extension goes with the thread.
  await expect(stat(extension as string)).rejects.toThrow()
}, 30_000)
