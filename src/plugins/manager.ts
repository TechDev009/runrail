import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import type { IsolatedExtensionWorker } from "@nifrajs/coding-agent"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  parsePluginManifestJson,
  RUNRAIL_PLUGIN_MANIFEST_FILE,
  type RunrailPluginManifest,
} from "./manifest.ts"
import { PluginRegistry, type PluginAdmissionRequest, type PluginTrustPolicy } from "./registry.ts"
import { TrustedPluginHost, startIsolatedPluginWorker, type PluginHostSnapshot } from "./sdk.ts"
import { validatePluginConfiguration } from "./manifest.ts"
import { createLocalPluginSourceResolver, type PluginSourceResolver } from "./source.ts"
import { PiResourceAdapter } from "./pi/index.ts"
import { readBoundedText } from "../runtime/bounded-read.ts"
import { ensureContainedDirectory } from "../runtime/contained-path.ts"

export interface PluginConfigurationStore {
  load(id: string): unknown | undefined | PromiseLike<unknown | undefined>
  save(id: string, value: unknown): void | PromiseLike<void>
  delete(id: string): void | PromiseLike<void>
}

export interface PluginManagerOptions {
  readonly workspaceRoot: string
  readonly pluginRoot?: string
  readonly maxPackageBytes?: number
  readonly maxPackageFiles?: number
  /** Caller-owned settings storage. Runrail never implements durable secret storage. */
  readonly configurationStore?: PluginConfigurationStore
  /** Optional caller-owned source resolver. The default accepts local directories and tar archives. */
  readonly sourceResolver?: PluginSourceResolver
  /**
   * A folder outside the workspace where the digest of each plugin installed here is recorded.
   * With it, a plugin whose files and manifest were both rewritten in the workspace is not activated.
   */
  readonly trustDir?: string
}

export interface InstalledPlugin {
  readonly manifest: RunrailPluginManifest
  readonly root: string
  readonly enabled: boolean
}

export type PluginManagerErrorCode =
  | "PLUGIN_MANAGER_INVALID"
  | "PLUGIN_PACKAGE_NOT_FOUND"
  | "PLUGIN_PACKAGE_INVALID"
  | "PLUGIN_INTEGRITY_MISMATCH"
  | "PLUGIN_DUPLICATE"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_STATE_INVALID"
  | "PLUGIN_ROLLBACK_UNAVAILABLE"
  | "PLUGIN_PI_PACKAGE_REQUIRES_MIGRATION"
  | "PLUGIN_INSTALL_FAILED"

export class PluginManagerError extends Error {
  constructor(readonly code: PluginManagerErrorCode, reason: string) {
    super(`plugin manager: ${reason}`)
    this.name = "PluginManagerError"
  }
}

export interface PluginInstallOptions {
  readonly replace?: boolean
}

export interface PluginTestResult {
  readonly id: string
  readonly mode: "trusted" | "isolated"
  readonly ok: boolean
  readonly tools: number
  readonly commands: number
}
interface PluginState {
  readonly version: 1
  readonly enabled: Readonly<Record<string, boolean>>
}

/** The installed package's digest, and the one a rollback may return to. */
interface TrustRecord {
  readonly current: string
  readonly previous?: string
}

interface InternalPlugin {
  readonly manifest: RunrailPluginManifest
  readonly root: string
  readonly enabled: boolean
}

/** Local package manager for explicitly supplied plugin directories. It never contacts a registry. */
export class PluginManager {
  workspaceRoot: string
  pluginRoot: string
  readonly registry = new PluginRegistry()
  readonly host = new TrustedPluginHost()
  private readonly isolated = new Map<string, IsolatedExtensionWorker>()
  private readonly configurationStore?: PluginConfigurationStore
  private readonly sourceResolver: PluginSourceResolver
  private readonly trustDir: string | undefined
  private readonly maxPackageBytes: number
  private readonly maxPackageFiles: number
  private readonly installed = new Map<string, InternalPlugin>()
  private readonly configurations = new Map<string, unknown>()
  private initialized = false

