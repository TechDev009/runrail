import { readFile, realpath, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { NativeApprovalPort, NativeTool } from "@nifrajs/coding-agent"
import { INTEGRATION_GRANTS, type IntegrationGrant, type IntegrationGrants } from "../connectors/tools.ts"
import { wildcardMatch } from "../workspace/wildcard.ts"

/**
 * File-based agent behavior configuration.
 *
 * The desktop merges global, repo-local, and thread scopes and writes one
 * `<session-dir>/config.json` before spawn. The engine reads it at every
 * session creation: strict on first load (bad config fails launch
 * recoverably), last-good fallback on later reloads so a transient IO
 * failure never nukes a running session. Unknown keys are ignored.
 */

export type BehaviorMode = "ask" | "auto" | "plan"
export type BehaviorEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max"
export type BehaviorPolicy = "allow" | "ask" | "deny"

export interface BehaviorPermissionRule {
  readonly tool: string
  readonly match: string
  readonly policy: BehaviorPolicy
}

/** A local MCP server the session starts for Runrail's own loop. Names only for the environment, never values. */
/** A local server the engine starts and talks to over standard input and output. */
export interface BehaviorMcpStdioServer {
  readonly transport: "stdio"
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  /** Variables of the engine's own environment the server also gets, such as its access token. */
  readonly env: readonly string[]
  readonly enabled: boolean
  readonly readOnlyTools?: readonly string[]
}

/** A server reached over Streamable HTTP. */
export interface BehaviorMcpHttpServer {
  readonly transport: "http"
  readonly name: string
  /** `https`, or `http` on this machine only. */
  readonly url: string
  /** A variable of the engine's own environment whose value is sent as `Authorization: Bearer`. */
  readonly bearerEnv?: string
  readonly enabled: boolean
  readonly readOnlyTools?: readonly string[]
}

export type BehaviorMcpServer = BehaviorMcpStdioServer | BehaviorMcpHttpServer

export interface BehaviorConfig {
  readonly mode: BehaviorMode
  readonly effort: BehaviorEffort
  readonly instructionsText?: string
  readonly permissionDefault: BehaviorPolicy
  readonly permissionRules: readonly BehaviorPermissionRule[]
  readonly compactionEnabled: boolean
  readonly mcpServers: readonly BehaviorMcpServer[]
  /** `skills.userRoots`: also read the user-wide skill folders in place, below the project's own. */
  readonly userSkillRoots: boolean
  /** Who may use what: this thread's grant per connector id or `mcp:<server>`; one left out is Write. */
  readonly integrations?: IntegrationGrants
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = Object.freeze({
  mode: "ask",
  effort: "medium",
  permissionDefault: "ask",
  permissionRules: Object.freeze([]),
  compactionEnabled: true,
  mcpServers: Object.freeze([]),
  userSkillRoots: false,
})

export class BehaviorConfigError extends Error {
  constructor(reason: string) {
    super(`behavior config is invalid: ${reason}`)
    this.name = "BehaviorConfigError"
  }
}

const MAX_CONFIG_BYTES = 256 * 1024
const MAX_INSTRUCTIONS_CHARS = 8 * 1024
const MAX_RULES = 128
export const MAX_MCP_SERVERS = 16
export const MCP_SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Tools that mutate the world. Everything else is a read. */
export const BEHAVIOR_MUTATING_TOOLS: readonly string[] = Object.freeze([
  "apply_patch",
  "write_file",
  "edit_file",
  "run_command",
  "run_verification",
])

// Tools that leave the workspace as it is. `update_plan` only shares the agent's plan, so it
// needs no approval and stays available in plan mode, where publishing a plan is the point.
const BEHAVIOR_READ_ONLY_TOOLS = new Set(["read_file", "list_files", "find_files", "search_files", "update_plan", "skill_read"])

/** Resolve which config file governs a session. Explicit flag wins. */
export function resolveBehaviorConfigPath(explicitPath: string | undefined, sessionDir: string | undefined): string | undefined {
  if (explicitPath !== undefined) return explicitPath
  if (sessionDir === undefined) return undefined
  return join(sessionDir, "config.json")
}

/**
 * Strict load: missing file, oversize, malformed JSON, wrong version, or
 * out-of-bounds values all throw. Content-free messages only — file content
 * (user instructions) is never echoed.
 */
export async function loadBehaviorConfigFile(filePath: string, options: { readonly cwd: string }): Promise<BehaviorConfig> {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (error) {
    if (isNotFound(error)) throw new BehaviorConfigError("config file is missing")
    throw new BehaviorConfigError("config file is unreadable")
  }
  if (!Number.isSafeInteger(size) || size > MAX_CONFIG_BYTES) throw new BehaviorConfigError("config file is too large")
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch {
    throw new BehaviorConfigError("config file is unreadable")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BehaviorConfigError("config file is not valid JSON")
  }
  if (!isRecord(parsed)) throw new BehaviorConfigError("config file must be an object")
  if (parsed.version !== 1) throw new BehaviorConfigError("config version is unsupported")
  const mode = parsed.mode === undefined ? DEFAULT_BEHAVIOR_CONFIG.mode : parsed.mode
  if (mode !== "ask" && mode !== "auto" && mode !== "plan") throw new BehaviorConfigError("mode is invalid")
  const effort = parsed.effort === undefined ? DEFAULT_BEHAVIOR_CONFIG.effort : parsed.effort
  if (effort !== "off" && effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "xhigh" && effort !== "max") throw new BehaviorConfigError("effort is invalid")
  const instructions = await parseInstructions(parsed.instructions, options.cwd)
  const permissions = parsed.permissions === undefined ? undefined : parsed.permissions
  if (permissions !== undefined && !isRecord(permissions)) throw new BehaviorConfigError("permissions are invalid")
  const permissionDefault = permissions?.default === undefined ? DEFAULT_BEHAVIOR_CONFIG.permissionDefault : permissions.default
  if (permissionDefault !== "allow" && permissionDefault !== "ask" && permissionDefault !== "deny") throw new BehaviorConfigError("default policy is invalid")
  const rulesInput = permissions?.rules === undefined ? [] : permissions.rules
  if (!Array.isArray(rulesInput) || rulesInput.length > MAX_RULES) throw new BehaviorConfigError("permission rules are invalid")
  const permissionRules = Object.freeze(rulesInput.map(parseRule))
  const compaction = parsed.compaction === undefined ? undefined : parsed.compaction
  if (compaction !== undefined && !isRecord(compaction)) throw new BehaviorConfigError("compaction is invalid")
  const compactionEnabled = compaction?.enabled === undefined ? DEFAULT_BEHAVIOR_CONFIG.compactionEnabled : compaction.enabled
  if (typeof compactionEnabled !== "boolean") throw new BehaviorConfigError("compaction flag is invalid")
  const mcpServers = parseMcpServers(parsed.mcp)
  const skills = parsed.skills === undefined ? undefined : parsed.skills
  if (skills !== undefined && !isRecord(skills)) throw new BehaviorConfigError("skills are invalid")
  const userSkillRoots = skills?.userRoots === undefined ? DEFAULT_BEHAVIOR_CONFIG.userSkillRoots : skills.userRoots
  if (typeof userSkillRoots !== "boolean") throw new BehaviorConfigError("skills user roots flag is invalid")
  const integrations = parseIntegrations(parsed.integrations)
  return Object.freeze({
    mode,
    effort,
    ...(instructions === undefined ? {} : { instructionsText: instructions }),
    permissionDefault,
    permissionRules,
    compactionEnabled,
    mcpServers,
    userSkillRoots,
    ...(integrations === undefined ? {} : { integrations }),
  })
}

const INTEGRATION_KEY = /^(mcp:)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_INTEGRATIONS = 128

function parseIntegrations(value: unknown): IntegrationGrants | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).length > MAX_INTEGRATIONS) throw new BehaviorConfigError("integrations are invalid")
  const grants: Record<string, IntegrationGrant> = {}
  for (const [key, grant] of Object.entries(value)) {
    if (!INTEGRATION_KEY.test(key) || !(INTEGRATION_GRANTS as readonly unknown[]).includes(grant)) throw new BehaviorConfigError("integrations are invalid")
    grants[key] = grant as IntegrationGrant
  }
  return Object.freeze(grants)
}

