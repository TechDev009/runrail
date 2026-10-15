import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { registerClaudeAgentSdkLoader, type ClaudeAgentSdk, type ClaudeSdkQuery, type ClaudeSdkQueryOptions } from "../../src/backend/claude-agent-sdk.ts"
import { claudePlanLimits, claudeUsageLimits } from "../../src/harness/plan-limits.ts"
import { claudeUsageReader, codexUsageReader, UsageReader, UsageReadError, type ToolUsageRead } from "../../src/harness/usage-read.ts"
import type { RunrailPlanLimitsFrame } from "../../src/live/types.ts"

const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp("/tmp/runrail-usage-read-")
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const usage = (rateLimits: Record<string, unknown>) => ({ rate_limits_available: true, subscription_type: "max", rate_limits: rateLimits })
const scoped = (display_name: unknown, utilization: unknown = 12) => ({ display_name, utilization, resets_at: "2026-10-08T10:00:00Z", extra: "dropped" })

describe("extra usage", () => {
  test("a reading says whether extra usage can serve requests past a used-up window, only when the tool says", () => {
    const weekly = { seven_day: { utilization: 100, resets_at: "2026-10-12T02:00:00Z" } }
    expect(claudeUsageLimits(usage({ ...weekly, extra_usage: { is_enabled: false, monthly_limit: 5_000, used_credits: 5_000, currency: "USD" } }))).toEqual({ type: "plan.limits", source: "claude-code", plan: "max", windows: [{ id: "weekly", usedPercent: 100, resetsAt: Date.parse("2026-10-12T02:00:00Z") }], extraUsage: false })
    expect(claudeUsageLimits(usage({ ...weekly, extra_usage: { is_enabled: true } }))?.extraUsage).toBe(true)
    expect(claudeUsageLimits(usage({ ...weekly, extra_usage: null }))?.extraUsage).toBe(false)
    expect(claudeUsageLimits(usage(weekly))).not.toHaveProperty("extraUsage")
    expect(claudeUsageLimits(usage({ ...weekly, extra_usage: { is_enabled: "yes" } }))).not.toHaveProperty("extraUsage")

    const event = (fields: Record<string, unknown>) => claudePlanLimits({ status: "rejected", rateLimitType: "seven_day", resetsAt: 1_791_000_000, ...fields })
    expect(event({ overageStatus: "rejected" })?.extraUsage).toBe(false)
    expect(event({ overageStatus: "allowed_warning" })?.extraUsage).toBe(true)
    expect(event({ isUsingOverage: true })?.extraUsage).toBe(true)
    expect(event({})).not.toHaveProperty("extraUsage")
  })
})

describe("per-model weekly windows", () => {
  test("structured session and weekly limits work without legacy five_hour fields", () => {
    const limits = claudeUsageLimits(usage({ limits: [
      { kind: "weekly_all", percent: 23, resets_at: "2026-10-18T10:00:00Z" },
      { kind: "session", percent: 42, resets_at: null, is_active: false },
      { kind: "weekly_scoped", percent: 64, scope: { model: "Sonnet", surface: "code" }, resets_at: "2026-10-18T10:00:00Z" },
    ] }))
    expect(limits?.windows).toEqual([
      { id: "five-hour", usedPercent: 42 },
      { id: "weekly", usedPercent: 23, resetsAt: Date.parse("2026-10-18T10:00:00Z") },
      { id: "weekly-model", model: "Sonnet", usedPercent: 64, resetsAt: Date.parse("2026-10-18T10:00:00Z") },
    ])
  })

  test("structured limits override legacy values and preserve public model names without duplicates", () => {
    const limits = claudeUsageLimits(usage({ five_hour: { utilization: 95, resets_at: "2026-10-10T10:00:00Z" }, model_scoped: [scoped("Sonnet", 4)], limits: [
      { kind: "session", percent: 0, resets_at: null },
      { kind: "weekly_scoped", percent: 60, scope: { model: "sonnet" } },
    ] }))
    expect(limits?.windows).toEqual([{ id: "five-hour", usedPercent: 0 }, { id: "weekly-model", model: "Sonnet", usedPercent: 60 }])
  })

  test("invalid and unknown structured rows are dropped and scoped models stay bounded", () => {
    expect(claudeUsageLimits(usage({ limits: [{ kind: "session", percent: "42" }, { kind: "session", percent: Number.NaN }, { kind: "unknown", percent: 30 }, { kind: "weekly_scoped", percent: 30, scope: { model: "bad\u0007" } }] }))).toBeUndefined()
    const limits = claudeUsageLimits(usage({ limits: [{ kind: "session", percent: 120, resets_at: "invalid" }, ...Array.from({ length: 12 }, (_, index) => ({ kind: "weekly_scoped", percent: 20, scope: { model: `Model ${String(index)}` } }))] }))
    expect(limits?.windows[0]).toEqual({ id: "five-hour", usedPercent: 100 })
    expect(limits?.windows.filter((window) => window.id === "weekly-model")).toHaveLength(8)
  })
  test("model_scoped entries become weekly-model windows with their model's name", () => {
    const limits = claudeUsageLimits(usage({ five_hour: { utilization: 40, resets_at: "2026-10-04T18:00:00Z" }, model_scoped: [scoped("Fable", 63.4), scoped("Opus", null)] }))
    expect(limits?.windows).toEqual([
      { id: "five-hour", usedPercent: 40, resetsAt: Date.parse("2026-10-04T18:00:00Z") },
      { id: "weekly-model", model: "Fable", usedPercent: 63.4, resetsAt: Date.parse("2026-10-08T10:00:00Z") },
    ])
  })

  test("a long, empty, or control-character name is refused, the ninth is dropped, and a non-array is ignored", () => {
    const names = ["x".repeat(41), "", "Bad\u0007", 7, ...Array.from({ length: 9 }, (_, index) => `Model ${String(index + 1)}`)]
    const limits = claudeUsageLimits(usage({ model_scoped: names.map((name) => scoped(name)) }))
    expect(limits?.windows.map((window) => window.model)).toEqual(Array.from({ length: 8 }, (_, index) => `Model ${String(index + 1)}`))
    expect(claudeUsageLimits(usage({ five_hour: { utilization: 1 }, model_scoped: { Fable: 3 } }))?.windows).toEqual([{ id: "five-hour", usedPercent: 1 }])
  })
})

