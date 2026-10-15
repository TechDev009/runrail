import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const MAX_CREDENTIAL_SECRET_BYTES = 16 * 1024
const MAX_VAULT_ITEM_BYTES = 64 * 1024
const VAULT_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/

/** A key the user pasted. */
export interface ApiKeyCredential {
  readonly kind: "api-key"
  readonly secret: string
}

/** Tokens from a sign-in. `access` is what a request carries; `refresh` obtains the next `access`. */
export interface OAuthCredential {
  readonly kind: "oauth"
  readonly access: string
  readonly refresh?: string
  /** Epoch milliseconds at which `access` stops working. Absent when the vendor issues a non-expiring token. */
  readonly expiresAt?: number
  readonly scopes?: readonly string[]
  /** The client id the vendor issued to this installation at sign-in, when the refresh call needs it. Not a secret. */
  readonly clientId?: string
}

export type StoredCredential = ApiKeyCredential | OAuthCredential

export type VaultErrorCode = "VAULT_INVALID" | "VAULT_UNAVAILABLE" | "VAULT_TIMEOUT" | "VAULT_PERMISSIONS"

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "VaultError"
  }
}

/**
 * Where secrets live. Account metadata never holds a secret; it holds the id a vault is asked for.
 * A vault never logs and never returns a secret to anything but its caller.
 */
export interface CredentialVault {
  readonly kind: "memory" | "file" | "keychain"
  get(id: string): Promise<StoredCredential | undefined>
  set(id: string, credential: StoredCredential): Promise<void>
  delete(id: string): Promise<void>
}

export function parseStoredCredential(value: unknown): StoredCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new VaultError("VAULT_INVALID", "credential is invalid")
  const record = value as Record<string, unknown>
  if (record.kind === "api-key") {
    onlyKeys(record, ["kind", "secret"])
    return Object.freeze({ kind: "api-key", secret: secretText(record.secret) })
  }
  if (record.kind === "oauth") {
    onlyKeys(record, ["kind", "access", "refresh", "expiresAt", "scopes", "clientId"])
    const access = secretText(record.access)
    const refresh = record.refresh === undefined ? undefined : secretText(record.refresh)
    const expiresAt = record.expiresAt === undefined ? undefined : timestamp(record.expiresAt)
    const scopes = record.scopes === undefined ? undefined : scopeList(record.scopes)
    const clientId = record.clientId === undefined ? undefined : clientIdText(record.clientId)
    return Object.freeze({
      kind: "oauth",
      access,
      ...(refresh === undefined ? {} : { refresh }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(scopes === undefined ? {} : { scopes }),
      ...(clientId === undefined ? {} : { clientId }),
    })
  }
  throw new VaultError("VAULT_INVALID", "credential kind is invalid")
}

export class MemoryCredentialVault implements CredentialVault {
  readonly kind = "memory" as const
  private readonly items = new Map<string, StoredCredential>()

  async get(id: string): Promise<StoredCredential | undefined> {
    return this.items.get(vaultId(id))
  }

  async set(id: string, credential: StoredCredential): Promise<void> {
    this.items.set(vaultId(id), parseStoredCredential(credential))
  }

  async delete(id: string): Promise<void> {
    this.items.delete(vaultId(id))
  }
}

/**
 * One file per credential, readable by the owner only. Weaker than the OS keychain - anything
 * running as the user can read it - so it is opt-in: development builds, whose signature changes
 * on every rebuild, and hosts without a keychain service.
 */
export class FileCredentialVault implements CredentialVault {
  readonly kind = "file" as const
  private readonly root: string

  constructor(options: { readonly root: string }) {
    if (typeof options.root !== "string" || options.root.length === 0 || options.root.length > 4_096 || !options.root.startsWith("/")) throw new VaultError("VAULT_INVALID", "vault root is invalid")
    this.root = options.root
  }

  async get(id: string): Promise<StoredCredential | undefined> {
    const path = this.path(id)
    let text: string
    try {
      const info = await stat(path)
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new VaultError("VAULT_PERMISSIONS", "vault file is readable by other users")
      if (info.size > MAX_VAULT_ITEM_BYTES) throw new VaultError("VAULT_INVALID", "vault file is too large")
      text = await readFile(path, "utf8")
    } catch (error) {
      if (error instanceof VaultError) throw error
      if (isNotFound(error)) return undefined
      throw new VaultError("VAULT_UNAVAILABLE", "vault file cannot be read")
    }
    const item = parseItem(text)
    if (item.id !== id) throw new VaultError("VAULT_INVALID", "vault file belongs to another credential")
    return item.credential
  }

  async set(id: string, credential: StoredCredential): Promise<void> {
    const path = this.path(id)
    const data = JSON.stringify({ version: 1, id, credential: parseStoredCredential(credential) })
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" })
      await rename(temporary, path)
    } catch {
      await unlink(temporary).catch(() => undefined)
      throw new VaultError("VAULT_UNAVAILABLE", "vault file cannot be written")
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.path(id))
    } catch (error) {
      if (!isNotFound(error)) throw new VaultError("VAULT_UNAVAILABLE", "vault file cannot be removed")
    }
  }

  private path(id: string): string {
    return join(this.root, `${createHash("sha256").update(vaultId(id)).digest("hex").slice(0, 40)}.json`)
  }
}

