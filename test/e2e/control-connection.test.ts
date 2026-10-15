import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { FileAccountStore, parseAccountRecord } from "../../src/accounts/index.ts"
import { MemoryCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { CUSTOM_PROVIDER_PRESETS, PROVIDER_PRESETS, RUNRAIL_USER_AGENT, createModelMetadataSource } from "../../src/index.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>
interface Reply {
  readonly status: number
  readonly code: string | null
  readonly text: string
  readonly body: { readonly ok: boolean; readonly result?: Record<string, unknown>; readonly error?: { readonly code: string; readonly message?: string } | string }
}
interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly userAgent: string | null
  readonly body?: Record<string, unknown>
}

// Distinct from every other string in the test so a leak is unambiguous.
const CANARY = "sk-canary-4c81e07d2a9b4f53b6e0"
const SHELL_CANARY = "sk-shell-canary-91d3f5a7c2e8"
// No preset claims this name, so an account may point it at any endpoint.
const SHELL_NAME = "RUNRAIL_E2E_RELAY_API_KEY"

const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function send(running: Running, payload: unknown, token: string | null = running.handle.token, path: "/rpc" | "/secret" = "/rpc"): Promise<Reply> {
  const response = await fetch(`${running.handle.url}${path}`, {
    method: "POST",
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  return { status: response.status, code: response.headers.get("x-runrail-error-code"), text, body: JSON.parse(text) as Reply["body"] }
}

const rpc = (running: Running, method: string, params: Record<string, unknown> = {}): Promise<Reply> => send(running, { method, params })
const storeSecret = (running: Running, accountId: string, secret: string): Promise<Reply> => send(running, { accountId, secret }, running.handle.token, "/secret")

/** Everything the event stream has to say within a short window, as text. */
async function eventStreamText(running: Running): Promise<string> {
  const abort = new AbortController()
  const response = await fetch(`${running.handle.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${running.handle.token}` }, signal: abort.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const timer = setTimeout(() => abort.abort(), 250)
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    // Aborted after the window.
  } finally {
    clearTimeout(timer)
  }
  return text
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if ((await readFile(path)).includes(needle)) found.push(path)
  }
  return found.sort()
}

/** A loopback endpoint that speaks just enough Chat Completions to answer a list call and one turn. */
function mockEndpoint() {
  const seen: Seen[] = []
  const state: { status: number; list: unknown } = { status: 200, list: { data: [{ id: "chat-model", context_length: 32_000 }, { id: "text-embedding-fixture" }] } }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const url = new URL(incoming.url)
      const body = incoming.method === "POST" ? await incoming.json() as Record<string, unknown> : undefined
      seen.push({ method: incoming.method, path: url.pathname, authorization: incoming.headers.get("authorization"), userAgent: incoming.headers.get("user-agent"), ...(body === undefined ? {} : { body }) })
      if (state.status !== 200) return Response.json({ error: "refused" }, { status: state.status })
      if (incoming.method === "GET") return Response.json(state.list)
      return new Response('data: {"choices":[{"delta":{"content":"from the mock"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
    },
  })
  cleanup.push(() => server.stop(true))
  return { seen, state, server, baseUrl: `http://127.0.0.1:${server.port}/v1` }
}

async function start(extra: Partial<Parameters<typeof startRunrailControlRpcServer>[0]> = {}): Promise<{ running: Running; dirs: readonly string[] }> {
  const cwd = await mkdtemp(join("/tmp", "runrail-connection-cwd-"))
  const sessionDir = await mkdtemp(join("/tmp", "runrail-connection-state-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-connection-accounts-"))
  const dirs = [cwd, sessionDir, accountsDir]
  for (const dir of dirs) cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "connection-session",
    loadExtensions: false,
    model: { complete: () => ({ type: "text" as const, text: "from the fixture model" }) },
    nativeAccountsDir: accountsDir,
    nativeCredentialVault: new MemoryCredentialVault(),
    connectionEnvironment: {},
    ...extra,
  })
  cleanup.push(() => running.handle.stop())
  return { running, dirs }
}

const localAccount = (baseUrl: string, extra: Record<string, unknown> = {}) => ({ accountId: "conn-local", provider: "custom-openai-chat", label: "Local relay", authMode: "api-key", baseUrl, ...extra })

