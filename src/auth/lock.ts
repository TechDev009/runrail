import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises"
import { dirname } from "node:path"

const HELD_KEY = Symbol.for("runrail.file-lock.held")

export type FileLockErrorCode = "LOCK_TIMEOUT" | "LOCK_CANCELLED" | "LOCK_UNAVAILABLE"

export class FileLockError extends Error {
  constructor(readonly code: FileLockErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "FileLockError"
  }
}

export interface FileLockOptions {
  /** How long to wait for another holder. Default 15 seconds. */
  readonly timeoutMs?: number
  /** How long a lock in another process may go without its holder renewing it before it is taken over. Default 30 seconds. */
  readonly staleMs?: number
  readonly pollMs?: number
  readonly signal?: AbortSignal
}

/**
 * Runs `run` while holding an exclusive lock file shared by every process on this machine.
 *
 * Several engines run at once and share one accounts directory, so a refresh token or an account
 * file must have one writer at a time. The lock is a file created with `wx` that its holder renews
 * while it runs. A holder that died is detected by its process id; one in another process that
 * stopped renewing for `staleMs` (a reused id, or a hung process) is taken over. A holder in this
 * process is never taken over while it runs.
 */
export async function withFileLock<T>(path: string, run: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = bounded(options.timeoutMs ?? 15_000, 1, 120_000, "lock timeout")
  const staleMs = bounded(options.staleMs ?? 30_000, 100, 600_000, "lock stale age")
  const pollMs = bounded(options.pollMs ?? 25, 1, 1_000, "lock poll interval")
  const owner = `${process.pid}:${randomBytes(8).toString("hex")}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Known as live before the file names it: a waiter here that read the file in between would
  // otherwise take this holder for a crashed one and remove its lock.
  HELD_HERE.add(owner)
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (options.signal?.aborted === true) throw new FileLockError("LOCK_CANCELLED", "lock wait was cancelled")
      if (await acquire(path, owner)) break
      await takeOverIfAbandoned(path, staleMs)
      if (Date.now() >= deadline) throw new FileLockError("LOCK_TIMEOUT", "lock is held by another process")
      await delay(pollMs)
    }
    const renew = setInterval(() => void renewIfOurs(path, owner), Math.max(10, Math.floor(staleMs / 3)))
    renew.unref?.()
    try {
      return await run()
    } finally {
      clearInterval(renew)
      await release(path, owner)
    }
  } finally {
    HELD_HERE.delete(owner)
  }
}

/**
 * Owners holding a lock in this process right now, so a live holder here is known for certain.
 * Kept on the global object: a second copy of this module in the process must see the same holders.
 */
const HELD_HERE: Set<string> = ((globalThis as { [HELD_KEY]?: Set<string> })[HELD_KEY] ??= new Set<string>())

async function renewIfOurs(path: string, owner: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) !== owner) return
    const now = new Date()
    await utimes(path, now, now)
  } catch {
    // Released already; the next renewal finds nothing to do.
  }
}

async function acquire(path: string, owner: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, "wx", 0o600)
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw new FileLockError("LOCK_UNAVAILABLE", "lock file cannot be created")
  }
  try {
    await handle.writeFile(owner, "utf8")
  } finally {
    await handle.close()
  }
  return true
}

async function takeOverIfAbandoned(path: string, staleMs: number): Promise<void> {
  let observed: string
  let modifiedAt: number
  try {
    observed = await readFile(path, "utf8")
    modifiedAt = (await stat(path)).mtimeMs
  } catch {
    return
  }
  const pid = Number.parseInt(observed.split(":")[0] ?? "", 10)
  // Same process id, unknown owner: a crashed earlier process that had this id.
  if (pid === process.pid && HELD_HERE.has(observed)) return
  const holderGone = pid === process.pid || (Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid))
  if (!holderGone && Date.now() - modifiedAt < staleMs) return
  // Another waiter may have taken over between the read above and this point. The lock is removed
  // only while it still names the abandoned holder, which narrows that window to the two calls below.
  try {
    if ((await readFile(path, "utf8")) === observed) await unlink(path)
  } catch {
    // Already released or taken over.
  }
}

async function release(path: string, owner: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === owner) await unlink(path)
  } catch {
    // The lock was taken over after going stale; there is nothing of ours left to remove.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists under another user.
    return errorCode(error) === "EPERM"
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as { readonly code: unknown }).code) : undefined
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new FileLockError("LOCK_UNAVAILABLE", `${name} is invalid`)
  return value
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
