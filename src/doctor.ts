import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { CLAUDE_AGENT_SDK, claudeAgentSdkInstallCommand, claudeAgentSdkSource, claudeAgentSdkStatus, type ClaudeAgentSdkSource } from "./backend/claude-agent-sdk.ts"
import { HARNESS_PROBE_TARGETS, probeHarness, type HarnessProbe, type HarnessProbeTarget } from "./harness/detect.ts"
import { listCliSessions } from "./sessions-cli.ts"
import { RUNRAIL_VERSION } from "./version.ts"
import { filteredEnvironment } from "./workspace/policy.ts"

/**
 * `runrail doctor`: what this machine has for Runrail, checked offline. It runs only the installed
 * tools' own version and sign-in commands; it reads no key and sends nothing anywhere.
 */

export type DoctorLevel = "ok" | "warn" | "fail" | "off"

export interface DoctorCheck {
  readonly name: string
  readonly level: DoctorLevel
  readonly detail: string
}

export interface DoctorOptions {
  /** A project folder to check as well. */
  readonly cwd?: string
  readonly accountsDir: string
  readonly sessionsDir: string
  /** Where keys are kept, as the command line would pick it, and whether that is a fallback. */
  readonly credentialStore: { readonly detail: string; readonly fallback: boolean }
  readonly bunVersion?: string
  readonly probe?: (target: HarnessProbeTarget) => Promise<HarnessProbe>
  readonly gitVersion?: (cwd?: string) => Promise<GitAnswer>
  readonly agentSdk?: () => ClaudeAgentSdkSource
  readonly agentSdkInstallCommand?: string
  /** The command that downloads it, as `claude.sdk.status` gives it; `null` for none. */
  readonly agentSdkDownloadCommand?: string | null
}

export interface GitAnswer {
  readonly version?: string
  readonly inRepository?: boolean
}

export const MIN_BUN_VERSION = "1.3.0"
const COMMAND_TIMEOUT_MS = 5_000
const TOOL_NAMES: Readonly<Record<HarnessProbeTarget, string>> = Object.freeze({ "claude-code": "Claude Code", codex: "Codex", copilot: "GitHub Copilot CLI", opencode: "OpenCode", gemini: "Gemini CLI", goose: "Goose", pi: "Pi" })

export async function runDoctor(options: DoctorOptions): Promise<readonly DoctorCheck[]> {
  const probe = options.probe ?? ((target: HarnessProbeTarget) => probeHarness(target, { models: false, timeoutMs: COMMAND_TIMEOUT_MS }).catch((): HarnessProbe => ({ installed: false })))
  const git = options.gitVersion ?? askGit
  const sdk = (options.agentSdk ?? claudeAgentSdkSource)()
  const [tools, gitAnswer, accounts, sessions, saved] = await Promise.all([
    Promise.all(HARNESS_PROBE_TARGETS.map(async (target) => [target, await probe(target)] as const)),
    git(options.cwd),
    writable(options.accountsDir),
    writable(options.sessionsDir),
    listCliSessions(options.sessionsDir).then((list) => list.length, () => undefined),
  ])
  const bun = options.bunVersion ?? Bun.version
  const checks: DoctorCheck[] = [
    { name: "Runrail", level: "ok", detail: RUNRAIL_VERSION },
    atLeast(bun, MIN_BUN_VERSION)
      ? { name: "Bun", level: "ok", detail: bun }
      : { name: "Bun", level: "fail", detail: `${bun}; Runrail needs ${MIN_BUN_VERSION} or later (bun upgrade)` },
    gitAnswer.version === undefined
      ? { name: "git", level: "warn", detail: "not found on PATH; worktrees, reviews and checkpoints need it" }
      : { name: "git", level: "ok", detail: gitAnswer.version },
    accounts
      ? { name: "Sign-ins folder", level: "ok", detail: tilde(options.accountsDir) }
      : { name: "Sign-ins folder", level: "fail", detail: `${tilde(options.accountsDir)} cannot be written` },
    sessions
      ? { name: "Sessions folder", level: "ok", detail: `${tilde(options.sessionsDir)}${saved === undefined ? "" : `, ${saved} saved`}` }
      : { name: "Sessions folder", level: "fail", detail: `${tilde(options.sessionsDir)} cannot be written` },
    { name: "Key store", level: options.credentialStore.fallback ? "warn" : "ok", detail: options.credentialStore.detail },
  ]
  for (const [target, found] of tools) checks.push(toolCheck(target, found))
  const claudeInstalled = tools.some(([target, found]) => target === "claude-code" && found.installed)
  const download = options.agentSdkDownloadCommand === undefined ? claudeAgentSdkStatus().downloadCommand : options.agentSdkDownloadCommand ?? undefined
  checks.push(agentSdkCheck(sdk, claudeInstalled, options.agentSdkInstallCommand ?? claudeAgentSdkInstallCommand(), download))
  if (options.cwd !== undefined) {
    checks.push(gitAnswer.inRepository === true
      ? { name: "Project", level: "ok", detail: `${tilde(options.cwd)} is a git repository` }
      : { name: "Project", level: "warn", detail: `${tilde(options.cwd)} is not a git repository; worktrees and reviews need one` })
  }
  return Object.freeze(checks.map((check) => Object.freeze(check)))
}