function parseMcpServers(value: unknown): readonly BehaviorMcpServer[] {
  if (value === undefined) return DEFAULT_BEHAVIOR_CONFIG.mcpServers
  if (!isRecord(value)) throw new BehaviorConfigError("mcp is invalid")
  const servers = value.servers ?? []
  if (!Array.isArray(servers) || servers.length > MAX_MCP_SERVERS) throw new BehaviorConfigError("mcp servers are invalid")
  const names = new Set<string>()
  return Object.freeze(servers.map((server: unknown): BehaviorMcpServer => {
    if (!isRecord(server)) throw new BehaviorConfigError("mcp server is invalid")
    const { name, command } = server
    const args = server.args ?? []
    const env = server.env ?? []
    const enabled = server.enabled ?? true
    if (typeof name !== "string" || !MCP_SERVER_NAME.test(name) || names.has(name)) throw new BehaviorConfigError("mcp server name is invalid")
    names.add(name)
    if (typeof enabled !== "boolean") throw new BehaviorConfigError("mcp server flag is invalid")
    const readOnlyTools = server.readOnlyTools
    if (readOnlyTools !== undefined && (!Array.isArray(readOnlyTools) || readOnlyTools.length > 256 || readOnlyTools.some((tool) => typeof tool !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tool)))) throw new BehaviorConfigError("mcp read-only tools are invalid")
    const admission = readOnlyTools === undefined ? {} : { readOnlyTools: Object.freeze([...readOnlyTools] as string[]) }
    if (server.url !== undefined) {
      if (command !== undefined || server.args !== undefined || server.env !== undefined) throw new BehaviorConfigError("mcp server sets both a url and a command")
      const url = parseMcpUrl(server.url)
      const bearerEnv = server.bearerEnv ?? undefined
      if (bearerEnv !== undefined && (typeof bearerEnv !== "string" || !ENVIRONMENT_NAME.test(bearerEnv))) throw new BehaviorConfigError("mcp server token variable is invalid")
      return Object.freeze({ transport: "http" as const, name, url, ...(bearerEnv === undefined ? {} : { bearerEnv }), enabled, ...admission })
    }
    if (server.bearerEnv !== undefined) throw new BehaviorConfigError("mcp server token variable needs a url")
    // The stdio transport takes a program name or path alone; arguments go in `args`.
    if (typeof command !== "string" || command.length === 0 || command.length > 256 || /\s/.test(command) || command.startsWith("-")) throw new BehaviorConfigError("mcp server command is invalid")
    if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.length > 4_096 || arg.includes("\0"))) throw new BehaviorConfigError("mcp server arguments are invalid")
    if (!Array.isArray(env) || env.length > 16 || env.some((entry) => typeof entry !== "string" || !ENVIRONMENT_NAME.test(entry))) throw new BehaviorConfigError("mcp server environment is invalid")
    return Object.freeze({ transport: "stdio" as const, name, command, args: Object.freeze([...args] as string[]), env: Object.freeze([...env] as string[]), enabled, ...admission })
  }))
}

