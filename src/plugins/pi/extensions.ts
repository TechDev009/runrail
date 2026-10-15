import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { lstat, realpath, unlink, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import type { NativeTool, UiExtensionManifest } from "@nifrajs/coding-agent"
import type { ModelAdapter } from "../../model/catalog.ts"
import type {
  PluginCommand,
  PluginHostSnapshot,
  PluginPrompt,
  PluginTextResource,
} from "../sdk.ts"
import { HotkeyRegistry, WorkbenchCommandRegistry } from "../../workbench/commands.ts"

/** Versioned native compatibility surface for Pi-style extensions. */
export const PI_EXTENSION_ADAPTER_VERSION = "1.0" as const

const MAX_EXTENSIONS = 64
const MAX_HANDLERS_PER_EVENT = 128
const MAX_CONTRIBUTIONS = 256
const MAX_ENTRIES = 512

export type PiExtensionEventName = keyof PiExtensionEventMap

export interface PiExtensionEventMap {
  readonly project_trust: { readonly cwd: string }
  readonly resources_discover: { readonly cwd: string; readonly reason: "startup" | "reload" }
  readonly session_start: { readonly sessionId: string }
  readonly session_shutdown: { readonly sessionId: string; readonly reason: string }
  readonly reload: { readonly sessionId: string }
  readonly session_compact: { readonly sessionId: string; readonly reason: string }
  readonly input: { readonly text: string; readonly source: "interactive" | "rpc" | "extension" }
  readonly before_agent_start: { readonly sessionId: string; readonly text: string }
  readonly agent_start: { readonly sessionId: string; readonly turnId: string }
  readonly agent_end: { readonly sessionId: string; readonly turnId: string; readonly ok: boolean }
  readonly turn_start: { readonly sessionId: string; readonly turnId: string }
  readonly turn_end: { readonly sessionId: string; readonly turnId: string; readonly ok: boolean }
  readonly tool_call: { readonly sessionId: string; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
  readonly tool_result: { readonly sessionId: string; readonly toolCallId: string; readonly toolName: string; readonly output?: unknown; readonly isError: boolean }
  readonly model_select: { readonly sessionId: string; readonly modelId: string }
  readonly thinking_level_select: { readonly sessionId: string; readonly level: string }
}

export interface PiExtensionEventResult {
  readonly block?: boolean
  readonly reason?: string
  readonly text?: string
  readonly systemPrompt?: string
}

export interface PiExtensionContext {
  readonly cwd: string
  readonly extensionId: string
  readonly mode: "tui" | "rpc" | "json" | "print"
  readonly hasUI: boolean
  readonly signal?: AbortSignal
  readonly ui: PiExtensionUI
  readonly isIdle: () => boolean
  readonly hasPendingMessages: () => boolean
  readonly abort: () => void
  readonly reload: () => Promise<void>
  readonly getContextUsage: () => { readonly tokens: number | null; readonly contextWindow: number; readonly percent: number | null } | undefined
}

export type PiExtensionHandler<K extends PiExtensionEventName> = (
  event: PiExtensionEventMap[K],
  context: PiExtensionContext,
) => PiExtensionEventResult | void | PromiseLike<PiExtensionEventResult | void>

export interface PiExtensionCommand {
  readonly description?: string
  readonly aliases?: readonly string[]
  readonly handler: (args: string, context: PiExtensionContext) => unknown | PromiseLike<unknown>
}

export interface PiExtensionShortcut {
  readonly description?: string
  readonly handler: (context: PiExtensionContext) => unknown | PromiseLike<unknown>
}

export interface PiExtensionTool {
  readonly name: string
  readonly label?: string
  readonly description: string
  readonly capabilities?: readonly string[]
  readonly parameters?: unknown
  readonly requiresApproval?: NativeTool["requiresApproval"]
  readonly execute: PiExtensionToolExecutor | PiCompatibleToolExecutor
}

export type PiExtensionToolExecutor = (input: unknown, context: PiExtensionContext) => unknown | PromiseLike<unknown>
export type PiCompatibleToolExecutor = (toolCallId: string, input: unknown, signal: AbortSignal) => unknown | PromiseLike<unknown>

export interface PiExtensionProvider {
  readonly name: string
  readonly description: string
  readonly capabilities?: readonly string[]
  /** Optional native adapter. Pi provider configuration remains caller-owned when omitted. */
  readonly adapter?: ModelAdapter
}

export interface PiExtensionUIContribution {
  readonly id: string
  readonly slot: UiExtensionManifest["slot"]
  readonly label: string
  readonly capabilities?: readonly string[]
  readonly theme?: UiExtensionManifest["theme"]
  readonly status?: UiExtensionManifest["status"]
}

export type PiExtensionRendererKind = "message" | "entry" | "markdown"

export interface PiExtensionRenderer {
  readonly id: string
  readonly kind: PiExtensionRendererKind
  readonly render: (value: unknown) => unknown
}

export interface PiExtensionUI {
  readonly select: (title: string, options: readonly string[]) => Promise<string | undefined>
  readonly confirm: (title: string, message: string) => Promise<boolean>
  readonly input: (title: string, placeholder?: string) => Promise<string | undefined>
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void
  readonly setStatus: (key: string, text: string | undefined) => void
  readonly setWidget: (key: string, content: readonly string[] | undefined, placement?: "aboveEditor" | "belowEditor") => void
  readonly setHeader: (text: string | undefined) => void
  readonly setFooter: (text: string | undefined) => void
  readonly setTitle: (title: string) => void
  readonly setEditorText: (text: string) => void
  readonly getEditorText: () => string
  readonly pasteToEditor: (text: string) => void
  readonly setWorkingMessage: (message?: string) => void
  readonly setWorkingVisible: (visible: boolean) => void
  readonly setWorkingIndicator: (frames?: readonly string[], intervalMs?: number) => void
  readonly setHiddenThinkingLabel: (label?: string) => void
  readonly getToolsExpanded: () => boolean
  readonly setToolsExpanded: (expanded: boolean) => void
  readonly setTheme: (name: string | undefined) => void
}

export interface PiExtensionRuntime {
  readonly mode?: PiExtensionContext["mode"]
  readonly signal?: AbortSignal
  readonly sessionId?: () => string
  readonly isIdle?: () => boolean
  readonly hasPendingMessages?: () => boolean
  readonly abort?: () => void
  readonly reload?: () => PromiseLike<void>
  readonly getContextUsage?: PiExtensionContext["getContextUsage"]
  readonly sendMessage?: (message: string) => void | PromiseLike<void>
  readonly sendUserMessage?: (message: string) => void | PromiseLike<void>
  readonly appendEntry?: (customType: string, data: unknown) => void | PromiseLike<void>
  readonly exec?: (command: string, args: readonly string[], signal?: AbortSignal) => Promise<unknown>
  readonly ui?: Partial<PiExtensionUIDriver>
}

export interface PiExtensionUIDriver {
  readonly select: (title: string, options: readonly string[]) => Promise<string | undefined>
  readonly confirm: (title: string, message: string) => Promise<boolean>
  readonly input: (title: string, placeholder?: string) => Promise<string | undefined>
  readonly notify: (message: string, type: "info" | "warning" | "error") => void
}

export interface PiExtensionEntry {
  readonly customType: string
  readonly data: unknown
}

export interface PiExtensionUINotification {
  readonly message: string
  readonly type: "info" | "warning" | "error"
}

export interface PiExtensionUISnapshot {
  readonly statuses: Readonly<Record<string, string>>
  readonly widgets: Readonly<Record<string, { readonly content: readonly string[]; readonly placement: "aboveEditor" | "belowEditor" }>>
  readonly header?: string
  readonly footer?: string
  readonly title?: string
  readonly editorText: string
  readonly workingMessage?: string
  readonly workingVisible: boolean
  readonly workingIndicator?: { readonly frames: readonly string[]; readonly intervalMs: number }
  readonly hiddenThinkingLabel?: string
  readonly toolsExpanded: boolean
  readonly theme?: string
  readonly notifications: readonly PiExtensionUINotification[]
}

export interface PiExtensionDescriptor {
  readonly id: string
  readonly path: string
  readonly capabilities: readonly string[]
  readonly active: boolean
}

export interface PiExtensionHostOptions {
  readonly cwd: string
  readonly trustedCapabilities?: readonly string[]
  readonly commandRegistry?: WorkbenchCommandRegistry
  readonly hotkeyRegistry?: HotkeyRegistry
  readonly runtime?: PiExtensionRuntime
  readonly maxExtensions?: number
}

export type PiExtensionErrorCode =
  | "PI_EXTENSION_INVALID"
  | "PI_EXTENSION_TRUST_REQUIRED"
  | "PI_EXTENSION_CAPABILITY_DENIED"
  | "PI_EXTENSION_PATH_INVALID"
  | "PI_EXTENSION_ENTRY_INVALID"
  | "PI_EXTENSION_CONTRIBUTION_INVALID"
  | "PI_EXTENSION_CONFLICT"
  | "PI_EXTENSION_HANDLER_FAILED"
  | "PI_EXTENSION_RUNTIME_UNAVAILABLE"
  | "PI_EXTENSION_TOOL_BLOCKED"

export class PiExtensionError extends Error {
  constructor(readonly code: PiExtensionErrorCode, reason: string) {
    super(`Pi extension: ${reason}`)
    this.name = "PiExtensionError"
  }
}

interface PiExtensionModule {
  readonly default: (api: PiExtensionAPI) => unknown | PromiseLike<unknown>
  readonly id?: unknown
  readonly capabilities?: unknown
}

interface ExtensionRecord {
  readonly descriptor: PiExtensionDescriptor
  readonly dispose?: () => void | PromiseLike<void>
  readonly commands: readonly string[]
  readonly shortcuts: readonly string[]
  readonly tools: readonly string[]
  readonly providers: readonly string[]
  readonly ui: readonly string[]
  readonly flags: readonly string[]
  readonly renderers: readonly string[]
  readonly handlers: ReadonlyMap<PiExtensionEventName, readonly PiExtensionHandler<PiExtensionEventName>[]>
}

interface StagedExtension {
  readonly descriptor: PiExtensionDescriptor
  readonly commands: Map<string, PiExtensionCommand>
  readonly shortcuts: Map<string, { readonly key: string; readonly value: PiExtensionShortcut; readonly commandId: string }>
  readonly tools: Map<string, PiExtensionTool>
  readonly providers: Map<string, PiExtensionProvider>
  readonly ui: Map<string, PiExtensionUIContribution>
  readonly handlers: Map<PiExtensionEventName, PiExtensionHandler<PiExtensionEventName>[]>
  readonly flags: Map<string, boolean | string>
  readonly renderers: Map<string, PiExtensionRenderer>
  dispose?: () => void | PromiseLike<void>
}

export interface PiExtensionAPI {
  on<K extends PiExtensionEventName>(event: K, handler: PiExtensionHandler<K>): () => void
  registerCommand(name: string, command: PiExtensionCommand): void
  registerShortcut(shortcut: string, value: PiExtensionShortcut): void
  registerFlag(name: string, defaultValue?: boolean | string): void
  registerTool(tool: PiExtensionTool): void
  registerProvider(provider: PiExtensionProvider): void
  registerUI(contribution: PiExtensionUIContribution): void
  registerMessageRenderer(id: string, render: (value: unknown) => unknown): void
  registerEntryRenderer(id: string, render: (value: unknown) => unknown): void
  registerMarkdownTransformer(id: string, render: (value: string) => string): void
  sendMessage(message: string): void
  sendUserMessage(message: string): void
  appendEntry(customType: string, data?: unknown): void
  setSessionName(name: string): void
  getSessionName(): string | undefined
  exec(command: string, args?: readonly string[]): Promise<unknown>
  getActiveTools(): readonly string[]
  getAllTools(): readonly { readonly name: string; readonly label: string; readonly description: string; readonly capabilities: readonly string[] }[]
  setActiveTools(toolNames: readonly string[]): void
  getFlag(name: string): boolean | string | undefined
}

/**
 * Native host for the useful, provider-neutral portion of Pi's ExtensionAPI.
 *
 * Activation is always explicit and trusted. This class deliberately does not
 * pretend that a Bun worker is a hostile-code sandbox: callers that need that
 * boundary must activate through an OS/container launcher instead.
 */
export class PiExtensionHost {
  readonly commandRegistry: WorkbenchCommandRegistry
  readonly hotkeyRegistry: HotkeyRegistry
  private readonly cwd: string
  private readonly trustedCapabilities: readonly string[]
  private readonly maxExtensions: number
  private readonly records = new Map<string, ExtensionRecord>()
  private readonly commands = new Map<string, PluginCommand>()
  private readonly tools = new Map<string, NativeTool>()
  private readonly providers = new Map<string, ModelAdapter>()
  private readonly providerRegistrations = new Map<string, PiExtensionProvider>()
  private readonly ui = new Map<string, UiExtensionManifest>()
  private readonly renderers = new Map<string, PiExtensionRenderer>()
  private readonly handlers = new Map<PiExtensionEventName, Array<{ readonly extensionId: string; readonly handler: PiExtensionHandler<PiExtensionEventName> }>>()
  private readonly disabledHandlers = new WeakSet<object>()
  private readonly activeTools = new Set<string>()
  private readonly flags = new Map<string, boolean | string>()
  private readonly entries: PiExtensionEntry[] = []
  private readonly statuses = new Map<string, string>()
  private readonly widgets = new Map<string, { readonly content: readonly string[]; readonly placement: "aboveEditor" | "belowEditor" }>()
  private readonly notifications: PiExtensionUINotification[] = []
  private runtime: PiExtensionRuntime
  private sessionName: string | undefined
  private header: string | undefined
  private footer: string | undefined
  private title: string | undefined
  private editorText = ""
  private workingMessage: string | undefined
  private workingVisible = true
  private workingIndicator: { readonly frames: readonly string[]; readonly intervalMs: number } | undefined
  private hiddenThinkingLabel: string | undefined
  private toolsExpanded = false
  private theme: string | undefined
  private revision = 0

  constructor(options: PiExtensionHostOptions) {
    this.cwd = resolve(options.cwd)
    this.trustedCapabilities = Object.freeze(parseStringList(options.trustedCapabilities ?? [], "trusted capabilities"))
    this.commandRegistry = options.commandRegistry ?? new WorkbenchCommandRegistry()
    this.hotkeyRegistry = options.hotkeyRegistry ?? new HotkeyRegistry()
    this.runtime = Object.freeze({ ...(options.runtime ?? {}) })
    this.maxExtensions = options.maxExtensions ?? MAX_EXTENSIONS
    if (!Number.isSafeInteger(this.maxExtensions) || this.maxExtensions < 1 || this.maxExtensions > MAX_EXTENSIONS)
      throw new PiExtensionError("PI_EXTENSION_INVALID", "extension limit is invalid")
  }

  get currentRevision(): string {
    return `pi:${this.revision}`
  }

  get extensions(): readonly PiExtensionDescriptor[] {
    return Object.freeze([...this.records.values()].map((record) => record.descriptor).sort((a, b) => a.id.localeCompare(b.id)))
  }

  setRuntime(runtime: PiExtensionRuntime): () => void {
    const previous = this.runtime
    this.runtime = Object.freeze({ ...previous, ...runtime })
    return () => {
      this.runtime = previous
    }
  }

  async activate(pathInput: string, options: { readonly approvalGranted: boolean } = { approvalGranted: false }): Promise<PiExtensionDescriptor> {
    if (options.approvalGranted !== true) throw new PiExtensionError("PI_EXTENSION_TRUST_REQUIRED", "explicit extension approval is required")
    if (this.records.size >= this.maxExtensions) throw new PiExtensionError("PI_EXTENSION_INVALID", "extension limit exceeded")
    const path = await this.resolvePath(pathInput)
    const moduleValue: unknown = await importExtensionModule(path)
    if (!isExtensionModule(moduleValue)) throw new PiExtensionError("PI_EXTENSION_ENTRY_INVALID", "extension must export a default factory")
    const id = parseExtensionId(moduleValue.id, path)
    if (this.records.has(id)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `extension '${id}' is already active`)
    const capabilities = parseStringList(moduleValue.capabilities ?? [], "extension capabilities")
    const denied = capabilities.find((capability) => !this.trustedCapabilities.includes(capability))
    if (denied !== undefined) throw new PiExtensionError("PI_EXTENSION_CAPABILITY_DENIED", `extension '${id}' requires an untrusted capability`)
    const staged: StagedExtension = {
      descriptor: Object.freeze({ id, path, capabilities: Object.freeze(capabilities), active: true }),
      commands: new Map(),
      shortcuts: new Map(),
      tools: new Map(),
      providers: new Map(),
      ui: new Map(),
      handlers: new Map(),
      flags: new Map(),
      renderers: new Map(),
    }
    let result: unknown
    try {
      result = await moduleValue.default(this.createAPI(staged))
      staged.dispose = readDispose(result)
      this.commit(staged)
    } catch (error) {
      this.rollbackStaged(staged)
      if (error instanceof PiExtensionError) throw error
      throw new PiExtensionError("PI_EXTENSION_ENTRY_INVALID", "extension factory failed")
    }
    this.revision += 1
    return staged.descriptor
  }

  async deactivate(id: string): Promise<boolean> {
    const record = this.records.get(validateName(id, "extension id"))
    if (record === undefined) return false
    try {
      await record.dispose?.()
    } finally {
      this.unregister(record)
    }
    return true
  }

  /** Removes everything an extension registered; a disposer that throws does not keep any of it. */
  private unregister(record: ExtensionRecord): void {
    for (const name of record.commands) {
      this.commands.delete(name)
      this.commandRegistry.unregister(name)
    }
    for (const key of record.shortcuts) this.hotkeyRegistry.unregister(key)
    for (const name of record.tools) {
      this.tools.delete(name)
      this.activeTools.delete(name)
    }
    for (const name of record.providers) {
      this.providers.delete(name)
      this.providerRegistrations.delete(name)
    }
    for (const idValue of record.ui) this.ui.delete(idValue)
    for (const idValue of record.renderers) this.renderers.delete(idValue)
    for (const name of record.flags) this.flags.delete(name)
    for (const [event, handlers] of this.handlers) {
      const remaining = handlers.filter((item) => item.extensionId !== record.descriptor.id)
      if (remaining.length === 0) this.handlers.delete(event)
      else this.handlers.set(event, remaining)
    }
    this.records.delete(record.descriptor.id)
    this.revision += 1
  }

  /** Whether the model may see and call `name`: a Pi tool must be in the active set; any other tool is not this host's. */
  isToolActive(name: string): boolean {
    return !this.tools.has(name) || this.activeTools.has(name)
  }

  async close(): Promise<void> {
    const ids = [...this.records.keys()].reverse()
    let failure: unknown
    for (const id of ids) {
      try {
        await this.deactivate(id)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }

  async reload(): Promise<readonly PiExtensionDescriptor[]> {
    const paths = [...this.records.values()].map((record) => record.descriptor.path)
    const staging = new PiExtensionHost({
      cwd: this.cwd,
      trustedCapabilities: this.trustedCapabilities,
      commandRegistry: new WorkbenchCommandRegistry(this.commandRegistry.limits),
      hotkeyRegistry: new HotkeyRegistry(),
      runtime: this.runtime,
      maxExtensions: this.maxExtensions,
    })

    // Activate and dispose the replacement graph before touching the live graph.
    // This catches syntax, capability, contribution, and cleanup failures while
    // the current extension set is still available to the session.
    try {
      for (const path of paths) await staging.activate(path, { approvalGranted: true })
      await staging.close()
    } catch (error) {
      try {
        await staging.close()
      } catch {
        // The staging graph is unreachable after this failure; preserve the
        // original activation error and, critically, leave the live graph intact.
      }
      throw error
    }

    try {
      await this.close()
      for (const path of paths) await this.activate(path, { approvalGranted: true })
    } catch (error) {
      // A second import is unavoidable for the live graph because extension
      // factories close over this host. Restore the last-known-good paths if
      // that commit step fails after the live graph has started changing.
      try {
        await this.close()
        for (const path of paths) await this.activate(path, { approvalGranted: true })
      } catch {
        throw new PiExtensionError("PI_EXTENSION_ENTRY_INVALID", "extension reload failed and the previous graph could not be restored")
      }
      throw error
    }
    return this.extensions
  }

  snapshot(): PluginHostSnapshot {
    return Object.freeze({
      plugins: Object.freeze([...this.records.keys()].sort()),
      tools: Object.freeze([...this.tools.values()]),
      commands: Object.freeze([...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))),
      prompts: Object.freeze([]) as readonly PluginPrompt[],
      skills: Object.freeze([]) as readonly PluginTextResource[],
      themes: Object.freeze([]) as readonly PluginTextResource[],
      ui: Object.freeze([...this.ui.values()]),
      providers: Object.freeze([...this.providers.values()]),
      verification: Object.freeze([]),
      workflows: Object.freeze([]),
      subagents: Object.freeze([]),
    })
  }

  providerRegistrationsSnapshot(): readonly PiExtensionProvider[] {
    return Object.freeze([...this.providerRegistrations.values()].map((provider) => Object.freeze({ ...provider })))
  }

  rendererSnapshot(): readonly PiExtensionRenderer[] {
    return Object.freeze([...this.renderers.values()].map((renderer) => Object.freeze({ ...renderer })))
  }

  uiSnapshot(): PiExtensionUISnapshot {
    const widgets: Record<string, { readonly content: readonly string[]; readonly placement: "aboveEditor" | "belowEditor" }> = {}
    for (const [key, value] of this.widgets) widgets[key] = Object.freeze({ content: value.content, placement: value.placement })
    const statuses: Record<string, string> = {}
    for (const [key, value] of this.statuses) statuses[key] = value
    return Object.freeze({
      statuses: Object.freeze(statuses),
      widgets: Object.freeze(widgets),
      ...(this.header === undefined ? {} : { header: this.header }),
      ...(this.footer === undefined ? {} : { footer: this.footer }),
      ...(this.title === undefined ? {} : { title: this.title }),
      editorText: this.editorText,
      ...(this.workingMessage === undefined ? {} : { workingMessage: this.workingMessage }),
      workingVisible: this.workingVisible,
      ...(this.workingIndicator === undefined ? {} : { workingIndicator: Object.freeze({ frames: this.workingIndicator.frames, intervalMs: this.workingIndicator.intervalMs }) }),
      ...(this.hiddenThinkingLabel === undefined ? {} : { hiddenThinkingLabel: this.hiddenThinkingLabel }),
      toolsExpanded: this.toolsExpanded,
      ...(this.theme === undefined ? {} : { theme: this.theme }),
      notifications: Object.freeze([...this.notifications]),
    })
  }

  entriesSnapshot(): readonly PiExtensionEntry[] {
    return Object.freeze([...this.entries])
  }

  async emit<K extends PiExtensionEventName>(event: K, payload: PiExtensionEventMap[K]): Promise<PiExtensionEventResult> {
    let outcome: PiExtensionEventResult = Object.freeze({})
    for (const item of this.handlers.get(event) ?? []) {
      if (this.disabledHandlers.has(item.handler)) continue
      let result: PiExtensionEventResult | void
      try {
        result = await item.handler(payload as PiExtensionEventMap[PiExtensionEventName], this.context(item.extensionId))
      } catch {
        throw new PiExtensionError("PI_EXTENSION_HANDLER_FAILED", `extension handler failed for '${event}'`)
      }
      if (result !== undefined) {
        if (typeof result !== "object" || result === null || Array.isArray(result))
          throw new PiExtensionError("PI_EXTENSION_HANDLER_FAILED", `extension handler returned an invalid result for '${event}'`)
        outcome = Object.freeze({
          ...(outcome.block === true || result.block === true ? { block: true } : {}),
          ...(result.reason === undefined ? (outcome.reason === undefined ? {} : { reason: outcome.reason }) : { reason: boundedText(result.reason, 512) }),
          ...(result.text === undefined ? (outcome.text === undefined ? {} : { text: outcome.text }) : { text: boundedText(result.text, 64 * 1024) }),
          ...(result.systemPrompt === undefined ? (outcome.systemPrompt === undefined ? {} : { systemPrompt: outcome.systemPrompt }) : { systemPrompt: boundedText(result.systemPrompt, 64 * 1024) }),
        })
      }
    }
    return outcome
  }

  private createAPI(staged: StagedExtension): PiExtensionAPI {
    const extensionId = staged.descriptor.id
    const api: PiExtensionAPI = {
      on: <K extends PiExtensionEventName>(event: K, handler: PiExtensionHandler<K>): (() => void) => {
        validateEvent(event)
        if (typeof handler !== "function") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "event handler is invalid")
        const list = staged.handlers.get(event) ?? []
        if (list.length >= MAX_HANDLERS_PER_EVENT) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "event handler limit exceeded")
        const item = handler as PiExtensionHandler<PiExtensionEventName>
        list.push(item)
        staged.handlers.set(event, list)
        return () => {
          this.disabledHandlers.add(item)
          const current = staged.handlers.get(event)
          if (current === undefined) return
          const next = current.filter((candidate) => candidate !== item)
          if (next.length === 0) staged.handlers.delete(event)
          else staged.handlers.set(event, next)
        }
      },
      registerCommand: (name, command) => {
        const safeName = validateName(name, "command")
        if (staged.commands.has(safeName) || this.commands.has(safeName)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `command '${safeName}' conflicts`)
        if (command === null || typeof command !== "object" || typeof command.handler !== "function") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "command is invalid")
        const aliases = parseStringList(command.aliases ?? [], "command aliases")
        if (aliases.some((alias) => alias === safeName || staged.commands.has(alias) || this.commands.has(alias))) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `command '${safeName}' alias conflicts`)
        staged.commands.set(safeName, Object.freeze({ description: boundedText(command.description ?? "", 512), aliases: Object.freeze(aliases), handler: command.handler }))
      },
      registerShortcut: (shortcut, value) => {
        const key = validateShortcut(shortcut)
        if (staged.shortcuts.has(key) || [...this.hotkeyRegistry.list()].some((binding) => binding.key === key)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `shortcut '${key}' conflicts`)
        if (value === null || typeof value !== "object" || typeof value.handler !== "function") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "shortcut is invalid")
        const commandId = `pi.${extensionId}.shortcut.${key.replace(/[^A-Za-z0-9._:-]/g, "-")}`
        staged.shortcuts.set(key, Object.freeze({ key, value, commandId }))
      },
      registerFlag: (name, defaultValue) => {
        const safeName = validateName(name, "flag")
        if (staged.flags.has(safeName) || this.flags.has(safeName)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `flag '${safeName}' conflicts`)
        if (defaultValue !== undefined && typeof defaultValue !== "boolean" && typeof defaultValue !== "string") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "flag default is invalid")
        staged.flags.set(safeName, defaultValue ?? false)
      },
      registerTool: (tool) => {
        const safeName = validateName(tool.name, "tool")
        if (staged.tools.has(safeName) || this.tools.has(safeName)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `tool '${safeName}' conflicts`)
        if (tool === null || typeof tool !== "object" || typeof tool.description !== "string" || typeof tool.execute !== "function") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "tool is invalid")
        if (tool.description.length === 0 || tool.description.length > 64 * 1024) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "tool description is invalid")
        const capabilities = parseStringList(tool.capabilities ?? [], "tool capabilities")
        const denied = capabilities.find((capability) => !this.trustedCapabilities.includes(capability))
        if (denied !== undefined) throw new PiExtensionError("PI_EXTENSION_CAPABILITY_DENIED", `tool '${safeName}' requires an untrusted capability`)
        staged.tools.set(safeName, Object.freeze({ ...tool, name: safeName, capabilities: Object.freeze(capabilities) }))
      },
      registerProvider: (provider) => {
        const safeName = validateName(provider.name, "provider")
        if (staged.providers.has(safeName) || this.providerRegistrations.has(safeName)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `provider '${safeName}' conflicts`)
        if (provider === null || typeof provider !== "object" || typeof provider.description !== "string") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "provider is invalid")
        const capabilities = parseStringList(provider.capabilities ?? [], "provider capabilities")
        const denied = capabilities.find((capability) => !this.trustedCapabilities.includes(capability))
        if (denied !== undefined) throw new PiExtensionError("PI_EXTENSION_CAPABILITY_DENIED", `provider '${safeName}' requires an untrusted capability`)
        staged.providers.set(safeName, Object.freeze({ ...provider, name: safeName, capabilities: Object.freeze(capabilities) }))
      },
      registerUI: (contribution) => {
        const safeId = validateName(contribution.id, "UI contribution")
        if (staged.ui.has(safeId) || this.ui.has(safeId)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `UI contribution '${safeId}' conflicts`)
        validateUiContribution(contribution)
        staged.ui.set(safeId, Object.freeze({ ...contribution, id: safeId, capabilities: Object.freeze(parseStringList(contribution.capabilities ?? [], "UI capabilities")) }))
      },
      registerMessageRenderer: (id, render) => registerRenderer(staged, id, "message", render, this.renderers),
      registerEntryRenderer: (id, render) => registerRenderer(staged, id, "entry", render, this.renderers),
      registerMarkdownTransformer: (id, render) => registerRenderer(staged, id, "markdown", (value) => {
        if (typeof value !== "string") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "markdown renderer received invalid input")
        return render(value)
      }, this.renderers),
      sendMessage: (message) => {
        const value = boundedText(message, 64 * 1024)
        const result = this.runtime.sendMessage?.(value)
        if (result !== undefined) void Promise.resolve(result)
      },
      sendUserMessage: (message) => {
        const value = boundedText(message, 64 * 1024)
        const result = this.runtime.sendUserMessage?.(value)
        if (result !== undefined) void Promise.resolve(result)
      },
      appendEntry: (customType, data) => {
        const type = validateName(customType, "entry type")
        if (this.entries.length >= MAX_ENTRIES) this.entries.shift()
        this.entries.push(Object.freeze({ customType: type, data }))
        const result = this.runtime.appendEntry?.(type, data)
        if (result !== undefined) void Promise.resolve(result)
      },
      setSessionName: (name) => {
        this.sessionName = boundedText(name, 160)
      },
      getSessionName: () => this.sessionName,
      exec: async (command, args = []) => {
        if (this.runtime.exec === undefined) throw new PiExtensionError("PI_EXTENSION_RUNTIME_UNAVAILABLE", "process execution is unavailable")
        return this.runtime.exec(boundedText(command, 256), Object.freeze(args.map((arg) => boundedText(arg, 4 * 1024))), this.runtime.signal)
      },
      getActiveTools: () => Object.freeze([...this.activeTools].sort()),
      getAllTools: () => Object.freeze([...this.tools.values(), ...staged.tools.values()].map((tool) => Object.freeze({ name: tool.name, label: "label" in tool && typeof tool.label === "string" ? tool.label : tool.name, description: tool.description, capabilities: Object.freeze([...(tool.capabilities ?? [])]) }))),
      setActiveTools: (toolNames) => {
        if (!Array.isArray(toolNames) || toolNames.length > MAX_CONTRIBUTIONS) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "active tool list is invalid")
        const next = new Set<string>()
        for (const name of toolNames) {
          const safeName = validateName(name, "active tool")
          if (!this.tools.has(safeName) && !staged.tools.has(safeName)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", `unknown active tool '${safeName}'`)
          next.add(safeName)
        }
        this.activeTools.clear()
        for (const name of next) this.activeTools.add(name)
      },
      getFlag: (name) => this.flags.get(validateName(name, "flag")) ?? staged.flags.get(validateName(name, "flag")),
    }
    return Object.freeze(api)
  }

  private context(extensionId: string): PiExtensionContext {
    const runtime = this.runtime
    const ui = runtime.ui
    const uiContext: PiExtensionUI = {
      select: (title, options) => ui?.select?.(boundedText(title, 512), Object.freeze(options.map((option) => boundedText(option, 512)))) ?? Promise.resolve(undefined),
      confirm: (title, message) => ui?.confirm?.(boundedText(title, 512), boundedText(message, 8 * 1024)) ?? Promise.resolve(false),
      input: (title, placeholder) => ui?.input?.(boundedText(title, 512), placeholder === undefined ? undefined : boundedText(placeholder, 512)) ?? Promise.resolve(undefined),
      notify: (message, type = "info") => {
        const notification: PiExtensionUINotification = Object.freeze({ message: boundedText(message, 2 * 1024), type })
        if (this.notifications.length >= 64) this.notifications.shift()
        this.notifications.push(notification)
        ui?.notify?.(notification.message, notification.type)
      },
      setStatus: (key, text) => {
        const safeKey = validateName(key, "status key")
        if (text === undefined) this.statuses.delete(safeKey)
        else this.statuses.set(safeKey, boundedText(text, 512))
      },
      setWidget: (key, content, placement = "aboveEditor") => {
        const safeKey = validateName(key, "widget key")
        if (content === undefined) this.widgets.delete(safeKey)
        else this.widgets.set(safeKey, Object.freeze({ content: Object.freeze(content.map((line) => boundedText(line, 4 * 1024))), placement }))
      },
      setHeader: (text) => { this.header = text === undefined ? undefined : boundedText(text, 4 * 1024) },
      setFooter: (text) => { this.footer = text === undefined ? undefined : boundedText(text, 4 * 1024) },
      setTitle: (title) => { this.title = boundedText(title, 512) },
      setEditorText: (text) => { this.editorText = boundedText(text, 64 * 1024) },
      getEditorText: () => this.editorText,
      pasteToEditor: (text) => { this.editorText = boundedText(`${this.editorText}${text}`, 64 * 1024) },
      setWorkingMessage: (message) => { this.workingMessage = message === undefined ? undefined : boundedText(message, 512) },
      setWorkingVisible: (visible) => { if (typeof visible !== "boolean") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "working visibility is invalid"); this.workingVisible = visible },
      setWorkingIndicator: (frames, intervalMs = 120) => {
        if (frames === undefined) { this.workingIndicator = undefined; return }
        if (!Array.isArray(frames) || frames.length > 64 || !Number.isSafeInteger(intervalMs) || intervalMs < 16 || intervalMs > 10_000) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "working indicator is invalid")
        this.workingIndicator = Object.freeze({ frames: Object.freeze(frames.map((frame) => boundedText(frame, 128))), intervalMs })
      },
      setHiddenThinkingLabel: (label) => { this.hiddenThinkingLabel = label === undefined ? undefined : boundedText(label, 256) },
      getToolsExpanded: () => this.toolsExpanded,
      setToolsExpanded: (expanded) => { if (typeof expanded !== "boolean") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "tool expansion state is invalid"); this.toolsExpanded = expanded },
      setTheme: (name) => { this.theme = name === undefined ? undefined : validateName(name, "theme") },
    }
    return Object.freeze({
      cwd: this.cwd,
      extensionId,
      mode: runtime.mode ?? "tui",
      hasUI: runtime.mode !== "json" && runtime.mode !== "print",
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      ui: Object.freeze(uiContext),
      isIdle: runtime.isIdle ?? (() => true),
      hasPendingMessages: runtime.hasPendingMessages ?? (() => false),
      abort: runtime.abort ?? (() => undefined),
      reload: async () => { if (runtime.reload !== undefined) await runtime.reload(); else await this.reload() },
      getContextUsage: runtime.getContextUsage ?? (() => undefined),
    })
  }

  private commit(staged: StagedExtension): void {
    const registeredCommands: string[] = []
    const registeredShortcuts: string[] = []
    try {
      for (const [name, command] of staged.commands) {
        const aliases = command.aliases ?? []
        this.commandRegistry.register({ id: name, aliases, description: command.description ?? "", execute: ({ args }) => command.handler(args.join(" "), this.context(staged.descriptor.id)) })
        registeredCommands.push(name)
        for (const alias of aliases) registeredCommands.push(alias)
        this.commands.set(name, Object.freeze({ name, description: command.description ?? "", execute: (args: string) => command.handler(args, this.context(staged.descriptor.id)) }))
      }
      for (const shortcut of staged.shortcuts.values()) {
        this.commandRegistry.register({ id: shortcut.commandId, description: shortcut.value.description ?? "Pi extension shortcut", execute: () => shortcut.value.handler(this.context(staged.descriptor.id)) })
        this.hotkeyRegistry.register({ key: shortcut.key, command: shortcut.commandId })
        registeredCommands.push(shortcut.commandId)
        registeredShortcuts.push(shortcut.key)
      }
      for (const [name, tool] of staged.tools) {
        const nativeTool: NativeTool = Object.freeze({
          name,
          description: tool.description,
          capabilities: Object.freeze([...(tool.capabilities ?? [])]),
          ...(tool.requiresApproval === undefined ? {} : { requiresApproval: tool.requiresApproval }),
          execute: async (input: unknown, context: { readonly cwd: string; readonly signal: AbortSignal }) => {
            if (!this.activeTools.has(name)) throw new PiExtensionError("PI_EXTENSION_TOOL_BLOCKED", `tool '${name}' is not active`)
            const callId = `pi-call-${this.revision + 1}-${name}`
            const before = await this.emit("tool_call", { sessionId: this.runtime.sessionId?.() ?? "unknown", toolCallId: callId, toolName: name, input })
            if (before.block === true) throw new PiExtensionError("PI_EXTENSION_TOOL_BLOCKED", before.reason ?? "tool call blocked by extension")
            try {
        const output = tool.execute.length >= 3
          ? await (tool.execute as PiCompatibleToolExecutor)(callId, input, context.signal)
          : await (tool.execute as PiExtensionToolExecutor)(input, { ...this.context(staged.descriptor.id), signal: context.signal })
              await this.emit("tool_result", { sessionId: this.runtime.sessionId?.() ?? "unknown", toolCallId: callId, toolName: name, output, isError: false })
              return output
            } catch (error) {
              await this.emit("tool_result", { sessionId: this.runtime.sessionId?.() ?? "unknown", toolCallId: callId, toolName: name, isError: true })
              throw error
            }
          },
        })
        this.tools.set(name, nativeTool)
        this.activeTools.add(name)
      }
      for (const [name, provider] of staged.providers) {
        if (provider.adapter !== undefined) this.providers.set(name, provider.adapter)
        this.providerRegistrations.set(name, provider)
      }
      for (const [id, contribution] of staged.ui) this.ui.set(id, Object.freeze({ ...contribution, revision: this.currentRevision }))
      for (const [id, renderer] of staged.renderers) this.renderers.set(id, renderer)
      for (const [name, value] of staged.flags) this.flags.set(name, value)
      for (const [event, list] of staged.handlers) {
        const current = this.handlers.get(event) ?? []
        this.handlers.set(event, [...current, ...list.map((handler) => ({ extensionId: staged.descriptor.id, handler }))])
      }
      this.records.set(staged.descriptor.id, Object.freeze({ descriptor: staged.descriptor, dispose: staged.dispose, commands: Object.freeze([...staged.commands.keys(), ...[...staged.shortcuts.values()].map((shortcut) => shortcut.commandId)]), shortcuts: Object.freeze([...staged.shortcuts.keys()]), tools: Object.freeze([...staged.tools.keys()]), providers: Object.freeze([...staged.providers.keys()]), ui: Object.freeze([...staged.ui.keys()]), flags: Object.freeze([...staged.flags.keys()]), renderers: Object.freeze([...staged.renderers.keys()]), handlers: new Map(staged.handlers) }))
    } catch (error) {
      for (const key of registeredShortcuts) this.hotkeyRegistry.unregister(key)
      for (const name of registeredCommands) this.commandRegistry.unregister(name)
      for (const name of staged.commands.keys()) this.commands.delete(name)
      for (const name of staged.tools.keys()) { this.tools.delete(name); this.activeTools.delete(name) }
      for (const name of staged.providers.keys()) { this.providers.delete(name); this.providerRegistrations.delete(name) }
      for (const id of staged.ui.keys()) this.ui.delete(id)
      for (const id of staged.renderers.keys()) this.renderers.delete(id)
      for (const name of staged.flags.keys()) this.flags.delete(name)
      for (const [event, handlers] of this.handlers) {
        const remaining = handlers.filter((item) => item.extensionId !== staged.descriptor.id)
        if (remaining.length === 0) this.handlers.delete(event)
        else this.handlers.set(event, remaining)
      }
      if (error instanceof PiExtensionError) throw error
      throw new PiExtensionError("PI_EXTENSION_CONFLICT", "extension contributions conflict")
    }
  }

  private rollbackStaged(staged: StagedExtension): void {
    void staged
  }

  private async resolvePath(pathInput: string): Promise<string> {
    if (typeof pathInput !== "string" || pathInput.length === 0 || pathInput.length > 512 || pathInput.includes("\0")) throw new PiExtensionError("PI_EXTENSION_PATH_INVALID", "extension path is invalid")
    const root = await realpath(this.cwd).catch(() => { throw new PiExtensionError("PI_EXTENSION_PATH_INVALID", "extension workspace is unavailable") })
    const candidate = isAbsolute(pathInput) ? resolve(pathInput) : resolve(root, pathInput)
    const path = await realpath(candidate).catch(() => { throw new PiExtensionError("PI_EXTENSION_PATH_INVALID", "extension path cannot be resolved") })
    const rel = relative(root, path)
    if (rel !== "" && (rel.startsWith(`..${sep}`) || rel === "..")) throw new PiExtensionError("PI_EXTENSION_PATH_INVALID", "extension path escapes workspace")
    const info = await lstat(path)
    if (!info.isFile()) throw new PiExtensionError("PI_EXTENSION_PATH_INVALID", "extension path is not a file")
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) throw new PiExtensionError("PI_EXTENSION_PATH_INVALID", "extension file type is unsupported")
    return path
  }
}

