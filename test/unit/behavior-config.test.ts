import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyBehaviorToolPolicy,
  BEHAVIOR_MUTATING_TOOLS,
  createBehaviorApprovalPort,
  DEFAULT_BEHAVIOR_CONFIG,
  filterToolsForMode,
  loadBehaviorConfigFile,
  loadBehaviorForSession,
  matchGlob,
  resolveBehaviorConfigPath,
  shouldRequestApproval,
  type BehaviorConfig,
} from "../../src/behavior/config.ts"

async function dir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

async function writeConfig(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name)
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value))
  return path
}

const FULL = {
  version: 1,
  mode: "plan",
  effort: "high",
  instructions: { text: "Prefer small diffs." },
  permissions: {
    default: "deny",
    rules: [{ tool: "run_command", match: "git push *", policy: "deny" }],
  },
  compaction: { enabled: false },
}

describe("behavior config paths", () => {
  test("explicit path wins, session dir default, undefined stays undefined", () => {
    expect(resolveBehaviorConfigPath("/x/c.json", "/s")).toBe("/x/c.json")
    expect(resolveBehaviorConfigPath(undefined, "/s")).toBe(join("/s", "config.json"))
    expect(resolveBehaviorConfigPath(undefined, undefined)).toBeUndefined()
  })
})

