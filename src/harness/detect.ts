import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { terminateProcessTree } from "../backend/process-tree.ts"
import { RUNRAIL_VERSION } from "../version.ts"
import { filteredEnvironment } from "../workspace/policy.ts"
import { isRouteEnvironment } from "./auth.ts"
import { COPILOT_EFFORTS } from "./copilot.ts"
import { listClaudeCodeModels, withClaudeCatalog } from "./claude-models.ts"
import { CLAUDE_CODE_EFFORTS, CLAUDE_CODE_MODELS, isHarnessModelId } from "./launch.ts"
import { claudeCodeProxy, codexProxy, type HarnessProxy } from "./proxy.ts"
import type { HarnessModelDescriptor } from "./types.ts"

/**
 * What asking an installed coding CLI about itself found. Every probe runs the CLI's own
 * commands; Runrail never opens the CLI's credential or session files, and reads only the API
 * address from its settings file (`proxy`). A field that is absent was not learned, which is not
 * the same as "no".
 */
export interface HarnessProbe {
  readonly installed: boolean
  readonly version?: string
  readonly signedIn?: boolean
  readonly models?: readonly HarnessModelDescriptor[]
  readonly efforts?: readonly string[]
  readonly freeTextModel?: boolean
  /** Where the tool's own settings send its model requests, when that is not its vendor. */
  readonly proxy?: HarnessProxy
}

export interface HarnessProbeCommand {
  readonly command: string
  /** Placed before the probe's own arguments, for a wrapper or a test double. */
  readonly args?: readonly string[]
}

export interface HarnessProbeOptions {
  readonly commands?: Readonly<Partial<Record<HarnessProbeTarget, HarnessProbeCommand>>>
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Set on top of the filtered environment, such as a connection's own config folder. Never a credential. */
  readonly routeEnv?: Readonly<Record<string, string>>
  /** Bound for each command a probe runs. */
  readonly timeoutMs?: number
  /** False to skip asking for models where that takes a tool start of its own (Claude Code): a status check. */
  readonly models?: boolean
}

export type HarnessProbeTarget = "claude-code" | "codex" | "copilot" | "opencode" | "gemini" | "goose" | "pi"

export const HARNESS_PROBE_TARGETS: readonly HarnessProbeTarget[] = Object.freeze(["claude-code", "codex", "copilot", "opencode", "gemini", "goose", "pi"])

const DEFAULT_COMMAND: Readonly<Record<HarnessProbeTarget, string>> = Object.freeze({ "claude-code": "claude", codex: "codex", copilot: "copilot", opencode: "opencode", gemini: "gemini", goose: "goose", pi: "pi" })
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024
const MAX_SERVER_OUTPUT_BYTES = 1024 * 1024
const MAX_MODELS = 64
const MAX_EFFORTS = 8
const VERSION = /\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.+-]{1,32})?/
const EFFORT = /^[a-z][a-z0-9-]{0,31}$/

const NOT_INSTALLED: HarnessProbe = Object.freeze({ installed: false })

export function isHarnessProbeTarget(value: unknown): value is HarnessProbeTarget {
  return value === "claude-code" || value === "codex" || value === "copilot" || value === "opencode" || value === "gemini" || value === "goose" || value === "pi"
}

export async function probeHarness(target: HarnessProbeTarget, options: HarnessProbeOptions = {}): Promise<HarnessProbe> {
  const probe = resolveProbe(target, options)
  if (target === "claude-code") return probeClaudeCode(probe)
  // The same pick a thread makes, so the models listed are the ones the thread's CLI offers.
  if (target === "codex") return probeCodex(options.commands?.codex === undefined ? { ...probe, argv: Object.freeze([await resolveCodexCommand({ ...(options.env === undefined ? {} : { env: options.env }), timeoutMs: probe.timeoutMs })]) } : probe)
  if (target === "copilot") return probeCopilot(probe)
  if (target === "opencode") return probeOpenCode(probe)
  if (target === "gemini" || target === "goose") return probeVersionOnly(probe)
  return probePi(probe)
}

interface ResolvedProbe {
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  readonly timeoutMs: number
  readonly models: boolean
}

