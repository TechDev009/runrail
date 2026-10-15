import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ConnectionDirectory,
  FileAccountStore,
  FileConnectionSettingsStore,
  InMemoryAccountStore,
  InMemoryConnectionSettingsStore,
  parseAccountRecord,
  parseConnectionSettings,
} from "../../src/accounts/index.ts"

const cleanup: string[] = []
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

const account = (accountId: string, status: "ready" | "revoked" = "ready") => parseAccountRecord({
  reference: { accountId, provider: "openrouter", label: `Label ${accountId}`, authMode: "environment", environmentName: "OPENROUTER_API_KEY", scopes: [], createdAt: 1, updatedAt: 1 },
  status,
})

async function code(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : `unexpected:${String(error)}`
  }
  return "no error"
}

function directory(accounts = new InMemoryAccountStore(), clock = () => 1_000) {
  const settings = new InMemoryConnectionSettingsStore()
  return { accounts, settings, connections: new ConnectionDirectory(accounts, settings, clock) }
}

describe("connections the person added", () => {
  test("a fresh store has no connections and no default", async () => {
    const { connections } = directory()
    expect(await connections.list()).toEqual({ connections: [] })
  })

  test("an account with no settings is on with every listed model; turning it off leaves it out of the picker", async () => {
    const { accounts, connections } = directory()
    accounts.put(account("conn-a"))
    accounts.put(account("conn-gone", "revoked"))
    expect((await connections.list()).connections).toEqual([
      { kind: "provider", connectionId: "conn-a", provider: "openrouter", label: "Label conn-a", authMode: "environment", status: "ready", enabled: true },
      { kind: "provider", connectionId: "conn-gone", provider: "openrouter", label: "Label conn-gone", authMode: "environment", status: "revoked", enabled: true },
    ])
    await connections.update("conn-a", { enabled: false, models: ["router/large", "router/small"], label: "Work router" })
    expect(await connections.get("conn-a")).toMatchObject({ enabled: false, models: ["router/large", "router/small"], label: "Work router" })
    expect((await accounts.get("conn-a"))?.reference).toMatchObject({ label: "Work router", updatedAt: 1_000 })
    // Off and revoked connections are not offered.
    expect((await connections.list({ enabledOnly: true })).connections).toEqual([])
    expect(await code(() => connections.requireProviderModel("conn-a", "router/large"))).toBe("CONNECTION_DISABLED")
    await connections.update("conn-a", { enabled: true })
    expect(await code(() => connections.requireProviderModel("conn-a", "router/other"))).toBe("CONNECTION_MODEL_NOT_CHOSEN")
    await expect(connections.requireProviderModel("conn-a", "router/small")).resolves.toBeUndefined()
    await connections.update("conn-a", { models: null })
    expect(await connections.get("conn-a")).not.toHaveProperty("models")
    await expect(connections.requireProviderModel("conn-a", "router/other")).resolves.toBeUndefined()
  })

  test("a model list is never empty or repeated", async () => {
    const { accounts, connections } = directory()
    accounts.put(account("conn-a"))
    expect(await code(() => connections.update("conn-a", { models: [] }))).toBe("CONNECTION_MODELS_EMPTY")
    expect(await code(() => connections.update("conn-a", { models: ["m", "m"] }))).toBe("CONNECTION_INVALID")
    expect(await code(() => connections.update("conn-a", { models: ["-flag"] }))).toBe("CONNECTION_INVALID")
    expect(await code(() => connections.update("missing", { enabled: false }))).toBe("CONNECTION_NOT_FOUND")
    expect(await code(() => connections.addTool({ tool: "codex", models: [] }))).toBe("CONNECTION_MODELS_EMPTY")
  })

  test("coding tools are added, numbered, and removed without signing anything out", async () => {
    const { accounts, connections } = directory()
    accounts.put(account("codex-1"))
    expect(await connections.addTool({ tool: "claude-code" })).toEqual({ kind: "tool", connectionId: "claude-code-1", tool: "claude-code", label: "Claude Code", authMode: "subscription", separateAccount: false, enabled: true })
    // A key connection always runs in a folder of its own.
    expect(await connections.addTool({ tool: "claude-code", authMode: "api-key", models: ["sonnet", "opus"] })).toEqual({ kind: "tool", connectionId: "claude-code-2", tool: "claude-code", label: "Claude Code 2", authMode: "api-key", separateAccount: true, enabled: true, models: ["sonnet", "opus"] })
    expect(await connections.addTool({ tool: "codex", connectionId: "codex-own", separateAccount: true })).toMatchObject({ separateAccount: true })
    expect(await code(() => connections.addTool({ tool: "opencode", separateAccount: true }))).toBe("CONNECTION_AUTH_UNSUPPORTED")
    const homes = (await connections.getTool("claude-code-2")).homeId
    expect([homes?.length, homes === (await connections.getTool("codex-own")).homeId, (await connections.getTool("claude-code-1")).homeId]).toEqual([32, false, undefined])
    // An id an account already has is skipped, and a requested one is refused.
    expect((await connections.addTool({ tool: "codex" })).connectionId).toBe("codex-2")
    expect(await code(() => connections.addTool({ tool: "codex", connectionId: "codex-1" }))).toBe("CONNECTION_EXISTS")
    // A connector's key lives in the same vault under `connector:<kind>`.
    expect(await code(() => connections.addTool({ tool: "codex", connectionId: "Connector:linear" }))).toBe("CONNECTION_INVALID")
    expect(await code(() => connections.addTool({ tool: "copilot", authMode: "api-key" }))).toBe("CONNECTION_AUTH_UNSUPPORTED")
    expect(await code(() => connections.addTool({ tool: "cursor" }))).toBe("CONNECTION_INVALID")
    expect(await code(() => connections.requireFreeForAccount("claude-code-1"))).toBe("CONNECTION_EXISTS")

    expect(await code(() => connections.requireTool("claude-code-1", "codex"))).toBe("CONNECTION_INVALID")
    await connections.update("claude-code-1", { enabled: false })
    expect(await code(() => connections.requireTool("claude-code-1", "claude-code"))).toBe("CONNECTION_DISABLED")
    await expect(connections.requireTool("claude-code-2", "claude-code")).resolves.toMatchObject({ authMode: "api-key", models: ["sonnet", "opus"] })

    expect(await connections.removeTool("claude-code-1")).toMatchObject({ connectionId: "claude-code-1", authMode: "subscription" })
    expect(await code(() => connections.removeTool("claude-code-1"))).toBe("CONNECTION_NOT_FOUND")
    expect((await connections.list()).connections.map((entry) => entry.connectionId)).toEqual(["codex-1", "claude-code-2", "codex-own", "codex-2"])
  })

  test("one default model: never taken by adding, moved with its list, cleared with its connection", async () => {
    const { accounts, connections } = directory()
    accounts.put(account("conn-a"))
    await connections.update("conn-a", { models: ["router/large", "router/small"] })
    const tool = await connections.addTool({ tool: "codex", models: ["gpt-fixture"] })
    expect((await connections.list()).default).toBeUndefined()

    expect(await code(() => connections.setDefault({ connectionId: "conn-a", model: "router/other" }))).toBe("CONNECTION_MODEL_NOT_CHOSEN")
    await connections.setDefault({ connectionId: "conn-a", model: "router/small" })
    await connections.addTool({ tool: "gemini" })
    expect((await connections.list()).default).toEqual({ connectionId: "conn-a", model: "router/small", usable: true })

    // Dropping the default's model from the list moves the default to the list's first model.
    await connections.update("conn-a", { models: ["router/large"] })
    expect((await connections.list()).default).toEqual({ connectionId: "conn-a", model: "router/large", usable: true })
    await connections.update("conn-a", { enabled: false })
    expect((await connections.list()).default).toEqual({ connectionId: "conn-a", model: "router/large", usable: false })
    expect(await code(() => connections.setDefault({ connectionId: "conn-a", model: "router/large" }))).toBe("CONNECTION_DISABLED")

    await connections.setDefault({ connectionId: tool.connectionId, model: "gpt-fixture" })
    await connections.removeTool(tool.connectionId)
    expect((await connections.list()).default).toBeUndefined()

    await connections.update("conn-a", { enabled: true })
    await connections.setDefault({ connectionId: "conn-a", model: "router/large" })
    accounts.remove("conn-a")
    await connections.forgetProvider("conn-a")
    expect(await connections.list()).toEqual({ connections: [expect.objectContaining({ tool: "gemini" })] })
    await connections.setDefault(undefined)
  })

  test("settings parse strictly", () => {
    const valid = { providers: { "conn-a": { enabled: false } }, tools: [], default: { connectionId: "conn-a", model: "m" } }
    expect(parseConnectionSettings(valid)).toEqual(valid)
    for (const bad of [
      { ...valid, extra: true },
      { ...valid, providers: { "conn-a": { enabled: "no" } } },
      { ...valid, tools: [{ connectionId: "conn-a", tool: "codex", label: "Codex", authMode: "subscription", enabled: true, createdAt: 1, updatedAt: 1 }] },
      { ...valid, tools: [{ connectionId: "t-1", tool: "copilot", label: "Copilot", authMode: "api-key", enabled: true, createdAt: 1, updatedAt: 1 }] },
      { ...valid, default: { connectionId: "conn-a", model: "" } },
      { ...valid, tools: [{ connectionId: "t-1", tool: "codex", label: "Codex", authMode: "subscription", enabled: true, homeId: "../escape", createdAt: 1, updatedAt: 1 }] },
      { ...valid, tools: [{ connectionId: "t-1", tool: "opencode", label: "OpenCode", authMode: "subscription", enabled: true, homeId: "a".repeat(32), createdAt: 1, updatedAt: 1 }] },
    ]) expect(() => parseConnectionSettings(bad)).toThrow()
  })
})

