import { expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  NativePackageManager,
  computeNativePackageIntegrity,
  NATIVE_PACKAGE_MANIFEST_FILE,
} from "../../src/packages/index.ts"

function platform(): string {
  if (process.platform === "darwin") return "macos"
  if (process.platform === "win32") return "windows"
  return process.platform
}

function manifest(version: string, digest: string) {
  return {
    contractVersion: 1,
    apiVersion: "1.0",
    packageType: "extension",
    displayName: "Native fixture",
    id: "fixture.native",
    version,
    entry: "dist/index.js",
    mode: "trusted",
    capabilities: ["tools"],
    permissions: [],
    approval: { required: false, capabilities: [] },
    integrity: { algorithm: "sha256", digest },
    dependencies: [],
    contributes: ["tools"],
    platforms: [platform()],
    tags: [],
    enabled: true,
  }
}

async function writeFixture(root: string, version: string, body: string): Promise<void> {
  await mkdir(join(root, "dist"), { recursive: true })
  await writeFile(join(root, "dist", "index.js"), body, "utf8")
  await writeFile(join(root, NATIVE_PACKAGE_MANIFEST_FILE), JSON.stringify(manifest(version, "a".repeat(64))), "utf8")
  const digest = await computeNativePackageIntegrity(root)
  await writeFile(join(root, NATIVE_PACKAGE_MANIFEST_FILE), JSON.stringify(manifest(version, digest)), "utf8")
}