export function createPiExtensionHost(options: PiExtensionHostOptions): PiExtensionHost {
  return new PiExtensionHost(options)
}

/** Discover candidate files without importing or executing them. */
export async function discoverPiExtensions(cwd: string): Promise<readonly string[]> {
  const root = await realpath(resolve(cwd)).catch(() => undefined)
  if (root === undefined) return Object.freeze([])
  const candidates = [join(root, ".pi", "agent", "extensions"), join(root, ".pi", "extensions")]
  const result: string[] = []
  for (const directory of candidates) {
    const actual = await realpath(directory).catch(() => undefined)
    if (actual === undefined) continue
    const actualRel = relative(root, actual)
    if (actualRel !== "" && (actualRel.startsWith(`..${sep}`) || actualRel === "..")) continue
    const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}")
    for await (const file of glob.scan({ cwd: actual, dot: false })) {
      if (result.length >= 256) throw new PiExtensionError("PI_EXTENSION_INVALID", "extension discovery limit exceeded")
      result.push(join(actual, file))
    }
  }
  return Object.freeze([...new Set(result)].sort())
}

// Bun cannot unload a module, so an extension whose code has not changed reuses the module it already
// loaded; only an edit adds one. The extension's own relative imports are bundled into that module, so
// an edited helper is loaded fresh too instead of being served from Bun's cache by its path.
const MAX_LOADED_EXTENSIONS = 1_024
const loadedExtensions = new Map<string, { readonly digest: string; readonly module: unknown }>()

