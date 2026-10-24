import { describe, expect, test } from "bun:test"
import { CUSTOM_PROVIDER_PRESETS, PROVIDER_PRESETS, ProviderError, getCustomProviderPreset, getProviderPreset, isProviderFamilyId, parseProviderAuthStyle, parseProviderQuirks, resolveProviderTarget } from "../../src/index.ts"
import { callerKeyVariableAllowedAt, keyVariableAllowedAt } from "../../src/providers/presets.ts"

const ID = /^[a-z][a-z0-9._:-]{0,63}$/
const ENVIRONMENT = /^[A-Z][A-Z0-9_]{0,127}$/
const PROTOCOLS = ["openai-responses", "openai-chat", "anthropic-messages"]
const OLD_FIELD = ["ant-ling", "deepseek", "mistral", "moonshotai", "moonshotai-cn", "nvidia", "togetherai", "zai", "zai-coding-plan", "zhipuai", "zhipuai-coding-plan"]

function code(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ProviderError ? error.code : "not a provider error"
  }
  return undefined
}

describe("provider preset table", () => {
  test("every row is a well-formed, fixed https destination", () => {
    expect(PROTOCOLS.map((protocol) => PROVIDER_PRESETS.filter((preset) => preset.protocol === protocol).length)).toEqual([3, 32, 6])
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.id).toMatch(ID)
      expect(preset.name.length).toBeGreaterThan(0)
      expect(preset.name.length).toBeLessThanOrEqual(64)
      const url = new URL(preset.baseUrl)
      expect(url.protocol).toBe("https:")
      expect(`${url.username}${url.password}${url.search}${url.hash}`).toBe("")
      expect(preset.baseUrl.endsWith("/")).toBe(false)
      expect(PROTOCOLS).toContain(preset.protocol)
      expect(["bearer", "x-api-key"]).toContain(preset.authStyle)
      expect(["list", "none"]).toContain(preset.models)
      if (preset.environment !== undefined) expect(preset.environment).toMatch(ENVIRONMENT)
      // A plan address is reached by signing in, so no shell variable ever points at it.
      if (preset.signInOnly === true) expect(preset.environment).toBeUndefined()
      // OpenAI protocols have one way to carry the key.
      if (preset.protocol !== "anthropic-messages") expect(preset.authStyle).toBe("bearer")
      expect(parseProviderQuirks(preset.quirks)).toEqual(preset.quirks)
      expect(Object.isFrozen(preset)).toBe(true)
      expect(Object.isFrozen(preset.quirks)).toBe(true)
      expect(getProviderPreset(preset.id)).toBe(preset)
    }
  })

  test("ids are unique across named and custom presets", () => {
    const ids = [...PROVIDER_PRESETS, ...CUSTOM_PROVIDER_PRESETS].map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(CUSTOM_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual(["custom-openai-chat", "custom-openai-responses", "custom-anthropic", "custom-anthropic-bearer"])
    for (const preset of CUSTOM_PROVIDER_PRESETS) {
      expect(preset.id).toMatch(ID)
      expect(getCustomProviderPreset(preset.id)).toBe(preset)
      expect(getProviderPreset(preset.id)).toBeUndefined()
      expect("baseUrl" in preset).toBe(false)
    }
  })

  test("chat rows take the newer max tokens field unless the row opts out", () => {
    const chat = PROVIDER_PRESETS.filter((preset) => preset.protocol === "openai-chat")
    expect(chat.filter((preset) => preset.quirks.maxTokensField === "max_tokens").map((preset) => preset.id).sort()).toEqual(OLD_FIELD)
    for (const preset of chat) if (!OLD_FIELD.includes(preset.id)) expect(preset.quirks.maxTokensField).toBe("max_completion_tokens")
    for (const preset of PROVIDER_PRESETS) if (preset.protocol !== "openai-chat") expect(preset.quirks.maxTokensField).toBeUndefined()
    expect(getCustomProviderPreset("custom-openai-chat")?.quirks.maxTokensField).toBe("max_tokens")
  })

  test("pins the rows whose wire behaviour differs", () => {
    expect(getProviderPreset("openai")).toMatchObject({ protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", environment: "OPENAI_API_KEY" })
    expect(getProviderPreset("anthropic")).toMatchObject({ protocol: "anthropic-messages", authStyle: "x-api-key", baseUrl: "https://api.anthropic.com/v1" })
    expect(getProviderPreset("deepseek")?.quirks).toEqual({ maxTokensField: "max_tokens", thinking: "thinking-type", reasoningReplay: true })
    expect(getProviderPreset("mistral")?.quirks).toEqual({ maxTokensField: "max_tokens", thinking: "none", streamOptions: false })
    expect(getProviderPreset("openrouter")?.quirks).toEqual({ maxTokensField: "max_completion_tokens", thinking: "reasoning-object" })
    expect(getProviderPreset("zai")?.quirks).toEqual({ maxTokensField: "max_tokens", thinking: "zhipu" })
    expect(getProviderPreset("togetherai")?.quirks).toEqual({ maxTokensField: "max_tokens", thinking: "together" })
    expect(getProviderPreset("alibaba-cn")?.quirks).toEqual({ maxTokensField: "max_completion_tokens", thinking: "qwen" })
    expect(getProviderPreset("xai")?.quirks).toEqual({ maxTokensField: "max_completion_tokens", thinking: "none" })
    expect(PROVIDER_PRESETS.filter((preset) => preset.models === "none").map((preset) => preset.id)).toEqual(["minimax", "minimax-cn"])
  })

  test("refuses quirks and auth styles the adapters do not understand", () => {
    expect(parseProviderQuirks(undefined)).toEqual({})
    expect(code(() => parseProviderQuirks({ temperature: 1 }))).toBe("PROVIDER_INVALID")
    expect(code(() => parseProviderQuirks({ maxTokensField: "max_output_tokens" }))).toBe("PROVIDER_INVALID")
    expect(code(() => parseProviderQuirks({ thinking: "budget" }))).toBe("PROVIDER_INVALID")
    expect(code(() => parseProviderQuirks({ reasoningReplay: "yes" }))).toBe("PROVIDER_INVALID")
    expect(code(() => parseProviderQuirks({ streamOptions: 0 }))).toBe("PROVIDER_INVALID")
    expect(code(() => parseProviderQuirks([]))).toBe("PROVIDER_INVALID")
    expect(parseProviderAuthStyle(undefined)).toBeUndefined()
    expect(parseProviderAuthStyle("x-api-key")).toBe("x-api-key")
    expect(code(() => parseProviderAuthStyle("basic"))).toBe("PROVIDER_INVALID")
  })
})

describe("provider target resolution", () => {
  test("the four families keep their own defaults", () => {
    expect(isProviderFamilyId("openai")).toBe(true)
    expect(isProviderFamilyId("deepseek")).toBe(false)
    expect(resolveProviderTarget({ provider: "openai" })).toEqual({ endpoint: "https://api.openai.com/v1", protocol: "openai-chat", authStyle: "bearer", quirks: { maxTokensField: "max_completion_tokens", thinking: "effort" }, name: "OpenAI" })
    expect(resolveProviderTarget({ provider: "openai", endpoint: "http://127.0.0.1:8080/v1" }).quirks).toEqual({ maxTokensField: "max_tokens", thinking: "effort" })
    expect(resolveProviderTarget({ provider: "openai-compatible", endpoint: "http://127.0.0.1:8080/v1" })).toMatchObject({ protocol: "openai-chat", name: "OpenAI-compatible", quirks: { maxTokensField: "max_tokens" } })
    expect(resolveProviderTarget({ provider: "xai" })).toMatchObject({ endpoint: "https://api.x.ai/v1", protocol: "openai-chat", name: "xAI / Grok" })
    expect(resolveProviderTarget({ provider: "openai", protocol: "responses" }).protocol).toBe("openai-responses")
  })

  test("the anthropic family keeps its address as written; presets and custom endpoints get a version", () => {
    expect(resolveProviderTarget({ provider: "anthropic" }).endpoint).toBe("https://api.anthropic.com/v1")
    expect(resolveProviderTarget({ provider: "anthropic", endpoint: "http://127.0.0.1:9000" }).endpoint).toBe("http://127.0.0.1:9000")
    expect(resolveProviderTarget({ provider: "custom-anthropic", endpoint: "http://127.0.0.1:9000" }).endpoint).toBe("http://127.0.0.1:9000/v1")
    expect(resolveProviderTarget({ provider: "custom-anthropic", endpoint: "http://127.0.0.1:9000/relay/" }).endpoint).toBe("http://127.0.0.1:9000/relay/v1")
    expect(resolveProviderTarget({ provider: "custom-anthropic", endpoint: "http://127.0.0.1:9000/relay/v1" }).endpoint).toBe("http://127.0.0.1:9000/relay/v1")
    expect(resolveProviderTarget({ provider: "minimax", endpoint: "https://api.minimax.io/anthropic" }).endpoint).toBe("https://api.minimax.io/anthropic/v1")
    expect(resolveProviderTarget({ provider: "custom-openai-chat", endpoint: "http://127.0.0.1:9000" }).endpoint).toBe("http://127.0.0.1:9000")
  })

  test("a preset id resolves from its row and caller quirks merge over it", () => {
    expect(resolveProviderTarget({ provider: "deepseek" })).toEqual({ endpoint: "https://api.deepseek.com", protocol: "openai-chat", authStyle: "bearer", quirks: { maxTokensField: "max_tokens", thinking: "thinking-type", reasoningReplay: true }, name: "DeepSeek" })
    expect(resolveProviderTarget({ provider: "deepseek", quirks: { reasoningReplay: false }, displayName: "Relay" })).toMatchObject({ name: "Relay", quirks: { maxTokensField: "max_tokens", thinking: "thinking-type", reasoningReplay: false } })
    expect(resolveProviderTarget({ provider: "kimi-for-coding" })).toMatchObject({ protocol: "anthropic-messages", authStyle: "x-api-key", endpoint: "https://api.kimi.com/coding/v1" })
    expect(resolveProviderTarget({ provider: "custom-anthropic-bearer", endpoint: "http://127.0.0.1:9000/v1" })).toMatchObject({ protocol: "anthropic-messages", authStyle: "bearer" })
  })

  test("an id nobody knows must name its endpoint and protocol", () => {
    expect(code(() => resolveProviderTarget({ provider: "example-org" }))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveProviderTarget({ provider: "example-org", endpoint: "http://127.0.0.1:9000/v1" }))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveProviderTarget({ provider: "custom-openai-chat" }))).toBe("PROVIDER_INVALID")
    expect(resolveProviderTarget({ provider: "example-org", endpoint: "http://127.0.0.1:9000/v1", protocol: "chat" })).toEqual({ endpoint: "http://127.0.0.1:9000/v1", protocol: "openai-chat", authStyle: "bearer", quirks: { maxTokensField: "max_tokens" }, name: "example-org" })
    expect(resolveProviderTarget({ provider: "example-org", endpoint: "http://127.0.0.1:9000", protocol: "messages" })).toMatchObject({ endpoint: "http://127.0.0.1:9000/v1", authStyle: "x-api-key" })
  })

  test("refuses malformed input and a non-Bearer key on an OpenAI protocol", () => {
    expect(code(() => resolveProviderTarget({ provider: "Open AI" }))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveProviderTarget({ provider: "openai", endpoint: "" }))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveProviderTarget({ provider: "openai", protocol: "graphql" as never }))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveProviderTarget({ provider: "openai", displayName: "two\nlines" }))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveProviderTarget({ provider: "openai", authStyle: "x-api-key" }))).toBe("PROVIDER_INVALID")
    expect(code(() => resolveProviderTarget({ provider: "openrouter", authStyle: "x-api-key" }))).toBe("PROVIDER_INVALID")
    // Switching a Messages row to an OpenAI protocol switches the key header with it.
    expect(resolveProviderTarget({ provider: "anthropic", protocol: "chat" }).authStyle).toBe("bearer")
  })
})

