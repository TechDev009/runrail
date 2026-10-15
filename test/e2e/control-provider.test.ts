import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/index.ts"

function headers(token: string): HeadersInit { return { authorization: `Bearer ${token}`, "content-type": "application/json" } }

async function rpc(url: string, token: string, method: string, params: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${url}/rpc`, { method: "POST", headers: headers(token), body: JSON.stringify({ method, params }) })
}

describe("provider and harness control RPC", () => {
  test("lists, negotiates, discovers, and selects without accepting raw secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runrail-provider-control-"))
    const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname
    const token = "provider-control-test-token"
    const discovery = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ id: "fixture-model" }] }) })
    const server = await startRunrailControlRpcServer({ cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) }, authToken: token, harnessCommand: process.execPath, harnessArgs: [fixture], harnessProtocol: "app-server", nativeAccountsDir: join(cwd, "accounts"), githubCli: false })
    const previous = process.env.RUNRAIL_FIXTURE_PROVIDER_API_KEY
    process.env.RUNRAIL_FIXTURE_PROVIDER_API_KEY = "fixture-secret"
    try {
      const providers = await rpc(server.handle.url, token, "provider.list")
      const providerPayload = await providers.json() as { readonly result?: readonly { readonly id: string }[] }
      expect(providerPayload.result?.map((provider) => provider.id)).toEqual(["anthropic", "bedrock", "google", "llama.cpp", "openai", "openai-compatible", "vertex", "xai"])
      const harnesses = await rpc(server.handle.url, token, "harness.list")
      const harnessPayload = await harnesses.json() as { readonly result?: readonly { readonly id: string }[] }
      expect(harnessPayload.result?.map((harness) => harness.id)).toEqual(["aider", "claude-code", "codex", "copilot", "gemini", "goose", "opencode", "pi", "pty"])
      const negotiation = await rpc(server.handle.url, token, "harness.negotiate", { id: "pi", features: ["sessions", "mcp"] })
      expect(await negotiation.json()).toMatchObject({ ok: true, result: { granted: ["sessions"], unsupported: ["mcp"] } })
      const discovered = await rpc(server.handle.url, token, "provider.discover", { provider: "openai", endpoint: discovery.url.toString(), credentialEnvironment: "RUNRAIL_FIXTURE_PROVIDER_API_KEY" })
      expect(await discovered.json()).toMatchObject({ ok: true, result: [{ id: "fixture-model", provider: "openai" }] })
      const selected = await rpc(server.handle.url, token, "provider.select", { provider: "openai", model: "fixture-model", endpoint: discovery.url.toString(), credentialEnvironment: "RUNRAIL_FIXTURE_PROVIDER_API_KEY" })
      expect(await selected.json()).toMatchObject({ ok: true, result: { backend: "native", model: { id: "fixture-model", provider: "openai" } } })
      const switched = await rpc(server.handle.url, token, "backend.switch", { backend: "codex" })
      expect(await switched.json()).toMatchObject({ ok: true, result: { name: "codex-app-server" } })
      const native = await rpc(server.handle.url, token, "backend.switch", { backend: "native" })
      expect(await native.json()).toMatchObject({ ok: true, result: { name: "runrail" } })
      const secret = await rpc(server.handle.url, token, "provider.select", { provider: "openai", model: "fixture-model", apiKey: "must-not-pass" })
      expect(secret.status).toBe(400)
      expect(await secret.json()).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
    } finally {
      if (previous === undefined) delete process.env.RUNRAIL_FIXTURE_PROVIDER_API_KEY
      else process.env.RUNRAIL_FIXTURE_PROVIDER_API_KEY = previous
      await server.handle.stop()
      await discovery.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
