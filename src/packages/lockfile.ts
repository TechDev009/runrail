import { NATIVE_API_VERSION, NATIVE_CONTRACT_VERSION, NativeContractError, boundedNativeId, boundedNativeText, requireNativeTimestamp } from "../native/errors.ts"
import type { NativePackageDependency, NativePackageIntegrity, NativePackageManifest } from "../native/manifest.ts"

export interface NativeLockedPackage {
  readonly id: string
  readonly version: string
  readonly digest: string
  readonly source: string
  readonly dependencies: readonly NativePackageDependency[]
  readonly integrity: NativePackageIntegrity
}

export interface NativeLockfile {
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION
  readonly apiVersion: typeof NATIVE_API_VERSION
  readonly rootId: string
  readonly generatedAt: number
  readonly packages: readonly NativeLockedPackage[]
}

export class NativeLockfileError extends NativeContractError {
  constructor(reason: string) {
    super("NATIVE_INVALID", reason)
    this.name = "NativeLockfileError"
  }
}

export function createNativeLockfile(input: {
  readonly root: NativePackageManifest
  readonly packages: readonly NativePackageManifest[]
  readonly sourceById?: Readonly<Record<string, string>>
  readonly now?: number
}): NativeLockfile {
  const sourceById = input.sourceById ?? {}
  const manifests = [input.root, ...input.packages]
  const seen = new Set<string>()
  const packages: NativeLockedPackage[] = []
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) throw new NativeLockfileError(`duplicate package '${manifest.id}'`)
    seen.add(manifest.id)
    packages.push(Object.freeze({
      id: manifest.id,
      version: manifest.version,
      digest: manifest.integrity.digest,
      source: boundedNativeText(sourceById[manifest.id] ?? `local:${manifest.id}`, "package source", 2_048),
      dependencies: Object.freeze([...manifest.dependencies]),
      integrity: manifest.integrity,
    }))
  }
  const generatedAt = input.now ?? Date.now()
  requireNativeTimestamp(generatedAt, "lockfile timestamp")
  return Object.freeze({ contractVersion: NATIVE_CONTRACT_VERSION, apiVersion: NATIVE_API_VERSION, rootId: input.root.id, generatedAt, packages: Object.freeze(packages.sort((left, right) => left.id.localeCompare(right.id))) })
}

export function parseNativeLockfile(value: unknown): NativeLockfile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeLockfileError("lockfile must be an object")
  const record = value as Record<string, unknown>
  knownKeys(record, ["contractVersion", "apiVersion", "rootId", "generatedAt", "packages"])
  if (record.contractVersion !== NATIVE_CONTRACT_VERSION || record.apiVersion !== NATIVE_API_VERSION) throw new NativeContractError("NATIVE_UNSUPPORTED_VERSION", "lockfile version is unsupported")
  const rootId = boundedNativeId(record.rootId, "lockfile root id")
  const generatedAt = requireNativeTimestamp(record.generatedAt, "lockfile timestamp")
  if (!Array.isArray(record.packages) || record.packages.length === 0 || record.packages.length > 4_096) throw new NativeLockfileError("lockfile package list is invalid")
  const ids = new Set<string>()
  const packages = record.packages.map((entry) => parseLockedPackage(entry, ids))
  if (!packages.some((entry) => entry.id === rootId)) throw new NativeLockfileError("lockfile root package is missing")
  return Object.freeze({ contractVersion: NATIVE_CONTRACT_VERSION, apiVersion: NATIVE_API_VERSION, rootId, generatedAt, packages: Object.freeze(packages.sort((left, right) => left.id.localeCompare(right.id))) })
}

