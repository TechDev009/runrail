import { describe, expect, test } from "bun:test"
import { parseCliArgs } from "../../src/cli.ts"

describe("CLI parsing", () => {
  test("parses bounded run options", () => {
    expect(
      parseCliArgs([
        "run",
        "--cwd",
        ".",
        "--backend",
        "native",
        "--max-steps",
        "4",
        "--max-repair-attempts",
        "2",
        "--verify",
        "check",
        "--json",
        "repair",
        "this",
      ]),
    ).toMatchObject({ backend: "native", maxSteps: 4, maxRepairAttempts: 2, json: true, task: "repair this" })
  })
  test("parses explicit Pi extension activation options", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "native", "--pi-extension", ".pi/agent/extensions/review.ts", "--pi-extension-capability", "filesystem.read", "task"])).toMatchObject({
      piExtensionPaths: [".pi/agent/extensions/review.ts"],
      piExtensionCapabilities: ["filesystem.read"],
    })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--pi-extension-capability", "../escape"])).toThrow()
  })

  test("takes every reasoning level, xhigh, max, and ultra included, and nothing else", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "claude-code", "--thinking", level, "task"])).toMatchObject({ modelSelection: { thinking: level } })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--thinking", "persistent", "task"])).toThrow("invalid thinking level")
  })

  test("turns the default coding prompt off only when asked", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "native", "--no-default-prompt", "task"])).toMatchObject({ defaultSystemPrompt: false })
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--approval-timeout-ms", "86400000"])).toMatchObject({ approvalTimeoutMs: 86_400_000 })
    expect(() => parseCliArgs(["control", "--cwd", "/tmp/project", "--approval-timeout-ms", "86400001"])).toThrow()
    expect(() => parseCliArgs(["control", "--cwd", "/tmp/project", "--approval-timeout-ms", "0"])).toThrow()
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "native", "task"])).not.toHaveProperty("defaultSystemPrompt")
  })

  test("rejects an unsafe repair cap", () => {
    expect(() => parseCliArgs(["run", "--cwd", ".", "--max-repair-attempts", "9"])).toThrow()
  })
  test("parses the bounded deterministic benchmark command", () => {
    expect(parseCliArgs(["benchmark", "--repeats", "2", "--concurrency", "2", "--json"])).toMatchObject({ command: "benchmark", backend: "replay", benchmarkRepeats: 2, benchmarkConcurrency: 2, json: true })
    expect(() => parseCliArgs(["benchmark", "--repeats", "33"])).toThrow()
  })
  test("parses the local MCP server command", () => {
    expect(parseCliArgs(["mcp", "--cwd", "/tmp/project", "--max-message-bytes", "4096"])).toMatchObject({ command: "mcp", cwd: "/tmp/project", mcpMaxMessageBytes: 4096 })
    expect(() => parseCliArgs(["mcp", "--unknown"])).toThrow()
  })
  test("parses caller-owned MCP attachment options for native runs", () => {
    expect(parseCliArgs(["run", "--backend", "native", "--cwd", "/tmp/project", "--mcp-command", "bun", "--mcp-arg", "run", "--mcp-load-resources", "inspect"])).toMatchObject({ mcpCommand: "bun", mcpArgs: ["run"], mcpLoadResources: true })
    expect(parseCliArgs(["run", "--backend", "replay", "--cwd", "/tmp/project", "--mcp-command", "bun"])).toMatchObject({ backend: "replay", mcpCommand: "bun" })
  })
  test("parses first-party provider and harness options without secrets", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--provider", "openai", "--provider-model", "gpt-fixture", "--provider-credential-env", "OPENAI_API_KEY", "--provider-endpoint", "http://127.0.0.1:1", "--harness-command", "fixture", "--harness-arg", "--rpc", "task"])).toMatchObject({ backend: "native", provider: { provider: "openai", model: "gpt-fixture", credential: { kind: "environment", environment: "OPENAI_API_KEY" }, endpoint: "http://127.0.0.1:1" }, harnessCommand: "fixture", harnessArgs: ["--rpc"] })
    expect(parseCliArgs(["providers", "--json"])).toMatchObject({ command: "providers", json: true })
    expect(parseCliArgs(["harnesses", "--json"])).toMatchObject({ command: "harnesses", json: true })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--provider", "openai", "--provider-model", "gpt", "--provider-credential-env", "BAD-NAME"])).toThrow()
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--provider", "openai", "--provider-model", "gpt", "--backend", "pi"])).toThrow()
  })
  test("parses explicit harness authentication modes", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "codex", "--harness-auth", "environment", "--harness-credential-env", "OPENAI_API_KEY", "task"])).toMatchObject({
      harnessAuth: { mode: "environment", credentialEnvironment: ["OPENAI_API_KEY"] },
    })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "codex", "--harness-auth", "environment", "task"])).toThrow()
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "codex", "--harness-auth", "caller", "task"])).toThrow()
  })
  test("parses persistent vendor harness mode only for Codex and Claude", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "codex", "--harness-persistent", "task"])).toMatchObject({ harnessPersistent: true })
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "claude-code", "--harness-persistent", "task"])).toMatchObject({ harnessPersistent: true })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "native", "--harness-persistent", "task"])).toThrow()
  })
  test("parses the explicit Codex app-server protocol only", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "codex", "--harness-protocol", "app-server", "task"])).toMatchObject({ harnessProtocol: "app-server" })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "claude-code", "--harness-protocol", "app-server", "task"])).toThrow()
  })
  test("parses Claude Code's sdk and print protocols for Claude Code only", () => {
    const base = ["run", "--cwd", "/tmp/project", "--backend"]
    expect(parseCliArgs([...base, "claude-code", "--harness-protocol", "sdk", "task"])).toMatchObject({ harnessProtocol: "sdk" })
    expect(parseCliArgs([...base, "claude-code", "--harness-protocol", "print", "task"])).toMatchObject({ harnessProtocol: "print" })
    // The SDK route takes the thread's settings even when the caller names the claude binary.
    expect(parseCliArgs([...base, "claude-code", "--harness-command", "/opt/claude", "--harness-protocol", "sdk", "--harness-permission-mode", "ask", "task"])).toMatchObject({ harnessLaunch: { permissionMode: "ask" } })
    expect(() => parseCliArgs([...base, "codex", "--harness-protocol", "sdk", "task"])).toThrow("--harness-protocol sdk requires the Claude Code backend")
    expect(() => parseCliArgs([...base, "claude-code", "--harness-protocol", "sdk", "--harness-arg", "--verbose", "task"])).toThrow("--harness-protocol sdk cannot be combined")
    expect(() => parseCliArgs([...base, "claude-code", "--harness-protocol", "sdk", "--harness-persistent", "task"])).toThrow("--harness-protocol sdk cannot be combined")
    expect(() => parseCliArgs([...base, "claude-code", "--harness-protocol", "agent", "task"])).toThrow("invalid harness protocol")
  })
  test("parses vendor launch options for the Codex and Claude Code routes only", () => {
    const base = ["run", "--cwd", "/tmp/project", "--backend"]
    expect(parseCliArgs([...base, "claude-code", "--harness-effort", "xhigh", "--harness-permission-mode", "accept-edits", "--harness-append-system-prompt", "Prefer small diffs.", "--harness-mcp-config", "/tmp/a.json", "--harness-mcp-config", "/tmp/b.json", "--harness-resume", "session-1", "task"])).toMatchObject({
      harnessLaunch: { effort: "xhigh", permissionMode: "accept-edits", appendSystemPrompt: "Prefer small diffs.", mcpConfig: ["/tmp/a.json", "/tmp/b.json"], resume: "session-1" },
    })
    expect(parseCliArgs([...base, "codex", "--harness-effort", "low", "task"])).toMatchObject({ harnessLaunch: { effort: "low" } })
    // The app-server protocol carries launch settings even when the caller names the command.
    expect(parseCliArgs([...base, "codex", "--harness-command", "fixture", "--harness-protocol", "app-server", "--harness-permission-mode", "plan", "task"])).toMatchObject({ harnessLaunch: { permissionMode: "plan" } })
    expect(parseCliArgs([...base, "codex", "task"]).harnessLaunch).toBeUndefined()
    expect(() => parseCliArgs([...base, "claude-code", "--harness-effort", "extreme", "task"])).toThrow("invalid harness effort")
    expect(() => parseCliArgs([...base, "claude-code", "--harness-permission-mode", "yolo", "task"])).toThrow("invalid harness permission mode")
    expect(() => parseCliArgs([...base, "native", "--harness-effort", "high", "task"])).toThrow("harness launch options require a Codex, Claude Code, or Agent Client Protocol backend")
    expect(() => parseCliArgs([...base, "pi", "--harness-resume", "session-1", "task"])).toThrow("harness launch options require a Codex, Claude Code, or Agent Client Protocol backend")
    expect(() => parseCliArgs([...base, "claude-code", "--harness-command", "fixture", "--harness-effort", "high", "task"])).toThrow("harness launch options cannot be combined with --harness-command or --harness-persistent")
    expect(() => parseCliArgs([...base, "codex", "--harness-persistent", "--harness-effort", "high", "task"])).toThrow("harness launch options cannot be combined with --harness-command or --harness-persistent")
    expect(() => parseCliArgs([...base, "codex", "--harness-mcp-config", "/tmp/a.json", "task"])).toThrow("--harness-mcp-config requires the Claude Code backend")
    expect(() => parseCliArgs([...base, "claude-code", "--harness-resume", "-not-an-id", "task"])).toThrow()
    // Copilot has one protocol, so its settings travel whatever the command is called.
    expect(parseCliArgs([...base, "copilot", "--model", "gpt-fixture", "--harness-effort", "max", "--harness-permission-mode", "plan", "--harness-append-system-prompt", "Prefer small diffs.", "--harness-resume", "session-1", "task"])).toMatchObject({ backend: "copilot", harnessLaunch: { effort: "max", permissionMode: "plan", appendSystemPrompt: "Prefer small diffs.", resume: "session-1" } })
    expect(parseCliArgs([...base, "copilot", "--harness-command", "fixture", "--harness-effort", "high", "task"])).toMatchObject({ harnessCommand: "fixture", harnessLaunch: { effort: "high" } })
    expect(() => parseCliArgs([...base, "copilot", "--harness-mcp-config", "/tmp/a.json", "task"])).toThrow("--harness-mcp-config requires the Claude Code backend")
    expect(() => parseCliArgs([...base, "copilot", "--harness-protocol", "jsonl", "task"])).toThrow("--harness-protocol does not apply to the Copilot backend")
    expect(() => parseCliArgs([...base, "copilot", "--harness-persistent", "task"])).toThrow("--harness-persistent requires the Codex or Claude Code backend")
    // OpenCode, Gemini CLI, and Goose are Agent Client Protocol routes like Copilot.
    for (const backend of ["opencode", "gemini", "goose"]) expect(parseCliArgs([...base, backend, "--harness-command", "fixture", "--harness-permission-mode", "ask", "task"])).toMatchObject({ backend, harnessCommand: "fixture", harnessLaunch: { permissionMode: "ask" } })
    expect(() => parseCliArgs([...base, "goose", "--harness-protocol", "jsonl", "task"])).toThrow("--harness-protocol does not apply to the Goose backend")
    expect(() => parseCliArgs([...base, "claude-code", "--harness-append-system-prompt", "x".repeat(32 * 1024 + 1), "task"])).toThrow()
  })
  test("keeps model discovery explicit and credential-reference-only", () => {
    expect(parseCliArgs(["models", "--json", "--discover", "--provider", "openai", "--provider-credential-env", "OPENAI_API_KEY", "--provider-endpoint", "http://127.0.0.1:1"])).toMatchObject({ command: "models", providerDiscovery: { provider: "openai", credential: { kind: "environment", environment: "OPENAI_API_KEY" } } })
    expect(() => parseCliArgs(["models", "--provider", "openai"])).toThrow()
  })
  test("runs on a saved connection without taking an address, protocol or key on the command line", () => {
    const parsed = parseCliArgs(["run", "--cwd", "/tmp/project", "--connection", "work-openrouter", "--model", "router/model", "--thinking", "high", "--accounts-dir", "/tmp/accounts", "--credential-vault", "file", "task"])
    expect(parsed).toMatchObject({ backend: "native", connection: { id: "work-openrouter", model: "router/model", thinking: "high" }, accountsDir: "/tmp/accounts", credentialVault: "file", task: "task" })
    // The address and key are looked up when the command starts, never parsed from arguments.
    expect(parsed.provider).toBeUndefined()
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--connection", "work", "--provider-model", "router/model", "task"])).toMatchObject({ connection: { id: "work", model: "router/model" } })
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--connection", "work", "--model", "m", "task"]).connection).toEqual({ id: "work", model: "m" })

    const base = ["run", "--cwd", "/tmp/project", "--connection", "work", "--model", "m"]
    for (const extra of [["--provider", "openai"], ["--provider-credential-env", "OPENAI_API_KEY"], ["--provider-endpoint", "https://relay.example.test/v1"], ["--provider-allow-remote"], ["--provider-allow-insecure-remote"], ["--provider-protocol", "chat"]])
      expect(() => parseCliArgs([...base, ...extra, "task"])).toThrow("--connection cannot be combined with --provider options")
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--connection", "work", "task"])).toThrow("--model is required with --connection")
    expect(() => parseCliArgs([...base, "--provider-model", "other", "task"])).toThrow("--model and --provider-model must match")
    expect(() => parseCliArgs([...base, "--backend", "codex", "task"])).toThrow("--connection requires the native backend")
    for (const id of ["../escape", "9lives", "has space", "", "x".repeat(257)]) expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--connection", id, "--model", "m", "task"])).toThrow()
    expect(() => parseCliArgs([...base, "--credential-vault", "plaintext", "task"])).toThrow("invalid credential vault")
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--accounts-dir", "/tmp/accounts", "task"])).toThrow("--accounts-dir requires the control command, --connection, or --tool-connection")
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--credential-vault", "file", "task"])).toThrow("--credential-vault requires the control command, --connection, or --tool-connection")
    // A tool backend runs as a tool connection; the provider and replay backends have none.
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "claude-code", "--tool-connection", "claude-code-1", "--accounts-dir", "/tmp/accounts", "task"])).toMatchObject({ backend: "claude-code", toolConnection: "claude-code-1", accountsDir: "/tmp/accounts" })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--tool-connection", "claude-code-1", "task"])).toThrow("--tool-connection requires a coding-tool backend")
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "codex", "--tool-connection", "-bad", "task"])).toThrow("tool connection id is invalid")
  })
  test("takes a preset id as a provider and still refuses a name nobody knows", () => {
    for (const provider of ["openrouter", "deepseek", "custom-openai-chat"])
      expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--provider", provider, "--provider-model", "m", "--provider-credential-env", "RELAY_API_KEY", "--provider-endpoint", "http://127.0.0.1:1", "task"])).toMatchObject({ backend: "native", provider: { provider, model: "m", credential: { kind: "environment", environment: "RELAY_API_KEY" } } })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--provider", "example-cloud", "--provider-model", "m", "task"])).toThrow("invalid provider")
    expect(() => parseCliArgs(["models", "--discover", "--provider", "example-cloud"])).toThrow("invalid provider")
  })
  test("preserves the native behavior config path", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "native", "--config", "/tmp/project/config.json", "task"])).toMatchObject({ behaviorConfigPath: "/tmp/project/config.json" })
  })
  test("a control session may continue another session's transcript, named by directory and id together", () => {
    const base = ["control", "--cwd", "/tmp/project", "--transcript-dir", "/tmp/child", "--session-id", "child"]
    expect(parseCliArgs([...base, "--continue-from-dir", "/tmp/parent", "--continue-from-session", "parent"])).toMatchObject({ continueFrom: { transcriptDir: "/tmp/parent", sessionId: "parent" } })
    expect(() => parseCliArgs([...base, "--continue-from-dir", "/tmp/parent"])).toThrow("go together")
    expect(() => parseCliArgs(["control", "--cwd", "/tmp/project", "--session-id", "child", "--continue-from-dir", "/tmp/parent", "--continue-from-session", "parent"])).toThrow("requires --transcript-dir")
    expect(() => parseCliArgs([...base, "--continue-from-dir", "/tmp/parent", "--continue-from-session", "child"])).toThrow("cannot continue itself")
  })
  test("accepts opt-in caller-owned transcript storage only for control", () => {
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--transcript-dir", "/tmp/transcripts"])).toMatchObject({ command: "control", transcriptDir: "/tmp/transcripts" })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--transcript-dir", "/tmp/transcripts"])).toThrow()
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--worktree-root", "/tmp/worktrees"])).toMatchObject({ command: "control", worktreeRoot: "/tmp/worktrees" })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--worktree-root", "/tmp/worktrees"])).toThrow("--worktree-root requires the control command")
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--threads-dir", "/tmp/threads"])).toMatchObject({ command: "control", threadsDir: "/tmp/threads" })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--threads-dir", "/tmp/threads", "task"])).toThrow("--threads-dir requires the control command")
  })

  test("checking after each turn is a switch for the interactive commands, off unless asked", () => {
    for (const command of ["control", "console", "serve"]) {
      expect(parseCliArgs([command, "--cwd", "/tmp/project", "--verify-after-turn"])).toMatchObject({ command, verifyAfterTurn: true })
      expect(parseCliArgs([command, "--cwd", "/tmp/project"])).not.toHaveProperty("verifyAfterTurn")
    }
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--verify-after-turn", "task"])).toThrow("--verify-after-turn requires the control, console, or serve command")
  })

  test("Nifra is left to the project unless --no-nifra turns it off", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "task"])).not.toHaveProperty("nifra")
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--no-nifra", "task"])).toMatchObject({ nifra: false })
    expect(parseCliArgs(["run", "--backend", "pi", "--cwd", "/tmp/project", "task"]).piOptions).not.toHaveProperty("enableNifraTools")
    expect(parseCliArgs(["run", "--backend", "pi", "--cwd", "/tmp/project", "--no-pi-nifra-tools", "task"]).piOptions).toMatchObject({ enableNifraTools: false })
  })

  test("per-turn checkpoints are a control switch, off unless asked", () => {
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--checkpoints"])).toMatchObject({ command: "control", checkpoints: true })
    expect(parseCliArgs(["control", "--cwd", "/tmp/project"])).not.toHaveProperty("checkpoints")
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--checkpoints", "task"])).toThrow("--checkpoints requires the control command")
  })

  test("browser tools are a control switch, and browser-mcp takes only its endpoint file", () => {
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--browser-tools"])).toMatchObject({ command: "control", browserTools: true })
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--browser-tools", "--browser-any-site"])).toMatchObject({ browserTools: true, browserAnySite: true })
    expect(parseCliArgs(["control", "--cwd", "/tmp/project"])).not.toHaveProperty("browserTools")
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--browser-tools", "task"])).toThrow("--browser-tools requires the control command")
    expect(() => parseCliArgs(["control", "--cwd", "/tmp/project", "--browser-any-site"])).toThrow("--browser-any-site requires --browser-tools")
    expect(parseCliArgs(["browser-mcp", "--endpoint-file", "/tmp/runrail-browser-x/endpoint.json"])).toMatchObject({ command: "browser-mcp", browserEndpointFile: "/tmp/runrail-browser-x/endpoint.json" })
    expect(() => parseCliArgs(["browser-mcp"])).toThrow("browser-mcp accepts only --endpoint-file <path>")
    expect(() => parseCliArgs(["browser-mcp", "--endpoint-file", "/tmp/a", "--cwd", "/"])).toThrow("browser-mcp accepts only --endpoint-file <path>")
  })
  test("computer tools are a control switch, and computer-mcp takes only its endpoint file", () => {
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--computer-tools"])).toMatchObject({ command: "control", computerTools: true })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--computer-tools", "task"])).toThrow("--computer-tools requires the control command")
    expect(parseCliArgs(["computer-mcp", "--endpoint-file", "/tmp/runrail-computer-x/endpoint.json"])).toMatchObject({ command: "computer-mcp", browserEndpointFile: "/tmp/runrail-computer-x/endpoint.json" })
    expect(() => parseCliArgs(["computer-mcp"])).toThrow("computer-mcp accepts only --endpoint-file <path>")
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--image-tools"])).toMatchObject({ command: "control", imageTools: true })
    expect(() => parseCliArgs(["run", "--cwd", "/tmp/project", "--image-tools", "task"])).toThrow("--image-tools requires the control command")
    expect(parseCliArgs(["images-mcp", "--endpoint-file", "/tmp/runrail-images-x/endpoint.json"])).toMatchObject({ command: "images-mcp", browserEndpointFile: "/tmp/runrail-images-x/endpoint.json" })
  })
  test("parses auth doctor, and refuses what it cannot take", () => {
    expect(parseCliArgs(["auth", "doctor", "signin-xai"])).toMatchObject({ command: "auth", doctor: { connectionId: "signin-xai", json: false } })
    expect(parseCliArgs(["auth", "doctor", "conn-1", "--json", "--accounts-dir", "/tmp/accounts", "--credential-vault", "file"])).toMatchObject({ command: "auth", json: true, accountsDir: "/tmp/accounts", credentialVault: "file", doctor: { connectionId: "conn-1", json: true } })
    for (const argv of [["auth"], ["auth", "doctor"], ["auth", "status", "conn-1"], ["auth", "doctor", "a", "b"], ["auth", "doctor", "-rf"], ["auth", "doctor", "two words"], ["auth", "doctor", "conn-1", "--model", "x"], ["auth", "doctor", "conn-1", "--credential-vault"]]) {
      expect(() => parseCliArgs(argv)).toThrow()
    }
  })

  test("parses login and logout, and refuses what they cannot take", () => {
    expect(parseCliArgs(["login", "chatgpt"])).toMatchObject({ command: "login", signIn: { action: "login", target: "chatgpt", acceptUnofficial: false, json: false }, openBrowser: true })
    expect(parseCliArgs(["login", "xai", "--accept-unofficial", "--no-browser", "--json", "--connection", "grok-work", "--label", "Grok (work)", "--accounts-dir", "/tmp/accounts", "--credential-vault", "file"])).toMatchObject({
      command: "login",
      json: true,
      accountsDir: "/tmp/accounts",
      credentialVault: "file",
      openBrowser: false,
      signIn: { action: "login", target: "xai", acceptUnofficial: true, connectionId: "grok-work", label: "Grok (work)", json: true },
    })
    expect(parseCliArgs(["login", "--list", "--json"]).signIn).toEqual({ action: "list", json: true })
    expect(parseCliArgs(["logout", "signin-xai"])).toMatchObject({ command: "logout", signIn: { action: "logout", connectionId: "signin-xai", json: false } })
    const refused: readonly (readonly string[])[] = [
      ["login"],
      ["login", "chatgpt", "openrouter"],
      ["login", "--list", "chatgpt"],
      ["login", "--list", "--accept-unofficial"],
      ["login", "Chat GPT"],
      ["login", "chatgpt", "--connection", "-rf"],
      ["login", "chatgpt", "--connection"],
      ["login", "chatgpt", "--label", ""],
      ["login", "chatgpt", "--credential-vault", "somewhere"],
      ["login", "chatgpt", "--token", "abc"],
      ["logout"],
      ["logout", "a", "b"],
      ["logout", "signin-xai", "--accept-unofficial"],
      ["logout", "signin-xai", "--list"],
      ["logout", "../etc"],
    ]
    for (const args of refused) expect(() => parseCliArgs(args)).toThrow()
  })
})