/** A stand-in SDK whose idle session answers the usage question, recording what it was started with. */
function fakeSdk(answer: unknown, seen: ClaudeSdkQueryOptions[], closed: string[]): ClaudeAgentSdk {
  return {
    query: ({ options }) => {
      seen.push(options)
      const query: ClaudeSdkQuery = {
        [Symbol.asyncIterator]: async function* () {
          // An idle session says nothing until it is closed.
        },
        interrupt: async () => ({}),
        setModel: async () => undefined,
        stopTask: async () => undefined,
        close: () => {
          closed.push("closed")
        },
        readPlanUsage: async () => answer,
      }
      return query
    },
  }
}

describe("reading a tool's usage with no thread running", () => {
  test("Claude Code is started with none of the person's settings, no MCP servers, and no saved conversation", async () => {
    const cwd = await tempDir()
    const seen: ClaudeSdkQueryOptions[] = []
    const closed: string[] = []
    const read = claudeUsageReader({ sdk: fakeSdk(usage({ seven_day: { utilization: 20 }, model_scoped: [scoped("Fable", 5)] }), seen, closed), command: process.execPath })
    const limits = await read({ cwd, configDir: join(cwd, "account") })
    expect(limits).toEqual({ type: "plan.limits", source: "claude-code", plan: "max", windows: [{ id: "weekly", usedPercent: 20 }, { id: "weekly-model", model: "Fable", usedPercent: 5, resetsAt: Date.parse("2026-10-08T10:00:00Z") }] })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ cwd, settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false })
    expect(seen[0]?.env.CLAUDE_CONFIG_DIR).toBe(join(cwd, "account"))
    expect(Object.keys(seen[0]?.env ?? {}).every((name) => ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "CI", "CLAUDE_CONFIG_DIR", "CLAUDE_AGENT_SDK_CLIENT_APP"].includes(name))).toBe(true)
    expect(closed).toEqual(["closed"])
    expect(await readdir(cwd)).toEqual([])
  })

  test("Claude Code without a plan, or not installed, says so", async () => {
    const cwd = await tempDir()
    const none = claudeUsageReader({ sdk: fakeSdk({ rate_limits_available: false }, [], []), command: process.execPath })
    await expect(none({ cwd })).rejects.toMatchObject({ code: "USAGE_UNAVAILABLE" })
    const missing = claudeUsageReader({ sdk: fakeSdk({}, [], []), command: "/nonexistent/claude" })
    await expect(missing({ cwd })).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" })
  })

  test("with Claude Code not installed, the SDK is never loaded, so a desktop build never downloads it", async () => {
    let loads = 0
    registerClaudeAgentSdkLoader(async () => {
      loads += 1
      return undefined
    })
    cleanup.push(async () => registerClaudeAgentSdkLoader(undefined))
    const read = claudeUsageReader({ command: "/nonexistent/claude" })
    await expect(read({ cwd: await tempDir() })).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE", message: "Claude Code is not installed" })
    expect(loads).toBe(0)
  })

  test("Codex returns the CLI sign-in separately from the quota fields", async () => {
    const cwd = await tempDir()
    const reading = await codexUsageReader({ command: process.execPath, args: [fixture, "limits"] })({ cwd })
    const { account, ...limits } = reading ?? {}
    expect(account).toEqual({ label: "fixture@example.invalid" })
    expect(limits).toEqual({ type: "plan.limits", source: "codex", plan: "pro", windows: [{ id: "five-hour", usedPercent: 24, resetsAt: 1_790_000_000_000, windowMinutes: 300 }, { id: "weekly", usedPercent: 7, resetsAt: 1_790_400_000_000, windowMinutes: 10_080 }] })
    expect(JSON.stringify(limits)).not.toContain("fixture-account")
    expect(JSON.stringify(limits)).not.toContain("12.50")
    await expect(codexUsageReader({ command: process.execPath, args: [fixture, "normal"] })({ cwd })).rejects.toMatchObject({ code: "USAGE_UNAVAILABLE" })
    await expect(codexUsageReader({ command: "/nonexistent/codex" })({ cwd })).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" })
  })

  test("a Codex that exits after initialize fails the read at once instead of after the timeout", async () => {
    const cwd = await tempDir()
    const answerThenExit = `for await (const line of console) { process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, result: {} }) + "\\n"); process.exit(0) }`
    const started = Date.now()
    await expect(codexUsageReader({ command: process.execPath, args: ["-e", answerThenExit], timeoutMs: 10_000 })({ cwd })).rejects.toMatchObject({ code: "USAGE_UNAVAILABLE" })
    expect(Date.now() - started).toBeLessThan(5_000)
  })
  test("signed-out and API-key accounts cannot return a subscription quota", async () => {
    const cwd = await tempDir()
    for (const account of [null, { type: "apiKey" }, { type: "unexpected" }]) {
      const script = `for await (const line of console) { const request = JSON.parse(line); if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: request.method === "account/read" ? { account: ${JSON.stringify(account)} } : {} }) + "\\n") }`
      await expect(codexUsageReader({ command: process.execPath, args: ["-e", script] })({ cwd })).rejects.toMatchObject({ code: "USAGE_UNAVAILABLE" })
    }
  })
})

