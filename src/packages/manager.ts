import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import { BoundedReadError, readBoundedText } from "../runtime/bounded-read.ts"
import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { NativeContractError, boundedNativeId, boundedNativeText } from "../native/errors.ts"
import { parseNativePackageManifest, type NativePackageManifest } from "../native/manifest.ts"
import { createNativeLockfile, parseNativeLockfile, verifyNativeLockfile, type NativeLockfile } from "./lockfile.ts"
import { resolveNativePackageGraph, type NativePackageResolutionResult } from "./resolver.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"

export const NATIVE_PACKAGE_MANIFEST_FILE = "runrail.package.json"
export const NATIVE_PACKAGE_LOCKFILE_FILE = "runrail.lock.json"

export interface NativePackageCandidate {
  readonly manifest: NativePackageManifest
  readonly source?: string
}

export interface NativePackageManagerOptions {
  readonly workspaceRoot: string
  readonly packageRoot?: string
  readonly platform?: string
  readonly maxPackageBytes?: number
  readonly maxPackageFiles?: number
  readonly requireSignature?: boolean
  /** Signer name to its Ed25519 public key (PEM). A signature counts only when it verifies against one of these. */
  readonly trustedSigners?: Readonly<Record<string, string>>
}

export interface NativePackageInstallOptions {
  readonly replace?: boolean
  readonly candidates?: readonly NativePackageCandidate[]
  readonly sourceLabel?: string
}

export interface NativeInstalledPackage {
  readonly manifest: NativePackageManifest
  readonly root: string
  readonly enabled: boolean
  readonly active: boolean
}

export interface NativePackageAuditEntry {
  readonly id: string
  readonly version: string
  readonly active: boolean
  /** What makes this install unsafe to rely on: integrity, signature, platform or state. */
  readonly problems: readonly string[]
  /** What it is allowed to do that a reviewer should know: trusted mode, permissions, no approval. */
  readonly notes: readonly string[]
}

export interface NativePackageAudit {
  readonly ok: boolean
  readonly packages: readonly NativePackageAuditEntry[]
}

export interface NativePackageVerification {
  readonly id: string
  readonly version: string
  readonly digest: string
  readonly integrity: "verified" | "failed"
  readonly platform: boolean
  readonly signature: "verified" | "unverified" | "missing"
}

export class NativePackageManagerError extends NativeContractError {
  constructor(reason: string) {
    super("NATIVE_INVALID", reason)
    this.name = "NativePackageManagerError"
  }
}

interface PackageState {
  readonly version: 1
  readonly enabled: Readonly<Record<string, boolean>>
  readonly active: Readonly<Record<string, boolean>>
}

/**
 * Local-first package manager. It validates and stages package bytes but never
 * imports or executes a package entry point.
 */
export class NativePackageManager {
  #workspaceRoot: string
  #packageRoot: string
  private readonly platform: string
  private readonly maxPackageBytes: number
  private readonly maxPackageFiles: number
  private readonly requireSignature: boolean
  private readonly trustedSigners: ReadonlyMap<string, KeyObject>
  private readonly installed = new Map<string, NativeInstalledPackage>()
  private state: PackageState = { version: 1, enabled: {}, active: {} }
  private initialized = false

