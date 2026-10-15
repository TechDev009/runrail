import { describe, expect, test } from "bun:test"
import { createCallerCredentialResolver, createEnvironmentCredentialResolver, createOpenAIModelAdapter, parseCredentialReference, ProviderError } from "../../src/index.ts"

describe("provider credential boundaries", () => {
  test("parses environment and caller references without secret material", () => {
    const environment = parseCredentialReference("RUNRAIL_FIXTURE_KEY")
    const caller = parseCredentialReference({ kind: "caller", account: "desktop-main" })
    expect(environment).toEqual({ kind: "environment", environment: "RUNRAIL_FIXTURE_KEY" })
    expect(caller).toEqual({ kind: "caller", account: "desktop-main" })
    expect(JSON.stringify(environment)).not.toContain("secret")
    expect(JSON.stringify(caller)).not.toContain("secret")
    expect(() => parseCredentialReference("bad-name")).toThrow(ProviderError)
  })

  test("resolves secrets transiently and rejects missing or wrong references", async () => {
    const environment = createEnvironmentCredentialResolver({ RUNRAIL_FIXTURE_KEY: "fixture-secret" })
    expect(environment.resolve({ kind: "environment", environment: "RUNRAIL_FIXTURE_KEY" })).toBe("fixture-secret")
    expect(() => environment.resolve({ kind: "environment", environment: "MISSING_KEY" })).toThrow()
    const caller = createCallerCredentialResolver((reference) => reference.account === "desktop-main" ? "caller-secret" : "")
    await expect(caller.resolve({ kind: "caller", account: "desktop-main" })).resolves.toBe("caller-secret")
    expect(() => caller.resolve({ kind: "environment", environment: "RUNRAIL_FIXTURE_KEY" })).toThrow()
  })

  test("rejects raw API keys and secret-bearing error text", () => {
    expect(() => createOpenAIModelAdapter({ provider: "openai", model: "fixture", credential: { kind: "environment", environment: "KEY" }, apiKey: "do-not-accept" } as never)).toThrow(ProviderError)
    const error = new ProviderError("PROVIDER_FAILED", "authorization: Bearer super-secret-value")
    expect(error.message).not.toContain("super-secret-value")
    expect(error.message).not.toContain("Bearer")
  })
})
