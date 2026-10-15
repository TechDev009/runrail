import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * A random id for this installation, created on first use and kept in `<root>/installation-id`.
 * It identifies nothing but the install: no hardware, user, or host name goes into it. Vendors that
 * register a client per installation ask for one.
 */
export async function installationId(root: string): Promise<string> {
  const path = join(root, "installation-id")
  const existing = await read(path)
  if (existing !== undefined) return existing
  await mkdir(root, { recursive: true, mode: 0o700 })
  const created = randomUUID().toLowerCase()
  // Written in full beside the target first, so no reader ever finds a half-written id.
  const draft = `${path}.${randomUUID()}.tmp`
  await writeFile(draft, `${created}\n`, { flag: "wx", mode: 0o600 })
  try {
    try {
      // A link appears whole or not at all: when two engines start together, one wins and the other reads the winner's id.
      await link(draft, path)
      return created
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error
    }
    const winner = await read(path)
    if (winner !== undefined) return winner
    // The file is there but unusable (hand-edited or cut short): replace it.
    await rename(draft, path)
    return created
  } finally {
    await rm(draft, { force: true })
  }
}

async function read(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, "utf8")).trim()
    return UUID.test(text) ? text : undefined
  } catch {
    return undefined
  }
}