describe("the settings file", () => {
  test("lives beside accounts.json, which keeps its old shape, and is read by every engine sharing the folder", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-connection-settings-"))
    cleanup.push(root)
    const accounts = new FileAccountStore({ root })
    await accounts.put(account("conn-a"))
    const first = new ConnectionDirectory(accounts, new FileConnectionSettingsStore({ root }))
    await first.update("conn-a", { enabled: false, models: ["router/large"] })
    await first.addTool({ tool: "opencode", models: ["lmstudio/qwen"] })

    // An engine that predates these settings still reads its accounts.
    const stored = JSON.parse(await readFile(join(root, "accounts.json"), "utf8")) as { reference: Record<string, unknown> }[]
    expect(Object.keys(stored[0]!.reference).sort()).toEqual(["accountId", "authMode", "createdAt", "environmentName", "label", "provider", "scopes", "updatedAt"])
    expect(((await stat(join(root, "connections.json"))).mode & 0o777).toString(8)).toBe("600")

    const second = new ConnectionDirectory(new FileAccountStore({ root }), new FileConnectionSettingsStore({ root }))
    expect((await second.list()).connections).toEqual([
      expect.objectContaining({ connectionId: "conn-a", enabled: false, models: ["router/large"] }),
      expect.objectContaining({ connectionId: "opencode-1", tool: "opencode", models: ["lmstudio/qwen"] }),
    ])
    // A change written by the other engine is seen without a restart.
    await second.update("opencode-1", { enabled: false })
    expect(await first.get("opencode-1")).toMatchObject({ enabled: false })

    await writeFile(join(root, "connections.json"), JSON.stringify({ version: 2, providers: {}, tools: [] }))
    expect(await code(() => new FileConnectionSettingsStore({ root }).read())).toBe("CONNECTION_INVALID")
  })
})

test("an account or tool connection can never take a connector key's vault id", async () => {
  expect(await code(() => account("connector:slack"))).toBe("ACCOUNT_INVALID")
  expect(await code(() => account("Connector:Linear"))).toBe("ACCOUNT_INVALID")
  const { connections } = directory()
  expect(await code(() => connections.addTool({ tool: "codex", authMode: "api-key", connectionId: "connector:slack" }))).toBe("CONNECTION_INVALID")
})
