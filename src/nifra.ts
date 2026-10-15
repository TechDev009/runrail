import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { BehaviorMcpServer } from "./behavior/config.ts"
import { filteredEnvironment } from "./workspace/policy.ts"

/**
 * Every place Runrail brings in Nifra, the framework Runrail's authors make. By default each applies
 * only in a Nifra project, is listed in the README, and is reported when it is on (`NifraUse`):
 *
 * - Runrail's own loop gets the tools of the `nifra mcp` on PATH;
 * - Pi gets Nifra's instructions and tools;
 * - a turn is checked with `nifra check` where the command checks by default (`run`, the library).
 *
 * `nifra: false` (`--no-nifra`, `RUNRAIL_NIFRA=off`) turns all of them off; `true` turns them on in any
 * workspace. `runrail new` offers Nifra as the first starter and says who makes it.
 */
export interface NifraUse {
  /** Runrail's own loop has the `nifra mcp` tools. */
  readonly mcp: boolean
  /** Pi has Nifra's instructions and tools. */
  readonly pi: boolean
  /** Each turn ends with the default `nifra` check. */
  readonly check: boolean
}

export const NIFRA_OFF_HINT = "--no-nifra or RUNRAIL_NIFRA=off turns it off"

/** `RUNRAIL_NIFRA`: `off` or `on` for every session this process opens; anything else leaves it to the workspace. */
export function nifraSettingFromEnvironment(value = process.env.RUNRAIL_NIFRA): boolean | undefined {
  const setting = value?.trim().toLowerCase()
  if (setting === "off" || setting === "0" || setting === "false") return false
  if (setting === "on" || setting === "1" || setting === "true") return true
  return undefined
}

/** Whether Nifra's tools, instructions, and default check apply here. */
export function nifraApplies(setting: boolean | undefined, cwd: string): boolean {
  return setting ?? nifraSettingFromEnvironment() ?? isNifraProject(cwd)
}

function installedNifra(): string | undefined {
  return Bun.which("nifra", { PATH: filteredEnvironment().PATH ?? "" }) ?? undefined
}

export interface VerificationGateInput {
  readonly command: string | undefined
  readonly cwd: string
  /** The caller asked for a check after each turn (`verifyAfterTurn: true`). */
  readonly requested?: boolean
  readonly nifra?: boolean
}

/**
 * A command the caller named always runs. The default `nifra` runs only when it is installed, Nifra
 * is not turned off, and the caller asked for it or the workspace is a Nifra project: elsewhere
 * `nifra check` fails on what the task never touched (no tsconfig.json, say), and every turn would
 * end in repairs.
 */
export function verificationGateAvailable(input: VerificationGateInput): boolean {
  if (input.command !== undefined || process.env.RUNRAIL_NIFRA_COMMAND !== undefined) return true
  if (installedNifra() === undefined) return false
  if ((input.nifra ?? nifraSettingFromEnvironment()) === false) return false
  return input.requested === true || nifraApplies(input.nifra, input.cwd)
}

/** Nifra's own read-only marks; every other Nifra tool runs project code or writes, and asks first. */
const NIFRA_MCP_READ_ONLY = Object.freeze(["nifra_docs", "nifra_example", "nifra_types", "nifra_learn", "nifra_frontend"])

/**
 * The `nifra mcp` server where Nifra applies, unless the behavior file names its own `nifra` server.
 * Only the `nifra` on PATH: a binary inside the workspace is never started unasked, and none is fetched.
 */
export function nifraMcpServer(root: string, setting: boolean | undefined, configured: readonly BehaviorMcpServer[]): BehaviorMcpServer | undefined {
  if (configured.some((server) => server.name === "nifra") || !nifraApplies(setting, root)) return undefined
  const command = installedNifra()
  if (command === undefined) return undefined
  return Object.freeze({ transport: "stdio", name: "nifra", command, args: Object.freeze(["mcp"]), env: Object.freeze([]), enabled: true, readOnlyTools: NIFRA_MCP_READ_ONLY })
}

/** One line for a person at a terminal, or undefined when Nifra is not in use. */
export function nifraNotice(use: NifraUse): string | undefined {
  const parts = [
    ...(use.mcp ? ["Runrail's agent has the `nifra mcp` tools"] : []),
    ...(use.pi ? ["Pi has Nifra's instructions and tools"] : []),
    ...(use.check ? ["each turn is checked with `nifra check`"] : []),
  ]
  if (parts.length === 0) return undefined
  return `Nifra (by the authors of Runrail): ${parts.join("; ")}. ${NIFRA_OFF_HINT}.`
}

const NIFRA_PACKAGE = /^(?:@nifrajs\/|nifra$)/
const NIFRA_FILES = ["nifra.config.ts", "nifra.check.json", join("backend", "framework.ts")]
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

/** Nifra's own test: a Nifra config file in the folder, or a nearest package.json that names `nifra` or a `@nifrajs/` package, or has a `nifra` setting. */
export function isNifraProject(cwd: string): boolean {
  const root = resolve(cwd)
  if (NIFRA_FILES.some((file) => existsSync(join(root, file)))) return true
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) return manifestDeclaresNifra(manifest)
    if (dirname(dir) === dir) return false
  }
}

function manifestDeclaresNifra(path: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // An unreadable manifest proves nothing either way, so the gate runs, as `nifra check` decides it.
    return true
  }
  if (typeof parsed !== "object" || parsed === null) return true
  if ("nifra" in parsed) return true
  return DEPENDENCY_FIELDS.some((field) => {
    const deps: unknown = Reflect.get(parsed, field)
    return typeof deps === "object" && deps !== null && Object.keys(deps).some((name) => NIFRA_PACKAGE.test(name))
  })
}
