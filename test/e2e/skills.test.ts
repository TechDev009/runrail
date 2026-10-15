import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createDefaultSkillRegistry, createSkillRegistry, SkillRegistryError } from "../../src/skills/index.ts"
import { createContextResourceSet } from "../../src/context/resources.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

describe("normalized local skills", () => {
  test("discovers Markdown skills with explicit precedence and context integration", async () => {
    const cwd = await mkdtemp("/tmp/runrail-skills-")
    try {
      await mkdir(join(cwd, ".claude", "skills", "review"), { recursive: true })
      await writeFile(join(cwd, ".claude", "skills", "review", "SKILL.md"), "---\nid: review\nname: Project review\ndescription: Project guidance\n---\nProject skill body", "utf8")
      await Bun.write(join(cwd, "explicit.md"), "---\nid: review\nname: Explicit review\n---\nExplicit skill body")
      await Bun.write(join(cwd, "other.skill.md"), "Other skill body")
      const policy = await createWorkspacePolicy(cwd)
      const registry = await createSkillRegistry(policy, {
        sources: [
          { path: ".claude/skills", scope: "project" },
          { path: "explicit.md", scope: "explicit" },
          { path: "other.skill.md", scope: "user" },
        ],
      })
      expect(registry.list().map((skill) => skill.id)).toEqual(["other.skill", "review"])
      expect(registry.get("review")).toMatchObject({ name: "Explicit review", content: "Explicit skill body", scope: "explicit" })
      const context = await createContextResourceSet(policy, { skillRegistry: registry })
      expect(context.text()).toContain("- review: Explicit review")
      expect(context.text()).not.toContain("Explicit skill body")
      expect(context.list().some((resource) => resource.kind === "skill")).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("failed reload preserves the previously loaded skill graph", async () => {
    const cwd = await mkdtemp("/tmp/runrail-skills-reload-")
    try {
      const path = join(cwd, "skill.md")
      await Bun.write(path, "stable skill")
      const policy = await createWorkspacePolicy(cwd)
      const registry = await createSkillRegistry(policy, { sources: [{ path: "skill.md", scope: "project" }] })
      expect(registry.get("skill")).toBeDefined()
      await Bun.write(path, "---\nid: not a valid id\n---\nbroken")
      await expect(registry.reload()).rejects.toBeInstanceOf(SkillRegistryError)
      expect(registry.get("skill")?.content).toBe("stable skill")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
  test("reads a skill folder other tools also use", async () => {
    const cwd = await mkdtemp("/tmp/runrail-skills-shared-")
    try {
      await mkdir(join(cwd, ".claude", "skills", "pdf"), { recursive: true })
      await mkdir(join(cwd, ".claude", "skills", "sheets"), { recursive: true })
      await writeFile(join(cwd, ".claude", "skills", "pdf", "SKILL.md"), "---\nname: \"PDF\"\ndescription: Work with PDF files.\nallowed-tools: Read, Bash\nlicense: MIT\nmetadata:\n  author: someone\n  tags:\n    - files\n---\n\nPDF body", "utf8")
      await writeFile(join(cwd, ".claude", "skills", "pdf", "reference.md"), "PDF reference", "utf8")
      await writeFile(join(cwd, ".claude", "skills", "sheets", "SKILL.md"), "---\nname: sheets\ndescription: >-\n  Work with spreadsheets,\n  one sheet at a time.\n---\nSheets body", "utf8")
      await writeFile(join(cwd, ".claude", "skills", "sheets", "reference.md"), "Sheets reference", "utf8")
      const registry = await createDefaultSkillRegistry(await createWorkspacePolicy(cwd))
      expect(registry.list().map((skill) => skill.id)).toEqual(["pdf", "sheets"])
      expect(registry.get("pdf")).toMatchObject({ name: "PDF", description: "Work with PDF files.", content: "\nPDF body" })
      expect(registry.get("sheets")?.description).toBe("Work with spreadsheets, one sheet at a time.")
      expect(registry.skipped()).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("leaves out a stray file in a conventional folder and keeps the rest", async () => {
    const cwd = await mkdtemp("/tmp/runrail-skills-stray-")
    try {
      await mkdir(join(cwd, ".claude", "skills"), { recursive: true })
      await writeFile(join(cwd, ".claude", "skills", "review.md"), "Review body", "utf8")
      await writeFile(join(cwd, ".claude", "skills", "my notes.md"), "Not a skill", "utf8")
      const policy = await createWorkspacePolicy(cwd)
      const registry = await createDefaultSkillRegistry(policy)
      expect(registry.list().map((skill) => skill.id)).toEqual(["review"])
      expect(registry.skipped()).toEqual([{ path: ".claude/skills/my notes.md", code: "SKILL_INVALID" }])
      await expect(createSkillRegistry(policy, { sources: [{ path: ".claude/skills" }] })).rejects.toBeInstanceOf(SkillRegistryError)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("resolves a skill kept in two conventional folders and picks up a folder added later", async () => {
    const cwd = await mkdtemp("/tmp/runrail-skills-mirror-")
    try {
      await mkdir(join(cwd, ".claude", "skills"), { recursive: true })
      await writeFile(join(cwd, ".claude", "skills", "review.md"), "Claude copy", "utf8")
      const registry = await createDefaultSkillRegistry(await createWorkspacePolicy(cwd))
      expect(registry.get("review")?.content).toBe("Claude copy")
      await mkdir(join(cwd, ".agents", "skills"), { recursive: true })
      await writeFile(join(cwd, ".agents", "skills", "review.md"), "Agents copy", "utf8")
      await registry.reload()
      expect(registry.list().map((skill) => skill.id)).toEqual(["review"])
      expect(registry.get("review")).toMatchObject({ content: "Agents copy", path: ".agents/skills/review.md" })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("a session without the native loop lists workspace skills, including one added after it started", async () => {
    const cwd = await mkdtemp("/tmp/runrail-skills-control-")
    const token = "control-skills-test-token-123"
    const running = await startRunrailControlRpcServer({ cwd, backend: "replay", authToken: token, loadExtensions: false })
    const list = async (): Promise<unknown> => {
      const response = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ method: "skills.list", params: {} }),
      })
      return response.json()
    }
    try {
      expect(await list()).toMatchObject({ ok: true, result: [] })
      await mkdir(join(cwd, ".agents", "skills", "changelog"), { recursive: true })
      await writeFile(join(cwd, ".agents", "skills", "changelog", "SKILL.md"), "---\nname: changelog\ndescription: Draft a changelog entry.\n---\nChangelog body", "utf8")
      expect(await list()).toMatchObject({ ok: true, result: [{ id: "changelog", name: "changelog", description: "Draft a changelog entry.", scope: "project", enabled: true }] })
    } finally {
      await running.handle.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("discovers conventional project skill directories when present", async () => {
    const cwd = await mkdtemp("/tmp/runrail-skills-default-")
    try {
      await mkdir(join(cwd, ".claude", "skills"), { recursive: true })
      await writeFile(join(cwd, ".claude", "skills", "default.md"), "Default conventional skill", "utf8")
      const policy = await createWorkspacePolicy(cwd)
      const registry = await createDefaultSkillRegistry(policy)
      expect(registry.list().map((skill) => skill.id)).toEqual(["default"])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
