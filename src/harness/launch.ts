import type { BehaviorConfig } from "../behavior/config.ts"

/**
 * What a caller may ask of a vendor coding CLI at launch, in Runrail's words. Each route turns
 * these into that CLI's own flags or protocol fields; nothing here names a vendor flag.
 */
export type HarnessEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
export type HarnessPermissionMode = "plan" | "ask" | "accept-edits" | "auto" | "bypass"

export const HARNESS_EFFORTS: readonly HarnessEffort[] = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
export const HARNESS_PERMISSION_MODES: readonly HarnessPermissionMode[] = Object.freeze(["plan", "ask", "accept-edits", "auto", "bypass"])

export interface HarnessLaunchOptions {
  /** Model alias or id, passed to the CLI as written. */
  readonly model?: string
  readonly effort?: HarnessEffort
  readonly permissionMode?: HarnessPermissionMode
  /** Text added after the CLI's own system prompt. The CLI's prompt is never replaced. */
  readonly appendSystemPrompt?: string
  /** MCP configuration files or JSON documents. Claude Code only. */
  readonly mcpConfig?: readonly string[]
  /** Tools or MCP servers (`mcp__<server>`) that run without asking. Claude Code only. */
  readonly allowedTools?: readonly string[]
  /** Tools that always wait for the person, in every permission mode, even under `allowedTools`. Claude Code only. */
  readonly askTools?: readonly string[]
  /** Vendor session to continue on the first turn. Later turns continue the session the CLI reports. */
  readonly resume?: string
  /** The project's related folders, absolute: Claude Code's `--add-dir`, Codex's writable roots. */
  readonly addDirs?: readonly string[]
}

export type HarnessLaunchErrorCode = "HARNESS_LAUNCH_INVALID"

export class HarnessLaunchError extends Error {
  readonly code: HarnessLaunchErrorCode = "HARNESS_LAUNCH_INVALID"
  constructor(reason: string) {
    super(`harness launch: ${reason}`)
    this.name = "HarnessLaunchError"
  }
}

export interface HarnessModelChoice {
  readonly id: string
  readonly name: string
}

/** Claude Code resolves these aliases itself; any other id can be typed. */
export const CLAUDE_CODE_MODELS: readonly HarnessModelChoice[] = Object.freeze([
  Object.freeze({ id: "fable", name: "Fable" }),
  Object.freeze({ id: "opus", name: "Opus" }),
  Object.freeze({ id: "sonnet", name: "Sonnet" }),
  Object.freeze({ id: "haiku", name: "Haiku" }),
])
export const CLAUDE_CODE_EFFORTS: readonly HarnessEffort[] = Object.freeze(["low", "medium", "high", "xhigh", "max"])

/** Bounds for one turn of a vendor coding CLI. A coding turn runs far longer than a probe. */
export const HARNESS_ROUTE_LIMITS = Object.freeze({ timeoutMs: 3_600_000, maxOutputBytes: 256 * 1024 * 1024, maxEvents: 200_000 })

/**
 * Fixed `claude` arguments for one print-mode turn; per-turn settings follow them.
 * Print mode skips the trust dialog, so only the person's own settings load: a cloned repo's hooks must not run.
 */
export const CLAUDE_CODE_PRINT_ARGS: readonly string[] = Object.freeze(["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--setting-sources", "user"])

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._\-:/@+[\]]{0,127}$/
const VENDOR_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const MAX_APPEND_SYSTEM_PROMPT = 32 * 1024
const MAX_MCP_CONFIGS = 8
const MAX_MCP_CONFIG_CHARS = 4_096
const MAX_ALLOWED_TOOLS = 16
// A bare tool or server name; a pattern with arguments would widen what runs unasked.
const ALLOWED_TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const MAX_ASK_TOOLS = 64
const KEYS: ReadonlySet<string> = new Set(["model", "effort", "permissionMode", "appendSystemPrompt", "mcpConfig", "allowedTools", "askTools", "resume", "addDirs"])
const MAX_ADD_DIRS = 8

/** A vendor session id that is safe to hand back to the CLI as an argument. */
export function isVendorSessionId(value: unknown): value is string {
  return typeof value === "string" && VENDOR_SESSION.test(value)
}

/** A message id in a tool's conversation, such as Claude Code's message uuid. */
export function isMessageMark(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

export function isHarnessModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL.test(value)
}

