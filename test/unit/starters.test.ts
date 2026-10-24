import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ISOLATED_BUN_FLAGS } from "../../src/isolated-bun.ts"
import { createStarterApp, DEFAULT_STARTER, parseNewCliArgs, RUNRAIL_STARTERS, runNewCli, StarterError } from "../../src/starters.ts"

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join("/tmp", "runrail-starters-"))
  folders.push(root)
  return root
}

/** A stand-in for Bun: `x --bun <creator> <name> ...` makes the app folder, `install` leaves a mark; each call records its BUN_OPTIONS. */
async function fakeBun(root: string, exitCode = 0): Promise<string> {
  const path = join(root, "fake-bun")
  await writeFile(path, [
    "#!/bin/sh",
    `echo "[$BUN_OPTIONS] $@" >> '${join(root, "calls")}'`,
    `if [ "$1" = x ]; then mkdir -p "$4" && echo '{"name":"'"$4"'"}' > "$4/package.json"; fi`,
    `if [ "$1" = install ]; then : > installed; fi`,
    `[ ${exitCode} -eq 0 ] || echo "creator broke" >&2`,
    `exit ${exitCode}`,
    "",
  ].join("\n"))
  await chmod(path, 0o755)
  return path
}

const expectCode = async (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code })

describe("starters", () => {
  test("Nifra is the default and the only one marked recommended, and says who makes it", () => {
    expect(DEFAULT_STARTER).toBe("nifra")
    expect(RUNRAIL_STARTERS.map((starter) => starter.id)).toEqual(["nifra", "vite", "next", "empty"])
    expect(RUNRAIL_STARTERS.filter((starter) => starter.recommended).map((starter) => starter.id)).toEqual(["nifra"])
    expect(RUNRAIL_STARTERS[0]!.maker).toBe("the authors of Runrail")
    // Each creator is pinned to the version Runrail was tested with.
    for (const starter of RUNRAIL_STARTERS) if (starter.creator !== undefined) expect(starter.creator).toMatch(/^create-[a-z-]+@\d+\.\d+\.\d+$/)
  })

  test("an empty app is a folder with a first commit", async () => {
    const root = await scratch()
    const result = await createStarterApp({ directory: join(root, "blank"), starter: "empty" })
    expect(result).toMatchObject({ starter: "empty", installed: false })
    if (result.committed) expect((await readFile(join(root, "blank", ".git", "HEAD"), "utf8")).trim()).toBe("ref: refs/heads/main")
    else expect(result.warnings.length).toBe(1)
  })

  test("a starter runs its pinned creator from the parent folder without that folder's Bun config, then installs in the app", async () => {
    const root = await scratch()
    const bun = await fakeBun(root)
    const steps: string[] = []
    const result = await createStarterApp({ directory: join(root, "shop"), starter: "vite", bun, onStep: (step) => steps.push(step) })
    expect(result).toMatchObject({ starter: "vite", installed: true })
    expect(steps).toEqual(["create", "install", "commit"])
    expect((await readFile(join(root, "calls"), "utf8")).trim().split("\n")).toEqual([`[${ISOLATED_BUN_FLAGS.join(" ")}] x --bun create-vite@9.2.1 shop --template react-ts --no-interactive --no-immediate`, "[] install"])
  })

  test("a creator that fails is reported with the end of its output", async () => {
    const root = await scratch()
    const failure = createStarterApp({ directory: join(root, "shop"), starter: "next", bun: await fakeBun(root, 3) })
    await expect(failure).rejects.toBeInstanceOf(StarterError)
    await failure.catch((error: StarterError) => {
      expect(error.code).toBe("STARTER_CREATE_FAILED")
      expect(error.output).toContain("creator broke")
    })
  })

  test("refuses a name npm would refuse, a missing parent, and a folder that is not empty", async () => {
    const root = await scratch()
    await expectCode(createStarterApp({ directory: join(root, "My App"), starter: "empty" }), "STARTER_NAME_INVALID")
    await expectCode(createStarterApp({ directory: join(root, "missing", "app"), starter: "empty" }), "STARTER_PARENT_MISSING")
    await mkdir(join(root, "taken"))
    await writeFile(join(root, "taken", "file"), "")
    await expectCode(createStarterApp({ directory: join(root, "taken"), starter: "empty" }), "STARTER_TARGET_EXISTS")
    await expectCode(createStarterApp({ directory: join(root, "app"), starter: "rails" as "empty" }), "STARTER_UNKNOWN")
  })
})

describe("runrail new", () => {
  test("parses a directory, a starter, and the list", () => {
    expect(parseNewCliArgs(["app"])).toEqual({ action: "create", directory: "app", install: true, json: false })
    expect(parseNewCliArgs(["app", "--starter", "next", "--no-install", "--json"])).toEqual({ action: "create", directory: "app", starter: "next", install: false, json: true })
    expect(parseNewCliArgs(["--list", "--json"])).toEqual({ action: "list", json: true })
    expect(() => parseNewCliArgs([])).toThrow("usage: runrail new")
    expect(() => parseNewCliArgs(["--list", "app"])).toThrow("usage: runrail new")
    expect(() => parseNewCliArgs(["app", "--starter", "rails"])).toThrow('unknown starter "rails"')
  })

  test("without --starter it says Nifra was picked, who makes it, and how to pick another", async () => {
    const root = await scratch()
    const notes: string[] = []
    const out: string[] = []
    // An invalid name stops it before anything runs, after the notice.
    const code = await runNewCli({ action: "create", directory: join(root, "Bad"), install: false, json: false }, { out: (line) => out.push(line), note: (line) => notes.push(line) })
    expect(code).toBe(1)
    expect(notes[0]).toBe("Starter: Nifra, by the authors of Runrail. --starter vite|next|empty picks another.")
  })

  test("--list shows every starter with its maker; --json gives the default too", async () => {
    const out: string[] = []
    await runNewCli({ action: "list", json: false }, { out: (line) => out.push(line), note: () => undefined })
    expect(out[0]).toStartWith("nifra  Nifra (recommended), by the authors of Runrail:")
    expect(out).toHaveLength(4)
    const json: string[] = []
    await runNewCli({ action: "list", json: true }, { out: (line) => json.push(line), note: () => undefined })
    expect(JSON.parse(json[0]!)).toMatchObject({ default: "nifra", starters: [{ id: "nifra", recommended: true }, { id: "vite" }, { id: "next" }, { id: "empty" }] })
  })
})
