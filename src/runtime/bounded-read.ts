import { constants } from "node:fs"
import { open } from "node:fs/promises"

export class BoundedReadError extends Error {
  constructor(readonly path: string) {
    super("file exceeds its size limit")
    this.name = "BoundedReadError"
  }
}

/**
 * Reads a UTF-8 file of at most `maxBytes`, refusing a larger one before its contents are held.
 * The bytes actually read are checked too: a file that grew after its size was taken is refused.
 */
export async function readBoundedText(path: string, maxBytes: number, options: { readonly noFollow?: boolean } = {}): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new BoundedReadError(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (options.noFollow === true ? constants.O_NOFOLLOW : 0))
  try {
    const entry = await handle.stat()
    if (!entry.isFile()) throw new Error("file is not regular")
    const size = entry.size
    if (size > maxBytes) throw new BoundedReadError(path)
    const buffer = Buffer.alloc(size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > size) throw new BoundedReadError(path)
    return buffer.subarray(0, length).toString("utf8")
  } finally {
    await handle.close()
  }
}
