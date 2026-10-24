import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Builds the standalone `runrail` executables a release ships, one archive per platform:
 *
 *   bun scripts/build-binaries.ts [--target <platform>]... [--out <dir>] [--smoke]
 *
 * Each archive holds `runrail-<version>-<platform>/` with the executable, LICENSE, NOTICE, and
 * README.md. The Claude Agent SDK is never inside: `runrail sdk install` downloads it. `--smoke`
 * runs each built executable this machine can run.
 */

export interface BinaryTarget {
  readonly platform: string
  readonly bun: string
  readonly windows: boolean
}

export const BINARY_TARGETS: readonly BinaryTarget[] = Object.freeze([
  { platform: "darwin-arm64", bun: "bun-darwin-arm64", windows: false },
  { platform: "darwin-x64", bun: "bun-darwin-x64", windows: false },
  { platform: "linux-arm64", bun: "bun-linux-arm64", windows: false },
  // Baseline builds also run on x64 processors without AVX2.
  { platform: "linux-x64", bun: "bun-linux-x64-baseline", windows: false },
  { platform: "windows-x64", bun: "bun-windows-x64-baseline", windows: true },
])

// A project's .env or bunfig.toml (whose `preload` runs code) must never load into Runrail itself.
const COMPILE_FLAGS = ["--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"] as const
const ARCHIVED = ["LICENSE", "NOTICE", "README.md"] as const
const root = resolve(import.meta.dir, "..")

export function archiveName(version: string, target: BinaryTarget): string {
  return `runrail-${version}-${target.platform}.${target.windows ? "zip" : "tar.gz"}`
}

/** The platform name of this machine, as the targets name it. */
export function hostPlatform(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`
}

if (import.meta.main) await main(process.argv.slice(2))

async function main(argv: readonly string[]): Promise<void> {
  const asked: string[] = []
  let out = join(root, "dist", "binaries")
  let smoke = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--target" && next !== undefined) {
      asked.push(next)
      index += 1
    } else if (arg === "--out" && next !== undefined) {
      out = resolve(next)
      index += 1
    } else if (arg === "--smoke") smoke = true
    else throw new Error("usage: bun scripts/build-binaries.ts [--target <platform>]... [--out <dir>] [--smoke]")
  }
  const targets = asked.length === 0 ? BINARY_TARGETS : asked.map((platform) => {
    const target = BINARY_TARGETS.find((item) => item.platform === platform)
    if (target === undefined) throw new Error(`unknown target ${platform}; one of ${BINARY_TARGETS.map((item) => item.platform).join(", ")}`)
    return target
  })
  const version = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }).version
  await mkdir(out, { recursive: true })
  for (const target of targets) {
    const archive = await build(version, target, out)
    if (smoke) await smokeTest(version, target, out)
    console.log(`${archive}\t${String((await stat(archive)).size)} bytes`)
  }
}

async function build(version: string, target: BinaryTarget, out: string): Promise<string> {
  const stem = `runrail-${version}-${target.platform}`
  const folder = join(out, stem)
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true })
  const executable = join(folder, target.windows ? "runrail.exe" : "runrail")
  await run([process.execPath, "build", join(root, "src", "cli.ts"), ...COMPILE_FLAGS, `--target=${target.bun}`, "--outfile", executable], root)
  for (const file of ARCHIVED) await copyFile(join(root, file), join(folder, file))
  const archive = join(out, archiveName(version, target))
  await rm(archive, { force: true })
  // macOS tar would otherwise carry extended attributes that other tars warn about.
  if (!target.windows) await run(["tar", "--no-xattrs", "-czf", archive, stem], out, { COPYFILE_DISABLE: "1" })
  else if (process.platform === "win32") await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${stem}' -DestinationPath '${archive}'`], out)
  else await run(["zip", "-qr", archive, stem], out)
  return archive
}

/**
 * Runs the executable from a folder whose .env and bunfig.toml would show if they loaded, and
 * checks it reports its version, runs doctor, and would download the SDK rather than carry it.
 */
async function smokeTest(version: string, target: BinaryTarget, out: string): Promise<void> {
  const host = hostPlatform()
  // Apple silicon runs x64 builds through Rosetta, when it is installed.
  const rosetta = target.platform === "darwin-x64" && host === "darwin-arm64" && Bun.spawnSync(["/usr/bin/arch", "-x86_64", "/usr/bin/true"]).exitCode === 0
  if (target.platform !== host && !rosetta) {
    console.error(`skipped the smoke test for ${target.platform} on ${host}`)
    return
  }
  const executable = join(out, `runrail-${version}-${target.platform}`, target.windows ? "runrail.exe" : "runrail")
  const project = await mkdtemp(join(tmpdir(), "runrail-smoke-"))
  try {
    await writeFile(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
    await writeFile(join(project, "preload.ts"), 'console.log("PROJECT PRELOAD RAN")\n')
    await writeFile(join(project, ".env"), `RUNRAIL_AGENT_SDK_DIR=${join(project, "from-dotenv")}\n`)
    const { RUNRAIL_AGENT_SDK_DIR: _ignored, ...inherited } = process.env
    const env = { ...inherited, HOME: project, USERPROFILE: project }
    const said = await output([executable, "--version"], project, env)
    if (said.trim() !== version) throw new Error(`${target.platform}: --version said ${JSON.stringify(said)}, not ${version}`)
    const doctor = JSON.parse(await output([executable, "doctor", "--json"], project, env, [0, 1])) as { version?: unknown; checks?: unknown }
    if (doctor.version !== version || !Array.isArray(doctor.checks)) throw new Error(`${target.platform}: doctor --json did not report ${version}`)
    const sdk = JSON.parse(await output([executable, "sdk", "status", "--json"], project, env)) as { source?: unknown; downloadCommand?: unknown; directory?: unknown }
    if (sdk.directory === join(project, "from-dotenv")) throw new Error(`${target.platform}: the project's .env loaded`)
    if (sdk.source !== "installable" || sdk.downloadCommand !== "runrail sdk install" || sdk.directory !== join(project, ".runrail", "agent-sdk")) throw new Error(`${target.platform}: sdk status said ${JSON.stringify(sdk)}`)
    console.error(`smoke test passed for ${target.platform}`)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function output(command: readonly string[], cwd: string, env: Record<string, string | undefined>, codes: readonly number[] = [0]): Promise<string> {
  const child = Bun.spawn([...command], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (!codes.includes(code)) throw new Error(`${command.join(" ")} exited ${String(code)}: ${stderr.trim()}`)
  if (`${stdout}${stderr}`.includes("PROJECT PRELOAD RAN")) throw new Error(`${command.join(" ")} ran the project's bunfig.toml preload`)
  return stdout
}

async function run(command: readonly string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
  const child = Bun.spawn([...command], { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "inherit", stderr: "inherit" })
  if ((await child.exited) !== 0) throw new Error(`${command[0] ?? "command"} failed`)
}
