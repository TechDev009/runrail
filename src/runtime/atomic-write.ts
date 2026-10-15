import { randomBytes } from "node:crypto"
import { chmod, rename, unlink, writeFile } from "node:fs/promises"

/**
 * Writes `data` beside `path` under a name no other writer can pick, then renames it over `path`,
 * so a reader sees the old file or the new one and two writers never share a draft.
 */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode, flag: "wx" })
    // The mode given to writeFile is narrowed by the umask; the file must end up exactly this.
    await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