export function parseHarnessLaunchOptions(value: unknown): HarnessLaunchOptions {
  if (value === undefined) return Object.freeze({})
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HarnessLaunchError("options are invalid")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !KEYS.has(key))) throw new HarnessLaunchError("options hold an unknown field")
  const { model, effort, permissionMode, appendSystemPrompt, mcpConfig, allowedTools, askTools, resume, addDirs } = record
  if (model !== undefined && !isHarnessModelId(model)) throw new HarnessLaunchError("model is invalid")
  if (effort !== undefined && !HARNESS_EFFORTS.includes(effort as HarnessEffort)) throw new HarnessLaunchError("effort is invalid")
  if (permissionMode !== undefined && !HARNESS_PERMISSION_MODES.includes(permissionMode as HarnessPermissionMode)) throw new HarnessLaunchError("permission mode is invalid")
  if (appendSystemPrompt !== undefined && (typeof appendSystemPrompt !== "string" || appendSystemPrompt.length === 0 || appendSystemPrompt.length > MAX_APPEND_SYSTEM_PROMPT || appendSystemPrompt.includes("\0"))) throw new HarnessLaunchError("appended system prompt is invalid")
  if (mcpConfig !== undefined && (!Array.isArray(mcpConfig) || mcpConfig.length > MAX_MCP_CONFIGS || mcpConfig.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > MAX_MCP_CONFIG_CHARS || entry.includes("\0") || entry.startsWith("-")))) throw new HarnessLaunchError("MCP configuration is invalid")
  if (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.length > MAX_ALLOWED_TOOLS || allowedTools.some((entry) => typeof entry !== "string" || !ALLOWED_TOOL.test(entry)))) throw new HarnessLaunchError("allowed tools are invalid")
  if (askTools !== undefined && (!Array.isArray(askTools) || askTools.length > MAX_ASK_TOOLS || askTools.some((entry) => typeof entry !== "string" || !ALLOWED_TOOL.test(entry)))) throw new HarnessLaunchError("ask tools are invalid")
  if (resume !== undefined && !isVendorSessionId(resume)) throw new HarnessLaunchError("resume id is invalid")
  // Absolute, so none is read as a flag or as a path in the tool's own folder.
  if (addDirs !== undefined && (!Array.isArray(addDirs) || addDirs.length > MAX_ADD_DIRS || addDirs.some((entry) => typeof entry !== "string" || !entry.startsWith("/") || entry.length > 4_096 || /[\0\r\n]/.test(entry)))) throw new HarnessLaunchError("added folders are invalid")
  return Object.freeze({
    ...(model === undefined ? {} : { model: model as string }),
    ...(effort === undefined ? {} : { effort: effort as HarnessEffort }),
    ...(permissionMode === undefined ? {} : { permissionMode: permissionMode as HarnessPermissionMode }),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt: appendSystemPrompt as string }),
    ...(mcpConfig === undefined || mcpConfig.length === 0 ? {} : { mcpConfig: Object.freeze([...(mcpConfig as string[])]) }),
    ...(allowedTools === undefined || allowedTools.length === 0 ? {} : { allowedTools: Object.freeze([...new Set(allowedTools as string[])]) }),
    ...(askTools === undefined || askTools.length === 0 ? {} : { askTools: Object.freeze([...new Set(askTools as string[])]) }),
    ...(resume === undefined ? {} : { resume: resume as string }),
    ...(addDirs === undefined || addDirs.length === 0 ? {} : { addDirs: Object.freeze([...new Set(addDirs as string[])]) }),
  })
}

type LaunchBehavior = Pick<BehaviorConfig, "mode" | "effort" | "permissionDefault" | "permissionRules" | "instructionsText">

const EDIT_TOOLS: readonly string[] = Object.freeze(["apply_patch", "write_file", "edit_file"])

/**
 * Fill what the caller left unset from the session's model selection and behavior file, so one
 * set of Runrail settings governs a thread whichever route runs it. Explicit values always win.
 */
