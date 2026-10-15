import { randomBytes } from "node:crypto"
import { isReservedCredentialId, parseAccountRecord, type AccountAuthMode, type AccountStatus, type AccountStore } from "./types.ts"
import {
  ConnectionSettingsError,
  TOOL_CONNECTION_KEY_TOOLS,
  TOOL_CONNECTION_SEPARATE_TOOLS,
  TOOL_CONNECTION_TOOLS,
  connectionId as parseConnectionId,
  connectionLabel,
  parseConnectionModels,
  type ConnectionSettings,
  type ConnectionSettingsStore,
  type DefaultConnectionModel,
  type ImageModelChoice,
  type ToolConnection,
  type ToolConnectionAuthMode,
  type ToolConnectionTool,
} from "./connection-settings.ts"

export type ConnectionEntry =
  | {
    readonly kind: "provider"
    readonly connectionId: string
    readonly provider: string
    readonly preset?: string
    readonly label: string
    readonly authMode: AccountAuthMode
    readonly status: AccountStatus
    readonly enabled: boolean
    /** Absent: every model the provider lists. */
    readonly models?: readonly string[]
  }
  | {
    readonly kind: "tool"
    readonly connectionId: string
    readonly tool: ToolConnectionTool
    readonly label: string
    readonly authMode: ToolConnectionAuthMode
    /** True when the tool signs in from a config folder of this connection's own. */
    readonly separateAccount: boolean
    readonly enabled: boolean
    readonly models?: readonly string[]
  }

export interface ConnectionListing {
  readonly connections: readonly ConnectionEntry[]
  /** `usable` is false while the default's connection is off, revoked, or gone. */
  readonly default?: DefaultConnectionModel & { readonly usable: boolean }
  /** The image model the person picked, usable on the same terms. */
  readonly image?: ImageModelChoice & { readonly usable: boolean }
}

export interface ConnectionChanges {
  readonly label?: string
  readonly enabled?: boolean
  /** `null` goes back to every model the connection lists. */
  readonly models?: readonly string[] | null
}

export interface AddToolConnectionInput {
  readonly tool: string
  readonly authMode?: string
  readonly label?: string
  readonly models?: readonly string[]
  readonly connectionId?: string
  /** Sign in as another account, in a config folder of the connection's own. A key connection always has one. */
  readonly separateAccount?: boolean
}

const TOOL_NAMES: Readonly<Record<ToolConnectionTool, string>> = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  goose: "Goose",
  pi: "Pi",
})

/**
 * Providers (stored accounts) and coding tools as one list of connections the person added, each
 * with an on/off switch and a chosen model list, plus the one default model. Nothing is added by
 * detection: a connection exists only once someone adds it.
 */
export class ConnectionDirectory {
  constructor(private readonly accounts: AccountStore, private readonly settings: ConnectionSettingsStore, private readonly now: () => number = Date.now) {}

  async list(options: { readonly enabledOnly?: boolean } = {}): Promise<ConnectionListing> {
    const settings = await this.settings.read()
    const entries: ConnectionEntry[] = []
    for (const record of await this.accounts.list()) {
      const reference = record.reference
      const extra = settings.providers[reference.accountId]
      entries.push(Object.freeze({
        kind: "provider" as const,
        connectionId: reference.accountId,
        provider: reference.provider,
        ...(reference.preset === undefined ? {} : { preset: reference.preset }),
        label: reference.label,
        authMode: reference.authMode,
        status: record.status,
        enabled: extra?.enabled ?? true,
        ...(extra?.models === undefined ? {} : { models: extra.models }),
      }))
    }
    for (const tool of settings.tools) entries.push(toolEntry(tool))
    const usable = (entry: ConnectionEntry): boolean => entry.enabled && (entry.kind === "tool" || entry.status !== "revoked")
    const connections = options.enabledOnly === true ? entries.filter(usable) : entries
    const chosen = settings.default
    const target = chosen === undefined ? undefined : entries.find((entry) => entry.connectionId === chosen.connectionId)
    const image = settings.image
    const imageTarget = image === undefined ? undefined : entries.find((entry) => entry.connectionId === image.connectionId)
    return Object.freeze({
      connections: Object.freeze(connections),
      ...(chosen === undefined ? {} : { default: Object.freeze({ ...chosen, usable: target !== undefined && usable(target) }) }),
      ...(image === undefined ? {} : { image: Object.freeze({ ...image, usable: imageTarget !== undefined && usable(imageTarget) }) }),
    })
  }

  async get(id: string): Promise<ConnectionEntry> {
    const entry = (await this.list()).connections.find((candidate) => candidate.connectionId === id)
    if (entry === undefined) throw new ConnectionSettingsError("CONNECTION_NOT_FOUND", "connection was not found")
    return entry
  }

