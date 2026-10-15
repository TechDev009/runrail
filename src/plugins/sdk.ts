import { pathToFileURL } from "node:url"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { realpath } from "node:fs/promises"
import {
  IsolatedExtensionWorker as NifraIsolatedExtensionWorker,
  type IsolatedExtensionWorker,
  type NativeTool,
  type UiExtensionManifest,
} from "@nifrajs/coding-agent"
import type { NativeEvent, NativeEventType } from "../native/events.ts"
import type { NativeExtensionManifest, NativeUIDescriptor } from "../native/manifest.ts"
import type { ModelAdapter } from "../model/catalog.ts"
import type { PluginAdmission } from "./registry.ts"
import type { PluginContributionKind, RunrailPluginManifest } from "./manifest.ts"

export interface PluginCommand {
  readonly name: string
  readonly description: string
  readonly execute: (args: string) => unknown | PromiseLike<unknown>
}

export interface PluginPrompt {
  readonly id: string
  readonly template: string
}

export interface PluginTextResource {
  readonly id: string
  readonly content: string
}

export interface PluginVerificationGate {
  readonly name: string
  readonly capabilities: readonly string[]
  readonly run: (input: { readonly cwd: string; readonly signal: AbortSignal }) => unknown | PromiseLike<unknown>
}

export interface PluginWorkflowNode {
  readonly name: string
  readonly capabilities: readonly string[]
  readonly run: (input: unknown, context: { readonly cwd: string; readonly signal: AbortSignal }) => unknown | PromiseLike<unknown>
}

export interface PluginSubagent {
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly capabilities: readonly string[]
}
export type NativeExtensionHookName = NativeEventType

export interface NativeExtensionContext {
  readonly cwd: string
  readonly taskId?: string
  readonly sessionId?: string
  readonly capabilities: readonly string[]
  readonly signal?: AbortSignal
}

export interface NativeExtensionAction {
  readonly id: string
  readonly label: string
  readonly capability?: string
  readonly approvalRequired: boolean
  readonly execute: (input: unknown, context: NativeExtensionContext) => unknown | PromiseLike<unknown>
}

export interface NativeExtensionHook {
  readonly event: NativeExtensionHookName
  readonly handle: (event: NativeEvent, context: NativeExtensionContext) => void | PromiseLike<void>
}

export interface NativeExtensionContributionSet {
  readonly actions?: readonly NativeExtensionAction[]
  readonly hooks?: readonly NativeExtensionHook[]
  readonly nativeUI?: readonly NativeUIDescriptor[]
}

export interface PluginContributionSet {
  readonly tools?: readonly NativeTool[]
  readonly commands?: readonly PluginCommand[]
  readonly prompts?: readonly PluginPrompt[]
  readonly skills?: readonly PluginTextResource[]
  readonly themes?: readonly PluginTextResource[]
  readonly ui?: readonly UiExtensionManifest[]
  readonly providers?: readonly ModelAdapter[]
  readonly verification?: readonly PluginVerificationGate[]
  readonly workflows?: readonly PluginWorkflowNode[]
  readonly subagents?: readonly PluginSubagent[]
  readonly actions?: readonly NativeExtensionAction[]
  readonly hooks?: readonly NativeExtensionHook[]
  readonly nativeUI?: readonly NativeUIDescriptor[]
}

export interface RunrailPluginModule {
  readonly activate: (context: RunrailPluginContext) => PluginContributionSet | void | PromiseLike<PluginContributionSet | void>
  readonly deactivate?: () => void | PromiseLike<void>
}

export interface RunrailPluginContext {
  readonly cwd: string
  readonly manifest: RunrailPluginManifest
  readonly onNativeEvent: (hook: NativeExtensionHook) => void
  readonly nativeManifest?: NativeExtensionManifest
  readonly capabilities: readonly string[]
  readonly config: unknown
  readonly register: (contributions: PluginContributionSet) => void
}

export interface PluginHostSnapshot {
  readonly plugins: readonly string[]
  readonly tools: readonly NativeTool[]
  readonly commands: readonly PluginCommand[]
  readonly prompts: readonly PluginPrompt[]
  readonly skills: readonly PluginTextResource[]
  readonly themes: readonly PluginTextResource[]
  readonly ui: readonly UiExtensionManifest[]
  readonly providers: readonly ModelAdapter[]
  readonly verification: readonly PluginVerificationGate[]
  readonly workflows: readonly PluginWorkflowNode[]
  readonly subagents: readonly PluginSubagent[]
  readonly actions?: readonly NativeExtensionAction[]
  readonly hooks?: readonly NativeExtensionHook[]
  readonly nativeUI?: readonly NativeUIDescriptor[]
}

