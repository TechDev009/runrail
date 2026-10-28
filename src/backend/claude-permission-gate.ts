import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { isToolConfigPath } from "../workspace/policy.ts"

/**
 * Claude Code runs some calls without asking: commands it judges read-only, and whatever the
 * person's own settings allow. Under Ask and Auto-edit Runrail asks before every edit, command and
 * network call, as its own loop does, so a PreToolUse hook answers "ask" and the call reaches
 * `canUseTool`. That answer also passes over Claude Code's allow rules, so Runrail keeps the
 * rules a person allowed for the session itself.
 */

/** A PreToolUse hook's answer, in the shape Claude Code reads. `{}` leaves the call to Claude Code. */
export type ClaudeSdkHookOutput = {
  readonly hookSpecificOutput?: { readonly hookEventName: "PreToolUse"; readonly permissionDecision: "ask"; readonly permissionDecisionReason: string }
}

export type ClaudeSdkHookCallback = (input: unknown, toolUseId: string | undefined, options: { readonly signal: AbortSignal }) => Promise<ClaudeSdkHookOutput>

export interface ClaudeSdkHookMatcher {
  readonly hooks: readonly ClaudeSdkHookCallback[]
}

/** An allow rule from Claude Code's suggestion, as `Bash(npm test:*)` names it: the tool and its content. */
export interface ClaudeSessionGrant {
  readonly tool: string
  readonly content?: string
}