describe("behavior config parsing", () => {
  test("parses a full file and ignores unknown keys", async () => {
    const root = await dir("runrail-behavior")
    const path = await writeConfig(root, "c.json", { ...FULL, futureField: true, nested: { x: 1 } })
    const config = await loadBehaviorConfigFile(path, { cwd: root })
    expect(config.mode).toBe("plan")
    expect(config.effort).toBe("high")
    expect(config.instructionsText).toBe("Prefer small diffs.")
    expect(config.permissionDefault).toBe("deny")
    expect(config.permissionRules).toHaveLength(1)
    expect(config.compactionEnabled).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("skills.userRoots opts in to the user-wide skill folders and must be a flag", async () => {
    const root = await dir("runrail-behavior")
    const on = await writeConfig(root, "on.json", { version: 1, skills: { userRoots: true } })
    expect((await loadBehaviorConfigFile(on, { cwd: root })).userSkillRoots).toBe(true)
    expect(DEFAULT_BEHAVIOR_CONFIG.userSkillRoots).toBe(false)
    for (const skills of [{ userRoots: "yes" }, "all", [true]]) {
      const bad = await writeConfig(root, "bad.json", { version: 1, skills })
      await expect(loadBehaviorConfigFile(bad, { cwd: root })).rejects.toThrow("skills")
    }
    await rm(root, { recursive: true, force: true })
  })

  test("missing fields fall back to defaults", async () => {
    const root = await dir("runrail-behavior")
    const path = await writeConfig(root, "c.json", { version: 1 })
    expect(await loadBehaviorConfigFile(path, { cwd: root })).toEqual(DEFAULT_BEHAVIOR_CONFIG)
    await rm(root, { recursive: true, force: true })
  })

  test("missing file, corrupt JSON, wrong version, and oversize all throw content-free errors", async () => {
    const root = await dir("runrail-behavior")
    await expect(loadBehaviorConfigFile(join(root, "nope.json"), { cwd: root })).rejects.toThrow("missing")
    const bad = await writeConfig(root, "bad.json", "{oops")
    await expect(loadBehaviorConfigFile(bad, { cwd: root })).rejects.toThrow("valid JSON")
    const v99 = await writeConfig(root, "v99.json", { version: 99 })
    await expect(loadBehaviorConfigFile(v99, { cwd: root })).rejects.toThrow("unsupported")
    const big = await writeConfig(root, "big.json", { version: 1, instructions: { text: "x".repeat(9_000) } })
    await expect(loadBehaviorConfigFile(big, { cwd: root })).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  })

  test("rejects bad enums, oversized text, too many rules, and text+file together", async () => {
    const root = await dir("runrail-behavior")
    for (const body of [
      { version: 1, mode: "turbo" },
      { version: 1, effort: "extreme" },
      { version: 1, permissions: { default: "maybe" } },
      { version: 1, permissions: { rules: [{ tool: "", match: "*", policy: "ask" }] } },
      {
        version: 1,
        permissions: { rules: Array.from({ length: 129 }, (_, i) => ({ tool: `t${i}`, match: "*", policy: "ask" as const })) },
      },
      { version: 1, instructions: { text: "a", file: "b.md" } },
    ]) {
      const path = await writeConfig(root, "c.json", body)
      await expect(loadBehaviorConfigFile(path, { cwd: root })).rejects.toThrow()
    }
    await rm(root, { recursive: true, force: true })
  })

  test("reads instructions from an in-workspace file and rejects escapes", async () => {
    const root = await dir("runrail-behavior")
    await writeFile(join(root, "notes.md"), "Follow the guide.")
    const ok = await writeConfig(root, "c.json", { version: 1, instructions: { file: "notes.md" } })
    expect((await loadBehaviorConfigFile(ok, { cwd: root })).instructionsText).toBe("Follow the guide.")
    for (const file of ["../escape.md", "/absolute.md", "a/../../b.md"]) {
      const bad = await writeConfig(root, "bad.json", { version: 1, instructions: { file } })
      await expect(loadBehaviorConfigFile(bad, { cwd: root })).rejects.toThrow()
    }
    const missing = await writeConfig(root, "missing.json", { version: 1, instructions: { file: "gone.md" } })
    await expect(loadBehaviorConfigFile(missing, { cwd: root })).rejects.toThrow("unreadable")
    await rm(root, { recursive: true, force: true })
  })

  test("resilient reload keeps last good config after a transient failure", async () => {
    const root = await dir("runrail-behavior")
    const path = await writeConfig(root, "c.json", { version: 1, mode: "auto" })
    const warnings: string[] = []
    const first = await loadBehaviorForSession(path, { cwd: root, onWarning: (message) => warnings.push(message) })
    expect(first?.mode).toBe("auto")
    await writeFile(path, "broken")
    const second = await loadBehaviorForSession(path, { cwd: root, onWarning: (message) => warnings.push(message) })
    expect(second?.mode).toBe("auto")
    expect(warnings).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })

  test("first load failure throws when nothing is cached", async () => {
    const root = await dir("runrail-behavior")
    await expect(loadBehaviorForSession(join(root, "nope.json"), { cwd: root })).rejects.toThrow("missing")
    await expect(loadBehaviorForSession(join(root, "implicit.json"), { cwd: root, allowMissing: true })).resolves.toEqual(DEFAULT_BEHAVIOR_CONFIG)
    expect(await loadBehaviorForSession(undefined, { cwd: root })).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })
})

describe("glob matching", () => {
  test("supports exact, star, and question mark", () => {
    expect(matchGlob("git push *", "git push origin main")).toBe(true)
    expect(matchGlob("git push *", "git pull")).toBe(false)
    expect(matchGlob("rm -rf ?", "rm -rf /")).toBe(true)
    expect(matchGlob("exact", "exact")).toBe(true)
    expect(matchGlob("a.c", "abc")).toBe(false)
  })
})

describe("approval policy", () => {
  const base: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG }

  test("ask requires approval for mutating tools, frees reads", () => {
    for (const tool of BEHAVIOR_MUTATING_TOOLS) {
      expect(shouldRequestApproval({ ...base, mode: "ask" }, tool, "anything")).toBe(true)
    }
    for (const tool of ["read_file", "list_files", "search_files"]) {
      expect(shouldRequestApproval({ ...base, mode: "ask" }, tool, "anything")).toBe(false)
    }
  })

  test("auto approves by default but honors rules", () => {
    const config: BehaviorConfig = {
      ...base,
      mode: "auto",
      permissionRules: Object.freeze([{ tool: "run_command", match: "git push *", policy: "deny" as const }]),
    }
    expect(shouldRequestApproval(config, "write_file", "x")).toBe(false)
    expect(shouldRequestApproval(config, "run_command", "git push origin")).toBe(true)
    expect(shouldRequestApproval(config, "run_command", "ls")).toBe(false)
  })

  test("rules match tool plus action glob, first match wins", () => {
    const config: BehaviorConfig = {
      ...base,
      mode: "ask",
      permissionDefault: "ask",
      permissionRules: Object.freeze([
        { tool: "run_command", match: "ls *", policy: "allow" as const },
        { tool: "run_command", match: "*", policy: "deny" as const },
      ]),
    }
    expect(shouldRequestApproval(config, "run_command", "ls /tmp")).toBe(false)
    expect(shouldRequestApproval(config, "run_command", "rm -rf /")).toBe(true)
    expect(shouldRequestApproval(config, "write_file", "x")).toBe(true)
  })

  test("plan gates mutating tools like ask", () => {
    expect(shouldRequestApproval({ ...base, mode: "plan" }, "write_file", "x")).toBe(true)
    expect(shouldRequestApproval({ ...base, mode: "plan" }, "read_file", "x")).toBe(false)
  })

  test("approval port auto-approves only what needs no human", async () => {
    const live = new AbortController().signal
    const input = (action: string, name: string) => ({
      sessionId: "s",
      approvalId: "a",
      turnId: "t",
      callId: "c",
      action,
      capability: "y",
      tool: { name } as never,
      input: {},
      signal: live,
    })
    // true approves at once; false denies at once, which is all a one-shot run can do.
    expect(createBehaviorApprovalPort({ ...base, mode: "auto" }).request(input("x", "write_file"))).toBe(true)
    expect(createBehaviorApprovalPort({ ...base, mode: "ask" }).request(input("x", "write_file"))).toBe(false)
    expect(createBehaviorApprovalPort({ ...base, mode: "ask" }).request(input("x", "read_file"))).toBe(true)
    // With a caller that resolves approvals, a reviewed request never settles here.
    const waiting = createBehaviorApprovalPort({ ...base, mode: "ask" }, { pending: true })
    expect(waiting.request(input("x", "read_file"))).toBe(true)
    const left = waiting.request(input("x", "write_file"))
    expect(left).toBeInstanceOf(Promise)
    expect(await Promise.race([left, new Promise((resolve) => setTimeout(() => resolve("pending"), 20))])).toBe("pending")
    // A deny rule is final: nobody is asked.
    const denying = createBehaviorApprovalPort({ ...base, mode: "ask", permissionRules: [{ tool: "write_file", match: "*", policy: "deny" }] }, { pending: true })
    expect(denying.request(input("x", "write_file"))).toBe(false)
  })

  test("command rules read run_command's program and arguments, by name or by path, strictest first", async () => {
    const live = new AbortController().signal
    const command = (program: string, args: readonly string[]) => ({ sessionId: "s", approvalId: "a", turnId: "t", callId: "c", action: "run_command", capability: "process.run", tool: { name: "run_command" } as never, input: { program, args }, signal: live })
    const auto = createBehaviorApprovalPort({ ...base, mode: "auto", permissionRules: [{ tool: "run_command", match: "git push *", policy: "deny" }] })
    expect(auto.request(command("git", ["push", "origin", "main"]))).toBe(false)
    expect(auto.request(command("/usr/bin/git", ["push", "origin", "main"]))).toBe(false)
    expect(auto.request(command("git", ["status"]))).toBe(true)
    const asking: BehaviorConfig = { ...base, mode: "ask", permissionRules: [{ tool: "run_command", match: "git status*", policy: "allow" }] }
    const [tool] = applyBehaviorToolPolicy([{ name: "run_command", description: "run", execute: () => null }], asking)
    expect(await (tool!.requiresApproval as (input: unknown) => Promise<boolean>)({ program: "git", args: ["status"] })).toBe(false)
    // A program elsewhere that only shares the name is asked about.
    expect(await (tool!.requiresApproval as (input: unknown) => Promise<boolean>)({ program: "/tmp/planted/git", args: ["status"] })).toBe(true)
    expect(await (tool!.requiresApproval as (input: unknown) => Promise<boolean>)({ program: "git", args: ["push"] })).toBe(true)
  })
})

import { createRunrailRuntime } from "../../src/session.ts"

describe("runtime integration", () => {
  test("behavior instructions reach the session context", async () => {
    const root = await dir("runrail-behavior")
    const sessionDir = join(root, "sessions")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, "config.json"),
      JSON.stringify({ version: 1, instructions: { text: "Follow the runbook." } }),
    )
    const runtime = await createRunrailRuntime({ cwd: root, backend: "native", sessionDir })
    const system = runtime.context.list().filter((resource) => resource.kind === "system")
    expect(system.some((resource) => resource.content.includes("Follow the runbook."))).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  test("explicit config path is honored and CLI context still wins", async () => {
    const root = await dir("runrail-behavior")
    const custom = join(root, "custom.json")
    await writeFile(custom, JSON.stringify({ version: 1, instructions: { text: "From file." } }))
    const runtime = await createRunrailRuntime({
      cwd: root,
      backend: "native",
      behaviorConfigPath: custom,
      context: { systemPrompt: "From flag." },
    })
    const text = runtime.context.text()
    expect(text.includes("From flag.")).toBe(true)
    expect(text.includes("From file.")).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})

describe("plan tool filter", () => {
  const tools = Object.freeze([
    { name: "read_file" },
    { name: "write_file" },
    { name: "run_command" },
    { name: "search_files" },
  ])

  test("plan keeps reads and drops mutating tools", () => {
    const filtered = filterToolsForMode(tools, "plan")
    expect(filtered.map((tool) => tool.name)).toEqual(["read_file", "search_files"])
  })

  test("sharing a plan needs no approval and stays available while planning", () => {
    const strict: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, mode: "ask", permissionDefault: "ask" }
    expect(shouldRequestApproval(strict, "update_plan", "update_plan")).toBe(false)
    expect(shouldRequestApproval(strict, "write_file", "x")).toBe(true)
    expect(filterToolsForMode([{ name: "update_plan", capabilities: [] as string[] }, { name: "write_file" }], "plan").map((tool) => tool.name)).toEqual(["update_plan"])
  })

  test("loading a skill needs no approval and stays available while planning", () => {
    const strict: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, mode: "ask", permissionDefault: "deny" }
    expect(shouldRequestApproval(strict, "skill_read", "skill_read")).toBe(false)
    expect(filterToolsForMode([{ name: "skill_read", capabilities: ["read"] }, { name: "run_command" }], "plan").map((tool) => tool.name)).toEqual(["skill_read"])
  })

  test("ask and auto leave the catalog untouched", () => {
    expect(filterToolsForMode(tools, "ask")).toBe(tools)
    expect(filterToolsForMode(tools, "auto")).toBe(tools)
  })
})

test("MCP read-only admission is caller-owned and parsed for both transports", async () => {
  const root = await dir("runrail-mcp-admission")
  try {
    const servers = [{ name: "local", command: "fixture", readOnlyTools: ["inspect"] }, { name: "http", url: "http://127.0.0.1:1234/mcp", readOnlyTools: ["inspect"] }]
    const path = await writeConfig(root, "config.json", { version: 1, mcp: { servers } })
    expect((await loadBehaviorConfigFile(path, { cwd: root })).mcpServers.map((server) => server.readOnlyTools)).toEqual([["inspect"], ["inspect"]])
    for (const readOnlyTools of ["inspect", [null], ["../delete"], Array.from({ length: 257 }, () => "inspect")]) {
      await writeConfig(root, "config.json", { version: 1, mcp: { servers: [{ name: "local", command: "fixture", readOnlyTools }] } })
      await expect(loadBehaviorConfigFile(path, { cwd: root })).rejects.toThrow("read-only tools")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
