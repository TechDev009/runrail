import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ShareError, InMemoryShareStore, parseShareAccessGrant, parseShareReference, type ShareAccessGrant, type ShareReference, type ShareStore } from "./types.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"

interface ShareState {
  readonly shares: readonly ShareReference[]
  readonly grants: readonly ShareAccessGrant[]
}

export class FileShareStore implements ShareStore {
  private readonly root: string
  private readonly path: string
  private readonly maxBytes: number
  private readonly memory: InMemoryShareStore
  private loaded = false
  private loading: Promise<void> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(options: { readonly root: string; readonly maxShares?: number; readonly maxBytes?: number }) {
    if (typeof options.root !== "string" || options.root.length === 0 || options.root.length > 4_096 || !options.root.startsWith("/")) throw new ShareError("SHARE_INVALID", "share store root is invalid")
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 128 * 1024 * 1024) throw new ShareError("SHARE_LIMIT", "share store byte limit is invalid")
    this.root = options.root
    this.path = join(this.root, "shares.json")
    this.maxBytes = maxBytes
    this.memory = new InMemoryShareStore({ maxShares: options.maxShares })
  }

  async get(shareId: string): Promise<ShareReference | undefined> {
    await this.ensureLoaded()
    return this.memory.get(shareId)
  }

  async put(share: ShareReference): Promise<void> {
    await this.ensureLoaded()
    this.memory.put(share)
    await this.flush()
  }

  async list(taskId?: string): Promise<readonly ShareReference[]> {
    await this.ensureLoaded()
    return this.memory.list(taskId)
  }

  async grants(shareId: string): Promise<readonly ShareAccessGrant[]> {
    await this.ensureLoaded()
    return this.memory.grants(shareId)
  }

  async putGrant(grant: ShareAccessGrant): Promise<void> {
    await this.ensureLoaded()
    this.memory.putGrant(grant)
    await this.flush()
  }

  /** One load, however many callers arrive first: a second reader must not put old state over a write already made. */
  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, "utf8")
    } catch (error) {
      if (isNotFound(error)) {
        this.loaded = true
        return
      }
      throw new ShareError("SHARE_INVALID", "share store cannot be read")
    }
    if (Buffer.byteLength(text, "utf8") > this.maxBytes) throw new ShareError("SHARE_LIMIT", "share store is too large")
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new ShareError("SHARE_INVALID", "share store JSON is invalid")
    }
    if (!isRecord(value) || !Array.isArray(value.shares) || !Array.isArray(value.grants) || value.shares.length > 65_536 || value.grants.length > 262_144)
      throw new ShareError("SHARE_INVALID", "share store shape is invalid")
    for (const item of value.shares) this.memory.put(parseShareReference(item))
    for (const item of value.grants) this.memory.putGrant(parseShareAccessGrant(item))
    this.loaded = true
  }

  /** Writes run one at a time, each from the memory as it is when its turn comes. */
  private flush(): Promise<void> {
    const next = this.writing.then(() => this.write())
    this.writing = next.catch(() => undefined)
    return next
  }

  private async write(): Promise<void> {
    const state: ShareState = {
      shares: await this.memory.list(),
      grants: (await this.memory.list()).flatMap((share) => this.memory.grants(share.shareId)),
    }
    const data = JSON.stringify(state)
    if (Buffer.byteLength(data, "utf8") > this.maxBytes) throw new ShareError("SHARE_LIMIT", "share store is too large")
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.path, data)
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && String((error as { readonly code: unknown }).code) === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
