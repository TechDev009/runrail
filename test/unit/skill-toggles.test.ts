import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"
import { SkillRegistry } from "../../src/skills/registry.ts"

async function fixtureRegistry() {  const root = await mkdtemp(join(tmpdir(), "runrail-skills-"))
  await mkdir(join(root, "skills", "alpha"), { recursive: true })
  await mkdir(join(root, "skills", "beta"), { recursive: true })
  await writeFile(
    join(root, "skills", "alpha", "SKILL.md"),
    "---\nid: alpha\ndescription: First skill\n---\nDo alpha things.",
  )
  await writeFile(join(root, "skills", "beta", "SKILL.md"), "Do beta things.")
  const policy = await createWorkspacePolicy(root)
  const registry = new SkillRegistry(policy, { sources: [{ path: "skills" }] })
  await registry.reload()
  return { root, registry }
}

function expectSkillInvalid(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    expect((error as { code?: string }).code).toBe("SKILL_INVALID")
    return
  }
  throw new Error("expected SKILL_INVALID")
}

describe("skill toggles", () => {
  test("lists discovered skills enabled, then excludes and restores", async () => {
    const { root, registry } = await fixtureRegistry()
    try {
      expect(registry.snapshot().map((skill) => skill.id).sort()).toEqual(["alpha", "beta"])
      expect(registry.isEnabled("alpha")).toBe(true)

      registry.setExcluded(["alpha"])
      expect(registry.isEnabled("alpha")).toBe(false)
      expect(registry.snapshot().map((skill) => skill.id)).toEqual(["beta"])
      expect(registry.excluded().map((skill) => skill.id)).toEqual(["alpha"])
      expect(registry.resources().some((resource) => resource.id === "skill:alpha")).toBe(false)

      registry.setExcluded([])
      expect(registry.snapshot()).toHaveLength(2)
      expect(registry.isEnabled("alpha")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects invalid exclusion lists", async () => {
    const { root, registry } = await fixtureRegistry()
    try {
      expectSkillInvalid(() => registry.setExcluded([""]))
      expectSkillInvalid(() => registry.setExcluded(["no!valid"]))
      expectSkillInvalid(() => registry.setExcluded(Array.from({ length: 513 }, (_, i) => `s${i}`)))
      expectSkillInvalid(() => registry.isEnabled(""))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("as many skills can be switched off as a registry can hold", async () => {
    const { root, registry } = await fixtureRegistry()
    try {
      registry.setExcluded(["alpha", ...Array.from({ length: 511 }, (_, i) => `s${i}`)])
      expect(registry.snapshot().map((skill) => skill.id)).toEqual(["beta"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("constructor exclusions apply from the start", async () => {
    const { root } = await fixtureRegistry()
    try {
      const policy = await createWorkspacePolicy(root)
      const second = new SkillRegistry(policy, { sources: [{ path: "skills" }], exclude: ["beta"] })
      await second.reload()
      expect(second.snapshot().map((skill) => skill.id)).toEqual(["alpha"])
      expect(second.excluded().map((skill) => skill.id)).toEqual(["beta"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
