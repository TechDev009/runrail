import { lstat, mkdir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export class ContainedPathError extends Error {
  constructor() {
    super("path is not an unlinked path inside its root")
    this.name = "ContainedPathError"
  }
}

/**
 * Resolve OS aliases above the caller-owned root, but refuse links at or below it.
 * Missing suffixes are checked before any mkdir/write. This is not an openat sandbox
 * against an adversary concurrently replacing ancestor directories.
 */
export async function containedPath(root: string, path: string): Promise<string> {
  const anchor = resolve(root)
  const suffix = relative(anchor, resolve(path))
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new ContainedPathError()
  let existing = anchor
  const missing: string[] = []
  for (;;) {
    try {
      const entry = await lstat(existing)
      if (existing === anchor ? entry.isSymbolicLink() || !entry.isDirectory() : !(await stat(existing)).isDirectory()) throw new ContainedPathError()
      break
    } catch (error) {
      if (!isMissing(error)) throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(relative(parent, existing))
      existing = parent
    }
  }
  const canonicalRoot = join(await realpath(existing), ...missing)
  const candidate = resolve(canonicalRoot, suffix)
  let current = canonicalRoot
  const parts = suffix.length === 0 ? [] : suffix.split(sep)
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())) throw new ContainedPathError()
    } catch (error) {
      if (!isMissing(error)) throw error
      break
    }
  }
  return candidate
}

export async function ensureContainedDirectory(root: string, directory: string, mode = 0o700): Promise<string> {
  const safe = await containedPath(root, directory)
  await mkdir(safe, { recursive: true, mode })
  const verified = await containedPath(root, directory)
  if (!(await lstat(verified)).isDirectory()) throw new ContainedPathError()
  return verified
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
