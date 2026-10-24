import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(".")
const packDir = resolve(process.env.NIFRA_PACK_DIR ?? "/tmp/nifra-runrail-pack")
const packageFiles = {
  "@nifrajs/agent-protocol": "nifrajs-agent-protocol-5.3.0.tgz",
  "@nifrajs/agent": "nifrajs-agent-5.3.0.tgz",
  "@nifrajs/agent-review": "nifrajs-agent-review-5.3.0.tgz",
  "@nifrajs/core": "nifrajs-core-5.3.0.tgz",
  "@nifrajs/jobs": "nifrajs-jobs-5.3.0.tgz",
  "@nifrajs/coding-agent": "nifrajs-coding-agent-5.3.0.tgz",
  "@nifrajs/mcp": "nifrajs-mcp-5.3.0.tgz",
  "@nifrajs/pi": "nifrajs-pi-5.3.0.tgz",
} as const

const tarballs = Object.fromEntries(
  await Promise.all(
    Object.entries(packageFiles).map(async ([name, file]) => {
      const path = join(packDir, file)
      if (!(await Bun.file(path).exists())) throw new Error("missing packed Nifra artifact: " + path)
      return [name, "file:" + path]
    }),
  ),
)

const releasePack = await mkdtemp(join("/tmp", "runrail-release-pack-"))
const consumer = await mkdtemp(join("/tmp", "runrail-packed-consumer-"))
try {
  const runrailTarball = await packRunrail(releasePack)
  const dependencies = { runrail: "file:" + runrailTarball, ...tarballs }
  const manifest = {
    name: "runrail-packed-consumer",
    private: true,
    type: "module",
    dependencies,
    overrides: tarballs,
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify(manifest, null, 2))
  await writeExternalExample(consumer)
  await writeFixture(consumer)
  await writeCheck(consumer)

  const install = Bun.spawn(["bun", "install", "--ignore-scripts", "--no-save"], {
    cwd: consumer,
    stdout: "pipe",
    stderr: "pipe",
  })
  const installOutput = readProcessOutput(install)
  const installStatus = await install.exited
  if (installStatus !== 0) throw new Error(await installOutput)

  const check = Bun.spawn(["bun", "check.ts"], {
    cwd: consumer,
    stdout: "pipe",
    stderr: "pipe",
  })
  const checkOutput = readProcessOutput(check)
  const checkStatus = await check.exited
  if (checkStatus !== 0) throw new Error(await checkOutput)
  await checkFolderIsolation(join(consumer, "node_modules", ".bin", "runrail"))
  console.log("packed consumer passed (Runrail plus " + Object.keys(tarballs).length + " Nifra packages)")
} finally {
  await rm(consumer, { recursive: true, force: true })
  await rm(releasePack, { recursive: true, force: true })
}

async function packRunrail(destination: string): Promise<string> {
  const pack = Bun.spawn(["npm", "pack", "--pack-destination", destination], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const packOutput = readProcessOutput(pack)
  const status = await pack.exited
  if (status !== 0) throw new Error("Runrail packing failed:\n" + await packOutput)
  const files = (await readdir(destination)).filter((file) => file.endsWith(".tgz"))
  if (files.length !== 1) throw new Error("expected one Runrail tarball, found " + files.length)
  return join(destination, files[0] as string)
}

async function writeExternalExample(consumer: string): Promise<void> {
  const directory = join(consumer, "external-harness-adapter")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "index.ts"), await readFile(join(repositoryRoot, "examples/external-harness-adapter/index.ts")))
}

async function writeFixture(consumer: string): Promise<void> {
  await writeFile(
    join(consumer, "fixture.ts"),
    [
      'import { createInterface } from "node:readline"',
      "const input = createInterface({ input: process.stdin })",
      "for await (const line of input) {",
      "  let value: unknown",
      "  try { value = JSON.parse(line) as unknown } catch { continue }",
      '  if (!isRecord(value) || value.type !== "prompt" || typeof value.sessionId !== "string") continue',
      "  const sessionId = value.sessionId",
      '  process.stdout.write(JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "turn.started", turnId: "turn", prompt: "packed" }) + "\\n")',
      '  process.stdout.write(JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "assistant.message", turnId: "turn", text: "packed adapter" }) + "\\n")',
      '  process.stdout.write(JSON.stringify({ version: 1, sessionId, seq: 2, at: 2, type: "session.completed", snapshot: { version: 1, id: sessionId, backend: "my-agent", cwd: process.cwd(), status: "completed", createdAt: 0, updatedAt: 2, lastSeq: 2, capabilities: ["sessions", "streaming"] } }) + "\\n")',
      "}",
      'function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }',
    ].join("\n"),
  )
}