  constructor(options: NativePackageManagerOptions) {
    this.#workspaceRoot = absolutePath(options.workspaceRoot, "workspace root")
    this.#packageRoot = resolve(options.packageRoot ?? join(this.#workspaceRoot, ".runrail", "packages"))
    assertInside(this.#workspaceRoot, this.#packageRoot)
    this.platform = normalizePlatform(options.platform ?? process.platform)
    this.maxPackageBytes = boundedLimit(options.maxPackageBytes ?? 64 * 1024 * 1024, 1_024, 512 * 1024 * 1024, "package byte limit")
    this.maxPackageFiles = boundedLimit(options.maxPackageFiles ?? 4_096, 1, 32_768, "package file limit")
    this.requireSignature = options.requireSignature === true
    this.trustedSigners = new Map(Object.entries(options.trustedSigners ?? {}).map(([signer, pem]) => [boundedNativeText(signer, "package signer", 256), signerKey(pem)]))
  }

  /** Canonical once initialized. */
  get workspaceRoot(): string {
    return this.#workspaceRoot
  }

  /** Canonical once initialized, and inside the canonical workspace: a linked folder cannot carry writes out of it. */
  get packageRoot(): string {
    return this.#packageRoot
  }

  async initialize(): Promise<readonly NativeInstalledPackage[]> {
    const workspaceRoot = await realpath(this.#workspaceRoot)
    assertInside(workspaceRoot, await realpath(await nearestExisting(this.#packageRoot)))
    await mkdir(this.#packageRoot, { recursive: true, mode: 0o700 })
    const packageRoot = await realpath(this.#packageRoot)
    assertInside(workspaceRoot, packageRoot)
    this.#workspaceRoot = workspaceRoot
    this.#packageRoot = packageRoot
    const state = await this.readState()
    this.state = state
    this.installed.clear()
    const entries = (await readdir(packageRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const root = await realpath(join(packageRoot, entry.name))
      assertInside(packageRoot, root)
      const manifest = await readNativePackageManifest(root)
      await this.verifyRoot(root, manifest)
      this.assertAdmissible(manifest)
      const enabled = this.state.enabled[manifest.id] ?? manifest.enabled
      const active = this.state.active[manifest.id] ?? false
      this.installed.set(manifest.id, Object.freeze({ manifest: Object.freeze({ ...manifest, enabled }), root, enabled, active }))
    }
    this.initialized = true
    return this.list()
  }

  async list(): Promise<readonly NativeInstalledPackage[]> {
    await this.ensureInitialized()
    return Object.freeze([...this.installed.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)).map((item) => Object.freeze({ ...item })))
  }

  async get(id: string): Promise<NativeInstalledPackage | undefined> {
    await this.ensureInitialized()
    const item = this.installed.get(boundedNativeId(id, "package id"))
    return item === undefined ? undefined : Object.freeze({ ...item })
  }

  async install(sourceInput: string, options: NativePackageInstallOptions = {}): Promise<NativeInstalledPackage> {
    await this.ensureInitialized()
    const source = await resolvePackageDirectory(sourceInput)
    const manifest = await readNativePackageManifest(source)
    this.assertAdmissible(manifest)
    await this.verifyRoot(source, manifest)
    const current = this.installed.get(manifest.id)
    if (current !== undefined && options.replace !== true) throw new NativeContractError("NATIVE_DUPLICATE", `package '${manifest.id}' is already installed`)
    const candidates = [
      ...[...this.installed.values()].filter((item) => item.manifest.id !== manifest.id).map((item) => ({ manifest: item.manifest, source: item.root })),
      ...(options.candidates ?? []),
    ]
    const sourceById: Record<string, string> = { [manifest.id]: options.sourceLabel ?? source }
    for (const candidate of options.candidates ?? []) if (candidate.source !== undefined) sourceById[candidate.manifest.id] = candidate.source
    const resolution = resolveNativePackageGraph({ root: manifest, candidates: candidates.map((candidate) => candidate.manifest), sourceById })
    await this.stagePackage(source, manifest, current, resolution.lockfile)
    const enabled = current?.enabled ?? manifest.enabled
    const updated = Object.freeze({ manifest: Object.freeze({ ...manifest, enabled }), root: join(this.packageRoot, manifest.id), enabled, active: false })
    this.installed.set(manifest.id, updated)
    this.state = {
      version: 1,
      enabled: { ...this.state.enabled, [manifest.id]: enabled },
      active: { ...this.state.active, [manifest.id]: false },
    }
    await this.writeState()
    return Object.freeze({ ...updated })
  }

  async update(id: string, source: string): Promise<NativeInstalledPackage> {
    const packageId = boundedNativeId(id, "package id")
    const current = await this.get(packageId)
    if (current === undefined) throw new NativeContractError("NATIVE_NOT_FOUND", `package '${packageId}' was not found`)
    const incoming = await readNativePackageManifest(await resolvePackageDirectory(source))
    if (incoming.id !== packageId) throw new NativeContractError("NATIVE_STATE_CONFLICT", `the update is package '${incoming.id}', not '${packageId}'`)
    return this.install(source, { replace: true })
  }

  async activate(id: string, options: { readonly approvalGranted?: boolean; readonly allowTrusted?: boolean; readonly allowIsolated?: boolean } = {}): Promise<NativeInstalledPackage> {
    await this.ensureInitialized()
    const packageId = boundedNativeId(id, "package id")
    const current = this.installed.get(packageId)
    if (current === undefined) throw new NativeContractError("NATIVE_NOT_FOUND", `package '${packageId}' was not found`)
    if (!current.enabled) throw new NativeContractError("NATIVE_STATE_CONFLICT", "package is disabled")
    if (current.manifest.approval.required && options.approvalGranted !== true) throw new NativeContractError("NATIVE_APPROVAL_REQUIRED", "package activation requires approval")
    if (current.manifest.mode === "trusted" && options.allowTrusted !== true) throw new NativeContractError("NATIVE_CAPABILITY_DENIED", "trusted package activation is not allowed")
    if (current.manifest.mode === "isolated" && options.allowIsolated !== true) throw new NativeContractError("NATIVE_CAPABILITY_DENIED", "isolated package activation is not allowed")
    const updated = Object.freeze({ ...current, active: true })
    this.installed.set(packageId, updated)
    this.state = { ...this.state, active: { ...this.state.active, [packageId]: true } }
    await this.writeState()
    return Object.freeze({ ...updated })
  }

  async deactivate(id: string): Promise<NativeInstalledPackage> {
    await this.ensureInitialized()
    const packageId = boundedNativeId(id, "package id")
    const current = this.installed.get(packageId)
    if (current === undefined) throw new NativeContractError("NATIVE_NOT_FOUND", `package '${packageId}' was not found`)
    const updated = Object.freeze({ ...current, active: false })
    this.installed.set(packageId, updated)
    this.state = { ...this.state, active: { ...this.state.active, [packageId]: false } }
    await this.writeState()
    return Object.freeze({ ...updated })
  }

  async rollback(id: string): Promise<NativeInstalledPackage> {
    await this.ensureInitialized()
    const packageId = boundedNativeId(id, "package id")
    const current = this.installed.get(packageId)
    if (current === undefined) throw new NativeContractError("NATIVE_NOT_FOUND", `package '${packageId}' was not found`)
    const target = join(this.packageRoot, packageId)
    const backup = join(this.packageRoot, `.${packageId}.previous`)
    const staging = join(this.packageRoot, `.${packageId}.rollback`)
    assertInside(this.packageRoot, target)
    assertInside(this.packageRoot, backup)
    let previousRoot: string
    try {
      previousRoot = await realpath(backup)
    } catch {
      throw new NativeContractError("NATIVE_STATE_CONFLICT", "no verified previous package is available")
    }
    const previousManifest = await readNativePackageManifest(previousRoot)
    this.assertAdmissible(previousManifest)
    await this.verifyRoot(previousRoot, previousManifest)
    await rm(staging, { recursive: true, force: true })
    await rename(target, staging)
    try {
      await rename(backup, target)
      await rename(staging, backup)
    } catch (error) {
      try {
        if (!(await exists(target))) await rename(staging, target)
      } catch {
        // Preserve the stable rollback error; recovery is surfaced by doctor.
      }
      throw new NativePackageManagerError(error instanceof Error ? error.message : "package rollback failed")
    }
    const updated = Object.freeze({ manifest: Object.freeze({ ...previousManifest, enabled: current.enabled }), root: target, enabled: current.enabled, active: false })
    this.installed.set(packageId, updated)
    this.state = { ...this.state, active: { ...this.state.active, [packageId]: false } }
    await this.writeState()
    return Object.freeze({ ...updated })
  }

  async remove(id: string): Promise<void> {
    await this.ensureInitialized()
    const packageId = boundedNativeId(id, "package id")
    const current = this.installed.get(packageId)
    if (current === undefined) throw new NativeContractError("NATIVE_NOT_FOUND", `package '${packageId}' was not found`)
    if (current.active) throw new NativeContractError("NATIVE_STATE_CONFLICT", "active package must be deactivated before removal")
    await rm(current.root, { recursive: true, force: false })
    await rm(join(this.packageRoot, `.${packageId}.previous`), { recursive: true, force: true })
    this.installed.delete(packageId)
    const enabled = { ...this.state.enabled }
    const active = { ...this.state.active }
    delete enabled[packageId]
    delete active[packageId]
    this.state = { version: 1, enabled, active }
    await this.writeState()
  }

  async setEnabled(id: string, enabled: boolean): Promise<NativeInstalledPackage> {
    await this.ensureInitialized()
    if (typeof enabled !== "boolean") throw new NativeContractError("NATIVE_INVALID", "enabled flag is invalid")
    const packageId = boundedNativeId(id, "package id")
    const current = this.installed.get(packageId)
    if (current === undefined) throw new NativeContractError("NATIVE_NOT_FOUND", `package '${packageId}' was not found`)
    const updated = Object.freeze({ ...current, manifest: Object.freeze({ ...current.manifest, enabled }), enabled, active: enabled ? current.active : false })
    this.installed.set(packageId, updated)
    this.state = { version: 1, enabled: { ...this.state.enabled, [packageId]: enabled }, active: { ...this.state.active, [packageId]: updated.active } }
    await this.writeState()
    return Object.freeze({ ...updated })
  }

  async lock(): Promise<NativeLockfile> {
    await this.ensureInitialized()
    try {
      return parseNativeLockfile(await readJson(join(this.packageRoot, NATIVE_PACKAGE_LOCKFILE_FILE)))
    } catch (error) {
      if (error instanceof NativeContractError && error.code !== "NATIVE_INVALID") throw error
      throw new NativeContractError("NATIVE_NOT_FOUND", "package lockfile was not found")
    }
  }

  async verify(): Promise<readonly NativePackageVerification[]> {
    await this.ensureInitialized()
    const results: NativePackageVerification[] = []
    for (const item of this.installed.values()) {
      await this.verifyRoot(item.root, item.manifest)
      results.push(Object.freeze({
        id: item.manifest.id,
        version: item.manifest.version,
        digest: item.manifest.integrity.digest,
        integrity: "verified",
        platform: this.platformAllowed(item.manifest),
        signature: item.manifest.integrity.signature === undefined ? "missing" : this.signatureVerifies(item.manifest) ? "verified" : "unverified",
      }))
    }
    return Object.freeze(results)
  }

  async doctor(): Promise<Readonly<Record<string, unknown>>> {
    await this.ensureInitialized()
    const issues: string[] = []
    for (const item of this.installed.values()) {
      try {
        await this.verifyRoot(item.root, item.manifest)
      } catch {
        issues.push(`${item.manifest.id}:integrity`)
      }
      if (!this.platformAllowed(item.manifest)) issues.push(`${item.manifest.id}:platform`)
      if (item.active && !item.enabled) issues.push(`${item.manifest.id}:disabled-active`)
    }
    return Object.freeze({ ok: issues.length === 0, packageCount: this.installed.size, issues: Object.freeze(issues) })
  }

  /** Offline: checks each installed package's files, signature and platform, and lists what it may do. */
  async audit(): Promise<NativePackageAudit> {
    await this.ensureInitialized()
    const packages: NativePackageAuditEntry[] = []
    for (const item of this.installed.values()) {
      const { manifest } = item
      const problems: string[] = []
      const notes: string[] = []
      try {
        await this.verifyRoot(item.root, manifest)
      } catch {
        problems.push("integrity: its files do not match the package digest")
      }
      if (manifest.integrity.signature === undefined) notes.push("signature: unsigned")
      else if (!this.signatureVerifies(manifest)) problems.push("signature: no trusted signer verifies it")
      if (!this.platformAllowed(manifest)) problems.push("platform: not built for this platform")
      if (item.active && !item.enabled) problems.push("state: active although disabled")
      if (manifest.mode === "trusted") notes.push("mode: runs trusted, inside the engine process")
      for (const permission of manifest.permissions) notes.push(`permission: ${permission}`)
      if (!manifest.approval.required && manifest.permissions.length > 0) notes.push("approval: uses its permissions without asking")
      packages.push(Object.freeze({ id: manifest.id, version: manifest.version, active: item.active, problems: Object.freeze(problems), notes: Object.freeze(notes) }))
    }
    return Object.freeze({ ok: packages.every((item) => item.problems.length === 0), packages: Object.freeze(packages) })
  }

  async resolve(root: NativePackageManifest, candidates: readonly NativePackageManifest[] = []): Promise<NativePackageResolutionResult> {
    await this.ensureInitialized()
    this.assertAdmissible(root)
    for (const candidate of candidates) this.assertAdmissible(candidate)
    return resolveNativePackageGraph({ root, candidates })
  }

  private async stagePackage(source: string, manifest: NativePackageManifest, current: NativeInstalledPackage | undefined, lockfile: NativeLockfile): Promise<void> {
    const target = join(this.packageRoot, manifest.id)
    const staging = join(this.packageRoot, `.${manifest.id}.staging`)
    const backup = join(this.packageRoot, `.${manifest.id}.previous`)
    assertInside(this.packageRoot, target)
    await rm(staging, { recursive: true, force: true })
    await cp(source, staging, { recursive: true, force: true, dereference: false })
    try {
      await this.verifyRoot(staging, manifest)
      if (current !== undefined) {
        await rm(backup, { recursive: true, force: true })
        await rename(target, backup)
      }
      await rename(staging, target)
      await writeJson(join(this.packageRoot, NATIVE_PACKAGE_LOCKFILE_FILE), lockfile)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      if (current !== undefined) {
        try {
          if (await exists(backup)) await rename(backup, target)
        } catch {
          // Preserve the install failure; doctor will report the missing target.
        }
      }
      throw error instanceof NativeContractError ? error : new NativePackageManagerError("package install failed")
    }
  }

  private assertAdmissible(manifest: NativePackageManifest): void {
    if (!this.platformAllowed(manifest)) throw new NativeContractError("NATIVE_CAPABILITY_DENIED", `package '${manifest.id}' is not supported on this platform`)
    if (this.requireSignature && !this.signatureVerifies(manifest)) throw new NativeContractError("NATIVE_AUTH_REQUIRED", "package needs a signature from a trusted signer")
  }

  /** An Ed25519 signature over `sha256:<digest>` by a pinned signer; a signer name alone proves nothing. */
  private signatureVerifies(manifest: NativePackageManifest): boolean {
    const { signature, signer, digest } = manifest.integrity
    const key = signer === undefined ? undefined : this.trustedSigners.get(signer)
    if (signature === undefined || key === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false
    try {
      return verifySignature(null, Buffer.from(`sha256:${digest}`), key, Buffer.from(signature, "base64"))
    } catch {
      return false
    }
  }

  private platformAllowed(manifest: NativePackageManifest): boolean {
    return manifest.platforms.includes("any") || manifest.platforms.includes(this.platform)
  }

  private async verifyRoot(root: string, manifest: NativePackageManifest): Promise<void> {
    await verifyPackageTree(root, manifest, this.maxPackageBytes, this.maxPackageFiles)
    const actual = await computeNativePackageIntegrity(root, this.maxPackageBytes, this.maxPackageFiles)
    if (actual !== manifest.integrity.digest) throw new NativeContractError("NATIVE_STATE_CONFLICT", `package '${manifest.id}' integrity does not match its manifest`)
  }

  private async readState(): Promise<PackageState> {
    try {
      const value = await readJson(join(this.packageRoot, ".state.json"))
      if (!isRecord(value) || value.version !== 1 || !isBooleanMap(value.enabled) || !isBooleanMap(value.active)) throw new NativeContractError("NATIVE_INVALID", "package state shape is invalid")
      return { version: 1, enabled: Object.freeze({ ...value.enabled }), active: Object.freeze({ ...value.active }) }
    } catch (error) {
      if (isNotFound(error)) return { version: 1, enabled: {}, active: {} }
      if (error instanceof NativeContractError) throw error
      throw new NativeContractError("NATIVE_STATE_CONFLICT", "package state cannot be read")
    }
  }

  private async writeState(): Promise<void> {
    await writeJson(join(this.packageRoot, ".state.json"), this.state)
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
  }
}

export async function createNativePackageManager(options: NativePackageManagerOptions): Promise<NativePackageManager> {
  const manager = new NativePackageManager(options)
  await manager.initialize()
  return manager
}

export async function readNativePackageManifest(root: string): Promise<NativePackageManifest> {
  const path = join(await resolvePackageDirectory(root), NATIVE_PACKAGE_MANIFEST_FILE)
  let text: string
  try {
    text = await readBoundedText(path, MAX_MANIFEST_BYTES)
  } catch (error) {
    if (error instanceof BoundedReadError) throw new NativeContractError("NATIVE_LIMIT", "native package manifest is too large")
    throw new NativeContractError("NATIVE_NOT_FOUND", "native package manifest was not found")
  }
  try {
    return parseNativePackageManifest(JSON.parse(text))
  } catch (error) {
    if (error instanceof NativeContractError) throw error
    throw new NativePackageManagerError("native package manifest cannot be parsed")
  }
}

export async function computeNativePackageIntegrity(root: string, maxBytes = 64 * 1024 * 1024, maxFiles = 4_096): Promise<string> {
  const packageRoot = await resolvePackageDirectory(root)
  const files = await collectPackageFiles(packageRoot, maxBytes, maxFiles)
  const manifest = await readNativePackageManifest(packageRoot)
  // The signature signs this digest, so it and its signer stay out of it.
  const normalized = JSON.stringify({ ...manifest, integrity: { algorithm: manifest.integrity.algorithm, digest: "" } })
  const hash = createHash("sha256")
  framed(hash, Buffer.from(NATIVE_PACKAGE_MANIFEST_FILE))
  framed(hash, Buffer.from(normalized))
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

async function verifyPackageTree(root: string, manifest: NativePackageManifest, maxBytes: number, maxFiles: number): Promise<void> {
  assertInside(root, join(root, manifest.entry))
  try {
    if (!(await stat(join(root, manifest.entry))).isFile()) throw new Error("entry is not a file")
  } catch {
    throw new NativeContractError("NATIVE_INVALID", "package entry is missing")
  }
  await collectPackageFiles(root, maxBytes, maxFiles)
}

interface PackageFile {
  readonly relative: string
  readonly absolute: string
}

const MAX_MANIFEST_BYTES = 1024 * 1024
// Folders count against the walk as files do, so an empty deep or wide tree cannot run it long.
const MAX_PACKAGE_DEPTH = 32

async function collectPackageFiles(root: string, maxBytes: number, maxFiles: number): Promise<readonly PackageFile[]> {
  const files: PackageFile[] = []
  let totalBytes = 0
  let directories = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    directories += 1
    if (depth > MAX_PACKAGE_DEPTH || directories > maxFiles) throw new NativeContractError("NATIVE_LIMIT", "package exceeds its bounds")
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    if (entries.length > maxFiles) throw new NativeContractError("NATIVE_LIMIT", "package exceeds its bounds")
    // Every file is hashed: the manager's state, lockfile and temporary files sit beside packages, never in one.
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new NativeContractError("NATIVE_INVALID", "package symlinks are not allowed")
      if (info.isDirectory()) {
        await visit(absolute, depth + 1)
        continue
      }
      if (!info.isFile()) throw new NativeContractError("NATIVE_INVALID", "package contains an unsupported file")
      const relativePath = relative(root, absolute)
      if (relativePath === NATIVE_PACKAGE_MANIFEST_FILE) continue
      files.push({ relative: relativePath.split(sep).join("/"), absolute })
      totalBytes += info.size
      if (files.length > maxFiles || totalBytes > maxBytes) throw new NativeContractError("NATIVE_LIMIT", "package exceeds its bounds")
    }
  }
  await visit(root, 0)
  return Object.freeze(files.sort((left, right) => left.relative.localeCompare(right.relative)))
}

async function resolvePackageDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0 || input.length > 4_096) throw new NativeContractError("NATIVE_INVALID", "package source is invalid")
  try {
    const path = await realpath(resolve(input))
    if (!(await stat(path)).isDirectory()) throw new Error("package source is not a directory")
    return path
  } catch (error) {
    if (error instanceof NativeContractError) throw error
    throw new NativeContractError("NATIVE_NOT_FOUND", "package source cannot be read")
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readBoundedText(path, MAX_MANIFEST_BYTES).catch((error: unknown) => {
    throw error instanceof BoundedReadError ? new NativeContractError("NATIVE_LIMIT", "package JSON is too large") : error
  })
  try {
    return JSON.parse(text)
  } catch {
    throw new NativeContractError("NATIVE_INVALID", "package JSON is invalid")
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const root = resolve(path, "..")
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFileAtomic(path, JSON.stringify(value))
}

function absolutePath(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !isAbsolute(value)) throw new NativeContractError("NATIVE_INVALID", `${name} is invalid`)
  return resolve(value)
}

async function nearestExisting(path: string): Promise<string> {
  for (let current = path; ; current = dirname(current)) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (dirname(current) === current || !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error
    }
  }
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new NativeContractError("NATIVE_INVALID", "package path escapes its root")
}

function boundedLimit(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new NativeContractError("NATIVE_LIMIT", `${name} is invalid`)
  return value
}

function normalizePlatform(value: string): string {
  const platform = boundedNativeText(value, "platform", 64).toLowerCase()
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
  return platform
}

function isBooleanMap(value: unknown): value is Readonly<Record<string, boolean>> {
  return isRecord(value) && Object.entries(value).every(([key, entry]) => /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(key) && typeof entry === "boolean")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && String((error as { readonly code: unknown }).code) === "ENOENT"
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

function signerKey(pem: string): KeyObject {
  try {
    if (typeof pem === "string" && pem.length <= 4_096) {
      const key = createPublicKey(pem)
      if (key.asymmetricKeyType === "ed25519") return key
    }
  } catch {
    // Reported below without the key text.
  }
  throw new NativeContractError("NATIVE_INVALID", "package signer key must be an Ed25519 public key")
}
