import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { MAX_SETUPS, parseSetup, SetupError, type Setup } from "./schema.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"
import { FileLockError, withFileLock } from "../auth/lock.ts"
import { readBoundedText } from "../runtime/bounded-read.ts"

/**
 * The person's setups in `~/.runrail/setups.json`, and a project's in `<project>/.runrail/setups.json`.
 * The person's win by id: a repository cannot change what one of their own setups runs by reusing
 * its id. A project's setups are edited in the repository, so this store never writes them.
 */

export interface StoredSetup extends Setup {
  readonly source: "user" | "project"
  /**
   * A project's setup that runs a check or gives a role full access runs only once the person trusts
   * this exact version of it: the repository wrote it, and could change it after a look.
   */
  readonly trust?: { readonly digest: string; readonly trusted: boolean }
}

export interface SetupListing {
  readonly setups: readonly StoredSetup[]
  /** Entries left out because they did not parse; their files are kept as they are. */
  readonly skipped: number
}

const MAX_FILE_BYTES = 1024 * 1024

export class SetupStore {
  #queue: Promise<unknown> = Promise.resolve()

  /** `trust` defaults to `setup-trust.json` beside the person's setups. */
  constructor(private readonly paths: { readonly user: string; readonly project?: string; readonly trust?: string }) {}

