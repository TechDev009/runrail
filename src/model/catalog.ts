import { RUNRAIL_VERSION } from "../version.ts"
import type {
  NativeModelPort,
  NativeModelRequest,
} from "@nifrajs/coding-agent"
import { ScriptedModel } from "./scripted-model.ts"

export type ModelTier = "cheap" | "fast" | "strong"
export type ModelQuality = "balanced" | "cheap" | "fast" | "strong"
/**
 * How hard a model thinks, lowest first. `xhigh`, `max`, and `ultra` go past high: coding tools take
 * them as their own effort levels (Codex's Ultra also hands work to subagents), and a provider with
 * no level above high runs them as high.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
export const THINKING_LEVELS: readonly ThinkingLevel[] = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
}
export type ModelCapability = "streaming" | "tools" | "multimodal" | "reasoning"

export interface ModelPricing {
  readonly inputUsdPerMillionTokens?: number
  readonly outputUsdPerMillionTokens?: number
  /** Input read from or written to a provider's prompt cache; the input rate when absent. */
  readonly cacheReadUsdPerMillionTokens?: number
  readonly cacheWriteUsdPerMillionTokens?: number
}

export interface ModelDescriptor {
  readonly id: string
  readonly provider: string
  readonly version: string
  readonly tier: ModelTier
  readonly capabilities: readonly ModelCapability[]
  readonly contextTokens: number
  readonly pricing?: ModelPricing
}

export interface ModelCreateContext {
  readonly cwd: string
  readonly descriptor: ModelDescriptor
  readonly quality: ModelQuality
  readonly thinking: ThinkingLevel
  readonly signal?: AbortSignal
}

export interface ModelAdapter {
  readonly descriptor: ModelDescriptor
  readonly contentAware?: boolean
  create(context: ModelCreateContext): NativeModelPort | PromiseLike<NativeModelPort>
}

export interface ModelSelection {
  readonly id?: string
  readonly tier?: ModelTier
  readonly quality?: ModelQuality
  readonly thinking?: ThinkingLevel
  readonly requiredCapabilities?: readonly ModelCapability[]
}

export interface CreatedModel {
  readonly descriptor: ModelDescriptor
  readonly port: NativeModelPort
  readonly quality: ModelQuality
  readonly thinking: ThinkingLevel
}

export type ModelCatalogErrorCode =
  | "MODEL_INVALID"
  | "MODEL_DUPLICATE"
  | "MODEL_NOT_FOUND"
  | "MODEL_CAPABILITY_UNAVAILABLE"
  | "MODEL_CREATE_FAILED"

export class ModelCatalogError extends Error {
  constructor(readonly code: ModelCatalogErrorCode, reason: string) {
    super(`model catalog: ${reason}`)
    this.name = "ModelCatalogError"
  }
}

/** A caller-owned, provider-neutral catalog. Credentials stay inside the adapter implementation. */
export class ModelCatalog {
  private readonly adapters = new Map<string, ModelAdapter>()

  constructor(adapters: readonly ModelAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: ModelAdapter): this {
    const parsed = parseModelAdapter(adapter)
    if (this.adapters.has(parsed.descriptor.id))
      throw new ModelCatalogError("MODEL_DUPLICATE", `duplicate model '${parsed.descriptor.id}'`)
    this.adapters.set(parsed.descriptor.id, freezeAdapter(parsed))
    return this
  }

