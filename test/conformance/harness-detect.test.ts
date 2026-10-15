import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLAUDE_CODE_EFFORTS, COPILOT_EFFORTS, HarnessRegistry, createDefaultHarnessAdapters, probeHarness, startRunrailControlRpcServer, type HarnessProbeOptions } from "../../src/index.ts"
import { createVendorShims, type VendorShims } from "../fixtures/vendor-shim.ts"

// What the fixture prints about the account. A probe reads whether someone is signed in, never who.
const BAIT = ["never-read@example.invalid", "Bait Org", "bait-plan", "authMethod", "fixture\""]

const ACP_FIXTURE = new URL("../fixtures/acp-agent.ts", import.meta.url).pathname

let shims: VendorShims
const paths = new Map<string, string>()
let missing: string
// A probe reads the tool's settings from HOME; this one is empty, so your own proxy never shows up here.
let home: string
const realHome = process.env.HOME

function command(name: string): { readonly command: string } {
  const path = paths.get(name)
  if (path === undefined) throw new Error(`no shim named ${name}`)
  return { command: path }
}

function expectNoAccountDetails(value: unknown): void {
  const json = JSON.stringify(value)
  for (const bait of BAIT) expect(json).not.toContain(bait)
}

beforeAll(async () => {
  shims = await createVendorShims()
  for (const mode of ["normal", "signed-out", "status-unreadable"]) paths.set(`claude-${mode}`, await shims.add(`claude-${mode}`, ["claude", mode]))
  for (const mode of ["normal", "signed-out", "no-server", "no-server-signed-out"]) paths.set(`codex-${mode}`, await shims.add(`codex-${mode}`, ["codex", mode]))
  paths.set("copilot-normal", await shims.add("copilot-normal", ["normal"], ACP_FIXTURE))
  for (const mode of ["normal", "no-models"]) paths.set(`opencode-${mode}`, await shims.add(`opencode-${mode}`, ["opencode", mode]))
  for (const kind of ["gemini", "goose"]) paths.set(`${kind}-normal`, await shims.add(`${kind}-normal`, [kind, "normal"]))
  for (const mode of ["normal", "no-models", "old"]) paths.set(`pi-${mode}`, await shims.add(`pi-${mode}`, ["pi", mode]))
  missing = join(shims.directory, "not-installed")
  home = await mkdtemp(join(tmpdir(), "runrail-detect-home-"))
  process.env.HOME = home
})

afterAll(async () => {
  process.env.HOME = realHome
  await rm(home, { recursive: true, force: true })
  await shims.remove()
})