export function deriveHarnessLaunch(
  explicit: HarnessLaunchOptions | undefined,
  selection: { readonly id?: string; readonly thinking?: string } | undefined,
  behavior: LaunchBehavior | undefined,
): HarnessLaunchOptions {
  const base = parseHarnessLaunchOptions(explicit)
  if (base.model === undefined && selection?.id !== undefined && !isHarnessModelId(selection.id)) throw new HarnessLaunchError("model is invalid")
  const model = base.model ?? selection?.id
  const effort = base.effort ?? effortFromThinking(selection?.thinking ?? behavior?.effort)
  const permissionMode = base.permissionMode ?? (behavior === undefined ? undefined : behaviorPermissionMode(behavior))
  const instructions = behavior?.instructionsText
  const appendSystemPrompt = base.appendSystemPrompt ?? (instructions === undefined || instructions.length === 0 || instructions.includes("\0") ? undefined : instructions.slice(0, MAX_APPEND_SYSTEM_PROMPT))
  return Object.freeze({
    ...base,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
  })
}

/**
 * Runrail's thinking levels go no lower than the lowest effort every coding CLI accepts. The same
 * mapping holds at launch and for a level changed mid-session; an unknown level maps to nothing.
 */
export function effortFromThinking(thinking: string | undefined): HarnessEffort | undefined {
  if (thinking === undefined) return undefined
  if (thinking === "off" || thinking === "minimal") return "low"
  return HARNESS_EFFORTS.includes(thinking as HarnessEffort) ? thinking as HarnessEffort : undefined
}

function behaviorPermissionMode(behavior: LaunchBehavior): HarnessPermissionMode {
  if (behavior.mode === "plan") return "plan"
  // A deny rule has no CLI equivalent, so the person is asked instead of the CLI running it unasked.
  if (behavior.permissionRules.some((rule) => rule.policy === "deny")) return "ask"
  if (behavior.mode === "auto") return behavior.permissionDefault === "allow" ? "bypass" : "auto"
  const edits = EDIT_TOOLS.every((tool) => behavior.permissionRules.some((rule) => rule.tool === tool && rule.match === "*" && rule.policy === "allow"))
  return edits ? "accept-edits" : "ask"
}

/**
 * Claude Code's native builds leave out Grep and Glob unless an allow rule names them, and search
 * through Bash, which Runrail asks about. Kept to the working folder, the rules allow nothing Claude
 * Code would not: a search outside it is still asked about, where a bare `Grep` would allow it.
 */
export const CLAUDE_SEARCH_TOOL_RULES: readonly string[] = Object.freeze(["Grep(./**)", "Glob(./**)"])

const CLAUDE_PERMISSION_MODE: Readonly<Record<HarnessPermissionMode, string>> = Object.freeze({
  plan: "plan",
  // Named so the user's own Claude Code default cannot be wider than what Runrail shows.
  ask: "manual",
  "accept-edits": "acceptEdits",
  auto: "auto",
  bypass: "bypassPermissions",
})

/**
 * Arguments for one `claude --print` run. The prompt goes on stdin, so no positional follows and
 * the variadic `--mcp-config` cannot swallow it.
 */
export function claudeCodeLaunchArguments(options: HarnessLaunchOptions, vendorSessionId?: string, fork = false, at?: string): readonly string[] {
  const args: string[] = []
  if (options.mcpConfig !== undefined && options.mcpConfig.length > 0) args.push("--mcp-config", ...options.mcpConfig)
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir)
  args.push("--allowedTools", ...(options.allowedTools ?? []), ...CLAUDE_SEARCH_TOOL_RULES)
  // A print run has no one to ask, so a tool that must ask is refused up front rather than at its call.
  if (options.askTools !== undefined && options.askTools.length > 0) args.push("--disallowedTools", ...options.askTools)
  if (options.model !== undefined) args.push("--model", options.model)
  // Claude Code's levels run from low to max.
  if (options.effort !== undefined) args.push("--effort", options.effort === "minimal" ? "low" : options.effort === "ultra" ? "max" : options.effort)
  if (options.permissionMode !== undefined) args.push("--permission-mode", CLAUDE_PERMISSION_MODE[options.permissionMode])
  // The `=` form keeps text that starts with a hyphen from being read as a flag.
  if (options.appendSystemPrompt !== undefined) args.push(`--append-system-prompt=${options.appendSystemPrompt}`)
  const resume = vendorSessionId ?? options.resume
  if (resume !== undefined && isVendorSessionId(resume)) {
    args.push("--resume", resume, ...(fork ? ["--fork-session"] : []))
    // A rewind continues a copy from the turn it went back to; the original stays whole.
    if (fork && at !== undefined && isMessageMark(at)) args.push(`--resume-session-at=${at}`)
  }
  return Object.freeze(args)
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never"
/** Who answers Codex's approval requests: the person, or Codex's own reviewer ("Approve for me" in Codex). */
export type CodexApprovalsReviewer = "user" | "auto_review"

