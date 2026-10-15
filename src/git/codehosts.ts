import { mkdir, readFile, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { GIT_SERVICES, type GitRemoteHints, type GitService } from "./remote.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"

/**
 * Which service each git host is, as the person said, and which hosts they connected for pull
 * requests. One small file in the accounts folder, shared by every engine on the machine; it holds
 * no secret. A `gh` connection names only that the person's own `gh` sign-in may be used.
 */

export const MAX_CODE_HOSTS = 64
const HOST = /^(?=.{1,253}(:|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/

export interface CodeHostConnection {
  readonly via: "gh"
  readonly enabled: boolean
  readonly addedAt: number
}

export interface CodeHostRecord {
  readonly host: string
  readonly service?: GitService
  readonly connection?: CodeHostConnection
}

export interface CodeHostListing {
  readonly hosts: readonly CodeHostRecord[]
  /** The file was there but unreadable or malformed, and reads as empty. */
  readonly invalid: boolean
}

export class CodeHostError extends Error {
  constructor(message: string, readonly code: "invalid" | "limit" = "invalid") {
    super(message)
    this.name = "CodeHostError"
  }
}

/** A lowercase host name with an optional port; anything else is refused. */
export function parseCodeHost(value: unknown): string {
  if (typeof value !== "string") throw new CodeHostError("host must be a host name")
  const host = value.trim().toLowerCase()
  if (!HOST.test(host)) throw new CodeHostError("host must be a host name, optionally with a port")
  const port = host.includes(":") ? Number(host.slice(host.indexOf(":") + 1)) : undefined
  if (port !== undefined && (port < 1 || port > 65_535)) throw new CodeHostError("host port is out of range")
  return host
}

export function parseGitService(value: unknown): GitService {
  if (typeof value !== "string" || !(GIT_SERVICES as readonly string[]).includes(value)) throw new CodeHostError("service must be github, gitlab, bitbucket, or unknown")
  return value as GitService
}

export class CodeHostStore {
  readonly #file: string
  #cache: { readonly key: string; readonly listing: CodeHostListing } | undefined
  #writes: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.#file = file
  }

  async list(): Promise<CodeHostListing> {
    let key: string
    try {
      const info = await stat(this.#file)
      key = `${String(info.mtimeMs)}:${String(info.size)}`
    } catch {
      return { hosts: [], invalid: false }
    }
    if (this.#cache?.key === key) return this.#cache.listing
    let listing: CodeHostListing
    try {
      listing = { hosts: parseFile(JSON.parse(await readFile(this.#file, "utf8"))), invalid: false }
    } catch {
      listing = { hosts: [], invalid: true }
    }
    this.#cache = { key, listing }
    return listing
  }

  async hints(): Promise<GitRemoteHints> {
    const services = new Map<string, GitService>()
    for (const record of (await this.list()).hosts) if (record.service !== undefined) services.set(record.host, record.service)
    return { services }
  }

  /** The enabled connection for a host, if the person made one. */
  async connection(host: string): Promise<CodeHostConnection | undefined> {
    const record = (await this.list()).hosts.find((entry) => entry.host === host.toLowerCase())
    return record?.connection?.enabled === true ? record.connection : undefined
  }

  set(host: string, service: GitService): Promise<CodeHostRecord> {
    return this.#update(host, (record) => ({ ...record, service }))
  }

  connect(host: string, via: "gh", now = Date.now()): Promise<CodeHostRecord> {
    return this.#update(host, (record) => ({ ...record, connection: { via, enabled: true, addedAt: now } }))
  }

  disconnect(host: string): Promise<CodeHostRecord> {
    return this.#update(host, ({ connection: _gone, ...record }) => record)
  }

  #update(host: string, change: (record: CodeHostRecord) => CodeHostRecord): Promise<CodeHostRecord> {
    const next = this.#writes.then(async () => {
      const hosts = [...(await this.list()).hosts]
      const index = hosts.findIndex((entry) => entry.host === host)
      const updated = Object.freeze(change(index < 0 ? { host } : (hosts[index] as CodeHostRecord)))
      if (index < 0) {
        if (hosts.length >= MAX_CODE_HOSTS) throw new CodeHostError(`at most ${String(MAX_CODE_HOSTS)} hosts are kept`, "limit")
        hosts.push(updated)
      } else hosts[index] = updated
      const kept = hosts.filter((entry) => entry.service !== undefined || entry.connection !== undefined)
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      await writeFileAtomic(this.#file, `${JSON.stringify({ version: 1, hosts: kept }, null, 2)}\n`)
      this.#cache = undefined
      return updated
    })
    this.#writes = next.catch(() => undefined)
    return next
  }
}

function parseFile(value: unknown): readonly CodeHostRecord[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.hosts)) throw new Error("malformed")
  const hosts: CodeHostRecord[] = []
  for (const entry of value.hosts.slice(0, MAX_CODE_HOSTS)) {
    if (!isRecord(entry)) continue
    let host: string
    try {
      host = parseCodeHost(entry.host)
    } catch {
      continue
    }
    if (hosts.some((record) => record.host === host)) continue
    const service = typeof entry.service === "string" && (GIT_SERVICES as readonly string[]).includes(entry.service) ? (entry.service as GitService) : undefined
    const raw = entry.connection
    const connection = isRecord(raw) && raw.via === "gh" && typeof raw.enabled === "boolean" && typeof raw.addedAt === "number" && Number.isFinite(raw.addedAt)
      ? { via: "gh" as const, enabled: raw.enabled, addedAt: raw.addedAt }
      : undefined
    hosts.push(Object.freeze({ host, ...(service === undefined ? {} : { service }), ...(connection === undefined ? {} : { connection: Object.freeze(connection) }) }))
  }
  return Object.freeze(hosts)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
