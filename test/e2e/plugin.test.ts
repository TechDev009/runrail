import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import {
  PluginManagerError,
  PluginRegistryError,
  createPluginIntegrity,
  createPluginManager,
} from "../../src/plugins/index.ts"

class MemoryConfigurationStore {
  private readonly values = new Map<string, unknown>()
  load(id: string): unknown | undefined { return this.values.get(id) }
  save(id: string, value: unknown): void { this.values.set(id, value) }
  delete(id: string): void { this.values.delete(id) }
}

async function makePlugin(root: string, version: string): Promise<void> {
  await writeFile(
    join(root, "index.ts"),
    `export function activate() { return { commands: [{ name: "hello", description: "fixture", execute: () => "${version}" }] } }\n`,
    "utf8",
  )
  const manifest = {
    manifestVersion: 1,
    id: "fixture-plugin",
    version,
    apiVersion: "1.0",
    entry: "index.ts",
    mode: "trusted",
    capabilities: ["fixture.command"],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    contributes: ["commands"],
    configuration: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
    enabled: true,
  }
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify(manifest), "utf8")
  const digest = await createPluginIntegrity(root)
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify({ ...manifest, integrity: { algorithm: "sha256", digest } }), "utf8")
}

function tarEntry(name: string, content: Uint8Array, type = 48): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, "utf8")
  header.write("0000644\0", 100, 8, "ascii")
  header.write("0000000\0", 108, 8, "ascii")
  header.write("0000000\0", 116, 8, "ascii")
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii")
  header.write("00000000000\0", 136, 12, "ascii")
  header[156] = type
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")
  header.fill(32, 148, 156)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii")
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, Buffer.from(content), padding])
}

function createTar(entries: readonly { readonly name: string; readonly content: Uint8Array; readonly type?: number }[]): Buffer {
  return Buffer.concat([...entries.map((entry) => tarEntry(entry.name, entry.content, entry.type ?? 48)), Buffer.alloc(1024)])
}

async function makeIsolatedPlugin(root: string): Promise<void> {
  await writeFile(join(root, "isolated.ts"), `export default (context) => { context.registerTool({ name: "isolated", description: "isolated fixture", capabilities: [], execute: () => "ok" }) }\n`, "utf8")
  const manifest = {
    manifestVersion: 1,
    id: "isolated-plugin",
    version: "1.0.0",
    apiVersion: "1.0",
    entry: "isolated.ts",
    mode: "isolated",
    capabilities: [],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    contributes: ["tools"],
    enabled: true,
  }
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify(manifest), "utf8")
  const digest = await createPluginIntegrity(root)
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify({ ...manifest, integrity: { algorithm: "sha256", digest } }), "utf8")
}

async function makeResourcePlugin(root: string): Promise<void> {
  await writeFile(join(root, "index.ts"), `export function activate() { return { prompts: [{ id: "fixture.prompt", template: "Use the fixture prompt." }], skills: [{ id: "fixture.skill", content: "Fixture skill guidance." }], themes: [{ id: "fixture.theme", content: "Fixture theme tokens." }] } }\n`, "utf8")
  const manifest = {
    manifestVersion: 1,
    id: "resource-plugin",
    version: "1.0.0",
    apiVersion: "1.0",
    entry: "index.ts",
    mode: "trusted",
    capabilities: [],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    contributes: ["prompts", "skills", "themes"],
    enabled: true,
  }
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify(manifest), "utf8")
  const digest = await createPluginIntegrity(root)
  await writeFile(join(root, "runrail.plugin.json"), JSON.stringify({ ...manifest, integrity: { algorithm: "sha256", digest } }), "utf8")
}