describe("one reading at a time", () => {
  test("explicit refresh and reset windows bypass the minute cache", async () => {
    let calls = 0
    let now = 100
    const read: ToolUsageRead = async () => ({ type: "plan.limits", source: "claude-code", windows: [{ id: "five-hour", usedPercent: ++calls, resetsAt: 200 }] })
    const reader = new UsageReader({ "claude-code": read, codex: read }, () => now)
    const account = { cwd: "/tmp/usage" }
    await reader.read("usual", "claude-code", account)
    await reader.read("usual", "claude-code", account)
    expect(calls).toBe(1)
    await reader.read("usual", "claude-code", account, true)
    expect(calls).toBe(2)
    now = 201
    await reader.read("usual", "claude-code", account)
    expect(calls).toBe(3)
  })
  const plan: RunrailPlanLimitsFrame = { type: "plan.limits", source: "codex", windows: [{ id: "weekly", usedPercent: 1 }] }

  test("concurrent reads coalesce, Codex rechecks sign-in, and tools never run at once", async () => {
    let clock = 0
    let running = 0
    let most = 0
    const calls: string[] = []
    const slow = (name: string): ToolUsageRead => async (account) => {
      calls.push(`${name}:${account.configDir ?? "usual"}`)
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running -= 1
      return plan
    }
    const reader = new UsageReader({ "claude-code": slow("claude"), codex: slow("codex") }, () => clock)
    const [first, second, other] = await Promise.all([
      reader.read("codex:usual", "codex", { cwd: "/tmp" }),
      reader.read("codex:usual", "codex", { cwd: "/tmp" }),
      reader.read("claude-code:/a", "claude-code", { cwd: "/tmp", configDir: "/a" }),
    ])
    expect(first).toBe(plan)
    expect(second).toBe(plan)
    expect(other).toBe(plan)
    expect(calls).toEqual(["codex:usual", "claude:/a"])
    expect(most).toBe(1)
    clock = 59_000
    await reader.read("codex:usual", "codex", { cwd: "/tmp" })
    expect(calls).toHaveLength(3)
    clock = 61_000
    await reader.read("codex:usual", "codex", { cwd: "/tmp" })
    expect(calls).toHaveLength(4)
  })

  test("a failed read is not kept, and the next account still runs", async () => {
    let fail = true
    const reader = new UsageReader({
      "claude-code": async () => {
        if (fail) throw new UsageReadError("USAGE_UNAVAILABLE", "signed out")
        return plan
      },
      codex: async () => plan,
    })
    await expect(reader.read("claude-code:usual", "claude-code", { cwd: "/tmp" })).rejects.toMatchObject({ code: "USAGE_UNAVAILABLE" })
    expect(await reader.read("codex:usual", "codex", { cwd: "/tmp" })).toBe(plan)
    fail = false
    expect(await reader.read("claude-code:usual", "claude-code", { cwd: "/tmp" })).toBe(plan)
  })
})