function resolveProbe(target: HarnessProbeTarget, options: HarnessProbeOptions): ResolvedProbe {
  const configured = options.commands?.[target]
  const command = configured?.command ?? DEFAULT_COMMAND[target]
  if (typeof command !== "string" || command.length === 0 || command.length > 4_096 || command.includes("\0")) throw new TypeError("harness probe command is invalid")
  const args = configured?.args ?? []
  if (!Array.isArray(args) || args.length > 16 || args.some((arg) => typeof arg !== "string" || arg.length > 4_096 || arg.includes("\0"))) throw new TypeError("harness probe arguments are invalid")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError("harness probe timeout is invalid")
  if (options.routeEnv !== undefined && !isRouteEnvironment(options.routeEnv)) throw new TypeError("harness probe route environment is invalid")
  // The same environment a turn runs with, so a probe sees the login a turn would use.
  return { argv: Object.freeze([command, ...args]), env: { ...filteredEnvironment(options.env), ...options.routeEnv }, timeoutMs, models: options.models !== false }
}

export interface CodexCommandOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Copies of the CLI outside PATH to compare with. Defaults to the Codex desktop app's own copy. */
  readonly appCommands?: readonly string[]
  readonly timeoutMs?: number
}

const CODEX_APP_BUNDLES = Object.freeze(["ChatGPT.app", "Codex.app"])
const CODEX_APP_CLI = "Contents/Resources/codex-cli/bin/codex"
const CODEX_VERSION = /\bcodex-cli (\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,32}))?/
const codexVersions = new Map<string, { readonly stamp: string; readonly version?: CodexVersion }>()

type CodexVersion = readonly [number, number, number, string | undefined]

/**
 * The Codex CLI a thread runs: `codex` on PATH, unless the Codex desktop app carries a strictly
 * newer copy. The app updates its copy itself, so without this a model the app already offers
 * would be missing here until the PATH install is updated by hand. `RUNRAIL_CODEX_APP_SEARCH=off`
 * keeps to PATH. Returns the bare `codex` when PATH wins or nothing is found.
 */
export async function resolveCodexCommand(options: CodexCommandOptions = {}): Promise<string> {
  const env = filteredEnvironment(options.env)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const onPath = Bun.which("codex", { PATH: env.PATH ?? "" })
  let best: { readonly command: string; readonly version: CodexVersion } | undefined
  if (onPath !== null) {
    const version = await codexVersion(onPath, env, timeoutMs, false)
    // A PATH install whose version cannot be read is the user's own choice; it is kept.
    if (version === undefined) return "codex"
    best = { command: "codex", version }
  }
  for (const command of options.appCommands ?? defaultCodexAppCommands()) {
    const version = await codexVersion(command, env, timeoutMs, true)
    if (version !== undefined && (best === undefined || compareCodexVersions(version, best.version) > 0)) best = { command, version }
  }
  return best?.command ?? "codex"
}

function defaultCodexAppCommands(): readonly string[] {
  if (process.platform !== "darwin" || process.env.RUNRAIL_CODEX_APP_SEARCH === "off") return []
  return ["/Applications", join(homedir(), "Applications")].flatMap((root) => CODEX_APP_BUNDLES.map((bundle) => join(root, bundle, CODEX_APP_CLI)))
}

async function codexVersion(command: string, env: Record<string, string>, timeoutMs: number, appCopy: boolean): Promise<CodexVersion | undefined> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(command)
  } catch {
    return undefined
  }
  if (!info.isFile()) return undefined
  // A copy another account could have replaced is never run.
  if (appCopy && ((Number(info.mode) & 0o022) !== 0 || (Number(info.uid) !== 0 && Number(info.uid) !== process.getuid?.()))) return undefined
  const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
  const known = codexVersions.get(command)
  if (known?.stamp === stamp) return known.version
  const result = await runCommand({ argv: [command], env, timeoutMs, models: false }, ["--version"])
  // A run cut off at its time limit says nothing; the next look asks again.
  if (result?.exitCode === undefined) return undefined
  const match = result.exitCode === 0 ? CODEX_VERSION.exec(result.stdout.slice(0, 1_024)) : null
  const version: CodexVersion | undefined = match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3]), match[4]]
  if (codexVersions.size >= 16) codexVersions.clear()
  codexVersions.set(command, { stamp, ...(version === undefined ? {} : { version }) })
  return version
}