async function importExtensionModule(path: string): Promise<unknown> {
  let code: string
  try {
    const built = await Bun.build({ entrypoints: [path], target: "bun", format: "esm", packages: "external", throw: false })
    const output = built.outputs.find((artifact) => artifact.kind === "entry-point")
    if (!built.success || output === undefined) throw new Error("extension could not be bundled")
    code = await output.text()
  } catch {
    throw new PiExtensionError("PI_EXTENSION_ENTRY_INVALID", "extension could not be loaded")
  }
  const digest = createHash("sha256").update(code).digest("hex")
  const loaded = loadedExtensions.get(path)
  if (loaded?.digest === digest) return loaded.module
  // Beside the entry, so package imports resolve from the same folder they did before bundling.
  const cachePath = join(dirname(path), `.runrail-pi-extension-${randomUUID()}.js`)
  await writeFile(cachePath, code, { encoding: "utf8", flag: "wx", mode: 0o600 })
  let module: unknown
  try {
    module = await import(pathToFileURL(cachePath).href)
  } finally {
    await unlink(cachePath)
  }
  loadedExtensions.delete(path)
  loadedExtensions.set(path, { digest, module })
  if (loadedExtensions.size > MAX_LOADED_EXTENSIONS) loadedExtensions.delete(loadedExtensions.keys().next().value!)
  return module
}

