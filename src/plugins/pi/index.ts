import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { PI_RESOURCE_ADAPTER_VERSION } from "./constants.ts"
import { PiResourceCompatibilityError } from "./errors.ts"

export { PI_RESOURCE_ADAPTER_VERSION } from "./constants.ts"
export { PiResourceCompatibilityError } from "./errors.ts"

export { createPiMigrationPlan, PI_MIGRATION_PLAN_VERSION } from "./migration.ts"
export type {
  PiMigrationAction,
  PiMigrationNextAction,
  PiMigrationPlan,
  PiMigrationStep,
  PiMigrationStepStatus,
} from "./migration.ts"

export type PiResourceKind = "extension" | "skill" | "prompt" | "theme"
export type PiResourceActivation = "native" | "caller-owned"

export interface PiResourceManifest {
  readonly adapterVersion: typeof PI_RESOURCE_ADAPTER_VERSION
  readonly packageId: string
  readonly version: string
  readonly extensions: readonly string[]
  readonly skills: readonly string[]
  readonly prompts: readonly string[]
  readonly themes: readonly string[]
}

export interface PiResourceEntry {
  readonly kind: PiResourceKind
  readonly path: string
  readonly activation: PiResourceActivation
}

export interface PiResourceBundle {
  readonly manifest: PiResourceManifest
  readonly root: string
  readonly entries: readonly PiResourceEntry[]
}

export interface PiResourceAdapterOptions {
  readonly maxEntries?: number
  readonly maxManifestBytes?: number
}

/** Discover Pi package resources without importing or executing extension code. */
export class PiResourceAdapter {
  private readonly maxEntries: number
  private readonly maxManifestBytes: number

