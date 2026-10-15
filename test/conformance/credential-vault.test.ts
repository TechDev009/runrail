import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FileAccountStore, type AccountRecord } from "../../src/accounts/index.ts"
import {
  FileCredentialVault,
  FileLockError,
  KeychainCredentialVault,
  MemoryCredentialVault,
  VaultError,
  osKeychainReachable,
  parseStoredCredential,
  withFileLock,
  type CredentialVault,
  type KeychainBackend,
  type StoredCredential,
} from "../../src/auth/index.ts"

const apiKey: StoredCredential = { kind: "api-key", secret: "sk-test-value" }
const tokens: StoredCredential = { kind: "oauth", access: "access-1", refresh: "refresh-1", expiresAt: 1_900_000_000_000, scopes: ["openid", "offline_access"] }

function fakeKeychain(): KeychainBackend & { readonly items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    get: async ({ service, name }) => items.get(`${service}/${name}`) ?? null,
    set: async ({ service, name, value }) => {
      items.set(`${service}/${name}`, value)
    },
    delete: async ({ service, name }) => items.delete(`${service}/${name}`),
  }
}

async function vaultCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof VaultError ? error.code : `unexpected:${String(error)}`
  }
  return "resolved"
}

function account(accountId: string, label = "Account"): AccountRecord {
  return { reference: { accountId, provider: "openai", label, authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1 }, status: "unconfigured" }
}

describe("stored credential shape", () => {
  test("accepts a key and sign-in tokens", () => {
    expect(parseStoredCredential(apiKey)).toEqual(apiKey)
    expect(parseStoredCredential(tokens)).toEqual(tokens)
    expect(parseStoredCredential({ kind: "oauth", access: "a" })).toEqual({ kind: "oauth", access: "a" })
  })

  test("rejects unknown fields, control characters, oversize secrets and bad expiry", () => {
    const rejected: unknown[] = [
      null,
      "sk-test",
      { kind: "password", secret: "x" },
      { kind: "api-key", secret: "" },
      { kind: "api-key", secret: "line\nbreak" },
      { kind: "api-key", secret: "nul\0" },
      { kind: "api-key", secret: "x".repeat(16 * 1024 + 1) },
      { kind: "api-key", secret: "ok", note: "extra" },
      { kind: "oauth", access: "a", expiresAt: -1 },
      { kind: "oauth", access: "a", expiresAt: 1.5 },
      { kind: "oauth", access: "a", scopes: ["has space"] },
      { kind: "oauth", access: "a", idToken: "extra" },
    ]
    for (const value of rejected) expect(() => parseStoredCredential(value)).toThrow(VaultError)
  })
})

