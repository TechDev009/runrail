import { createHash } from "node:crypto"
import { join } from "node:path"
import { AccountError, EnvironmentCredentialBroker, type AccountReference, type AccountStatus, type AccountStore, type CredentialBroker, type CredentialLease } from "../accounts/types.ts"
import { FileLockError, withFileLock } from "./lock.ts"
import { VaultError, parseStoredCredential, type CredentialVault, type OAuthCredential, type StoredCredential, type VaultErrorCode } from "./vault.ts"

/** Exchanges a refresh token for new tokens at the vendor. One per preset that signs in. */
export interface CredentialRefresher {
  refresh(credential: OAuthCredential, reference: AccountReference, signal: AbortSignal): Promise<OAuthCredential>
}

/**
 * `invalid_grant`: the vendor no longer accepts the refresh token; the user must sign in again.
 * `transient`: network or vendor trouble; the old tokens are kept.
 */
export class CredentialRefreshError extends Error {
  constructor(readonly kind: "invalid_grant" | "transient", reason: string) {
    super(reason.slice(0, 256).replace(/[\r\n\0]/g, " "))
    this.name = "CredentialRefreshError"
  }
}

/** The vault itself failed (locked, timed out, unreadable). `vaultCode` is stable and carries no secret. */
export class CredentialStoreError extends AccountError {
  constructor(readonly vaultCode: VaultErrorCode) {
    super("ACCOUNT_CREDENTIALS_UNAVAILABLE", `credential store failed (${vaultCode})`)
    this.name = "CredentialStoreError"
  }
}

export interface VaultCredentialBrokerOptions {
  readonly vault: CredentialVault
  readonly accounts: AccountStore
  /** Keyed by `reference.preset`, falling back to `reference.provider`. */
  readonly refreshers?: Readonly<Record<string, CredentialRefresher>>
  /** Directory for the lock files that keep two engines from refreshing the same account at once. */
  readonly lockRoot: string
  /** Resolves the modes that read an environment variable. */
  readonly fallback?: CredentialBroker
  readonly now?: () => number
  /** A token this close to expiry is refreshed before use. Default 3 minutes. */
  readonly refreshMarginMs?: number
  /** Upper bound for one refresh call to the vendor. Default 30 seconds. */
  readonly refreshTimeoutMs?: number
}

/**
 * Resolves an account to the secret a request carries.
 *
 * Keys and sign-in tokens come from the vault. An expiring sign-in token is refreshed first, by at
 * most one caller per account across every engine on the machine: vendors rotate refresh tokens, so
 * a second concurrent refresh would present a token the first one already spent.
 */
export class VaultCredentialBroker implements CredentialBroker {
  readonly vault: CredentialVault
  private readonly accounts: AccountStore
  private readonly refreshers: ReadonlyMap<string, CredentialRefresher>
  private readonly lockRoot: string
  private readonly fallback: CredentialBroker
  private readonly now: () => number
  private readonly refreshMarginMs: number
  private readonly refreshTimeoutMs: number
  private readonly refreshing = new Map<string, Promise<StoredCredential>>()