/** `https` anywhere, plain `http` only to this machine, and never with a user name or password in it. */
function parseMcpUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new BehaviorConfigError("mcp server url is invalid")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BehaviorConfigError("mcp server url is invalid")
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.username.length > 0 || url.password.length > 0 || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) throw new BehaviorConfigError("mcp server url is invalid")
  return url.href
}

async function parseInstructions(value: unknown, cwd: string): Promise<string | undefined> {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new BehaviorConfigError("instructions are invalid")
  const text = value.text ?? undefined
  const file = value.file ?? undefined
  if (text !== undefined && file !== undefined) throw new BehaviorConfigError("instructions set both text and file")
  if (text !== undefined) {
    if (typeof text !== "string" || text.length > MAX_INSTRUCTIONS_CHARS) throw new BehaviorConfigError("instructions text is invalid")
    return text
  }
  if (file !== undefined) {
    if (typeof file !== "string" || file.length === 0 || file.length > 512) throw new BehaviorConfigError("instructions file is invalid")
    const resolved = await resolveWorkspaceFile(cwd, file)
    let content: string
    try {
      content = await readFile(resolved, "utf8")
    } catch {
      throw new BehaviorConfigError("instructions file is unreadable")
    }
    if (content.length > MAX_INSTRUCTIONS_CHARS) throw new BehaviorConfigError("instructions file is too large")
    return content
  }
  return undefined
}

