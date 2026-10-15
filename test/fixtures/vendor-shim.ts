import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const VENDOR_CLI = new URL("./vendor-cli.ts", import.meta.url).pathname

export interface VendorShims {
  /** Directory that holds the shims; put it first on PATH to stand in for the installed CLIs. */
  readonly directory: string
  /** Write one executable named `name` that runs `fixture` with `fixtureArgs` before its own arguments. */
  add(name: string, fixtureArgs: readonly string[], fixture?: string): Promise<string>
  remove(): Promise<void>
}

/**
 * Fake vendor binaries as single executable paths. Runrail drives a vendor CLI only when it is
 * given a bare command with no prefix arguments, so a test double has to be one file too.
 */
export async function createVendorShims(): Promise<VendorShims> {
  const directory = await mkdtemp(join(tmpdir(), "runrail-vendor-"))
  return {
    directory,
    async add(name, fixtureArgs, fixture = VENDOR_CLI) {
      const path = join(directory, name)
      const quoted = [process.execPath, fixture, ...fixtureArgs].map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ")
      await writeFile(path, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 })
      await chmod(path, 0o755)
      return path
    },
    async remove() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}
