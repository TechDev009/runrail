import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeTool } from "@nifrajs/coding-agent"
import { loadBehaviorConfigFile } from "../../src/behavior/config.ts"
import { claudeCallGated } from "../../src/backend/claude-permission-gate.ts"
import { ConnectorApprovals } from "../../src/connectors/approvals.ts"
import { connectorsPermissions } from "../../src/connectors/mcp.ts"
import { createConnectorRegistry, type ConnectorDefinition } from "../../src/connectors/registry.ts"
import { buildConnectorRegistry, ConnectorSetupStore } from "../../src/connectors/setup.ts"
import { connectorNativeTools, grantedConnectorTools } from "../../src/connectors/tools.ts"
import { grantConfiguredMcp } from "../../src/mcp/configured.ts"

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-connectors-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const calls: string[] = []
function fake(id: string): ConnectorDefinition {
  const action = (name: string, kind: "read" | "search" | "write" | "notify") => ({ name, description: `${id} ${name}`, kind, capabilities: kind === "write" ? ["connector.write"] : kind === "notify" ? ["connector.notify"] : ["connector.read"], execute: (input: unknown) => (calls.push(`${id}.${name}`), { ok: true, input }) })
  return { descriptor: { id, version: "1.0.0", capabilities: ["connector.read", "connector.write", "connector.notify"] }, actions: [action("search", "search"), action("list", "read"), action("create", "write"), action("send", "notify")] }
}

describe("who may use what", () => {
  const registry = createConnectorRegistry([fake("github"), fake("slack")])
  const names = (grants: Record<string, "off" | "read" | "ask" | "write"> | undefined) => grantedConnectorTools(registry, grants).map((tool) => `${tool.name}${tool.approval ? " (asks)" : ""}`)

  test("Off hides it, Read offers reads and searches, Ask makes every use wait, Write asks only before writing", () => {
    expect(names({ github: "off", slack: "off" })).toEqual([])
    expect(names({ github: "read", slack: "off" })).toEqual(["github_search", "github_list"])
    expect(names({ github: "ask", slack: "off" })).toEqual(["github_search (asks)", "github_list (asks)", "github_create (asks)", "github_send (asks)"])
    expect(names({ github: "write", slack: "off" })).toEqual(["github_search", "github_list", "github_create (asks)", "github_send (asks)"])
  })

  test("an integration left out of the grants is Write, as before grants existed", () => {
    expect(names(undefined)).toEqual(names({ github: "write", slack: "write" }))
  })

  test("each route takes the same grants: native tools ask where the grant asks, and on Claude Code they ask in every mode", async () => {
    const granted = grantedConnectorTools(registry, { github: "read", slack: "ask" })
    const native = connectorNativeTools(registry, granted)
    expect(native.map((tool) => [tool.name, tool.requiresApproval === true])).toEqual([
      ["connector.github.search", false],
      ["connector.github.list", false],
      ["connector.slack.search", true],
      ["connector.slack.list", true],
      ["connector.slack.create", true],
      ["connector.slack.send", true],
    ])
    const claude = connectorsPermissions(granted)
    expect(claude.allowedTools).toEqual(["mcp__runrail_connectors"])
    expect(claude.askTools).toEqual(["mcp__runrail_connectors__slack_search", "mcp__runrail_connectors__slack_list", "mcp__runrail_connectors__slack_create", "mcp__runrail_connectors__slack_send"])
    // Full access leaves calls to Claude Code, but not these.
    for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions", "plan"]) {
      expect(claudeCallGated("mcp__runrail_connectors__slack_send", mode, claude.allowedTools, claude.askTools)).toBe(true)
      expect(claudeCallGated("mcp__runrail_connectors__github_search", mode, claude.allowedTools, claude.askTools)).toBe(false)
    }
    calls.length = 0
    await native[0]!.execute({ query: "x" }, { cwd: root, signal: new AbortController().signal })
    expect(calls).toEqual(["github.search"])
  })

  test("MCP servers the session starts: Off leaves the server out, Read keeps read-only tools, Ask makes each ask", () => {
    const tool = (name: string, asks: boolean): NativeTool => ({ name, description: name, ...(asks ? { requiresApproval: true } : {}), execute: () => null })
    const configured = { tools: [tool("db.query", false), tool("db.write", true), tool("files.read", false)], status: [{ name: "db", state: "ready" as const, tools: 2 }, { name: "files", state: "ready" as const, tools: 1 }], close: async () => undefined }
    const read = grantConfiguredMcp(configured, { "mcp:db": "read", "mcp:files": "off" })
    expect(read.tools.map((entry) => entry.name)).toEqual(["db.query"])
    expect(read.status.map((entry) => entry.state)).toEqual(["ready", "off"])
    const ask = grantConfiguredMcp(configured, { "mcp:db": "ask" })
    expect(ask.tools.map((entry) => [entry.name, entry.requiresApproval === true])).toEqual([["db.query", true], ["db.write", true], ["files.read", false]])
    expect(grantConfiguredMcp(configured, undefined)).toBe(configured)
  })

  test("the behavior file carries the grants; a key or a level it does not know is refused", async () => {
    const file = join(root, "config.json")
    await writeFile(file, JSON.stringify({ version: 1, integrations: { github: "read", "mcp:db": "ask" } }))
    expect((await loadBehaviorConfigFile(file, { cwd: root })).integrations).toEqual({ github: "read", "mcp:db": "ask" })
    for (const bad of [{ github: "admin" }, { "bad key": "read" }, ["read"]]) {
      await writeFile(file, JSON.stringify({ version: 1, integrations: bad }))
      await expect(loadBehaviorConfigFile(file, { cwd: root })).rejects.toThrow("integrations are invalid")
    }
  })
})

