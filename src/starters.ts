import { existsSync } from "node:fs"
import { mkdir, readdir, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { runGit } from "./git/run.ts"
import { filteredEnvironment } from "./workspace/policy.ts"

export type StarterId = "nifra" | "vite" | "next" | "empty"

export interface RunrailStarter {
  readonly id: StarterId
  readonly label: string
  readonly description: string
  /** Who makes it. Nifra is made by Runrail's authors, and every list that offers it says so. */
  readonly maker: string
  readonly recommended: boolean
  /** The npm creator at the exact version Runrail was tested with; none for an empty folder. */
  readonly creator?: string
}

export const DEFAULT_STARTER: StarterId = "nifra"

const STARTERS: RunrailStarter[] = [
  {
    id: "nifra",
    label: "Nifra",
    description: "A full-stack TypeScript app: typed API routes and a React frontend, with Nifra's checks and agent tools set up.",
    maker: "the authors of Runrail",
    recommended: true,
    creator: "create-nifra@5.3.0",
  },
  { id: "vite", label: "Vite + React", description: "A React and TypeScript app on Vite.", maker: "the Vite team", recommended: false, creator: "create-vite@9.2.1" },
  { id: "next", label: "Next.js", description: "A Next.js app with the App Router, TypeScript, Tailwind CSS, and ESLint.", maker: "Vercel", recommended: false, creator: "create-next-app@16.3.8" },
  { id: "empty", label: "Empty", description: "An empty folder with a git repository.", maker: "Runrail", recommended: false },
]

export const RUNRAIL_STARTERS: readonly RunrailStarter[] = Object.freeze(STARTERS.map((starter) => Object.freeze(starter)))

const CREATOR_ARGS: Readonly<Record<Exclude<StarterId, "empty">, (name: string) => readonly string[]>> = {
  nifra: (name) => [name, "--template", "site", "--framework", "react"],
  vite: (name) => [name, "--template", "react-ts", "--no-interactive", "--no-immediate"],
  // Its own install runs the `bun` on PATH, which a desktop install may not have, so Runrail installs after.
  next: (name) => [name, "--ts", "--app", "--tailwind", "--eslint", "--use-bun", "--skip-install", "--yes", "--disable-git"],
}

/** npm's rule for a package name, which every creator applies to the folder name. */
const APP_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/
const CREATE_TIMEOUT_MS = 5 * 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const OUTPUT_TAIL_BYTES = 16 * 1024
const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const

export type StarterErrorCode =
  | "STARTER_UNKNOWN"
  | "STARTER_NAME_INVALID"
  | "STARTER_PARENT_MISSING"
  | "STARTER_TARGET_EXISTS"
  | "STARTER_CREATE_FAILED"
  | "STARTER_INSTALL_FAILED"
  | "STARTER_TIMEOUT"
  | "STARTER_CANCELLED"

export class StarterError extends Error {
  constructor(
    readonly code: StarterErrorCode,
    message: string,
    /** The end of the creator's or the install's own output. */
    readonly output?: string,
  ) {
    super(message)
    this.name = "StarterError"
  }
}

export type StarterStep = "create" | "install" | "commit"

export interface StarterCreateOptions {
  readonly directory: string
  readonly starter?: StarterId
  /** Install the app's packages. Default true. */
  readonly install?: boolean
  /** The Bun that runs the creator and the install. Default: this process, which a compiled engine runs as Bun. */
  readonly bun?: string
  readonly onStep?: (step: StarterStep, starter: RunrailStarter) => void
  readonly signal?: AbortSignal
}

export interface StarterResult {
  readonly path: string
  readonly starter: StarterId
  readonly installed: boolean
  readonly committed: boolean
  readonly warnings: readonly string[]
}

export function findStarter(id: string): RunrailStarter {
  const starter = RUNRAIL_STARTERS.find((candidate) => candidate.id === id)
  if (starter === undefined) throw new StarterError("STARTER_UNKNOWN", `unknown starter ${JSON.stringify(id)}; one of ${RUNRAIL_STARTERS.map((entry) => entry.id).join(", ")}`)
  return starter
}

/** Creates a new app in `directory` from a starter, installs its packages, and makes the first commit. */
export async function createStarterApp(options: StarterCreateOptions): Promise<StarterResult> {
  const starter = findStarter(options.starter ?? DEFAULT_STARTER)
  const path = resolve(options.directory)
  const name = basename(path)
  const parent = dirname(path)
  if (!APP_NAME.test(name)) throw new StarterError("STARTER_NAME_INVALID", "an app name uses lowercase letters, digits, \".\", \"_\", and \"-\", starting with a letter or digit")
  if (!(await isDirectory(parent))) throw new StarterError("STARTER_PARENT_MISSING", "the folder to create the app in does not exist")
  if (existsSync(path) && !(await isEmptyDirectory(path))) throw new StarterError("STARTER_TARGET_EXISTS", `${name} already exists and is not empty`)
  const warnings: string[] = []
  const bun = options.bun ?? process.execPath
  options.onStep?.("create", starter)
  if (starter.creator === undefined) await mkdir(path, { recursive: true })
  else await run([bun, "x", "--bun", starter.creator, ...CREATOR_ARGS[starter.id as Exclude<StarterId, "empty">](name)], parent, CREATE_TIMEOUT_MS, "STARTER_CREATE_FAILED", options.signal)
  let installed = false
  if (starter.creator !== undefined && options.install !== false) {
    options.onStep?.("install", starter)
    await run([bun, "install"], path, INSTALL_TIMEOUT_MS, "STARTER_INSTALL_FAILED", options.signal)
    installed = true
  }
  options.onStep?.("commit", starter)
  const committed = await firstCommit(path, starter, warnings)
  return Object.freeze({ path, starter: starter.id, installed, committed, warnings: Object.freeze(warnings) })
}

async function firstCommit(path: string, starter: RunrailStarter, warnings: string[]): Promise<boolean> {
  try {
    if (!existsSync(join(path, ".git"))) await runGit({ cwd: path, args: ["init", "--quiet", "--initial-branch=main"] })
    await runGit({ cwd: path, args: ["add", "--all"] })
    const message = starter.creator === undefined ? "Start an empty app" : `Start from ${starter.creator}`
    const commit = await runGit({ cwd: path, args: ["commit", "--quiet", "--allow-empty", "--message", message], signing: true, okExitCodes: [0, 1, 128] })
    if (commit.exitCode === 0) return true
    warnings.push("the files are not committed yet: git could not commit (are user.name and user.email set?)")
  } catch {
    warnings.push("the app has no first commit: git did not run (is it installed?)")
  }
  return false
}

async function run(argv: readonly string[], cwd: string, timeoutMs: number, failure: StarterErrorCode, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw new StarterError("STARTER_CANCELLED", "creating the app was cancelled")
  const env: Record<string, string> = {
    ...filteredEnvironment(),
    ...Object.fromEntries(PROXY_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]]))),
    // A compiled Runrail is Bun itself; this makes it act as the `bun` command.
    BUN_BE_BUN: "1",
    // Next.js would otherwise send usage telemetry to Vercel.
    NEXT_TELEMETRY_DISABLED: "1",
  }
  const child = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let ended: "timeout" | "cancelled" | undefined
  const stop = (reason: "timeout" | "cancelled") => {
    ended ??= reason
    child.kill()
  }
  const timer = setTimeout(() => stop("timeout"), timeoutMs)
  const onAbort = () => stop("cancelled")
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (ended === "timeout") throw new StarterError("STARTER_TIMEOUT", `${argv.slice(1, 4).join(" ")} did not finish in ${Math.round(timeoutMs / 60_000)} minutes`)
    if (ended === "cancelled") throw new StarterError("STARTER_CANCELLED", "creating the app was cancelled")
    if (exitCode !== 0) throw new StarterError(failure, failure === "STARTER_INSTALL_FAILED" ? "installing the app's packages failed" : "the starter could not create the app", tail(`${stdout}\n${stderr}`))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= OUTPUT_TAIL_BYTES ? trimmed : trimmed.slice(-OUTPUT_TAIL_BYTES)
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  return (await isDirectory(path)) && (await readdir(path)).length === 0
}

