import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeCodeLaunchArguments, codexExecLaunchArguments, codexThreadParameters, parseHarnessLaunchOptions } from "../../src/harness/launch.ts"
import { defaultCodingPrompt } from "../../src/prompt/index.ts"
import { createRunrailSession } from "../../src/session.ts"
import { createRunCommandTool } from "../../src/tools/run-command.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function folder(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe("a policy with related folders", () => {
  test("relative paths stay in the root; a related folder is reached by absolute path and answers absolute paths", async () => {
    const root = await folder("runrail-folders-root-")
    const api = await folder("runrail-folders-api-")
    await writeFile(join(root, "a.txt"), "root")
    await mkdir(join(api, "src"))
    await writeFile(join(api, "src", "b.txt"), "api")
    const policy = await createWorkspacePolicy(root, [api])
    expect(policy.folders).toEqual([api])
    expect(await policy.read("a.txt")).toBe("root")
    expect(await policy.read(join(api, "src", "b.txt"))).toBe("api")
    // A relative path is never looked for in a related folder.
    await expect(policy.read("src/b.txt")).rejects.toThrow()
    expect(await policy.write(join(api, "src", "c.txt"), "new")).toEqual({ path: join(api, "src", "c.txt"), bytes: 3 })
    expect(await readFile(join(api, "src", "c.txt"), "utf8")).toBe("new")
    expect((await policy.list(api, 2)).map((entry) => entry.path)).toEqual([join(api, "src"), join(api, "src", "b.txt"), join(api, "src", "c.txt")])
    expect((await policy.search(api, "api")).map((match) => match.path)).toEqual([join(api, "src", "b.txt")])
    expect((await policy.list()).map((entry) => entry.path)).toEqual(["a.txt"])
  })

  test("the agent's file rules hold in a related folder, and anywhere else is refused", async () => {
    const root = await folder("runrail-folders-root-")
    const api = await folder("runrail-folders-api-")
    const other = await folder("runrail-folders-other-")
    await writeFile(join(api, ".env"), "TOKEN=x")
    await writeFile(join(other, "x.txt"), "x")
    const policy = await createWorkspacePolicy(root, [api])
    await expect(policy.read(join(api, ".env"))).rejects.toThrow("credential")
    await expect(policy.write(join(api, ".git", "config"), "x")).rejects.toThrow()
    await expect(policy.read(join(other, "x.txt"))).rejects.toThrow("escapes")
  })

  test("folders must be real directories that do not overlap", async () => {
    const root = await folder("runrail-folders-root-")
    const api = await folder("runrail-folders-api-")
    await mkdir(join(root, "inner"))
    await writeFile(join(api, "file.txt"), "x")
    await expect(createWorkspacePolicy(root, [join(root, "inner")])).rejects.toThrow("overlap")
    await expect(createWorkspacePolicy(join(root, "inner"), [root])).rejects.toThrow("overlap")
    await expect(createWorkspacePolicy(root, [api, api])).rejects.toThrow("overlap")
    await expect(createWorkspacePolicy(root, [join(api, "file.txt")])).rejects.toThrow("not a directory")
    await expect(createWorkspacePolicy(root, ["relative"])).rejects.toThrow("invalid")
    await expect(createWorkspacePolicy(root, Array.from({ length: 9 }, () => api))).rejects.toThrow("invalid")
  })

  test("run_command runs in a related folder when given cwd, and nowhere outside", async () => {
    const root = await folder("runrail-folders-root-")
    const api = await folder("runrail-folders-api-")
    const other = await folder("runrail-folders-other-")
    const tool = createRunCommandTool(await createWorkspacePolicy(root, [api]))
    const context = { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1]
    const ran = (await tool.execute({ program: "pwd", cwd: api }, context)) as { stdout?: string }
    expect(ran.stdout?.trim()).toBe(api)
    const home = (await tool.execute({ program: "pwd" }, context)) as { stdout?: string }
    expect(home.stdout?.trim()).toBe(root)
    await expect(tool.execute({ program: "pwd", cwd: other }, context)).rejects.toThrow()
  })
})

describe("related folders on each route", () => {
  test("Claude Code gets --add-dir, Codex writable roots, and a relative folder is refused", () => {
    const launch = parseHarnessLaunchOptions({ addDirs: ["/work/api", "/work/web"] })
    const claude = claudeCodeLaunchArguments(launch)
    expect(claude.slice(0, 4)).toEqual(["--add-dir", "/work/api", "--add-dir", "/work/web"])
    expect(codexThreadParameters(launch)).toEqual({ config: { "sandbox_workspace_write.writable_roots": ["/work/api", "/work/web"] } })
    expect(codexExecLaunchArguments(launch)).toEqual(["exec", "--json", "-c", 'sandbox_workspace_write.writable_roots=["/work/api","/work/web"]', "-"])
    expect(() => parseHarnessLaunchOptions({ addDirs: ["api"] })).toThrow("added folders are invalid")
    expect(() => parseHarnessLaunchOptions({ addDirs: ["--dangerously-skip-permissions"] })).toThrow("added folders are invalid")
  })

  test("the native prompt names them, and a route that cannot take them refuses them", async () => {
    const prompt = defaultCodingPrompt({ family: "anthropic", environment: { cwd: "/work/app", folders: ["/work/api"], platform: "macOS", date: "2026-10-10" }, tools: ["read_file", "run_command"] })
    expect(prompt).toContain("- Related folders: /work/api")
    expect(prompt).toContain("a file in one of the related folders listed under Environment is named by its absolute path")
    expect(prompt).toContain("(or in `cwd`, a folder inside a related folder)")
    expect(defaultCodingPrompt({ family: "anthropic", environment: { cwd: "/work/app", platform: "macOS", date: "2026-10-10" }, tools: ["read_file"] })).toContain("You cannot read or write outside it.")
    const root = await folder("runrail-folders-root-")
    const api = await folder("runrail-folders-api-")
    await expect(createRunrailSession({ cwd: root, folders: [api], backend: "replay", loadExtensions: false })).rejects.toThrow("FOLDERS_UNSUPPORTED_BACKEND")
    await expect(createRunrailSession({ cwd: root, folders: [api], backend: "codex", loadExtensions: false, harnessPersistent: true })).rejects.toThrow("FOLDERS_REQUIRE_VENDOR_COMMAND")
  })
})
