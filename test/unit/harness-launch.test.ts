import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessLaunchError, createFileVendorSessionStore, deriveHarnessLaunch, parseHarnessLaunchOptions } from "../../src/index.ts"
import { claudeCodeLaunchArguments, codexEffortFor, codexExecLaunchArguments, codexThreadParameters, isVendorSessionId } from "../../src/harness/launch.ts"
import { createRunrailSession } from "../../src/session.ts"

const ALLOW_EDITS = ["apply_patch", "write_file", "edit_file"].map((tool) => ({ tool, match: "*", policy: "allow" as const }))

function behavior(overrides: Partial<Parameters<typeof deriveHarnessLaunch>[2] & object> = {}): NonNullable<Parameters<typeof deriveHarnessLaunch>[2]> {
  return { mode: "ask", effort: "medium", permissionDefault: "ask", permissionRules: [], ...overrides }
}

describe("harness launch options", () => {
  test("parses a bounded option set and freezes it", () => {
    expect(parseHarnessLaunchOptions(undefined)).toEqual({})
    const parsed = parseHarnessLaunchOptions({ model: "opus[1m]", effort: "xhigh", permissionMode: "accept-edits", appendSystemPrompt: "-be brief", mcpConfig: ["/tmp/mcp.json"], resume: "0199-abc" })
    expect(parsed).toEqual({ model: "opus[1m]", effort: "xhigh", permissionMode: "accept-edits", appendSystemPrompt: "-be brief", mcpConfig: ["/tmp/mcp.json"], resume: "0199-abc" })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(parseHarnessLaunchOptions({ mcpConfig: [] })).toEqual({})
  })

  test("rejects anything that could become a flag or an unknown setting", () => {
    const rejected: unknown[] = [
      null,
      [],
      "opus",
      { extra: true },
      { model: "--dangerously-skip-permissions" },
      { model: "has space" },
      { model: "" },
      { model: "m".repeat(129) },
      { effort: "extreme" },
      { permissionMode: "bypassPermissions" },
      { appendSystemPrompt: "" },
      { appendSystemPrompt: "x".repeat(32 * 1024 + 1) },
      { appendSystemPrompt: "nul\0" },
      { mcpConfig: "one.json" },
      { mcpConfig: ["--strict-mcp-config"] },
      { mcpConfig: [""] },
      { mcpConfig: Array.from({ length: 9 }, (_, index) => `${index}.json`) },
      { resume: "--last" },
      { resume: "has space" },
    ]
    for (const value of rejected) {
      expect(() => parseHarnessLaunchOptions(value)).toThrow(HarnessLaunchError)
    }
    expect(() => parseHarnessLaunchOptions({ effort: "extreme" })).toThrow("harness launch: effort is invalid")
    expect(isVendorSessionId("0199a1b2-c3d4")).toBe(true)
    expect(isVendorSessionId("-flag")).toBe(false)
    expect(isVendorSessionId(7)).toBe(false)
  })

  test("derives the unset fields from the model selection and the behavior file", () => {
    expect(deriveHarnessLaunch(undefined, undefined, undefined)).toEqual({})
    expect(deriveHarnessLaunch(undefined, { id: "sonnet", thinking: "high" }, behavior())).toEqual({ model: "sonnet", effort: "high", permissionMode: "ask" })
    // The thinking level on the thread wins over the behavior file's effort, and never goes below "low".
    expect(deriveHarnessLaunch(undefined, { thinking: "off" }, behavior({ effort: "high" })).effort).toBe("low")
    expect(deriveHarnessLaunch(undefined, { thinking: "minimal" }, undefined).effort).toBe("low")
    expect(deriveHarnessLaunch(undefined, {}, behavior({ effort: "high" })).effort).toBe("high")
    expect(deriveHarnessLaunch(undefined, {}, behavior({ effort: "off" })).effort).toBe("low")
    expect(deriveHarnessLaunch(undefined, { thinking: "unheard-of" }, undefined).effort).toBeUndefined()
    // Past high: the tools' own top levels, from the thread or the behavior file.
    expect(deriveHarnessLaunch(undefined, { thinking: "xhigh" }, undefined).effort).toBe("xhigh")
    expect(deriveHarnessLaunch(undefined, {}, behavior({ effort: "max" })).effort).toBe("max")
    expect(deriveHarnessLaunch(undefined, undefined, behavior({ instructionsText: "Prefer small diffs." })).appendSystemPrompt).toBe("Prefer small diffs.")
    expect(deriveHarnessLaunch(undefined, undefined, behavior({ instructionsText: "" })).appendSystemPrompt).toBeUndefined()
    expect(deriveHarnessLaunch(undefined, undefined, behavior({ instructionsText: "y".repeat(40 * 1024) })).appendSystemPrompt).toHaveLength(32 * 1024)
  })

  test("maps the behavior file to a permission mode without ever widening it", () => {
    const mode = (overrides: Parameters<typeof behavior>[0]): string | undefined => deriveHarnessLaunch(undefined, undefined, behavior(overrides)).permissionMode
    expect(mode({ mode: "plan", permissionDefault: "allow" })).toBe("plan")
    expect(mode({ mode: "auto", permissionDefault: "allow" })).toBe("bypass")
    expect(mode({ mode: "auto", permissionDefault: "ask" })).toBe("auto")
    expect(mode({})).toBe("ask")
    expect(mode({ permissionRules: ALLOW_EDITS })).toBe("accept-edits")
    expect(mode({ permissionRules: ALLOW_EDITS.slice(0, 2) })).toBe("ask")
    expect(mode({ permissionRules: ALLOW_EDITS.map((rule) => ({ ...rule, match: "src/**" })) })).toBe("ask")
    expect(mode({ permissionRules: [...ALLOW_EDITS, { tool: "bash", match: "rm *", policy: "deny" }] })).toBe("ask")
    // A route change never drops a deny rule the native loop would enforce.
    const deny = [{ tool: "run_command", match: "*", policy: "deny" as const }]
    expect(mode({ mode: "auto", permissionDefault: "allow", permissionRules: deny })).toBe("ask")
    expect(mode({ mode: "auto", permissionDefault: "ask", permissionRules: deny })).toBe("ask")
    expect(mode({ mode: "plan", permissionDefault: "allow", permissionRules: deny })).toBe("plan")
  })

  test("keeps explicit values and refuses a model id that cannot be an argument", () => {
    const explicit = { model: "opus", effort: "max" as const, permissionMode: "plan" as const, appendSystemPrompt: "explicit" }
    expect(deriveHarnessLaunch(explicit, { id: "sonnet", thinking: "low" }, behavior({ mode: "auto", permissionDefault: "allow", instructionsText: "derived" }))).toEqual(explicit)
    expect(() => deriveHarnessLaunch(undefined, { id: "--model-injection" }, undefined)).toThrow("harness launch: model is invalid")
    // An explicit model stands in for a selection that is not a CLI model id.
    expect(deriveHarnessLaunch({ model: "opus" }, { id: "not a cli id" }, undefined).model).toBe("opus")
    expect(() => deriveHarnessLaunch({ effort: "extreme" } as never, undefined, undefined)).toThrow(HarnessLaunchError)
  })

  test("builds Claude Code print-mode arguments", () => {
    const search = ["--allowedTools", "Grep(./**)", "Glob(./**)"]
    expect(claudeCodeLaunchArguments({})).toEqual(search)
    expect(claudeCodeLaunchArguments({ model: "opus", effort: "minimal", permissionMode: "ask", appendSystemPrompt: "--not-a-flag", mcpConfig: ["a.json", "b.json"], resume: "launch-session" })).toEqual([
      "--mcp-config", "a.json", "b.json",
      ...search,
      "--model", "opus",
      "--effort", "low",
      "--permission-mode", "manual",
      "--append-system-prompt=--not-a-flag",
      "--resume", "launch-session",
    ])
    // The conversation the CLI reported replaces the one named at launch.
    expect(claudeCodeLaunchArguments({ resume: "launch-session" }, "reported-session")).toEqual([...search, "--resume", "reported-session"])
    expect(claudeCodeLaunchArguments({ allowedTools: ["mcp__runrail_connectors"], askTools: ["mcp__runrail_connectors__slack_send"] })).toEqual(["--allowedTools", "mcp__runrail_connectors", "Grep(./**)", "Glob(./**)", "--disallowedTools", "mcp__runrail_connectors__slack_send"])
    expect(claudeCodeLaunchArguments({}, "--bad")).toEqual(search)
    // A rewind continues a copy from the message it went back to; a mark alone, or a flag-like one, adds nothing.
    expect(claudeCodeLaunchArguments({}, "kept-session", true, "msg-7").slice(-4)).toEqual(["--resume", "kept-session", "--fork-session", "--resume-session-at=msg-7"])
    expect(claudeCodeLaunchArguments({}, "kept-session", false, "msg-7")).not.toContain("--resume-session-at=msg-7")
    expect(claudeCodeLaunchArguments({}, "kept-session", true, "--bad").at(-1)).toBe("--fork-session")
    const modes = (["plan", "ask", "accept-edits", "auto", "bypass"] as const).map((permissionMode) => claudeCodeLaunchArguments({ permissionMode })[4])
    expect(modes).toEqual(["plan", "manual", "acceptEdits", "auto", "bypassPermissions"])
  })

  test("builds Codex exec arguments and app-server thread parameters", () => {
    expect(codexExecLaunchArguments({})).toEqual(["exec", "--json", "-"])
    expect(codexExecLaunchArguments({ model: "gpt-fixture", effort: "max", permissionMode: "ask", appendSystemPrompt: 'say "hi"\n[table]' })).toEqual([
      "exec", "--json",
      "-m", "gpt-fixture",
      "-c", "model_reasoning_effort=max",
      "-c", "sandbox_mode=read-only",
      "-c", 'developer_instructions="say \\"hi\\"\\n[table]"',
      "-",
    ])
    // A level the Codex model does not list runs as the nearest one below it that it does.
    expect(codexEffortFor("ultra", ["low", "medium", "high", "xhigh", "max", "ultra"])).toBe("ultra")
    expect(codexEffortFor("ultra", ["low", "medium", "high", "xhigh"])).toBe("xhigh")
    expect(codexEffortFor("max", ["medium", "high"])).toBe("high")
    expect(codexEffortFor("low", ["medium", "high"])).toBe("medium")
    expect(codexEffortFor("max", undefined)).toBe("max")
    // Codex takes Ultra as its own level; Claude Code tops out at Max.
    expect(codexExecLaunchArguments({ effort: "ultra" })).toEqual(["exec", "--json", "-c", "model_reasoning_effort=ultra", "-"])
    expect(claudeCodeLaunchArguments({ effort: "ultra" })).toEqual(["--allowedTools", "Grep(./**)", "Glob(./**)", "--effort", "max"])
    expect(codexExecLaunchArguments({ model: "gpt-fixture", permissionMode: "bypass" }, "thread-7")).toEqual(["exec", "resume", "--json", "-m", "gpt-fixture", "-c", "sandbox_mode=danger-full-access", "thread-7", "-"])
    expect(codexExecLaunchArguments({ resume: "launch-thread" })).toEqual(["exec", "resume", "--json", "launch-thread", "-"])
    const sandboxes = (["plan", "ask", "accept-edits", "auto", "bypass"] as const).map((permissionMode) => codexExecLaunchArguments({ permissionMode })[3])
    expect(sandboxes).toEqual(["sandbox_mode=read-only", "sandbox_mode=read-only", "sandbox_mode=workspace-write", "sandbox_mode=workspace-write", "sandbox_mode=danger-full-access"])

    expect(codexThreadParameters({})).toEqual({})
    expect(codexThreadParameters({ model: "gpt-fixture", permissionMode: "plan", appendSystemPrompt: "notes" })).toEqual({ model: "gpt-fixture", approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only", developerInstructions: "notes" })
    expect(codexThreadParameters({ permissionMode: "ask" })).toEqual({ approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" })
    expect(codexThreadParameters({ permissionMode: "accept-edits" })).toEqual({ approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" })
    expect(codexThreadParameters({ permissionMode: "auto" })).toEqual({ approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" })
    expect(codexThreadParameters({ permissionMode: "bypass" })).toEqual({ approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" })
  })
})

describe("vendor session store", () => {
  test("keeps one pointer per backend and session, private to the user", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-vendor-store-"))
    const directory = join(root, "harness")
    try {
      const claude = createFileVendorSessionStore(directory, "claude-code")
      const codex = createFileVendorSessionStore(directory, "codex")
      expect(await claude.load("thread-1")).toBeUndefined()
      await claude.save("thread-1", "claude-session-a")
      await claude.save("thread-1", "claude-session-b")
      await codex.save("thread-1", "codex-thread-a")
      expect(await claude.load("thread-1")).toBe("claude-session-b")
      expect(await codex.load("thread-1")).toBe("codex-thread-a")
      expect(await claude.load("thread-2")).toBeUndefined()

      const files = await readdir(directory)
      expect(files).toHaveLength(2)
      expect(files.every((file) => /^(?:claude-code|codex)-[0-9a-f]{32}\.json$/.test(file))).toBe(true)
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      for (const file of files) {
        expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600)
      }
      const record = JSON.parse(await readFile(join(directory, files.find((file) => file.startsWith("claude-code-")) as string), "utf8")) as Record<string, unknown>
      expect(Object.keys(record).sort()).toEqual(["backend", "sessionId", "vendorSessionId", "version"])

      await claude.save("thread-1", undefined)
      expect(await claude.load("thread-1")).toBeUndefined()
      expect(await codex.load("thread-1")).toBe("codex-thread-a")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ignores a pointer it did not write and refuses an unsafe id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runrail-vendor-store-"))
    try {
      const store = createFileVendorSessionStore(directory, "codex")
      await store.save("thread-1", "codex-thread-a")
      const [file] = await readdir(directory)
      const path = join(directory, file as string)
      for (const tampered of [
        "not json",
        JSON.stringify({ version: 2, backend: "codex", sessionId: "thread-1", vendorSessionId: "codex-thread-a" }),
        JSON.stringify({ version: 1, backend: "claude-code", sessionId: "thread-1", vendorSessionId: "codex-thread-a" }),
        JSON.stringify({ version: 1, backend: "codex", sessionId: "thread-9", vendorSessionId: "codex-thread-a" }),
        JSON.stringify({ version: 1, backend: "codex", sessionId: "thread-1", vendorSessionId: "--last" }),
        JSON.stringify({ version: 1, backend: "codex", sessionId: "thread-1", vendorSessionId: "codex-thread-a", padding: "x".repeat(5_000) }),
      ]) {
        await writeFile(path, tampered)
        expect(await store.load("thread-1")).toBeUndefined()
      }
      await expect(store.save("thread-1", "--last")).rejects.toThrow("vendor session id is invalid")
      expect(() => createFileVendorSessionStore("", "codex")).toThrow("vendor session directory is invalid")
      expect(() => createFileVendorSessionStore(directory, "../codex")).toThrow("vendor session backend is invalid")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("launch options on a session", () => {
  test("are refused where no vendor CLI would receive them", async () => {
    const launch = { effort: "high" } as const
    await expect(createRunrailSession({ cwd: "/tmp", backend: "replay", loadExtensions: false, harnessLaunch: launch })).rejects.toThrow("HARNESS_LAUNCH_REQUIRES_HARNESS_BACKEND")
    // A caller who names the command, or keeps one process alive, owns its arguments.
    await expect(createRunrailSession({ cwd: "/tmp", backend: "claude-code", loadExtensions: false, harnessCommand: "fixture", harnessLaunch: launch })).rejects.toThrow("HARNESS_LAUNCH_REQUIRES_VENDOR_COMMAND")
    await expect(createRunrailSession({ cwd: "/tmp", backend: "codex", loadExtensions: false, harnessPersistent: true, harnessLaunch: launch })).rejects.toThrow("HARNESS_LAUNCH_REQUIRES_VENDOR_COMMAND")
    await expect(createRunrailSession({ cwd: "/tmp", backend: "codex", loadExtensions: false, harnessCommand: "fixture", harnessProtocol: "jsonl", harnessLaunch: launch })).rejects.toThrow("HARNESS_LAUNCH_REQUIRES_VENDOR_COMMAND")
    await expect(createRunrailSession({ cwd: "/tmp", backend: "copilot", loadExtensions: false, harnessPersistent: true, harnessLaunch: launch })).rejects.toThrow("HARNESS_LAUNCH_REQUIRES_VENDOR_COMMAND")
    // Copilot speaks one protocol under any command name, so a named command still takes the settings.
    const session = await createRunrailSession({ cwd: "/tmp", backend: "copilot", loadExtensions: false, harnessCommand: "fixture", harnessLaunch: launch })
    expect(session.backend.info.name).toBe("copilot")
  })
})
