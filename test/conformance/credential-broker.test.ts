import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { AccountError, FileAccountStore, InMemoryAccountStore, createAccountCredentialResolver, type AccountAuthMode, type AccountRecord, type AccountStore } from "../../src/accounts/index.ts"
import { CredentialRefreshError, FileCredentialVault, MemoryCredentialVault, VaultCredentialBroker, type CredentialRefresher, type CredentialVault, type OAuthCredential } from "../../src/auth/index.ts"

const NOW = 1_800_000_000_000

function record(accountId: string, authMode: AccountAuthMode, extra: Partial<AccountRecord["reference"]> = {}): AccountRecord {
  return { reference: { accountId, provider: "fake-vendor", label: "Account", authMode, scopes: [], createdAt: 1, updatedAt: 1, ...extra }, status: "unconfigured" }
}

async function accountCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof AccountError ? error.code : `unexpected:${String(error)}`
  }
  return "resolved"
}

interface Harness {
  readonly broker: VaultCredentialBroker
  readonly vault: CredentialVault
  readonly accounts: AccountStore
  readonly calls: OAuthCredential[]
  readonly close: () => Promise<void>
}

async function harness(refresh?: (credential: OAuthCredential, call: number) => Promise<OAuthCredential>): Promise<Harness> {
  const root = await mkdtemp(join("/tmp", "runrail-broker-"))
  const vault = new MemoryCredentialVault()
  const accounts = new InMemoryAccountStore()
  const calls: OAuthCredential[] = []
  const refresher: CredentialRefresher = {
    refresh: async (credential) => {
      calls.push(credential)
      if (refresh === undefined) throw new Error("refresh was not expected")
      return refresh(credential, calls.length)
    },
  }
  const broker = new VaultCredentialBroker({
    vault,
    accounts,
    refreshers: { "fake-vendor": refresher },
    lockRoot: join(root, "locks"),
    now: () => NOW,
    fallback: { resolve: async (reference) => ({ accountId: reference.accountId, provider: reference.provider, secret: `env:${reference.environmentName}` }) },
  })
  return { broker, vault, accounts, calls, close: () => rm(root, { recursive: true, force: true }) }
}