async function writeCheck(consumer: string): Promise<void> {
  await writeFile(
    join(consumer, "check.ts"),
    [
      'import { AGENT_PROTOCOL_VERSION } from "@nifrajs/agent-protocol"',
      'import { createMcpServer } from "@nifrajs/mcp"',
      'import { createHarnessRegistry, registerClaudeAgentSdk } from "runrail"',
      'import { runCliMain } from "runrail/cli"',
      'import { createExternalHarnessAdapter } from "./external-harness-adapter/index.ts"',
      'if (AGENT_PROTOCOL_VERSION !== 1 || typeof createMcpServer !== "function") throw new Error("packed Nifra exports are unavailable")',
      'if (typeof runCliMain !== "function" || typeof registerClaudeAgentSdk !== "function") throw new Error("packed sidecar entry points are unavailable")',
      'const adapter = createExternalHarnessAdapter(process.execPath, ["fixture.ts"])',
      'const registry = createHarnessRegistry([adapter])',
      'const selected = registry.select("my-agent", ["sessions", "streaming"])',
      'const backend = await selected.create({ cwd: process.cwd(), requestedFeatures: ["sessions", "streaming"] })',
      'const session = await backend.createSession({ cwd: process.cwd(), sessionId: "packed-example" })',
      'const events: unknown[] = []',
      'for await (const event of backend.send({ sessionId: session.id, message: "packed" })) events.push(event)',
      'if (events.at(-1) === undefined || (events.at(-1) as { type?: unknown }).type !== "session.completed" || !events.some((event) => (event as { type?: unknown }).type === "assistant.message")) throw new Error("external adapter did not complete")',
      'await backend.close(session.id)',
      'console.log("packed external adapter passed")',
    ].join("\n"),
  )
}

/**
 * Runs the installed command in a folder like a freshly cloned repository, whose bunfig.toml
 * preload and .env would show if they loaded into Runrail.
 */
async function checkFolderIsolation(runrail: string): Promise<void> {
  const project = await mkdtemp(join("/tmp", "runrail-packed-project-"))
  try {
    const mark = join(project, "preloaded")
    await writeFile(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
    await writeFile(join(project, "preload.ts"), 'import { writeFileSync } from "node:fs"\nwriteFileSync(' + JSON.stringify(mark) + ', "")\n')
    await writeFile(join(project, ".env"), "RUNRAIL_AGENT_SDK_DIR=" + join(project, "from-dotenv") + "\n")
    const { RUNRAIL_AGENT_SDK_DIR: _ignored, ...inherited } = process.env
    const sdk = Bun.spawn([runrail, "sdk", "status", "--json"], {
      cwd: project,
      env: { ...inherited, HOME: project },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, status] = await Promise.all([new Response(sdk.stdout).text(), new Response(sdk.stderr).text(), sdk.exited])
    if (status !== 0) throw new Error("installed runrail failed:\n" + stderr)
    if (await Bun.file(mark).exists()) throw new Error("installed runrail ran the folder's bunfig.toml preload")
    const directory = (JSON.parse(stdout) as { directory?: unknown }).directory
    if (directory !== join(project, ".runrail", "agent-sdk")) throw new Error("installed runrail loaded the folder's .env: " + JSON.stringify(directory))
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function readProcessOutput(process: Bun.Subprocess): Promise<string> {
  const stdout = process.stdout === null || typeof process.stdout === "number" ? "" : await new Response(process.stdout).text()
  const stderr = process.stderr === null || typeof process.stderr === "number" ? "" : await new Response(process.stderr).text()
  return (stdout + "\n" + stderr).trim()
}
