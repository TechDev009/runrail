import { NativeContractError, boundedNativeId, boundedNativeText, nativeInvalid } from "../native/errors.ts"
import type { NativePackageDependency, NativePackageManifest } from "../native/manifest.ts"
import { createNativeLockfile, type NativeLockfile } from "./lockfile.ts"

export class NativePackageResolutionError extends NativeContractError {
  constructor(reason: string) {
    super("NATIVE_INVALID", reason)
    this.name = "NativePackageResolutionError"
  }
}

export interface NativePackageResolutionResult {
  readonly root: NativePackageManifest
  readonly selected: readonly NativePackageManifest[]
  readonly lockfile: NativeLockfile
}

export function resolveNativePackageGraph(input: {
  readonly root: NativePackageManifest
  readonly candidates: readonly NativePackageManifest[]
  readonly sourceById?: Readonly<Record<string, string>>
  readonly now?: number
}): NativePackageResolutionResult {
  const candidates = new Map<string, NativePackageManifest[]>()
  for (const manifest of input.candidates) {
    const list = candidates.get(manifest.id) ?? []
    list.push(manifest)
    candidates.set(manifest.id, list.sort((left, right) => compareVersions(right.version, left.version)))
  }
  const selected = new Map<string, NativePackageManifest>()
  const visiting = new Set<string>()
  visit(input.root, undefined)
  const manifests = [...selected.values()].filter((manifest) => manifest.id !== input.root.id)
  const lockfile = createNativeLockfile({ root: input.root, packages: manifests, sourceById: input.sourceById, now: input.now })
  return Object.freeze({ root: input.root, selected: Object.freeze(manifests.sort((left, right) => left.id.localeCompare(right.id))), lockfile })

  function visit(manifest: NativePackageManifest, via: NativePackageDependency | undefined): void {
    if (visiting.has(manifest.id)) throw new NativePackageResolutionError(`dependency cycle includes '${manifest.id}'`)
    const existing = selected.get(manifest.id)
    if (existing !== undefined) {
      if (!matchesRange(existing.version, via?.range ?? existing.version)) throw new NativePackageResolutionError(`package '${manifest.id}' has incompatible ranges`)
      return
    }
    selected.set(manifest.id, manifest)
    visiting.add(manifest.id)
    for (const dependency of manifest.dependencies) {
      const options = candidates.get(dependency.id) ?? []
      const selectedDependency = options.find((candidate) => matchesRange(candidate.version, dependency.range))
      if (selectedDependency === undefined) throw new NativePackageResolutionError(`dependency '${dependency.id}' cannot satisfy '${dependency.range}'`)
      if (dependency.digest !== undefined && selectedDependency.integrity.digest !== dependency.digest) throw new NativePackageResolutionError(`dependency '${dependency.id}' digest does not match`) 
      visit(selectedDependency, dependency)
    }
    visiting.delete(manifest.id)
  }
}

export function matchesNativePackageRange(version: string, range: string): boolean {
  return matchesRange(version, range)
}

/**
 * npm's rules: `^` allows changes that keep the left-most non-zero part (`^0.2.3` stays in 0.2.x,
 * `^0.0.3` is 0.0.3 only), `~` keeps major and minor, and a prerelease satisfies a range only when
 * the range names a prerelease of the same version.
 */
function matchesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  const normalized = boundedNativeText(range, "package range", 128).trim()
  if (normalized === "*" || normalized === "latest") return parsed.prerelease.length === 0
  const operator = normalized.startsWith("^") ? "^" : normalized.startsWith("~") ? "~" : ""
  const base = parseVersion(normalized.slice(operator.length))
  if (operator === "") return compareParsed(parsed, base) === 0
  if (parsed.prerelease.length > 0 && (base.prerelease.length === 0 || parsed.major !== base.major || parsed.minor !== base.minor || parsed.patch !== base.patch)) return false
  if (compareParsed(parsed, base) < 0) return false
  if (operator === "~") return parsed.major === base.major && parsed.minor === base.minor
  if (base.major > 0) return parsed.major === base.major
  if (base.minor > 0) return parsed.major === 0 && parsed.minor === base.minor
  return parsed.major === 0 && parsed.minor === 0 && parsed.patch === base.patch
}

function compareVersions(left: string, right: string): number {
  return compareParsed(parseVersion(left), parseVersion(right))
}

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // A release sorts after its prereleases; prerelease parts compare as numbers when both are numeric.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumber = /^\d+$/.test(left)
    const rightNumber = /^\d+$/.test(right)
    if (leftNumber && rightNumber) return Number(left) - Number(right)
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    return left < right ? -1 : 1
  }
  return 0
}

function parseVersion(value: string): ParsedVersion {
  const text = boundedNativeText(value, "package version", 64)
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(text)
  if (match === null) throw new NativePackageResolutionError("package versions must use semver")
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] === undefined ? [] : match[4].split(".") }
}
