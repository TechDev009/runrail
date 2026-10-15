import { expect, test } from "bun:test"
import {
  AccountError,
  EnvironmentCredentialBroker,
  InMemoryAccountStore,
  InMemoryCredentialBroker,
  createAccountCredentialResolver,
  parseAccountRecord,
  redactAccount,
} from "../../src/accounts/index.ts"

const reference = {
  accountId: "account-openai-main",
  provider: "openai",
  label: "OpenAI main",
  authMode: "environment",
  scopes: ["models.read", "inference"],
  environmentName: "OPENAI_API_KEY",
  createdAt: 1,
  updatedAt: 2,
} as const

test("native accounts store metadata only and redact credential state", () => {
  const store = new InMemoryAccountStore()
  const record = parseAccountRecord({ reference, status: "ready", lastCheckedAt: 3 })
  store.put(record)
  expect(store.list("openai")).toEqual([record])
  expect(redactAccount(record)).toEqual(record)
  expect(JSON.stringify(redactAccount(record))).not.toContain("secret")
})

test("native credential brokers resolve ephemeral secrets and enforce scope", async () => {
  const environment = new EnvironmentCredentialBroker({ environment: { OPENAI_API_KEY: "secret-value" }, allowedEnvironmentNames: ["OPENAI_API_KEY"] })
  const lease = await environment.resolve(reference)
  expect(lease).toMatchObject({ accountId: reference.accountId, provider: "openai", secret: "secret-value" })
  await expect(environment.resolve({ ...reference, environmentName: "OTHER_KEY" })).rejects.toMatchObject({ code: "ACCOUNT_SCOPE_DENIED" })

  const memory = new InMemoryCredentialBroker()
  memory.set(reference.accountId, "memory-secret")
  await expect(memory.resolve(reference)).resolves.toMatchObject({ secret: "memory-secret" })
  await memory.revoke(reference)
  await expect(memory.resolve(reference)).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIALS_UNAVAILABLE" })
  memory.set(reference.accountId, "memory-secret")
  const store = new InMemoryAccountStore()
  store.put(parseAccountRecord({ reference: { ...reference, authMode: "caller", environmentName: undefined }, status: "ready" }))
  const resolver = createAccountCredentialResolver(store, memory)
  await expect(resolver.resolve({ kind: "caller", account: reference.accountId })).resolves.toBe("memory-secret")
})

test("native account parsing refuses malformed or secret-bearing references", () => {
  expect(() => parseAccountRecord({ reference: { ...reference, authMode: "unknown" }, status: "ready" })).toThrow(AccountError)
  expect(() => parseAccountRecord({ reference: { ...reference, apiKey: "raw-secret" }, status: "ready" })).toThrow(AccountError)
  expect(() => parseAccountRecord({ reference, status: "ready", updatedAt: 0 })).toThrow(AccountError)
})

test("an account endpoint needs TLS unless it is on this machine or the local network", () => {
  const withUrl = (baseUrl: string) => parseAccountRecord({ reference: { ...reference, authMode: "api-key", environmentName: undefined, baseUrl }, status: "unconfigured" })
  const accepted = [
    "https://api.openai.com/v1",
    "https://example.com:8443/v1?api-version=2024-10-21",
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
    "http://192.168.1.20:11434",
    "http://10.0.0.5:8000/v1",
    "http://172.20.0.2:8000/v1",
    "http://100.101.102.103:11434/v1",
    "http://[fd7a:115c:a1e0::1]:11434/v1",
    "http://studio.local:1234/v1",
    "http://ollama-box:11434/v1",
  ]
  for (const baseUrl of accepted) expect(withUrl(baseUrl).reference.baseUrl).toBe(baseUrl)
  const refused = [
    "http://api.openai.com/v1",
    "http://example.com/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1/v1",
    "http://100.128.0.1/v1",
    "http://169.254.169.254/latest",
    "http://[2001:db8::1]/v1",
    // Other spellings of a public address still resolve to a public address.
    "http://134744072/v1",
    "http://localhost.example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1#fragment",
    "ftp://example.com/v1",
    "file:///etc/passwd",
    "example.com/v1",
    "https://exa mple.com",
  ]
  for (const baseUrl of refused) expect(() => withUrl(baseUrl)).toThrow(AccountError)
})