function isExtensionModule(value: unknown): value is PiExtensionModule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.default === "function" && (record.id === undefined || typeof record.id === "string") && (record.capabilities === undefined || Array.isArray(record.capabilities))
}

function readDispose(value: unknown): (() => void | PromiseLike<void>) | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const dispose = (value as Record<string, unknown>).dispose
  return typeof dispose === "function" ? () => dispose() : undefined
}

function parseExtensionId(value: unknown, path: string): string {
  const fallback = basename(path).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "-")
  return validateName(typeof value === "string" && value.length > 0 ? value : `pi.${fallback || "extension"}`, "extension id")
}

function validateName(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", `${field} is invalid`)
  return value
}

function validateShortcut(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(value)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "shortcut is invalid")
  return value
}

function validateEvent(value: string): void {
  if (!(value in eventNames)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "event is unsupported")
}

const eventNames: Readonly<Record<PiExtensionEventName, true>> = Object.freeze({
  project_trust: true,
  resources_discover: true,
  session_start: true,
  session_shutdown: true,
  reload: true,
  session_compact: true,
  input: true,
  before_agent_start: true,
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  tool_call: true,
  tool_result: true,
  model_select: true,
  thinking_level_select: true,
})

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", `${field} is invalid`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item) || result.includes(item)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", `${field} is invalid`)
    result.push(item)
  }
  return result.sort()
}

