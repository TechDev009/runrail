// One engine process for the cross-process refresh test. Resolves an expiring sign-in through the
// shared file vault and prints which access token it ended up with. Every call to the fake vendor
// appends one line to `<root>/refresh.log`, so the test can count refreshes across processes.
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { FileAccountStore } from "../../src/accounts/index.ts"
import { FileCredentialVault, VaultCredentialBroker, type CredentialRefresher } from "../../src/auth/index.ts"

const root = process.argv[2]
const accountId = process.argv[3]
if (root === undefined || accountId === undefined) throw new Error("usage: credential-refresh-worker <root> <accountId>")

const refresher: CredentialRefresher = {
  refresh: async (credential) => {
    await appendFile(join(root, "refresh.log"), `${process.pid}\n`)
    // Long enough for the other process to reach the lock while this refresh is in flight.
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The fake vendor rotates: the refresh token in hand is spent by this call.
    if (credential.refresh !== "refresh-1") throw new Error("spent refresh token was presented again")
    return { kind: "oauth", access: "access-2", refresh: "refresh-2", expiresAt: Date.now() + 3_600_000 }
  },
}

const accounts = new FileAccountStore({ root })
const broker = new VaultCredentialBroker({
  vault: new FileCredentialVault({ root: join(root, "vault") }),
  accounts,
  refreshers: { "fake-vendor": refresher },
  lockRoot: join(root, "locks"),
})
const record = await accounts.get(accountId)
if (record === undefined) throw new Error("account is missing")
const lease = await broker.resolve(record.reference)
console.log(JSON.stringify({ access: lease.secret }))