async function resolveWorkspaceFile(cwd: string, relativePath: string): Promise<string> {
  if (relativePath.includes("\0")) throw new BehaviorConfigError("instructions file is invalid")
  const parts = relativePath.split("/")
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new BehaviorConfigError("instructions file escapes the workspace")
  }
  const joined = join(cwd, ...parts)
  let canonical: string
  try {
    canonical = await realpath(joined)
  } catch {
    throw new BehaviorConfigError("instructions file is unreadable")
  }
  const root = await realpath(cwd).catch(() => cwd)
  if (canonical !== root && !canonical.startsWith(root + sep)) {
    throw new BehaviorConfigError("instructions file escapes the workspace")
  }
  return canonical
}

function parseRule(value: unknown): BehaviorPermissionRule {
  if (!isRecord(value)) throw new BehaviorConfigError("permission rule is invalid")
  const tool = value.tool
  const match = value.match
  const policy = value.policy
  if (typeof tool !== "string" || tool.length === 0 || tool.length > 64) throw new BehaviorConfigError("permission rule tool is invalid")
  if (typeof match !== "string" || match.length === 0 || match.length > 256) throw new BehaviorConfigError("permission rule match is invalid")
  if (policy !== "allow" && policy !== "ask" && policy !== "deny") throw new BehaviorConfigError("permission rule policy is invalid")
  return Object.freeze({ tool, match, policy })
}