function validateUiContribution(value: PiExtensionUIContribution): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI contribution is invalid")
  const allowed = new Set(["id", "slot", "label", "capabilities", "theme", "status"])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI contribution contains unsupported fields")
  if (typeof value.label !== "string" || value.label.length === 0 || value.label.length > 120) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI contribution label is invalid")
  const slots = ["sidebar", "main", "timeline", "diff", "workflow", "status"]
  if (!slots.includes(value.slot)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI contribution slot is invalid")
  if (value.theme !== undefined) {
    if (typeof value.theme !== "object" || value.theme === null || typeof value.theme.name !== "string" || value.theme.name.length === 0 || value.theme.name.length > 128) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI theme is invalid")
    if (value.theme.accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(value.theme.accent)) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI theme accent is invalid")
    if (value.theme.density !== undefined && value.theme.density !== "compact" && value.theme.density !== "comfortable") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI theme density is invalid")
  }
  if (value.status !== undefined) {
    if (typeof value.status !== "object" || value.status === null || typeof value.status.text !== "string" || value.status.text.length === 0 || value.status.text.length > 160) throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI status is invalid")
    if (value.status.tone !== undefined && value.status.tone !== "neutral" && value.status.tone !== "positive" && value.status.tone !== "warning" && value.status.tone !== "danger") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "UI status tone is invalid")
  }
}

function registerRenderer(
  staged: StagedExtension,
  id: string,
  kind: PiExtensionRendererKind,
  render: (value: unknown) => unknown,
  active: ReadonlyMap<string, PiExtensionRenderer>,
): void {
  const safeId = validateName(id, `${kind} renderer`)
  if (typeof render !== "function" || staged.renderers.has(safeId) || active.has(safeId)) throw new PiExtensionError("PI_EXTENSION_CONFLICT", `${kind} renderer '${safeId}' conflicts`)
  staged.renderers.set(safeId, Object.freeze({ id: safeId, kind, render }))
}

function boundedText(value: string, max: number): string {
  if (typeof value !== "string") throw new PiExtensionError("PI_EXTENSION_CONTRIBUTION_INVALID", "text is invalid")
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
