import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findImportableConnections } from "../../src/accounts/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

const KEY_IN_FILE = "sk-fixture-literal-key-0000"

let home = ""
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "runrail-connection-import-"))
  await mkdir(join(home, ".codex"), { recursive: true })
  await writeFile(
    join(home, ".codex", "config.toml"),
    [
      'model = "anthropic/claude-sonnet-4.5"',
      'model_provider = "openrouter"',
      "[model_providers.openrouter]",
      'name = "OpenRouter"',
      'base_url = "https://openrouter.ai/api/v1"',
      'env_key = "OPENROUTER_API_KEY"',
      "[model_providers.ollama]",
      'name = "Ollama"',
      'base_url = "http://localhost:11434/v1"',
      "[model_providers.plain]",
      'base_url = "http://relay.example.com/v1"',
      "[model_providers.stolen]",
      'base_url = "https://api.groq.com/openai/v1"',
      'env_key = "OPENAI_API_KEY"',
    ].join("\n"),
  )
  await mkdir(join(home, ".pi", "agent"), { recursive: true })
  await writeFile(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        relay: { baseUrl: "https://relay.example.com/v1", api: "openai-completions", apiKey: KEY_IN_FILE, models: [{ id: "relay-large" }, { id: "text-embedding-relay" }] },
        // The same address as Codex's entry is listed once.
        "openrouter-pi": { baseUrl: "https://openrouter.ai/api/v1", apiKey: "OPENROUTER_API_KEY", models: [] },
      },
    }),
  )
  await mkdir(join(home, ".config", "opencode"), { recursive: true })
  await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: { deepseek: { name: "DeepSeek", options: { baseURL: "https://api.deepseek.com", apiKey: "{env:DEEPSEEK_API_KEY}" }, models: { "deepseek-chat": {} } }, broken: "x" } }))
})
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("provider settings from other coding tools", () => {
  test("offers known providers, local endpoints, and other https addresses, never a key", async () => {
    const found = await findImportableConnections(home, { OPENROUTER_API_KEY: "set", DEEPSEEK_API_KEY: "" })
    expect(found).toEqual([
      { source: "codex", id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", kind: "preset", presetId: "openrouter", environmentName: "OPENROUTER_API_KEY", environmentSet: true, models: ["anthropic/claude-sonnet-4.5"] },
      { source: "codex", id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", kind: "local", models: [] },
      // Another vendor's variable is never offered for this address.
      { source: "codex", id: "stolen", name: "stolen", baseUrl: "https://api.groq.com/openai/v1", kind: "preset", presetId: "groq", models: [] },
      { source: "pi", id: "relay", name: "relay", baseUrl: "https://relay.example.com/v1", kind: "remote", models: ["relay-large"] },
      { source: "opencode", id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", kind: "preset", presetId: "deepseek", environmentName: "DEEPSEEK_API_KEY", environmentSet: false, models: ["deepseek-chat"] },
    ])
    expect(JSON.stringify(found)).not.toContain(KEY_IN_FILE)
  })

  test("a home without those files offers nothing", async () => {
    expect(await findImportableConnections(join(home, "missing"), {})).toEqual([])
  })

  test("connection.importable answers on the control server, and the capability is listed", async () => {
    const token = "connection-import-test-token"
    const server = await startRunrailControlRpcServer({ cwd: home, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) }, authToken: token, connectionImportHome: home, connectionEnvironment: {} })
    try {
      const health = (await (await fetch(`${server.handle.url}/health`)).json()) as { readonly capabilityStatus: Record<string, string> }
      expect(health.capabilityStatus["connection.import"]).toBe("available")
      const response = await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "connection.importable", params: {} }) })
      const body = (await response.json()) as { readonly ok: boolean; readonly result: { readonly candidates: readonly { readonly id: string }[] } }
      expect(body.ok).toBe(true)
      expect(body.result.candidates.map((candidate) => candidate.id)).toEqual(["openrouter", "ollama", "stolen", "relay", "deepseek"])
      expect(JSON.stringify(body)).not.toContain(KEY_IN_FILE)
      const refused = await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "connection.importable", params: {} }) })
      expect(refused.status).toBe(401)
    } finally {
      await server.handle.stop()
    }
  })
})
