import { terminateProcessTree } from "../backend/process-tree.ts"
import { filteredEnvironment } from "../workspace/policy.ts"
import { isRouteEnvironment } from "./auth.ts"

/**
 * The account a coding tool runs as for one connection. Without either field the tool runs with
 * its usual folder and its own sign-in, as it does from a terminal.
 */
export interface HarnessAccountOptions {
  /** The connection's own config folder for the tool, so its sign-in and settings are its own. */
  readonly configDir?: string
  /** Reads the connection's API key when the tool starts. */
  readonly apiKey?: () => Promise<string>
}

/** The variable that moves each tool's config folder. Only these tools can run as a separate account. */
export const HARNESS_ACCOUNT_CONFIG_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  gemini: "GEMINI_CLI_HOME",
})

export class HarnessAccountError extends Error {
  constructor(readonly code: "HARNESS_ACCOUNT_INVALID" | "HARNESS_ACCOUNT_UNSUPPORTED", reason: string) {
    super(`${code}: ${reason}`)
    this.name = "HarnessAccountError"
  }
}

export function parseHarnessAccountOptions(value: unknown): HarnessAccountOptions | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HarnessAccountError("HARNESS_ACCOUNT_INVALID", "harness account is invalid")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== "configDir" && key !== "apiKey")) throw new HarnessAccountError("HARNESS_ACCOUNT_INVALID", "harness account has unknown fields")
  const { configDir, apiKey } = record
  if (configDir !== undefined && (typeof configDir !== "string" || !configDir.startsWith("/") || configDir.length > 4_096 || configDir.includes("\0"))) throw new HarnessAccountError("HARNESS_ACCOUNT_INVALID", "harness account folder is invalid")
  if (apiKey !== undefined && typeof apiKey !== "function") throw new HarnessAccountError("HARNESS_ACCOUNT_INVALID", "harness account key is invalid")
  return Object.freeze({ ...(configDir === undefined ? {} : { configDir }), ...(apiKey === undefined ? {} : { apiKey: apiKey as () => Promise<string> }) })
}

/** The variables that point `backend` at the account's folder; empty for the tool's usual one. */
export function harnessAccountEnvironment(backend: string, account: HarnessAccountOptions | undefined): Readonly<Record<string, string>> {
  if (account?.configDir === undefined) return Object.freeze({})
  const name = HARNESS_ACCOUNT_CONFIG_VARIABLES[backend]
  if (name === undefined) throw new HarnessAccountError("HARNESS_ACCOUNT_UNSUPPORTED", `${backend} cannot run as a separate account`)
  return Object.freeze({ [name]: account.configDir })
}

export interface HarnessAccountCommand {
  readonly command: string
  readonly args: readonly string[]
  /** Set on top of the user's environment. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The tool's own sign-in command for an account, for a terminal the person sees: Runrail never
 * handles what the tool stores. Codex signs in with a device code, which needs no local port
 * (Runrail's ChatGPT sign-in uses the same port as `codex login`).
 */
export function harnessLoginCommand(backend: string, configDir?: string): HarnessAccountCommand | undefined {
  const env = harnessAccountEnvironment(backend, configDir === undefined ? undefined : { configDir })
  if (backend === "claude-code") return Object.freeze({ command: "claude", args: Object.freeze(["auth", "login", "--claudeai"]), env })
  if (backend === "codex") return Object.freeze({ command: "codex", args: Object.freeze(["login", "--device-auth"]), env })
  return undefined
}

export function harnessLogoutCommand(backend: string, configDir?: string): HarnessAccountCommand | undefined {
  const env = harnessAccountEnvironment(backend, configDir === undefined ? undefined : { configDir })
  if (backend === "claude-code") return Object.freeze({ command: "claude", args: Object.freeze(["auth", "logout"]), env })
  if (backend === "codex") return Object.freeze({ command: "codex", args: Object.freeze(["logout"]), env })
  return undefined
}

export interface HarnessLogoutOptions {
  /** Stands in for the tool's command, for a wrapper or a test double; `args` go before the tool's own. */
  readonly command?: { readonly command: string; readonly args?: readonly string[] }
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}

/** Runs the tool's own sign-out for an account. True when the tool said it is done. */
export async function runHarnessLogout(backend: string, configDir: string | undefined, options: HarnessLogoutOptions = {}): Promise<boolean> {
  const logout = harnessLogoutCommand(backend, configDir)
  if (logout === undefined) throw new HarnessAccountError("HARNESS_ACCOUNT_UNSUPPORTED", `${backend} has no sign-out Runrail can run`)
  if (!isRouteEnvironment(logout.env)) throw new HarnessAccountError("HARNESS_ACCOUNT_INVALID", "harness account folder is invalid")
  const timeoutMs = options.timeoutMs ?? 15_000
  const child = Bun.spawn([options.command?.command ?? logout.command, ...(options.command?.args ?? []), ...logout.args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, env: { ...filteredEnvironment(options.env), ...logout.env } })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs) })
  try {
    const outcome = await Promise.race([child.exited, timedOut])
    if (outcome === "timeout") {
      await terminateProcessTree({ pid: child.pid, exited: child.exited, kill: (signal) => void child.kill(signal) })
      return false
    }
    return outcome === 0
  } finally {
    clearTimeout(timer)
  }
}
