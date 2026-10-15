import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BehaviorConfigError, loadBehaviorConfigFile } from "../../src/behavior/config.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { McpClient } from "../../src/mcp/client.ts"
import { connectConfiguredMcp } from "../../src/mcp/configured.ts"

const fixture = resolve(import.meta.dir, "../fixtures/mcp-server.ts")
const fixtureServer = { transport: "stdio" as const, name: "fixture", command: process.execPath, args: [fixture], env: [], enabled: true }

let root = ""
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-mcp-configured-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function config(name: string, mcp: unknown): Promise<string> {
  const path = join(root, name)
  await writeFile(path, JSON.stringify({ version: 1, mode: "ask", mcp }))
  return path
}

describe("MCP servers from the behavior file", () => {
  test("parses servers with their arguments, inherited variable names, and switch", async () => {
    const path = await config("valid.json", { servers: [{ name: "github", command: "npx", args: ["-y", "server-github"], env: ["GITHUB_TOKEN"] }, { name: "local_db", command: "/usr/local/bin/db-mcp", enabled: false }] })
    const loaded = await loadBehaviorConfigFile(path, { cwd: root })
    expect(loaded.mcpServers).toEqual([
      { transport: "stdio", name: "github", command: "npx", args: ["-y", "server-github"], env: ["GITHUB_TOKEN"], enabled: true },
      { transport: "stdio", name: "local_db", command: "/usr/local/bin/db-mcp", args: [], env: [], enabled: false },
    ])
    expect((await loadBehaviorConfigFile(await config("none.json", undefined), { cwd: root })).mcpServers).toEqual([])
  })

  test("refuses bad names, duplicates, commands with spaces, and bad variable names", async () => {
    const bad: unknown[] = [
      { servers: [{ name: "Bad Name", command: "npx" }] },
      { servers: [{ name: "dup", command: "a" }, { name: "dup", command: "b" }] },
      { servers: [{ name: "spaced", command: "npx -y server" }] },
      { servers: [{ name: "flag", command: "--help" }] },
      { servers: [{ name: "env", command: "npx", env: ["TOKEN=value"] }] },
      { servers: [{ name: "args", command: "npx", args: "-y" }] },
      { servers: Array.from({ length: 17 }, (_, index) => ({ name: `s${String(index)}`, command: "npx" })) },
      { servers: "github" },
      { servers: [{ name: "plain", url: "http://mcp.example.com/mcp" }] },
      { servers: [{ name: "userinfo", url: "https://user:secret@mcp.example.com/mcp" }] },
      { servers: [{ name: "both", url: "https://mcp.example.com/mcp", command: "npx" }] },
      { servers: [{ name: "bearer", command: "npx", bearerEnv: "TOKEN" }] },
      { servers: [{ name: "badvar", url: "https://mcp.example.com/mcp", bearerEnv: "TOKEN=value" }] },
      { servers: [{ name: "scheme", url: "file:///etc/passwd" }] },
    ]
    for (const [index, mcp] of bad.entries()) {
      await expect(loadBehaviorConfigFile(await config(`bad-${String(index)}.json`, mcp), { cwd: root })).rejects.toBeInstanceOf(BehaviorConfigError)
    }
  })

  test("starts each server under its configured name and reports the ones that are off or fail", async () => {
    const configured = await connectConfiguredMcp([
      fixtureServer,
      { ...fixtureServer, name: "paused", enabled: false },
      { transport: "stdio", name: "missing", command: join(root, "no-such-server"), args: [], env: [], enabled: true },
    ], root)
    try {
      expect(configured.status).toEqual([
        { name: "fixture", state: "ready", tools: 3 },
        { name: "paused", state: "off", tools: 0 },
        { name: "missing", state: "failed", tools: 0, code: expect.stringMatching(/^MCP_[A-Z_]+$/) },
      ])
      expect(configured.tools.map((tool) => tool.name).sort()).toEqual(["fixture.echo", "fixture.hold", "fixture.mutate"])
      // A server that only says it might write still asks first.
      expect(configured.tools.find((tool) => tool.name === "fixture.mutate")?.requiresApproval).toBe(true)
    } finally {
      await configured.close()
    }
  })

  test("parses servers reached over HTTP: https anywhere, plain http only on this machine", async () => {
    const path = await config("http.json", { servers: [{ name: "docs", url: "https://mcp.example.com/mcp", bearerEnv: "DOCS_TOKEN" }, { name: "local", url: "http://127.0.0.1:8931/mcp", enabled: false }] })
    expect((await loadBehaviorConfigFile(path, { cwd: root })).mcpServers).toEqual([
      { transport: "http", name: "docs", url: "https://mcp.example.com/mcp", bearerEnv: "DOCS_TOKEN", enabled: true },
      { transport: "http", name: "local", url: "http://127.0.0.1:8931/mcp", enabled: false },
    ])
  })

  test("an HTTP server gets its token from the variable it names, and fails without it", async () => {
    const seen: unknown[] = []
    const connectHttp = async (options: unknown) => {
      seen.push(options)
      return { server: undefined, listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => undefined } as never
    }
    const docs = { transport: "http" as const, name: "docs", url: "https://mcp.example.com/mcp", bearerEnv: "DOCS_TOKEN", enabled: true }
    const configured = await connectConfiguredMcp([docs, { ...docs, name: "unset", bearerEnv: "UNSET_TOKEN" }], root, undefined, connectHttp, { DOCS_TOKEN: "docs-token-value" })
    expect(configured.status).toEqual([
      { name: "docs", state: "ready", tools: 0 },
      { name: "unset", state: "failed", tools: 0, code: "MCP_TOKEN_MISSING" },
    ])
    expect(seen).toEqual([{ url: "https://mcp.example.com/mcp", allowRemote: true, timeoutMs: 20_000, headers: { authorization: "Bearer docs-token-value" } }])
    await configured.close()
  })

  test("a server gets the variables it names, and no others", async () => {
    process.env.FIXTURE_MCP_TOKEN = "fixture-token-value"
    const named = await McpClient.connect({ command: process.execPath, args: [fixture], inherit: ["FIXTURE_MCP_TOKEN"] })
    const unnamed = await McpClient.connect({ command: process.execPath, args: [fixture] })
    try {
      expect((await named.callTool("env", {})).content).toEqual([{ type: "text", text: "token present" }])
      expect((await unnamed.callTool("env", {})).content).toEqual([{ type: "text", text: "token absent" }])
      await expect(McpClient.connect({ command: process.execPath, args: [fixture], inherit: ["BAD=NAME"] })).rejects.toThrow()
    } finally {
      delete process.env.FIXTURE_MCP_TOKEN
      await named.close()
      await unnamed.close()
    }
  })

  test("mcp.status answers with each server's state, and the capability is listed", async () => {
    const token = "mcp-status-test-token"
    const server = await startRunrailControlRpcServer({
      cwd: root,
      backend: "native",
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "done" }) },
      behaviorConfigPath: await config("control.json", { servers: [fixtureServer, { ...fixtureServer, name: "paused", enabled: false }] }),
      authToken: token,
    })
    try {
      const health = await (await fetch(`${server.handle.url}/health`)).json() as { readonly capabilityStatus: Record<string, string> }
      expect(health.capabilityStatus.mcp).toBe("available")
      const response = await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "mcp.status", params: {} }) })
      expect(await response.json()).toEqual({ ok: true, result: { servers: [{ name: "fixture", state: "ready", tools: 3 }, { name: "paused", state: "off", tools: 0 }] } })
      const refused = await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "mcp.status", params: {} }) })
      expect(refused.status).toBe(401)
    } finally {
      await server.handle.stop()
    }
  })

  test("mcp.check starts a named server on its own, even one that is off or on another backend", async () => {
    const token = "mcp-check-test-token"
    const server = await startRunrailControlRpcServer({
      cwd: root,
      backend: "replay",
      loadExtensions: false,
      behaviorConfigPath: await config("check.json", { servers: [{ ...fixtureServer, name: "paused", enabled: false }] }),
      authToken: token,
    })
    const call = async (params: Record<string, unknown>): Promise<{ readonly status: number; readonly body: unknown }> => {
      const response = await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "mcp.check", params }) })
      return { status: response.status, body: await response.json() }
    }
    try {
      // A coding-tool or replay engine starts no servers for its turns.
      expect((await (await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "mcp.status", params: {} }) })).json())).toEqual({ ok: true, result: { servers: [] } })
      expect(await call({ name: "paused" })).toEqual({ status: 200, body: { ok: true, result: { name: "paused", state: "ready", tools: 3 } } })
      expect(await call({ name: "missing" })).toMatchObject({ status: 400, body: { ok: false, error: { code: "CONTROL_INVALID_INPUT" } } })
      expect(await call({ name: "Not A Name" })).toMatchObject({ status: 400, body: { ok: false, error: { code: "CONTROL_INVALID_INPUT" } } })
      expect(await call({})).toMatchObject({ status: 400, body: { ok: false } })
    } finally {
      await server.handle.stop()
    }
  })

  test("a behavior file with an invalid server list stops the engine from starting", async () => {
    await expect(startRunrailControlRpcServer({
      cwd: root,
      backend: "native",
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "done" }) },
      behaviorConfigPath: await config("control-bad.json", { servers: [{ name: "x y", command: "npx" }] }),
    })).rejects.toThrow()
  })
})