/** Codex names its own levels, Max and Ultra included; each model lists the ones it takes. */
export function codexEffort(effort: HarnessEffort): string {
  return effort
}

const CODEX_EFFORT_ORDER: readonly string[] = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])

/** A level the model does not list runs as the highest it lists below that level, else its lowest. */
export function codexEffortFor(effort: string, listed: readonly string[] | undefined): string {
  if (listed === undefined || listed.length === 0 || listed.includes(effort)) return effort
  const rank = (level: string): number => CODEX_EFFORT_ORDER.indexOf(level)
  const ranked = listed.filter((level) => rank(level) >= 0).sort((a, b) => rank(a) - rank(b))
  return ranked.filter((level) => rank(level) <= rank(effort)).at(-1) ?? ranked[0] ?? effort
}

// The reviewer is named in every mode, so the person's own Codex default cannot answer for them under Ask.
const CODEX_THREAD_POLICY: Readonly<Record<HarnessPermissionMode, { readonly approvalPolicy: CodexApprovalPolicy; readonly sandbox: CodexSandboxMode; readonly approvalsReviewer: CodexApprovalsReviewer }>> = Object.freeze({
  plan: { approvalPolicy: "never", sandbox: "read-only", approvalsReviewer: "user" },
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write", approvalsReviewer: "user" },
  "accept-edits": { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" },
  bypass: { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" },
})

export interface CodexThreadParameters {
  readonly model?: string
  readonly approvalPolicy?: CodexApprovalPolicy
  readonly approvalsReviewer?: CodexApprovalsReviewer
  readonly sandbox?: CodexSandboxMode
  readonly developerInstructions?: string
  readonly config?: Readonly<Record<string, unknown>>
}

/** Fields shared by app-server `thread/start` and `thread/resume`. */
export function codexThreadParameters(options: HarnessLaunchOptions): CodexThreadParameters {
  const policy = options.permissionMode === undefined ? undefined : CODEX_THREAD_POLICY[options.permissionMode]
  return Object.freeze({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(policy === undefined ? {} : { approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandbox: policy.sandbox }),
    ...(options.appendSystemPrompt === undefined ? {} : { developerInstructions: options.appendSystemPrompt }),
    ...(options.addDirs === undefined ? {} : { config: { "sandbox_workspace_write.writable_roots": [...options.addDirs] } }),
  })
}

/** `codex exec` cannot ask, so a mode that would ask runs read-only instead. */
const CODEX_EXEC_SANDBOX: Readonly<Record<HarnessPermissionMode, CodexSandboxMode>> = Object.freeze({
  plan: "read-only",
  ask: "read-only",
  "accept-edits": "workspace-write",
  auto: "workspace-write",
  bypass: "danger-full-access",
})

/**
 * The whole argument list for one `codex exec` run; the prompt is read from stdin (`-`).
 * `exec resume` takes no sandbox flag, so every setting travels as a config override.
 */
export function codexExecLaunchArguments(options: HarnessLaunchOptions, vendorSessionId?: string): readonly string[] {
  const settings: string[] = []
  if (options.model !== undefined) settings.push("-m", options.model)
  if (options.effort !== undefined) settings.push("-c", `model_reasoning_effort=${codexEffort(options.effort)}`)
  if (options.permissionMode !== undefined) settings.push("-c", `sandbox_mode=${CODEX_EXEC_SANDBOX[options.permissionMode]}`)
  // A JSON string is a TOML basic string, so the text is never parsed as another TOML type.
  if (options.appendSystemPrompt !== undefined) settings.push("-c", `developer_instructions=${JSON.stringify(options.appendSystemPrompt)}`)
  // A JSON array of strings is a TOML array; `exec resume` takes no `--add-dir`, so it travels as config too.
  if (options.addDirs !== undefined) settings.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(options.addDirs)}`)
  const resume = vendorSessionId ?? options.resume
  if (resume !== undefined && isVendorSessionId(resume)) return Object.freeze(["exec", "resume", "--json", ...settings, resume, "-"])
  return Object.freeze(["exec", "--json", ...settings, "-"])
}
