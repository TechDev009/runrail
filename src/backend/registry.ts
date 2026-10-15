import type { AgentBackend, AgentBackendInfo } from "@nifrajs/agent-protocol"
import {
  createCapabilityManifest,
  parseCapabilityManifest,
  type AgentCapability,
  type AgentCapabilityManifest,
} from "@nifrajs/coding-agent"

import type { RunrailIntegrationHook } from "../integrations.ts"
export interface RunrailBackendContext {
  readonly cwd: string
  readonly requestedCapabilities: readonly string[]
  readonly options: Readonly<Record<string, unknown>>
}

/** Public adapter seam for any agent harness that can speak the Nifra agent protocol. */
export interface RunrailBackendAdapter {
  readonly name: string
  readonly version: string
  /** Functional and protocol capabilities used by deterministic routing. */
  readonly capabilities: readonly string[]
  /** Optional operating-system capability declaration for host admission. */
  readonly securityManifest?: AgentCapabilityManifest
  /** Optional explicit bridge for non-native MCP/tools/connectors/skills integrations. */
  readonly integrationHook?: RunrailIntegrationHook
  create(context: RunrailBackendContext): AgentBackend | PromiseLike<AgentBackend>
}

export type BackendRegistryErrorCode = "BACKEND_INVALID" | "BACKEND_DUPLICATE" | "BACKEND_NOT_FOUND" | "BACKEND_CAPABILITY_UNAVAILABLE"

export class BackendRegistryError extends Error {
  constructor(
    readonly code: BackendRegistryErrorCode,
    reason: string,
  ) {
    super(`backend registry: ${reason}`)
    this.name = "BackendRegistryError"
  }
}

export interface BackendSelection {
  readonly requiredCapabilities?: readonly string[]
  readonly preferred?: string
}

/** Deterministic, collision-checked registry of backend adapters. */
export class BackendRegistry {
  private readonly adapters = new Map<string, RunrailBackendAdapter>()

  constructor(adapters: readonly RunrailBackendAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: RunrailBackendAdapter): this {
    validateAdapter(adapter)
    if (this.adapters.has(adapter.name))
      throw new BackendRegistryError("BACKEND_DUPLICATE", `duplicate adapter '${adapter.name}'`)
    this.adapters.set(adapter.name, freezeAdapter(adapter))
    return this
  }

  get(name: string): RunrailBackendAdapter | undefined {
    return this.adapters.get(name)
  }

  list(): readonly RunrailBackendAdapter[] {
    return Object.freeze([...this.adapters.values()].sort((a, b) => a.name.localeCompare(b.name)))
  }

  select(selection: BackendSelection = {}): RunrailBackendAdapter {
    const required = uniqueSorted(selection.requiredCapabilities ?? [])
    if (selection.preferred !== undefined) {
      const preferred = this.adapters.get(selection.preferred)
      if (preferred === undefined)
        throw new BackendRegistryError("BACKEND_NOT_FOUND", `unknown adapter '${selection.preferred}'`)
      if (!supports(preferred, required))
        throw new BackendRegistryError(
          "BACKEND_CAPABILITY_UNAVAILABLE",
          `preferred adapter '${preferred.name}' does not provide the requested capabilities`,
        )
      return preferred
    }
    const adapter = this.list().find((candidate) => supports(candidate, required))
    if (adapter === undefined)
      throw new BackendRegistryError(
        "BACKEND_CAPABILITY_UNAVAILABLE",
        "no registered adapter provides the requested capabilities",
      )
    return adapter
  }

  async create(
    name: string,
    context: RunrailBackendContext,
  ): Promise<AgentBackend> {
    const adapter = this.get(name)
    if (adapter === undefined)
      throw new BackendRegistryError("BACKEND_NOT_FOUND", `unknown adapter '${name}'`)
    return adapter.create(context)
  }
}

export function createBackendRegistry(
  adapters: readonly RunrailBackendAdapter[] = [],
): BackendRegistry {
  return new BackendRegistry(adapters)
}

/** Convert a backend's requested OS capabilities into Nifra's public manifest shape. */
export function createSecurityManifest(
  requested: readonly AgentCapability[],
  trusted: readonly AgentCapability[] = [],
  reason?: string,
): AgentCapabilityManifest {
  return createCapabilityManifest(requested, trusted, reason)
}

export function backendInfo(adapter: RunrailBackendAdapter): AgentBackendInfo {
  return Object.freeze({
    name: adapter.name,
    version: adapter.version,
    capabilities: Object.freeze([...adapter.capabilities]),
  })
}

function validateAdapter(adapter: RunrailBackendAdapter): void {
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(adapter.name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/.test(adapter.version) ||
    typeof adapter.create !== "function"
  )
    throw new BackendRegistryError("BACKEND_INVALID", "adapter metadata is invalid")
  if (
    !Array.isArray(adapter.capabilities) ||
    adapter.capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(capability),
    )
  )
    throw new BackendRegistryError("BACKEND_INVALID", "adapter capabilities are invalid")
  if (adapter.securityManifest !== undefined) {
    try {
      parseCapabilityManifest(adapter.securityManifest)
    } catch {
      throw new BackendRegistryError("BACKEND_INVALID", "adapter security manifest is invalid")
    }
  }
  if (adapter.integrationHook !== undefined && typeof adapter.integrationHook !== "function")
    throw new BackendRegistryError("BACKEND_INVALID", "adapter integration hook is invalid")
}

function freezeAdapter(adapter: RunrailBackendAdapter): RunrailBackendAdapter {
  const securityManifest =
    adapter.securityManifest === undefined
      ? {}
      : { securityManifest: parseCapabilityManifest(adapter.securityManifest) }
  return Object.freeze({
    ...adapter,
    capabilities: Object.freeze(uniqueSorted(adapter.capabilities)),
    ...securityManifest,
  })
}

function supports(adapter: RunrailBackendAdapter, required: readonly string[]): boolean {
  const capabilities = new Set(adapter.capabilities)
  return required.every((capability) => capabilities.has(capability))
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort())
}
