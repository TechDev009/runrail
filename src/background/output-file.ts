import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, sep } from "node:path"

/**
 * The end of an output file a coding tool announced for one of its tasks. Only a regular file
 * under a temporary directory is read, so an announced path cannot point the reader elsewhere.
 */
export async function readAnnouncedOutput(path: string, maxBytes: number): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) throw new RangeError("output file is invalid")
  const real = await realpath(path)
  const roots = await temporaryRoots()
  if (!roots.some((root) => real.startsWith(root + sep))) throw new RangeError("output file is outside the temporary directory")
  // Checked on the open file itself, so a swap after the path was resolved changes nothing; and only
  // a file of this user, never another account's file left in the shared temporary directory.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new RangeError("output file is not a regular file")
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new RangeError("output file belongs to another user")
    const length = Math.min(info.size, maxBytes)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length)
    // Starting mid-file can split a character; the decoder replaces the partial one.
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: info.size > length }
  } finally {
    await handle.close()
  }
}

async function temporaryRoots(): Promise<readonly string[]> {
  const candidates = [tmpdir(), "/tmp", process.env.TMPDIR].filter((value): value is string => typeof value === "string" && value.length > 0)
  const resolved = await Promise.all(candidates.map((candidate) => realpath(candidate).catch(() => undefined)))
  return [...new Set(resolved.filter((value): value is string => value !== undefined && value !== "/"))]
}