/** Minimal host seam shared by the native Runrail plugin host and Pi adapters. */
export interface PluginHost {
  snapshot(): PluginHostSnapshot
}

export type PluginHostErrorCode =
  | "PLUGIN_ACTIVATION_FAILED"
  | "PLUGIN_DEACTIVATION_FAILED"
  | "PLUGIN_ENTRY_INVALID"
  | "PLUGIN_CONTRIBUTION_INVALID"
  | "PLUGIN_CONTRIBUTION_UNDECLARED"

export class PluginHostError extends Error {
  constructor(readonly code: PluginHostErrorCode, reason: string) {
    super(`plugin host: ${reason}`)
    this.name = "PluginHostError"
  }
}

/** Host for admitted trusted plugins. It never grants capabilities beyond the manifest. */
export class TrustedPluginHost {
  private readonly loaded = new Map<string, RunrailPluginModule>()
  private readonly contributions = new Map<string, PluginContributionSet>()

  async activate(
    admission: PluginAdmission,
    root: string,
    config: unknown = undefined,
  ): Promise<PluginHostSnapshot> {
    if (admission.mode !== "trusted") throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", "trusted host received an isolated plugin")
    const entry = await safeEntry(root, admission.manifest.entry)
    let moduleValue: unknown
    try {
      // Keyed by the checked digest, so an update or rollback loads its own code instead of the cached copy.
      moduleValue = await import(`${pathToFileURL(entry).href}?integrity=${encodeURIComponent(admission.manifest.integrity.digest)}`)
    } catch (error) {
      throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", error instanceof Error ? error.message : "plugin entry failed to load")
    }
    if (!isRecord(moduleValue) || !isPluginModule(moduleValue))
      throw new PluginHostError("PLUGIN_ENTRY_INVALID", "plugin entry must export activate")
    const registered: PluginContributionSet[] = []
    const context: RunrailPluginContext = Object.freeze({
      cwd: root,
      manifest: admission.manifest,
      capabilities: admission.capabilities,
      config,
      register: (contributions) => registered.push(validateContributions(admission.manifest, contributions)),
      onNativeEvent: (hook) => registered.push(validateContributions(admission.manifest, { hooks: [hook] })),
    })
    let returned: PluginContributionSet | void
    try {
      returned = await moduleValue.activate(context)
    } catch (error) {
      throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", error instanceof Error ? error.message : "plugin activation failed")
    }
    if (returned !== undefined) registered.push(validateContributions(admission.manifest, returned))
    if (this.loaded.has(admission.manifest.id)) await this.deactivate(admission.manifest.id)
    this.loaded.set(admission.manifest.id, moduleValue)
    this.contributions.set(admission.manifest.id, mergeContributions(registered))
    return this.snapshot()
  }

  async deactivate(id: string): Promise<PluginHostSnapshot> {
    const moduleValue = this.loaded.get(id)
    if (moduleValue === undefined) return this.snapshot()
    try {
      await moduleValue.deactivate?.()
    } catch (error) {
      throw new PluginHostError("PLUGIN_DEACTIVATION_FAILED", error instanceof Error ? error.message : "plugin deactivation failed")
    }
    this.loaded.delete(id)
    this.contributions.delete(id)
    return this.snapshot()
  }
  async invokeNativeAction(id: string, input: unknown, context: NativeExtensionContext): Promise<unknown> {
    if (!boundedName(id)) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native action id is invalid")
    const action = this.snapshot().actions?.find((candidate) => candidate.id === id)
    if (action === undefined) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native action is not registered")
    if (action.capability !== undefined && !context.capabilities.includes(action.capability)) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native action capability is not admitted")
    if (context.signal?.aborted === true) throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", "native action was cancelled")
    try {
      return await action.execute(input, context)
    } catch {
      throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", "native action failed")
    }
  }

  async emitNativeEvent(event: NativeEvent, context: NativeExtensionContext): Promise<void> {
    const hooks = this.snapshot().hooks?.filter((hook) => hook.event === event.type) ?? []
    for (const hook of hooks) {
      if (context.signal?.aborted === true) throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", "native hook delivery was cancelled")
      try {
        await hook.handle(event, context)
      } catch {
        throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", "native hook failed")
      }
    }
  }