/** `*` matches any run, `?` matches one character. All else is literal. */
export function matchGlob(pattern: string, value: string): boolean {
  return wildcardMatch(pattern, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

/** First matching rule wins; otherwise the default policy applies. */
export function behaviorPolicyFor(config: BehaviorConfig, toolName: string, action: string): BehaviorPolicy {
  for (const rule of config.permissionRules) {
    if (rule.tool === toolName && matchGlob(rule.match, action)) return rule.policy
  }
  if (BEHAVIOR_READ_ONLY_TOOLS.has(toolName)) return "allow"
  if (!BEHAVIOR_MUTATING_TOOLS.includes(toolName) && config.permissionDefault !== "allow") return config.permissionDefault
  switch (config.mode) {
    case "ask":
    case "plan":
      return BEHAVIOR_MUTATING_TOOLS.includes(toolName) ? "ask" : "allow"
    case "auto":
      return "allow"
  }
}

export function shouldRequestApproval(config: BehaviorConfig, toolName: string, action: string): boolean {
  return behaviorPolicyFor(config, toolName, action) !== "allow"
}

export interface BehaviorApprovalOptions {
  /** A caller can resolve approvals later. Without one, a request the policy wants reviewed is denied at once. */
  readonly pending?: boolean
}

export function createBehaviorApprovalPort(config: BehaviorConfig, options: BehaviorApprovalOptions = {}): NativeApprovalPort {
  return {
    // The engine treats any settled answer other than true as a denial, so a
    // request left for a human must not settle here: the engine keeps it
    // pending until it is resolved, times out, or the turn is cancelled.
    // approval.required is emitted by the engine either way.
    request: ({ tool, action, input, signal }) => {
      if (signal.aborted) return false
      const policy = inputPolicy(config, tool.name, input, typeof action === "string" ? action : "")
      if (policy === "allow") return true
      return policy === "ask" && options.pending === true ? new Promise<boolean>(() => undefined) : false
    },
  }
}

/** Apply the behavior policy to caller-owned and native tools alike. */
export function applyBehaviorToolPolicy(tools: readonly NativeTool[], config: BehaviorConfig): readonly NativeTool[] {
  return Object.freeze(tools.map((tool) => {
    const existing = tool.requiresApproval
    return Object.freeze({
      ...tool,
      requiresApproval: async (input: unknown): Promise<boolean> => {
        const explicitlyRequired = typeof existing === "function" ? await existing(input) : existing === true
        return explicitlyRequired || inputPolicy(config, tool.name, input, tool.name) !== "allow"
      },
    })
  }))
}

/**
 * Plan mode is genuinely read-only: mutating tools never reach the model.
 * Caller-owned (MCP/connector/plugin) tools are outside this boundary and
 * stay gated by the approval port instead.
 */
export function filterToolsForMode<T extends { readonly name?: string; readonly capabilities?: readonly string[]; readonly requiresApproval?: unknown }>(tools: readonly T[], mode: BehaviorMode): readonly T[] {
  if (mode !== "plan") return tools
  return Object.freeze(tools.filter((tool) => isPlanSafeTool(tool)))
}

function isPlanSafeTool(tool: { readonly name?: string; readonly capabilities?: readonly string[]; readonly requiresApproval?: unknown }): boolean {
  const name = tool.name ?? ""
  if (BEHAVIOR_MUTATING_TOOLS.includes(name)) return false
  if (BEHAVIOR_READ_ONLY_TOOLS.has(name)) return true
  if (tool.requiresApproval === true || typeof tool.requiresApproval === "function") return false
  const capabilities = tool.capabilities
  if (capabilities === undefined || capabilities.length === 0) return false
  return capabilities.every((capability) => /(?:^|[.:/_-])(read|search|list|inspect|query)(?:$|[.:/_-])/i.test(capability))
}

const STRICTNESS: Readonly<Record<BehaviorPolicy, number>> = { allow: 0, ask: 1, deny: 2 }

/** The strictest policy over every way the call can be named, so `/usr/bin/git push` meets a `git push *` rule and earns no `git *` allow. */
function inputPolicy(config: BehaviorConfig, toolName: string, input: unknown, fallback: string): BehaviorPolicy {
  let strictest: BehaviorPolicy | undefined
  for (const action of approvalActions(toolName, input, fallback)) {
    const policy = behaviorPolicyFor(config, toolName, action)
    if (strictest === undefined || STRICTNESS[policy] > STRICTNESS[strictest]) strictest = policy
  }
  return strictest ?? behaviorPolicyFor(config, toolName, fallback || toolName)
}

function approvalActions(toolName: string, input: unknown, fallback: string): readonly string[] {
  if (typeof input === "string") return [input.slice(0, 4_096)]
  if (isRecord(input)) {
    for (const key of ["action", "command", "path", "operation"] as const) {
      const value = input[key]
      if (typeof value === "string") return [value.slice(0, 4_096)]
    }
    const argv = Array.isArray(input.argv) && input.argv.length > 0 && input.argv.every((value) => typeof value === "string") ? (input.argv as string[]) : undefined
    // run_command takes `{program, args}`.
    const program = typeof input.program === "string" ? [input.program, ...(Array.isArray(input.args) ? input.args.filter((value): value is string => typeof value === "string") : [])] : undefined
    const words = program ?? argv
    if (words !== undefined) {
      const named = words.join(" ").slice(0, 4_096)
      const head = words[0] ?? ""
      const base = head.slice(head.lastIndexOf("/") + 1)
      return base.length > 0 && base !== head ? [named, [base, ...words.slice(1)].join(" ").slice(0, 4_096)] : [named]
    }
  }
  return [fallback || toolName]
}

const lastGoodByPath = new Map<string, BehaviorConfig>()

/**
 * Session-scoped loader with last-good fallback. The first load for a path
 * is strict (a bad config fails launch recoverably); later reloads — session
 * refresh, backend switch — fall back to the last good config with a warning
 * instead of stranding a running session on transient IO.
 */
export async function loadBehaviorForSession(
  filePath: string | undefined,
  options: { readonly cwd: string; readonly allowMissing?: boolean; readonly onWarning?: (message: string) => void },
): Promise<BehaviorConfig | undefined> {
  if (filePath === undefined) return undefined
  try {
    const config = await loadBehaviorConfigFile(filePath, { cwd: options.cwd })
    lastGoodByPath.set(filePath, config)
    return config
  } catch (error) {
    if (options.allowMissing === true && error instanceof BehaviorConfigError && error.message.endsWith("config file is missing")) {
      const config = DEFAULT_BEHAVIOR_CONFIG
      lastGoodByPath.set(filePath, config)
      return config
    }
    const cached = lastGoodByPath.get(filePath)
    if (cached !== undefined) {
      options.onWarning?.(`behavior config unreadable, keeping last good config: ${error instanceof Error ? error.message : "unknown error"}`)
      return cached
    }
    throw error
  }
}
