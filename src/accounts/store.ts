import { mkdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { FileLockError, withFileLock } from "../auth/lock.ts"
import { AccountError, InMemoryAccountStore, parseAccountRecord, type AccountRecord, type AccountStore } from "./types.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"

/**
 * Account metadata in one JSON file. Several engines may share the directory, so every read checks
 * whether the file changed on disk and every write re-reads it under a lock before changing it.
 */
export class FileAccountStore implements AccountStore {
  private readonly root: string
  private readonly path: string
  private readonly lockPath: string
  private readonly maxBytes: number
  private readonly maxAccounts: number | undefined
  private memory: InMemoryAccountStore
  private stamp: string | undefined

  constructor(options: { readonly root: string; readonly maxAccounts?: number; readonly maxBytes?: number }) {
    if (typeof options.root !== "string" || options.root.length === 0 || options.root.length > 4_096 || !options.root.startsWith("/")) throw new AccountError("ACCOUNT_INVALID", "account store root is invalid")
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 64 * 1024 * 1024) throw new AccountError("ACCOUNT_LIMIT", "account store byte limit is invalid")
    this.root = options.root
    this.path = join(this.root, "accounts.json")
    this.lockPath = join(this.root, "accounts.lock")
    this.maxBytes = maxBytes
    this.maxAccounts = options.maxAccounts
    this.memory = new InMemoryAccountStore({ maxAccounts: options.maxAccounts })
  }

  async get(accountId: string): Promise<AccountRecord | undefined> {
    await this.refresh()
    return this.memory.get(accountId)
  }

  async list(provider?: string): Promise<readonly AccountRecord[]> {
    await this.refresh()
    return this.memory.list(provider)
  }

  async put(record: AccountRecord): Promise<void> {
    await this.change((memory) => memory.put(record))
  }

  async remove(accountId: string): Promise<void> {
    await this.change((memory) => memory.remove(accountId))
  }

  private async change(apply: (memory: InMemoryAccountStore) => void): Promise<void> {
    try {
      await withFileLock(this.lockPath, async () => {
        await this.refresh()
        // Applied to a copy so a rejected or unwritten change leaves the cached view as the file has it.
        const next = new InMemoryAccountStore({ maxAccounts: this.maxAccounts })
        for (const record of this.memory.list()) next.put(record)
        apply(next)
        await this.flush(next)
        this.memory = next
        this.stamp = await this.currentStamp()
      })
    } catch (error) {
      if (error instanceof FileLockError) throw new AccountError("ACCOUNT_INVALID", "account store is busy")
      throw error
    }
  }

  private async refresh(): Promise<void> {
    const stamp = await this.currentStamp()
    if (stamp === this.stamp) return
    const memory = new InMemoryAccountStore({ maxAccounts: this.maxAccounts })
    if (stamp !== "absent") {
      let text: string
      try {
        text = await readFile(this.path, "utf8")
      } catch (error) {
        if (!isNotFound(error)) throw new AccountError("ACCOUNT_INVALID", "account store cannot be read")
        text = "[]"
      }
      if (Buffer.byteLength(text, "utf8") > this.maxBytes) throw new AccountError("ACCOUNT_LIMIT", "account store is too large")
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new AccountError("ACCOUNT_INVALID", "account store JSON is invalid")
      }
      if (!Array.isArray(value) || value.length > 4_096) throw new AccountError("ACCOUNT_INVALID", "account store shape is invalid")
      for (const item of value) memory.put(parseAccountRecord(item))
    }
    this.memory = memory
    this.stamp = stamp
  }

  private async currentStamp(): Promise<string> {
    try {
      const info = await stat(this.path)
      return `${info.ino}:${info.mtimeMs}:${info.size}`
    } catch (error) {
      if (isNotFound(error)) return "absent"
      throw new AccountError("ACCOUNT_INVALID", "account store cannot be read")
    }
  }

  private async flush(memory: InMemoryAccountStore): Promise<void> {
    const data = JSON.stringify(memory.list())
    if (Buffer.byteLength(data, "utf8") > this.maxBytes) throw new AccountError("ACCOUNT_LIMIT", "account store is too large")
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.path, data)
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && String((error as { readonly code: unknown }).code) === "ENOENT"
}
