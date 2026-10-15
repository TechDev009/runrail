import { randomBytes } from "node:crypto"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeContractError, boundedNativeId } from "../native/errors.ts"
import { parseNativeTaskRecord, type NativeTaskRecord, type NativeTaskStore } from "./types.ts"
import { BoundedReadError, readBoundedText } from "../runtime/bounded-read.ts"

export class InMemoryNativeTaskStore implements NativeTaskStore {
  private readonly tasks = new Map<string, NativeTaskRecord>()
  private readonly maxTasks: number

  constructor(options: { readonly maxTasks?: number } = {}) {
    const maxTasks = options.maxTasks ?? 4_096
    if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 65_536) throw new NativeContractError("NATIVE_LIMIT", "task store limit is invalid")
    this.maxTasks = maxTasks
  }

  get(taskId: string): NativeTaskRecord | undefined {
    return this.tasks.get(boundedNativeId(taskId, "task id"))
  }

  put(task: NativeTaskRecord): void {
    const parsed = parseNativeTaskRecord(task)
    if (!this.tasks.has(parsed.taskId) && this.tasks.size >= this.maxTasks) throw new NativeContractError("NATIVE_LIMIT", "task store is full")
    this.tasks.set(parsed.taskId, parsed)
  }

  delete(taskId: string): void {
    this.tasks.delete(boundedNativeId(taskId, "task id"))
  }

  list(projectId?: string): readonly NativeTaskRecord[] {
    const selected = projectId === undefined ? undefined : boundedNativeId(projectId, "project id")
    return Object.freeze([...this.tasks.values()].filter((task) => selected === undefined || task.projectId === selected).sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId)))
  }
}

export class FileNativeTaskStore implements NativeTaskStore {
  private readonly root: string
  private readonly maxBytes: number
  private memory: InMemoryNativeTaskStore
  private readonly maxTasks: number
  private loading: Promise<void> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(options: { readonly root: string; readonly maxTasks?: number; readonly maxBytes?: number }) {
    if (typeof options.root !== "string" || options.root.length === 0 || options.root.length > 4_096 || !options.root.startsWith("/")) throw new NativeContractError("NATIVE_INVALID", "task store root is invalid")
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 64 * 1024 * 1024) throw new NativeContractError("NATIVE_LIMIT", "task store byte limit is invalid")
    this.root = options.root
    this.maxBytes = maxBytes
    this.maxTasks = options.maxTasks ?? 4_096
    this.memory = new InMemoryNativeTaskStore({ maxTasks: options.maxTasks })
  }

  async get(taskId: string): Promise<NativeTaskRecord | undefined> {
    await this.ensureLoaded()
    return this.memory.get(taskId)
  }

  async put(task: NativeTaskRecord): Promise<void> {
    await this.ensureLoaded()
    const parsed = parseNativeTaskRecord(task)
    await this.change((staged) => staged.put(parsed))
  }

  async delete(taskId: string): Promise<void> {
    await this.ensureLoaded()
    const id = boundedNativeId(taskId, "task id")
    await this.change((staged) => staged.delete(id))
  }

  async list(projectId?: string): Promise<readonly NativeTaskRecord[]> {
    await this.ensureLoaded()
    return this.memory.list(projectId)
  }

  /** Every caller waits on the one read; a failed read is tried again, and nothing is written over the file meanwhile. */
  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  private async load(): Promise<void> {
    const path = join(this.root, "tasks.json")
    let text: string
    try {
      text = await readBoundedText(path, this.maxBytes)
    } catch (error) {
      if (isNotFound(error)) return
      if (error instanceof BoundedReadError) throw new NativeContractError("NATIVE_LIMIT", "task store is too large")
      throw new NativeContractError("NATIVE_STATE_CONFLICT", "task store cannot be read")
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new NativeContractError("NATIVE_INVALID", "task store JSON is invalid")
    }
    if (!Array.isArray(value) || value.length > 65_536) throw new NativeContractError("NATIVE_INVALID", "task store shape is invalid")
    const records = value.map((item) => parseNativeTaskRecord(item))
    const staged = new InMemoryNativeTaskStore({ maxTasks: this.maxTasks })
    for (const record of records) staged.put(record)
    this.memory = staged
  }

  /** Stage each change in queue order and publish it only after persistence succeeds. */
  private change(apply: (staged: InMemoryNativeTaskStore) => void): Promise<void> {
    const next = this.writing.then(async () => {
      const staged = new InMemoryNativeTaskStore({ maxTasks: this.maxTasks })
      for (const task of this.memory.list()) staged.put(task)
      apply(staged)
      const data = JSON.stringify(staged.list())
      if (Buffer.byteLength(data, "utf8") > this.maxBytes) throw new NativeContractError("NATIVE_LIMIT", "task store is too large")
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const temporary = join(this.root, `tasks.${randomBytes(8).toString("hex")}.tmp`)
      try {
        await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" })
        await rename(temporary, join(this.root, "tasks.json"))
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      this.memory = staged
    })
    this.writing = next.catch(() => undefined)
    return next
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && String((error as { readonly code: unknown }).code) === "ENOENT"
}