export function verifyNativeLockfile(lockfile: NativeLockfile, manifests: readonly NativePackageManifest[]): void {
  const parsed = parseNativeLockfile(lockfile)
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]))
  for (const locked of parsed.packages) {
    const manifest = byId.get(locked.id)
    if (manifest === undefined) throw new NativeLockfileError(`locked package '${locked.id}' is unavailable`)
    if (manifest.version !== locked.version || manifest.integrity.digest !== locked.digest) throw new NativeLockfileError(`locked package '${locked.id}' does not match its manifest`)
    if (!sameDependencies(manifest.dependencies, locked.dependencies)) throw new NativeLockfileError(`locked package '${locked.id}' dependencies changed`)
  }
}

function parseLockedPackage(value: unknown, ids: Set<string>): NativeLockedPackage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeLockfileError("locked package is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["id", "version", "digest", "source", "dependencies", "integrity"])
  const id = boundedNativeId(record.id, "locked package id")
  if (ids.has(id)) throw new NativeLockfileError(`duplicate locked package '${id}'`)
  ids.add(id)
  const version = boundedNativeText(record.version, "locked package version", 64)
  const digest = boundedNativeText(record.digest, "locked package digest", 128)
  if (!/^[a-f0-9]{64}$/i.test(digest)) throw new NativeLockfileError("locked package digest is invalid")
  const source = boundedNativeText(record.source, "locked package source", 2_048)
  if (!Array.isArray(record.dependencies) || record.dependencies.length > 256) throw new NativeLockfileError("locked package dependencies are invalid")
  const dependencies = Object.freeze(record.dependencies.map(parseDependency))
  const integrity = parseIntegrity(record.integrity)
  if (integrity.digest !== digest.toLowerCase()) throw new NativeLockfileError("locked package integrity digest differs")
  return Object.freeze({ id, version, digest: digest.toLowerCase(), source, dependencies, integrity })
}

function parseDependency(value: unknown): NativePackageDependency {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeLockfileError("locked dependency is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["id", "range", "digest"])
  const id = boundedNativeId(record.id, "dependency id")
  const range = boundedNativeText(record.range, "dependency range", 128)
  const digest = record.digest === undefined ? undefined : boundedNativeText(record.digest, "dependency digest", 128)
  if (digest !== undefined && !/^[a-f0-9]{64}$/i.test(digest)) throw new NativeLockfileError("dependency digest is invalid")
  return Object.freeze({ id, range, ...(digest === undefined ? {} : { digest: digest.toLowerCase() }) })
}

function parseIntegrity(value: unknown): NativePackageIntegrity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new NativeLockfileError("locked integrity is invalid")
  const record = value as Record<string, unknown>
  knownKeys(record, ["algorithm", "digest", "signature", "signer"])
  if (record.algorithm !== "sha256" || typeof record.digest !== "string" || !/^[a-f0-9]{64}$/i.test(record.digest)) throw new NativeLockfileError("locked integrity is invalid")
  if (record.signature !== undefined && (typeof record.signature !== "string" || record.signature.length === 0 || record.signature.length > 4_096)) throw new NativeLockfileError("locked signature is invalid")
  if (record.signer !== undefined && (typeof record.signer !== "string" || record.signer.length === 0 || record.signer.length > 256)) throw new NativeLockfileError("locked signer is invalid")
  return Object.freeze({ algorithm: "sha256", digest: record.digest.toLowerCase(), ...(record.signature === undefined ? {} : { signature: record.signature }), ...(record.signer === undefined ? {} : { signer: record.signer }) })
}

/** The same dependencies in any order, each compared field by field rather than by how its JSON was written. */
function sameDependencies(left: readonly NativePackageDependency[], right: readonly NativePackageDependency[]): boolean {
  if (left.length !== right.length) return false
  const key = (dependency: NativePackageDependency): string => `${dependency.id}\u0000${dependency.range}\u0000${dependency.digest?.toLowerCase() ?? ""}`
  const sorted = (list: readonly NativePackageDependency[]): string[] => list.map(key).sort()
  const a = sorted(left)
  const b = sorted(right)
  return a.every((entry, index) => entry === b[index])
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new NativeLockfileError("lockfile contains unknown fields")
}
