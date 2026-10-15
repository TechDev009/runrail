import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeCodeProxy, codexProxy, proxyOf } from "../../src/harness/proxy.ts"

const root = mkdtempSync(join(tmpdir(), "runrail-proxy-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function folder(name: string, file: string, text: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), text)
  return dir
}

describe("a coding tool's proxy", () => {
  test("keeps only host and port, and nothing for the vendor's own address", () => {
    expect(proxyOf("http://127.0.0.1:8787/v1?key=secret")).toEqual({ address: "127.0.0.1:8787" })
    expect(proxyOf("https://api.anthropic.com")).toBeUndefined()
    expect(proxyOf("https://chatgpt.com/backend-api/codex")).toBeUndefined()
    expect(proxyOf("file:///etc/passwd")).toBeUndefined()
    expect(proxyOf("not a url")).toBeUndefined()
    expect(proxyOf("http://gateway.example:443", "Team\ngateway")).toEqual({ address: "gateway.example:443", name: "Team gateway" })
  })

  test("Claude Code: the address in its user settings' env, found through the run's environment", async () => {
    const dir = folder("claude", "settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_API_KEY: "sk-unread" } }))
    expect(await claudeCodeProxy({ CLAUDE_CONFIG_DIR: dir })).toEqual({ address: "127.0.0.1:8787" })
    folder("home/.claude", "settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }))
    expect(await claudeCodeProxy({ HOME: join(root, "home") })).toEqual({ address: "gateway.example" })
    expect(await claudeCodeProxy({ CLAUDE_CONFIG_DIR: join(root, "none") })).toBeUndefined()
    expect(await claudeCodeProxy({})).toBeUndefined()
    const broken = folder("claude-broken", "settings.json", "{")
    expect(await claudeCodeProxy({ CLAUDE_CONFIG_DIR: broken })).toBeUndefined()
  })

  test("Codex: the chosen provider's address and name, else its OpenAI address", async () => {
    const named = folder("codex", "config.toml", ['model_provider = "headroom"', 'openai_base_url = "http://127.0.0.1:8787/v1"', "", "[model_providers.headroom]", 'name = "OpenAI via Headroom proxy"', 'base_url = "http://127.0.0.1:8787/v1"'].join("\n"))
    expect(await codexProxy({ CODEX_HOME: named })).toEqual({ address: "127.0.0.1:8787", name: "OpenAI via Headroom proxy" })
    const plain = folder("codex-plain", "config.toml", 'openai_base_url = "http://localhost:4000/v1"\n')
    expect(await codexProxy({ CODEX_HOME: plain })).toEqual({ address: "localhost:4000" })
    expect(await codexProxy({ CODEX_HOME: join(root, "none") })).toBeUndefined()
  })
})