  constructor(options: PluginManagerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot)
    this.pluginRoot = resolve(options.pluginRoot ?? join(this.workspaceRoot, ".runrail", "plugins"))
    this.configurationStore = options.configurationStore
    this.sourceResolver = options.sourceResolver ?? createLocalPluginSourceResolver({ temporaryRoot: this.pluginRoot })
    this.trustDir = options.trustDir === undefined ? undefined : resolve(options.trustDir)
    assertInside(this.workspaceRoot, this.pluginRoot)
    this.maxPackageBytes = options.maxPackageBytes ?? 64 * 1024 * 1024
    this.maxPackageFiles = options.maxPackageFiles ?? 4096
    if (
      !Number.isSafeInteger(this.maxPackageBytes) ||
      this.maxPackageBytes < 1 ||
      this.maxPackageBytes > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(this.maxPackageFiles) ||
      this.maxPackageFiles < 1 ||
      this.maxPackageFiles > 32_768
    )
      throw new PluginManagerError("PLUGIN_MANAGER_INVALID", "package limits are invalid")
  }

  async initialize(): Promise<readonly InstalledPlugin[]> {
    if (this.initialized) await this.close()
    let pluginRoot: string
    try {
      pluginRoot = await ensureContainedDirectory(this.workspaceRoot, this.pluginRoot)
    } catch {
      throw new PluginManagerError("PLUGIN_MANAGER_INVALID", "plugin root is not an unlinked directory inside the workspace")
    }
    this.workspaceRoot = await realpath(this.workspaceRoot)
    this.pluginRoot = pluginRoot
    assertInside(this.workspaceRoot, this.pluginRoot)
    const state = await this.readState()
    this.installed.clear()
    this.registryClear()
    const entries = (await readdir(this.pluginRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const root = await realpath(join(this.pluginRoot, entry.name))
      assertInside(this.pluginRoot, root)
      const manifest = await readManifest(root)
      await verifyIntegrity(root, manifest, this.maxPackageBytes, this.maxPackageFiles)
      const enabled = state.enabled[manifest.id] ?? manifest.enabled
      const effective = Object.freeze({ ...manifest, enabled })
      const plugin = Object.freeze({ manifest: effective, root, enabled })
      this.installed.set(effective.id, plugin)
      this.registry.register(effective)
      if (this.configurationStore !== undefined) {
        let configuration: unknown | undefined
        try {
          configuration = await this.configurationStore.load(effective.id)
        } catch (error) {
          throw new PluginManagerError("PLUGIN_STATE_INVALID", error instanceof Error ? error.message : "plugin configuration cannot be loaded")
        }
        if (configuration !== undefined) {
          try {
            validatePluginConfiguration(effective, configuration)
          } catch (error) {
            throw new PluginManagerError("PLUGIN_STATE_INVALID", error instanceof Error ? error.message : "plugin configuration is invalid")
          }
          this.configurations.set(effective.id, configuration)
        }
      }
    }
    this.initialized = true
    return this.list()
  }

  async list(): Promise<readonly InstalledPlugin[]> {
    await this.ensureInitialized()
    return Object.freeze(
      [...this.installed.values()]
        .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
        .map((plugin) => Object.freeze({ ...plugin })),
    )
  }

  async get(id: string): Promise<InstalledPlugin | undefined> {
    await this.ensureInitialized()
    const plugin = this.installed.get(id)
    return plugin === undefined ? undefined : Object.freeze({ ...plugin })
  }

  async install(sourceInput: string, options: PluginInstallOptions = {}): Promise<InstalledPlugin> {
    await this.ensureInitialized()
    const resolved = await this.sourceResolver.resolve(sourceInput)
    try {
      try {
        return await this.installResolved(resolved.root, options)
      } catch (error) {
        if (error instanceof PluginManagerError && error.code === "PLUGIN_PACKAGE_INVALID" && await isPiPackage(resolved.root))
          throw new PluginManagerError("PLUGIN_PI_PACKAGE_REQUIRES_MIGRATION", "Pi package resources were discovered, but Runrail requires an explicit migration plan; run 'runrail plugins migrate-pi <path> --json', author a Runrail plugin for extensions, or use 'runrail pi'.")
        throw error
      }
    } finally {
      await resolved.release?.()
    }
  }

  private async installResolved(source: string, options: PluginInstallOptions = {}): Promise<InstalledPlugin> {
    const manifest = await readManifest(source)
    await verifyIntegrity(source, manifest, this.maxPackageBytes, this.maxPackageFiles)
    if (this.installed.has(manifest.id) && options.replace !== true)
      throw new PluginManagerError("PLUGIN_DUPLICATE", `plugin '${manifest.id}' is already installed`)
    if (options.replace === true && this.installed.has(manifest.id)) await this.deactivate(manifest.id)
    const target = join(this.pluginRoot, manifest.id)
    assertInside(this.pluginRoot, target)
    const staging = join(this.pluginRoot, `.${manifest.id}.staging`)
    const backup = join(this.pluginRoot, `.${manifest.id}.previous`)
    try {
      await rm(staging, { recursive: true, force: true })
      await cp(source, staging, { recursive: true, force: true, dereference: false })
      await verifyIntegrity(staging, manifest, this.maxPackageBytes, this.maxPackageFiles)
      if (options.replace === true && this.installed.has(manifest.id)) {
        await rm(backup, { recursive: true, force: true })
        await rename(target, backup)
      }
      await rename(staging, target)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      if (options.replace === true && this.installed.has(manifest.id)) {
        try {
          if (await exists(backup)) await rename(backup, target)
        } catch {
          // A failed rollback is surfaced below; no partial package is admitted.
        }
      }
      throw new PluginManagerError("PLUGIN_INSTALL_FAILED", error instanceof Error ? error.message : "plugin package install failed")
    }
    const replaced = options.replace === true ? this.installed.get(manifest.id) : undefined
    const enabled = replaced?.enabled ?? manifest.enabled
    const effective = Object.freeze({ ...manifest, enabled })
    const plugin = Object.freeze({ manifest: effective, root: target, enabled })
    this.installed.set(manifest.id, plugin)
    this.registry.replace(effective)
    await this.recordTrust(manifest.id, replaced === undefined ? { current: manifest.integrity.digest } : { current: manifest.integrity.digest, previous: replaced.manifest.integrity.digest })
    await this.writeState()
    return Object.freeze({ ...plugin })
  }

  async update(id: string, source: string): Promise<InstalledPlugin> {
    await this.ensureInitialized()
    if (this.installed.get(id) === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `unknown plugin '${id}'`)
    const resolved = await this.sourceResolver.resolve(source)
    try {
      const sourceManifest = await readManifest(resolved.root)
      if (sourceManifest.id !== id) throw new PluginManagerError("PLUGIN_PACKAGE_INVALID", "updated package identity does not match")
      return this.installResolved(resolved.root, { replace: true })
    } finally {
      await resolved.release?.()
    }
  }

  async reload(): Promise<readonly InstalledPlugin[]> {
    await this.close()
    this.initialized = false
    return this.initialize()
  }

  async activate(id: string, policy: PluginTrustPolicy = {}, approvalGranted = false): Promise<PluginHostSnapshot> {
    await this.ensureInitialized()
    const plugin = this.installed.get(id)
    if (plugin === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `unknown plugin '${id}'`)
    const admission = this.admit({ id, approvalGranted }, policy)
    // The files are checked again as they are loaded: the folder sits in the workspace, where they can change after the admission.
    await verifyIntegrity(plugin.root, plugin.manifest, this.maxPackageBytes, this.maxPackageFiles)
    await this.assertInstalledHere(plugin)
    if (admission.mode === "trusted") {
      const root = await this.moduleRoot(plugin)
      const snapshot = await this.host.activate(admission, root, this.configurations.get(id))
      await this.pruneModuleRoots(id, root)
      const worker = this.isolated.get(id)
      if (worker !== undefined) {
        await worker.close()
        this.isolated.delete(id)
      }
      return snapshot
    }
    const worker = await startIsolatedPluginWorker(admission, plugin.root, {
      trustedCapabilities: admission.capabilities,
    })
    await this.host.deactivate(id)
    const previous = this.isolated.get(id)
    if (previous !== undefined) await previous.close()
    this.isolated.set(id, worker)
    return this.host.snapshot()
  }

  /**
   * A verified copy of the plugin at a path of its own per digest. Bun keeps every module it loaded
   * by path, so a helper the entry imports would otherwise stay at its first version after an update.
   */
  private async moduleRoot(plugin: InstalledPlugin): Promise<string> {
    const modules = join(this.pluginRoot, ".modules")
    // "@" is never in an id, so one plugin's copies are never taken for another's.
    const prefix = `${plugin.manifest.id}@`
    const target = join(modules, `${prefix}${createHash("sha256").update(plugin.manifest.integrity.digest).digest("hex").slice(0, 32)}`)
    assertInside(this.pluginRoot, target)
    if (!(await exists(target))) {
      await mkdir(modules, { recursive: true })
      const staging = await mkdtemp(join(modules, `.${prefix}`))
      try {
        await cp(plugin.root, staging, { recursive: true, force: true, dereference: false })
        await verifyIntegrity(staging, plugin.manifest, this.maxPackageBytes, this.maxPackageFiles)
        await rename(staging, target).catch(async (error: unknown) => {
          // Another activation of the same digest got there first; its copy is the same files.
          if (!(await exists(target))) throw error
        })
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    // The copy is checked as it is loaded, like the installed folder.
    await verifyIntegrity(target, plugin.manifest, this.maxPackageBytes, this.maxPackageFiles)
    return target
  }

  /** Copies of earlier versions; the modules already loaded from them stay in memory. */
  private async pruneModuleRoots(id: string, keep?: string): Promise<void> {
    const modules = join(this.pluginRoot, ".modules")
    const entries = await readdir(modules).catch(() => [] as string[])
    for (const name of entries) {
      if (!name.startsWith(`${id}@`) || join(modules, name) === keep) continue
      await rm(join(modules, name), { recursive: true, force: true })
    }
  }

  async invokeIsolatedTool(id: string, name: string, input: unknown): Promise<unknown> {
    await this.ensureInitialized()
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(name))
      throw new PluginManagerError("PLUGIN_MANAGER_INVALID", "isolated tool name is invalid")
    const worker = this.isolated.get(id)
    if (worker === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `isolated plugin '${id}' is not active`)
    return worker.invokeTool(name, input)
  }

  async deactivate(id: string): Promise<PluginHostSnapshot> {
    const worker = this.isolated.get(id)
    if (worker !== undefined) {
      await worker.close()
      this.isolated.delete(id)
    }
    return this.host.deactivate(id)
  }

  async close(): Promise<void> {
    await this.host.close()
    for (const [id, worker] of this.isolated) {
      await worker.close()
      this.isolated.delete(id)
    }
  }

  /** Loads the plugin once to see what it adds. It needs the same approval activation does, and an active plugin stays active. */
  async test(id: string, policy: PluginTrustPolicy = {}, approvalGranted = false): Promise<PluginTestResult> {
    await this.ensureInitialized()
    const plugin = this.installed.get(id)
    if (plugin === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `unknown plugin '${id}'`)
    const admission = this.admit(
      { id, approvalGranted },
      { ...policy, allowTrusted: policy.allowTrusted ?? true, allowIsolated: policy.allowIsolated ?? true },
    )
    await verifyIntegrity(plugin.root, plugin.manifest, this.maxPackageBytes, this.maxPackageFiles)
    await this.assertInstalledHere(plugin)
    if (admission.mode === "trusted") {
      const wasActive = this.host.snapshot().plugins.includes(id)
      const before = wasActive ? undefined : this.host.snapshot()
      const snapshot = await this.host.activate(admission, await this.moduleRoot(plugin), this.configurations.get(id))
      if (!wasActive) await this.host.deactivate(id)
      const added = (count: (value: PluginHostSnapshot) => number) => count(snapshot) - (before === undefined ? 0 : count(before))
      return Object.freeze({ id, mode: "trusted", ok: true, tools: wasActive ? snapshot.tools.length : added((value) => value.tools.length), commands: wasActive ? snapshot.commands.length : added((value) => value.commands.length) })
    }
    const worker = await startIsolatedPluginWorker(admission, plugin.root, {
      trustedCapabilities: admission.capabilities,
    })
    try {
      return Object.freeze({ id, mode: "isolated", ok: true, tools: worker.snapshot.tools.length, commands: worker.snapshot.commands.length })
    } finally {
      await worker.close()
    }
  }

  async rollback(id: string): Promise<InstalledPlugin> {
    await this.ensureInitialized()
    const current = this.installed.get(id)
    if (current === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `unknown plugin '${id}'`)
    const backup = join(this.pluginRoot, `.${id}.previous`)
    let previousManifest: RunrailPluginManifest
    try {
      previousManifest = await readManifest(await realpath(backup))
      await verifyIntegrity(await realpath(backup), previousManifest, this.maxPackageBytes, this.maxPackageFiles)
    } catch (error) {
      if (error instanceof PluginManagerError && error.code === "PLUGIN_INTEGRITY_MISMATCH") throw error
      throw new PluginManagerError("PLUGIN_ROLLBACK_UNAVAILABLE", "no verified previous plugin package is available")
    }
    const trust = this.trustDir === undefined ? undefined : (await this.readTrust())[id]
    if (this.trustDir !== undefined && (trust?.previous !== previousManifest.integrity.digest || trust.current !== current.manifest.integrity.digest))
      throw new PluginManagerError("PLUGIN_INTEGRITY_MISMATCH", `the previous package of plugin '${id}' is not the one installed on this computer`)
    await this.deactivate(id)
    const staging = join(this.pluginRoot, `.${id}.rollback`)
    const target = join(this.pluginRoot, id)
    try {
      await rm(staging, { recursive: true, force: true })
      await rename(target, staging)
      await rename(backup, target)
      await rename(staging, backup)
    } catch (error) {
      try {
        if (!(await exists(target))) await rename(staging, target)
      } catch {
        // The original package may already be recoverable at target; surface the stable rollback error.
      }
      throw new PluginManagerError("PLUGIN_INSTALL_FAILED", error instanceof Error ? error.message : "plugin rollback failed")
    }
    const effective = Object.freeze({ ...previousManifest, enabled: current.enabled })
    const updated = Object.freeze({ manifest: effective, root: target, enabled: current.enabled })
    this.installed.set(id, updated)
    this.registry.replace(effective)
    await this.recordTrust(id, { current: previousManifest.integrity.digest, previous: current.manifest.integrity.digest })
    await this.writeState()
    return Object.freeze({ ...updated })
  }

  async remove(id: string): Promise<void> {
    await this.ensureInitialized()
    const plugin = this.installed.get(id)
    if (plugin === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `unknown plugin '${id}'`)
    await this.deactivate(id)
    await rm(plugin.root, { recursive: true, force: false })
    await this.pruneModuleRoots(id)
    this.installed.delete(id)
    this.registryClear()
    for (const item of this.installed.values()) this.registry.register(item.manifest)
    this.configurations.delete(id)
    await this.configurationStore?.delete(id)
    await this.recordTrust(id, undefined)
    await this.writeState()
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin> {
    await this.ensureInitialized()
    const plugin = this.installed.get(id)
    if (plugin === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `unknown plugin '${id}'`)
    if (typeof enabled !== "boolean") throw new PluginManagerError("PLUGIN_MANAGER_INVALID", "enabled must be boolean")
    const manifest = Object.freeze({ ...plugin.manifest, enabled })
    const updated = Object.freeze({ manifest, root: plugin.root, enabled })
    this.installed.set(id, updated)
    this.registry.replace(manifest)
    if (!enabled) await this.deactivate(id)
    await this.writeState()
    return Object.freeze({ ...updated })
  }

  async configure(id: string, value: unknown): Promise<void> {
    await this.ensureInitialized()
    const plugin = this.installed.get(id)
    if (plugin === undefined) throw new PluginManagerError("PLUGIN_NOT_FOUND", `unknown plugin '${id}'`)
    try {
      validatePluginConfiguration(plugin.manifest, value)
    } catch (error) {
      throw new PluginManagerError("PLUGIN_MANAGER_INVALID", error instanceof Error ? error.message : "plugin configuration is invalid")
    }
    // Configuration stays caller-owned; Runrail only keeps the active value in memory.
    this.configurations.set(id, value)
    await this.configurationStore?.save(id, value)
  }

  configuration(id: string): unknown {
    return this.configurations.get(id)
  }

  admit(request: PluginAdmissionRequest, policy: PluginTrustPolicy = {}) {
    return this.registry.admit(request, policy)
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
  }

  private registryClear(): void {
    this.registry.clear()
  }

  /** Refuses a plugin whose digest is not the one this computer installed; without a trust folder there is no record to hold it to. */
  private async assertInstalledHere(plugin: InstalledPlugin): Promise<void> {
    if (this.trustDir === undefined) return
    if ((await this.readTrust())[plugin.manifest.id]?.current !== plugin.manifest.integrity.digest)
      throw new PluginManagerError("PLUGIN_INTEGRITY_MISMATCH", `plugin '${plugin.manifest.id}' is not the package installed on this computer; install it again`)
  }

  private trustFile(): string | undefined {
    if (this.trustDir === undefined) return undefined
    return join(this.trustDir, `${createHash("sha256").update(this.workspaceRoot).digest("hex").slice(0, 32)}.json`)
  }

  private async readTrust(): Promise<Record<string, TrustRecord>> {
    const path = this.trustFile()
    if (path === undefined) return {}
    let text: string
    try {
      text = await readBoundedText(path, 1024 * 1024, { noFollow: true })
    } catch (error) {
      if (isNotFound(error)) return {}
      throw new PluginManagerError("PLUGIN_STATE_INVALID", "the plugin trust record cannot be read")
    }
    try {
      const value = JSON.parse(text) as { version?: unknown; plugins?: unknown }
      if (value.version !== 1 || value.plugins === null || typeof value.plugins !== "object" || Array.isArray(value.plugins)) throw new Error("invalid")
      const plugins: Record<string, TrustRecord> = {}
      for (const [id, record] of Object.entries(value.plugins as Record<string, unknown>)) {
        const entry = record as { current?: unknown; previous?: unknown } | null
        if (entry === null || typeof entry !== "object" || typeof entry.current !== "string" || (entry.previous !== undefined && typeof entry.previous !== "string")) throw new Error("invalid")
        plugins[id] = entry.previous === undefined ? { current: entry.current } : { current: entry.current, previous: entry.previous as string }
      }
      return plugins
    } catch {
      throw new PluginManagerError("PLUGIN_STATE_INVALID", "the plugin trust record is invalid")
    }
  }

  private async recordTrust(id: string, record: TrustRecord | undefined): Promise<void> {
    const path = this.trustFile()
    if (path === undefined || this.trustDir === undefined) return
    const plugins = await this.readTrust()
    if (record === undefined) delete plugins[id]
    else plugins[id] = record
    await mkdir(this.trustDir, { recursive: true, mode: 0o700 })
    const staging = `${path}.${process.pid}.tmp`
    await writeFile(staging, JSON.stringify({ version: 1, plugins }), { encoding: "utf8", mode: 0o600 })
    await rename(staging, path)
  }

  private async readState(): Promise<PluginState> {
    const path = join(this.pluginRoot, ".state.json")
    try {
      const text = await readFile(path, "utf8")
      return parseState(text)
    } catch (error) {
      if (isNotFound(error)) return { version: 1, enabled: {} }
      if (error instanceof PluginManagerError) throw error
      throw new PluginManagerError("PLUGIN_STATE_INVALID", error instanceof Error ? error.message : "plugin state cannot be read")
    }
  }

  private async writeState(): Promise<void> {
    const enabled: Record<string, boolean> = {}
    for (const plugin of this.installed.values()) enabled[plugin.manifest.id] = plugin.enabled
    await writeFile(join(this.pluginRoot, ".state.json"), JSON.stringify({ version: 1, enabled }), "utf8")
  }
}

export async function createPluginManager(options: PluginManagerOptions): Promise<PluginManager> {
  const manager = new PluginManager(options)
  await manager.initialize()
  return manager
}

export async function createPluginIntegrity(
  packageRoot: string,
  options: Pick<PluginManagerOptions, "maxPackageBytes" | "maxPackageFiles"> = {},
): Promise<string> {
  // Its own directory each call: a fixed name could be the caller's, or another call's in flight.
  const temporaryRoot = await mkdtemp(join(tmpdir(), "runrail-integrity-"))
  try {
    const resolver = createLocalPluginSourceResolver({ temporaryRoot })
    const resolved = await resolver.resolve(packageRoot)
    try {
      return await computeIntegrity(resolved.root, options.maxPackageBytes ?? 64 * 1024 * 1024, options.maxPackageFiles ?? 4096)
    } finally {
      await resolved.release?.()
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

const MAX_MANIFEST_BYTES = 1024 * 1024
// Folders count against the walk as files do, so an empty deep or wide tree cannot run it long.
const MAX_PACKAGE_DEPTH = 32

async function readManifest(root: string): Promise<RunrailPluginManifest> {
  const path = join(root, RUNRAIL_PLUGIN_MANIFEST_FILE)
  try {
    return parsePluginManifestJson(await readBoundedText(path, MAX_MANIFEST_BYTES))
  } catch (error) {
    if (error instanceof PluginManagerError) throw error
    throw new PluginManagerError("PLUGIN_PACKAGE_INVALID", error instanceof Error ? error.message : "plugin manifest cannot be read")
  }
}

async function isPiPackage(root: string): Promise<boolean> {
  try {
    await new PiResourceAdapter().discover(root)
    return true
  } catch {
    return false
  }
}

async function verifyIntegrity(
  root: string,
  manifest: RunrailPluginManifest,
  maxBytes: number,
  maxFiles: number,
): Promise<void> {
  const actual = await computeIntegrity(root, maxBytes, maxFiles)
  if (actual !== manifest.integrity.digest)
    throw new PluginManagerError("PLUGIN_INTEGRITY_MISMATCH", `plugin '${manifest.id}' integrity does not match its manifest`)
}

async function computeIntegrity(root: string, maxBytes: number, maxFiles: number): Promise<string> {
  const files = await collectFiles(root, maxBytes, maxFiles)
  const manifest = await readManifest(root)
  const normalizedManifest = JSON.stringify({
    ...manifest,
    integrity: { ...manifest.integrity, digest: "" },
  })
  const hash = createHash("sha256")
  framed(hash, Buffer.from(RUNRAIL_PLUGIN_MANIFEST_FILE))
  framed(hash, Buffer.from(normalizedManifest))
  for (const file of files) {
    framed(hash, Buffer.from(file.relative))
    framed(hash, await readFile(file.absolute))
  }
  return hash.digest("hex")
}

/** Each part with its length first, so no two trees hash the same by moving bytes across a boundary. */
function framed(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(bytes.byteLength))
  hash.update(length)
  hash.update(bytes)
}

interface PackageFile {
  readonly relative: string
  readonly absolute: string
  readonly bytes: number
}

async function collectFiles(root: string, maxBytes: number, maxFiles: number): Promise<readonly PackageFile[]> {
  const result: PackageFile[] = []
  let totalBytes = 0
  let directories = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    directories += 1
    if (depth > MAX_PACKAGE_DEPTH || directories > maxFiles)
      throw new PluginManagerError("PLUGIN_PACKAGE_INVALID", "plugin package exceeds its bounds")
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    if (entries.length > maxFiles) throw new PluginManagerError("PLUGIN_PACKAGE_INVALID", "plugin package exceeds its bounds")
    // Every file is hashed: the manager's own state and staging sit beside packages, never in one,
    // and a skipped name could hold code the entry imports.
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new PluginManagerError("PLUGIN_PACKAGE_INVALID", "symlinks are not allowed in plugin packages")
      if (info.isDirectory()) {
        await visit(absolute, depth + 1)
        continue
      }
      if (!info.isFile()) throw new PluginManagerError("PLUGIN_PACKAGE_INVALID", "plugin package contains an unsupported file")
      const relativePath = relative(root, absolute)
      if (relativePath === RUNRAIL_PLUGIN_MANIFEST_FILE) continue
      result.push({ relative: relativePath.split(sep).join("/"), absolute, bytes: info.size })
      totalBytes += info.size
      if (result.length > maxFiles || totalBytes > maxBytes)
        throw new PluginManagerError("PLUGIN_PACKAGE_INVALID", "plugin package exceeds its bounds")
    }
  }
  await visit(root, 0)
  return Object.freeze(result.sort((a, b) => a.relative.localeCompare(b.relative)))
}

async function resolvePackageDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0 || input.length > 4_096)
    throw new PluginManagerError("PLUGIN_PACKAGE_NOT_FOUND", "plugin package path is invalid")
  try {
    const path = await realpath(resolve(input))
    if (!(await stat(path)).isDirectory()) throw new Error("plugin package path is not a directory")
    return path
  } catch (error) {
    throw new PluginManagerError("PLUGIN_PACKAGE_NOT_FOUND", error instanceof Error ? error.message : "plugin package cannot be read")
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function parseState(text: string): PluginState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PluginManagerError("PLUGIN_STATE_INVALID", "plugin state JSON cannot be parsed")
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.enabled))
    throw new PluginManagerError("PLUGIN_STATE_INVALID", "plugin state shape is invalid")
  const enabled: Record<string, boolean> = {}
  for (const [id, setting] of Object.entries(value.enabled)) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(id) || typeof setting !== "boolean")
      throw new PluginManagerError("PLUGIN_STATE_INVALID", "plugin state entry is invalid")
    enabled[id] = setting
  }
  return { version: 1, enabled: Object.freeze(enabled) }
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new PluginManagerError("PLUGIN_MANAGER_INVALID", "plugin root escapes the workspace")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}