describe("Runrail plugin platform", () => {
  test("installs, admits, activates, configures, updates, and disables a pinned plugin", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-source-"))
    try {
      await makePlugin(source, "1.0.0")
      const configurationStore = new MemoryConfigurationStore()
      const manager = await createPluginManager({ workspaceRoot: workspace, configurationStore })
      const installed = await manager.install(source)
      expect(installed.manifest.id).toBe("fixture-plugin")
      const admission = manager.admit(
        { id: "fixture-plugin" },
        { capabilities: ["fixture.command"], permissions: [], allowTrusted: true },
      )
      const snapshot = await manager.host.activate(admission, installed.root)
      expect(snapshot.plugins).toEqual(["fixture-plugin"])
      expect(snapshot.commands[0]?.name).toBe("hello")
      await expect(manager.test("fixture-plugin", { capabilities: ["fixture.command"], permissions: [] })).resolves.toMatchObject({ mode: "trusted", ok: true, commands: 1 })
      // Testing an active plugin leaves it active.
      expect(manager.host.snapshot().plugins).toEqual(["fixture-plugin"])
      await expect(manager.activate("fixture-plugin", { capabilities: ["fixture.command"], permissions: [] })).resolves.toMatchObject({ plugins: ["fixture-plugin"] })
      await expect(manager.deactivate("fixture-plugin")).resolves.toMatchObject({ plugins: [] })
      await manager.configure("fixture-plugin", { label: "fixture" })
      expect(manager.configuration("fixture-plugin")).toEqual({ label: "fixture" })
      await expect(manager.reload()).resolves.toHaveLength(1)
      expect(manager.configuration("fixture-plugin")).toEqual({ label: "fixture" })
      await expect(manager.configure("fixture-plugin", { extra: true })).rejects.toMatchObject({ code: "PLUGIN_MANAGER_INVALID" })
      await expect(manager.setEnabled("fixture-plugin", false)).resolves.toMatchObject({ enabled: false })
      expect(() => manager.admit({ id: "fixture-plugin" }, { capabilities: ["fixture.command"], permissions: [] })).toThrow(PluginRegistryError)
      await manager.setEnabled("fixture-plugin", true)
      await writeFile(join(source, "index.ts"), `export function activate() { return { commands: [{ name: "hello", description: "fixture", execute: () => "2.0.0" }] } }\n`, "utf8")
      await makePlugin(source, "2.0.0")
      await expect(manager.update("fixture-plugin", source)).resolves.toMatchObject({ manifest: { version: "2.0.0" } })
      await expect(manager.rollback("fixture-plugin")).resolves.toMatchObject({ manifest: { version: "1.0.0" } })
      await manager.remove("fixture-plugin")
      expect(await manager.list()).toHaveLength(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("a linked or oversized plugin state file is refused, and saving state replaces a link instead of writing through it", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-state-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-state-source-"))
    const outside = await mkdtemp(join("/tmp", "runrail-plugin-state-outside-"))
    try {
      const state = join(workspace, ".runrail", "plugins", ".state.json")
      const elsewhere = join(outside, "state.json")
      const original = JSON.stringify({ version: 1, enabled: {} })
      await writeFile(elsewhere, original)
      await mkdir(join(workspace, ".runrail", "plugins"), { recursive: true })
      for (const plant of [() => symlink("/dev/zero", state), () => symlink(elsewhere, state), () => writeFile(state, JSON.stringify({ version: 1, enabled: {}, pad: "x".repeat(300 * 1024) }))]) {
        await plant()
        await expect(createPluginManager({ workspaceRoot: workspace })).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID" })
        await rm(state)
      }
      await makePlugin(source, "1.0.0")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await manager.install(source)
      await rm(state)
      await symlink(elsewhere, state)
      await manager.setEnabled("fixture-plugin", false)
      expect(await readFile(elsewhere, "utf8")).toBe(original)
      expect((await lstat(state)).isFile()).toBe(true)
      expect(JSON.parse(await readFile(state, "utf8"))).toEqual({ version: 1, enabled: { "fixture-plugin": false } })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("a plugin package with a symlink in it is refused", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-symlink-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-symlink-source-"))
    try {
      await makePlugin(source, "1.0.0")
      await symlink("/etc/hosts", join(source, "hosts.txt"))
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await expect(manager.install(source)).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("a plugin nested past the depth limit, or with an oversized manifest, is refused", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-bounds-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-bounds-source-"))
    try {
      await makePlugin(source, "1.0.0")
      await mkdir(join(source, ...Array.from({ length: 40 }, (_, index) => `d${String(index)}`)), { recursive: true })
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await expect(manager.install(source)).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" })
      await rm(join(source, "d0"), { recursive: true })
      await writeFile(join(source, "runrail.plugin.json"), `{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`, "utf8")
      await expect(manager.install(source)).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_INVALID" })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("feeds admitted plugin resources into native context", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-resource-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-resource-source-"))
    try {
      await makeResourcePlugin(source)
      const manager = await createPluginManager({ workspaceRoot: workspace })
      const installed = await manager.install(source)
      const admission = manager.admit({ id: "resource-plugin" }, { capabilities: [], permissions: [] })
      await manager.host.activate(admission, installed.root)
      let contextText = ""
      const session = await (await import("../../src/session.ts")).createRunrailSession({
        cwd: workspace,
        backend: "native",
        pluginHost: manager.host,
        loadExtensions: false,
        model: {
          complete: (request) => {
            contextText = request.messages[0]?.text ?? ""
            return { type: "text", text: "done" }
          },
        },
      })
      try {
        for await (const _event of session.prompt("finish")) {}
        expect(contextText).toContain("Use the fixture prompt.")
        // A plugin skill is listed like any other; its first line stands in for a description.
        expect(contextText).toContain("- fixture.skill: Fixture skill guidance.")
        expect(contextText).toContain("Fixture theme tokens.")
        expect(session.context.list().map((resource) => resource.kind)).toContain("skill")
        expect(session.skillRegistry?.read("fixture.skill")).toMatchObject({ scope: "plugin", content: "Fixture skill guidance." })
      } finally {
        await session.stop("test complete")
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("tests an admitted isolated plugin through the public worker path", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-isolated-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-isolated-source-"))
    try {
      await makeIsolatedPlugin(source)
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await manager.install(source)
      await expect(manager.test("isolated-plugin", { capabilities: [], permissions: [] })).resolves.toMatchObject({ mode: "isolated", ok: true, tools: 1 })
      await expect(manager.activate("isolated-plugin", { capabilities: [], permissions: [] })).resolves.toMatchObject({ plugins: [] })
      await expect(manager.invokeIsolatedTool("isolated-plugin", "isolated", { fixture: true })).resolves.toBe("ok")
      await manager.deactivate("isolated-plugin")
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("installs a deterministic tar archive and rejects traversal entries", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-archive-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-archive-source-"))
    try {
      await makePlugin(source, "1.0.0")
      const manifest = await (await import("node:fs/promises")).readFile(join(source, "runrail.plugin.json"))
      const entry = await (await import("node:fs/promises")).readFile(join(source, "index.ts"))
      const archive = join(workspace, "fixture.tar")
      await writeFile(archive, createTar([
        { name: "bundle/runrail.plugin.json", content: manifest },
        { name: "bundle/index.ts", content: entry },
      ]))
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await expect(manager.install(archive)).resolves.toMatchObject({ manifest: { id: "fixture-plugin" } })
      const badArchive = join(workspace, "bad.tar")
      await writeFile(badArchive, createTar([{ name: "../escape.txt", content: Buffer.from("bad") }]))
      await expect(manager.install(badArchive)).rejects.toMatchObject({ code: "PLUGIN_ARCHIVE_INVALID" })
      const corruptArchive = join(workspace, "corrupt.tar")
      const corrupt = createTar([{ name: "bundle/index.ts", content: Buffer.from("bad") }])
      corrupt[0] = (corrupt[0] ?? 0) ^ 1
      await writeFile(corruptArchive, corrupt)
      await expect(manager.install(corruptArchive)).rejects.toMatchObject({ code: "PLUGIN_ARCHIVE_INVALID" })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("installs an archive the system tar made, folders and all", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-system-tar-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-system-tar-source-"))
    try {
      const bundle = join(source, "bundle")
      await mkdir(bundle)
      await makePlugin(bundle, "1.0.0")
      const archive = join(workspace, "fixture.tar")
      // Without AppleDouble files, which would be package files of their own on macOS.
      const made = Bun.spawnSync(["tar", "-cf", archive, "bundle"], { cwd: source, env: { ...process.env, COPYFILE_DISABLE: "1" } })
      expect(made.exitCode).toBe(0)
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await expect(manager.install(archive)).resolves.toMatchObject({ manifest: { id: "fixture-plugin" } })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("installs and cleans up a gzip tar archive", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-tgz-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-tgz-source-"))
    try {
      await makePlugin(source, "1.0.0")
      const manifest = await (await import("node:fs/promises")).readFile(join(source, "runrail.plugin.json"))
      const entry = await (await import("node:fs/promises")).readFile(join(source, "index.ts"))
      const archive = join(workspace, "fixture.tgz")
      await writeFile(archive, gzipSync(createTar([
        { name: "bundle/runrail.plugin.json", content: manifest },
        { name: "bundle/index.ts", content: entry },
      ])))
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await expect(manager.install(archive)).resolves.toMatchObject({ manifest: { id: "fixture-plugin" } })
      const packageEntries = await readdir(join(workspace, ".runrail", "plugins"))
      expect(packageEntries.some((name) => name.startsWith(".source-"))).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("testing a plugin that asks for approval needs the same approval activation does", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-test-approval-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-test-approval-source-"))
    try {
      await makePlugin(source, "1.0.0")
      const path = join(source, "runrail.plugin.json")
      const fs = await import("node:fs/promises")
      const written = JSON.parse(await fs.readFile(path, "utf8"))
      await fs.writeFile(path, JSON.stringify({ ...written, approval: { required: true, capabilities: ["fixture.command"] }, integrity: { algorithm: "sha256", digest: "0".repeat(64) } }), "utf8")
      await fs.writeFile(path, JSON.stringify({ ...written, approval: { required: true, capabilities: ["fixture.command"] }, integrity: { algorithm: "sha256", digest: await createPluginIntegrity(source) } }), "utf8")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await manager.install(source)
      const policy = { capabilities: ["fixture.command"], permissions: [] }
      await expect(manager.test("fixture-plugin", policy)).rejects.toThrow()
      expect(manager.host.snapshot().plugins).toEqual([])
      await expect(manager.test("fixture-plugin", policy, true)).resolves.toMatchObject({ ok: true, commands: 1 })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("an archive that expands past its byte limit stops there", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-bomb-"))
    try {
      const { createLocalPluginSourceResolver } = await import("../../src/plugins/source.ts")
      const archive = join(workspace, "bomb.tgz")
      // 64 MiB of zeros compresses to about 64 KiB.
      await writeFile(archive, gzipSync(new Uint8Array(64 * 1024 * 1024)))
      const resolver = createLocalPluginSourceResolver({ temporaryRoot: workspace, maxArchiveBytes: 1024 * 1024 })
      await expect(resolver.resolve(archive)).rejects.toMatchObject({ code: "PLUGIN_ARCHIVE_LIMIT" })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("rejects manifest tampering, not only entry tampering", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-manifest-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-manifest-source-"))
    try {
      await makePlugin(source, "1.0.0")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      const installed = await manager.install(source)
      await writeFile(join(installed.root, "runrail.plugin.json"), JSON.stringify({ ...installed.manifest, enabled: false }), "utf8")
      await expect(manager.reload()).rejects.toMatchObject({ code: "PLUGIN_INTEGRITY_MISMATCH" })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("code changed after the plugin was admitted is refused when it is loaded, before it runs", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-late-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-late-source-"))
    const marker = join(workspace, "planted-ran")
    try {
      await makePlugin(source, "1.0.0")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      const installed = await manager.install(source)
      await manager.list()
      await writeFile(join(installed.root, "index.ts"), `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "ran")\nexport function activate() { return {} }\n`, "utf8")
      await expect(manager.activate("fixture-plugin", { capabilities: ["fixture.command"], permissions: [] })).rejects.toMatchObject({ code: "PLUGIN_INTEGRITY_MISMATCH" })
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("every file in a package is in its digest, names the manager uses beside packages included", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-names-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-names-source-"))
    const marker = join(workspace, "planted-ran")
    try {
      await makePlugin(source, "1.0.0")
      for (const name of [".staging", ".previous"]) await mkdir(join(source, name))
      await writeFile(join(source, ".staging", "helper.ts"), "export const label = 'original'\n", "utf8")
      await writeFile(join(source, ".state.json"), "{}", "utf8")
      await writeFile(join(source, "index.ts"), `import { label } from "./.staging/helper.ts"\nexport function activate() { return { commands: [{ name: "hello", description: label, execute: () => label }] } }\n`, "utf8")
      const manifest = JSON.parse(await readFile(join(source, "runrail.plugin.json"), "utf8")) as Record<string, unknown>
      await writeFile(join(source, "runrail.plugin.json"), JSON.stringify({ ...manifest, integrity: { algorithm: "sha256", digest: await createPluginIntegrity(source) } }), "utf8")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      const installed = await manager.install(source)
      await writeFile(join(installed.root, ".staging", "helper.ts"), `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "ran")\nexport const label = "planted"\n`, "utf8")
      await expect(manager.activate("fixture-plugin", { capabilities: ["fixture.command"], permissions: [] })).rejects.toMatchObject({ code: "PLUGIN_INTEGRITY_MISMATCH" })
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("an update loads the new version of a helper the entry imports, not the one loaded before", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-helper-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-helper-source-"))
    const policy = { capabilities: ["fixture.command"], permissions: [] }
    const write = async (version: string) => {
      await makePlugin(source, version)
      await writeFile(join(source, "helper.ts"), `export const label = "helper-${version}"\n`, "utf8")
      await writeFile(join(source, "index.ts"), `import { label } from "./helper.ts"\nexport function activate() { return { commands: [{ name: "hello", description: label, execute: () => label }] } }\n`, "utf8")
      const manifest = JSON.parse(await readFile(join(source, "runrail.plugin.json"), "utf8")) as Record<string, unknown>
      await writeFile(join(source, "runrail.plugin.json"), JSON.stringify({ ...manifest, integrity: { algorithm: "sha256", digest: await createPluginIntegrity(source) } }), "utf8")
    }
    try {
      await write("1.0.0")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await manager.install(source)
      expect((await manager.activate("fixture-plugin", policy)).commands[0]?.description).toBe("helper-1.0.0")
      await write("2.0.0")
      await manager.update("fixture-plugin", source)
      expect((await manager.activate("fixture-plugin", policy)).commands[0]?.description).toBe("helper-2.0.0")
      await manager.rollback("fixture-plugin")
      expect((await manager.activate("fixture-plugin", policy)).commands[0]?.description).toBe("helper-1.0.0")
      // Only the copy of the active version is kept; listing never takes the copies for plugins.
      expect(await readdir(join(workspace, ".runrail", "plugins", ".modules"))).toHaveLength(1)
      expect((await manager.reload()).map((plugin) => plugin.manifest.id)).toEqual(["fixture-plugin"])
      await manager.remove("fixture-plugin")
      expect(await readdir(join(workspace, ".runrail", "plugins", ".modules"))).toEqual([])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("with a trust folder, a plugin rewritten or planted in the workspace is not activated", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-trust-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-trust-source-"))
    const trustDir = await mkdtemp(join("/tmp", "runrail-plugin-trust-"))
    const policy = { capabilities: ["fixture.command"], permissions: [] }
    try {
      await makePlugin(source, "1.0.0")
      const manager = await createPluginManager({ workspaceRoot: workspace, trustDir })
      await manager.install(source)
      expect((await manager.activate("fixture-plugin", policy)).commands).toHaveLength(1)
      await manager.deactivate("fixture-plugin")

      // Both the files and the manifest's digest rewritten in the workspace: it still verifies against itself.
      const installed = join(workspace, ".runrail", "plugins", "fixture-plugin")
      await makePlugin(installed, "6.6.6")
      const reloaded = await createPluginManager({ workspaceRoot: workspace, trustDir })
      await expect(reloaded.activate("fixture-plugin", policy)).rejects.toMatchObject({ code: "PLUGIN_INTEGRITY_MISMATCH" })
      await expect(reloaded.test("fixture-plugin", policy, true)).rejects.toMatchObject({ code: "PLUGIN_INTEGRITY_MISMATCH" })

      // Installing it again from the source the person chose makes it the recorded package.
      await reloaded.update("fixture-plugin", source)
      expect((await reloaded.activate("fixture-plugin", policy)).commands).toHaveLength(1)
      await reloaded.remove("fixture-plugin")
      expect(JSON.parse(await readFile(join(trustDir, (await readdir(trustDir))[0] ?? ""), "utf8"))).toEqual({ version: 1, plugins: {} })

      // A plugin folder that arrived with the workspace was never installed here.
      const planted = await mkdtemp(join("/tmp", "runrail-plugin-planted-workspace-"))
      try {
        await mkdir(join(planted, ".runrail", "plugins", "fixture-plugin"), { recursive: true })
        await makePlugin(join(planted, ".runrail", "plugins", "fixture-plugin"), "1.0.0")
        const fresh = await createPluginManager({ workspaceRoot: planted, trustDir })
        expect((await fresh.list()).map((plugin) => plugin.manifest.id)).toEqual(["fixture-plugin"])
        await expect(fresh.activate("fixture-plugin", policy)).rejects.toMatchObject({ code: "PLUGIN_INTEGRITY_MISMATCH" })
      } finally {
        await rm(planted, { recursive: true, force: true })
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
      await rm(trustDir, { recursive: true, force: true })
    }
  })

  test("computing a digest leaves the directories beside the package alone", async () => {
    const parent = await mkdtemp(join("/tmp", "runrail-plugin-digest-"))
    try {
      const sibling = join(parent, ".runrail-integrity")
      await mkdir(sibling)
      await writeFile(join(sibling, "keep.txt"), "mine", "utf8")
      const root = join(parent, "plugin")
      await mkdir(root)
      await makePlugin(root, "1.0.0")
      const digests = await Promise.all(Array.from({ length: 4 }, () => createPluginIntegrity(root)))
      expect(new Set(digests).size).toBe(1)
      expect(await readFile(join(sibling, "keep.txt"), "utf8")).toBe("mine")
      expect((await readdir(parent)).sort()).toEqual([".runrail-integrity", "plugin"])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("refuses Pi packages before activation with an actionable migration code", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-pi-install-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-pi-install-source-"))
    try {
      await writeFile(join(source, "extension.ts"), "throw new Error('must not execute')\n", "utf8")
      await writeFile(join(source, "package.json"), JSON.stringify({
        name: "pi-install-fixture",
        version: "1.0.0",
        pi: { extensions: ["extension.ts"] },
      }), "utf8")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await expect(manager.install(source)).rejects.toMatchObject({ code: "PLUGIN_PI_PACKAGE_REQUIRES_MIGRATION" })
      expect(await manager.list()).toHaveLength(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })

  test("rejects package tampering and undeclared permissions", async () => {
    const workspace = await mkdtemp(join("/tmp", "runrail-plugin-tamper-workspace-"))
    const source = await mkdtemp(join("/tmp", "runrail-plugin-tamper-source-"))
    try {
      await makePlugin(source, "1.0.0")
      await writeFile(join(source, "index.ts"), "tampered\n", "utf8")
      const manager = await createPluginManager({ workspaceRoot: workspace })
      await expect(manager.install(source)).rejects.toBeInstanceOf(PluginManagerError)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })
})