  constructor(options: VaultCredentialBrokerOptions) {
    if (typeof options.lockRoot !== "string" || options.lockRoot.length === 0 || options.lockRoot.length > 4_096 || !options.lockRoot.startsWith("/")) throw new AccountError("ACCOUNT_INVALID", "credential lock root is invalid")
    const refreshMarginMs = options.refreshMarginMs ?? 180_000
    if (!Number.isSafeInteger(refreshMarginMs) || refreshMarginMs < 0 || refreshMarginMs > 3_600_000) throw new AccountError("ACCOUNT_INVALID", "credential refresh margin is invalid")
    const refreshTimeoutMs = options.refreshTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(refreshTimeoutMs) || refreshTimeoutMs < 1 || refreshTimeoutMs > 30_000) throw new AccountError("ACCOUNT_INVALID", "credential refresh timeout is invalid")
    this.vault = options.vault
    this.accounts = options.accounts
    this.refreshers = new Map(Object.entries(options.refreshers ?? {}))
    this.lockRoot = options.lockRoot
    this.fallback = options.fallback ?? new EnvironmentCredentialBroker()
    this.now = options.now ?? Date.now
    this.refreshMarginMs = refreshMarginMs
    this.refreshTimeoutMs = refreshTimeoutMs
  }

  async resolve(reference: AccountReference, signal?: AbortSignal): Promise<CredentialLease> {
    if (signal?.aborted === true) throw new AccountError("ACCOUNT_CANCELLED", "credential resolution was cancelled")
    if (!usesVault(reference)) return this.fallback.resolve(reference, signal)
    let credential = await this.read(reference)
    if (credential.kind === "oauth" && !this.fresh(credential)) credential = await cancellable(this.refreshShared(reference), signal)
    if (credential.kind === "api-key") return Object.freeze({ accountId: reference.accountId, provider: reference.provider, secret: credential.secret })
    return Object.freeze({
      accountId: reference.accountId,
      provider: reference.provider,
      secret: credential.access,
      ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    })
  }

  /** Puts a pasted key or the tokens of a finished sign-in into the vault and marks the account ready. */
  async store(reference: AccountReference, credential: StoredCredential): Promise<void> {
    if (!usesVault(reference)) throw new AccountError("ACCOUNT_INVALID", "this account does not keep a credential in the vault")
    let parsed: StoredCredential
    try {
      parsed = parseStoredCredential(credential)
    } catch {
      throw new AccountError("ACCOUNT_INVALID", "credential is invalid")
    }
    if ((reference.authMode === "api-key") !== (parsed.kind === "api-key")) throw new AccountError("ACCOUNT_INVALID", "credential does not match the account auth mode")
    await this.changeLocked(reference, async () => {
      try {
        await this.vault.set(reference.accountId, parsed)
      } catch (error) {
        throw vaultFailure(error)
      }
      await this.mark(reference, "ready", undefined)
    })
  }

  async revoke(reference: AccountReference): Promise<void> {
    if (!usesVault(reference)) {
      await this.fallback.revoke?.(reference)
      return
    }
    await this.changeLocked(reference, async () => {
      try {
        await this.vault.delete(reference.accountId)
      } catch (error) {
        throw vaultFailure(error)
      }
    })
  }

  /** Removes the stored credential and leaves the account in place, ready for a new key or sign-in. */
  async signOut(reference: AccountReference): Promise<void> {
    if (!usesVault(reference)) throw new AccountError("ACCOUNT_INVALID", "this account does not keep a credential in the vault")
    await this.changeLocked(reference, async () => {
      try {
        await this.vault.delete(reference.accountId)
      } catch (error) {
        throw vaultFailure(error)
      }
      await this.mark(reference, "unconfigured", "SIGNED_OUT")
    })
  }

  /**
   * A sign-in, sign-out or revoke waits for a refresh in flight in any engine, under the refresh's
   * own lock: otherwise the refresh would write its tokens back after the change and undo it.
   */
  private async changeLocked(reference: AccountReference, change: () => Promise<void>): Promise<void> {
    try {
      await this.underAccountLock(reference, change)
    } catch (error) {
      if (error instanceof FileLockError) throw new AccountError("ACCOUNT_AUTH_FAILED", "the account is busy refreshing; try again")
      throw error
    }
  }

  private underAccountLock<T>(reference: AccountReference, run: () => Promise<T>): Promise<T> {
    const lockPath = join(this.lockRoot, `${createHash("sha256").update(reference.accountId).digest("hex").slice(0, 40)}.lock`)
    // The lock outlives the longest refresh call, so a live holder is never taken over mid-refresh.
    return withFileLock(lockPath, run, { timeoutMs: this.refreshTimeoutMs + 15_000, staleMs: this.refreshTimeoutMs + 30_000 })
  }

  private async read(reference: AccountReference): Promise<StoredCredential> {
    let credential: StoredCredential | undefined
    try {
      credential = await this.vault.get(reference.accountId)
    } catch (error) {
      throw vaultFailure(error)
    }
    if (credential === undefined) {
      await this.mark(reference, "unconfigured", "CREDENTIAL_MISSING")
      throw new AccountError("ACCOUNT_CREDENTIALS_UNAVAILABLE", "account has no stored credential")
    }
    return credential
  }

  private fresh(credential: OAuthCredential): boolean {
    return credential.expiresAt === undefined || credential.expiresAt - this.refreshMarginMs > this.now()
  }

  private usable(credential: OAuthCredential): boolean {
    return credential.expiresAt === undefined || credential.expiresAt > this.now()
  }

  private refreshShared(reference: AccountReference): Promise<StoredCredential> {
    const running = this.refreshing.get(reference.accountId)
    if (running !== undefined) return running
    const started = this.refreshUnderLock(reference).finally(() => this.refreshing.delete(reference.accountId))
    this.refreshing.set(reference.accountId, started)
    return started
  }

  private async refreshUnderLock(reference: AccountReference): Promise<StoredCredential> {
    try {
      return await this.underAccountLock(reference, () => this.refreshLocked(reference))
    } catch (error) {
      if (!(error instanceof FileLockError)) throw error
      const current = await this.read(reference)
      if (current.kind !== "oauth" || this.usable(current)) return current
      throw new AccountError("ACCOUNT_AUTH_FAILED", "token refresh is busy in another process")
    }
  }

  private async refreshLocked(reference: AccountReference): Promise<StoredCredential> {
    // Read again: another engine may have refreshed while this one waited for the lock.
    const current = await this.read(reference)
    if (current.kind !== "oauth" || this.fresh(current)) return current
    const refresher = this.refreshers.get(reference.preset ?? reference.provider) ?? this.refreshers.get(reference.provider)
    if (current.refresh === undefined || refresher === undefined) {
      if (this.usable(current)) return current
      await this.mark(reference, "expired", "SIGN_IN_EXPIRED")
      throw new AccountError("ACCOUNT_EXPIRED", "sign-in has expired")
    }
    let next: OAuthCredential
    try {
      next = await refresher.refresh(current, reference, AbortSignal.timeout(this.refreshTimeoutMs))
    } catch (error) {
      if (error instanceof CredentialRefreshError && error.kind === "invalid_grant") {
        await this.mark(reference, "expired", "SIGN_IN_REJECTED")
        throw new AccountError("ACCOUNT_EXPIRED", "sign-in is no longer accepted")
      }
      if (this.usable(current)) return current
      throw new AccountError("ACCOUNT_AUTH_FAILED", "token refresh failed")
    }
    let merged: StoredCredential
    try {
      // Vendors that do not rotate omit the refresh token; the one in hand stays valid.
      merged = parseStoredCredential({
        kind: "oauth",
        access: next.access,
        refresh: next.refresh ?? current.refresh,
        ...(next.expiresAt === undefined ? {} : { expiresAt: next.expiresAt }),
        ...((next.scopes ?? current.scopes) === undefined ? {} : { scopes: next.scopes ?? current.scopes }),
        ...((next.clientId ?? current.clientId) === undefined ? {} : { clientId: next.clientId ?? current.clientId }),
      })
    } catch {
      if (this.usable(current)) return current
      throw new AccountError("ACCOUNT_AUTH_FAILED", "token refresh returned an invalid credential")
    }
    try {
      await this.vault.set(reference.accountId, merged)
    } catch (error) {
      throw vaultFailure(error)
    }
    await this.mark(reference, "ready", undefined)
    return merged
  }

  private async mark(reference: AccountReference, status: AccountStatus, statusCode: string | undefined): Promise<void> {
    const record = await this.accounts.get(reference.accountId)
    if (record === undefined || record.status === "revoked") return
    if (record.status === status && record.statusCode === statusCode) return
    await this.accounts.put({
      reference: record.reference,
      status,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      lastCheckedAt: this.now(),
    })
  }
}

function usesVault(reference: AccountReference): boolean {
  return reference.authMode === "api-key" || reference.authMode === "oauth" || reference.authMode === "device"
}

function vaultFailure(error: unknown): CredentialStoreError {
  // The vault code is stable and carries no secret; the vault message is not forwarded.
  return new CredentialStoreError(error instanceof VaultError ? error.code : "VAULT_UNAVAILABLE")
}

function cancellable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new AccountError("ACCOUNT_CANCELLED", "credential resolution was cancelled"))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
