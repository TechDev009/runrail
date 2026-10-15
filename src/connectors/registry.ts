import type { NativeTool } from "@nifrajs/coding-agent"
import { redactCommandText } from "../background/redact.ts"
import { assertJsonSize } from "../mcp/protocol.ts"

export type ConnectorActionKind = "read" | "search" | "write" | "notify" | "custom"

export interface ConnectorDescriptor {
  readonly id: string
  readonly version: string
  readonly capabilities: readonly string[]
  readonly kind?: string
}

export interface ConnectorAction {
  readonly name: string
  readonly description: string
  readonly kind: ConnectorActionKind
  readonly capabilities: readonly string[]
  readonly requiresApproval?: boolean
  readonly execute: (input: unknown, context: { readonly cwd: string; readonly signal: AbortSignal }) => unknown | PromiseLike<unknown>
}

export interface ConnectorDefinition {
  readonly descriptor: ConnectorDescriptor
  readonly actions: readonly ConnectorAction[]
  /** Credentials and transport clients remain inside this caller-owned implementation. */
  readonly close?: () => void | PromiseLike<void>
}

export interface ConnectorInvocationOptions {
  readonly cwd: string
  readonly signal: AbortSignal
  readonly allowedCapabilities?: readonly string[]
  readonly approve?: (input: { readonly connector: ConnectorDescriptor; readonly action: ConnectorAction; readonly input: unknown }) => boolean | PromiseLike<boolean>
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
}

export interface ConnectorNativeToolOptions extends Omit<ConnectorInvocationOptions, "cwd" | "signal" | "input" | "approve"> {
  readonly cwd: string
  readonly approve?: ConnectorInvocationOptions["approve"]
  readonly namespace?: string
}

export type ConnectorErrorCode = "CONNECTOR_INVALID" | "CONNECTOR_DUPLICATE" | "CONNECTOR_NOT_FOUND" | "CONNECTOR_ACTION_NOT_FOUND" | "CONNECTOR_CAPABILITY_DENIED" | "CONNECTOR_APPROVAL_DENIED" | "CONNECTOR_LIMIT" | "CONNECTOR_CREDENTIALS" | "CONNECTOR_AUTH_FAILED" | "CONNECTOR_RATE_LIMITED" | "CONNECTOR_TIMEOUT" | "CONNECTOR_CANCELLED" | "CONNECTOR_TRANSPORT" | "CONNECTOR_FAILED"

export class ConnectorError extends Error {
  constructor(readonly code: ConnectorErrorCode, reason: string) {
    super(`connector: ${reason}`)
    this.name = "ConnectorError"
  }
}

/** Registry for caller-owned integrations; Runrail supplies policy and lifecycle, never credentials. */
export class ConnectorRegistry {
  private readonly definitions = new Map<string, ConnectorDefinition>()

  register(definition: ConnectorDefinition): this {
    validateDefinition(definition)
    if (this.definitions.has(definition.descriptor.id)) throw new ConnectorError("CONNECTOR_DUPLICATE", `duplicate connector '${definition.descriptor.id}'`)
    this.definitions.set(definition.descriptor.id, freezeDefinition(definition))
    return this
  }

  get(id: string): ConnectorDefinition | undefined {
    return this.definitions.get(id)
  }

  list(): readonly ConnectorDescriptor[] {
    return Object.freeze([...this.definitions.values()].map((definition) => definition.descriptor).sort((left, right) => left.id.localeCompare(right.id)))
  }

  actions(id: string): readonly ConnectorAction[] {
    return this.require(id).actions
  }

  async invoke(id: string, actionName: string, input: unknown, options: ConnectorInvocationOptions): Promise<unknown> {
    const definition = this.require(id)
    const action = definition.actions.find((candidate) => candidate.name === actionName)
    if (action === undefined) throw new ConnectorError("CONNECTOR_ACTION_NOT_FOUND", `unknown action '${actionName}'`)
    validateInvocation(options, input)
    if (!supports(options.allowedCapabilities ?? [], action.capabilities)) throw new ConnectorError("CONNECTOR_CAPABILITY_DENIED", "connector action capability is not authorized")
    if (action.requiresApproval === true) {
      if (options.approve === undefined || !(await options.approve({ connector: definition.descriptor, action, input }))) throw new ConnectorError("CONNECTOR_APPROVAL_DENIED", "connector action approval was denied")
    }
    try {
      const result = await action.execute(input, { cwd: options.cwd, signal: options.signal })
      try {
        assertJsonSize(result, options.maxOutputBytes ?? 256 * 1024)
      } catch {
        throw new ConnectorError("CONNECTOR_LIMIT", "connector output exceeds its byte limit")
      }
      return result
    } catch (error) {
      // A caller's connector may put a token or a payload in its message: other errors keep none of
      // it, and a ConnectorError's own text crosses masked and bounded.
      if (error instanceof ConnectorError) throw new ConnectorError(error.code, redactCommandText(error.message.replace(/^connector: /, "")))
      throw new ConnectorError("CONNECTOR_FAILED", `action '${actionName}' failed`)
    }
  }

