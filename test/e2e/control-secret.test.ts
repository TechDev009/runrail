import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { FileCredentialVault, MemoryCredentialVault, VaultError, type CredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>
interface Reply {
  readonly status: number
  readonly code: string | null
  readonly text: string
  readonly body: { readonly ok: boolean; readonly result?: Record<string, unknown>; readonly error?: { readonly code: string; readonly message?: string } | string }
}

// Distinct from every other string in the test so a leak is unambiguous.
const CANARY = "sk-canary-7f3a9c2e51b84d06a1f2"

async function send(running: Running, path: "/rpc" | "/secret", payload: unknown, init: { readonly token?: string | null; readonly method?: string } = {}): Promise<Reply> {
  const token = init.token === undefined ? running.handle.token : init.token
  const method = init.method ?? "POST"
  const response = await fetch(`${running.handle.url}${path}`, {
    method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
  })
  const text = await response.text()
  return { status: response.status, code: response.headers.get("x-runrail-error-code"), text, body: JSON.parse(text) as Reply["body"] }
}

const rpc = (running: Running, method: string, params: Record<string, unknown>): Promise<Reply> => send(running, "/rpc", { method, params })
const secret = (running: Running, payload: unknown): Promise<Reply> => send(running, "/secret", payload)

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

const model = { complete: () => ({ type: "text" as const, text: "ok" }) }

describe("control secret entry", () => {
  test("a pasted key reaches the vault and nothing else, survives a restart, and is removed on revoke", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-secret-cwd-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-secret-state-"))
    const accountsDir = await mkdtemp(join("/tmp", "runrail-secret-accounts-"))
    const vaultDir = join(accountsDir, "vault")
    let first: Running | undefined
    let second: Running | undefined
    try {
      const options = { cwd, backend: "native" as const, sessionDir, sessionId: "secret-session", loadExtensions: false, model, nativeAccountsDir: accountsDir }
      first = await startRunrailControlRpcServer({ ...options, nativeCredentialVault: new FileCredentialVault({ root: vaultDir }) })
      const health = await (await fetch(`${first.handle.url}/health`)).json() as { capabilities: string[]; capabilityStatus: Record<string, string> }
      expect(health.capabilities).toContain("account.secrets")
      expect(health.capabilityStatus["account.secrets"]).toBe("available")

      // A client cannot declare a vault-backed account ready; only a stored credential does.
      const created = await rpc(first, "account.create", {
        accountId: "account-openrouter",
        provider: "openrouter",
        label: "OpenRouter",
        authMode: "api-key",
        preset: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        headers: { "HTTP-Referer": "https://runrail.dev", "X-Title": "Runrail" },
        status: "ready",
      })
      expect(created.status).toBe(200)
      expect(created.body.result).toMatchObject({
        status: "unconfigured",
        reference: { authMode: "api-key", preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", headers: { "http-referer": "https://runrail.dev", "x-title": "Runrail" } },
      })
      const before = await rpc(first, "account.resolve", { accountId: "account-openrouter" })
      expect(before.status).toBe(409)
      expect(before.code).toBe("CONTROL_ACCOUNT_CREDENTIALS_UNAVAILABLE")

      // Pasted with the usual stray whitespace.
      const stored = await secret(first, { accountId: "account-openrouter", secret: `  ${CANARY}\n` })
      expect(stored.status).toBe(200)
      expect(stored.body.result).toMatchObject({ status: "ready", reference: { accountId: "account-openrouter" } })
      expect(stored.text).not.toContain(CANARY)

      const resolved = await rpc(first, "account.resolve", { accountId: "account-openrouter" })
      expect(resolved.body.result).toMatchObject({ accountId: "account-openrouter", resolved: true })
      // Editing the label keeps the engine-owned status.
      const renamed = await rpc(first, "account.upsert", { accountId: "account-openrouter", provider: "openrouter", label: "OpenRouter (work)", authMode: "api-key", preset: "openrouter" })
      expect(renamed.body.result).toMatchObject({ status: "ready", reference: { label: "OpenRouter (work)" } })
      const replies = [resolved, renamed, await rpc(first, "account.get", { accountId: "account-openrouter" }), await rpc(first, "account.list", {}), await rpc(first, "control.describe", {})]
      for (const reply of replies) expect(reply.text).not.toContain(CANARY)
      expect(await eventStreamText(first)).not.toContain(CANARY)

      // On disk the key exists in the vault directory and nowhere else.
      const holders = [...(await filesContaining(sessionDir, CANARY)), ...(await filesContaining(accountsDir, CANARY)), ...(await filesContaining(cwd, CANARY))]
      expect(holders).toHaveLength(1)
      expect(holders[0]!.startsWith(`${vaultDir}/`)).toBe(true)

      await first.handle.stop()
      first = undefined
      second = await startRunrailControlRpcServer({ ...options, sessionId: "secret-session-2", nativeCredentialVault: new FileCredentialVault({ root: vaultDir }) })
      expect((await rpc(second, "account.get", { accountId: "account-openrouter" })).body.result).toMatchObject({ status: "ready" })
      expect((await rpc(second, "account.resolve", { accountId: "account-openrouter" })).body.result).toMatchObject({ resolved: true })

      const revoked = await rpc(second, "account.revoke", { accountId: "account-openrouter" })
      expect(revoked.body.result).toMatchObject({ status: "revoked" })
      expect(await filesContaining(accountsDir, CANARY)).toEqual([])
      const afterRevoke = await secret(second, { accountId: "account-openrouter", secret: CANARY })
      expect(afterRevoke.status).toBe(409)
      expect(afterRevoke.code).toBe("CONTROL_ACCOUNT_REVOKED")
      expect(await filesContaining(accountsDir, CANARY)).toEqual([])
    } finally {
      await first?.handle.stop()
      await second?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
      await rm(accountsDir, { recursive: true, force: true })
    }
  })

  test("rejects every malformed or unauthorized secret request without echoing the key", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-secret-cwd-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-secret-state-"))
    const vault = new MemoryCredentialVault()
    let running: Running | undefined
    try {
      running = await startRunrailControlRpcServer({ cwd, backend: "native", sessionDir, sessionId: "secret-reject", loadExtensions: false, model, nativeCredentialVault: vault })
      await rpc(running, "account.create", { accountId: "account-key", provider: "openai", label: "Key", authMode: "api-key" })
      await rpc(running, "account.create", { accountId: "account-env", provider: "openai", label: "Env", authMode: "environment", environmentName: "OPENAI_API_KEY", status: "ready" })
      await rpc(running, "account.create", { accountId: "account-oauth", provider: "openai", label: "Sign-in", authMode: "oauth" })

      const cases: readonly { readonly name: string; readonly reply: Promise<Reply>; readonly status: number; readonly code?: string }[] = [
        { name: "no token", reply: send(running, "/secret", { accountId: "account-key", secret: CANARY }, { token: null }), status: 401 },
        { name: "wrong token", reply: send(running, "/secret", { accountId: "account-key", secret: CANARY }, { token: "not-the-token" }), status: 401 },
        { name: "GET", reply: send(running, "/secret", undefined, { method: "GET" }), status: 405 },
        { name: "not JSON", reply: secret(running, `{"accountId":"account-key","secret":"${CANARY}"`), status: 400, code: "CONTROL_INVALID_JSON" },
        { name: "array body", reply: secret(running, [CANARY]), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "unknown field", reply: secret(running, { accountId: "account-key", secret: CANARY, label: "x" }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "missing secret", reply: secret(running, { accountId: "account-key" }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "blank secret", reply: secret(running, { accountId: "account-key", secret: "  \n" }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "non-string secret", reply: secret(running, { accountId: "account-key", secret: { value: CANARY } }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "two lines", reply: secret(running, { accountId: "account-key", secret: `${CANARY}\nsecond` }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "too long", reply: secret(running, { accountId: "account-key", secret: `${CANARY}${"x".repeat(17 * 1024)}` }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "body over the limit", reply: secret(running, { accountId: "account-key", secret: `${CANARY}${"x".repeat(40 * 1024)}` }), status: 413, code: "CONTROL_BODY_LIMIT" },
        { name: "bad account id", reply: secret(running, { accountId: "bad id!", secret: CANARY }), status: 400 },
        { name: "unknown account", reply: secret(running, { accountId: "account-missing", secret: CANARY }), status: 404, code: "CONTROL_ACCOUNT_NOT_FOUND" },
        { name: "environment account", reply: secret(running, { accountId: "account-env", secret: CANARY }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "sign-in account", reply: secret(running, { accountId: "account-oauth", secret: CANARY }), status: 400, code: "CONTROL_INVALID_INPUT" },
      ]
      for (const entry of cases) {
        const reply = await entry.reply
        expect({ name: entry.name, status: reply.status }).toEqual({ name: entry.name, status: entry.status })
        if (entry.code !== undefined) expect({ name: entry.name, code: reply.code }).toEqual({ name: entry.name, code: entry.code })
        expect(reply.body.ok).toBe(false)
        expect(reply.text).not.toContain(CANARY)
      }
      expect(await vault.get("account-key")).toBeUndefined()
      expect((await rpc(running, "account.get", { accountId: "account-key" })).body.result).toMatchObject({ status: "unconfigured" })

      // The generic RPC surface still refuses raw credentials and credential-bearing account fields.
      const rpcCases: readonly Record<string, unknown>[] = [
        { accountId: "account-raw", provider: "openai", label: "Raw", authMode: "api-key", secret: CANARY },
        { accountId: "account-raw", provider: "openai", label: "Raw", authMode: "api-key", apiKey: CANARY },
        { accountId: "account-raw", provider: "openai", label: "Raw", authMode: "api-key", headers: { Authorization: `Bearer ${CANARY}` } },
        { accountId: "account-raw", provider: "openai", label: "Raw", authMode: "api-key", headers: { "X-Api-Key": CANARY } },
        { accountId: "account-raw", provider: "openai", label: "Raw", authMode: "api-key", baseUrl: `https://user:${CANARY}@example.com/v1` },
        { accountId: "account-raw", provider: "openai", label: "Raw", authMode: "api-key", baseUrl: "file:///etc/passwd" },
        { accountId: "account-raw", provider: "openai", label: "Raw", authMode: "api-key", baseUrl: "not a url" },
      ]
      for (const params of rpcCases) {
        const reply = await rpc(running, "account.create", params)
        expect(reply.status).toBe(400)
        expect(reply.text).not.toContain(CANARY)
      }
      expect((await rpc(running, "account.get", { accountId: "account-raw" })).status).toBe(404)
      expect((await send(running, "/rpc", { method: "account.secret.set", params: { accountId: "account-key", secret: CANARY } })).body.ok).toBe(false)
    } finally {
      await running?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  test("a failing credential store reports its stable code and keeps the account unconfigured", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-secret-cwd-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-secret-state-"))
    // What an unsigned build sees when the OS keychain waits on a prompt nobody answers.
    const stalled: CredentialVault = {
      kind: "keychain",
      get: async () => {
        throw new VaultError("VAULT_TIMEOUT", `os detail ${CANARY}`)
      },
      set: async () => {
        throw new VaultError("VAULT_TIMEOUT", `os detail ${CANARY}`)
      },
      delete: async () => {},
    }
    let running: Running | undefined
    try {
      running = await startRunrailControlRpcServer({ cwd, backend: "native", sessionDir, sessionId: "secret-stalled", loadExtensions: false, model, nativeCredentialVault: stalled })
      await rpc(running, "account.create", { accountId: "account-key", provider: "openai", label: "Key", authMode: "api-key" })
      for (const reply of [await secret(running, { accountId: "account-key", secret: CANARY }), await rpc(running, "account.resolve", { accountId: "account-key" })]) {
        expect(reply.status).toBe(503)
        expect(reply.code).toBe("CONTROL_CREDENTIAL_STORE_FAILED")
        expect(reply.body.error).toEqual({ code: "CONTROL_CREDENTIAL_STORE_FAILED", message: "VAULT_TIMEOUT" })
        expect(reply.text).not.toContain(CANARY)
      }
      // A store failure is not a missing credential: the recorded status is left alone.
      const after = (await rpc(running, "account.get", { accountId: "account-key" })).body.result
      expect(after).toMatchObject({ status: "unconfigured" })
      expect(after).not.toHaveProperty("statusCode")
    } finally {
      await running?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  test("without a vault the endpoint is off and the capability says so", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-secret-cwd-"))
    const sessionDir = await mkdtemp(join("/tmp", "runrail-secret-state-"))
    let running: Running | undefined
    try {
      running = await startRunrailControlRpcServer({ cwd, backend: "native", sessionDir, sessionId: "secret-off", loadExtensions: false, model })
      const health = await (await fetch(`${running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
      expect(health.capabilityStatus["account.secrets"]).toBe("configurable")
      // Status stays caller-owned when no vault backs the account, as before.
      const created = await rpc(running, "account.create", { accountId: "account-key", provider: "openai", label: "Key", authMode: "api-key", status: "ready" })
      expect(created.body.result).toMatchObject({ status: "ready" })
      const reply = await secret(running, { accountId: "account-key", secret: CANARY })
      expect(reply.status).toBe(409)
      expect(reply.code).toBe("CONTROL_CAPABILITY_UNAVAILABLE")
      expect(reply.text).not.toContain(CANARY)
      expect(await filesContaining(sessionDir, CANARY)).toEqual([])
    } finally {
      await running?.handle.stop()
      await rm(cwd, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })
})
