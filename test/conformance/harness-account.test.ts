import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"
import {
  createClaudeCodeHarness,
  createCodexHarness,
  createDefaultBackendRegistry,
  harnessAccountEnvironment,
  harnessLoginCommand,
  harnessLogoutCommand,
  isRouteEnvironment,
  parseHarnessAccountOptions,
  parseHarnessAuthOptions,
  probeHarness,
  runHarnessLogout,
} from "../../src/index.ts"
import { createVendorShims, type VendorShims } from "../fixtures/vendor-shim.ts"

const ACP_FIXTURE = new URL("../fixtures/acp-agent.ts", import.meta.url).pathname
const CODEX_FIXTURE = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname

let shims: VendorShims
let home: string
const command: Record<string, string> = {}

beforeAll(async () => {
  shims = await createVendorShims()
  home = await mkdtemp(join(tmpdir(), "runrail-tool-home-"))
  command.claudeAccount = await shims.add("claude-account", ["claude", "account"])
  command.claudeRefused = await shims.add("claude-refused", ["claude", "key-refused"])
  command.claudeQuota = await shims.add("claude-quota", ["claude", "weekly-quota"])
  command.codexQuota = await shims.add("codex-quota", ["codex", "weekly-quota"])
  command.codexEcho = await shims.add("codex-echo", ["echo"], CODEX_FIXTURE)
  command.geminiEcho = await shims.add("gemini-echo", ["echo"], ACP_FIXTURE)
  command.geminiRefused = await shims.add("gemini-refused", ["auth-refused"], ACP_FIXTURE)
  command.geminiPromptRefused = await shims.add("gemini-prompt-refused", ["prompt-key-refused"], ACP_FIXTURE)
  command.codexRefused = await shims.add("codex-refused", ["key-refused"], CODEX_FIXTURE)
})

afterAll(async () => {
  await shims.remove()
  await rm(home, { recursive: true, force: true })
})

async function turn(backend: AgentBackend, sessionId: string): Promise<AgentEvent[]> {
  const session = await backend.createSession({ cwd: "/tmp", sessionId })
  const events: AgentEvent[] = []
  try {
    for await (const event of backend.send({ sessionId: session.id, message: "hello" })) events.push(event)
  } finally {
    await backend.close?.(session.id)
  }
  return events
}

function answer(events: readonly AgentEvent[]): Record<string, unknown> {
  const message = events.find((event) => event.type === "assistant.message")
  if (message?.type !== "assistant.message") throw new Error(`no answer: ${JSON.stringify(events.at(-1))}`)
  return JSON.parse(message.text) as Record<string, unknown>
}

const key = async (): Promise<string> => "sk-fixture-key"

