import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeAskGate, claudeCallGated, claudeGrantCovers, claudeSessionGrants, claudeEditsControlPath } from "../../src/backend/claude-permission-gate.ts"

const signal = new AbortController().signal

describe("Claude Code's ask gate", () => {
  test("asks before edits, commands, network calls, MCP tools and unknown tools in Claude Code's default mode", () => {
    for (const tool of ["Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Monitor", "mcp__github__create_issue", "SomeNewTool"]) expect(claudeCallGated(tool, "default")).toBe(true)
    for (const tool of ["Read", "Glob", "Grep", "TodoWrite", "TaskUpdate", "Agent", "ExitPlanMode", "AskUserQuestion", "ReadMcpResourceTool"]) expect(claudeCallGated(tool, "default")).toBe(false)
    expect(claudeCallGated("Bash", "manual")).toBe(true)
  })

  test("leaves edits to acceptEdits, and plan, auto, bypass and dontAsk to Claude Code", () => {
    expect(claudeCallGated("Edit", "acceptEdits")).toBe(false)
    expect(claudeCallGated("Write", "acceptEdits")).toBe(false)
    expect(claudeCallGated("Bash", "acceptEdits")).toBe(true)
    for (const mode of ["plan", "auto", "bypassPermissions", "dontAsk"]) expect(claudeCallGated("Bash", mode)).toBe(false)
  })

  test("never asks about a tool or MCP server the launch lets run unasked", () => {
    const allowed = ["mcp__runrail_browser", "Bash"]
    expect(claudeCallGated("mcp__runrail_browser__click", "default", allowed)).toBe(false)
    expect(claudeCallGated("Bash", "default", allowed)).toBe(false)
    expect(claudeCallGated("mcp__runrail_browser_other__click", "default", allowed)).toBe(true)
    expect(claudeCallGated("mcp__github__create_issue", "default", allowed)).toBe(true)
  })

  test("the hook follows the mode Claude Code reports, else the launch's, and asks about a call it cannot read", async () => {
    const gate = claudeAskGate("default", [])
    const asked = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: expect.any(String) } } as const
    expect(await gate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sleep 1; echo hi" }, permission_mode: "default" }, "toolu_1", { signal })).toEqual(asked)
    expect(await gate({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.ts" }, permission_mode: "default" }, "toolu_2", { signal })).toEqual({})
    // An auto mode that runs as asked is left alone; one that fell back to default is gated.
    const auto = claudeAskGate("auto", [])
    expect(await auto({ tool_name: "Bash", permission_mode: "auto" }, undefined, { signal })).toEqual({})
    expect(await auto({ tool_name: "Bash", permission_mode: "default" }, undefined, { signal })).toEqual(asked)
    expect(await gate({ tool_name: "Bash" }, undefined, { signal })).toEqual(asked)
    expect(await claudeAskGate("plan", [])({ tool_name: "Bash" }, undefined, { signal })).toEqual({})
    for (const input of [null, "Bash", [], { tool_name: 7 }]) expect(await auto(input, undefined, { signal })).toEqual(asked)
  })
})

describe("session grants kept from Claude Code's suggestions", () => {
  test("keeps only allow rules it can read, and drops a rule whose content is unreadable rather than widening it", () => {
    expect(claudeSessionGrants([
      { type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }, { toolName: "Write" }] },
      { type: "addRules", behavior: "deny", rules: [{ toolName: "Bash" }] },
      { type: "addRules", rules: [{ toolName: "Edit" }] },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: 42 }, { toolName: "Bash", ruleContent: "  " }, { toolName: "Bash", ruleContent: "x".repeat(1_025) }, { toolName: "not a tool" }, "Bash"] },
      null,
    ])).toEqual([{ tool: "Bash", content: "npm test:*" }, { tool: "Write" }])
    const many = { type: "addRules", behavior: "allow", rules: Array.from({ length: 40 }, (_, index) => ({ toolName: `mcp__s${String(index)}` })) }
    expect(claudeSessionGrants([many])).toHaveLength(16)
  })

  test("covers a whole tool or MCP server, an exact command, and a prefix only over a plain command", () => {
    expect(claudeGrantCovers({ tool: "Write" }, "Write", { file_path: "a.ts" })).toBe(true)
    expect(claudeGrantCovers({ tool: "Write" }, "Edit", { file_path: "a.ts" })).toBe(false)
    expect(claudeGrantCovers({ tool: "mcp__github" }, "mcp__github__create_issue", {})).toBe(true)
    expect(claudeGrantCovers({ tool: "mcp__github" }, "mcp__github_enterprise__create_issue", {})).toBe(false)
    const prefix = { tool: "Bash", content: "npm test:*" }
    expect(claudeGrantCovers(prefix, "Bash", { command: "npm test" })).toBe(true)
    expect(claudeGrantCovers(prefix, "Bash", { command: "npm test -- --watch" })).toBe(true)
    expect(claudeGrantCovers({ tool: "Bash", content: "npm run *" }, "Bash", { command: "npm run build" })).toBe(true)
    for (const command of ["npm testing", "npm test && rm -rf build", "npm test; rm -rf build", "npm test | sh", "npm test $(rm -rf build)", "npm test `rm -rf build`", "npm test > /etc/hosts", "npm test\nrm -rf build", "sudo npm test"])
      expect(claudeGrantCovers(prefix, "Bash", { command })).toBe(false)
    expect(claudeGrantCovers(prefix, "PowerShell", { command: "npm test" })).toBe(false)
    expect(claudeGrantCovers(prefix, "Bash", {})).toBe(false)
    // What the person approved word for word is covered as written.
    expect(claudeGrantCovers({ tool: "Bash", content: "sleep 1; echo hi" }, "Bash", { command: "sleep 1; echo hi" })).toBe(true)
    expect(claudeGrantCovers({ tool: "Bash", content: "sleep 1; echo hi" }, "Bash", { command: "sleep 1; echo hi; rm -rf build" })).toBe(false)
    for (const content of [":*", "npm * test:*", "*"]) expect(claudeGrantCovers({ tool: "Bash", content }, "Bash", { command: "npm test" })).toBe(false)
  })

  test("covers a WebFetch domain exactly, and never a path rule", () => {
    const domain = { tool: "WebFetch", content: "domain:docs.example.com" }
    expect(claudeGrantCovers(domain, "WebFetch", { url: "https://docs.example.com/guide" })).toBe(true)
    expect(claudeGrantCovers(domain, "WebFetch", { url: "https://DOCS.example.com" })).toBe(true)
    expect(claudeGrantCovers(domain, "WebFetch", { url: "https://evil.docs.example.com.attacker.net" })).toBe(false)
    expect(claudeGrantCovers(domain, "WebFetch", { url: "not a url" })).toBe(false)
    expect(claudeGrantCovers({ tool: "WebFetch", content: "docs.example.com" }, "WebFetch", { url: "https://docs.example.com" })).toBe(false)
    expect(claudeGrantCovers({ tool: "Edit", content: "src/**" }, "Edit", { file_path: "src/a.ts" })).toBe(false)
  })
})