test("eval: list, and run a suite against setups with no desktop", () => {
  expect(parseCliArgs(["eval", "list", "--cwd", "/tmp", "--json"])).toMatchObject({ command: "eval", cwd: "/tmp", json: true, evalCli: { action: "list" } })
  expect(parseCliArgs(["eval", "run", "--suite", "smoke", "--setup", "duo", "--setup", "solo", "--case", "abc", "--repeats", "2", "--parallel", "3", "--max-minutes", "30", "--harness-auth", "environment", "--harness-credential-env", "ANTHROPIC_API_KEY"])).toMatchObject({
    command: "eval",
    harnessAuth: { mode: "environment", credentialEnvironment: ["ANTHROPIC_API_KEY"] },
    evalCli: { action: "run", suite: "smoke", setupIds: ["duo", "solo"], cases: ["abc"], repeats: 2, parallel: 3, maxMinutes: 30 },
  })
  for (const argv of [["eval"], ["eval", "run", "--suite", "smoke"], ["eval", "run", "--setup", "duo"], ["eval", "run", "--suite", "s", "--setup", "d", "--parallel", "9"], ["eval", "list", "--suite", "s"], ["eval", "run", "--suite", "s", "--setup", "d", "--harness-auth", "environment"]])
    expect(() => parseCliArgs(argv)).toThrow()
})
