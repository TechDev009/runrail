import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createPiMigrationPlan,
  PiResourceAdapter,
  PiResourceCompatibilityError,
  parsePiResourceManifest,
  type PiResourceBundle,
} from "../../src/plugins/index.ts"

test("Pi resource adapter discovers conventional resources without executing extensions", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-pi-resources-"))
  try {
    await mkdir(join(root, "extensions"))
    await mkdir(join(root, "skills"))
    await mkdir(join(root, "prompts"))
    await mkdir(join(root, "themes"))
    await writeFile(join(root, "extensions", "main.ts"), "throw new Error('must not execute')\n", "utf8")
    await writeFile(join(root, "skills", "review.md"), "review skill\n", "utf8")
    await writeFile(join(root, "prompts", "review.md"), "review prompt\n", "utf8")
    await writeFile(join(root, "themes", "dark.json"), "{}\n", "utf8")
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "pi-fixture",
      version: "1.0.0",
      pi: { extensions: ["extensions/main.ts"], skills: ["skills/review.md"], prompts: ["prompts/review.md"], themes: ["themes/dark.json"] },
    }), "utf8")

    const resources = await new PiResourceAdapter().discover(root)
    expect(resources.manifest.packageId).toBe("pi-fixture")
    expect(resources.entries.map((entry) => entry.kind)).toEqual(["extension", "prompt", "skill", "theme"])
    expect(resources.entries.find((entry) => entry.kind === "extension")?.activation).toBe("caller-owned")
    expect(resources.entries.map((entry) => entry.path)).toEqual([
      "extensions/main.ts",
      "prompts/review.md",
      "skills/review.md",
      "themes/dark.json",
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pi migration planning makes native resources actionable and extensions explicit", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-pi-migration-"))
  try {
    await mkdir(join(root, "extensions"))
    await mkdir(join(root, "skills"))
    await mkdir(join(root, "prompts"))
    await mkdir(join(root, "themes"))
    await writeFile(join(root, "extensions", "main.ts"), "throw new Error('must not execute')\n", "utf8")
    await writeFile(join(root, "skills", "review.md"), "review skill\n", "utf8")
    await writeFile(join(root, "prompts", "review.md"), "review prompt\n", "utf8")
    await writeFile(join(root, "themes", "dark.json"), "{}\n", "utf8")
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "pi-migration-fixture",
      version: "1.0.0",
      pi: { extensions: ["extensions/main.ts"], skills: ["skills/review.md"], prompts: ["prompts/review.md"], themes: ["themes/dark.json"] },
    }), "utf8")

    const bundle = await new PiResourceAdapter().discover(root)
    const plan = createPiMigrationPlan(bundle)

    expect(plan.version).toBe(1)
    expect(plan.packageId).toBe("pi-migration-fixture")
    expect(plan.nativeResources).toBe(3)
    expect(plan.callerOwnedResources).toBe(1)
    expect(plan.requiresManualMigration).toBe(true)
    expect(plan.nextAction).toBe("author-runrail-plugin-or-use-pi-pass-through")
    expect(plan.steps).toEqual([
      expect.objectContaining({ kind: "extension", status: "manual-review", action: "author-runrail-plugin" }),
      expect.objectContaining({ kind: "prompt", status: "ready", action: "map-prompt-template" }),
      expect.objectContaining({ kind: "skill", status: "ready", action: "load-skill" }),
      expect.objectContaining({ kind: "theme", status: "ready", action: "load-theme" }),
    ])
    expect(JSON.stringify(plan)).not.toContain("must not execute")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pi resource manifest parsing refuses traversal and unsupported package versions", () => {
  expect(() => parsePiResourceManifest({ packageId: "fixture", version: "1.0.0", extensions: ["../escape.ts"] })).toThrow("PI_RESOURCE_INVALID")
  expect(() => parsePiResourceManifest({ packageId: "fixture", version: "1.0.0", adapterVersion: 9 })).toThrow("PI_RESOURCE_UNSUPPORTED")
})

test("Pi migration planning rejects duplicate or contradictory resource metadata", () => {
  const base: PiResourceBundle = {
    manifest: { adapterVersion: 1, packageId: "fixture", version: "1.0.0", extensions: [], skills: ["skills/review.md"], prompts: [], themes: [] },
    root: "/tmp/pi-fixture",
    entries: [{ kind: "skill", path: "skills/review.md", activation: "native" }],
  }
  expect(() => createPiMigrationPlan({ ...base, entries: [...base.entries, ...base.entries] })).toThrow("PI_RESOURCE_INVALID")
  expect(() => createPiMigrationPlan({ ...base, entries: [{ kind: "skill", path: "skills/review.md", activation: "caller-owned" }] })).toThrow("PI_RESOURCE_INVALID")
  expect(() => createPiMigrationPlan({ ...base, manifest: { ...base.manifest, packageId: "bad id" } })).toThrow("PI_RESOURCE_INVALID")
})

test("Pi resource adapter refuses missing resources instead of silently activating them", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-pi-resources-missing-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-missing", version: "1.0.0", pi: { extensions: ["extensions/missing.ts"] } }), "utf8")
    await expect(new PiResourceAdapter().discover(root)).rejects.toBeInstanceOf(PiResourceCompatibilityError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pi resource adapter refuses symlinks that escape the package root", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-pi-resources-symlink-"))
  const outside = await mkdtemp(join("/tmp", "runrail-pi-resources-outside-"))
  try {
    await writeFile(join(outside, "secret.ts"), "secret extension\n", "utf8")
    await symlink(join(outside, "secret.ts"), join(root, "extension.ts"))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-symlink", version: "1.0.0", pi: { extensions: ["extension.ts"] } }), "utf8")
    await expect(new PiResourceAdapter().discover(root)).rejects.toMatchObject({ code: "PI_RESOURCE_INVALID" })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