/** Calls that read, plan, or keep Claude Code's own lists. A subagent's own calls are gated one by one. */
const UNGATED_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "LSP",
  "TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "TaskOutput", "BashOutput", "TaskStop", "KillShell", "KillBash",
  "Agent", "Task", "ToolSearch", "Skill", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
])
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
export const EDIT_TOOL_NAMES: ReadonlySet<string> = EDIT_TOOLS
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"])
const ASK_REASON = "Runrail asks the person before edits, commands, and network calls"
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const MAX_RULES = 16
const MAX_RULE_CHARS = 1_024
export const MAX_SESSION_GRANTS = 256
// A prefix rule covers only a plain command: no chaining, substitution, redirection, or escape.
const PLAIN_COMMAND = /^[^;&|`$<>()\\\n\r]*$/

/**
 * Whether Runrail asks before a call in Claude Code's mode at that moment: everything but reads
 * and Claude Code's own bookkeeping in `default`, and also no edits in `acceptEdits`. Plan, auto
 * and bypass are left to Claude Code. Tools the launch lets run unasked stay unasked, except the
 * `askTools` the person must answer in every mode (a connector write, an Ask grant).
 */
export function claudeCallGated(toolName: string, permissionMode: string, allowedTools: readonly string[] = [], askTools: readonly string[] = []): boolean {
  if (askTools.includes(toolName)) return true
  const mode = permissionMode === "manual" ? "default" : permissionMode
  if (mode !== "default" && mode !== "acceptEdits") return false
  if (UNGATED_TOOLS.has(toolName)) return false
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return false
  return !allowedTools.some((entry) => entry === toolName || (entry.startsWith("mcp__") && toolName.startsWith(`${entry}__`)))
}

/**
 * The PreToolUse hook. Claude Code reports the mode it is in, which can differ from the launch:
 * an unavailable auto mode falls back to `default`, and a session answer can switch to
 * `acceptEdits`. A call the hook cannot read is asked about.
 */
export function claudeAskGate(launchMode: string, allowedTools: readonly string[] = [], askTools: readonly string[] = [], cwd?: string): ClaudeSdkHookCallback {
  const ask: ClaudeSdkHookOutput = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: ASK_REASON }) })
  return async (input) => {
    if (!isRecord(input) || typeof input.tool_name !== "string") return ask
    const mode = typeof input.permission_mode === "string" ? input.permission_mode : launchMode
    const base = typeof input.cwd === "string" ? input.cwd : cwd
    if (base !== undefined && claudeEditsControlPath(input.tool_name, input.tool_input, base)) return ask
    return claudeCallGated(input.tool_name, mode, allowedTools, askTools) ? ask : {}
  }
}

/**
 * An edit to git's own files, the project's `.runrail` folder, or the `.nifra/extensions` the engine
 * imports, which decide what runs later (hooks, filters, plugins, setups, extension code). It is
 * asked about in every mode, Full access included.
 */
export function claudeEditsControlPath(toolName: string, toolInput: unknown, cwd: string): boolean {
  if (!EDIT_TOOLS.has(toolName)) return false
  if (!isRecord(toolInput)) return true
  const target = typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.notebook_path === "string" ? toolInput.notebook_path : undefined
  if (target === undefined) return true
  const lexical = resolve(cwd, target)
  const named = segmentsUnder(cwd, lexical)
  if (named === undefined) return false
  if (isControlPath(named)) return true
  // A link checked into the project can reach its control files under another name, and
  // Claude Code's own tools follow it. A target that cannot be resolved is asked about.
  const root = realTarget(cwd)
  const real = realTarget(lexical)
  if (root === undefined || real === undefined) return true
  const reached = segmentsUnder(root, real)
  return reached === undefined || isControlPath(reached)
}

function segmentsUnder(root: string, path: string): readonly string[] | undefined {
  const inside = relative(root, path)
  if (isAbsolute(inside)) return undefined
  const segments = inside.split(/[\\/]/).map((segment) => segment.toLowerCase())
  return segments[0] === ".." ? undefined : segments
}

function isControlPath(segments: readonly string[]): boolean {
  return segments.includes(".git") || segments[0] === ".runrail" || (segments[0] === ".nifra" && segments[1] === "extensions") || isToolConfigPath(segments)
}

/** The real path of `path` through its nearest existing ancestor, following links, dangling ones too. */
function realTarget(path: string, hops = 0): string | undefined {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch (error) {
      if (!isMissing(error)) return undefined
    }
    let link: string | undefined
    try {
      const info = lstatSync(current)
      if (!info.isSymbolicLink()) return undefined
      link = readlinkSync(current)
    } catch (error) {
      if (!isMissing(error)) return undefined
    }
    if (link !== undefined) return hops >= 32 ? undefined : realTarget(join(resolve(dirname(current), link), ...missing.reverse()), hops + 1)
    const parent = dirname(current)
    if (parent === current) return undefined
    missing.push(basename(current))
    current = parent
  }
}

function isMissing(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

/** The allow rules in Claude Code's suggestions. A rule whose content cannot be read is dropped, never widened to the whole tool. */
export function claudeSessionGrants(suggestions: readonly unknown[]): readonly ClaudeSessionGrant[] {
  const grants: ClaudeSessionGrant[] = []
  for (const suggestion of suggestions) {
    if (!isRecord(suggestion) || suggestion.type !== "addRules" || suggestion.behavior !== "allow" || !Array.isArray(suggestion.rules)) continue
    for (const rule of suggestion.rules.slice(0, MAX_RULES)) {
      if (!isRecord(rule) || typeof rule.toolName !== "string" || !TOOL_NAME.test(rule.toolName)) continue
      if (rule.ruleContent === undefined) grants.push(Object.freeze({ tool: rule.toolName }))
      else if (typeof rule.ruleContent === "string" && rule.ruleContent.trim().length > 0 && rule.ruleContent.length <= MAX_RULE_CHARS) grants.push(Object.freeze({ tool: rule.toolName, content: rule.ruleContent }))
    }
  }
  return Object.freeze(grants)
}

/**
 * Whether a session grant covers a call. Kept to what Claude Code's own rule would also cover:
 * a whole tool or MCP server, an exact command, a command prefix (`:*` or a trailing ` *`) over
 * a plain command, or a WebFetch domain. Path rules and other patterns never cover; the person is
 * asked again.
 */
export function claudeGrantCovers(grant: ClaudeSessionGrant, toolName: string, input: Record<string, unknown>): boolean {
  if (grant.content === undefined) return grant.tool === toolName || (grant.tool.startsWith("mcp__") && toolName.startsWith(`${grant.tool}__`))
  if (grant.tool !== toolName) return false
  if (SHELL_TOOLS.has(toolName)) return typeof input.command === "string" && commandCovered(grant.content, input.command)
  if (toolName === "WebFetch") return typeof input.url === "string" && domainCovered(grant.content, input.url)
  return false
}

function commandCovered(rule: string, command: string): boolean {
  const text = command.trim()
  if (text === rule.trim()) return true
  const prefix = rule.endsWith(":*") || rule.endsWith(" *") ? rule.slice(0, -2).trim() : undefined
  if (prefix === undefined || prefix.length === 0 || prefix.includes("*")) return false
  return PLAIN_COMMAND.test(text) && (text === prefix || text.startsWith(`${prefix} `))
}

function domainCovered(rule: string, url: string): boolean {
  if (!rule.startsWith("domain:")) return false
  const host = rule.slice("domain:".length).toLowerCase()
  if (host.length === 0) return false
  try {
    return new URL(url).hostname.toLowerCase() === host
  } catch {
    // An address that does not parse is covered by no domain; the person is asked.
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