  async nativeTools(options: ConnectorNativeToolOptions): Promise<readonly NativeTool[]> {
    validateNativeOptions(options)
    const tools: NativeTool[] = []
    const namespace = options.namespace ?? "connector"
    for (const definition of this.definitions.values()) {
      for (const action of definition.actions) {
        const name = `${namespace}.${definition.descriptor.id}.${action.name}`
        if (!validName(name)) throw new ConnectorError("CONNECTOR_INVALID", "connector native tool name is invalid")
        tools.push(Object.freeze({
          name,
          description: action.description,
          capabilities: Object.freeze([...action.capabilities]),
          ...((action.requiresApproval === true || action.kind === "write" || action.kind === "notify") ? { requiresApproval: true } : {}),
          execute: (input: unknown, context: { readonly cwd: string; readonly signal: AbortSignal }) => this.invoke(definition.descriptor.id, action.name, input, {
            cwd: context.cwd,
            signal: context.signal,
            allowedCapabilities: options.allowedCapabilities,
            ...(options.approve === undefined ? {} : { approve: options.approve }),
            ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }),
            ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
          }),
        }))
      }
    }
    return Object.freeze(tools)
  }

  async close(): Promise<void> {
    for (const definition of this.definitions.values()) await definition.close?.()
  }

  private require(id: string): ConnectorDefinition {
    if (!validName(id)) throw new ConnectorError("CONNECTOR_INVALID", "connector id is invalid")
    const definition = this.definitions.get(id)
    if (definition === undefined) throw new ConnectorError("CONNECTOR_NOT_FOUND", `unknown connector '${id}'`)
    return definition
  }
}

export function createConnectorRegistry(definitions: readonly ConnectorDefinition[] = []): ConnectorRegistry {
  const registry = new ConnectorRegistry()
  for (const definition of definitions) registry.register(definition)
  return registry
}

function validateDefinition(definition: ConnectorDefinition): void {
  if (definition === null || typeof definition !== "object" || definition.descriptor === undefined || !isRecord(definition.descriptor)) throw new ConnectorError("CONNECTOR_INVALID", "connector definition is invalid")
  const descriptor = definition.descriptor
  if (!validName(descriptor.id) || !validVersion(descriptor.version) || !Array.isArray(descriptor.capabilities) || descriptor.capabilities.length > 64 || descriptor.capabilities.some((value) => !validCapability(value))) throw new ConnectorError("CONNECTOR_INVALID", "connector descriptor is invalid")
  if (!Array.isArray(definition.actions) || definition.actions.length > 256) throw new ConnectorError("CONNECTOR_LIMIT", "connector action count is invalid")
  const names = new Set<string>()
  for (const action of definition.actions) {
    if (!isRecord(action) || !validName(action.name) || typeof action.description !== "string" || action.description.length === 0 || action.description.length > 64 * 1024 || !isActionKind(action.kind) || !Array.isArray(action.capabilities) || action.capabilities.length > 32 || action.capabilities.some((value) => !validCapability(value)) || typeof action.execute !== "function" || (action.requiresApproval !== undefined && typeof action.requiresApproval !== "boolean") || names.has(action.name)) throw new ConnectorError("CONNECTOR_INVALID", "connector action is invalid")
    if (!supports(descriptor.capabilities, action.capabilities)) throw new ConnectorError("CONNECTOR_CAPABILITY_DENIED", "connector action exceeds descriptor capabilities")
    names.add(action.name)
  }
}

function freezeDefinition(definition: ConnectorDefinition): ConnectorDefinition {
  return Object.freeze({
    ...definition,
    descriptor: Object.freeze({ ...definition.descriptor, capabilities: Object.freeze([...definition.descriptor.capabilities].sort()) }),
    actions: Object.freeze(definition.actions.map((action) => Object.freeze({
      ...action,
      capabilities: Object.freeze([...action.capabilities].sort()),
      ...((action.requiresApproval === true || action.kind === "write" || action.kind === "notify") ? { requiresApproval: true } : {}),
    }))),
  })
}

function validateInvocation(options: ConnectorInvocationOptions, input: unknown): void {
  if (options === null || typeof options !== "object" || typeof options.cwd !== "string" || options.cwd.length === 0 || options.cwd.length > 4_096 || !(options.signal instanceof AbortSignal)) throw new ConnectorError("CONNECTOR_INVALID", "connector invocation options are invalid")
  const maxInputBytes = options.maxInputBytes ?? 256 * 1024
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 4 * 1024 * 1024 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024) throw new ConnectorError("CONNECTOR_LIMIT", "connector byte limits are invalid")
  try {
    assertJsonSize(input, maxInputBytes)
  } catch {
    throw new ConnectorError("CONNECTOR_LIMIT", "connector input exceeds its byte limit")
  }
  if (options.allowedCapabilities !== undefined && (!Array.isArray(options.allowedCapabilities) || options.allowedCapabilities.some((value) => !validCapability(value)))) throw new ConnectorError("CONNECTOR_INVALID", "allowed connector capabilities are invalid")
}

function validateNativeOptions(options: ConnectorNativeToolOptions): void {
  validateInvocation({ cwd: options.cwd, signal: new AbortController().signal, allowedCapabilities: options.allowedCapabilities, ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }), ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }) }, {})
  if (options.namespace !== undefined && !validName(options.namespace)) throw new ConnectorError("CONNECTOR_INVALID", "connector namespace is invalid")
}

function supports(allowed: readonly string[], required: readonly string[]): boolean {
  const set = new Set(allowed)
  return required.every((value) => set.has(value))
}

function isActionKind(value: unknown): value is ConnectorActionKind {
  return value === "read" || value === "search" || value === "write" || value === "notify" || value === "custom"
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9.+:-]{0,63}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