/** Semantic-version order: a pre-release sorts below its release. */
function compareCodexVersions(left: CodexVersion, right: CodexVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number)
    if (difference !== 0) return difference
  }
  if (left[3] === right[3]) return 0
  if (left[3] === undefined) return 1
  if (right[3] === undefined) return -1
  return left[3] < right[3] ? -1 : 1
}

const MAX_PI_MODELS = 256

/**
 * Pi answers `--list-models` with the models it can run on the logins and keys it holds itself.
 * Runrail reads that table and nothing else: which provider a model belongs to, never an account.
 * A Pi that lists no model has nothing to run on, which is what "not signed in" means for it.
 */
async function probePi(probe: ResolvedProbe): Promise<HarnessProbe> {
  const version = await runCommand(probe, ["--version"])
  if (version === undefined) return NOT_INSTALLED
  const base = { installed: true, ...versionField(version.stdout) }
  const listed = await runCommand(probe, ["--list-models"])
  if (listed === undefined) return Object.freeze(base)
  const models = parsePiModels(listed.stdout, listed.exitCode === undefined)
  // Anything but the table or a clean "nothing to list" is an older Pi or a failure: nothing was learned.
  if (models === undefined) return Object.freeze(listed.exitCode === 0 && listed.stdout.trim().length > 0 ? { ...base, signedIn: false, freeTextModel: true } : base)
  return Object.freeze({ ...base, signedIn: models.length > 0, models, freeTextModel: true })
}

/** The table is `provider  model  context  max-out  thinking  images`; a model is named `provider/model`, as Pi's `--model` takes it. */
function parsePiModels(stdout: string, cut: boolean): readonly HarnessModelDescriptor[] | undefined {
  const lines = stdout.split("\n")
  // Output stopped at a bound may end in half a row.
  if (cut) lines.pop()
  const rows = lines.map((line) => line.trim().split(/\s+/)).filter((cells) => cells[0] !== undefined && cells[0].length > 0)
  const header = rows.findIndex((cells) => cells[0] === "provider" && cells[1] === "model")
  if (header < 0) return undefined
  const models: HarnessModelDescriptor[] = []
  const seen = new Set<string>()
  // The column that says whether a model reasons: "yes" or "no".
  const thinking = rows[header]!.indexOf("thinking")
  for (const cells of rows.slice(header + 1)) {
    const [provider, model] = cells
    if (models.length === MAX_PI_MODELS) break
    if (provider === undefined || model === undefined) continue
    const id = `${provider}/${model}`
    if (!isHarnessModelId(id) || seen.has(id)) continue
    seen.add(id)
    const reasons = thinking < 0 ? undefined : cells[thinking] === "yes" ? true : cells[thinking] === "no" ? false : undefined
    models.push(Object.freeze({ id, name: model, ...(reasons === undefined ? {} : { reasoning: reasons }) }))
  }
  return Object.freeze(models)
}

/**
 * The Copilot CLI has no command that answers "is someone signed in" without starting a
 * conversation, and lists its models only inside one. So neither is learned: the model is typed,
 * and a missing login shows when a turn is sent.
 */
async function probeCopilot(probe: ResolvedProbe): Promise<HarnessProbe> {
  const version = await runCommand(probe, ["--version"])
  if (version === undefined) return NOT_INSTALLED
  return Object.freeze({ installed: true, ...versionField(version.stdout), efforts: COPILOT_EFFORTS, freeTextModel: true })
}

/**
 * OpenCode lists the models of every provider it can reach, some of which need no sign-in, so a
 * login is not learned. An effort is part of the model id (`provider/model/high`), not a setting.
 */
