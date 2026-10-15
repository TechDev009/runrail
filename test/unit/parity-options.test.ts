import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCliArgs } from "../../src/cli.ts"
import { createRunrailSession } from "../../src/session.ts"

describe("native parity CLI controls", () => {
  test("parses model, thinking, budgets, context, and verification", () => {
    const options = parseCliArgs([
      "run",
      "--cwd",
      "/tmp/project",
      "--model-command",
      "/tmp/model",
      "--model-command-arg",
      "--fixture",
      "--model-capability",
      "multimodal",
      "--requires-model-capability",
      "tools",
      "--verification-command",
      "/tmp/check",
      "--verification-timeout-ms",
      "3000",
      "--model",
      "strong-fixture",
      "--quality",
      "strong",
      "--thinking",
      "high",
      "--max-total-tokens",
      "4000",
      "--max-cost-usd",
      "1.25",
      "--context-file",
      "TEAM.md",
      "complete",
    ])
    expect(options).toMatchObject({
      command: "run",
      modelCommand: { command: "/tmp/model", args: ["--fixture"], capabilities: ["multimodal"] },
      verificationCommand: "/tmp/check",
      verificationTimeoutMs: 3000,
      modelSelection: { id: "strong-fixture", quality: "strong", thinking: "high", requiredCapabilities: ["tools"] },
      budget: { maxTotalTokens: 4000, maxCostUsd: 1.25 },
      context: { instructionFiles: ["TEAM.md"] },
      task: "complete",
    })
  })

  test("parses normalized skill and theme source paths", () => {
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--skill-path", ".claude/skills", "--theme-path", ".runrail/themes", "task"])) .toMatchObject({ context: { skillPaths: [".claude/skills"], themePaths: [".runrail/themes"] } })
  })

  test("rejects unsupported backend capabilities before execution", async () => {
    await expect(createRunrailSession({ cwd: "/tmp", backend: "native", requiredCapabilities: ["interactive"] })).rejects.toMatchObject({ code: "BACKEND_CAPABILITY_UNAVAILABLE" })
  })

  test("keeps Pi pass-through opaque and accepts the native console", () => {
    expect(parseCliArgs(["pi", "--model", "provider/model"])).toMatchObject({ command: "pi", piArgs: ["--model", "provider/model"] })
    expect(parseCliArgs(["console", "--cwd", "/tmp/project"])).toMatchObject({ command: "console", backend: "native" })
  })

  test("parses plugin lifecycle actions and explicit trust grants", () => {
    expect(parseCliArgs(["plugins", "--cwd", "/tmp/project", "test", "fixture", "--capability", "fixture.command", "--permission", "filesystem.read", "--json"])).toMatchObject({
      command: "plugins",
      plugin: { action: "test", id: "fixture", capabilities: ["fixture.command"], permissions: ["filesystem.read"] },
      json: true,
    })
    expect(() => parseCliArgs(["control", "--cwd", "/tmp/project", "--port", "0", "--token", "control-token-123456"])).toThrow("RUNRAIL_CONTROL_TOKEN or --token-file")
    expect(parseCliArgs(["control", "--cwd", "/tmp/project"], { RUNRAIL_CONTROL_TOKEN: "env-token-1234567890" })).toMatchObject({ authToken: "env-token-1234567890" })
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "task"], { RUNRAIL_CONTROL_TOKEN: "env-token-1234567890" }).authToken).toBeUndefined()
    const tokenDir = mkdtempSync(join(tmpdir(), "runrail-token-"))
    const tokenFile = join(tokenDir, "token")
    writeFileSync(tokenFile, "file-token-1234567890\n", { mode: 0o600 })
    expect(parseCliArgs(["control", "--cwd", "/tmp/project", "--token-file", tokenFile], {})).toMatchObject({ authToken: "file-token-1234567890" })
    chmodSync(tokenFile, 0o644)
    expect(() => parseCliArgs(["control", "--cwd", "/tmp/project", "--token-file", tokenFile], {})).toThrow("chmod 600")
    rmSync(tokenDir, { recursive: true, force: true })
    expect(parseCliArgs(["plugins", "configure", "fixture", "{\"enabled\":true}"])).toMatchObject({ command: "plugins", plugin: { action: "configure", id: "fixture", config: { enabled: true } } })
    expect(parseCliArgs(["plugins", "migrate-pi", "/tmp/pi-package", "--json"])).toMatchObject({ command: "plugins", plugin: { action: "migrate-pi", source: "/tmp/pi-package" }, json: true })
    expect(parseCliArgs(["run", "--cwd", "/tmp/project", "--backend", "pi", "--require-capability", "interactive", "--pi-env", "LANG=C", "--pi-max-event-queue", "128"])).toMatchObject({ requiredCapabilities: ["interactive"], piOptions: { env: { LANG: "C" }, maxEventQueueSize: 128 } })
  })
})