/** The part of `Bun.secrets` the keychain vault uses; tests supply their own. */
export interface KeychainBackend {
  get(options: { readonly service: string; readonly name: string }): Promise<string | null>
  set(options: { readonly service: string; readonly name: string; readonly value: string }): Promise<void>
  delete(options: { readonly service: string; readonly name: string }): Promise<boolean>
}

export const DEFAULT_KEYCHAIN_SERVICE = "dev.runrail.credentials"

/**
 * The OS credential store: macOS Keychain, Windows Credential Manager, or the Linux secret service.
 *
 * macOS ties an item to the code signature of the program that wrote it. A differently signed
 * build asking for the item makes the OS wait on a user prompt, so every call is bounded and
 * reports `VAULT_TIMEOUT` instead of hanging the turn.
 */
export class KeychainCredentialVault implements CredentialVault {
  readonly kind = "keychain" as const
  private readonly service: string
  private readonly timeoutMs: number
  private readonly backend: KeychainBackend | undefined

  constructor(options: { readonly service?: string; readonly timeoutMs?: number; readonly backend?: KeychainBackend } = {}) {
    const service = options.service ?? DEFAULT_KEYCHAIN_SERVICE
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(service)) throw new VaultError("VAULT_INVALID", "keychain service is invalid")
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new VaultError("VAULT_INVALID", "keychain timeout is invalid")
    this.service = service
    this.timeoutMs = timeoutMs
    this.backend = options.backend ?? defaultKeychainBackend()
  }

  async get(id: string): Promise<StoredCredential | undefined> {
    const name = vaultId(id)
    const text = await this.bounded((backend) => backend.get({ service: this.service, name }))
    if (text === null) return undefined
    if (text.length > MAX_VAULT_ITEM_BYTES) throw new VaultError("VAULT_INVALID", "keychain item is too large")
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new VaultError("VAULT_INVALID", "keychain item is invalid")
    }
    return parseStoredCredential(value)
  }

  async set(id: string, credential: StoredCredential): Promise<void> {
    const name = vaultId(id)
    const value = JSON.stringify(parseStoredCredential(credential))
    await this.bounded((backend) => backend.set({ service: this.service, name, value }))
  }

  async delete(id: string): Promise<void> {
    const name = vaultId(id)
    await this.bounded((backend) => backend.delete({ service: this.service, name }))
  }

  private async bounded<T>(run: (backend: KeychainBackend) => Promise<T>): Promise<T> {
    const backend = this.backend
    if (backend === undefined) throw new VaultError("VAULT_UNAVAILABLE", "no OS credential store is available")
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new VaultError("VAULT_TIMEOUT", "the OS credential store did not answer")), this.timeoutMs)
    })
    try {
      return await Promise.race([run(backend), timeout])
    } catch (error) {
      if (error instanceof VaultError) throw error
      // A locked Linux keyring still answers reads and refuses writes; the backend's own text is
      // only matched, never passed on.
      if (error instanceof Error && /\blocked\b/i.test(error.message)) throw new VaultError("VAULT_UNAVAILABLE", "the system keyring is locked; unlock it and try again")
      throw new VaultError("VAULT_UNAVAILABLE", "the OS credential store refused the request")
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * Whether the OS keychain can answer at all. On Linux it is the Secret Service on the session bus;
 * without a bus (a server, a container, an SSH session) every call fails.
 */
export function osKeychainReachable(env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform, exists: (path: string) => boolean = existsSync): boolean {
  if (platform !== "linux") return true
  if ((env.DBUS_SESSION_BUS_ADDRESS ?? "").length > 0) return true
  return env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR.length > 0 && exists(join(env.XDG_RUNTIME_DIR, "bus"))
}

function defaultKeychainBackend(): KeychainBackend | undefined {
  const runtime = (globalThis as { readonly Bun?: { readonly secrets?: KeychainBackend } }).Bun
  return runtime?.secrets
}

function parseItem(text: string): { readonly id: string; readonly credential: StoredCredential } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new VaultError("VAULT_INVALID", "vault file is invalid")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new VaultError("VAULT_INVALID", "vault file is invalid")
  const record = value as Record<string, unknown>
  onlyKeys(record, ["version", "id", "credential"])
  if (record.version !== 1 || typeof record.id !== "string") throw new VaultError("VAULT_INVALID", "vault file is invalid")
  return { id: record.id, credential: parseStoredCredential(record.credential) }
}

function vaultId(value: unknown): string {
  if (typeof value !== "string" || !VAULT_ID.test(value)) throw new VaultError("VAULT_INVALID", "credential id is invalid")
  return value
}

function secretText(value: unknown): string {
  // A secret goes into a request header, so it must be one line of printable text.
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_SECRET_BYTES || /[\0-\x1f\x7f]/.test(value)) throw new VaultError("VAULT_INVALID", "credential secret is invalid")
  return value
}

function clientIdText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0-\x20\x7f]/.test(value)) throw new VaultError("VAULT_INVALID", "credential client id is invalid")
  return value
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new VaultError("VAULT_INVALID", "credential expiry is invalid")
  return value
}

function scopeList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new VaultError("VAULT_INVALID", "credential scopes are invalid")
  for (const scope of value) if (typeof scope !== "string" || scope.length === 0 || scope.length > 256 || /[\0-\x20\x7f]/.test(scope)) throw new VaultError("VAULT_INVALID", "credential scope is invalid")
  return Object.freeze([...(value as string[])])
}

function onlyKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new VaultError("VAULT_INVALID", "credential contains unknown fields")
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && String((error as { readonly code: unknown }).code) === "ENOENT"
}