async function probeOpenCode(probe: ResolvedProbe): Promise<HarnessProbe> {
  const version = await runCommand(probe, ["--version"])
  if (version === undefined) return NOT_INSTALLED
  const listed = await runCommand(probe, ["models"])
  const models: HarnessModelDescriptor[] = []
  for (const line of (listed?.stdout ?? "").split("\n")) {
    const id = line.trim()
    if (!isHarnessModelId(id) || !id.includes("/") || models.some((model) => model.id === id)) continue
    models.push(Object.freeze({ id, name: id }))
    if (models.length >= MAX_MODELS) break
  }
  return Object.freeze({ installed: true, ...versionField(version.stdout), ...(models.length === 0 ? {} : { models: Object.freeze(models) }), freeTextModel: true })
}

/**
 * Gemini CLI and Goose have no command that lists models or answers "signed in" without starting
 * a conversation. Both take a typed model: Gemini CLI as `--model`, Goose as a config option.
 */
async function probeVersionOnly(probe: ResolvedProbe): Promise<HarnessProbe> {
  const version = await runCommand(probe, ["--version"])
  if (version === undefined) return NOT_INSTALLED
  return Object.freeze({ installed: true, ...versionField(version.stdout), freeTextModel: true })
}

async function probeClaudeCode(probe: ResolvedProbe): Promise<HarnessProbe> {
  const version = await runCommand(probe, ["--version"])
  if (version === undefined) return NOT_INSTALLED
  const status = await runCommand(probe, ["auth", "status", "--json"])
  // Only the one boolean is read; the rest of the document names the account and stays unread.
  const loggedIn = status === undefined ? undefined : booleanField(status.stdout, "loggedIn")
  // Asked of Claude Code itself, so each alias shows the version it runs; the fixed aliases otherwise.
  const listed = probe.models ? await listClaudeCodeModels({ argv: probe.argv, env: probe.env, cwd: homedir(), timeoutMs: probe.timeoutMs }) : undefined
  const proxy = await claudeCodeProxy(probe.env)
  return Object.freeze({
    installed: true,
    ...versionField(version.stdout),
    ...(loggedIn === undefined ? {} : { signedIn: loggedIn }),
    ...(proxy === undefined ? {} : { proxy }),
    models: withClaudeCatalog(listed ?? CLAUDE_CODE_MODELS.map((model) => Object.freeze({ id: model.id, name: model.name }))),
    efforts: CLAUDE_CODE_EFFORTS,
    freeTextModel: true,
  })
}

async function probeCodex(probe: ResolvedProbe): Promise<HarnessProbe> {
  const version = await runCommand(probe, ["--version"])
  if (version === undefined) return NOT_INSTALLED
  const proxy = await codexProxy(probe.env)
  const base = { installed: true, ...versionField(version.stdout), freeTextModel: true, ...(proxy === undefined ? {} : { proxy }) }
  const server = await askCodexServer(probe)
  if (server !== undefined) {
    return Object.freeze({
      ...base,
      ...(server.signedIn === undefined ? {} : { signedIn: server.signedIn }),
      ...(server.models === undefined ? {} : { models: server.models, efforts: unionEfforts(server.models) }),
    })
  }
  // An older CLI without the server still answers the login question with its exit status.
  const status = await runCommand(probe, ["login", "status"])
  return Object.freeze({ ...base, ...(status === undefined || status.exitCode === undefined ? {} : { signedIn: status.exitCode === 0 }) })
}

interface CommandResult {
  readonly stdout: string
  /** Absent when the command was stopped at its time or output bound. */
  readonly exitCode?: number
}

/** `undefined` means the command could not be started at all. */
async function runCommand(probe: ResolvedProbe, args: readonly string[]): Promise<CommandResult | undefined> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    child = Bun.spawn([...probe.argv, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true, env: probe.env })
  } catch {
    return undefined
  }
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    void terminateProcessTree(child)
  }
  const timer = setTimeout(stop, probe.timeoutMs)
  try {
    const stdout = await readBounded(child.stdout, MAX_COMMAND_OUTPUT_BYTES, stop)
    const exitCode = await child.exited
    return stopped ? { stdout } : { stdout, exitCode }
  } catch {
    stop()
    return { stdout: "" }
  } finally {
    clearTimeout(timer)
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) {
      onOverflow()
      break
    }
    text += decoder.decode(chunk, { stream: true })
  }
  return text
}

interface CodexServerAnswer {
  readonly signedIn?: boolean
  readonly models?: readonly HarnessModelDescriptor[]
}

