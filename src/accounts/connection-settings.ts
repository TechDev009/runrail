import { mkdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { FileLockError, withFileLock } from "../auth/lock.ts"
import { isImageRoute, type ImageRoute } from "../images/models.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"

/** Coding tools a connection can stand for. Each is driven through its own CLI. */
export type ToolConnectionTool = "claude-code" | "codex" | "copilot" | "opencode" | "gemini" | "goose" | "pi"
/** `subscription`: the tool's own sign-in. `api-key`: a key Runrail keeps for this connection. */
export type ToolConnectionAuthMode = "subscription" | "api-key"

export const TOOL_CONNECTION_TOOLS: readonly ToolConnectionTool[] = Object.freeze(["claude-code", "codex", "copilot", "opencode", "gemini", "goose", "pi"])
/** Tools that take an API key Runrail keeps. The others reach models only through their sign-in. */
export const TOOL_CONNECTION_KEY_TOOLS: readonly ToolConnectionTool[] = Object.freeze(["claude-code", "codex", "gemini"])
/** Tools that can sign in as a separate account in a config folder of the connection's own. */
export const TOOL_CONNECTION_SEPARATE_TOOLS: readonly ToolConnectionTool[] = Object.freeze(["claude-code", "codex"])

export interface ToolConnection {
  readonly connectionId: string
  readonly tool: ToolConnectionTool
  readonly label: string
  readonly authMode: ToolConnectionAuthMode
  readonly enabled: boolean
  /** Chosen models, the first being the connection's default. Absent: every model the tool offers. */
  readonly models?: readonly string[]
  /**
   * The connection's own config folder for the tool, named under the accounts folder. Every key
   * connection has one, so the user's own settings and sign-in never apply to it. Absent: the
   * tool's usual folder and sign-in.
   */
  readonly homeId?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** What a provider connection adds to its account. An account with none is on, with every listed model. */
export interface ProviderConnectionSettings {
  readonly enabled: boolean
  readonly models?: readonly string[]
}

export interface DefaultConnectionModel {
  readonly connectionId: string
  readonly model: string
}

/** The image model the person picked from one of their connections, and how it is asked. */
export interface ImageModelChoice extends DefaultConnectionModel {
  readonly route: ImageRoute
}

export interface ConnectionSettings {
  readonly providers: Readonly<Record<string, ProviderConnectionSettings>>
  readonly tools: readonly ToolConnection[]
  readonly default?: DefaultConnectionModel
  readonly image?: ImageModelChoice
}

export type ConnectionSettingsErrorCode =
  | "CONNECTION_INVALID"
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_EXISTS"
  | "CONNECTION_MODELS_EMPTY"
  | "CONNECTION_MODEL_NOT_CHOSEN"
  | "CONNECTION_DISABLED"
  | "CONNECTION_AUTH_UNSUPPORTED"
  | "CONNECTION_LIMIT"
  | "CONNECTION_STORE_BUSY"
  | "CONNECTION_KEY_MISSING"

export class ConnectionSettingsError extends Error {
  constructor(readonly code: ConnectionSettingsErrorCode, reason: string) {
    super(`${code}: ${reason.slice(0, 512).replace(/[\r\n\0]/g, " ")}`)
    this.name = "ConnectionSettingsError"
  }
}

export interface ConnectionSettingsStore {
  read(): Promise<ConnectionSettings>
  /** Applies `apply` to the current settings and stores what it returns, as one change. */
  change(apply: (current: ConnectionSettings) => ConnectionSettings): Promise<ConnectionSettings>
}

const MAX_TOOLS = 256
const MAX_PROVIDERS = 4_096
const MAX_MODELS = 256
const HOME_ID = /^[a-f0-9]{32}$/
const EMPTY: ConnectionSettings = Object.freeze({ providers: Object.freeze({}), tools: Object.freeze([]) })

export class InMemoryConnectionSettingsStore implements ConnectionSettingsStore {
  private settings: ConnectionSettings = EMPTY

  async read(): Promise<ConnectionSettings> {
    return this.settings
  }

  async change(apply: (current: ConnectionSettings) => ConnectionSettings): Promise<ConnectionSettings> {
    this.settings = parseConnectionSettings(apply(this.settings))
    return this.settings
  }
}

/**
 * Connection settings in `connections.json` beside `accounts.json`. They live apart so an engine
 * that predates them still reads the accounts file. Every read checks whether the file changed on
 * disk and every change re-reads it under a lock, as the account store does.
 */
export class FileConnectionSettingsStore implements ConnectionSettingsStore {
  private readonly root: string
  private readonly path: string
  private readonly lockPath: string
  private settings: ConnectionSettings = EMPTY
  private stamp: string | undefined

  constructor(options: { readonly root: string }) {
    if (typeof options.root !== "string" || options.root.length === 0 || options.root.length > 4_096 || !options.root.startsWith("/")) throw new ConnectionSettingsError("CONNECTION_INVALID", "connection settings root is invalid")
    this.root = options.root
    this.path = join(this.root, "connections.json")
    this.lockPath = join(this.root, "connections.lock")
  }

  async read(): Promise<ConnectionSettings> {
    await this.refresh()
    return this.settings
  }

  async change(apply: (current: ConnectionSettings) => ConnectionSettings): Promise<ConnectionSettings> {
    try {
      return await withFileLock(this.lockPath, async () => {
        await this.refresh()
        const next = parseConnectionSettings(apply(this.settings))
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        await writeFileAtomic(this.path, JSON.stringify({ version: 1, ...next }))
        this.settings = next
        this.stamp = await this.currentStamp()
        return next
      })
    } catch (error) {
      if (error instanceof FileLockError) throw new ConnectionSettingsError("CONNECTION_STORE_BUSY", "connection settings are busy")
      throw error
    }
  }

  private async refresh(): Promise<void> {
    const stamp = await this.currentStamp()
    if (stamp === this.stamp) return
    let settings = EMPTY
    if (stamp !== "absent") {
      let text: string
      try {
        text = await readFile(this.path, "utf8")
      } catch {
        throw new ConnectionSettingsError("CONNECTION_INVALID", "connection settings cannot be read")
      }
      if (text.length > 4 * 1024 * 1024) throw new ConnectionSettingsError("CONNECTION_LIMIT", "connection settings are too large")
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new ConnectionSettingsError("CONNECTION_INVALID", "connection settings JSON is invalid")
      }
      if (!isRecord(value) || value.version !== 1) throw new ConnectionSettingsError("CONNECTION_INVALID", "connection settings version is unknown")
      const { version: _version, ...rest } = value
      settings = parseConnectionSettings(rest)
    }
    this.settings = settings
    this.stamp = stamp
  }

  private async currentStamp(): Promise<string> {
    try {
      const info = await stat(this.path)
      return `${info.ino}:${info.mtimeMs}:${info.size}`
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT") return "absent"
      throw new ConnectionSettingsError("CONNECTION_INVALID", "connection settings cannot be read")
    }
  }
}

export function parseConnectionSettings(value: unknown): ConnectionSettings {
  if (!isRecord(value)) invalid("connection settings are invalid")
  knownKeys(value, ["providers", "tools", "default", "image"], "connection settings")
  if (!isRecord(value.providers)) invalid("provider settings are invalid")
  const providerEntries = Object.entries(value.providers)
  if (providerEntries.length > MAX_PROVIDERS) throw new ConnectionSettingsError("CONNECTION_LIMIT", "too many provider settings")
  const providers: Record<string, ProviderConnectionSettings> = {}
  for (const [id, entry] of providerEntries) providers[connectionId(id)] = parseProviderSettings(entry)
  if (!Array.isArray(value.tools)) invalid("tool connections are invalid")
  if (value.tools.length > MAX_TOOLS) throw new ConnectionSettingsError("CONNECTION_LIMIT", "too many tool connections")
  const tools = value.tools.map(parseToolConnection)
  const ids = new Set<string>()
  const homes = new Set<string>()
  for (const tool of tools) {
    if (ids.has(tool.connectionId) || Object.hasOwn(providers, tool.connectionId)) throw new ConnectionSettingsError("CONNECTION_EXISTS", "connection id is repeated")
    ids.add(tool.connectionId)
    if (tool.homeId !== undefined && homes.has(tool.homeId)) invalid("tool connection home is repeated")
    if (tool.homeId !== undefined) homes.add(tool.homeId)
  }
  const defaultModel = value.default === undefined ? undefined : parseDefault(value.default)
  const image = value.image === undefined ? undefined : parseImageChoice(value.image)
  return Object.freeze({ providers: Object.freeze(providers), tools: Object.freeze(tools), ...(defaultModel === undefined ? {} : { default: defaultModel }), ...(image === undefined ? {} : { image }) })
}

export function parseToolConnection(value: unknown): ToolConnection {
  if (!isRecord(value)) invalid("tool connection is invalid")
  knownKeys(value, ["connectionId", "tool", "label", "authMode", "enabled", "models", "homeId", "createdAt", "updatedAt"], "tool connection")
  const tool = value.tool
  if (!TOOL_CONNECTION_TOOLS.includes(tool as ToolConnectionTool)) invalid("tool is unknown")
  const authMode = value.authMode
  if (authMode !== "subscription" && authMode !== "api-key") invalid("tool connection auth mode is invalid")
  if (authMode === "api-key" && !TOOL_CONNECTION_KEY_TOOLS.includes(tool as ToolConnectionTool)) throw new ConnectionSettingsError("CONNECTION_AUTH_UNSUPPORTED", "this tool signs in only with its own login")
  if (typeof value.enabled !== "boolean") invalid("tool connection enabled flag is invalid")
  const createdAt = timestamp(value.createdAt)
  const updatedAt = timestamp(value.updatedAt)
  if (updatedAt < createdAt) invalid("tool connection timestamps are invalid")
  const models = value.models === undefined ? undefined : parseConnectionModels(value.models)
  const homeId = value.homeId
  if (homeId !== undefined && (typeof homeId !== "string" || !HOME_ID.test(homeId))) invalid("tool connection home is invalid")
  if (homeId !== undefined && authMode === "subscription" && !TOOL_CONNECTION_SEPARATE_TOOLS.includes(tool as ToolConnectionTool)) throw new ConnectionSettingsError("CONNECTION_AUTH_UNSUPPORTED", "this tool cannot sign in as a separate account")
  return Object.freeze({
    connectionId: connectionId(value.connectionId),
    tool: tool as ToolConnectionTool,
    label: connectionLabel(value.label),
    authMode,
    enabled: value.enabled,
    ...(models === undefined ? {} : { models }),
    ...(homeId === undefined ? {} : { homeId }),
    createdAt,
    updatedAt,
  })
}

/** A chosen model list: at least one id, no repeats. */
export function parseConnectionModels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid("models are invalid")
  if (value.length === 0) throw new ConnectionSettingsError("CONNECTION_MODELS_EMPTY", "a connection needs at least one model")
  if (value.length > MAX_MODELS) throw new ConnectionSettingsError("CONNECTION_LIMIT", "too many models")
  const models = value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256 || /[\0-\x1f\x7f]/.test(entry) || entry.trim() !== entry || entry.startsWith("-")) invalid("model id is invalid")
    return entry
  })
  if (new Set(models).size !== models.length) invalid("models are repeated")
  return Object.freeze(models)
}