  get(id: string): ModelAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): readonly ModelDescriptor[] {
    return Object.freeze(
      [...this.adapters.values()]
        .map((adapter) => adapter.descriptor)
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  select(selection: ModelSelection = {}): ModelAdapter {
    const required = uniqueCapabilities(selection.requiredCapabilities ?? [])
    if (selection.id !== undefined) {
      const selected = this.adapters.get(selection.id)
      if (selected === undefined)
        throw new ModelCatalogError("MODEL_NOT_FOUND", `unknown model '${selection.id}'`)
      if (!supports(selected.descriptor, required) || !matchesTier(selected.descriptor, selection.tier) || !matchesQuality(selected.descriptor, selection.quality))
        throw new ModelCatalogError(
          "MODEL_CAPABILITY_UNAVAILABLE",
          `model '${selection.id}' does not satisfy the requested capabilities`,
        )
      return selected
    }
    const selected = this.list()
      .map((descriptor) => this.adapters.get(descriptor.id))
      .find(
        (adapter): adapter is ModelAdapter =>
          adapter !== undefined &&
          supports(adapter.descriptor, required) &&
          matchesTier(adapter.descriptor, selection.tier) &&
          matchesQuality(adapter.descriptor, selection.quality),
      )
    if (selected === undefined)
      throw new ModelCatalogError(
        "MODEL_CAPABILITY_UNAVAILABLE",
        "no registered model provides the requested capabilities",
      )
    return selected
  }

  async create(
    selection: ModelSelection,
    context: Omit<ModelCreateContext, "descriptor" | "quality" | "thinking">,
  ): Promise<CreatedModel> {
    const adapter = this.select(selection)
    const quality = selection.quality ?? qualityForTier(adapter.descriptor.tier)
    const thinking = selection.thinking ?? "medium"
    let port: NativeModelPort
    try {
      port = await adapter.create({
        ...context,
        descriptor: adapter.descriptor,
        quality,
        thinking,
      })
    } catch (error) {
      throw new ModelCatalogError(
        "MODEL_CREATE_FAILED",
        error instanceof Error ? error.message : "model adapter failed to initialize",
      )
    }
    if (!isModelPort(port))
      throw new ModelCatalogError("MODEL_CREATE_FAILED", "model adapter returned an invalid port")
    return Object.freeze({ descriptor: adapter.descriptor, port, quality, thinking })
  }
}

export class RoutedModelPort implements NativeModelPort {
  private active: CreatedModel

  constructor(
    private readonly catalog: ModelCatalog,
    private readonly context: Omit<ModelCreateContext, "descriptor" | "quality" | "thinking">,
    initial: CreatedModel,
  ) {
    this.active = initial
  }

  get current(): CreatedModel {
    return this.active
  }

  complete(request: NativeModelRequest) {
    return this.active.port.complete(request)
  }

  takeUsage(): unknown {
    const port = this.active.port as unknown
    return isRecord(port) && typeof port.takeUsage === "function" ? port.takeUsage() : undefined
  }

  async switch(selection: ModelSelection): Promise<ModelDescriptor> {
    const next = await this.catalog.create(selection, this.context)
    this.active = next
    return next.descriptor
  }
}

export async function createRoutedModelPort(
  catalog: ModelCatalog,
  selection: ModelSelection,
  context: Omit<ModelCreateContext, "descriptor" | "quality" | "thinking">,
): Promise<RoutedModelPort> {
  return new RoutedModelPort(catalog, context, await catalog.create(selection, context))
}

export function parseModelDescriptor(value: unknown): ModelDescriptor {
  if (!isRecord(value)) throw new ModelCatalogError("MODEL_INVALID", "model descriptor must be an object")
  const id = boundedString(value.id, 1, 128, "id")
  const provider = boundedString(value.provider, 1, 128, "provider")
  const version = boundedString(value.version, 1, 64, "version")
  const tier = parseTier(value.tier)
  const capabilities = parseCapabilities(value.capabilities)
  const contextTokens = boundedInteger(value.contextTokens, 1, 10_000_000, "contextTokens")
  const pricing = value.pricing === undefined ? undefined : parsePricing(value.pricing)
  return Object.freeze({
    id,
    provider,
    version,
    tier,
    capabilities,
    contextTokens,
    ...(pricing === undefined ? {} : { pricing }),
  })
}

export function createModelCatalog(adapters: readonly ModelAdapter[] = []): ModelCatalog {
  return new ModelCatalog(adapters)
}

export function createDefaultModelCatalog(): ModelCatalog {
  const descriptor: ModelDescriptor = {
    id: "scripted",
    provider: "runrail",
    version: RUNRAIL_VERSION,
    tier: "cheap",
    capabilities: Object.freeze(["streaming", "tools"]),
    contextTokens: 128_000,
  }
  return createModelCatalog([{ descriptor, create: () => new ScriptedModel() }])
}

function parseModelAdapter(value: unknown): ModelAdapter {
  if (!isRecord(value)) throw new ModelCatalogError("MODEL_INVALID", "model adapter is invalid")
  const create = value.create
  if (!isModelFactory(create)) throw new ModelCatalogError("MODEL_INVALID", "model adapter create function is invalid")
  if (value.contentAware !== undefined && typeof value.contentAware !== "boolean") throw new ModelCatalogError("MODEL_INVALID", "model adapter content marker is invalid")
  const descriptor = parseModelDescriptor(value.descriptor)
  return { descriptor, create, ...(value.contentAware === true ? { contentAware: true } : {}) }
}

function isModelFactory(value: unknown): value is ModelAdapter["create"] {
  return typeof value === "function"
}
function freezeAdapter(adapter: ModelAdapter): ModelAdapter {
  return Object.freeze({ ...adapter, descriptor: adapter.descriptor })
}

function parseTier(value: unknown): ModelTier {
  if (value === "cheap" || value === "fast" || value === "strong") return value
  throw new ModelCatalogError("MODEL_INVALID", "model tier is invalid")
}

function parseCapabilities(value: unknown): readonly ModelCapability[] {
  if (!Array.isArray(value) || value.length > 16)
    throw new ModelCatalogError("MODEL_INVALID", "model capabilities are invalid")
  const parsed: ModelCapability[] = []
  for (const item of value) {
    if (
      item !== "streaming" &&
      item !== "tools" &&
      item !== "multimodal" &&
      item !== "reasoning"
    )
      throw new ModelCatalogError("MODEL_INVALID", "model capability is invalid")
    if (!parsed.includes(item)) parsed.push(item)
  }
  return Object.freeze(parsed.sort())
}

function parsePricing(value: unknown): ModelPricing {
  if (!isRecord(value)) throw new ModelCatalogError("MODEL_INVALID", "model pricing is invalid")
  const input = optionalNonNegative(value.inputUsdPerMillionTokens, "input pricing")
  const output = optionalNonNegative(value.outputUsdPerMillionTokens, "output pricing")
  const cacheRead = optionalNonNegative(value.cacheReadUsdPerMillionTokens, "cache read pricing")
  const cacheWrite = optionalNonNegative(value.cacheWriteUsdPerMillionTokens, "cache write pricing")
  if (input === undefined && output === undefined)
    throw new ModelCatalogError("MODEL_INVALID", "model pricing is empty")
  return Object.freeze({
    ...(input === undefined ? {} : { inputUsdPerMillionTokens: input }),
    ...(output === undefined ? {} : { outputUsdPerMillionTokens: output }),
    ...(cacheRead === undefined ? {} : { cacheReadUsdPerMillionTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillionTokens: cacheWrite }),
  })
}

function supports(descriptor: ModelDescriptor, required: readonly ModelCapability[]): boolean {
  const capabilities = new Set(descriptor.capabilities)
  return required.every((capability) => capabilities.has(capability))
}

function matchesTier(descriptor: ModelDescriptor, tier: ModelTier | undefined): boolean {
  return tier === undefined || descriptor.tier === tier
}

function matchesQuality(descriptor: ModelDescriptor, quality: ModelQuality | undefined): boolean {
  if (quality === undefined || quality === "balanced") return true
  return descriptor.tier === quality
}

function qualityForTier(tier: ModelTier): ModelQuality {
  return tier
}

function uniqueCapabilities(values: readonly ModelCapability[]): readonly ModelCapability[] {
  const allowed = new Set<ModelCapability>(["streaming", "tools", "multimodal", "reasoning"])
  const result: ModelCapability[] = []
  for (const value of values) {
    if (!allowed.has(value)) throw new ModelCatalogError("MODEL_INVALID", "requested capability is invalid")
    if (!result.includes(value)) result.push(value)
  }
  return Object.freeze(result.sort())
}

function isModelPort(value: unknown): value is NativeModelPort {
  return isRecord(value) && typeof value.complete === "function"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function boundedString(value: unknown, min: number, max: number, name: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max)
    throw new ModelCatalogError("MODEL_INVALID", `model ${name} is invalid`)
  return value
}

function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ModelCatalogError("MODEL_INVALID", `model ${name} is invalid`)
  return value
}

function optionalNonNegative(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000)
    throw new ModelCatalogError("MODEL_INVALID", `${name} is invalid`)
  return value
}