describe("vault credential broker", () => {
  test("stores a pasted key, marks the account ready and resolves it", async () => {
    const h = await harness()
    try {
      const account = record("account-key", "api-key")
      h.accounts.put(account)
      expect(await accountCode(() => h.broker.resolve(account.reference))).toBe("ACCOUNT_CREDENTIALS_UNAVAILABLE")
      expect(await h.accounts.get("account-key")).toMatchObject({ status: "unconfigured", statusCode: "CREDENTIAL_MISSING" })

      await h.broker.store(account.reference, { kind: "api-key", secret: "sk-test-value" })
      const stored = await h.accounts.get("account-key")
      expect(stored?.status).toBe("ready")
      expect(stored?.statusCode).toBeUndefined()
      expect(JSON.stringify(stored)).not.toContain("sk-test-value")
      expect(await h.broker.resolve(account.reference)).toEqual({ accountId: "account-key", provider: "fake-vendor", secret: "sk-test-value" })
      expect(await createAccountCredentialResolver(h.accounts, h.broker).resolve({ kind: "caller", account: "account-key" })).toBe("sk-test-value")

      await h.broker.revoke(account.reference)
      expect(await h.vault.get("account-key")).toBeUndefined()
      expect(await accountCode(() => h.broker.resolve(account.reference))).toBe("ACCOUNT_CREDENTIALS_UNAVAILABLE")
    } finally {
      await h.close()
    }
  })

  test("rejects a credential of the wrong kind, an account that uses no vault, and a cancelled call", async () => {
    const h = await harness()
    try {
      const key = record("account-key", "api-key")
      const signIn = record("account-oauth", "oauth")
      const environment = record("account-env", "environment", { environmentName: "FAKE_VENDOR_KEY" })
      expect(await accountCode(() => h.broker.store(key.reference, { kind: "oauth", access: "a" }))).toBe("ACCOUNT_INVALID")
      expect(await accountCode(() => h.broker.store(signIn.reference, { kind: "api-key", secret: "sk" }))).toBe("ACCOUNT_INVALID")
      expect(await accountCode(() => h.broker.store(environment.reference, { kind: "api-key", secret: "sk" }))).toBe("ACCOUNT_INVALID")
      expect(await accountCode(() => h.broker.store(key.reference, { kind: "api-key", secret: "two\nlines" }))).toBe("ACCOUNT_INVALID")
      expect(await h.vault.get("account-key")).toBeUndefined()

      // Environment-backed accounts keep resolving through the fallback broker.
      expect((await h.broker.resolve(environment.reference)).secret).toBe("env:FAKE_VENDOR_KEY")

      const cancelled = new AbortController()
      cancelled.abort()
      expect(await accountCode(() => h.broker.resolve(key.reference, cancelled.signal))).toBe("ACCOUNT_CANCELLED")
    } finally {
      await h.close()
    }
  })

  test("uses a fresh sign-in token as is and refreshes one that is about to expire", async () => {
    const h = await harness(async () => ({ kind: "oauth", access: "access-2", refresh: "refresh-2", expiresAt: NOW + 3_600_000 }))
    try {
      const account = record("account-oauth", "oauth")
      h.accounts.put(account)
      await h.broker.store(account.reference, { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW + 600_000, scopes: ["openid"] })
      expect(await h.broker.resolve(account.reference)).toMatchObject({ secret: "access-1", expiresAt: NOW + 600_000 })
      expect(h.calls).toHaveLength(0)

      // Inside the refresh margin: still valid, but refreshed before use.
      await h.vault.set("account-oauth", { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW + 60_000, scopes: ["openid"] })
      expect(await h.broker.resolve(account.reference)).toMatchObject({ secret: "access-2", expiresAt: NOW + 3_600_000 })
      expect(h.calls.map((call) => call.refresh)).toEqual(["refresh-1"])
      // The rotated refresh token replaced the spent one; scopes the vendor did not repeat are kept.
      expect(await h.vault.get("account-oauth")).toEqual({ kind: "oauth", access: "access-2", refresh: "refresh-2", expiresAt: NOW + 3_600_000, scopes: ["openid"] })
      expect((await h.accounts.get("account-oauth"))?.status).toBe("ready")
    } finally {
      await h.close()
    }
  })

  test("keeps the refresh token when the vendor does not rotate it", async () => {
    const h = await harness(async () => ({ kind: "oauth", access: "access-2", expiresAt: NOW + 3_600_000 }))
    try {
      const account = record("account-device", "device")
      h.accounts.put(account)
      await h.broker.store(account.reference, { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW - 1 })
      expect((await h.broker.resolve(account.reference)).secret).toBe("access-2")
      expect(await h.vault.get("account-device")).toEqual({ kind: "oauth", access: "access-2", refresh: "refresh-1", expiresAt: NOW + 3_600_000 })
    } finally {
      await h.close()
    }
  })

  test("concurrent callers share one refresh", async () => {
    const h = await harness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { kind: "oauth", access: "access-2", refresh: "refresh-2", expiresAt: NOW + 3_600_000 }
    })
    try {
      const account = record("account-oauth", "oauth")
      h.accounts.put(account)
      await h.broker.store(account.reference, { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW - 1 })
      const leases = await Promise.all(Array.from({ length: 8 }, () => h.broker.resolve(account.reference)))
      expect(leases.map((lease) => lease.secret)).toEqual(Array.from({ length: 8 }, () => "access-2"))
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

  test("a sign-out during a refresh stays signed out", async () => {
    let release!: () => void
    let started!: () => void
    const refreshStarted = new Promise<void>((resolve) => { started = resolve })
    const h = await harness(async () => {
      started()
      await new Promise<void>((resolve) => { release = resolve })
      return { kind: "oauth", access: "access-2", refresh: "refresh-2", expiresAt: NOW + 3_600_000 }
    })
    try {
      const account = record("account-oauth", "oauth")
      h.accounts.put(account)
      await h.broker.store(account.reference, { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW - 1 })
      const resolving = h.broker.resolve(account.reference)
      await refreshStarted
      const signingOut = h.broker.signOut(account.reference)
      await new Promise((resolve) => setTimeout(resolve, 50))
      release()
      expect((await resolving).secret).toBe("access-2")
      await signingOut
      expect(await h.vault.get("account-oauth")).toBeUndefined()
      expect(await h.accounts.get("account-oauth")).toMatchObject({ status: "unconfigured", statusCode: "SIGNED_OUT" })
      expect(await accountCode(() => h.broker.resolve(account.reference))).toBe("ACCOUNT_CREDENTIALS_UNAVAILABLE")
    } finally {
      await h.close()
    }
  })

  test("a rejected refresh token expires the account until the user signs in again", async () => {
    const h = await harness(async () => {
      throw new CredentialRefreshError("invalid_grant", "refresh token was revoked")
    })
    try {
      const account = record("account-oauth", "oauth")
      h.accounts.put(account)
      await h.broker.store(account.reference, { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW + 60_000 })
      expect(await accountCode(() => h.broker.resolve(account.reference))).toBe("ACCOUNT_EXPIRED")
      expect(await h.accounts.get("account-oauth")).toMatchObject({ status: "expired", statusCode: "SIGN_IN_REJECTED" })
      const resolver = createAccountCredentialResolver(h.accounts, h.broker)
      expect(await accountCode(async () => resolver.resolve({ kind: "caller", account: "account-oauth" }))).toBe("ACCOUNT_EXPIRED")
      expect(h.calls).toHaveLength(1)

      // Signing in again stores new tokens and clears the expired state.
      await h.broker.store(account.reference, { kind: "oauth", access: "access-3", refresh: "refresh-3", expiresAt: NOW + 3_600_000 })
      expect(await resolver.resolve({ kind: "caller", account: "account-oauth" })).toBe("access-3")
      expect((await h.accounts.get("account-oauth"))?.status).toBe("ready")
    } finally {
      await h.close()
    }
  })

  test("a vendor outage keeps a still-valid token and fails closed once it has expired", async () => {
    const h = await harness(async () => {
      throw new CredentialRefreshError("transient", "vendor returned 503")
    })
    try {
      const account = record("account-oauth", "oauth")
      h.accounts.put(account)
      await h.broker.store(account.reference, { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW + 60_000 })
      expect((await h.broker.resolve(account.reference)).secret).toBe("access-1")
      expect((await h.accounts.get("account-oauth"))?.status).toBe("ready")

      await h.vault.set("account-oauth", { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW - 1 })
      expect(await accountCode(() => h.broker.resolve(account.reference))).toBe("ACCOUNT_AUTH_FAILED")
      // A failed refresh does not throw the sign-in away.
      expect(await h.vault.get("account-oauth")).toMatchObject({ refresh: "refresh-1" })
      expect((await h.accounts.get("account-oauth"))?.status).toBe("ready")
    } finally {
      await h.close()
    }
  })

  test("an expired token with no way to refresh expires the account", async () => {
    const h = await harness()
    try {
      const noRefreshToken = record("account-a", "oauth")
      const noRefresher = record("account-b", "oauth", { provider: "other-vendor" })
      h.accounts.put(noRefreshToken)
      h.accounts.put(noRefresher)
      await h.broker.store(noRefreshToken.reference, { kind: "oauth", access: "access-1", expiresAt: NOW - 1 })
      await h.broker.store(noRefresher.reference, { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: NOW - 1 })
      expect(await accountCode(() => h.broker.resolve(noRefreshToken.reference))).toBe("ACCOUNT_EXPIRED")
      expect(await accountCode(() => h.broker.resolve(noRefresher.reference))).toBe("ACCOUNT_EXPIRED")
      expect(await h.accounts.get("account-a")).toMatchObject({ status: "expired", statusCode: "SIGN_IN_EXPIRED" })
      expect(h.calls).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  test("a stalled credential store surfaces its stable code and nothing else", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-broker-"))
    try {
      const accounts = new InMemoryAccountStore()
      const account = record("account-key", "api-key")
      accounts.put(account)
      const failing: CredentialVault = {
        kind: "keychain",
        get: async () => {
          throw new Error("os detail that must not leak")
        },
        set: async () => {},
        delete: async () => {},
      }
      const broker = new VaultCredentialBroker({ vault: failing, accounts, lockRoot: join(root, "locks") })
      let message = ""
      try {
        await broker.resolve(account.reference)
      } catch (error) {
        message = String(error)
      }
      expect(message).toContain("ACCOUNT_CREDENTIALS_UNAVAILABLE")
      expect(message).toContain("VAULT_UNAVAILABLE")
      expect(message).not.toContain("os detail")
      // Trouble reaching the store is not evidence that the credential is gone.
      expect((await accounts.get("account-key"))?.status).toBe("unconfigured")
      expect((await accounts.get("account-key"))?.statusCode).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("two engine processes refresh one account exactly once and both get the new token", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-broker-procs-"))
    try {
      const accounts = new FileAccountStore({ root })
      const account = record("account-shared", "oauth")
      await accounts.put(account)
      const vault = new FileCredentialVault({ root: join(root, "vault") })
      await vault.set("account-shared", { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: Date.now() - 1 })

      const worker = join(import.meta.dir, "..", "fixtures", "credential-refresh-worker.ts")
      const spawned = [0, 1, 2].map(() => Bun.spawn([process.execPath, "run", worker, root, "account-shared"], { stdout: "pipe", stderr: "pipe" }))
      const results = await Promise.all(
        spawned.map(async (child) => ({ code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })),
      )
      for (const result of results) {
        expect(result.err).toBe("")
        expect(result.code).toBe(0)
        expect(JSON.parse(result.out)).toEqual({ access: "access-2" })
      }
      // The fake vendor rejects a spent refresh token, so a second refresh would have failed a worker.
      const refreshes = (await readFile(join(root, "refresh.log"), "utf8")).trim().split("\n")
      expect(refreshes).toHaveLength(1)
      expect(await vault.get("account-shared")).toMatchObject({ access: "access-2", refresh: "refresh-2" })
      expect((await new FileAccountStore({ root }).get("account-shared"))?.status).toBe("ready")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