describe("control connections", () => {
  test("advertises the capability and lists every preset without a secret", async () => {
    const { running } = await start()
    const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilities: string[]; capabilityStatus: Record<string, string> }
    expect(health.capabilities).toContain("connections")
    expect(health.capabilityStatus.connections).toBe("available")

    const listed = await rpc(running, "connection.presets")
    expect(listed.status).toBe(200)
    const result = listed.body.result as { presets: Record<string, unknown>[]; custom: Record<string, unknown>[] }
    expect(result.presets.map((preset) => preset.id)).toEqual(PROVIDER_PRESETS.map((preset) => preset.id))
    expect(result.custom.map((preset) => preset.id)).toEqual(CUSTOM_PROVIDER_PRESETS.map((preset) => preset.id))
    expect(result.presets.find((preset) => preset.id === "deepseek")).toEqual({ id: "deepseek", name: "DeepSeek", protocol: "openai-chat", baseUrl: "https://api.deepseek.com", environment: "DEEPSEEK_API_KEY", models: "list" })
    expect(result.custom.find((preset) => preset.id === "custom-anthropic-bearer")).toEqual({ id: "custom-anthropic-bearer", name: expect.any(String), protocol: "anthropic-messages", authStyle: "bearer" })
    // Wire quirks are engine business; a client gets only what it shows.
    for (const preset of result.presets) expect(Object.keys(preset).sort().filter((key) => key !== "environment" && key !== "signInOnly")).toEqual(["baseUrl", "id", "models", "name", "protocol"])
    // Plan addresses are marked, so a client offers a sign-in there and no key form.
    expect(result.presets.filter((preset) => "signInOnly" in preset)).toEqual([
      { id: "xai-grok", name: "xAI (Grok plan)", protocol: "openai-responses", baseUrl: "https://api.x.ai/v1", models: "list", signInOnly: true },
      { id: "kimi-code", name: "Kimi Code", protocol: "anthropic-messages", baseUrl: "https://api.kimi.com/coding/v1", models: "list", signInOnly: true },
    ])

    for (const method of ["connection.presets", "connection.detect", "connection.models", "connection.test"]) {
      const refused = await send(running, { method, params: { connectionId: "conn-local" } }, null)
      expect(refused.status).toBe(401)
      expect(refused.body.error).toBe("CONTROL_UNAUTHORIZED")
    }
  })

  test("a plan address takes no key: refused when the connection is made and when a key is typed", async () => {
    const { running, dirs } = await start({ connectionEnvironment: { XAI_API_KEY: SHELL_CANARY } })
    for (const params of [
      { accountId: "conn-plan", provider: "xai-grok", label: "Grok plan", authMode: "api-key" },
      { accountId: "conn-plan", provider: "kimi-code", label: "Kimi Code", authMode: "api-key" },
      { accountId: "conn-plan", provider: "xai-grok", label: "Grok plan", authMode: "environment", environmentName: "XAI_API_KEY" },
    ]) {
      for (const method of ["account.create", "account.upsert"]) {
        const refused = await rpc(running, method, params)
        expect([method, params.provider, params.authMode, refused.status, refused.code]).toEqual([method, params.provider, params.authMode, 400, "CONTROL_ACCOUNT_SIGN_IN_ONLY"])
      }
    }
    expect((await rpc(running, "account.list")).body.result as unknown).toEqual([])

    // A key connection an older engine let through is refused when its key is typed, and nothing is stored.
    await new FileAccountStore({ root: dirs[2]! }).put(parseAccountRecord({ reference: { accountId: "conn-old", provider: "xai-grok", label: "Grok plan", authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1 }, status: "unconfigured" }))
    const typed = await storeSecret(running, "conn-old", CANARY)
    expect([typed.status, typed.code]).toEqual([400, "CONTROL_ACCOUNT_SIGN_IN_ONLY"])
    expect(typed.text).not.toContain(CANARY)
    expect((await rpc(running, "account.get", { accountId: "conn-old" })).body.result).toMatchObject({ status: "unconfigured" })
  })

  test("offers a shell key by name only, until a connection already uses it", async () => {
    const { running } = await start({ connectionEnvironment: { OPENROUTER_API_KEY: SHELL_CANARY, DEEPSEEK_API_KEY: "", UNRELATED: "value" } })
    const detected = await rpc(running, "connection.detect")
    expect(detected.status).toBe(200)
    expect(detected.body.result).toEqual({ detected: [{ presetId: "openrouter", name: "OpenRouter", environmentName: "OPENROUTER_API_KEY" }] })
    expect(detected.text).not.toContain(SHELL_CANARY)

    const created = await rpc(running, "account.create", { accountId: "conn-shell", provider: "openrouter", label: "OpenRouter (shell)", authMode: "environment", environmentName: "OPENROUTER_API_KEY" })
    expect(created.status).toBe(200)
    expect(created.text).not.toContain(SHELL_CANARY)
    expect((await rpc(running, "connection.detect")).body.result).toEqual({ detected: [] })
    // A pasted key for the same provider does not hide the shell offer; a revoked shell connection brings it back.
    expect((await rpc(running, "account.create", { accountId: "conn-pasted", provider: "openrouter", label: "OpenRouter", authMode: "api-key" })).status).toBe(200)
    expect((await rpc(running, "account.revoke", { accountId: "conn-shell" })).status).toBe(200)
    expect((await rpc(running, "connection.detect")).body.result).toMatchObject({ detected: [{ presetId: "openrouter" }] })
  })

  test("a custom endpoint lists models, passes the check and runs a turn with the stored key", async () => {
    const endpoint = mockEndpoint()
    const metadata = createModelMetadataSource({ generatedAt: "2026-01-01", providers: { "custom-openai-chat": [{ id: "chat-model", name: "Chat Model", contextTokens: 64_000 }, { id: "snapshot-only", contextTokens: 8_000 }] } })
    const { running, dirs } = await start({ modelMetadata: metadata })
    const created = await rpc(running, "account.create", localAccount(endpoint.baseUrl))
    expect(created.body.result).toMatchObject({ status: "unconfigured", reference: { accountId: "conn-local", baseUrl: endpoint.baseUrl } })

    // No key yet: nothing is sent, and the bundled list stands in for the live one.
    const early = await rpc(running, "connection.test", { connectionId: "conn-local" })
    expect(early.body.result).toMatchObject({ connectionId: "conn-local", status: "failed", code: "CREDENTIAL_MISSING" })
    expect(early.body.result).not.toHaveProperty("modelCount")
    const bundled = await rpc(running, "connection.models", { connectionId: "conn-local" })
    expect(bundled.body.result).toEqual({
      connectionId: "conn-local",
      presetId: "custom-openai-chat",
      models: [{ id: "chat-model", name: "Chat Model", contextTokens: 64_000, source: "snapshot" }, { id: "snapshot-only", contextTokens: 8_000, source: "snapshot" }],
      images: [],
      live: { ok: false, code: "CREDENTIAL_MISSING" },
      manualEntry: true,
    })
    expect(endpoint.seen).toEqual([])

    expect((await storeSecret(running, "conn-local", CANARY)).status).toBe(200)
    const before = await rpc(running, "account.get", { accountId: "conn-local" })

    const models = await rpc(running, "connection.models", { connectionId: "conn-local" })
    expect(models.status).toBe(200)
    // The live list wins, non-chat models are dropped, the bundle fills the name.
    expect(models.body.result).toEqual({
      connectionId: "conn-local",
      presetId: "custom-openai-chat",
      models: [{ id: "chat-model", name: "Chat Model", contextTokens: 32_000, source: "live" }],
      images: [],
      live: { ok: true, code: "OK" },
      manualEntry: true,
    })
    expect(endpoint.seen).toEqual([{ method: "GET", path: "/v1/models", authorization: `Bearer ${CANARY}`, userAgent: RUNRAIL_USER_AGENT }])

    const checked = await rpc(running, "connection.test", { connectionId: "conn-local" })
    expect(checked.body.result).toMatchObject({ connectionId: "conn-local", status: "ok", code: "OK", modelCount: 1, checkedAt: expect.any(Number) })
    // A check reports; it does not rewrite the account.
    expect((await rpc(running, "account.get", { accountId: "conn-local" })).body.result).toEqual(before.body.result!)

    const selected = await rpc(running, "provider.select", { connectionId: "conn-local", model: "chat-model", thinking: "off" })
    expect(selected.status).toBe(200)
    expect(selected.body.result).toMatchObject({ backend: "native", model: { id: "chat-model", provider: "custom-openai-chat", contextTokens: 64_000 } })
    endpoint.seen.length = 0
    expect((await rpc(running, "turn.enqueue", { message: "say something" })).status).toBe(200)
    const turn = endpoint.seen.find((request) => request.method === "POST")
    expect(turn).toMatchObject({ path: "/v1/chat/completions", authorization: `Bearer ${CANARY}`, userAgent: RUNRAIL_USER_AGENT, body: { model: "chat-model", stream: true } })
    const conversation = await rpc(running, "session.conversation.read")
    expect((conversation.body.result as { items: { kind: string; text?: string }[] }).items.find((item) => item.kind === "assistant")?.text).toBe("from the mock")

    // The key went to the endpoint and nowhere a client or a file can read it.
    const replies = [created, early, bundled, models, checked, selected, conversation, await rpc(running, "account.list"), await rpc(running, "control.describe"), await rpc(running, "session.snapshot")]
    for (const reply of replies) expect(reply.text).not.toContain(CANARY)
    expect(await eventStreamText(running)).not.toContain(CANARY)
    for (const dir of dirs) expect(await filesContaining(dir, CANARY)).toEqual([])
  })

  test("reports one stable code for each way a check can end", async () => {
    const endpoint = mockEndpoint()
    const { running } = await start()
    await rpc(running, "account.create", localAccount(endpoint.baseUrl))
    await storeSecret(running, "conn-local", CANARY)
    const check = async (): Promise<unknown> => {
      const reply = await rpc(running, "connection.test", { connectionId: "conn-local" })
      expect(reply.status).toBe(200)
      expect(reply.text).not.toContain(CANARY)
      const result = reply.body.result as { status: string; code: string }
      return { status: result.status, code: result.code }
    }
    const outcomes: [number, unknown, { status: string; code: string }][] = [
      [401, undefined, { status: "failed", code: "AUTH_FAILED" }],
      [403, undefined, { status: "failed", code: "AUTH_FAILED" }],
      [400, undefined, { status: "failed", code: "REJECTED" }],
      [404, undefined, { status: "unverified", code: "NO_MODEL_LIST" }],
      [405, undefined, { status: "unverified", code: "NO_MODEL_LIST" }],
      [429, undefined, { status: "unverified", code: "RATE_LIMITED" }],
      [500, undefined, { status: "failed", code: "SERVER_ERROR" }],
      [200, { object: "error" }, { status: "unverified", code: "INVALID_RESPONSE" }],
    ]
    for (const [status, list, expected] of outcomes) {
      endpoint.state.status = status
      if (list !== undefined) endpoint.state.list = list
      expect(await check()).toEqual(expected)
    }
    // A failed list still leaves the models method usable, with the reason attached.
    endpoint.state.status = 401
    expect((await rpc(running, "connection.models", { connectionId: "conn-local" })).body.result).toMatchObject({ models: [], live: { ok: false, code: "AUTH_FAILED" }, manualEntry: true })
    await endpoint.server.stop(true)
    expect(await check()).toEqual({ status: "failed", code: "UNREACHABLE" })

    // A provider with no list answers "unverified" once a key is there, without any request.
    await rpc(running, "account.create", { accountId: "conn-minimax", provider: "minimax", label: "MiniMax", authMode: "api-key" })
    expect((await rpc(running, "connection.test", { connectionId: "conn-minimax" })).body.result).toMatchObject({ status: "failed", code: "CREDENTIAL_MISSING" })
    await storeSecret(running, "conn-minimax", CANARY)
    expect((await rpc(running, "connection.test", { connectionId: "conn-minimax" })).body.result).toMatchObject({ status: "unverified", code: "NO_MODEL_LIST" })

    for (const method of ["connection.test", "connection.models"]) {
      const missing = await rpc(running, method, { connectionId: "conn-nobody" })
      expect([missing.status, missing.code]).toEqual([404, "CONTROL_ACCOUNT_NOT_FOUND"])
      const malformed = await rpc(running, method, { connectionId: "../escape" })
      expect([malformed.status, malformed.code]).toEqual([400, "CONTROL_INVALID_INPUT"])
      const absent = await rpc(running, method, {})
      expect([absent.status, absent.code]).toEqual([400, "CONTROL_INVALID_INPUT"])
    }
    await rpc(running, "account.revoke", { accountId: "conn-local" })
    for (const method of ["connection.test", "connection.models"]) {
      const revoked = await rpc(running, method, { connectionId: "conn-local" })
      expect([revoked.status, revoked.code]).toEqual([409, "CONTROL_ACCOUNT_REVOKED"])
    }
  })

  test("selecting by connection takes the model and reasoning level and nothing else", async () => {
    const endpoint = mockEndpoint()
    const { running } = await start()
    await rpc(running, "account.create", localAccount(endpoint.baseUrl))
    await storeSecret(running, "conn-local", CANARY)
    const select = (params: Record<string, unknown>) => rpc(running, "provider.select", { connectionId: "conn-local", model: "chat-model", ...params })

    const overrides: Record<string, unknown> = {
      provider: "openai-compatible",
      endpoint: "https://relay.example.test/v1",
      protocol: "chat",
      headers: { "x-title": "fixture" },
      accountId: "conn-local",
      credentialEnvironment: SHELL_NAME,
      allowRemote: true,
      allowInsecureRemote: true,
      apiKey: "fixture",
      token: "fixture",
      secret: "fixture",
      credential: { kind: "environment", environment: SHELL_NAME },
    }
    for (const [key, value] of Object.entries(overrides)) {
      const refused = await select({ [key]: value })
      expect([key, refused.status, refused.code]).toEqual([key, 400, "CONTROL_INVALID_INPUT"])
    }
    for (const params of [{ model: undefined }, { model: "" }, { model: "x".repeat(257) }, { thinking: "maximum" }, { connectionId: "bad id!" }]) {
      const refused = await select(params)
      expect([refused.status, refused.code]).toEqual([400, "CONTROL_INVALID_INPUT"])
    }
    const missing = await select({ connectionId: "conn-nobody" })
    expect([missing.status, missing.code]).toEqual([404, "CONTROL_ACCOUNT_NOT_FOUND"])
    // None of the refusals switched anything or reached the endpoint.
    expect(endpoint.seen).toEqual([])
    expect((await rpc(running, "turn.enqueue", { message: "still the fixture" })).status).toBe(200)
    expect(endpoint.seen).toEqual([])

    const selected = await select({ thinking: "high" })
    expect(selected.status).toBe(200)
    expect(selected.body.result).toMatchObject({ backend: "native", model: { id: "chat-model" } })

    await rpc(running, "account.revoke", { accountId: "conn-local" })
    const revoked = await select({})
    expect([revoked.status, revoked.code]).toEqual([409, "CONTROL_ACCOUNT_REVOKED"])
  })

  test("an account keeps the provider, address and sign-in type its key was saved for", async () => {
    const endpoint = mockEndpoint()
    const other = mockEndpoint()
    const { running } = await start()
    await rpc(running, "account.create", localAccount(endpoint.baseUrl))
    await storeSecret(running, "conn-local", CANARY)

    const moves: Record<string, unknown>[] = [
      { baseUrl: other.baseUrl },
      { baseUrl: "https://relay.example.test/v1" },
      { provider: "custom-openai-responses" },
      { provider: "deepseek", baseUrl: undefined },
      { preset: "openrouter" },
      { authMode: "environment", environmentName: SHELL_NAME },
    ]
    for (const move of moves) {
      const refused = await rpc(running, "account.upsert", localAccount(endpoint.baseUrl, move))
      expect([JSON.stringify(move), refused.status, refused.code]).toEqual([JSON.stringify(move), 409, "CONTROL_ACCOUNT_ENDPOINT_LOCKED"])
    }
    const kept = await rpc(running, "account.get", { accountId: "conn-local" })
    expect(kept.body.result).toMatchObject({ status: "ready", reference: { provider: "custom-openai-chat", baseUrl: endpoint.baseUrl, authMode: "api-key" } })
    expect((await rpc(running, "connection.test", { connectionId: "conn-local" })).body.result).toMatchObject({ status: "ok" })
    expect(other.seen).toEqual([])

    // A new label, or another path on the same host, is still the same destination.
    const renamed = await rpc(running, "account.upsert", localAccount(`${endpoint.baseUrl}/team`, { label: "Relay (team)" }))
    expect(renamed.body.result).toMatchObject({ status: "ready", reference: { label: "Relay (team)", baseUrl: `${endpoint.baseUrl}/team` } })

    // Revoking deletes the key; only then may the id point somewhere else, and it starts without one.
    await rpc(running, "account.revoke", { accountId: "conn-local" })
    const moved = await rpc(running, "account.upsert", localAccount(other.baseUrl))
    expect(moved.body.result).toMatchObject({ status: "unconfigured", reference: { baseUrl: other.baseUrl } })
    expect((await rpc(running, "connection.test", { connectionId: "conn-local" })).body.result).toMatchObject({ status: "failed", code: "CREDENTIAL_MISSING" })
    expect(other.seen).toEqual([])
  })

  test("a named provider's key is never sent to another host", async () => {
    const endpoint = mockEndpoint()
    const { running } = await start()
    // The account store holds any record; the connection refuses to use one that points a preset elsewhere.
    expect((await rpc(running, "account.create", { accountId: "conn-foreign", provider: "deepseek", label: "DeepSeek", authMode: "api-key", baseUrl: "https://relay.example.test/v1" })).status).toBe(200)
    await storeSecret(running, "conn-foreign", CANARY)
    expect((await rpc(running, "account.create", { accountId: "conn-loopback", provider: "openrouter", label: "OpenRouter", authMode: "api-key", baseUrl: endpoint.baseUrl })).status).toBe(200)
    await storeSecret(running, "conn-loopback", CANARY)
    // A shell key one provider owns does not travel to a custom endpoint either.
    expect((await rpc(running, "account.create", { accountId: "conn-borrowed", provider: "custom-openai-chat", label: "Relay", authMode: "environment", environmentName: "OPENAI_API_KEY", baseUrl: endpoint.baseUrl })).status).toBe(200)

    for (const connectionId of ["conn-foreign", "conn-loopback", "conn-borrowed"]) {
      for (const [method, params] of [["connection.test", {}], ["connection.models", {}], ["provider.select", { model: "chat-model" }]] as const) {
        const refused = await rpc(running, method, { connectionId, ...params })
        expect([connectionId, method, refused.status, refused.code]).toEqual([connectionId, method, 400, "CONTROL_CONNECTION_ENDPOINT_DENIED"])
        expect(refused.text).not.toContain(CANARY)
      }
    }
    expect(endpoint.seen).toEqual([])

    expect((await rpc(running, "account.create", { accountId: "conn-unknown", provider: "example-cloud", label: "Example", authMode: "api-key" })).status).toBe(200)
    const unknown = await rpc(running, "connection.test", { connectionId: "conn-unknown" })
    expect([unknown.status, unknown.code]).toEqual([400, "CONTROL_CONNECTION_INVALID"])
    const noAddress = await rpc(running, "account.create", { accountId: "conn-bare", provider: "custom-openai-chat", label: "Bare", authMode: "api-key" })
    expect(noAddress.status).toBe(200)
    const bare = await rpc(running, "connection.models", { connectionId: "conn-bare" })
    expect([bare.status, bare.code]).toEqual([400, "CONTROL_CONNECTION_INVALID"])
  })

  test("the older provider methods never carry a stored key to a caller-named endpoint", async () => {
    const endpoint = mockEndpoint()
    const { running } = await start()
    await rpc(running, "account.create", localAccount(endpoint.baseUrl))
    await storeSecret(running, "conn-local", CANARY)

    const legacy = { provider: "openai-compatible", accountId: "conn-local", endpoint: endpoint.baseUrl }
    for (const [method, params] of [["provider.discover", legacy], ["model.discover", legacy], ["provider.select", { ...legacy, model: "chat-model" }]] as const) {
      const refused = await rpc(running, method, params)
      expect([method, refused.status, refused.code]).toEqual([method, 400, "CONTROL_INVALID_INPUT"])
      expect(refused.text).not.toContain(CANARY)
    }
    expect(endpoint.seen).toEqual([])

    // A key the caller owns (its own shell variable) still works there, and through a connection.
    process.env[SHELL_NAME] = SHELL_CANARY
    cleanup.push(() => { delete process.env[SHELL_NAME] })
    await rpc(running, "account.create", { accountId: "conn-shell", provider: "custom-openai-chat", label: "Relay (shell)", authMode: "environment", environmentName: SHELL_NAME, baseUrl: endpoint.baseUrl })
    const discovered = await rpc(running, "provider.discover", { provider: "openai-compatible", accountId: "conn-shell", endpoint: endpoint.baseUrl })
    expect(discovered.status).toBe(200)
    const checked = await rpc(running, "connection.test", { connectionId: "conn-shell" })
    expect(checked.body.result).toMatchObject({ status: "ok", code: "OK" })
    expect(endpoint.seen.map((request) => request.authorization)).toEqual([`Bearer ${SHELL_CANARY}`, `Bearer ${SHELL_CANARY}`])
    for (const reply of [discovered, checked]) expect(reply.text).not.toContain(SHELL_CANARY)
  })

  test("provider failures keep their code and get a fitting HTTP status", async () => {
    const endpoint = mockEndpoint()
    const { running } = await start()
    process.env[SHELL_NAME] = SHELL_CANARY
    cleanup.push(() => { delete process.env[SHELL_NAME] })
    const discover = (params: Record<string, unknown> = {}) => rpc(running, "provider.discover", { provider: "openai-compatible", endpoint: endpoint.baseUrl, credentialEnvironment: SHELL_NAME, maxRetries: 0, ...params })

    const expected: [number, number, string][] = [[401, 409, "PROVIDER_AUTH_FAILED"], [429, 429, "PROVIDER_RATE_LIMITED"], [504, 504, "PROVIDER_TIMEOUT"], [500, 502, "PROVIDER_FAILED"]]
    for (const [upstream, status, code] of expected) {
      endpoint.state.status = upstream
      const reply = await discover()
      expect([upstream, reply.status, reply.code]).toEqual([upstream, status, code])
      expect(reply.text).not.toContain(SHELL_CANARY)
    }
    const remote = await discover({ endpoint: "https://relay.example.test/v1" })
    expect([remote.status, remote.code]).toEqual([400, "PROVIDER_ENDPOINT_DENIED"])
    // Only a model key variable may be named, and a vendor's own key only goes to that vendor.
    for (const name of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "HOME"]) expect((await discover({ credentialEnvironment: name })).code).toBe("CONTROL_INVALID_INPUT")
    expect((await discover({ credentialEnvironment: "OPENAI_API_KEY" })).code).toBe("CONTROL_INVALID_INPUT")
    // An omitted endpoint is the family's own default, and the key is held to that address too.
    const defaulted = (provider: string, credentialEnvironment: string) => rpc(running, "provider.discover", { provider, credentialEnvironment, allowRemote: true, maxRetries: 0 })
    expect((await defaulted("xai", "OPENAI_API_KEY")).code).toBe("CONTROL_INVALID_INPUT")
    expect((await defaulted("openai", "XAI_API_KEY")).code).toBe("CONTROL_INVALID_INPUT")
    expect((await defaulted("openai-compatible", "ANTHROPIC_API_KEY")).code).toBe("CONTROL_INVALID_INPUT")
    expect((await rpc(running, "provider.discover", { provider: "openai", credentialEnvironment: "OPENAI_API_KEY", maxRetries: 0 })).code).toBe("PROVIDER_ENDPOINT_DENIED")
    expect((await rpc(running, "account.create", { accountId: "conn-env", provider: "openai", label: "Env", authMode: "environment", environmentName: "OPENAI_API_KEY" })).status).toBe(200)
    expect((await rpc(running, "provider.discover", { provider: "xai", accountId: "conn-env", allowRemote: true, maxRetries: 0 })).code).toBe("CONTROL_INVALID_INPUT")
    expect((await rpc(running, "provider.discover", { provider: "openai", accountId: "conn-env", maxRetries: 0 })).code).toBe("PROVIDER_ENDPOINT_DENIED")
    expect((await rpc(running, "account.create", { accountId: "conn-git", provider: "custom-openai-chat", label: "Git", authMode: "environment", environmentName: "GITHUB_TOKEN", baseUrl: endpoint.baseUrl })).status).toBe(400)
    const missing = await discover({ credentialEnvironment: "RUNRAIL_E2E_UNSET_API_KEY" })
    expect([missing.status, missing.code]).toEqual([409, "PROVIDER_CREDENTIALS"])
  })
})
