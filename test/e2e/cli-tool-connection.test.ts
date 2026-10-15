import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ConnectionDirectory, FileAccountStore, FileConnectionSettingsStore, parseAccountRecord } from "../../src/accounts/index.ts"
import { FileCredentialVault } from "../../src/auth/index.ts"
import { createVendorShims } from "../fixtures/vendor-shim.ts"

const ACP_FIXTURE = new URL("../fixtures/acp-agent.ts", import.meta.url).pathname
const CODEX_FIXTURE = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function runCli(args: readonly string[], env?: Record<string, string>): Promise<{ readonly status: number; readonly output: string }> {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args], { cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env: { ...process.env, ...env } }) })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { status, output: `${stdout}\n${stderr}` }
}

test("a tool backend runs as a connection: on, for that tool, and on its first chosen model", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-tool-connection-cwd-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-tool-connection-accounts-"))
  const shims = await createVendorShims()
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(accountsDir, { recursive: true, force: true }), () => shims.remove())
  const copilot = await shims.add("copilot-echo", ["echo"], ACP_FIXTURE)
  const accounts = new FileAccountStore({ root: accountsDir })
  const connections = new ConnectionDirectory(accounts, new FileConnectionSettingsStore({ root: accountsDir }))
  await connections.addTool({ tool: "copilot", models: ["fixture-small", "fixture-large"] })
  await connections.addTool({ tool: "copilot", connectionId: "copilot-off" })
  await connections.update("copilot-off", { enabled: false })
  await connections.addTool({ tool: "claude-code", authMode: "api-key" })
  await accounts.put(parseAccountRecord({ reference: { accountId: "conn-off", provider: "openrouter", label: "Off", authMode: "environment", environmentName: "OPENROUTER_API_KEY", scopes: [], createdAt: 1, updatedAt: 1 }, status: "ready" }))
  await connections.update("conn-off", { enabled: false })
  await accounts.put(parseAccountRecord({ reference: { accountId: "conn-picked", provider: "openrouter", label: "Picked", authMode: "environment", environmentName: "OPENROUTER_API_KEY", scopes: [], createdAt: 1, updatedAt: 1 }, status: "ready" }))
  await connections.update("conn-picked", { models: ["router/large"] })

  const base = ["run", "--cwd", cwd, "--accounts-dir", accountsDir, "--credential-vault", "none"]
  const ran = await runCli([...base, "--backend", "copilot", "--harness-command", copilot, "--tool-connection", "copilot-1", "go"])
  expect([ran.status, ran.output]).toEqual([0, expect.stringContaining('"argv":["--model","fixture-small"]')])

  const cases: readonly (readonly [readonly string[], string])[] = [
    [["--backend", "copilot", "--harness-command", copilot, "--tool-connection", "copilot-1", "--model", "fixture-other"], "CONNECTION_MODEL_NOT_CHOSEN"],
    [["--backend", "copilot", "--harness-command", copilot, "--tool-connection", "copilot-off"], "CONNECTION_DISABLED"],
    [["--backend", "codex", "--tool-connection", "copilot-1"], "CONNECTION_INVALID"],
    [["--backend", "copilot", "--tool-connection", "copilot-nobody"], "CONNECTION_NOT_FOUND"],
    [["--backend", "claude-code", "--tool-connection", "claude-code-1"], "CONNECTION_KEY_MISSING"],
    [["--connection", "conn-off", "--model", "router/large"], "CONNECTION_DISABLED"],
    [["--connection", "conn-picked", "--model", "router/small"], "CONNECTION_MODEL_NOT_CHOSEN"],
  ]
  for (const [args, code] of cases) {
    const refused = await runCli([...base, ...args, "go"])
    expect([code, refused.status === 0, refused.output.includes(`(${code})`)]).toEqual([code, false, true])
  }
})

