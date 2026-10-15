import { createHash, randomBytes } from "node:crypto"
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { DEFAULT_MAX_FILE_BYTES, type WorkspacePolicy } from "./policy.ts"

/**
 * The person's own edit from the desktop's file view. It is saved only over the
 * text they opened: a file the agent, or anything else, changed since answers a conflict instead
 * of being overwritten. The agent's file rules hold here too, so git's and Runrail's own files and
 * credential files stay out of reach.
 */

export class WorkspaceEditError extends Error {
  constructor(
    readonly code: "WORKSPACE_EDIT_CONFLICT" | "WORKSPACE_EDIT_NOT_TEXT",
    message: string,
  ) {
    super(message)
    this.name = "WorkspaceEditError"
  }
}

/** What `workspace.read` hands out and `workspace.write` checks against: the text's SHA-256. */
export function textHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export async function saveOverRead(policy: WorkspacePolicy, path: string, content: string, baseHash: string): Promise<{ readonly path: string; readonly bytes: number; readonly hash: string }> {
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes > DEFAULT_MAX_FILE_BYTES) throw new RangeError("workspace write exceeds byte limit")
  // Checks the path the way an agent's write would: inside the workspace, no symlink out, not a control or credential file.
  const target = await policy.resolveForWrite(path)
  const current = await policy.read(path, DEFAULT_MAX_FILE_BYTES)
  // Text that does not survive decoding would lose its bytes on save.
  if (!Buffer.from(current, "utf8").equals(await readFile(target))) throw new WorkspaceEditError("WORKSPACE_EDIT_NOT_TEXT", "the file is not UTF-8 text")
  if (textHash(current) !== baseHash) throw new WorkspaceEditError("WORKSPACE_EDIT_CONFLICT", "the file changed since it was opened")
  const mode = (await lstat(target)).mode & 0o7777
  // Beside the file, then over it, so a reader never sees half of it.
  const temp = join(dirname(target), `.${basename(target)}.runrail-${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await chmod(temp, mode)
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return { path, bytes, hash: textHash(content) }
}