  constructor(options: PiResourceAdapterOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1_024
    this.maxManifestBytes = options.maxManifestBytes ?? 256 * 1024
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 16_384 || !Number.isSafeInteger(this.maxManifestBytes) || this.maxManifestBytes < 1_024 || this.maxManifestBytes > 4 * 1024 * 1024)
      throw new PiResourceCompatibilityError("PI_RESOURCE_LIMIT", "resource limits are invalid")
  }

  async discover(inputRoot: string): Promise<PiResourceBundle> {
    if (typeof inputRoot !== "string" || inputRoot.length === 0 || inputRoot.length > 4_096) throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", "package root is invalid")
    let root: string
    try {
      root = await realpath(resolve(inputRoot))
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory")
    } catch {
      throw new PiResourceCompatibilityError("PI_RESOURCE_NOT_FOUND", "package root cannot be read")
    }
    const packageJson = await this.readPackageJson(root)
    const manifest = parsePiResourceManifest(manifestValue(packageJson, root))
    const entries: PiResourceEntry[] = []
    await this.collect(root, manifest.extensions, "extension", entries)
    await this.collect(root, manifest.skills, "skill", entries)
    await this.collect(root, manifest.prompts, "prompt", entries)
    await this.collect(root, manifest.themes, "theme", entries)
    if (entries.length === 0) {
      await this.collectConventional(root, "extensions", "extension", entries)
      await this.collectConventional(root, "skills", "skill", entries)
      await this.collectConventional(root, "prompts", "prompt", entries)
      await this.collectConventional(root, "themes", "theme", entries)
    }
    if (entries.length === 0) throw new PiResourceCompatibilityError("PI_RESOURCE_NOT_FOUND", "package declares no discoverable resources")
    const seen = new Set<string>()
    const sorted = entries.filter((entry) => {
      const key = `${entry.kind}:${entry.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path))
    return Object.freeze({ manifest, root, entries: Object.freeze(sorted) })
  }

  private async readPackageJson(root: string): Promise<unknown> {
    try {
      const text = await readFile(resolve(root, "package.json"), "utf8")
      if (Buffer.byteLength(text, "utf8") > this.maxManifestBytes) throw new PiResourceCompatibilityError("PI_RESOURCE_LIMIT", "package manifest is too large")
      try {
        return JSON.parse(text)
      } catch {
        throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", "package manifest JSON is malformed")
      }
    } catch (error) {
      if (error instanceof PiResourceCompatibilityError) throw error
      return Object.freeze({})
    }
  }

  private async collect(root: string, paths: readonly string[], kind: PiResourceKind, entries: PiResourceEntry[]): Promise<void> {
    for (const path of paths) await this.collectPath(root, path, kind, entries)
  }

  private async collectConventional(root: string, directory: string, kind: PiResourceKind, entries: PiResourceEntry[]): Promise<void> {
    try {
      const children = await readdir(resolve(root, directory))
      await this.collect(root, children.map((child) => `${directory}/${child}`), kind, entries)
    } catch (error) {
      if (!isNotFound(error)) throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", "resource directory cannot be read")
    }
  }

  private async collectPath(root: string, path: string, kind: PiResourceKind, entries: PiResourceEntry[]): Promise<void> {
    const safe = validateRelativePath(path)
    const resolved = resolve(root, safe)
    const rel = relative(root, resolved)
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", "resource path escapes package")
    let actual: string
    try {
      actual = await realpath(resolved)
      const actualRel = relative(root, actual)
      if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", "resource symlink escapes package")
      const info = await stat(actual)
      if (info.isDirectory()) {
        const children = await readdir(actual)
        for (const child of children) await this.collectPath(root, `${safe}/${child}`, kind, entries)
        return
      }
      if (!info.isFile()) throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", "resource is not a file")
    } catch (error) {
      if (error instanceof PiResourceCompatibilityError) throw error
      throw new PiResourceCompatibilityError("PI_RESOURCE_NOT_FOUND", "declared resource cannot be read")
    }
    if (entries.length >= this.maxEntries) throw new PiResourceCompatibilityError("PI_RESOURCE_LIMIT", "resource entry limit reached")
    entries.push(Object.freeze({ kind, path: relative(root, actual).split(sep).join("/"), activation: kind === "extension" ? "caller-owned" : "native" }))
  }
}

export function parsePiResourceManifest(value: unknown): PiResourceManifest {
  if (!isRecord(value)) invalid("manifest must be an object")
  const adapterVersion = value.adapterVersion === undefined ? PI_RESOURCE_ADAPTER_VERSION : value.adapterVersion
  if (adapterVersion !== PI_RESOURCE_ADAPTER_VERSION) unsupported("resource adapter version is unsupported")
  const packageId = identifier(value.packageId, "package id")
  const version = text(value.version, "package version", 64)
  const extensions = paths(value.extensions, "extensions")
  const skills = paths(value.skills, "skills")
  const prompts = paths(value.prompts, "prompts")
  const themes = paths(value.themes, "themes")
  return Object.freeze({ adapterVersion: PI_RESOURCE_ADAPTER_VERSION, packageId, version, extensions, skills, prompts, themes })
}

function manifestValue(packageJson: unknown, root: string): Record<string, unknown> {
  if (!isRecord(packageJson)) invalid("package manifest must be an object")
  const pi = packageJson.pi
  if (pi !== undefined && !isRecord(pi)) invalid("package pi manifest is invalid")
  const source = pi === undefined ? {} : pi
  return {
    ...source,
    packageId: source.packageId ?? packageJson.name ?? basename(root),
    version: source.version ?? packageJson.version ?? "0.0.0",
  }
}

function paths(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 256) throw new PiResourceCompatibilityError("PI_RESOURCE_LIMIT", `${field} list is invalid`)
  const result = value.map((entry) => validateRelativePath(entry))
  if (new Set(result).size !== result.length) invalid(`${field} contains duplicates`)
  return Object.freeze(result.sort())
}

function validateRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) invalid("resource path is unsafe")
  return value
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 128)
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(result)) invalid(`${field} is invalid`)
  return result
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || /[\r\n]/.test(value)) invalid(`${field} is invalid`)
  return value
}

function invalid(reason: string): never {
  throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", reason)
}

function unsupported(reason: string): never {
  throw new PiResourceCompatibilityError("PI_RESOURCE_UNSUPPORTED", reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}
