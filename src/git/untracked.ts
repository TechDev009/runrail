import { lstat, open, readlink } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

export type UntrackedPatch =
  | { readonly kind: "text"; readonly patch: string; readonly additions: number }
  | { readonly kind: "binary" }
  | { readonly kind: "limit" }
  | { readonly kind: "unreadable" }

const BINARY_SNIFF_BYTES = 8_000

/**
 * Builds an added-file patch for an untracked path without spawning git. Symlinks are reported
 * by target text and never followed; non-regular files are unreadable.
 */
export async function untrackedPatch(root: string, path: string, maxBytes: number): Promise<UntrackedPatch> {
  const absolute = resolve(root, path)
  const rel = relative(resolve(root), absolute)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { kind: "unreadable" }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(absolute)
  } catch {
    return { kind: "unreadable" }
  }
  if (info.isSymbolicLink()) {
    try {
      const target = await readlink(absolute)
      return { kind: "text", patch: addedPatch(path, "120000", target, false), additions: 1 }
    } catch {
      return { kind: "unreadable" }
    }
  }
  if (!info.isFile()) return { kind: "unreadable" }
  if (info.size > maxBytes) return { kind: "limit" }
  const bytes = await readBounded(absolute, maxBytes)
  if (bytes === undefined) return { kind: "unreadable" }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary" }
  const text = new TextDecoder("utf-8").decode(bytes)
  const mode = (Number(info.mode) & 0o111) === 0 ? "100644" : "100755"
  if (text.length === 0) return { kind: "text", patch: `diff --git a/${path} b/${path}\nnew file mode ${mode}\n`, additions: 0 }
  const trailingNewline = text.endsWith("\n")
  const body = trailingNewline ? text.slice(0, -1) : text
  const patch = addedPatch(path, mode, body, trailingNewline)
  return { kind: "text", patch, additions: body.split("\n").length }
}

function addedPatch(path: string, mode: string, body: string, trailingNewline: boolean): string {
  const lines = body.split("\n")
  const hunk = lines.map((line) => `+${line}`).join("\n")
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@`,
    hunk,
    ...(trailingNewline ? [] : ["\\ No newline at end of file"]),
  ].join("\n") + "\n"
}

async function readBounded(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, "r")
    const buffer = new Uint8Array(maxBytes + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) return undefined
    return buffer.subarray(0, offset)
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}