  async list(): Promise<SetupListing> {
    const user = await readSetups(this.paths.user)
    const project = this.paths.project === undefined ? { setups: [], skipped: 0 } : await readSetups(this.paths.project)
    const trusted = project.setups.some(needsTrust) ? await this.#trusted() : {}
    const byId = new Map<string, StoredSetup>()
    for (const setup of project.setups) {
      const digest = needsTrust(setup) ? setupDigest(setup) : undefined
      byId.set(setup.id, { ...setup, source: "project", ...(digest === undefined ? {} : { trust: { digest, trusted: trusted[this.#trustKey(setup.id)] === digest } }) })
    }
    for (const setup of user.setups) byId.set(setup.id, { ...setup, source: "user" })
    return { setups: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped: user.skipped + project.skipped }
  }

  /** The setup, refused when it is the project's and the person has not trusted this version of it. */
  async runnable(id: string): Promise<StoredSetup> {
    const setup = await this.get(id)
    if (setup.trust !== undefined && !setup.trust.trusted)
      throw new SetupError("SETUP_UNTRUSTED", `"${setup.name}" comes from this project and ${risk(setup)}; look it over and trust it before it runs`)
    return setup
  }

  /** Trusts the project's setup as it is now; `digest` is the version the person was shown. */
  trust(id: string, digest: unknown): Promise<StoredSetup> {
    return this.#serial(async () => {
      const setup = await this.get(id)
      if (setup.trust === undefined) throw new SetupError("SETUP_INVALID", "only a project's setup that runs a check or with full access needs trust")
      if (digest !== setup.trust.digest) throw new SetupError("SETUP_INVALID", "the setup changed since it was shown; look it over again")
      const trusted = { ...(await this.#trusted()), [this.#trustKey(id)]: setup.trust.digest }
      await mkdir(dirname(this.#trustPath()), { recursive: true })
      await writeFileAtomic(this.#trustPath(), `${JSON.stringify({ version: 1, trusted }, null, 2)}\n`)
      return { ...setup, trust: { digest: setup.trust.digest, trusted: true } }
    })
  }

  #trustPath(): string {
    return this.paths.trust ?? join(dirname(this.paths.user), "setup-trust.json")
  }

  #trustKey(id: string): string {
    return `${createHash("sha256").update(this.paths.project ?? "").digest("hex").slice(0, 32)}:${id}`
  }

  async #trusted(): Promise<Readonly<Record<string, string>>> {
    let text: string
    try {
      text = await readBoundedText(this.#trustPath(), MAX_FILE_BYTES)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw new SetupError("SETUP_STORE_FAILED", "the setup trust file could not be read")
    }
    try {
      const parsed = JSON.parse(text) as { trusted?: unknown }
      const trusted = parsed.trusted
      if (trusted === null || typeof trusted !== "object" || Array.isArray(trusted)) return {}
      return Object.fromEntries(Object.entries(trusted).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    } catch {
      throw new SetupError("SETUP_STORE_FAILED", "the setup trust file is not valid JSON")
    }
  }

  async get(id: string): Promise<StoredSetup> {
    const found = (await this.list()).setups.find((setup) => setup.id === id)
    if (found === undefined) throw new SetupError("SETUP_NOT_FOUND", "no setup has that id")
    return found
  }

  save(value: unknown): Promise<StoredSetup> {
    const setup = parseSetup(value)
    return this.#serial(async () => {
      if (await this.#fromProject(setup.id)) throw new SetupError("SETUP_READ_ONLY", "this setup comes from the project's .runrail/setups.json; edit it there")
      const current = await readRaw(this.paths.user)
      const others = current.filter((entry) => !(typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === setup.id))
      if (others.length >= MAX_SETUPS) throw new SetupError("SETUP_LIMIT", `at most ${String(MAX_SETUPS)} setups`)
      await writeSetups(this.paths.user, [...others, setup])
      return { ...setup, source: "user" as const }
    })
  }

  delete(id: string): Promise<{ readonly deleted: boolean }> {
    return this.#serial(async () => {
      if (await this.#fromProject(id)) throw new SetupError("SETUP_READ_ONLY", "this setup comes from the project's .runrail/setups.json; edit it there")
      const current = await readRaw(this.paths.user)
      const kept = current.filter((entry) => !(typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === id))
      if (kept.length === current.length) return { deleted: false }
      await writeSetups(this.paths.user, kept)
      return { deleted: true }
    })
  }

  /** Whether the setup with this id is the project's: the person has none of their own by that id. */
  async #fromProject(id: string): Promise<boolean> {
    if (this.paths.project === undefined) return false
    if ((await readSetups(this.paths.user)).setups.some((setup) => setup.id === id)) return false
    return (await readSetups(this.paths.project)).setups.some((setup) => setup.id === id)
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      try {
        return await withFileLock(`${this.paths.user}.lock`, work)
      } catch (error) {
        if (error instanceof FileLockError) throw new SetupError("SETUP_STORE_FAILED", "the setups file could not be locked")
        throw error
      }
    }
    const next = this.#queue.then(locked, locked)
    this.#queue = next.catch(() => undefined)
    return next
  }
}

function needsTrust(setup: Setup): boolean {
  return setup.rules.check !== undefined || roles(setup).some((role) => role.access === "full")
}

function risk(setup: Setup): string {
  const full = roles(setup).some((role) => role.access === "full")
  if (setup.rules.check !== undefined && full) return "runs a check command and gives a role full access"
  return full ? "gives a role full access" : "runs a check command"
}

function roles(setup: Setup): readonly { readonly access?: string }[] {
  return [setup.roles.planner, setup.roles.executor, setup.roles.reviewer].filter((role): role is NonNullable<typeof role> => role !== undefined)
}

/** The setup as parsed, so a reordered or reformatted file is the same version. */
function setupDigest(setup: Setup): string {
  return createHash("sha256").update(JSON.stringify(setup)).digest("hex")
}

async function readRaw(path: string): Promise<readonly unknown[]> {
  let text: string
  try {
    text = await readBoundedText(path, MAX_FILE_BYTES)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new SetupError("SETUP_STORE_FAILED", "the setups file could not be read")
  }
  try {
    const parsed = JSON.parse(text) as unknown
    const list = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { setups?: unknown }).setups : undefined
    return Array.isArray(list) ? list : []
  } catch {
    throw new SetupError("SETUP_STORE_FAILED", "the setups file is not valid JSON")
  }
}

async function readSetups(path: string): Promise<{ readonly setups: readonly Setup[]; readonly skipped: number }> {
  const raw = await readRaw(path)
  const setups: Setup[] = []
  for (const entry of raw.slice(0, MAX_SETUPS)) {
    try {
      setups.push(parseSetup(entry))
    } catch {
      // Counted below: a setup that no longer parses is shown as skipped, never guessed at.
    }
  }
  return { setups, skipped: raw.length - setups.length }
}

async function writeSetups(path: string, setups: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, `${JSON.stringify({ version: 1, setups }, null, 2)}\n`)
}
