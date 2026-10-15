import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createToolCatalog } from "../../src/tools/catalog.ts"
import { toolInputSchema } from "../../src/tools/schemas.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"
import { createRunrailSession } from "../../src/session.ts"

describe("bounded native tools", () => {
  test("declares a closed input schema for every first-party tool", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-native-tools-"))
    try {
      for (const tool of createToolCatalog(await createWorkspacePolicy(root), { allowWrite: true })) {
        const schema = toolInputSchema(tool.name)
        expect({ tool: tool.name, closed: schema.additionalProperties }).toEqual({ tool: tool.name, closed: false })
      }
      expect(toolInputSchema("plugin_tool")).toEqual({ type: "object", additionalProperties: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("supports write, unique edit, listing, finding, and searching", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-native-tools-"))
    try {
      await writeFile(join(root, "index.ts"), "const answer = 1\n")
      await writeFile(join(root, ".env"), "SECRET=hidden\n")
      const policy = await createWorkspacePolicy(root)
      const tools = createToolCatalog(policy, { allowWrite: true })
      const context = { cwd: root, signal: new AbortController().signal }
      const write = tools.find((tool) => tool.name === "write_file")!
      const edit = tools.find((tool) => tool.name === "edit_file")!
      const list = tools.find((tool) => tool.name === "list_files")!
      const find = tools.find((tool) => tool.name === "find_files")!
      const search = tools.find((tool) => tool.name === "search_files")!
      await write.execute({ path: "notes.txt", content: "answer: 1\n" }, context)
      await edit.execute({ path: "notes.txt", oldText: "1", newText: "42" }, context)
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("answer: 42\n")
      // Replacement patterns are text, with and without replaceAll.
      for (const replaceAll of [false, true]) {
        await write.execute({ path: "dollars.sh", content: "echo OLD\n" }, context)
        await edit.execute({ path: "dollars.sh", oldText: "OLD", newText: "$$ $& $` $' $1", replaceAll }, context)
        expect(await readFile(join(root, "dollars.sh"), "utf8")).toBe("echo $$ $& $` $' $1\n")
      }
      // Many small matches times a large replacement is refused before the result is built.
      await write.execute({ path: "many.txt", content: "a".repeat(100_000) }, context)
      await expect(Promise.resolve(edit.execute({ path: "many.txt", oldText: "a", newText: "b".repeat(60_000), replaceAll: true }, context))).rejects.toThrow("exceed the file size limit")
      expect(await readFile(join(root, "many.txt"), "utf8")).toBe("a".repeat(100_000))
      expect((await list.execute({ depth: 1 }, context) as { entries: readonly { path: string }[] }).entries.map((entry) => entry.path)).toContain("index.ts")
      expect((await find.execute({ pattern: "*.ts" }, context) as { entries: readonly { path: string }[] }).entries.map((entry) => entry.path)).toEqual(["index.ts"])
      expect((await search.execute({ query: "42" }, context) as { matches: readonly { path: string }[] }).matches.map((match) => match.path)).toEqual(["notes.txt"])
      expect((await search.execute({ query: "hidden" }, context) as { matches: readonly unknown[] }).matches).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects ambiguous edits and escaping/symlinked paths", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-native-tools-safe-"))
    const outside = await mkdtemp(join("/tmp", "runrail-native-tools-outside-"))
    try {
      await writeFile(join(root, "index.ts"), "x x\n")
      await writeFile(join(outside, "secret.ts"), "secret\n")
      await symlink(join(outside, "secret.ts"), join(root, "link.ts"))
      const policy = await createWorkspacePolicy(root)
      const edit = createToolCatalog(policy, { allowWrite: true }).find((tool) => tool.name === "edit_file")!
      const context = { cwd: root, signal: new AbortController().signal }
      await expect(edit.execute({ path: "index.ts", oldText: "x", newText: "y" }, context)).rejects.toThrow("not unique")
      await expect(policy.read("link.ts")).rejects.toThrow("escapes")
      await expect(policy.write("../escape.ts", "bad")).rejects.toThrow("escapes")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("runs explicit argv with bounded, filtered process context", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-native-command-"))
    const originalSecret = process.env.RUNRAIL_NATIVE_TOOL_SECRET
    process.env.RUNRAIL_NATIVE_TOOL_SECRET = "must-not-cross"
    try {
      const policy = await createWorkspacePolicy(root)
      const tool = createToolCatalog(policy).find((entry) => entry.name === "run_command")!
      const result = (await tool.execute(
        {
          program: process.execPath,
          args: ["-e", "process.stdout.write(process.env.RUNRAIL_NATIVE_TOOL_SECRET ?? 'missing')"],
        },
        { cwd: root, signal: new AbortController().signal },
      )) as { readonly ok: boolean; readonly stdout?: string }
      expect(result.ok).toBe(true)
      expect(result.stdout).toBe("missing")
      expect(tool.requiresApproval).toBe(true)
    } finally {
      if (originalSecret === undefined) delete process.env.RUNRAIL_NATIVE_TOOL_SECRET
      else process.env.RUNRAIL_NATIVE_TOOL_SECRET = originalSecret
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects duplicate tool identities at session construction", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-native-tool-duplicate-"))
    try {
      await expect(createRunrailSession({
        cwd: root,
        backend: "native",
        loadExtensions: false,
        tools: [{ name: "read_file", description: "shadow", execute: () => "bad" }],
      })).rejects.toThrow("NATIVE_TOOL_DUPLICATE")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stops a timed-out or cancelled process", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-native-command-stop-"))
    try {
      const policy = await createWorkspacePolicy(root)
      const tool = createToolCatalog(policy).find((entry) => entry.name === "run_command")!
      const timeoutResult = (await tool.execute(
        { program: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"], timeoutMs: 20 },
        { cwd: root, signal: new AbortController().signal },
      )) as { readonly timedOut: boolean; readonly ok: boolean }
      expect(timeoutResult.timedOut).toBe(true)
      expect(timeoutResult.ok).toBe(false)

      const controller = new AbortController()
      setTimeout(() => controller.abort("test cancellation"), 10)
      const cancelled = (await tool.execute(
        { program: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"], timeoutMs: 500 },
        { cwd: root, signal: controller.signal },
      )) as { readonly cancelled: boolean; readonly ok: boolean }
      expect(cancelled.cancelled).toBe(true)
      expect(cancelled.ok).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
