import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveCodexCommand } from "../../src/index.ts"

let root: string
let counter = 0

/** A one-file stand-in that answers `--version` like the Codex CLI. */
async function fakeCodex(output: string, options: { readonly name?: string; readonly mode?: number } = {}): Promise<{ readonly directory: string; readonly path: string }> {
  counter += 1
  const directory = join(root, `copy-${counter}`)
  await mkdir(directory)
  const path = join(directory, options.name ?? "codex")
  await writeFile(path, `#!/bin/sh\necho '${output}'\n`)
  await chmod(path, options.mode ?? 0o755)
  return { directory, path }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-codex-command-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("which Codex CLI a thread runs", () => {
  test("a strictly newer app copy wins over PATH, an older or equal one does not", async () => {
    const onPath = await fakeCodex("codex-cli 0.155.1")
    const newer = await fakeCodex("codex-cli 0.160.0")
    const equal = await fakeCodex("codex-cli 0.155.1")
    const older = await fakeCodex("codex-cli 0.150.9")
    const env = { PATH: onPath.directory }
    expect(await resolveCodexCommand({ env, appCommands: [older.path, newer.path] })).toBe(newer.path)
    expect(await resolveCodexCommand({ env, appCommands: [equal.path, older.path] })).toBe("codex")
    expect(await resolveCodexCommand({ env, appCommands: [] })).toBe("codex")
  })

  test("a pre-release sorts below its release", async () => {
    const onPath = await fakeCodex("codex-cli 0.160.0")
    const alpha = await fakeCodex("codex-cli 0.160.0-alpha.3")
    const next = await fakeCodex("codex-cli 0.161.0-alpha.1")
    const env = { PATH: onPath.directory }
    expect(await resolveCodexCommand({ env, appCommands: [alpha.path] })).toBe("codex")
    expect(await resolveCodexCommand({ env, appCommands: [alpha.path, next.path] })).toBe(next.path)
  })

  test("with nothing on PATH the app copy is used, and with nothing at all the bare name stays", async () => {
    const empty = await mkdtemp(join(root, "empty-"))
    const app = await fakeCodex("codex-cli 0.159.2")
    expect(await resolveCodexCommand({ env: { PATH: empty }, appCommands: [app.path] })).toBe(app.path)
    expect(await resolveCodexCommand({ env: { PATH: empty }, appCommands: [join(empty, "missing")] })).toBe("codex")
  })

  test("an app copy that is writable by others, not Codex, or not a file is never chosen", async () => {
    const onPath = await fakeCodex("codex-cli 0.155.1")
    const writable = await fakeCodex("codex-cli 9.0.0", { mode: 0o777 })
    const groupWritable = await fakeCodex("codex-cli 9.0.0", { mode: 0o775 })
    const impostor = await fakeCodex("other-tool 9.0.0")
    const env = { PATH: onPath.directory }
    expect(await resolveCodexCommand({ env, appCommands: [writable.path, groupWritable.path, impostor.path, root] })).toBe("codex")
  })

  test("a PATH install whose version cannot be read is kept", async () => {
    const wrapper = await fakeCodex("my wrapper")
    const app = await fakeCodex("codex-cli 0.160.0")
    expect(await resolveCodexCommand({ env: { PATH: wrapper.directory }, appCommands: [app.path] })).toBe("codex")
  })

  test("an updated copy is asked again", async () => {
    const onPath = await fakeCodex("codex-cli 0.158.0")
    const app = await fakeCodex("codex-cli 0.157.0")
    const env = { PATH: onPath.directory }
    expect(await resolveCodexCommand({ env, appCommands: [app.path] })).toBe("codex")
    await writeFile(app.path, "#!/bin/sh\necho 'codex-cli 0.160.0'\n")
    await chmod(app.path, 0o755)
    // Linux moves file times once a kernel tick, so a rewrite this quick can keep the old time; a real update lands later.
    await utimes(app.path, new Date(), new Date(Date.now() + 60_000))
    expect(await resolveCodexCommand({ env, appCommands: [app.path] })).toBe(app.path)
  })

  test("tests and RUNRAIL_CODEX_APP_SEARCH=off never look in the app", async () => {
    expect(process.env.RUNRAIL_CODEX_APP_SEARCH).toBe("off")
    const empty = await mkdtemp(join(root, "empty-"))
    expect(await resolveCodexCommand({ env: { PATH: empty } })).toBe("codex")
  })
})