  async update(id: string, changes: ConnectionChanges): Promise<ConnectionEntry> {
    const target = parseConnectionId(id)
    const label = changes.label === undefined ? undefined : connectionLabel(changes.label)
    if (changes.enabled !== undefined && typeof changes.enabled !== "boolean") throw new ConnectionSettingsError("CONNECTION_INVALID", "enabled is invalid")
    const models = changes.models === undefined || changes.models === null ? changes.models : parseConnectionModels(changes.models)
    const entry = await this.get(target)
    if (entry.kind === "provider" && label !== undefined && label !== entry.label) {
      const record = await this.accounts.get(target)
      if (record === undefined) throw new ConnectionSettingsError("CONNECTION_NOT_FOUND", "connection was not found")
      await this.accounts.put(parseAccountRecord({ ...record, reference: { ...record.reference, label, updatedAt: Math.max(this.now(), record.reference.createdAt) } }))
    }
    await this.settings.change((current) => {
      const nextModels = (previous: readonly string[] | undefined): readonly string[] | undefined => models === undefined ? previous : models ?? undefined
      if (entry.kind === "provider") {
        const previous = current.providers[target]
        const enabled = changes.enabled ?? previous?.enabled ?? true
        const chosen = nextModels(previous?.models)
        return withDefault({ ...current, providers: { ...current.providers, [target]: { enabled, ...(chosen === undefined ? {} : { models: chosen }) } } }, target, chosen)
      }
      const tools = current.tools.map((tool) => {
        if (tool.connectionId !== target) return tool
        const chosen = nextModels(tool.models)
        const { models: _models, ...rest } = tool
        return { ...rest, ...(label === undefined ? {} : { label }), ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }), ...(chosen === undefined ? {} : { models: chosen }), updatedAt: Math.max(this.now(), tool.createdAt) }
      })
      return withDefault({ ...current, tools }, target, nextModels(entry.models))
    })
    return this.get(target)
  }

  /** `undefined` clears the default. Adding a connection never sets it. */
  async setDefault(choice: DefaultConnectionModel | undefined): Promise<DefaultConnectionModel | undefined> {
    if (choice === undefined) {
      await this.settings.change(({ default: _cleared, ...rest }) => rest)
      return undefined
    }
    const id = parseConnectionId(choice.connectionId)
    const [model] = parseConnectionModels([choice.model])
    const entry = await this.get(id)
    if (!entry.enabled || (entry.kind === "provider" && entry.status === "revoked")) throw new ConnectionSettingsError("CONNECTION_DISABLED", "connection is turned off")
    if (entry.models !== undefined && !entry.models.includes(model!)) throw new ConnectionSettingsError("CONNECTION_MODEL_NOT_CHOSEN", "model is not one of the connection's models")
    const chosen = Object.freeze({ connectionId: id, model: model! })
    await this.settings.change((current) => ({ ...current, default: chosen }))
    return chosen
  }

  /**
   * `undefined` clears it. The caller has checked that the connection lists the model as an image
   * model; the route says how that listing said to ask it.
   */
  async setImage(choice: ImageModelChoice | undefined): Promise<ImageModelChoice | undefined> {
    if (choice === undefined) {
      await this.settings.change(({ image: _cleared, ...rest }) => rest)
      return undefined
    }
    const id = parseConnectionId(choice.connectionId)
    const [model] = parseConnectionModels([choice.model])
    const entry = await this.get(id)
    if (entry.kind !== "provider") throw new ConnectionSettingsError("CONNECTION_INVALID", "image models come from provider connections")
    if (!entry.enabled || entry.status === "revoked") throw new ConnectionSettingsError("CONNECTION_DISABLED", "connection is turned off")
    const chosen = Object.freeze({ connectionId: id, model: model!, route: choice.route })
    await this.settings.change((current) => ({ ...current, image: chosen }))
    return chosen
  }

  async addTool(input: AddToolConnectionInput): Promise<ConnectionEntry> {
    const tool = input.tool as ToolConnectionTool
    if (!TOOL_CONNECTION_TOOLS.includes(tool)) throw new ConnectionSettingsError("CONNECTION_INVALID", "tool is unknown")
    const authMode = input.authMode ?? "subscription"
    if (authMode !== "subscription" && authMode !== "api-key") throw new ConnectionSettingsError("CONNECTION_INVALID", "tool connection auth mode is invalid")
    if (authMode === "api-key" && !TOOL_CONNECTION_KEY_TOOLS.includes(tool)) throw new ConnectionSettingsError("CONNECTION_AUTH_UNSUPPORTED", "this tool signs in only with its own login")
    if (input.separateAccount !== undefined && typeof input.separateAccount !== "boolean") throw new ConnectionSettingsError("CONNECTION_INVALID", "separateAccount is invalid")
    if (input.separateAccount === true && authMode === "subscription" && !TOOL_CONNECTION_SEPARATE_TOOLS.includes(tool)) throw new ConnectionSettingsError("CONNECTION_AUTH_UNSUPPORTED", "this tool cannot sign in as a separate account")
    const homeId = authMode === "api-key" || input.separateAccount === true ? randomBytes(16).toString("hex") : undefined
    const models = input.models === undefined ? undefined : parseConnectionModels(input.models)
    const label = input.label === undefined ? undefined : connectionLabel(input.label)
    const requested = input.connectionId === undefined ? undefined : parseConnectionId(input.connectionId)
    if (requested !== undefined && isReservedCredentialId(requested)) throw new ConnectionSettingsError("CONNECTION_INVALID", "connection id is reserved")
    const accountIds = new Set((await this.accounts.list()).map((record) => record.reference.accountId))
    const at = this.now()
    let added: ToolConnection | undefined
    await this.settings.change((current) => {
      const taken = new Set([...accountIds, ...current.tools.map((entry) => entry.connectionId)])
      if (requested !== undefined && taken.has(requested)) throw new ConnectionSettingsError("CONNECTION_EXISTS", "connection id is taken")
      let id = requested
      for (let index = 1; id === undefined; index += 1) if (!taken.has(`${tool}-${index}`)) id = `${tool}-${index}`
      const same = current.tools.filter((entry) => entry.tool === tool).length
      added = { connectionId: id, tool, label: label ?? (same === 0 ? TOOL_NAMES[tool] : `${TOOL_NAMES[tool]} ${same + 1}`), authMode, enabled: true, ...(models === undefined ? {} : { models }), ...(homeId === undefined ? {} : { homeId }), createdAt: at, updatedAt: at }
      return { ...current, tools: [...current.tools, added] }
    })
    return toolEntry(added!)
  }

  /** Forgets the connection and returns what it was. The tool's own sign-in is left as it is. */
  async removeTool(id: string): Promise<ToolConnection> {
    const target = parseConnectionId(id)
    let removed: ToolConnection | undefined
    await this.settings.change((current) => {
      removed = current.tools.find((tool) => tool.connectionId === target)
      if (removed === undefined) throw new ConnectionSettingsError("CONNECTION_NOT_FOUND", "tool connection was not found")
      return dropDefault({ ...current, tools: current.tools.filter((tool) => tool.connectionId !== target) }, target)
    })
    return removed!
  }

  /** The settings of a provider connection whose account was removed. */
  async forgetProvider(id: string): Promise<void> {
    const target = parseConnectionId(id)
    const current = await this.settings.read()
    if (!Object.hasOwn(current.providers, target) && current.default?.connectionId !== target && current.image?.connectionId !== target) return
    await this.settings.change((latest) => {
      const { [target]: _removed, ...providers } = latest.providers
      return dropDefault({ ...latest, providers }, target)
    })
  }

  /** Refuses an account id a tool connection already has. */
  async requireFreeForAccount(id: string): Promise<void> {
    if ((await this.settings.read()).tools.some((tool) => tool.connectionId === id)) throw new ConnectionSettingsError("CONNECTION_EXISTS", "connection id is taken by a tool connection")
  }

  /** Refuses a provider connection that is turned off, or a model outside its chosen list. */
  async requireProviderModel(id: string, model: string): Promise<void> {
    const settings = (await this.settings.read()).providers[id]
    if (settings?.enabled === false) throw new ConnectionSettingsError("CONNECTION_DISABLED", "connection is turned off")
    if (settings?.models !== undefined && !settings.models.includes(model)) throw new ConnectionSettingsError("CONNECTION_MODEL_NOT_CHOSEN", "model is not one of the connection's models")
  }

  /** The stored tool connection, on or off. */
  async getTool(id: string): Promise<ToolConnection> {
    const found = (await this.settings.read()).tools.find((entry) => entry.connectionId === id)
    if (found === undefined) throw new ConnectionSettingsError("CONNECTION_NOT_FOUND", "tool connection was not found")
    return found
  }

  /** A tool connection that can run now, for `tool` when one is named. */
  async requireTool(id: string, tool?: string): Promise<ToolConnection> {
    const found = (await this.settings.read()).tools.find((entry) => entry.connectionId === id)
    if (found === undefined) throw new ConnectionSettingsError("CONNECTION_NOT_FOUND", "tool connection was not found")
    if (tool !== undefined && found.tool !== tool) throw new ConnectionSettingsError("CONNECTION_INVALID", "connection belongs to another tool")
    if (!found.enabled) throw new ConnectionSettingsError("CONNECTION_DISABLED", "connection is turned off")
    return found
  }
}

function toolEntry(tool: ToolConnection): ConnectionEntry {
  return Object.freeze({
    kind: "tool" as const,
    connectionId: tool.connectionId,
    tool: tool.tool,
    label: tool.label,
    authMode: tool.authMode,
    separateAccount: tool.homeId !== undefined,
    enabled: tool.enabled,
    ...(tool.models === undefined ? {} : { models: tool.models }),
  })
}

/** A default whose model left the connection's list moves to the list's first model. */
function withDefault(settings: ConnectionSettings, id: string, models: readonly string[] | undefined): ConnectionSettings {
  const chosen = settings.default
  if (chosen === undefined || chosen.connectionId !== id || models === undefined || models.includes(chosen.model)) return settings
  return { ...settings, default: { connectionId: id, model: models[0]! } }
}

function dropDefault(settings: ConnectionSettings, id: string): ConnectionSettings {
  const { default: chosen, image, ...rest } = settings
  return { ...rest, ...(chosen === undefined || chosen.connectionId === id ? {} : { default: chosen }), ...(image === undefined || image.connectionId === id ? {} : { image }) }
}