describe("coding tool detection", () => {
  test("Claude Code: installed, version, and the one signed-in answer", async () => {
    const found = await probeHarness("claude-code", { commands: { "claude-code": command("claude-normal") } })
    // The models Claude Code itself answered with lead; the catalog's other versions follow.
    expect(found.models?.slice(0, 2).map((model) => model.name)).toEqual(["Opus 5.5", "Haiku 4.5"])
    expect(found.models?.slice(2).every((model) => model.catalog === true)).toBe(true)
    expect({ ...found, models: undefined }).toEqual({
      installed: true,
      version: "2.1.227",
      signedIn: true,
      models: undefined,
      efforts: CLAUDE_CODE_EFFORTS,
      freeTextModel: true,
    })
    expect(Object.isFrozen(found)).toBe(true)
    expectNoAccountDetails(found)

    const signedOut = await probeHarness("claude-code", { commands: { "claude-code": command("claude-signed-out") } })
    expect(signedOut).toMatchObject({ installed: true, signedIn: false })
    expectNoAccountDetails(signedOut)

    // A status the probe cannot read is "not learned", never "signed out".
    const unreadable = await probeHarness("claude-code", { commands: { "claude-code": command("claude-status-unreadable") } })
    expect(unreadable).toMatchObject({ installed: true, version: "2.1.227" })
    expect(unreadable).not.toHaveProperty("signedIn")
  })

  test("a proxy in the tool's own settings is reported by address", async () => {
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/v1" } }))
    try {
      expect((await probeHarness("claude-code", { commands: { "claude-code": command("claude-normal") }, models: false })).proxy).toEqual({ address: "127.0.0.1:8787" })
    } finally {
      await rm(join(home, ".claude"), { recursive: true, force: true })
    }
  })

  test("Codex: models and efforts from its own server, account presence only", async () => {
    const found = await probeHarness("codex", { commands: { codex: command("codex-normal") } })
    expect(found).toEqual({
      installed: true,
      version: "0.155.1",
      freeTextModel: true,
      signedIn: true,
      models: [
        { id: "fixture-large", name: "Fixture Large", default: true, efforts: ["low", "high"] },
        { id: "fixture-small", name: "Fixture Small", efforts: ["medium"] },
      ],
      efforts: ["low", "high", "medium"],
    })
    expectNoAccountDetails(found)

    const signedOut = await probeHarness("codex", { commands: { codex: command("codex-signed-out") } })
    expect(signedOut).toMatchObject({ installed: true, signedIn: false })
    expect(signedOut.models).toHaveLength(2)
    expectNoAccountDetails(signedOut)
  })

  test("Codex with no command named: the CLI the resolver picks, found on PATH", async () => {
    const onPath = await createVendorShims()
    try {
      await onPath.add("codex", ["codex", "normal"])
      const found = await probeHarness("codex", { env: { PATH: onPath.directory } })
      expect(found).toMatchObject({ installed: true, version: "0.155.1", signedIn: true })
      expect(await probeHarness("codex", { env: { PATH: missing } })).toEqual({ installed: false })
    } finally {
      await onPath.remove()
    }
  })

  test("Codex without a server falls back to the login command's exit status", async () => {
    const found = await probeHarness("codex", { commands: { codex: command("codex-no-server") } })
    expect(found).toEqual({ installed: true, version: "0.155.1", freeTextModel: true, signedIn: true })
    expectNoAccountDetails(found)
    const signedOut = await probeHarness("codex", { commands: { codex: command("codex-no-server-signed-out") } })
    expect(signedOut).toEqual({ installed: true, version: "0.155.1", freeTextModel: true, signedIn: false })
    expectNoAccountDetails(signedOut)
  })

  test("Copilot: installed and its version; the model is typed and the login is not guessed", async () => {
    const found = await probeHarness("copilot", { commands: { copilot: command("copilot-normal") } })
    expect(found).toEqual({ installed: true, version: "1.0.62", efforts: COPILOT_EFFORTS, freeTextModel: true })
    // Nothing answers "is someone signed in" without starting a conversation, so it stays unsaid.
    expect(found).not.toHaveProperty("signedIn")
    expect(found).not.toHaveProperty("models")
  })

  test("OpenCode: its version and the provider/model ids it lists; Gemini CLI and Goose: version only", async () => {
    const found = await probeHarness("opencode", { commands: { opencode: command("opencode-normal") } })
    expect(found).toEqual({ installed: true, version: "1.2.26", models: [{ id: "fixture/large", name: "fixture/large" }, { id: "fixture/small", name: "fixture/small" }], freeTextModel: true })
    expectNoAccountDetails(found)
    expect(await probeHarness("opencode", { commands: { opencode: command("opencode-no-models") } })).toEqual({ installed: true, version: "1.2.26", freeTextModel: true })
    expect(await probeHarness("gemini", { commands: { gemini: command("gemini-normal") } })).toEqual({ installed: true, version: "0.62.0", freeTextModel: true })
    // Goose takes a typed model as its `model` config option; it lists none without a conversation.
    expect(await probeHarness("goose", { commands: { goose: command("goose-normal") } })).toEqual({ installed: true, version: "1.53.0", freeTextModel: true })
  })

  test("Pi: the models it can run, named as its own --model takes them", async () => {
    const found = await probeHarness("pi", { commands: { pi: command("pi-normal") } })
    expect(found).toEqual({
      installed: true,
      version: "0.84.1",
      signedIn: true,
      models: [
        // Pi's "thinking" column: whether a model reasons at all.
        { id: "fixture-hub/fixture-large", name: "fixture-large", reasoning: true },
        { id: "fixture-hub/fixture-small", name: "fixture-small", reasoning: false },
        { id: "other/fixture-large", name: "fixture-large", reasoning: true },
      ],
      freeTextModel: true,
    })
    expect(Object.isFrozen(found)).toBe(true)
    // A Pi with nothing to run on says so in words, not in a table.
    expect(await probeHarness("pi", { commands: { pi: command("pi-no-models") } })).toEqual({ installed: true, version: "0.84.1", signedIn: false, freeTextModel: true })
    // A Pi that does not know the question is installed, and nothing more was learned.
    const old = await probeHarness("pi", { commands: { pi: command("pi-old") } })
    expect(old).toEqual({ installed: true, version: "0.84.1" })
    expect(old).not.toHaveProperty("signedIn")
  })

  test("a tool that is not installed, and a wrapper's own arguments", async () => {
    for (const target of ["claude-code", "codex", "copilot", "pi"] as const) {
      expect(await probeHarness(target, { commands: { [target]: { command: missing } } })).toEqual({ installed: false })
    }
    // A wrapper's own arguments come before the probe's.
    expect(await probeHarness("pi", { commands: { pi: { command: "/bin/sh", args: [paths.get("pi-old") ?? ""] } } })).toEqual({ installed: true, version: "0.84.1" })
  })

  test("rejects a probe it cannot bound", async () => {
    const invalid: readonly HarnessProbeOptions[] = [
      { timeoutMs: 0 },
      { timeoutMs: 30_001 },
      { timeoutMs: 1.5 },
      { commands: { pi: { command: "" } } },
      { commands: { pi: { command: "pi\0" } } },
      { commands: { pi: { command: "pi", args: ["a\0"] } } },
      { commands: { pi: { command: "pi", args: new Array<string>(17).fill("a") } } },
    ]
    for (const options of invalid) expect(probeHarness("pi", options)).rejects.toBeInstanceOf(TypeError)
  })

  test("a probe that runs out of time reports what it learned, not a guess", async () => {
    const slow = join(shims.directory, "slow")
    await writeFile(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 })
    await chmod(slow, 0o755)
    const started = Date.now()
    const found = await probeHarness("claude-code", { commands: { "claude-code": { command: slow } }, timeoutMs: 100 })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(found.installed).toBe(true)
    expect(found).not.toHaveProperty("version")
    expect(found).not.toHaveProperty("signedIn")
  })
})

