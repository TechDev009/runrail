import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

interface CliRun {
  readonly status: number
  readonly output: string
}

async function runCli(
  args: readonly string[],
  input = "",
  environment?: Readonly<Record<string, string>>,
): Promise<CliRun> {
  const processHandle = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
  })
  await processHandle.stdin.write(input)
  await processHandle.stdin.end()
  const [stdout, stderr, status] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  return { status, output: `${stdout}\n${stderr}` }
}

/** Runs a server until it prints `ready`, then stops it; a fixed timer flaked whenever the machine was busy. */
async function runLongCli(args: readonly string[], ready: string): Promise<CliRun> {
  const processHandle = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args], {
    cwd: resolve(import.meta.dir, "../.."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const fallback = setTimeout(() => processHandle.kill("SIGTERM"), 20_000)
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder()
    let text = ""
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true })
      if (text.includes(ready)) processHandle.kill("SIGTERM")
    }
    return text
  }
  try {
    const [stdout, stderr, status] = await Promise.all([read(processHandle.stdout), read(processHandle.stderr), processHandle.exited])
    return { status, output: `${stdout}\n${stderr}` }
  } finally {
    clearTimeout(fallback)
  }
}

test("CLI smoke covers every local command surface", async () => {
  const cwd = await mkdtemp("/tmp/runrail-cli-smoke-")
  try {
    const replay = await runCli(["run", "--backend", "replay", "--cwd", cwd, "smoke"])
    expect(replay.status).toBe(0)
    expect(replay.output).toContain("succeeded")

    const benchmark = await runCli(["benchmark", "--json", "--repeats", "2"])
    expect(benchmark.status).toBe(0)
    expect(benchmark.output).toContain('"totalCases": 2')
    expect(benchmark.output).not.toContain("totalCostUsd")

    const backends = await runCli(["backends", "--json"])
    expect(backends.status).toBe(0)
    expect(backends.output).toContain('"name": "pi"')

    const providers = await runCli(["providers", "--json"])
    expect(providers.status).toBe(0)
    expect(providers.output).toContain('"id": "openai"')

    const harnesses = await runCli(["harnesses", "--json"])
    expect(harnesses.status).toBe(0)
    expect(harnesses.output).toContain('"id": "codex"')
    const compatibility = await runCli(["compatibility", "--json"])
    expect(compatibility.status).toBe(0)
    expect(compatibility.output).toContain('"piVersion": "0.84.1"')
    const piPackage = await mkdtemp(join("/tmp", "runrail-cli-pi-package-"))
    try {
      await writeFile(join(piPackage, "package.json"), JSON.stringify({ name: "cli-pi-fixture", version: "1.0.0", pi: { skills: ["skill.md"] } }), "utf8")
      await writeFile(join(piPackage, "skill.md"), "fixture skill", "utf8")
      const inspected = await runCli(["plugins", "inspect-pi", piPackage, "--json"])
      expect(inspected.status).toBe(0)
      expect(inspected.output).toContain('"packageId": "cli-pi-fixture"')
      expect(inspected.output).toContain('"skill"')
      const migration = await runCli(["plugins", "migrate-pi", piPackage, "--json"])
      expect(migration.status).toBe(0)
      expect(migration.output).toContain('"nextAction": "load-native-resources"')
    } finally {
      await rm(piPackage, { recursive: true, force: true })
    }
    const harnessFixture = resolve(import.meta.dir, "../fixtures/vendor-harness.ts")
    const verifierFixture = resolve(import.meta.dir, "../fixtures/env-verifier")
    for (const [backend, mode] of [["codex", "codex"], ["claude-code", "claude"]] as const) {
      const harness = await runCli(["run", "--backend", backend, "--cwd", cwd, "--verification-command", verifierFixture, "--max-repair-attempts", "0", "--harness-auth", "subscription", "--harness-command", process.execPath, "--harness-arg", harnessFixture, "--harness-arg", mode, "--json", "run fixture"])
      expect(harness.status).toBe(0)
      expect(harness.output).toContain('"status": "succeeded"')
    }
    const persistentFixture = resolve(import.meta.dir, "../fixtures/persistent-agent-jsonl.ts")
  const persistent = await runCli(["run", "--backend", "codex", "--cwd", cwd, "--verification-command", verifierFixture, "--max-repair-attempts", "0", "--harness-persistent", "--harness-auth", "subscription", "--harness-command", process.execPath, "--harness-arg", persistentFixture, "--json", "persistent fixture"])
  expect(persistent.status).toBe(0)
  expect(persistent.output).toContain('"status": "succeeded"')
  const appServerFixture = resolve(import.meta.dir, "../fixtures/codex-app-server.ts")
  const appServer = await runCli(["run", "--backend", "codex", "--cwd", cwd, "--verification-command", verifierFixture, "--max-repair-attempts", "0", "--harness-protocol", "app-server", "--harness-auth", "subscription", "--harness-command", process.execPath, "--harness-arg", appServerFixture, "--harness-arg", "normal", "--json", "app-server fixture"])
  expect(appServer.status).toBe(0)
  expect(appServer.output).toContain('"status": "succeeded"')
  const appServerResult = JSON.parse(appServer.output.trim()) as { readonly events?: readonly { readonly type?: unknown }[] }
  expect(appServerResult.events?.filter((event) => event.type === "session.started")).toHaveLength(1)
  const models = await runCli(["models", "--json"])
    expect(models.status).toBe(0)
    expect(models.output).toContain('"id": "scripted"')

    const mcp = await runCli(["mcp", "--cwd", cwd], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1.0.0" } } })}\n`)
    expect(mcp.status).toBe(0)
    expect(mcp.output).toContain('"name":"runrail"')

    const plugins = await runCli(["plugins", "--cwd", cwd, "list", "--json"])
    expect(plugins.status).toBe(0)
    expect(plugins.output).toContain("[]")

    const console = await runCli(["console", "--backend", "replay", "--cwd", cwd], ":quit\n")
    expect(console.status).toBe(0)
    expect(console.output).toContain("Runrail console")

    const pi = await runCli(["pi", resolve(import.meta.dir, "../fixtures/pi-rpc.ts"), "events"], "", {
      RUNRAIL_PI_COMMAND: process.execPath,
    })
    expect(pi.status).toBe(0)

    const serve = await runLongCli(["serve", "--backend", "replay", "--cwd", cwd, "--port", "0", "--json"], "rpc.ready")
    expect(serve.output).toContain("rpc.ready")

    const control = await runLongCli(["control", "--backend", "replay", "--cwd", cwd, "--port", "0", "--json"], "control.ready")
    expect(control.output).toContain("control.ready")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, { timeout: 60_000 })

test("native Pi interop activation is consistent across local entry points", async () => {
  const cwd = await mkdtemp("/tmp/runrail-cli-extension-smoke-")
  try {
    const extensionPath = join(cwd, "surface.ts")
    await writeFile(extensionPath, `export const id = "cli.surface"\nexport default (pi) => { pi.registerCommand("surface", { description: "surface", handler: async () => "extension-ok" }) }\n`, "utf8")
    const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
    await writeFile(join(cwd, "config.json"), JSON.stringify({ version: 1, mode: "auto", effort: "medium", permissions: { default: "allow", rules: [] }, compaction: { enabled: true } }), "utf8")
    const run = await runCli(["run", "--backend", "native", "--cwd", cwd, "--config", join(cwd, "config.json"), "--verification-command", verifier, "--max-repair-attempts", "0", "--pi-extension", extensionPath, "--json", "fixture"])
    expect(run.status).toBe(0)
    expect(run.output).toContain('"status": "succeeded"')

    const console = await runCli(["console", "--backend", "native", "--cwd", cwd, "--pi-extension", extensionPath], ":surface\n:quit\n")
    expect(console.status).toBe(0)
    expect(console.output).toContain("extension-ok")

    const serve = await runLongCli(["serve", "--backend", "native", "--cwd", cwd, "--pi-extension", extensionPath, "--port", "0", "--json"], "rpc.ready")
    expect(serve.output).toContain("rpc.ready")
    const control = await runLongCli(["control", "--backend", "native", "--cwd", cwd, "--pi-extension", extensionPath, "--port", "0", "--json"], "control.ready")
    expect(control.output).toContain("control.ready")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, { timeout: 60_000 })

test("help and the version answer at once, and Pi keeps its own --help", async () => {
  const { RUNRAIL_VERSION } = await import("../../src/version.ts")
  for (const args of [["--help"], ["-h"], ["help"], ["run", "--help"], ["login", "-h"]]) {
    const run = await runCli(args)
    expect([args.join(" "), run.status, run.output.startsWith(`Runrail ${RUNRAIL_VERSION}`), run.output.includes("usage: runrail <command>")]).toEqual([args.join(" "), 0, true, true])
  }
  for (const args of [["--version"], ["-v"], ["version"]]) expect(await runCli(args)).toEqual({ status: 0, output: `${RUNRAIL_VERSION}\n\n` })
  const bare = await runCli([])
  expect([bare.status, bare.output.includes("usage: runrail <command>")]).toEqual([2, true])
  // `pi --help` is Pi's own: it reaches the Pi command, here one that only fails.
  const pi = await runCli(["pi", "--help"], "", { RUNRAIL_PI_COMMAND: "/usr/bin/false" })
  expect([pi.status, pi.output.includes("usage: runrail <command>")]).toEqual([1, false])
})