describe("credential vaults", () => {
  const cases: readonly { readonly name: string; readonly open: () => Promise<{ readonly vault: CredentialVault; readonly close: () => Promise<void> }> }[] = [
    { name: "memory", open: async () => ({ vault: new MemoryCredentialVault(), close: async () => {} }) },
    {
      name: "file",
      open: async () => {
        const root = await mkdtemp(join("/tmp", "runrail-vault-"))
        return { vault: new FileCredentialVault({ root: join(root, "vault") }), close: () => rm(root, { recursive: true, force: true }) }
      },
    },
    { name: "keychain", open: async () => ({ vault: new KeychainCredentialVault({ backend: fakeKeychain() }), close: async () => {} }) },
  ]

  for (const entry of cases) {
    test(`${entry.name}: stores, replaces, reads back and deletes`, async () => {
      const { vault, close } = await entry.open()
      try {
        expect(vault.kind).toBe(entry.name as CredentialVault["kind"])
        expect(await vault.get("account-a")).toBeUndefined()
        await vault.set("account-a", apiKey)
        await vault.set("account-b", tokens)
        expect(await vault.get("account-a")).toEqual(apiKey)
        expect(await vault.get("account-b")).toEqual(tokens)
        await vault.set("account-a", { kind: "api-key", secret: "sk-replaced" })
        expect(await vault.get("account-a")).toEqual({ kind: "api-key", secret: "sk-replaced" })
        await vault.delete("account-a")
        await vault.delete("account-a")
        expect(await vault.get("account-a")).toBeUndefined()
        expect(await vault.get("account-b")).toEqual(tokens)
        expect(await vaultCode(() => vault.get("../escape"))).toBe("VAULT_INVALID")
        expect(await vaultCode(() => vault.set("account-a", { kind: "api-key", secret: "a\nb" }))).toBe("VAULT_INVALID")
      } finally {
        await close()
      }
    })
  }

  test("file vault writes owner-only files whose names do not reveal the account", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-vault-"))
    try {
      const vaultRoot = join(root, "vault")
      const vault = new FileCredentialVault({ root: vaultRoot })
      await vault.set("account-visible-name", apiKey)
      await Promise.all(Array.from({ length: 8 }, () => vault.set("account-visible-name", apiKey)))
      const names = await readdir(vaultRoot)
      expect(names).toHaveLength(1)
      expect(names[0]).toMatch(/^[0-9a-f]{40}\.json$/)
      expect((await stat(vaultRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(join(vaultRoot, names[0]!))).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("file vault refuses a file other users can read, and a file moved from another account", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-vault-"))
    try {
      const vaultRoot = join(root, "vault")
      const vault = new FileCredentialVault({ root: vaultRoot })
      await vault.set("account-a", apiKey)
      const path = join(vaultRoot, (await readdir(vaultRoot))[0]!)
      await chmod(path, 0o644)
      expect(await vaultCode(() => vault.get("account-a"))).toBe("VAULT_PERMISSIONS")
      await chmod(path, 0o600)
      await writeFile(path, (await readFile(path, "utf8")).replace("account-a", "account-z"))
      expect(await vaultCode(() => vault.get("account-a"))).toBe("VAULT_INVALID")
      await writeFile(path, "{not json")
      expect(await vaultCode(() => vault.get("account-a"))).toBe("VAULT_INVALID")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a locked Linux keyring is named as locked, still without the backend's own text", async () => {
    // What libsecret says when gnome-keyring is running but locked: reads work, writes refuse.
    const locked: KeychainBackend = {
      get: async () => null,
      set: async () => {
        throw new Error("Cannot create an item in a locked collection (code: 2) sk-test-value")
      },
      delete: async () => false,
    }
    const vault = new KeychainCredentialVault({ backend: locked })
    expect(await vault.get("account-a")).toBeUndefined()
    let message = ""
    try {
      await vault.set("account-a", apiKey)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain("the system keyring is locked; unlock it and try again")
    expect(message).not.toContain("sk-test-value")
  })

  test("the OS keychain is unreachable only on a Linux with no session bus", () => {
    const none = () => false
    expect(osKeychainReachable({}, "darwin", none)).toBe(true)
    expect(osKeychainReachable({}, "linux", none)).toBe(false)
    expect(osKeychainReachable({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, "linux", none)).toBe(true)
    expect(osKeychainReachable({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux", none)).toBe(false)
    expect(osKeychainReachable({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux", (path) => path === "/run/user/1000/bus")).toBe(true)
  })

  test("keychain vault reports a stable code when the OS store stalls or refuses, without its message", async () => {
    const stalled: KeychainBackend = { get: () => new Promise(() => {}), set: () => new Promise(() => {}), delete: () => new Promise(() => {}) }
    const slow = new KeychainCredentialVault({ backend: stalled, timeoutMs: 25 })
    expect(await vaultCode(() => slow.get("account-a"))).toBe("VAULT_TIMEOUT")
    expect(await vaultCode(() => slow.set("account-a", apiKey))).toBe("VAULT_TIMEOUT")

    const refusing: KeychainBackend = {
      get: async () => {
        throw new Error("backend detail sk-test-value")
      },
      set: async () => {
        throw new Error("backend detail sk-test-value")
      },
      delete: async () => false,
    }
    const refused = new KeychainCredentialVault({ backend: refusing })
    let message = ""
    try {
      await refused.set("account-a", apiKey)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain("VAULT_UNAVAILABLE")
    expect(message).not.toContain("sk-test-value")

    const corrupt = fakeKeychain()
    corrupt.items.set("dev.runrail.credentials/account-a", "not json")
    expect(await vaultCode(() => new KeychainCredentialVault({ backend: corrupt }).get("account-a"))).toBe("VAULT_INVALID")
    expect(() => new KeychainCredentialVault({ service: "bad service" })).toThrow(VaultError)
  })
})

describe("file lock", () => {
  test("runs one holder at a time", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-lock-"))
    try {
      const path = join(root, "locks", "a.lock")
      let inside = 0
      let overlapped = false
      const order: number[] = []
      await Promise.all(
        [0, 1, 2, 3, 4].map((index) =>
          withFileLock(path, async () => {
            inside += 1
            if (inside > 1) overlapped = true
            await new Promise((resolve) => setTimeout(resolve, 15))
            order.push(index)
            inside -= 1
          }, { pollMs: 2 }),
        ),
      )
      expect(overlapped).toBe(false)
      expect(order).toHaveLength(5)
      expect(await readdir(join(root, "locks"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("releases on failure, times out on a live holder, and takes over a dead or stale one", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-lock-"))
    try {
      const path = join(root, "a.lock")
      await expect(withFileLock(path, async () => Promise.reject(new Error("work failed")))).rejects.toThrow("work failed")
      expect(await withFileLock(path, async () => "after failure")).toBe("after failure")

      // A holder in another live process that renews its lock is waited for, then reported.
      const holder = Bun.spawn(["sleep", "30"])
      try {
        await writeFile(path, `${holder.pid}:live`)
        let code = ""
        try {
          await withFileLock(path, async () => "unreachable", { timeoutMs: 80, pollMs: 5 })
        } catch (error) {
          code = error instanceof FileLockError ? error.code : String(error)
        }
        expect(code).toBe("LOCK_TIMEOUT")
        expect(await readFile(path, "utf8")).toBe(`${holder.pid}:live`)

        // The same holder, once it has stopped renewing for the stale age, is taken over.
        const old = new Date(Date.now() - 60_000)
        await utimes(path, old, old)
        expect(await withFileLock(path, async () => "took over stale", { staleMs: 1_000, timeoutMs: 500, pollMs: 5 })).toBe("took over stale")
      } finally {
        holder.kill()
      }

      // This process's id with an owner it is not running: left by a crashed process that had the id.
      await writeFile(path, `${process.pid}:crashed-earlier`)
      expect(await withFileLock(path, async () => "took over leftover", { timeoutMs: 500, pollMs: 5 })).toBe("took over leftover")

      // A holder whose process is gone is taken over at once.
      const gone = Bun.spawn(["true"])
      await gone.exited
      await writeFile(path, `${gone.pid}:dead`)
      expect(await withFileLock(path, async () => "took over dead", { timeoutMs: 500, pollMs: 5 })).toBe("took over dead")

      const cancelled = new AbortController()
      cancelled.abort()
      await writeFile(path, `${process.pid}:crashed-earlier`)
      await expect(withFileLock(path, async () => "unreachable", { signal: cancelled.signal })).rejects.toThrow("LOCK_CANCELLED")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test("a live holder that runs past the stale age keeps its lock", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-lock-live-"))
  try {
    const path = join(root, "a.lock")
    let inside = 0
    let overlapped = false
    const hold = (ms: number) => withFileLock(path, async () => {
      inside += 1
      if (inside > 1) overlapped = true
      await Bun.sleep(ms)
      inside -= 1
    }, { staleMs: 100, timeoutMs: 2_000, pollMs: 5 })
    await Promise.all([hold(350), Bun.sleep(20).then(() => hold(10))])
    expect(overlapped).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe("shared account file", () => {
  test("two stores over one directory see each other's changes and never lose one", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-accounts-"))
    try {
      const first = new FileAccountStore({ root })
      const second = new FileAccountStore({ root })
      expect(await second.list()).toEqual([])
      await first.put(account("account-a"))
      expect((await second.get("account-a"))?.reference.label).toBe("Account")
      await second.put(account("account-a", "Renamed"))
      expect((await first.get("account-a"))?.reference.label).toBe("Renamed")

      // Interleaved writers: every put must survive, whichever store wrote last.
      await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? first : second).put(account(`account-n${index}`))))
      const ids = (await first.list()).map((record) => record.reference.accountId)
      expect(ids).toHaveLength(13)
      expect((await second.list()).map((record) => record.reference.accountId)).toEqual(ids)

      await second.remove("account-a")
      expect(await first.get("account-a")).toBeUndefined()
      expect((await readdir(root)).sort()).toEqual(["accounts.json"])
      expect((await stat(join(root, "accounts.json"))).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a rejected change leaves the file and the cached view untouched", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-accounts-"))
    try {
      const store = new FileAccountStore({ root, maxAccounts: 1 })
      await store.put(account("account-a"))
      await expect(store.put(account("account-b"))).rejects.toThrow("ACCOUNT_LIMIT")
      await expect(store.put({ ...account("account-a"), secret: "sk-test-value" } as unknown as AccountRecord)).rejects.toThrow("ACCOUNT_INVALID")
      expect((await store.list()).map((record) => record.reference.accountId)).toEqual(["account-a"])
      expect(await readFile(join(root, "accounts.json"), "utf8")).not.toContain("sk-test-value")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
