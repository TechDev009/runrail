import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isNifraProject, nifraApplies, nifraNotice, nifraSettingFromEnvironment } from "../../src/nifra.ts"

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join("/tmp", "runrail-nifra-project-"))
  folders.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

const manifest = (value: unknown) => ({ "package.json": JSON.stringify(value) })

describe("isNifraProject", () => {
  test.each([
    ["a @nifrajs dependency", manifest({ dependencies: { "@nifrajs/core": "5.3.0" } })],
    ["a nifra dev dependency", manifest({ devDependencies: { nifra: "5.3.0" } })],
    ["a @nifrajs peer dependency", manifest({ peerDependencies: { "@nifrajs/agent": "^5" } })],
    ["a nifra setting", manifest({ nifra: { kind: "api" } })],
    ["a Nifra config file", { "nifra.config.ts": "export default {}" }],
    ["a nifra.check.json", { "nifra.check.json": "{}" }],
    ["a framework file", { "backend/framework.ts": "export {}" }],
    ["a manifest that does not parse", { "package.json": "{ not json" }],
  ])("%s makes a Nifra project", async (_name, files) => {
    expect(isNifraProject(await project(files))).toBe(true)
  })

  test.each([
    ["other dependencies", manifest({ dependencies: { react: "19.2.0" }, devDependencies: { typescript: "5.9.3" } })],
    ["a name that only starts with nifra", manifest({ dependencies: { "nifra-like": "1.0.0" } })],
    ["no package.json", { "src/index.ts": "export {}" }],
  ])("%s is not a Nifra project", async (_name, files) => {
    expect(isNifraProject(await project(files))).toBe(false)
  })

  test("a folder without a package.json takes the nearest one above it", async () => {
    const root = await project({ ...manifest({ dependencies: { "@nifrajs/core": "5.3.0" } }), "src/lib/a.ts": "" })
    expect(isNifraProject(join(root, "src", "lib"))).toBe(true)
  })

  test("a nested package that names no Nifra package is another project", async () => {
    const root = await project({ ...manifest({ dependencies: { "@nifrajs/core": "5.3.0" } }), "tools/site/package.json": JSON.stringify({ dependencies: { vite: "7.1.0" } }) })
    expect(isNifraProject(join(root, "tools", "site"))).toBe(false)
  })
})

describe("the Nifra switch", () => {
  test("RUNRAIL_NIFRA turns Nifra on or off for every session; anything else leaves it to the project", () => {
    for (const value of ["off", "OFF", "0", "false"]) expect(nifraSettingFromEnvironment(value)).toBe(false)
    for (const value of ["on", "1", "true"]) expect(nifraSettingFromEnvironment(value)).toBe(true)
    for (const value of [undefined, "", "maybe"]) expect(nifraSettingFromEnvironment(value)).toBeUndefined()
  })

  test("the session's own setting wins, then the environment, then the project", async () => {
    const nifra = await project(manifest({ dependencies: { "@nifrajs/core": "5.3.0" } }))
    const other = await project(manifest({ dependencies: { react: "19.2.0" } }))
    const saved = process.env.RUNRAIL_NIFRA
    try {
      delete process.env.RUNRAIL_NIFRA
      expect([nifraApplies(undefined, nifra), nifraApplies(undefined, other)]).toEqual([true, false])
      expect([nifraApplies(false, nifra), nifraApplies(true, other)]).toEqual([false, true])
      process.env.RUNRAIL_NIFRA = "off"
      expect([nifraApplies(undefined, nifra), nifraApplies(true, nifra)]).toEqual([false, true])
    } finally {
      if (saved === undefined) delete process.env.RUNRAIL_NIFRA
      else process.env.RUNRAIL_NIFRA = saved
    }
  })

  test("the notice says who makes Nifra, what it adds, and how to turn it off", () => {
    expect(nifraNotice({ mcp: false, pi: false, check: false })).toBeUndefined()
    const notice = nifraNotice({ mcp: true, pi: false, check: true })
    expect(notice).toContain("by the authors of Runrail")
    expect(notice).toContain("`nifra mcp` tools")
    expect(notice).toContain("`nifra check`")
    expect(notice).toContain("--no-nifra or RUNRAIL_NIFRA=off")
  })
})
