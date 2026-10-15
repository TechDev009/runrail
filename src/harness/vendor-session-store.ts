import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isMessageMark, isVendorSessionId } from "./launch.ts"

/**
 * Remembers which vendor conversation a Runrail session continues. A coding CLI keeps its own
 * history under its own id; without this a new engine process would start that CLI from nothing.
 * Only the two ids are stored: no prompt, output, or credential.
 */
export interface VendorSessionStore {
  load(sessionId: string): Promise<string | undefined>
  /** The stored conversation, and whether it is still another program's and must be forked before it is continued. */
  entry?(sessionId: string): Promise<VendorSessionEntry | undefined>
  /** `undefined` forgets the vendor session. */
  save(sessionId: string, vendorSessionId: string | undefined, options?: VendorSessionSaveOptions): Promise<void>
}

export interface VendorSessionEntry {
  readonly vendorSessionId: string
  readonly fork: boolean
  /** With `fork`: continue the copy from this message on, dropping what came after it (a rewind). */
  readonly at?: string
}

export interface VendorSessionSaveOptions {
  /**
   * The conversation belongs to the tool's own history (a session started outside Runrail): the
   * first turn continues a copy, and the copy's id replaces this one, so that history is never written.
   */
  readonly fork?: boolean
  /** Continue from this message of the conversation, as Claude Code's `--resume-session-at` does. */
  readonly at?: string
}

/** The stored entry; a store that keeps no fork marks continues what it holds. */
export async function vendorSessionEntry(store: VendorSessionStore | undefined, sessionId: string): Promise<VendorSessionEntry | undefined> {
  if (store === undefined) return undefined
  if (store.entry !== undefined) return store.entry(sessionId)
  const vendorSessionId = await store.load(sessionId)
  return isVendorSessionId(vendorSessionId) ? Object.freeze({ vendorSessionId, fork: false }) : undefined
}

const BACKEND = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32)
}

/**
 * Forgets every vendor conversation `sessionId` kept in `directory`, whichever tool or account
 * folder it was for, so the next turn starts the tool afresh (a rewind). Returns how many.
 */
export async function forgetVendorSessions(directory: string, sessionId: string): Promise<number> {
  const suffix = `-${sessionKey(sessionId)}.json`
  const names = await readdir(directory).catch(() => [] as string[])
  const ours = names.filter((name) => name.endsWith(suffix))
  await Promise.all(ours.map((name) => rm(join(directory, name), { force: true })))
  return ours.length
}
const MAX_FILE_BYTES = 4_096

export function createFileVendorSessionStore(directory: string, backend: string): VendorSessionStore {
  if (typeof directory !== "string" || directory.length === 0 || directory.length > 4_096 || directory.includes("\0")) throw new Error("vendor session directory is invalid")
  if (typeof backend !== "string" || !BACKEND.test(backend)) throw new Error("vendor session backend is invalid")
  const path = (sessionId: string): string => join(directory, `${backend.replace(/[^A-Za-z0-9-]/g, "-")}-${sessionKey(sessionId)}.json`)
  const entry = async (sessionId: string): Promise<VendorSessionEntry | undefined> => {
    let text: string
    try {
      text = await readFile(path(sessionId), "utf8")
    } catch {
      return undefined
    }
    if (text.length > MAX_FILE_BYTES) return undefined
    try {
      const value = JSON.parse(text) as unknown
      if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
      const record = value as Record<string, unknown>
      if (record.version !== 1 || record.backend !== backend || record.sessionId !== sessionId || !isVendorSessionId(record.vendorSessionId)) return undefined
      const fork = record.fork === true
      return Object.freeze({ vendorSessionId: record.vendorSessionId, fork, ...(fork && isMessageMark(record.at) ? { at: record.at } : {}) })
    } catch {
      return undefined
    }
  }
  return {
    entry,
    async load(sessionId) {
      return (await entry(sessionId))?.vendorSessionId
    },
    async save(sessionId, vendorSessionId, options) {
      const target = path(sessionId)
      if (vendorSessionId === undefined) {
        await rm(target, { force: true })
        return
      }
      if (!isVendorSessionId(vendorSessionId)) throw new Error("vendor session id is invalid")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`
      try {
        const at = options?.fork === true && isMessageMark(options.at) ? { at: options.at } : {}
        await writeFile(temporary, `${JSON.stringify({ version: 1, backend, sessionId, vendorSessionId, ...(options?.fork === true ? { fork: true } : {}), ...at })}\n`, { mode: 0o600, flag: "wx" })
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
  }
}
