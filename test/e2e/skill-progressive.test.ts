import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { NativeModelRequest } from "@nifrajs/coding-agent"
import { createDefaultSkillRegistry, createSkillRegistry, SkillRegistry, SkillRegistryError, userSkillSources } from "../../src/skills/index.ts"
import { ContextResourceError, createContextResourceSet } from "../../src/context/resources.ts"
import { createSkillReadTool } from "../../src/tools/skill-read.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"
import { createRunrailSession } from "../../src/session.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { parseCliArgs } from "../../src/cli.ts"

const cleanup: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join("/tmp", prefix))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeSkill(root: string, folder: string, id: string, description: string, body: string): Promise<void> {
  await mkdir(join(root, folder, id), { recursive: true })
  await writeFile(join(root, folder, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n${body}`, "utf8")
}

async function expectCode(action: unknown, code: string): Promise<void> {
  try {
    await (typeof action === "function" ? action() : action)
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

const context = { cwd: "/tmp", signal: new AbortController().signal }

describe("progressive skill loading", () => {
  test("the context lists skills by id and description and leaves their bodies out", async () => {
    const cwd = await tempDir("runrail-skill-catalog-")
    await writeSkill(cwd, ".agents/skills", "review", "Review a diff for correctness.", "REVIEW-BODY")
    await writeSkill(cwd, ".claude/skills", "changelog", "Draft a changelog entry.", "CHANGELOG-BODY")
    const policy = await createWorkspacePolicy(cwd)
    const resources = await createContextResourceSet(policy, { instructionFiles: [], skillRegistry: await createDefaultSkillRegistry(policy) })
    const text = resources.text()
    expect(text).toContain("- review: Review a diff for correctness.")
    expect(text).toContain("- changelog: Draft a changelog entry.")
    expect(text).toContain("skill_read")
    expect(text).not.toContain("REVIEW-BODY")
    expect(text).not.toContain("CHANGELOG-BODY")
    expect(resources.list().filter((resource) => resource.kind === "skill")).toEqual([expect.objectContaining({ id: "catalog" })])
  })

  test("hundreds of skills fit one bounded listing, and a budget too small for them all counts the rest", async () => {
    const cwd = await tempDir("runrail-skill-many-")
    for (let index = 0; index < 300; index += 1)
      await writeSkill(cwd, "skills", `skill-${String(index).padStart(3, "0")}`, `Long description ${"word ".repeat(40)}`.trim(), "body")
    const policy = await createWorkspacePolicy(cwd)
    const registry = await createSkillRegistry(policy, { sources: [{ path: "skills" }], maxSkills: 512 })
    const resources = await createContextResourceSet(policy, { instructionFiles: [], skillRegistry: registry, maxSkillCatalogEntries: 512 })
    const catalog = resources.list().find((resource) => resource.id === "catalog")!.content
    expect(Buffer.byteLength(catalog, "utf8")).toBeLessThanOrEqual(16 * 1024)
    expect(catalog).toContain("- skill-000")
    expect(catalog).toContain("- skill-299")
    const small = registry.catalog({ maxBytes: 1_024 })!
    expect(Buffer.byteLength(small, "utf8")).toBeLessThanOrEqual(1_024)
    expect(small).toMatch(/- \d+ more skills are installed but not listed here\.$/)
    await expectCode(() => registry.catalog({ maxBytes: 100 }), "SKILL_INVALID")
    await expectCode(createContextResourceSet(policy, { skillRegistry: registry, maxSkillCatalogBytes: 128 * 1024 }), "CONTEXT_INVALID")
    // Writing 300 skill folders outruns the 5 s default on a loaded machine.
  }, 20_000)

  test("skill_read loads an enabled skill and its reference files", async () => {
    const cwd = await tempDir("runrail-skill-read-")
    await writeSkill(cwd, ".agents/skills", "pdf", "Work with PDF files.", "PDF-BODY")
    await writeFile(join(cwd, ".agents/skills/pdf/reference.md"), "PDF-REFERENCE", "utf8")
    const registry = await createDefaultSkillRegistry(await createWorkspacePolicy(cwd))
    const tool = createSkillReadTool(registry)
    expect(await tool.execute({ id: "pdf" }, context)).toEqual({ id: "pdf", name: "pdf", description: "Work with PDF files.", content: "PDF-BODY", files: ["reference.md"] })
    expect(await tool.execute({ id: "pdf", file: "reference.md" }, context)).toEqual({ id: "pdf", file: "reference.md", content: "PDF-REFERENCE" })
  })

  test("skill_read refuses unknown and switched-off skills, paths out of the skill folder, and credential files", async () => {
    const cwd = await tempDir("runrail-skill-read-refused-")
    await writeSkill(cwd, ".agents/skills", "pdf", "Work with PDF files.", "PDF-BODY")
    await writeSkill(cwd, ".agents/skills", "other", "Another skill.", "OTHER-BODY")
    await writeFile(join(cwd, ".agents/skills/pdf/.env"), "SECRET=hidden", "utf8")
    await writeFile(join(cwd, ".agents/skills/single.md"), "Single-file skill", "utf8")
    const registry = await createDefaultSkillRegistry(await createWorkspacePolicy(cwd), { exclude: ["other"] })
    const tool = createSkillReadTool(registry)
    await expectCode(tool.execute({ id: "missing" }, context), "SKILL_NOT_FOUND")
    await expectCode(tool.execute({ id: "other" }, context), "SKILL_NOT_FOUND")
    await expectCode(tool.execute({ id: "pdf", file: "../other/SKILL.md" }, context), "SKILL_INVALID")
    await expectCode(tool.execute({ id: "pdf", file: "/etc/hosts" }, context), "SKILL_INVALID")
    await expectCode(tool.execute({ id: "pdf", file: ".env" }, context), "SKILL_NOT_FOUND")
    await expectCode(tool.execute({ id: "single", file: "anything.md" }, context), "SKILL_NOT_FOUND")
    await expect(tool.execute({ id: "" }, context)).rejects.toBeInstanceOf(TypeError)
    expect((await tool.execute({ id: "pdf" }, context)) as { files?: unknown }).not.toHaveProperty("files")
  })

  test("a prompt invokes a skill with a leading /skill:id or by listing its id", async () => {
    const cwd = await tempDir("runrail-skill-invoke-")
    await writeSkill(cwd, ".agents/skills", "review", "Review a diff.", "REVIEW-BODY")
    const policy = await createWorkspacePolicy(cwd)
    const resources = await createContextResourceSet(policy, { instructionFiles: [], skillRegistry: await createDefaultSkillRegistry(policy) })
    const leading = await resources.prepare("/skill:review check the login change")
    expect(leading.text).toStartWith("/skill:review check the login change")
    expect(leading.text).toContain("[Runrail skill: review]\nREVIEW-BODY\n[End skill]")
    const listed = await resources.prepare({ text: "check the login change", skills: ["review"] })
    expect(listed.text).toContain("REVIEW-BODY")
    expect(listed.parts.at(-1)).toEqual({ kind: "text", text: "[Runrail skill: review]\nREVIEW-BODY\n[End skill]" })
    expect((await resources.prepare("/skills are listed")).text).toBe("/skills are listed")
  })

  test("an invocation of a missing skill, a malformed id, or a session without skills is refused", async () => {
    const cwd = await tempDir("runrail-skill-invoke-refused-")
    const policy = await createWorkspacePolicy(cwd)
    const resources = await createContextResourceSet(policy, { instructionFiles: [], skillRegistry: await createDefaultSkillRegistry(policy) })
    await expectCode(resources.prepare("/skill:missing do it"), "CONTEXT_REFERENCE_NOT_FOUND")
    await expectCode(resources.prepare({ text: "do it", skills: ["no spaces"] }), "CONTEXT_INVALID")
    await expectCode(resources.prepare({ text: "do it", skills: Array.from({ length: 9 }, (_, index) => `s${index}`) }), "CONTEXT_INVALID")
    const bare = await createContextResourceSet(policy, { instructionFiles: [] })
    // A coding tool reads its own skills, so the text reaches it as written.
    expect((await bare.prepare("/skill:review go")).text).toBe("/skill:review go")
    await expectCode(bare.prepare({ text: "go", skills: ["review"] }), "CONTEXT_REFERENCE_NOT_FOUND")
    expect(new ContextResourceError("CONTEXT_LIMIT", "x").code).toBe("CONTEXT_LIMIT")
  })
})

describe("user-wide skill folders", () => {
  test("are read in place below the project's own skills when opted in", async () => {
    const cwd = await tempDir("runrail-skill-user-project-")
    const home = await tempDir("runrail-skill-user-home-")
    await writeSkill(cwd, ".agents/skills", "review", "Project review.", "PROJECT-REVIEW")
    await writeSkill(home, ".claude/skills", "review", "User review.", "USER-REVIEW")
    await writeSkill(home, ".pi/agent/skills", "pdf", "Work with PDF files.", "USER-PDF")
    await writeFile(join(home, ".pi/agent/skills/pdf/forms.md"), "PDF-FORMS", "utf8")
    await writeSkill(home, ".config/opencode/skills", "sheets", "Work with sheets.", "USER-SHEETS")
    const policy = await createWorkspacePolicy(cwd)
    expect((await createDefaultSkillRegistry(policy)).list().map((skill) => skill.id)).toEqual(["review"])
    const registry = await createDefaultSkillRegistry(policy, { userHome: home })
    expect(registry.list().map((skill) => [skill.id, skill.scope])).toEqual([["pdf", "user"], ["review", "project"], ["sheets", "user"]])
    expect(registry.read("review").content).toBe("PROJECT-REVIEW")
    const tool = createSkillReadTool(registry)
    expect(await tool.execute({ id: "pdf" }, context)).toMatchObject({ content: "USER-PDF", files: ["forms.md"] })
    expect(await tool.execute({ id: "pdf", file: "forms.md" }, context)).toMatchObject({ content: "PDF-FORMS" })
    await expectCode(tool.execute({ id: "pdf", file: "../../../.claude/skills/review/SKILL.md" }, context), "SKILL_INVALID")
  })

  test("a user folder that cannot be read is left out and the rest still load", async () => {
    const cwd = await tempDir("runrail-skill-user-broken-")
    const home = await tempDir("runrail-skill-user-broken-home-")
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude", "skills"), "not a folder", "utf8")
    await writeSkill(home, ".codex/skills", "lint", "Run the linter.", "LINT-BODY")
    const registry = await createDefaultSkillRegistry(await createWorkspacePolicy(cwd), { userHome: home })
    expect(registry.list().map((skill) => skill.id)).toEqual(["lint"])
    expect(registry.skipped()).toEqual([{ path: join(home, ".claude", "skills"), code: "SKILL_SOURCE_FAILED" }])
  })

  test("a home that is not an absolute path is refused", async () => {
    const cwd = await tempDir("runrail-skill-user-refused-")
    expect(() => userSkillSources("relative/home")).toThrow(SkillRegistryError)
    await expectCode(createDefaultSkillRegistry(await createWorkspacePolicy(cwd), { userHome: "relative/home" }), "SKILL_INVALID")
    await expect(createRunrailSession({ cwd, backend: "native", loadExtensions: false, userSkills: { home: 42 } as unknown as { home: string } })).rejects.toThrow("USER_SKILLS_INVALID")
  })

  test("past the count limit the lowest-ranked skills give way instead of failing the load", async () => {
    const cwd = await tempDir("runrail-skill-user-limit-")
    const home = await tempDir("runrail-skill-user-limit-home-")
    await writeSkill(cwd, ".agents/skills", "project-one", "Project skill.", "P1")
    await writeSkill(home, ".claude/skills", "user-one", "User skill.", "U1")
    await writeSkill(home, ".claude/skills", "user-two", "User skill.", "U2")
    const policy = await createWorkspacePolicy(cwd)
    const registry = await createDefaultSkillRegistry(policy, { userHome: home, maxSkills: 2 })
    expect(registry.list().map((skill) => skill.id)).toEqual(["project-one", "user-one"])
    expect(registry.skipped()).toEqual([{ path: "user-two/SKILL.md", code: "SKILL_LIMIT" }])
    await expectCode(createSkillRegistry(policy, { sources: [{ path: ".agents/skills" }, ...userSkillSources(home)], maxSkills: 2 }), "SKILL_LIMIT")
  })

  test("a native session lists user skills to the model and loads one through skill_read", async () => {
    const cwd = await tempDir("runrail-skill-session-")
    const home = await tempDir("runrail-skill-session-home-")
    await writeSkill(home, ".agents/skills", "deploy-notes", "Write deploy notes.", "DEPLOY-NOTES-BODY")
    const requests: NativeModelRequest[] = []
    const model = {
      complete: (request: NativeModelRequest) => {
        requests.push(request)
        return request.messages.some((message) => message.role === "tool")
          ? { type: "text" as const, text: "done" }
          : { type: "tool" as const, name: "skill_read", input: { id: "deploy-notes" } }
      },
    }
    const session = await createRunrailSession({ cwd, backend: "native", loadExtensions: false, model, userSkills: { home } })
    cleanup.push(() => session.stop())
    for await (const _event of session.prompt("write the deploy notes")) void _event
    const first = requests[0]!
    expect(first.tools.map((tool) => tool.name)).toContain("skill_read")
    expect(first.messages.some((message) => message.text.includes("- deploy-notes: Write deploy notes."))).toBe(true)
    expect(first.messages.some((message) => message.text.includes("DEPLOY-NOTES-BODY"))).toBe(false)
    expect(requests.at(-1)!.messages.some((message) => message.role === "tool" && message.text.includes("DEPLOY-NOTES-BODY"))).toBe(true)
  })
})

describe("named skill paths and supplied skills", () => {
  test("skill paths a caller names are listed and loaded on demand, not sent whole", async () => {
    const cwd = await tempDir("runrail-skill-named-")
    await writeSkill(cwd, "team-skills", "release", "Cut a release.", "RELEASE-BODY")
    await writeFile(join(cwd, "notes.md"), "# Notes skill\nNOTES-BODY", "utf8")
    const policy = await createWorkspacePolicy(cwd)
    const resources = await createContextResourceSet(policy, { instructionFiles: [], skillPaths: ["team-skills", "notes.md"] })
    expect(resources.text()).toContain("- release: Cut a release.")
    expect(resources.text()).toContain("- notes: Notes skill")
    expect(resources.text()).not.toContain("RELEASE-BODY")
    expect(resources.skillRegistry()?.read("release").scope).toBe("explicit")
    expect((await resources.prepare("/skill:notes go")).text).toContain("NOTES-BODY")
    const requests: NativeModelRequest[] = []
    const session = await createRunrailSession({
      cwd,
      backend: "native",
      loadExtensions: false,
      context: { skillPaths: ["team-skills"] },
      model: { complete: (request: NativeModelRequest) => { requests.push(request); return { type: "text" as const, text: "ok" } } },
    })
    cleanup.push(() => session.stop())
    for await (const _event of session.prompt("hi")) void _event
    expect(requests[0]!.messages.some((message) => message.text.includes("- release: Cut a release."))).toBe(true)
    expect(requests[0]!.messages.some((message) => message.text.includes("RELEASE-BODY"))).toBe(false)
    expect(session.skillRegistry?.read("release").content).toBe("RELEASE-BODY")
  })

  test("a named path to one skill's folder is that one skill, its other files reference material", async () => {
    const cwd = await tempDir("runrail-skill-named-folder-")
    await writeSkill(cwd, "team-skills", "release", "Cut a release.", "RELEASE-BODY")
    await writeFile(join(cwd, "team-skills", "release", "checklist.md"), "CHECKLIST", "utf8")
    await mkdir(join(cwd, "team-skills", "release", "docs"), { recursive: true })
    await writeFile(join(cwd, "team-skills", "release", "docs", "guide.md"), "GUIDE", "utf8")
    const policy = await createWorkspacePolicy(cwd)
    for (const path of ["team-skills/release", "./team-skills/release/"]) {
      const resources = await createContextResourceSet(policy, { instructionFiles: [], skillPaths: [path] })
      const registry = resources.skillRegistry()!
      expect(registry.list().map((skill) => skill.id)).toEqual(["release"])
      const tool = createSkillReadTool(registry)
      expect(await tool.execute({ id: "release" }, context)).toMatchObject({ content: "RELEASE-BODY", files: ["checklist.md", "docs/guide.md"] })
      expect(await tool.execute({ id: "release", file: "docs/guide.md" }, context)).toMatchObject({ content: "GUIDE" })
    }
  })

  test("a SKILL.md at the top of a collection folder does not swallow the collection", async () => {
    const cwd = await tempDir("runrail-skill-collection-root-")
    await mkdir(join(cwd, ".agents", "skills"), { recursive: true })
    await writeFile(join(cwd, ".agents", "skills", "SKILL.md"), "Stray manifest", "utf8")
    await writeFile(join(cwd, ".agents", "skills", "review.md"), "Review body", "utf8")
    const registry = await createDefaultSkillRegistry(await createWorkspacePolicy(cwd))
    expect(registry.list().map((skill) => skill.id)).toContain("review")
  })

  test("a named skill folder with an invalid SKILL.md fails the load", async () => {
    const cwd = await tempDir("runrail-skill-named-folder-refused-")
    await mkdir(join(cwd, "team-skills", "release"), { recursive: true })
    await writeFile(join(cwd, "team-skills", "release", "SKILL.md"), "---\nid: not valid\n---\nbody", "utf8")
    await writeFile(join(cwd, "team-skills", "release", "checklist.md"), "CHECKLIST", "utf8")
    await expectCode(createContextResourceSet(await createWorkspacePolicy(cwd), { skillPaths: ["team-skills/release"] }), "SKILL_INVALID")
  })

  test("named skill paths stay strict and cannot be mixed with a caller's registry", async () => {
    const cwd = await tempDir("runrail-skill-named-refused-")
    await mkdir(join(cwd, "team-skills"), { recursive: true })
    await writeFile(join(cwd, "team-skills", "my notes.md"), "Not a valid id", "utf8")
    const policy = await createWorkspacePolicy(cwd)
    await expectCode(createContextResourceSet(policy, { skillPaths: ["team-skills"] }), "SKILL_INVALID")
    await expectCode(createRunrailSession({ cwd, backend: "native", loadExtensions: false, context: { skillPaths: ["team-skills"] } }), "SKILL_INVALID")
    const registry = await createSkillRegistry(policy, { sources: [] })
    await expectCode(createContextResourceSet(policy, { skillPaths: ["team-skills"], skillRegistry: registry }), "CONTEXT_INVALID")
    await expectCode(createContextResourceSet(policy, { skillPaths: [""] }), "CONTEXT_INVALID")
  })

  test("supplied skills rank between project and user skills and are checked like files", async () => {
    const cwd = await tempDir("runrail-skill-supplied-")
    await writeSkill(cwd, ".agents/skills", "review", "Project review.", "PROJECT-REVIEW")
    const policy = await createWorkspacePolicy(cwd)
    const registry = await createDefaultSkillRegistry(policy, {
      supplied: [
        { id: "review", content: "PLUGIN-REVIEW" },
        { id: "lint", content: "---\ndescription: Lint the change.\n---\nLINT-BODY" },
        { id: "empty", content: "   " },
      ],
    })
    expect(registry.read("review").content).toBe("PROJECT-REVIEW")
    expect(registry.read("lint")).toMatchObject({ scope: "plugin", description: "Lint the change.", content: "LINT-BODY" })
    expect(registry.skipped()).toEqual([{ path: "plugin:empty", code: "SKILL_INVALID" }])
    expect(() => new SkillRegistry(policy, { supplied: [{ id: "no spaces", content: "x" }] })).toThrow(SkillRegistryError)
    await expectCode(createSkillRegistry(policy, { supplied: [{ id: "empty", content: "" }] }), "SKILL_INVALID")
  })

  test("the CLI turns user-wide skill folders on or off for one run", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--user-skills", "task"])).toMatchObject({ userSkills: true })
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--no-user-skills", "task"])).toMatchObject({ userSkills: false })
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "task"])).not.toHaveProperty("userSkills")
  })
})

describe("linked skills in user-wide folders", () => {
  test("a link to a skill folder or Markdown skill is followed; anything else is left out", async () => {
    const cwd = await tempDir("runrail-skill-links-")
    const home = await tempDir("runrail-skill-links-home-")
    const elsewhere = await tempDir("runrail-skill-links-elsewhere-")
    await writeSkill(elsewhere, "repo", "pdf", "Work with PDF files.", "LINKED-PDF")
    await writeFile(join(elsewhere, "repo", "pdf", "forms.md"), "PDF-FORMS", "utf8")
    await writeFile(join(elsewhere, "standup.md"), "---\ndescription: Write a standup.\n---\nSTANDUP-BODY", "utf8")
    await mkdir(join(elsewhere, "not-a-skill"), { recursive: true })
    await writeFile(join(elsewhere, "not-a-skill", "README.md"), "README", "utf8")
    await mkdir(join(home, ".claude", "skills"), { recursive: true })
    await symlink(join(elsewhere, "repo", "pdf"), join(home, ".claude", "skills", "pdf"))
    await symlink(join(elsewhere, "standup.md"), join(home, ".claude", "skills", "standup.md"))
    await symlink(join(elsewhere, "not-a-skill"), join(home, ".claude", "skills", "not-a-skill"))
    await symlink(join(elsewhere, "gone"), join(home, ".claude", "skills", "broken"))
    const registry = await createDefaultSkillRegistry(await createWorkspacePolicy(cwd), { userHome: home })
    expect(registry.list().map((skill) => [skill.id, skill.scope])).toEqual([["pdf", "user"], ["standup", "user"]])
    expect(registry.skipped()).toEqual([
      { path: "broken", code: "SKILL_SOURCE_FAILED" },
      { path: "not-a-skill", code: "SKILL_INVALID" },
    ])
    const tool = createSkillReadTool(registry)
    expect(await tool.execute({ id: "pdf" }, context)).toMatchObject({ content: "LINKED-PDF", files: ["forms.md"] })
    expect(await tool.execute({ id: "pdf", file: "forms.md" }, context)).toMatchObject({ content: "PDF-FORMS" })
    await expectCode(tool.execute({ id: "pdf", file: "../../standup.md" }, context), "SKILL_INVALID")
  })

  test("links in a project folder are still not followed", async () => {
    const cwd = await tempDir("runrail-skill-project-links-")
    const elsewhere = await tempDir("runrail-skill-project-links-elsewhere-")
    await writeSkill(elsewhere, "repo", "pdf", "Work with PDF files.", "LINKED-PDF")
    await mkdir(join(cwd, ".agents", "skills"), { recursive: true })
    await symlink(join(elsewhere, "repo", "pdf"), join(cwd, ".agents", "skills", "pdf"))
    expect((await createDefaultSkillRegistry(await createWorkspacePolicy(cwd))).list()).toEqual([])
  })
})

describe("skill invocation over the control RPC", () => {
  const token = "control-skill-invoke-token-1234567890"

  async function start() {
    const cwd = await tempDir("runrail-control-skill-invoke-")
    await writeSkill(cwd, ".agents/skills", "tidy", "Keep diffs small.", "TIDY-SKILL-BODY")
    const requests: NativeModelRequest[] = []
    const running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      authToken: token,
      loadExtensions: false,
      model: { complete: (request: NativeModelRequest) => { requests.push(request); return { type: "text" as const, text: "ok" } } },
    })
    cleanup.push(() => running.handle.stop())
    const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<{ readonly status: number; readonly body: any }> => {
      const response = await fetch(`${running.handle.url}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
      })
      return { status: response.status, body: await response.json() }
    }
    return { rpc, requests, url: running.handle.url }
  }

  test("a message that lists a skill sends its body with that turn only", async () => {
    const { rpc, requests, url } = await start()
    const health = await (await fetch(`${url}/health`)).json() as { capabilityStatus: Record<string, string> }
    expect(health.capabilityStatus["skills.invoke"]).toBe("available")
    expect((await rpc("turn.enqueue", { message: { text: "tidy this", skills: ["tidy"] } })).status).toBe(200)
    expect(requests.at(-1)!.messages.some((message) => message.text.includes("TIDY-SKILL-BODY"))).toBe(true)
    expect((await rpc("turn.enqueue", { message: "plain turn" })).status).toBe(200)
    expect(requests.at(-1)!.messages.filter((message) => message.text.includes("TIDY-SKILL-BODY")).length).toBe(1)
  })

  test("a malformed skill list is refused before the turn starts", async () => {
    const { rpc, requests } = await start()
    const invalid = await rpc("turn.enqueue", { message: { text: "tidy this", skills: ["not valid"] } })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe("CONTROL_INVALID_INPUT")
    expect((await rpc("turn.enqueue", { message: { text: "tidy this", skills: "tidy" } })).body.error.code).toBe("CONTROL_INVALID_INPUT")
    expect((await rpc("turn.enqueue", { message: { text: "tidy this", skills: ["missing"] } })).body.error.code).toBe("CONTEXT_REFERENCE_NOT_FOUND")
    expect(requests).toHaveLength(0)
  })
})