test("an edit to git's own files or the project's .runrail folder is asked about in every mode", async () => {
  expect(claudeEditsControlPath("Edit", { file_path: "/repo/.git/config" }, "/repo")).toBe(true)
  expect(claudeEditsControlPath("Write", { file_path: ".runrail/setups.json" }, "/repo")).toBe(true)
  expect(claudeEditsControlPath("MultiEdit", { file_path: "/repo/vendor/lib/.git/hooks/post-checkout" }, "/repo")).toBe(true)
  expect(claudeEditsControlPath("Write", { file_path: "/repo/src/index.ts" }, "/repo")).toBe(false)
  expect(claudeEditsControlPath("Write", { file_path: "/elsewhere/.git/config" }, "/repo")).toBe(false)
  expect(claudeEditsControlPath("Bash", { command: "cat .git/config" }, "/repo")).toBe(false)
  const gate = claudeAskGate("bypassPermissions", [], [], "/repo")
  const decide = async (tool: string, input: Record<string, unknown>, mode: string) => (await gate({ tool_name: tool, tool_input: input, permission_mode: mode, cwd: "/repo" }, "toolu_1", { signal: new AbortController().signal })).hookSpecificOutput?.permissionDecision
  for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions"]) expect(await decide("Edit", { file_path: "/repo/.git/config" }, mode)).toBe("ask")
  expect(await decide("Edit", { file_path: "/repo/src/a.ts" }, "acceptEdits")).toBeUndefined()
})

test("an edit to the .nifra/extensions the engine imports is asked about in every mode; other .nifra files are not", async () => {
  for (const target of ["/repo/.nifra/extensions/planted.ts", ".nifra/extensions/nested/helper.js", "/repo/.NIFRA/Extensions/x.ts", "/repo/.nifra/extensions"]) expect(claudeEditsControlPath("Write", { file_path: target }, "/repo")).toBe(true)
  expect(claudeEditsControlPath("Write", { file_path: "/repo/.nifra/notes.md" }, "/repo")).toBe(false)
  expect(claudeEditsControlPath("Edit", { file_path: "/repo/src/extensions/x.ts" }, "/repo")).toBe(false)
  const gate = claudeAskGate("bypassPermissions", [], [], "/repo")
  for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions"]) {
    const decision = await gate({ tool_name: "Write", tool_input: { file_path: "/repo/.nifra/extensions/planted.ts" }, permission_mode: mode, cwd: "/repo" }, "toolu_1", { signal: new AbortController().signal })
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("ask")
  }
})

test("a link in the project that reaches its control files is asked about too", async () => {
  const repo = await mkdtemp(join(tmpdir(), "runrail-claude-gate-"))
  try {
    await mkdir(join(repo, ".git", "hooks"), { recursive: true })
    await writeFile(join(repo, ".git", "config"), "[core]\n")
    await mkdir(join(repo, "src"))
    await symlink(join(".git", "config"), join(repo, "alias.txt"))
    await symlink(join(".git", "hooks", "pre-commit"), join(repo, "dangling.sh"))
    await symlink(".runrail", join(repo, "settings"))
    await symlink(".git", join(repo, "meta"))
    await symlink(tmpdir(), join(repo, "out"))
    for (const target of ["alias.txt", "dangling.sh", "settings/setups.json", "meta/hooks/post-checkout", "out/x.txt"]) expect(claudeEditsControlPath("Write", { file_path: target }, repo)).toBe(true)
    expect(claudeEditsControlPath("Write", { file_path: "src/new/a.ts" }, repo)).toBe(false)
    expect(claudeEditsControlPath("Write", { file_path: join(repo, "src", "a.ts") }, repo)).toBe(false)
    const gate = claudeAskGate("acceptEdits", [], [], repo)
    const decision = await gate({ tool_name: "Write", tool_input: { file_path: join(repo, "alias.txt") }, permission_mode: "acceptEdits", cwd: repo }, "toolu_1", { signal: new AbortController().signal })
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("ask")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