describe("key variables a control caller names", () => {
  test("one no preset owns goes only to this machine; a vendor's own goes only to that vendor", () => {
    expect(callerKeyVariableAllowedAt("STRIPE_API_KEY", "http://127.0.0.1:9000/v1")).toBe(true)
    expect(callerKeyVariableAllowedAt("STRIPE_API_KEY", "http://localhost:9000/v1")).toBe(true)
    expect(callerKeyVariableAllowedAt("STRIPE_API_KEY", "http://[::1]:9000/v1")).toBe(true)
    for (const endpoint of ["https://relay.example.test/v1", "https://api.openai.com/v1", "http://127.example.test/v1", "http://10.0.0.2:9000/v1", "not a url"]) expect([endpoint, callerKeyVariableAllowedAt("STRIPE_API_KEY", endpoint)]).toEqual([endpoint, false])
    expect(callerKeyVariableAllowedAt("OPENAI_API_KEY", "https://api.openai.com/v1")).toBe(true)
    expect(callerKeyVariableAllowedAt("OPENAI_API_KEY", "http://127.0.0.1:9000/v1")).toBe(false)
    // The general rule still lets an unowned variable go anywhere; only control callers are held to this machine.
    expect(keyVariableAllowedAt("STRIPE_API_KEY", "https://relay.example.test/v1")).toBe(true)
  })
})
