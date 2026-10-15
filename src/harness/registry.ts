import { parseCapabilityManifest, type AgentCapabilityManifest } from "@nifrajs/coding-agent"
import { isHarnessAuthMode } from "./auth.ts"
import { isHarnessProbeTarget, probeHarness, type HarnessProbeOptions } from "./detect.ts"
import type { HarnessAdapter, HarnessCapabilityClassification, HarnessControl, HarnessDescriptor, HarnessEventFamily, HarnessFeature, HarnessKind, HarnessStatus } from "./types.ts"

export type HarnessRegistryErrorCode = "HARNESS_INVALID" | "HARNESS_DUPLICATE" | "HARNESS_NOT_FOUND" | "HARNESS_FEATURE_UNAVAILABLE"

export class HarnessRegistryError extends Error {
  constructor(readonly code: HarnessRegistryErrorCode, reason: string) {
    super(`harness registry: ${reason}`)
    this.name = "HarnessRegistryError"
  }
}

/** Registry for first-party and caller-owned normalized agent runtimes. */
export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>()

  constructor(adapters: readonly HarnessAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: HarnessAdapter): this {
    validateAdapter(adapter)
    if (this.adapters.has(adapter.descriptor.id)) throw new HarnessRegistryError("HARNESS_DUPLICATE", `duplicate harness '${adapter.descriptor.id}'`)
    this.adapters.set(adapter.descriptor.id, freezeAdapter(adapter))
    return this
  }

  get(id: string): HarnessAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): readonly HarnessDescriptor[] {
    return Object.freeze([...this.adapters.values()].map((adapter) => adapter.descriptor).sort((left, right) => left.id.localeCompare(right.id)))
  }

  status(): readonly HarnessStatus[] {
    return Object.freeze(this.list().map((descriptor) => Object.freeze({ descriptor, available: true })))
  }

  /**
   * `status()` with the installed coding CLIs asked about themselves: whether each is installed,
   * signed in, and which models it offers. Runs those CLIs' own commands, so it takes seconds.
   */
  async probe(options: HarnessProbeOptions = {}): Promise<readonly HarnessStatus[]> {
    return Object.freeze(await Promise.all(this.list().map(async (descriptor): Promise<HarnessStatus> => {
      if (!isHarnessProbeTarget(descriptor.id)) return Object.freeze({ descriptor, available: true })
      const { installed, ...found } = await probeHarness(descriptor.id, options)
      if (!installed) return Object.freeze({ descriptor, available: false, reason: "not-installed" })
      return Object.freeze({ descriptor, available: true, ...(found.signedIn === false ? { reason: "signed-out" } : {}), ...found })
    })))
  }

  select(id: string, requiredFeatures: readonly HarnessFeature[] = []): HarnessAdapter {
    const adapter = this.adapters.get(id)
    if (adapter === undefined) throw new HarnessRegistryError("HARNESS_NOT_FOUND", `unknown harness '${id}'`)
    const requested = uniqueFeatures(requiredFeatures)
    if (!requested.every((feature) => adapter.descriptor.features.includes(feature)))
      throw new HarnessRegistryError("HARNESS_FEATURE_UNAVAILABLE", `harness '${id}' does not provide the requested features`)
    return adapter
  }

  async create(id: string, cwd: string, requiredFeatures: readonly HarnessFeature[] = []): Promise<ReturnType<HarnessAdapter["create"]> extends PromiseLike<infer T> ? T : never> {
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4_096) throw new HarnessRegistryError("HARNESS_INVALID", "harness cwd is invalid")
    return this.select(id, requiredFeatures).create({ cwd, requestedFeatures: uniqueFeatures(requiredFeatures) }) as never
  }
}

export function createHarnessRegistry(adapters: readonly HarnessAdapter[] = []): HarnessRegistry {
  return new HarnessRegistry(adapters)
}

export function negotiateHarnessFeatures(descriptor: HarnessDescriptor, requested: readonly HarnessFeature[]): { readonly granted: readonly HarnessFeature[]; readonly unsupported: readonly HarnessFeature[] } {
  const requestedUnique = uniqueFeatures(requested)
  return Object.freeze({
    granted: Object.freeze(requestedUnique.filter((feature) => descriptor.features.includes(feature))),
    unsupported: Object.freeze(requestedUnique.filter((feature) => !descriptor.features.includes(feature))),
  })
}