export const NEW_CLI_USAGE = "usage: runrail new <directory> [--starter nifra|vite|next|empty] [--no-install] [--json] | runrail new --list [--json]"

export type NewCliOptions =
  | { readonly action: "list"; readonly json: boolean }
  | { readonly action: "create"; readonly directory: string; readonly starter?: StarterId; readonly install: boolean; readonly json: boolean }

export function parseNewCliArgs(argv: readonly string[]): NewCliOptions {
  let list = false
  let json = false
  let install = true
  let starter: StarterId | undefined
  let directory: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--list") list = true
    else if (arg === "--json") json = true
    else if (arg === "--no-install") install = false
    else if (arg === "--starter") starter = findStarter(argv[++index] ?? "").id
    else if (!arg.startsWith("-") && directory === undefined) directory = arg
    else throw new Error(NEW_CLI_USAGE)
  }
  if (list) {
    if (directory !== undefined || starter !== undefined || !install) throw new Error(NEW_CLI_USAGE)
    return { action: "list", json }
  }
  if (directory === undefined) throw new Error(NEW_CLI_USAGE)
  return { action: "create", directory, ...(starter === undefined ? {} : { starter }), install, json }
}

export interface NewCliHost {
  /** Results: in `--json` mode one JSON object. */
  out(line: string): void
  /** What the person reads while the app is made. */
  note(line: string): void
  readonly signal?: AbortSignal
}

export async function runNewCli(options: NewCliOptions, host: NewCliHost): Promise<number> {
  if (options.action === "list") {
    if (options.json) host.out(JSON.stringify({ default: DEFAULT_STARTER, starters: RUNRAIL_STARTERS }))
    else for (const starter of RUNRAIL_STARTERS) host.out(`${starter.id.padEnd(6)} ${starter.label}${starter.recommended ? " (recommended)" : ""}, by ${starter.maker}: ${starter.description}`)
    return 0
  }
  const chosen = findStarter(options.starter ?? DEFAULT_STARTER)
  if (options.starter === undefined) host.note(`Starter: ${chosen.label}, by ${chosen.maker}. --starter ${RUNRAIL_STARTERS.filter((entry) => entry.id !== chosen.id).map((entry) => entry.id).join("|")} picks another.`)
  try {
    const result = await createStarterApp({
      directory: options.directory,
      starter: chosen.id,
      install: options.install,
      onStep: (step, starter) => host.note(step === "create" ? (starter.creator === undefined ? "Creating the folder" : `Creating the app with ${starter.creator}`) : step === "install" ? "Installing packages" : "Making the first commit"),
      ...(host.signal === undefined ? {} : { signal: host.signal }),
    })
    for (const warning of result.warnings) host.note(`warning: ${warning}`)
    host.out(options.json ? JSON.stringify({ ok: true, ...result }) : result.path)
    return 0
  } catch (error) {
    if (!(error instanceof StarterError)) throw error
    if (options.json) host.out(JSON.stringify({ ok: false, code: error.code, message: error.message, ...(error.output === undefined ? {} : { output: error.output }) }))
    else {
      if (error.output !== undefined && error.output.length > 0) host.note(error.output)
      host.note(`error: ${error.message}`)
    }
    return 1
  }
}