export function connectionLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160 || /[\0-\x1f\x7f]/.test(value)) invalid("connection label is invalid")
  return value
}

export function connectionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(value)) invalid("connection id is invalid")
  return value
}

function parseProviderSettings(value: unknown): ProviderConnectionSettings {
  if (!isRecord(value)) invalid("provider settings are invalid")
  knownKeys(value, ["enabled", "models"], "provider settings")
  if (typeof value.enabled !== "boolean") invalid("provider enabled flag is invalid")
  const models = value.models === undefined ? undefined : parseConnectionModels(value.models)
  return Object.freeze({ enabled: value.enabled, ...(models === undefined ? {} : { models }) })
}

function parseDefault(value: unknown): DefaultConnectionModel {
  if (!isRecord(value)) invalid("default model is invalid")
  knownKeys(value, ["connectionId", "model"], "default model")
  const [model] = parseConnectionModels([value.model])
  return Object.freeze({ connectionId: connectionId(value.connectionId), model: model! })
}

function parseImageChoice(value: unknown): ImageModelChoice {
  if (!isRecord(value)) invalid("image model is invalid")
  knownKeys(value, ["connectionId", "model", "route"], "image model")
  const [model] = parseConnectionModels([value.model])
  if (!isImageRoute(value.route)) invalid("image model route is invalid")
  return Object.freeze({ connectionId: connectionId(value.connectionId), model: model!, route: value.route })
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("timestamp is invalid")
  return value
}

function knownKeys(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys)
  if (Object.keys(record).some((key) => !allowed.has(key))) invalid(`${field} contains unknown fields`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalid(reason: string): never {
  throw new ConnectionSettingsError("CONNECTION_INVALID", reason)
}