describe("a connection's account", () => {
  test("is a folder and a key reader, and each tool's folder has its own variable", () => {
    expect(parseHarnessAccountOptions(undefined)).toBeUndefined()
    for (const bad of [null, { configDir: "relative" }, { configDir: "/tmp/x", other: 1 }, { apiKey: "sk-plain" }]) expect(() => parseHarnessAccountOptions(bad)).toThrow()
    expect([harnessAccountEnvironment("claude-code", { configDir: "/a" }), harnessAccountEnvironment("codex", { configDir: "/b" }), harnessAccountEnvironment("gemini", { configDir: "/c" }), harnessAccountEnvironment("copilot", undefined)])
      .toEqual([{ CLAUDE_CONFIG_DIR: "/a" }, { CODEX_HOME: "/b" }, { GEMINI_CLI_HOME: "/c" }, {}])
    expect(() => harnessAccountEnvironment("copilot", { configDir: "/d" })).toThrow("HARNESS_ACCOUNT_UNSUPPORTED")
    // A route variable is never a credential.
    expect([isRouteEnvironment({ CODEX_HOME: "/b" }), isRouteEnvironment({ ANTHROPIC_API_KEY: "sk" }), isRouteEnvironment({ GH_TOKEN: "t" }), isRouteEnvironment({ lower: "x" })]).toEqual([true, false, false, false])
    expect([harnessLoginCommand("claude-code", "/a"), harnessLoginCommand("codex"), harnessLoginCommand("copilot"), harnessLogoutCommand("codex", "/b")]).toEqual([
      { command: "claude", args: ["auth", "login", "--claudeai"], env: { CLAUDE_CONFIG_DIR: "/a" } },
      { command: "codex", args: ["login", "--device-auth"], env: {} },
      undefined,
      { command: "codex", args: ["logout"], env: { CODEX_HOME: "/b" } },
    ])
  })

  test("Claude Code's print route gets the folder and the key as its two variables", async () => {
    const backend = createClaudeCodeHarness({
      command: command.claudeAccount!,
      routeEnv: { CLAUDE_CONFIG_DIR: home },
      auth: parseHarnessAuthOptions({ mode: "caller", credentialEnvironment: ["ANTHROPIC_API_KEY"], credentialResolver: async () => ({ ANTHROPIC_API_KEY: "sk-fixture-key" }) }),
    })
    expect(answer(await turn(backend, "claude-print-account")).account).toEqual({ CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "sk-fixture-key" })
    expect(() => createClaudeCodeHarness({ command: command.claudeAccount!, routeEnv: { ANTHROPIC_API_KEY: "sk" } })).toThrow("route environment")
  })

  test("a refused key fails Claude Code's print turn at the first retry", async () => {
    const started = Date.now()
    const failure = await turn(createClaudeCodeHarness({ command: command.claudeRefused! }), "claude-print-refused").then(() => undefined, (error: { code?: string }) => error.code)
    expect([failure, Date.now() - started < 10_000]).toEqual(["COMMAND_AGENT_AUTH_FAILED", true])
  }, 20_000)

  test.each(["claude", "codex"])("a weekly quota ends the %s one-shot process promptly", async (vendor) => {
    const backend = vendor === "claude"
      ? createClaudeCodeHarness({ command: command.claudeQuota! })
      : createCodexHarness({ command: command.codexQuota! })
    const started = Date.now()
    const failure = await turn(backend, `${vendor}-quota`).then(() => undefined, (error: Error & { code?: string }) => error)
    expect(failure?.code).toBe("COMMAND_AGENT_RATE_LIMITED")
    expect(failure?.message).toContain("weekly usage limit reached")
    expect(failure?.message).not.toContain("sk-fixture")
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)

  test("Codex signs in with the key on stdin and keeps it in memory, in the connection's folder", async () => {
    const adapter = createDefaultBackendRegistry().select({ preferred: "codex", requiredCapabilities: [] })
    const backend = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: command.codexEcho, harnessProtocol: "app-server", harnessAccount: { configDir: home, apiKey: key } } })
    const seen = answer(await turn(backend, "codex-account"))
    expect([seen.login, seen.started]).toEqual([
      { type: "apiKey", apiKey: "sk-fixture-key" },
      { args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="ephemeral"'], CODEX_HOME: home, CODEX_API_KEY: null },
    ])

    const unreadable = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: command.codexEcho, harnessProtocol: "app-server", harnessAccount: { configDir: home, apiKey: async () => { throw new Error("vault locked") } } } })
    await expect(turn(unreadable, "codex-no-key")).rejects.toMatchObject({ code: "COMMAND_AGENT_CREDENTIALS_UNAVAILABLE" })
  })

  test("a key Codex's provider refuses ends the turn at its first retry", async () => {
    const adapter = createDefaultBackendRegistry().select({ preferred: "codex", requiredCapabilities: [] })
    const backend = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: command.codexRefused, harnessProtocol: "app-server", harnessAccount: { configDir: home, apiKey: key } } })
    const started = Date.now()
    const events = await turn(backend, "codex-refused")
    expect([events.at(-1), Date.now() - started < 5_000]).toEqual([expect.objectContaining({ type: "session.failed", error: expect.objectContaining({ code: "COMMAND_AGENT_AUTH_FAILED" }) }), true])
  })

  test("Gemini CLI gets its own home and the key through its authenticate request", async () => {
    const adapter = createDefaultBackendRegistry().select({ preferred: "gemini", requiredCapabilities: [] })
    const backend = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: command.geminiEcho, harnessAccount: { configDir: home, apiKey: key } } })
    const seen = answer(await turn(backend, "gemini-account"))
    expect([seen.authenticated, (seen.env as Record<string, unknown>).GEMINI_CLI_HOME, (seen.env as Record<string, unknown>).GEMINI_API_KEY]).toEqual([{ methodId: "gemini-api-key", meta: { "api-key": "sk-fixture-key" } }, home, null])

    // Gemini's own refusal can repeat the key; it is not passed on.
    const refused = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: command.geminiRefused, harnessAccount: { configDir: home, apiKey: key } } })
    const failure = await turn(refused, "gemini-refused").then(() => undefined, (error: Error & { code?: string }) => error)
    expect([failure?.code, failure?.message.includes("sk-fixture")]).toEqual(["COMMAND_AGENT_AUTH_FAILED", false])
    // Gemini takes any key at sign-in; the provider refuses it on the first prompt.
    const promptRefused = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: command.geminiPromptRefused, harnessAccount: { configDir: home, apiKey: key } } })
    expect((await turn(promptRefused, "gemini-prompt-refused")).at(-1)).toMatchObject({ type: "session.failed", error: { code: "COMMAND_AGENT_AUTH_FAILED" } })
    // A key with Gemini's usual home would rewrite the user's settings.
    await expect((async () => adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: command.geminiEcho, harnessAccount: { apiKey: key } } }))()).rejects.toThrow("home of its own")
  })

  test("tools without a folder or key of their own refuse one", async () => {
    const registry = createDefaultBackendRegistry()
    for (const name of ["copilot", "opencode", "goose", "pi"]) {
      const adapter = registry.select({ preferred: name, requiredCapabilities: [] })
      await expect((async () => adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessAccount: { configDir: home } } }))()).rejects.toThrow("HARNESS_ACCOUNT_UNSUPPORTED")
    }
  })

  test("a probe and a sign-out see the connection's folder, not the usual one", async () => {
    const commands = { "claude-code": { command: command.claudeAccount! } }
    const routeEnv = { CLAUDE_CONFIG_DIR: home }
    expect((await probeHarness("claude-code", { commands })).signedIn).toBe(false)
    await writeFile(join(home, "fixture-signed-in"), "")
    expect((await probeHarness("claude-code", { commands, routeEnv })).signedIn).toBe(true)
    expect(await runHarnessLogout("claude-code", home, { command: { command: command.claudeAccount! } })).toBe(true)
    expect((await probeHarness("claude-code", { commands, routeEnv })).signedIn).toBe(false)
    await expect(probeHarness("claude-code", { commands, routeEnv: { ANTHROPIC_API_KEY: "sk" } })).rejects.toThrow("route environment")
    await expect(runHarnessLogout("copilot", undefined)).rejects.toThrow("HARNESS_ACCOUNT_UNSUPPORTED")
  })
})