export function doctorText(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map((check) => check.name.length))
  const mark: Readonly<Record<DoctorLevel, string>> = { ok: "ok  ", warn: "warn", fail: "FAIL", off: "-   " }
  const lines = checks.map((check) => `${mark[check.level]}  ${check.name.padEnd(width)}  ${check.detail}`)
  const failed = checks.filter((check) => check.level === "fail").length
  const warned = checks.filter((check) => check.level === "warn").length
  lines.push("", failed > 0 ? `${failed} problem${failed === 1 ? "" : "s"} to fix.` : warned > 0 ? `Ready, with ${warned} warning${warned === 1 ? "" : "s"}.` : "Ready.")
  lines.push("To test a saved sign-in, run: runrail auth doctor <connection>")
  return `${lines.join("\n")}\n`
}

function agentSdkCheck(sdk: ClaudeAgentSdkSource, claudeInstalled: boolean, installCommand: string, downloadCommand: string | undefined): DoctorCheck {
  const name = "Claude Agent SDK"
  if (sdk === "missing") return { name, level: claudeInstalled ? "warn" : "off", detail: `not installed, so Claude Code runs in print mode and cannot ask before tools. Install it with: ${installCommand} (${CLAUDE_AGENT_SDK.npmUrl})` }
  if (sdk === "installable") {
    const detail = downloadCommand === undefined ? "not downloaded yet; Runrail Desktop downloads it when you allow it" : `not downloaded yet, so Claude Code runs in print mode and cannot ask before tools. Download it with: ${downloadCommand} (${CLAUDE_AGENT_SDK.npmUrl})`
    return { name, level: claudeInstalled ? "warn" : "off", detail }
  }
  return { name, level: "ok", detail: `${sdk === "fetched" ? "fetched from npm when first needed" : sdk}; Claude Code asks before each tool` }
}

function toolCheck(target: HarnessProbeTarget, found: HarnessProbe): DoctorCheck {
  const name = TOOL_NAMES[target]
  if (!found.installed) return { name, level: "off", detail: "not installed" }
  const version = found.version ?? "version unknown"
  if (found.signedIn === false) return { name, level: "warn", detail: `${version}, not signed in` }
  return { name, level: "ok", detail: found.signedIn === true ? `${version}, signed in` : version }
}

/** Whether the folder, or the nearest folder above it that exists, can be written. */
async function writable(path: string): Promise<boolean> {
  let current = resolve(path)
  for (;;) {
    try {
      await access(current, constants.W_OK)
      return true
    } catch (error) {
      const parent = dirname(current)
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || parent === current) return false
      current = parent
    }
  }
}

async function askGit(cwd?: string): Promise<GitAnswer> {
  const env = filteredEnvironment()
  const git = Bun.which("git", { PATH: env.PATH ?? "" })
  if (git === null) return {}
  const version = (await run([git, "--version"], env))?.match(/\d+\.\d+(?:\.\d+)?/)?.[0]
  if (cwd === undefined) return version === undefined ? {} : { version }
  const inside = (await run([git, "-C", cwd, "rev-parse", "--is-inside-work-tree"], env))?.trim() === "true"
  return { ...(version === undefined ? {} : { version }), inRepository: inside }
}

async function run(argv: readonly string[], env: Record<string, string>): Promise<string | undefined> {
  const child = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS)
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return code === 0 ? out.slice(0, 4_096) : undefined
  } finally {
    clearTimeout(timer)
  }
}

function atLeast(version: string, minimum: string): boolean {
  const have = version.split(/[.+-]/).slice(0, 3).map(Number)
  const need = minimum.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    const a = have[index] ?? 0
    const b = need[index] ?? 0
    if (!Number.isFinite(a)) return false
    if (a !== b) return a > b
  }
  return true
}

function tilde(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