  /** Every plugin is unloaded even when one fails to deactivate; the first failure is reported after. */
  async close(): Promise<void> {
    let failure: unknown
    for (const id of [...this.loaded.keys()]) {
      try {
        await this.deactivate(id)
      } catch (error) {
        failure ??= error
        this.loaded.delete(id)
        this.contributions.delete(id)
      }
    }
    if (failure !== undefined) throw failure
  }

  snapshot(): PluginHostSnapshot {
    const all = [...this.contributions.values()]
    return Object.freeze({
      plugins: Object.freeze([...this.loaded.keys()].sort()),
      tools: Object.freeze(all.flatMap((item) => item.tools ?? [])),
      commands: Object.freeze(all.flatMap((item) => item.commands ?? [])),
      prompts: Object.freeze(all.flatMap((item) => item.prompts ?? [])),
      skills: Object.freeze(all.flatMap((item) => item.skills ?? [])),
      themes: Object.freeze(all.flatMap((item) => item.themes ?? [])),
      ui: Object.freeze(all.flatMap((item) => item.ui ?? [])),
      providers: Object.freeze(all.flatMap((item) => item.providers ?? [])),
      verification: Object.freeze(all.flatMap((item) => item.verification ?? [])),
      workflows: Object.freeze(all.flatMap((item) => item.workflows ?? [])),
      subagents: Object.freeze(all.flatMap((item) => item.subagents ?? [])),
      actions: Object.freeze(all.flatMap((item) => item.actions ?? [])),
      hooks: Object.freeze(all.flatMap((item) => item.hooks ?? [])),
      nativeUI: Object.freeze(all.flatMap((item) => item.nativeUI ?? [])),
    })
  }
}

export interface IsolatedPluginWorkerOptions {
  readonly timeoutMs?: number
  readonly maxMessageBytes?: number
  readonly trustedCapabilities?: readonly string[]
  readonly exposeErrorStacks?: boolean
}

/** Start an admitted isolated worker through Nifra's public worker contract. */
export async function startIsolatedPluginWorker(
  admission: PluginAdmission,
  root: string,
  options: IsolatedPluginWorkerOptions = {},
): Promise<IsolatedExtensionWorker> {
  if (admission.mode !== "isolated") throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", "isolated worker received a trusted plugin")
  const entry = await safeEntry(root, admission.manifest.entry)
  const worker = new NifraIsolatedExtensionWorker({
    modulePath: entry,
    cwd: root,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    ...(options.trustedCapabilities === undefined ? {} : { trustedCapabilities: options.trustedCapabilities }),
    ...(options.exposeErrorStacks === undefined ? {} : { exposeErrorStacks: options.exposeErrorStacks }),
  })
  try {
    await worker.start()
  } catch (error) {
    await worker.close()
    throw new PluginHostError("PLUGIN_ACTIVATION_FAILED", error instanceof Error ? error.message : "isolated plugin failed to start")
  }
  return worker
}