describe("connector setup", () => {
  test("the file keeps which connectors are on and Jira's site, never a key, and only this user can read it", async () => {
    const store = new ConnectorSetupStore(join(root, "setup", "connectors.json"))
    expect(await store.read()).toEqual({})
    await store.save("slack", { on: true }, 1)
    await expect(store.save("jira", { on: true })).rejects.toThrow("Jira needs its site")
    await expect(store.save("jira", { on: true, site: "not a site", email: "me@example.com" })).rejects.toThrow("invalid")
    await store.save("jira", { on: true, site: "https://Your-Team.atlassian.net/", email: "me@example.com" }, 2)
    expect(await store.read()).toEqual({ slack: { on: true, updatedAt: 1 }, jira: { on: true, site: "your-team.atlassian.net", email: "me@example.com", updatedAt: 2 } })
    expect((await stat(store.file)).mode & 0o777).toBe(0o600)
    await store.remove("slack")
    expect(Object.keys(await store.read())).toEqual(["jira"])
    expect(await readFile(store.file, "utf8")).not.toContain("secret")
  })

  test("only connectors that are on are registered, and a key is asked for at call time, not at start", async () => {
    const asked: string[] = []
    const registry = buildConnectorRegistry({ github: { on: true, updatedAt: 1 }, linear: { on: false, updatedAt: 1 }, jira: { on: true, site: "your-team.atlassian.net", email: "me@example.com", updatedAt: 1 } }, { resolve: async (kind) => (asked.push(kind), "k") })
    expect(registry.list().map((entry) => entry.id)).toEqual(["github", "jira"])
    expect(asked).toEqual([])
  })
})

describe("approvals a connector call spends", () => {
  test("one approval runs the same tool with the same input once, whatever the key order, until it expires", () => {
    let now = 0
    const approvals = new ConnectorApprovals(() => now)
    approvals.approve("slack_sendMessage", { channel: "C1", text: "hi", blocks: [{ a: 1, b: 2 }] })
    expect(approvals.take("slack_sendMessage", { channel: "C1", text: "bye" })).toBe(false)
    expect(approvals.take("slack_postMessage", { channel: "C1", text: "hi", blocks: [{ a: 1, b: 2 }] })).toBe(false)
    expect(approvals.take("slack_sendMessage", { blocks: [{ b: 2, a: 1 }], text: "hi", channel: "C1" })).toBe(true)
    expect(approvals.take("slack_sendMessage", { channel: "C1", text: "hi", blocks: [{ a: 1, b: 2 }] })).toBe(false)
    approvals.approve("github_createIssue", undefined)
    now = 10 * 60_000 + 1
    expect(approvals.take("github_createIssue", {})).toBe(false)
  })
})