test("native package manager verifies, stages, activates, rolls back, and recovers", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-manager-"))
  const source = join(workspace, "source")
  try {
    await mkdir(source, { recursive: true })
    await writeFixture(source, "1.0.0", "export const version = 'one'\n")
    const manager = new NativePackageManager({ workspaceRoot: workspace })
    await expect(manager.install(source)).resolves.toMatchObject({ manifest: { id: "fixture.native", version: "1.0.0" }, active: false })
    await expect(manager.activate("fixture.native", { allowTrusted: true })).resolves.toMatchObject({ active: true })
    await expect(manager.verify()).resolves.toMatchObject([{ id: "fixture.native", integrity: "verified" }])
    const clean = await manager.audit()
    expect(clean).toMatchObject({ ok: true, packages: [{ id: "fixture.native", active: true, problems: [] }] })
    expect(clean.packages[0]?.notes).toContain("signature: unsigned")
    await writeFile(join(workspace, ".runrail", "packages", "fixture.native", "dist", "index.js"), "tampered\n", "utf8")
    await expect(manager.audit()).resolves.toMatchObject({ ok: false, packages: [{ problems: ["integrity: its files do not match the package digest"] }] })
    await writeFile(join(workspace, ".runrail", "packages", "fixture.native", "dist", "index.js"), "export const version = 'one'\n", "utf8")

    await writeFixture(source, "2.0.0", "export const version = 'two'\n")
    await expect(manager.update("fixture.native", source)).resolves.toMatchObject({ manifest: { version: "2.0.0" }, active: false })
    await expect(manager.rollback("fixture.native")).resolves.toMatchObject({ manifest: { version: "1.0.0" } })

    const recovered = new NativePackageManager({ workspaceRoot: workspace })
    await expect(recovered.list()).resolves.toMatchObject([{ manifest: { id: "fixture.native", version: "1.0.0" } }])
    expect(await readFile(join(workspace, ".runrail", "packages", "fixture.native", "dist", "index.js"), "utf8")).toContain("one")
    await recovered.deactivate("fixture.native")
    await recovered.remove("fixture.native")
    await expect(recovered.list()).resolves.toEqual([])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

 test("native package manager refuses tampered package bytes and unapproved activation", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-manager-reject-"))
  const source = join(workspace, "source")
  try {
    await mkdir(source, { recursive: true })
    await writeFixture(source, "1.0.0", "export const version = 'one'\n")
    await writeFile(join(source, "dist", "index.js"), "tampered\n", "utf8")
    const manager = new NativePackageManager({ workspaceRoot: workspace })
    await expect(manager.install(source)).rejects.toMatchObject({ code: "NATIVE_STATE_CONFLICT" })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("a package counts as signed only when its signature verifies against a pinned signer key", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-manager-signed-"))
  const source = join(workspace, "source")
  try {
    await mkdir(source, { recursive: true })
    await writeFixture(source, "1.0.0", "export const version = 'one'\n")
    const written = JSON.parse(await readFile(join(source, NATIVE_PACKAGE_MANIFEST_FILE), "utf8")) as ReturnType<typeof manifest>
    const signer = generateKeyPairSync("ed25519")
    const other = generateKeyPairSync("ed25519")
    const pem = signer.publicKey.export({ type: "spki", format: "pem" }).toString()
    const signed = (key: typeof signer.privateKey, name: string) => ({ ...written, integrity: { ...written.integrity, signer: name, signature: sign(null, Buffer.from(`sha256:${written.integrity.digest}`), key).toString("base64") } })

    // A name that matches the pinned signer, with a signature from some other key.
    await writeFile(join(source, NATIVE_PACKAGE_MANIFEST_FILE), JSON.stringify(signed(other.privateKey, "release")), "utf8")
    const strict = new NativePackageManager({ workspaceRoot: workspace, requireSignature: true, trustedSigners: { release: pem } })
    await expect(strict.install(source)).rejects.toMatchObject({ code: "NATIVE_AUTH_REQUIRED" })

    await writeFile(join(source, NATIVE_PACKAGE_MANIFEST_FILE), JSON.stringify(signed(signer.privateKey, "release")), "utf8")
    await expect(strict.install(source)).resolves.toMatchObject({ manifest: { id: "fixture.native" } })
    await expect(strict.verify()).resolves.toMatchObject([{ id: "fixture.native", signature: "verified" }])
    // Without the pinned key the same signature is only a claim.
    await expect(new NativePackageManager({ workspaceRoot: workspace }).verify()).resolves.toMatchObject([{ signature: "unverified" }])
    await expect(new NativePackageManager({ workspaceRoot: workspace }).audit()).resolves.toMatchObject({ ok: false, packages: [{ problems: ["signature: no trusted signer verifies it"] }] })
    expect(() => new NativePackageManager({ workspaceRoot: workspace, trustedSigners: { release: "not a key" } })).toThrow("Ed25519")
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("moving bytes across a file boundary changes the package digest", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-digest-"))
  try {
    const split = join(workspace, "split")
    const joined = join(workspace, "joined")
    for (const root of [split, joined]) {
      await mkdir(join(root, "dist"), { recursive: true })
      await writeFile(join(root, NATIVE_PACKAGE_MANIFEST_FILE), JSON.stringify(manifest("1.0.0", "a".repeat(64))), "utf8")
    }
    await writeFile(join(split, "dist", "a.js"), "X")
    await writeFile(join(split, "dist", "b.js"), "Y")
    await writeFile(join(joined, "dist", "a.js"), "Xdist/b.js\0Y")
    expect(await computeNativePackageIntegrity(split)).not.toBe(await computeNativePackageIntegrity(joined))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("a package with a symlink in it is refused", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-symlink-"))
  const source = join(workspace, "source")
  try {
    await mkdir(source, { recursive: true })
    await writeFixture(source, "1.0.0", "export const version = 'one'\n")
    await symlink("/etc/hosts", join(source, "dist", "hosts.js"))
    await expect(new NativePackageManager({ workspaceRoot: workspace }).install(source)).rejects.toThrow("symlinks are not allowed")
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("a package folder nested past the depth limit, or an oversized manifest, is refused", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-bounds-"))
  const source = join(workspace, "source")
  try {
    await mkdir(source, { recursive: true })
    await writeFixture(source, "1.0.0", "export const version = 'one'\n")
    await mkdir(join(source, ...Array.from({ length: 40 }, (_, index) => `d${String(index)}`)), { recursive: true })
    await expect(new NativePackageManager({ workspaceRoot: workspace }).install(source)).rejects.toMatchObject({ code: "NATIVE_LIMIT" })
    await rm(join(source, "d0"), { recursive: true })
    await writeFile(join(source, "runrail.package.json"), `{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`, "utf8")
    await expect(new NativePackageManager({ workspaceRoot: workspace }).install(source)).rejects.toMatchObject({ code: "NATIVE_LIMIT" })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("every file in a native package is in its digest, whatever its name", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-names-"))
  try {
    await writeFixture(workspace, "1.0.0", "export const version = 'one'\n")
    for (const name of ["entry.tmp", ".state.json", "runrail.lock.json"]) {
      await writeFile(join(workspace, name), "one", "utf8")
      const before = await computeNativePackageIntegrity(workspace)
      await writeFile(join(workspace, name), "two", "utf8")
      expect(await computeNativePackageIntegrity(workspace)).not.toBe(before)
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("a package folder linked out of the workspace is refused before anything is written", async () => {
  const parent = await mkdtemp(join("/tmp", "runrail-package-escape-"))
  try {
    const source = join(parent, "source")
    await mkdir(source, { recursive: true })
    await writeFixture(source, "1.0.0", "export const version = 'one'\n")
    for (const linked of [join(".runrail", "packages"), ".runrail"]) {
      const workspace = join(parent, `workspace-${linked.length}`)
      const outside = join(parent, `outside-${linked.length}`)
      await mkdir(join(workspace, ".runrail"), { recursive: true })
      await mkdir(outside)
      await rm(join(workspace, linked), { recursive: true, force: true })
      await symlink(outside, join(workspace, linked))
      await expect(new NativePackageManager({ workspaceRoot: workspace }).install(source)).rejects.toMatchObject({ code: "NATIVE_INVALID" })
      expect(await readdir(outside)).toEqual([])
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("an update must be the same package", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-package-identity-"))
  const source = join(workspace, "source")
  const other = join(workspace, "other")
  try {
    await mkdir(source, { recursive: true })
    await mkdir(other, { recursive: true })
    await writeFixture(source, "1.0.0", "export const version = 'one'\n")
    await writeFixture(other, "2.0.0", "export const version = 'other'\n")
    const written = JSON.parse(await readFile(join(other, NATIVE_PACKAGE_MANIFEST_FILE), "utf8")) as Record<string, unknown>
    await writeFile(join(other, NATIVE_PACKAGE_MANIFEST_FILE), JSON.stringify({ ...written, id: "fixture.other" }), "utf8")
    await writeFile(join(other, NATIVE_PACKAGE_MANIFEST_FILE), JSON.stringify({ ...written, id: "fixture.other", integrity: { algorithm: "sha256", digest: await computeNativePackageIntegrity(other) } }), "utf8")
    const manager = new NativePackageManager({ workspaceRoot: workspace })
    await manager.install(source)
    await expect(manager.update("fixture.native", other)).rejects.toMatchObject({ code: "NATIVE_STATE_CONFLICT" })
    await expect(manager.list()).resolves.toMatchObject([{ manifest: { id: "fixture.native", version: "1.0.0" } }])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