function validateContributions(manifest: RunrailPluginManifest, value: unknown): PluginContributionSet {
  if (!isRecord(value)) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "contributions must be an object")
  const keys: readonly [keyof PluginContributionSet, PluginContributionKind][] = [
    ["tools", "tools"],
    ["commands", "commands"],
    ["prompts", "prompts"],
    ["skills", "skills"],
    ["themes", "themes"],
    ["ui", "ui"],
    ["providers", "providers"],
    ["verification", "verification"],
    ["workflows", "workflows"],
    ["subagents", "subagents"],
    ["actions", "actions"],
    ["hooks", "hooks"],
    ["nativeUI", "native-ui"],
  ]
  for (const [key, kind] of keys) {
    const item = value[key]
    if (item === undefined) continue
    if (!manifest.contributes.includes(kind))
      throw new PluginHostError("PLUGIN_CONTRIBUTION_UNDECLARED", `plugin did not declare '${kind}' contribution`)
    if (!Array.isArray(item) || item.length > 256)
      throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", `${kind} contributions are invalid`)
  }
  const tools = arrayContribution(value.tools, isNativeTool, "tools")
  if (tools !== undefined && tools.some((tool) => !declaredCapabilities(manifest, tool.capabilities ?? [])))
    throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "plugin tools escalate capabilities")
  const commands = arrayContribution(value.commands, isPluginCommand, "commands")
  if (commands !== undefined && duplicateNames(commands.map((command) => command.name)))
    throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "plugin commands contain duplicates")
  const prompts = arrayContribution(value.prompts, isPluginPrompt, "prompts")
  if (prompts !== undefined && duplicateNames(prompts.map((prompt) => prompt.id)))
    throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "plugin prompts contain duplicates")
  const skills = arrayContribution(value.skills, isTextResource, "skills")
  const themes = arrayContribution(value.themes, isTextResource, "themes")
  const ui = arrayContribution(value.ui, isUiManifest, "ui")
  const providers = arrayContribution(value.providers, isModelAdapter, "providers")
  const actions = arrayContribution(value.actions, isNativeAction, "actions")
  const hooks = arrayContribution(value.hooks, isNativeHook, "hooks")
  const nativeUI = arrayContribution(value.nativeUI, isNativeUI, "native UI")
  const verification = arrayContribution(value.verification, isVerificationGate, "verification")
  const workflows = arrayContribution(value.workflows, isWorkflowNode, "workflows")
  const subagents = arrayContribution(value.subagents, isSubagent, "subagents")
  if (actions !== undefined) {
    if (duplicateNames(actions.map((action) => action.id))) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native actions contain duplicates")
    if (actions.some((action) => action.capability !== undefined && !manifest.capabilities.includes(action.capability))) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native actions escalate capabilities")
  }
  if (hooks !== undefined && hooks.some((hook) => !isNativeEventType(hook.event))) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native hooks contain an unsupported event")
  if (nativeUI !== undefined) {
    if (duplicateNames(nativeUI.map((item) => item.id))) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native UI contains duplicates")
    if (nativeUI.some((item) => !declaredCapabilities(manifest, item.capabilities))) throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "native UI escalates capabilities")
  }
  if (verification !== undefined && verification.some((item) => !declaredCapabilities(manifest, item.capabilities)))
    throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "plugin verification gates escalate capabilities")
  if (workflows !== undefined && workflows.some((item) => !declaredCapabilities(manifest, item.capabilities)))
    throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "plugin workflow nodes escalate capabilities")
  if (subagents !== undefined && subagents.some((item) => !declaredCapabilities(manifest, item.capabilities)))
    throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", "plugin subagents escalate capabilities")
  return Object.freeze({
    ...(tools === undefined ? {} : { tools }),
    ...(commands === undefined ? {} : { commands }),
    ...(prompts === undefined ? {} : { prompts }),
    ...(skills === undefined ? {} : { skills }),
    ...(actions === undefined ? {} : { actions }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(nativeUI === undefined ? {} : { nativeUI }),
    ...(themes === undefined ? {} : { themes }),
    ...(ui === undefined ? {} : { ui }),
    ...(providers === undefined ? {} : { providers }),
    ...(verification === undefined ? {} : { verification }),
    ...(workflows === undefined ? {} : { workflows }),
    ...(subagents === undefined ? {} : { subagents }),
  })
}

function arrayContribution<T>(value: unknown, guard: (value: unknown) => value is T, name: string): readonly T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 256 || !value.every(guard))
    throw new PluginHostError("PLUGIN_CONTRIBUTION_INVALID", `${name} contributions are invalid`)
  return Object.freeze(value)
}

function mergeContributions(values: readonly PluginContributionSet[]): PluginContributionSet {
  return Object.freeze({
    tools: Object.freeze(values.flatMap((item) => item.tools ?? [])),
    commands: Object.freeze(values.flatMap((item) => item.commands ?? [])),
    prompts: Object.freeze(values.flatMap((item) => item.prompts ?? [])),
    skills: Object.freeze(values.flatMap((item) => item.skills ?? [])),
    themes: Object.freeze(values.flatMap((item) => item.themes ?? [])),
    ui: Object.freeze(values.flatMap((item) => item.ui ?? [])),
    providers: Object.freeze(values.flatMap((item) => item.providers ?? [])),
    verification: Object.freeze(values.flatMap((item) => item.verification ?? [])),
    workflows: Object.freeze(values.flatMap((item) => item.workflows ?? [])),
    subagents: Object.freeze(values.flatMap((item) => item.subagents ?? [])),
    actions: Object.freeze(values.flatMap((item) => item.actions ?? [])),
    hooks: Object.freeze(values.flatMap((item) => item.hooks ?? [])),
    nativeUI: Object.freeze(values.flatMap((item) => item.nativeUI ?? [])),
  })
}