function validateAdapter(adapter: HarnessAdapter): void {
  if (adapter === null || typeof adapter !== "object" || typeof adapter.create !== "function") throw new HarnessRegistryError("HARNESS_INVALID", "harness adapter is invalid")
  const descriptor = adapter.descriptor
  if (descriptor === null || typeof descriptor !== "object" || !validId(descriptor.id) || typeof descriptor.name !== "string" || descriptor.name.length === 0 || descriptor.name.length > 128 || !validVersion(descriptor.version) || (descriptor.runtimeVersion !== undefined && !validVersion(descriptor.runtimeVersion)) || (descriptor.protocolVersion !== undefined && !validProtocolVersion(descriptor.protocolVersion)) || !isKind(descriptor.kind) || !Array.isArray(descriptor.features) || descriptor.features.length > 64 || descriptor.features.some((feature) => !isFeature(feature)) || !Array.isArray(descriptor.capabilities) || descriptor.capabilities.length > 64 || descriptor.capabilities.some((capability) => !validCapability(capability)) || (descriptor.controls !== undefined && (!Array.isArray(descriptor.controls) || descriptor.controls.length > 32 || descriptor.controls.some((control) => !isControl(control)))) || (descriptor.events !== undefined && (!Array.isArray(descriptor.events) || descriptor.events.length > 32 || descriptor.events.some((event) => !isEventFamily(event)))) || (descriptor.classification !== undefined && !isClassification(descriptor.classification)) || (descriptor.firstParty !== undefined && typeof descriptor.firstParty !== "boolean") || !validAuthMetadata(descriptor)) throw new HarnessRegistryError("HARNESS_INVALID", "harness descriptor is invalid")
  if (descriptor.defaultAuthMode !== undefined && !(descriptor.authModes ?? []).includes(descriptor.defaultAuthMode)) throw new HarnessRegistryError("HARNESS_INVALID", "harness descriptor default authentication mode is not advertised")
  if (descriptor.securityManifest !== undefined) {
    try { parseCapabilityManifest(descriptor.securityManifest) } catch { throw new HarnessRegistryError("HARNESS_INVALID", "harness security manifest is invalid") }
  }
}

function freezeAdapter(adapter: HarnessAdapter): HarnessAdapter {
  const descriptor = adapter.descriptor
  return Object.freeze({
    ...adapter,
    descriptor: Object.freeze({
      ...descriptor,
      features: Object.freeze(uniqueFeatures(descriptor.features)),
      capabilities: Object.freeze([...new Set(descriptor.capabilities)].sort()),
      ...(descriptor.authModes === undefined ? {} : { authModes: Object.freeze([...new Set(descriptor.authModes)].sort()) }),
      ...(descriptor.runtimeVersion === undefined ? {} : { runtimeVersion: descriptor.runtimeVersion }),
      ...(descriptor.protocolVersion === undefined ? {} : { protocolVersion: descriptor.protocolVersion }),
      ...(descriptor.controls === undefined ? {} : { controls: Object.freeze([...new Set(descriptor.controls)].sort()) }),
      ...(descriptor.events === undefined ? {} : { events: Object.freeze([...new Set(descriptor.events)].sort()) }),
      ...(descriptor.classification === undefined ? {} : { classification: descriptor.classification }),
      ...(descriptor.securityManifest === undefined ? {} : { securityManifest: parseCapabilityManifest(descriptor.securityManifest) }),
    }),
  })
}

function uniqueFeatures(values: readonly HarnessFeature[]): readonly HarnessFeature[] {
  if (!Array.isArray(values) || values.length > 64 || values.some((feature) => !isFeature(feature))) throw new HarnessRegistryError("HARNESS_INVALID", "harness features are invalid")
  return Object.freeze([...new Set(values)].sort())
}

function isFeature(value: unknown): value is HarnessFeature {
  return value === "sessions" || value === "streaming" || value === "tools" || value === "approvals" || value === "reload" || value === "compact" || value === "fork" || value === "mcp" || value === "skills" || value === "connectors" || value === "worktrees" || value === "provider.switch" || value === "verification" || value === "repair"
}
function isControl(value: unknown): value is HarnessControl {
  return value === "follow-up" || value === "cancel" || value === "interrupt" || value === "approve" || value === "reject" || value === "resume" || value === "fork" || value === "compact" || value === "model" || value === "thinking" || value === "sandbox" || value === "mcp" || value === "inspect" || value === "close"
}
function isEventFamily(value: unknown): value is HarnessEventFamily {
  return value === "lifecycle" || value === "turn" || value === "assistant" || value === "tool" || value === "approval" || value === "usage" || value === "rate-limit" || value === "compaction" || value === "cancellation" || value === "failure"
}
function isClassification(value: unknown): value is HarnessCapabilityClassification {
  return value === "native" || value === "pass-through" || value === "adapter" || value === "caller-owned" || value === "unavailable"
}

function isKind(value: unknown): value is HarnessKind {
  return value === "native" || value === "pi" || value === "codex" || value === "claude-code" || value === "copilot" || value === "gemini" || value === "opencode" || value === "aider" || value === "goose" || value === "grok" || value === "pty" || value === "remote" || value === "a2a" || value === "custom"
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9.+:-]{0,63}$/.test(value)
}

function validProtocolVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9.+:_/-]{0,63}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function validAuthMetadata(descriptor: HarnessDescriptor): boolean {
  const modes = descriptor.authModes
  if (modes !== undefined && (!Array.isArray(modes) || modes.length > 3 || modes.some((mode) => !isHarnessAuthMode(mode)) || new Set(modes).size !== modes.length)) return false
  return descriptor.defaultAuthMode === undefined || isHarnessAuthMode(descriptor.defaultAuthMode)
}
