import { expect, test } from "bun:test"
import {
  createNativeLockfile,
  parseNativeLockfile,
  resolveNativePackageGraph,
  verifyNativeLockfile,
} from "../../src/packages/index.ts"
import { parseNativePackageManifest } from "../../src/native/index.ts"

const integrity = { algorithm: "sha256" as const, digest: "a".repeat(64) }

function manifest(id: string, version: string, dependencies: readonly unknown[] = []) {
  return parseNativePackageManifest({
    contractVersion: 1,
    apiVersion: "1.0",
    packageType: "extension",
    displayName: id,
    id,
    version,
    entry: "dist/index.js",
    mode: "trusted",
    capabilities: [],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity,
    dependencies,
    contributes: ["tools"],
    platforms: ["linux", "macos"],
    tags: [],
    enabled: true,
  })
}

test("native packages resolve deterministic dependency graphs and lockfiles", () => {
  const dependency = manifest("dep", "1.2.0")
  const root = manifest("root", "1.0.0", [{ id: "dep", range: "^1.0.0", digest: integrity.digest }])
  const resolved = resolveNativePackageGraph({ root, candidates: [dependency], now: 10 })
  expect(resolved.selected.map((item) => item.id)).toEqual(["dep"])
  expect(resolved.lockfile.packages.map((item) => item.id)).toEqual(["dep", "root"])
  expect(() => verifyNativeLockfile(resolved.lockfile, [root, dependency])).not.toThrow()
  expect(parseNativeLockfile(resolved.lockfile)).toMatchObject({ rootId: "root", apiVersion: "1.0" })
})

test("native package resolution refuses unsatisfied or tampered dependencies", () => {
  const root = manifest("root", "1.0.0", [{ id: "dep", range: "^2.0.0" }])
  expect(() => resolveNativePackageGraph({ root, candidates: [manifest("dep", "1.2.0")] })).toThrow("dependency 'dep' cannot satisfy")
  const lock = createNativeLockfile({ root, packages: [], now: 10 })
  expect(() => verifyNativeLockfile(lock, [manifest("root", "1.0.0", [{ id: "dep", range: "^1.0.0" }])])).toThrow("dependencies changed")
  expect(() => parseNativeLockfile({ ...lock, packages: [] })).toThrow("lockfile package list")
})

test("ranges follow npm: a 0.x caret keeps the minor, prereleases need a prerelease range, order does not matter in a lock", () => {
  const pick = (range: string, versions: readonly string[]) => {
    try {
      return resolveNativePackageGraph({ root: manifest("root", "1.0.0", [{ id: "dep", range }]), candidates: versions.map((version) => manifest("dep", version)) }).selected[0]?.version
    } catch {
      return undefined
    }
  }
  expect(pick("^0.2.3", ["0.3.0", "0.2.9"])).toBe("0.2.9")
  expect(pick("^0.0.3", ["0.0.4", "0.0.3"])).toBe("0.0.3")
  expect(pick("^1.2.0", ["2.0.0-beta.1", "1.9.0"])).toBe("1.9.0")
  expect(pick("^1.2.0", ["1.3.0-beta.1"])).toBeUndefined()
  expect(pick("^1.3.0-beta.1", ["1.3.0-beta.2", "1.3.0-beta.10"])).toBe("1.3.0-beta.10")
  expect(pick("^1.3.0-beta.1", ["1.3.0"])).toBe("1.3.0")
  expect(pick("1.0.0", ["1.0.0+build.5"])).toBe("1.0.0+build.5")

  const root = manifest("root", "1.0.0", [{ id: "a", range: "^1.0.0" }, { id: "b", range: "^1.0.0" }])
  const lock = createNativeLockfile({ root, packages: [], now: 10 })
  expect(() => verifyNativeLockfile(lock, [manifest("root", "1.0.0", [{ id: "b", range: "^1.0.0" }, { id: "a", range: "^1.0.0" }])])).not.toThrow()
})