const MODEL_LIST_ID = "runrail-probe-models"
const ACCOUNT_ID = "runrail-probe-account"

/** One short-lived `codex app-server`: which models it offers and whether an account is present. */
async function askCodexServer(probe: ResolvedProbe): Promise<CodexServerAnswer | undefined> {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">
  try {
    child = Bun.spawn([...probe.argv, "app-server", "--listen", "stdio://"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true, env: probe.env })
  } catch {
    return undefined
  }
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    void terminateProcessTree(child)
  }
  const timer = setTimeout(stop, probe.timeoutMs)
  const send = (message: unknown): void => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
      void child.stdin.flush()
    } catch {
      stop()
    }
  }
  let initialized = false
  let models: readonly HarnessModelDescriptor[] | undefined
  let signedIn: boolean | undefined
  let answered = 0
  try {
    send({ id: "runrail-probe-initialize", method: "initialize", params: { clientInfo: { name: "runrail", title: "Runrail", version: RUNRAIL_VERSION }, capabilities: null } })
    const decoder = new TextDecoder()
    let buffer = ""
    let bytes = 0
    reading: for await (const chunk of child.stdout) {
      bytes += chunk.byteLength
      if (bytes > MAX_SERVER_OUTPUT_BYTES) break
      buffer += decoder.decode(chunk, { stream: true })
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = parseRecord(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (message === undefined || message.method !== undefined) continue
        if (message.id === "runrail-probe-initialize") {
          if (message.result === undefined) break reading
          initialized = true
          send({ method: "initialized" })
          send({ id: MODEL_LIST_ID, method: "model/list", params: {} })
          send({ id: ACCOUNT_ID, method: "account/read", params: {} })
        } else if (message.id === MODEL_LIST_ID) {
          answered += 1
          models = codexModels(message.result)
        } else if (message.id === ACCOUNT_ID) {
          answered += 1
          signedIn = codexSignedIn(message.result)
        }
        if (answered === 2) break reading
      }
    }
  } catch {
    // An unreadable server is the same as one that gave no answer.
  } finally {
    clearTimeout(timer)
    stop()
  }
  if (!initialized) return undefined
  return { ...(signedIn === undefined ? {} : { signedIn }), ...(models === undefined ? {} : { models }) }
}

export function codexModels(result: unknown): readonly HarnessModelDescriptor[] | undefined {
  const data = isRecord(result) ? result.data : undefined
  if (!Array.isArray(data)) return undefined
  const models: HarnessModelDescriptor[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    if (models.length >= MAX_MODELS) break
    if (!isRecord(entry) || entry.hidden === true) continue
    const id = isHarnessModelId(entry.model) ? entry.model : isHarnessModelId(entry.id) ? entry.id : undefined
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = typeof entry.displayName === "string" && entry.displayName.length > 0 ? entry.displayName.slice(0, 128) : id
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((effort) => isRecord(effort) && typeof effort.reasoningEffort === "string" && EFFORT.test(effort.reasoningEffort) ? [effort.reasoningEffort] : []).slice(0, MAX_EFFORTS)
      : []
    models.push(Object.freeze({ id, name, ...(entry.isDefault === true ? { default: true } : {}), ...(efforts.length === 0 ? {} : { efforts: Object.freeze(efforts) }) }))
  }
  return Object.freeze(models)
}

/** Reads whether an account exists and nothing about it: the answer also carries an email. */
function codexSignedIn(result: unknown): boolean | undefined {
  if (!isRecord(result)) return undefined
  if (isRecord(result.account)) return true
  if (result.account === null) return result.requiresOpenaiAuth !== true
  return undefined
}

function unionEfforts(models: readonly HarnessModelDescriptor[]): readonly string[] {
  return Object.freeze([...new Set(models.flatMap((model) => model.efforts ?? []))].slice(0, MAX_EFFORTS))
}

function versionField(stdout: string): { readonly version?: string } {
  const match = VERSION.exec(stdout.slice(0, 1_024))
  return match === null ? {} : { version: match[0] }
}

function booleanField(stdout: string, field: string): boolean | undefined {
  const value = parseRecord(stdout)?.[field]
  return typeof value === "boolean" ? value : undefined
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
