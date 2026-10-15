import { expect, test } from "bun:test"
import { createHttpConnector } from "../../src/connectors/http.ts"
import { createConnectorRegistry } from "../../src/connectors/registry.ts"
import { SandboxRegistry, type SandboxDescriptor } from "../../src/sandbox/index.ts"
import { InMemoryAccountStore } from "../../src/accounts/types.ts"
import { CredentialStoreError } from "../../src/auth/broker.ts"
import { runAuthDoctor } from "../../src/connection-check.ts"

const context = (signal = new AbortController().signal) => ({ cwd: process.cwd(), signal, allowedCapabilities: ["connector.read", "connector.write"], approve: () => true })

test("connector cancellation during credential resolution sends no write", async () => {
  const controller = new AbortController()
  let writes = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { writes++; return Response.json({ ok: true }) } })
  try {
    const connector = createHttpConnector({
      descriptor: { id: "fixture", version: "1", capabilities: ["connector.write"] }, endpoint: server.url.href,
      credential: { reference: { kind: "caller", account: "fixture" }, resolver: { resolve: async () => { controller.abort(); return "fake" } } },
      actions: [{ name: "write", description: "fixture write", kind: "write", capabilities: ["connector.write"], method: "POST", path: "write" }],
    })
    await expect(createConnectorRegistry([connector]).invoke("fixture", "write", {}, context(controller.signal))).rejects.toMatchObject({ code: "CONNECTOR_CANCELLED" })
    expect(writes).toBe(0)
  } finally { await server.stop(true) }
})

test("connector retry and final status errors cancel every response body", async () => {
  const original = globalThis.fetch
  let cancelled = 0
  let sends = 0
  globalThis.fetch = Object.assign(async () => {
    sends++
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++ } }), { status: 503 })
  }, { preconnect: original.preconnect })
  try {
    const connector = createHttpConnector({ descriptor: { id: "fixture", version: "1", capabilities: ["connector.read"] }, endpoint: "http://127.0.0.1:1", maxRetries: 2, retryDelayMs: 0,
      actions: [{ name: "read", description: "fixture read", kind: "read", capabilities: ["connector.read"], path: "read", retryable: true }] })
    await expect(createConnectorRegistry([connector]).invoke("fixture", "read", {}, context())).rejects.toMatchObject({ code: "CONNECTOR_FAILED" })
    expect(sends).toBe(3)
    expect(cancelled).toBe(3)
  } finally { globalThis.fetch = original }
})

test("sandbox class methods retain their receiver and cleanup", async () => {
  class Executor {
    readonly descriptor: SandboxDescriptor = { id: "fixture", name: "Fixture", version: "1", kind: "caller", isolated: true, capabilities: ["process.exec"] }
    #closed = false
    run() { return { status: this.#closed ? 1 : 0, truncated: false, timedOut: false, cancelled: false } }
    close() { this.#closed = true }
  }
  const registry = new SandboxRegistry([new Executor()])
  const executor = registry.select({ requireIsolation: true })
  const input = { argv: ["fixture"], cwd: process.cwd(), signal: new AbortController().signal }
  expect((await executor.run(input)).status).toBe(0)
  await registry.close()
  expect((await executor.run(input)).status).toBe(1)
})

test("auth doctor distinguishes vault failure from invalid account", async () => {
  const accounts = new InMemoryAccountStore()
  accounts.put({ reference: { accountId: "fixture", provider: "custom-openai-chat", preset: "custom-openai-chat", label: "Fixture", authMode: "api-key", scopes: [], baseUrl: "http://127.0.0.1:1", createdAt: 1, updatedAt: 1 }, status: "ready" })
  const output: string[] = []
  const result = await runAuthDoctor({ connectionId: "fixture", json: true }, { accounts, credentialResolver: { resolve: async () => { throw new CredentialStoreError("VAULT_TIMEOUT") } }, out: (value) => output.push(value), note: (value) => output.push(value) })
  expect(result).toBe(1)
  expect(JSON.parse(output[0]!)).toMatchObject({ status: "failed", code: "ACCOUNT_CREDENTIALS_UNAVAILABLE" })
})