async function safeEntry(root: string, entry: string): Promise<string> {
  if (isAbsolute(entry) || entry.includes("\\") || entry.split("/").includes(".."))
    throw new PluginHostError("PLUGIN_ENTRY_INVALID", "plugin entry must be relative")
  const packageRoot = resolve(root)
  const resolved = resolve(packageRoot, entry)
  const rel = relative(packageRoot, resolved)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new PluginHostError("PLUGIN_ENTRY_INVALID", "plugin entry escapes its package")
  try {
    const actual = await realpath(resolved)
    const actualRel = relative(packageRoot, actual)
    if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel))
      throw new PluginHostError("PLUGIN_ENTRY_INVALID", "plugin entry symlink escapes its package")
    return actual
  } catch (error) {
    if (error instanceof PluginHostError) throw error
    throw new PluginHostError("PLUGIN_ENTRY_INVALID", error instanceof Error ? error.message : "plugin entry cannot be resolved")
  }
}

function isPluginModule(value: Record<string, unknown>): value is Record<string, unknown> & RunrailPluginModule {
  return typeof value.activate === "function"
}

function isNativeTool(value: unknown): value is NativeTool {
  return isRecord(value) && boundedName(value.name) && typeof value.description === "string" && typeof value.execute === "function" && isOptionalStringList(value.capabilities)
}

function isPluginCommand(value: unknown): value is PluginCommand {
  return isRecord(value) && boundedName(value.name) && typeof value.description === "string" && typeof value.execute === "function"
}

function isPluginPrompt(value: unknown): value is PluginPrompt {
  return isRecord(value) && boundedName(value.id) && typeof value.template === "string" && value.template.length <= 64 * 1024
}

function isTextResource(value: unknown): value is PluginTextResource {
  return isRecord(value) && boundedName(value.id) && typeof value.content === "string" && value.content.length <= 256 * 1024
}

function isModelAdapter(value: unknown): value is ModelAdapter {
  return isRecord(value) && isRecord(value.descriptor) && typeof value.create === "function"
}

function isUiManifest(value: unknown): value is UiExtensionManifest {
  return isRecord(value) && boundedName(value.id) && typeof value.revision === "string" && boundedName(value.label)
}

function isVerificationGate(value: unknown): value is PluginVerificationGate {
  return isRecord(value) && boundedName(value.name) && isStringList(value.capabilities, true) && typeof value.run === "function"
}

function isWorkflowNode(value: unknown): value is PluginWorkflowNode {
  return isRecord(value) && boundedName(value.name) && isStringList(value.capabilities, true) && typeof value.run === "function"
}

function isSubagent(value: unknown): value is PluginSubagent {
  return isRecord(value) && boundedName(value.name) && typeof value.description === "string" && value.description.length <= 256 && typeof value.prompt === "string" && value.prompt.length <= 64 * 1024 && isStringList(value.capabilities, true)
}
function isNativeAction(value: unknown): value is NativeExtensionAction {
  return isRecord(value) && boundedName(value.id) && typeof value.label === "string" && value.label.length > 0 && value.label.length <= 256 && typeof value.approvalRequired === "boolean" && typeof value.execute === "function" && (value.capability === undefined || boundedName(value.capability))
}

function isNativeHook(value: unknown): value is NativeExtensionHook {
  return isRecord(value) && isNativeEventType(value.event) && typeof value.handle === "function"
}

function isNativeUI(value: unknown): value is NativeUIDescriptor {
  return isRecord(value) && boundedName(value.id) && boundedName(value.slot) && typeof value.label === "string" && value.label.length > 0 && value.label.length <= 256 && isOptionalStringList(value.capabilities)
}
function isNativeEventType(value: unknown): value is NativeEventType {
  return typeof value === "string" && NATIVE_EVENT_TYPES.has(value as NativeEventType)
}

const NATIVE_EVENT_TYPES = new Set<NativeEventType>([
  "task.created", "task.started", "task.waiting", "task.completed", "task.failed", "task.cancelled", "turn.started", "turn.completed",
  "tool.started", "tool.completed", "approval.required", "approval.resolved", "plan.step", "agent.run", "verification.completed", "repair.attempt",
  "budget.updated", "package.activated", "package.rolled_back", "account.updated", "share.updated",
])

function isStringList(value: unknown, required = false): value is readonly string[] {
  return (required || value !== undefined) && Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === "string" && boundedName(item))
}

function isOptionalStringList(value: unknown): value is readonly string[] | undefined {
  return value === undefined || isStringList(value, true)
}

function declaredCapabilities(manifest: RunrailPluginManifest, capabilities: readonly string[]): boolean {
  return capabilities.every((capability) => manifest.capabilities.includes(capability))
}

function duplicateNames(names: readonly string[]): boolean {
  return new Set(names).size !== names.length
}

function boundedName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
