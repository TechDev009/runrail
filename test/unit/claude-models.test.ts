import { afterEach, describe, expect, test } from "bun:test"
import { listClaudeCodeModels, parseClaudeCodeModels, withClaudeCatalog } from "../../src/harness/claude-models.ts"
import { probeHarness } from "../../src/harness/detect.ts"
import { filteredEnvironment } from "../../src/workspace/policy.ts"
import { createVendorShims, type VendorShims } from "../fixtures/vendor-shim.ts"

// The rows Claude Code 2.1.287 answered its `initialize` request with.
const ROWS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1[1m]", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "Sonnet 5.5 · Efficient for routine tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
]

const open: VendorShims[] = []
afterEach(async () => {
  for (const shims of open.splice(0)) await shims.remove()
})

async function claude(mode: string): Promise<string> {
  const shims = await createVendorShims()
  open.push(shims)
  return shims.add("claude", ["claude", mode])
}

describe("Claude Code's own model list", () => {
  test("names each alias by the version it runs, keeps the exact id, and marks the default", () => {
    expect(parseClaudeCodeModels(ROWS)).toEqual([
      { id: "opus", name: "Opus 5.5", resolved: "claude-opus-5-5", default: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "claude-fable-5-1[1m]", name: "Fable 5.1", resolved: "claude-fable-5-1[1m]", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "sonnet", name: "Sonnet 5.5", resolved: "claude-sonnet-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "haiku", name: "Haiku 4.5", resolved: "claude-haiku-4-5-20251001", reasoning: false },
    ])
  })

  test("refuses rows that are not model rows, and falls back to the display name", () => {
    expect(parseClaudeCodeModels("opus")).toBeUndefined()
    expect(parseClaudeCodeModels([{ value: "default", resolvedModel: "claude-opus-5-5" }])).toBeUndefined()
    const parsed = parseClaudeCodeModels([
      { value: "-rm", displayName: "Bad" },
      { value: "opus", resolvedModel: "not an id", displayName: "Opus", description: "Best \u0007 · x", supportedEffortLevels: ["low", "ultra-mega"] },
      { value: "opus", displayName: "Second opus" },
    ])
    expect(parsed).toEqual([{ id: "opus", name: "Opus", efforts: ["low"] }])
  })

  test("adds every other Claude version the catalog knows, once each, newest first", () => {
    const merged = withClaudeCatalog(parseClaudeCodeModels(ROWS)!, [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "claude-opus-5", name: "Claude Opus 5" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (latest)" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (latest)" },
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
      { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { id: "claude-3-5-haiku", name: "Claude Haiku 3.5" },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ])
    expect(merged.slice(4)).toEqual([
      { id: "claude-opus-5", name: "Opus 5", catalog: true },
      { id: "claude-opus-4-8", name: "Opus 4.8", catalog: true },
      { id: "claude-sonnet-4-5", name: "Sonnet 4.5", catalog: true },
    ])
  })

  test("asks the installed claude with no prompt and no settings, and reads only the models", async () => {
    const command = await claude("account")
    const models = await listClaudeCodeModels({ argv: [command], env: filteredEnvironment(), cwd: "/tmp", timeoutMs: 10_000 })
    expect(models?.map((model) => [model.id, model.name, model.resolved])).toEqual([
      ["opus", "Opus 5.5", "claude-opus-5-5"],
      ["haiku", "Haiku 4.5", "claude-haiku-4-5-20251001"],
    ])
    expect(JSON.stringify(models)).not.toContain("example.invalid")
  })

  test("a claude that does not answer in time leaves the fixed aliases, and is stopped", async () => {
    const command = await claude("models-silent")
    const started = Date.now()
    expect(await listClaudeCodeModels({ argv: [command], env: filteredEnvironment(), cwd: "/tmp", timeoutMs: 300 })).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
    const status = await probeHarness("claude-code", { commands: { "claude-code": { command } }, models: false })
    expect(status.models?.slice(0, 4).map((model) => model.id)).toEqual(["fable", "opus", "sonnet", "haiku"])
  })

  test("the probe lists Claude Code's own models first, then the catalog's", async () => {
    const full = await probeHarness("claude-code", { commands: { "claude-code": { command: await claude("account") } } })
    expect(full.models?.slice(0, 2).map((model) => model.name)).toEqual(["Opus 5.5", "Haiku 4.5"])
    expect(full.models?.slice(2).every((model) => model.catalog === true)).toBe(true)
    expect(full.models?.map((model) => model.id)).toContain("claude-opus-4-8")
  })
})