describe("coding tool status", () => {
  test("the registry says why a tool cannot be used", async () => {
    const registry = new HarnessRegistry(createDefaultHarnessAdapters())
    const status = await registry.probe({ commands: { "claude-code": command("claude-signed-out"), codex: command("codex-normal"), copilot: command("copilot-normal"), opencode: { command: missing }, gemini: { command: missing }, goose: { command: missing }, pi: { command: missing } } })
    const byId = new Map(status.map((entry) => [entry.descriptor.id, entry]))
    expect([...byId.keys()]).toEqual(["aider", "claude-code", "codex", "copilot", "gemini", "goose", "opencode", "pi", "pty"])
    expect(byId.get("copilot")).toEqual({ descriptor: byId.get("copilot")!.descriptor, available: true, version: "1.0.62", efforts: COPILOT_EFFORTS, freeTextModel: true })
    expect(byId.get("claude-code")).toMatchObject({ available: true, reason: "signed-out", signedIn: false, version: "2.1.227" })
    expect(byId.get("codex")).toMatchObject({ available: true, signedIn: true, version: "0.155.1", efforts: ["low", "high", "medium"] })
    expect(byId.get("codex")).not.toHaveProperty("reason")
    expect(byId.get("codex")).not.toHaveProperty("installed")
    expect(byId.get("pi")).toEqual({ descriptor: byId.get("pi")!.descriptor, available: false, reason: "not-installed" })
    // Tools Runrail has no probe for are listed as-is, not checked.
    expect(byId.get("aider")).toEqual({ descriptor: byId.get("aider")!.descriptor, available: true })
    expectNoAccountDetails(status)
  })

  test("harness.status answers from the probe, keeps it briefly, and refreshes on request", async () => {
    const counter = join(shims.directory, "claude-runs")
    const counted = join(shims.directory, "claude-counted")
    await writeFile(counted, `#!/bin/sh\n[ "$1" = "--version" ] && echo run >> '${counter}'\nexec '${paths.get("claude-normal")}' "$@"\n`, { mode: 0o755 })
    await chmod(counted, 0o755)
    const runs = async (): Promise<number> => (await readFile(counter, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0).length

    const token = "harness-status-test-token"
    const server = await startRunrailControlRpcServer({
      cwd: "/tmp",
      backend: "native",
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "done" }) },
      authToken: token,
      harnessProbe: { commands: { "claude-code": { command: counted }, codex: command("codex-signed-out"), copilot: { command: missing }, opencode: { command: missing }, gemini: { command: missing }, goose: { command: missing }, pi: { command: missing } } },
    })
    const call = async (params: Record<string, unknown> = {}): Promise<Response> =>
      fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "harness.status", params }) })
    try {
      const health = await (await fetch(`${server.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
      expect(health.capabilityStatus["harness.status"]).toBe("available")
      const first = await call()
      expect(first.status).toBe(200)
      const payload = await first.json() as { readonly ok: boolean; readonly result: readonly { readonly descriptor: { readonly id: string }; readonly available: boolean; readonly reason?: string }[] }
      expect(payload.ok).toBe(true)
      const byId = new Map(payload.result.map((entry) => [entry.descriptor.id, entry]))
      expect(byId.get("claude-code")).toMatchObject({ available: true, signedIn: true, version: "2.1.227", freeTextModel: true })
      expect(byId.get("codex")).toMatchObject({ available: true, reason: "signed-out", signedIn: false })
      expect(byId.get("pi")).toMatchObject({ available: false, reason: "not-installed" })
      expect(byId.get("copilot")).toMatchObject({ available: false, reason: "not-installed" })
      expectNoAccountDetails(payload)
      expect(await runs()).toBe(1)

      expect(await (await call()).json()).toEqual(payload)
      expect(await (await call({ refresh: false })).json()).toEqual(payload)
      expect(await runs()).toBe(1)

      expect(await (await call({ refresh: true })).json()).toEqual(payload)
      expect(await runs()).toBe(2)

      const rejected = await call({ refresh: "yes" })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
      expect(await runs()).toBe(2)

      const unauthenticated = await fetch(`${server.handle.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "harness.status", params: {} }) })
      expect(unauthenticated.status).toBe(401)
      expect(await runs()).toBe(2)
    } finally {
      await server.handle.stop()
    }
  })
})