test("a key connection runs its tool in its own folder with the key from the vault", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-tool-key-cwd-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-tool-key-accounts-"))
  const shims = await createVendorShims()
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(accountsDir, { recursive: true, force: true }), () => shims.remove())
  // The installed tools, as Runrail finds them on PATH.
  await shims.add("codex", ["echo"], CODEX_FIXTURE)
  await shims.add("claude", ["claude", "account"])
  const env = { PATH: `${shims.directory}:${process.env.PATH ?? ""}`, RUNRAIL_CODEX_APP_SEARCH: "off" }
  const connections = new ConnectionDirectory(new FileAccountStore({ root: accountsDir }), new FileConnectionSettingsStore({ root: accountsDir }))
  const vault = new FileCredentialVault({ root: join(accountsDir, "vault") })
  for (const tool of ["codex", "claude-code"] as const) {
    await connections.addTool({ tool, authMode: "api-key" })
    await vault.set(`${tool}-1`, { kind: "api-key", secret: `sk-fixture-${tool}` })
  }
  const base = ["run", "--cwd", cwd, "--accounts-dir", accountsDir, "--credential-vault", "file"]
  const homes = join(accountsDir, "tool-homes")

  const codex = await runCli([...base, "--backend", "codex", "--tool-connection", "codex-1", "go"], env)
  expect(codex.status).toBe(0)
  const codexSeen = JSON.parse(codex.output.slice(codex.output.indexOf('{"thread"'), codex.output.lastIndexOf("}") + 1)) as { login: unknown; started: { args: string[]; CODEX_HOME: string; CODEX_API_KEY: unknown } }
  expect([codexSeen.login, codexSeen.started.args.slice(-2), codexSeen.started.CODEX_HOME.startsWith(homes), codexSeen.started.CODEX_API_KEY]).toEqual([{ type: "apiKey", apiKey: "sk-fixture-codex" }, ["-c", 'cli_auth_credentials_store="ephemeral"'], true, null])

  const claude = await runCli([...base, "--backend", "claude-code", "--tool-connection", "claude-code-1", "go"], env)
  expect(claude.status).toBe(0)
  const account = /"account":(\{[^}]*\})/.exec(claude.output)?.[1]
  const claudeSeen = JSON.parse(account ?? "null") as { CLAUDE_CONFIG_DIR: string; ANTHROPIC_API_KEY: string } | null
  expect([claudeSeen?.CLAUDE_CONFIG_DIR.startsWith(homes), claudeSeen?.ANTHROPIC_API_KEY, claudeSeen?.CLAUDE_CONFIG_DIR === codexSeen.started.CODEX_HOME]).toEqual([true, "sk-fixture-claude-code", false])
})

test("a control engine started as a tool connection reports it and holds model switches to its models", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-tool-control-cwd-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-tool-control-accounts-"))
  const shims = await createVendorShims()
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(accountsDir, { recursive: true, force: true }), () => shims.remove())
  const copilot = await shims.add("copilot-echo", ["echo"], ACP_FIXTURE)
  await new ConnectionDirectory(new FileAccountStore({ root: accountsDir }), new FileConnectionSettingsStore({ root: accountsDir })).addTool({ tool: "copilot", models: ["fixture-small", "fixture-large"] })
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "control", "--backend", "copilot", "--harness-command", copilot, "--tool-connection", "copilot-1", "--cwd", cwd, "--accounts-dir", accountsDir, "--credential-vault", "none", "--port", "0", "--json", "--exit-on-stdin-close"], { cwd: resolve(import.meta.dir, "../.."), stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  cleanup.push(async () => {
    child.stdin.end()
    await child.exited
  })
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += new TextDecoder().decode(chunk.value)
  }
  const ready = JSON.parse(text.slice(0, text.indexOf("\n"))) as { url: string; token: string }
  const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<{ readonly status: number; readonly body: { result?: Record<string, unknown>; error?: { code?: string } } }> => {
    const response = await fetch(`${ready.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
    return { status: response.status, body: await response.json() as { result?: Record<string, unknown>; error?: { code?: string } } }
  }
  expect((await rpc("session.snapshot")).body.result).toMatchObject({ backend: "copilot", connectionId: "copilot-1" })
  expect(await rpc("model.switch", { id: "fixture-other" })).toMatchObject({ status: 400, body: { error: { code: "CONNECTION_MODEL_NOT_CHOSEN" } } })
})

test("a build that registers the Agent SDK before running the CLI gets Claude Code's SDK route", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-sdk-sidecar-cwd-"))
  const bin = await mkdtemp(join("/tmp", "runrail-sdk-sidecar-bin-"))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(bin, { recursive: true, force: true }))
  // The route looks Claude Code up on PATH; the stub SDK never runs it.
  await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../fixtures/sdk-sidecar.ts"), "run", "--cwd", cwd, "--backend", "claude-code", "--harness-protocol", "sdk", "--json", "go"], { cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe", env })
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect([status, (JSON.parse(stdout) as { status: string }).status]).toEqual([0, "succeeded"])
  // The CLI alone has no SDK here, so the same route is refused.
  const alone = await runCli(["run", "--cwd", cwd, "--backend", "claude-code", "--harness-protocol", "sdk", "go"])
  expect([alone.status, alone.output.includes("HARNESS_SDK_MISSING")]).toEqual([2, true])
})
