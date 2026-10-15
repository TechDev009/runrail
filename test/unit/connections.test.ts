import { describe, expect, test } from "bun:test"
import { AccountError, ProviderError, RUNRAIL_USER_AGENT, connectionDestination, connectionPresetId, createCallerCredentialResolver, detectShellConnections, parseAccountRecord, resolveConnection } from "../../src/index.ts"
import type { AccountRecord } from "../../src/index.ts"

const resolver = createCallerCredentialResolver(() => "fixture-secret")

function account(reference: Record<string, unknown>, status = "ready"): AccountRecord {
  return parseAccountRecord({ reference: { accountId: "conn-1", provider: "openrouter", label: "Work", authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1, ...reference }, status })
}

function code(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ProviderError || error instanceof AccountError ? error.code : "unexpected error"
  }
  return undefined
}

describe("connection resolution", () => {
  test("a named preset resolves to its own fixed address, pinned to one host", () => {
    const connection = resolveConnection(account({ preset: "deepseek", provider: "deepseek" }), resolver)
    expect(connection).toMatchObject({ connectionId: "conn-1", presetId: "deepseek", name: "DeepSeek", protocol: "openai-chat", endpoint: "https://api.deepseek.com", modelList: "list", custom: false })
    expect(connection.options).toMatchObject({
      provider: "deepseek",
      displayName: "DeepSeek",
      endpoint: "https://api.deepseek.com",
      protocol: "chat",
      authStyle: "bearer",
      quirks: { maxTokensField: "max_tokens", thinking: "thinking-type", reasoningReplay: true },
      allowRemote: true,
      allowedHosts: ["api.deepseek.com"],
      headers: { "user-agent": RUNRAIL_USER_AGENT },
      credential: { kind: "caller", account: "conn-1" },
    })
    expect(connection.options.allowInsecureRemote).toBeUndefined()
    expect(connection.options.credentialResolver).toBe(resolver)
    expect(resolveConnection(account({ provider: "openai" }), resolver).options).toMatchObject({ protocol: "responses", endpoint: "https://api.openai.com/v1", allowedHosts: ["api.openai.com"] })
    expect(resolveConnection(account({ provider: "minimax" }), resolver)).toMatchObject({ protocol: "anthropic-messages", modelList: "none", options: { protocol: "messages", authStyle: "x-api-key" } })
  })

  test("a named preset takes another address only on its own host over https", () => {
    expect(resolveConnection(account({ provider: "deepseek", baseUrl: "https://api.deepseek.com/beta" }), resolver).options).toMatchObject({ endpoint: "https://api.deepseek.com/beta", allowedHosts: ["api.deepseek.com"] })
    expect(code(() => resolveConnection(account({ provider: "deepseek", baseUrl: "https://relay.example.test/v1" }), resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
    expect(code(() => resolveConnection(account({ provider: "deepseek", baseUrl: "https://api.deepseek.com.example.test/v1" }), resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
    expect(code(() => resolveConnection(account({ provider: "deepseek", baseUrl: "https://api.deepseek.com:8443/v1" }), resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
    expect(code(() => resolveConnection(account({ provider: "deepseek", baseUrl: "http://127.0.0.1:8080/v1" }), resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
  })

  test("a custom preset needs an address and allows plain http only near this machine", () => {
    const local = resolveConnection(account({ provider: "openai-compatible", preset: "custom-openai-chat", baseUrl: "http://127.0.0.1:11434/v1" }), resolver)
    expect(local).toMatchObject({ presetId: "custom-openai-chat", custom: true, modelList: "list", endpoint: "http://127.0.0.1:11434/v1" })
    expect(local.options).toMatchObject({ allowRemote: true, allowInsecureRemote: true, allowedHosts: ["127.0.0.1"], quirks: { maxTokensField: "max_tokens" } })
    const remote = resolveConnection(account({ provider: "custom-anthropic-bearer", baseUrl: "https://relay.example.test/anthropic" }), resolver)
    expect(remote.options).toMatchObject({ protocol: "messages", authStyle: "bearer", allowedHosts: ["relay.example.test"] })
    expect(remote.options.allowInsecureRemote).toBeUndefined()
    expect(code(() => resolveConnection(account({ provider: "custom-openai-chat" }), resolver))).toBe("PROVIDER_INVALID")
    // The account parser already refuses plain http to a remote host; the resolver checks again for a record built by hand.
    expect(code(() => account({ provider: "custom-openai-chat", baseUrl: "http://relay.example.test/v1" }))).toBe("ACCOUNT_INVALID")
    const handBuilt: AccountRecord = { status: "ready", reference: { ...account({ provider: "custom-openai-chat", baseUrl: "https://relay.example.test/v1" }).reference, baseUrl: "http://relay.example.test/v1" } }
    expect(code(() => resolveConnection(handBuilt, resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
  })

  test("refuses a revoked account and a preset nobody knows", () => {
    expect(code(() => resolveConnection(account({ provider: "deepseek" }, "revoked"), resolver))).toBe("ACCOUNT_REVOKED")
    expect(code(() => resolveConnection(account({ provider: "example-org" }), resolver))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveConnection(account({ provider: "openrouter", preset: "example-org" }), resolver))).toBe("PROVIDER_INVALID")
  })

  test("a shell key a provider owns is only sent to that provider", () => {
    const shell = { authMode: "environment", environmentName: "OPENAI_API_KEY" }
    expect(resolveConnection(account({ provider: "openai", ...shell }), resolver).presetId).toBe("openai")
    expect(code(() => resolveConnection(account({ provider: "custom-openai-chat", baseUrl: "https://relay.example.test/v1", ...shell }), resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
    expect(code(() => resolveConnection(account({ provider: "openrouter", ...shell }), resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
    expect(code(() => resolveConnection(account({ provider: "openrouter", authMode: "api-key-reference", environmentName: "OPENAI_API_KEY" }), resolver))).toBe("PROVIDER_ENDPOINT_DENIED")
    // A variable two rows share goes to either; one no row claims goes anywhere its account points.
    expect(resolveConnection(account({ provider: "zai-coding-plan", authMode: "environment", environmentName: "ZAI_API_KEY" }), resolver).presetId).toBe("zai-coding-plan")
    expect(resolveConnection(account({ provider: "custom-openai-chat", baseUrl: "https://relay.example.test/v1", authMode: "environment", environmentName: "RELAY_API_KEY" }), resolver).custom).toBe(true)
  })

  test("drops a client identity from account headers and names Runrail", () => {
    const record = account({ provider: "openrouter", headers: { "x-title": "fixture" } })
    const forged: AccountRecord = { ...record, reference: { ...record.reference, headers: { "x-title": "fixture", "User-Agent": "other-editor/1.0", Originator: "other-cli" } } }
    expect(resolveConnection(forged, resolver).options.headers).toEqual({ "x-title": "fixture", "user-agent": RUNRAIL_USER_AGENT })
    expect(code(() => account({ provider: "openrouter", headers: { "user-agent": "other-editor/1.0" } }))).toBe("ACCOUNT_INVALID")
    expect(code(() => account({ provider: "openrouter", headers: { Originator: "other-cli" } }))).toBe("ACCOUNT_INVALID")
  })
})

describe("connection identity and detection", () => {
  test("names the preset an account connects through", () => {
    expect(connectionPresetId(account({ provider: "openrouter" }).reference)).toBe("openrouter")
    expect(connectionPresetId(account({ provider: "openai-compatible", preset: "deepseek" }).reference)).toBe("deepseek")
    expect(connectionPresetId(account({ provider: "openai-compatible" }).reference)).toBe("custom-openai-chat")
  })

  test("a destination is the preset plus the host the key goes to", () => {
    expect(connectionDestination(account({ provider: "deepseek" }).reference)).toBe("deepseek api.deepseek.com")
    expect(connectionDestination(account({ provider: "deepseek", baseUrl: "https://api.deepseek.com/beta" }).reference)).toBe("deepseek api.deepseek.com")
    expect(connectionDestination(account({ provider: "custom-openai-chat", baseUrl: "http://127.0.0.1:11434/v1" }).reference)).toBe("custom-openai-chat 127.0.0.1:11434")
    expect(connectionDestination(account({ provider: "custom-openai-chat", baseUrl: "http://127.0.0.1:11435/v1" }).reference)).not.toBe("custom-openai-chat 127.0.0.1:11434")
    expect(connectionDestination(account({ provider: "custom-openai-chat" }).reference)).toBe("custom-openai-chat ")
  })

  test("detects shell keys by name only", () => {
    const detected = detectShellConnections({ OPENROUTER_API_KEY: "value-one", ZAI_API_KEY: "value-two", DEEPSEEK_API_KEY: "", UNRELATED: "value-three" })
    expect(detected).toEqual([
      { presetId: "openrouter", name: "OpenRouter", environmentName: "OPENROUTER_API_KEY" },
      { presetId: "zai", name: "Z.AI", environmentName: "ZAI_API_KEY" },
      { presetId: "zai-coding-plan", name: "Z.AI Coding Plan", environmentName: "ZAI_API_KEY" },
    ])
    expect(JSON.stringify(detected)).not.toContain("value-")
    expect(detectShellConnections({})).toEqual([])
  })
})
