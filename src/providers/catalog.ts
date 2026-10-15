import type { ModelAdapter, ModelCapability, ModelCatalog, ModelDescriptor } from "../model/catalog.ts"
import { createModelCatalog, parseModelDescriptor } from "../model/catalog.ts"
import { createAnthropicModelAdapter } from "./anthropic.ts"
import { createOpenAICompatibleModelAdapter } from "./openai-compatible.ts"
import { createOpenAIModelAdapter } from "./openai.ts"
import { createEnvironmentCredentialResolver } from "./credentials.ts"
import { ProviderError } from "./errors.ts"
import { createProviderHttpClient } from "./http.ts"
import { resolveProviderTarget } from "./presets.ts"
import type {
  ProviderDescriptor,
  ProviderDiscoveryOptions,
  ProviderModelAdapter,
  ProviderModelOptions,
  ProviderModelPort,
  ProviderOwnership,
  ProviderProtocol,
} from "./types.ts"

export interface ProviderDefinition {
  readonly descriptor: ProviderDescriptor
  readonly models?: readonly ModelAdapter[]
  readonly createModel?: (options: ProviderModelOptions) => ModelAdapter
}

/** Catalog of provider families and explicitly configured model adapters. It never discovers by default. */
export class ProviderCatalog {
  private readonly providers = new Map<string, ProviderDefinition>()

  constructor(definitions: readonly ProviderDefinition[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: ProviderDefinition): this {
    validateDefinition(definition)
    if (this.providers.has(definition.descriptor.id)) throw new ProviderError("PROVIDER_INVALID", "duplicate provider id")
    this.providers.set(definition.descriptor.id, freezeDefinition(definition))
    return this
  }

  list(): readonly ProviderDescriptor[] {
    return Object.freeze([...this.providers.values()].map((definition) => definition.descriptor).sort((left, right) => left.id.localeCompare(right.id)))
  }
  status(environment: Readonly<Record<string, string | undefined>> = process.env): readonly ProviderDescriptor[] {
    return Object.freeze(this.list().map((provider) => provider.credentialEnvironment === undefined ? provider : Object.freeze({ ...provider, configured: typeof environment[provider.credentialEnvironment] === "string" && environment[provider.credentialEnvironment]!.length > 0 })))
  }

  get(id: string): ProviderDefinition | undefined {
    return this.providers.get(id)
  }

  models(): readonly ModelDescriptor[] {
    return Object.freeze([...this.providers.values()].flatMap((definition) => definition.models ?? []).map((adapter) => adapter.descriptor).sort((left, right) => left.id.localeCompare(right.id)))
  }

  modelCatalog(): ModelCatalog {
    return createModelCatalog([...this.providers.values()].flatMap((definition) => definition.models ?? []))
  }

  createModel(options: ProviderModelOptions): ModelAdapter {
    const definition = this.providers.get(options.provider)
    if (definition?.createModel !== undefined) return definition.createModel(options)
    if (definition !== undefined) throw new ProviderError("PROVIDER_CALLER_OWNED", "provider requires an explicit caller-owned adapter")
    throw new ProviderError("PROVIDER_INVALID", "provider is not configured for model creation")
  }
}

export function createProviderCatalog(definitions: readonly ProviderDefinition[] = []): ProviderCatalog {
  return new ProviderCatalog(definitions)
}
export function createDefaultProviderCatalog(): ProviderCatalog {
  return createProviderCatalog([
    { descriptor: providerDescriptor("openai", "OpenAI", ["openai-responses", "openai-chat"], false, "OPENAI_API_KEY"), createModel: createConfiguredProviderModelAdapter },
    { descriptor: providerDescriptor("anthropic", "Anthropic", ["anthropic-messages"], false, "ANTHROPIC_API_KEY"), createModel: createConfiguredProviderModelAdapter },
    { descriptor: providerDescriptor("openai-compatible", "OpenAI-compatible", ["openai-compatible", "openai-chat", "openai-responses"], false, "OPENAI_COMPATIBLE_API_KEY"), createModel: createConfiguredProviderModelAdapter },
    { descriptor: providerDescriptor("xai", "xAI / Grok", ["openai-compatible", "openai-chat"], false, "XAI_API_KEY"), createModel: createConfiguredProviderModelAdapter },
    { descriptor: providerDescriptor("google", "Google", ["google-generative-ai"], false, undefined, "caller-owned") },
    { descriptor: providerDescriptor("vertex", "Vertex AI", ["vertex-ai"], false, undefined, "caller-owned") },
    { descriptor: providerDescriptor("bedrock", "Amazon Bedrock", ["aws-bedrock"], false, undefined, "caller-owned") },
    { descriptor: providerDescriptor("llama.cpp", "llama.cpp", ["llama.cpp"], false, undefined, "caller-owned") },
  ])
}

export async function discoverProviderModels(options: ProviderDiscoveryOptions): Promise<readonly ModelDescriptor[]> {
  if (options === null || typeof options !== "object") throw new ProviderError("PROVIDER_INVALID", "provider discovery options are invalid")
  const target = resolveProviderTarget(options.provider === "anthropic" ? { ...options, protocol: "messages" } : options)
  const client = createProviderHttpClient({ baseUrl: target.endpoint, allowRemote: options.allowRemote === true, allowInsecureRemote: options.allowInsecureRemote, allowedHosts: options.allowedHosts, timeoutMs: options.timeoutMs, maxRequestBytes: options.maxRequestBytes, maxResponseBytes: options.maxResponseBytes, maxStreamBytes: options.maxStreamBytes, maxEvents: options.maxEvents, maxRetries: options.maxRetries, retryDelayMs: options.retryDelayMs })
  const resolver = options.credentialResolver ?? createEnvironmentCredentialResolver()
  let secret: string
  try { secret = await resolver.resolve(options.credential) } catch { throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential is unavailable") }
  validateNonAuthHeaders(options.headers)
  const headers = {
    ...(options.headers ?? {}),
    accept: "application/json",
    ...(target.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
    ...(target.authStyle === "bearer" ? { authorization: `Bearer ${secret}` } : { "x-api-key": secret }),
  }
  const value = await client.json({ path: "/models", method: "GET", headers, signal: undefined, retryable: true }, (response) => response)
  return parseDiscoveredModels(value, options.provider)
}

/**
 * Builds the adapter for a provider family, a preset id, or a caller-chosen id that names its own
 * endpoint and protocol. The protocol, not the vendor, picks the adapter.
 */
export function createConfiguredProviderModelAdapter(options: ProviderModelOptions): ProviderModelAdapter {
  if (options === null || typeof options !== "object") throw new ProviderError("PROVIDER_INVALID", "provider model options are invalid")
  if (options.provider === "openai") return createOpenAIModelAdapter(options) as ProviderModelAdapter
  if (options.provider === "anthropic") return createAnthropicModelAdapter(options) as ProviderModelAdapter
  if (options.provider === "openai-compatible" || options.provider === "xai") return createOpenAICompatibleModelAdapter(options) as ProviderModelAdapter
  let protocol: string
  try {
    protocol = resolveProviderTarget(options).protocol
  } catch (error) {
    // An id with no family, no preset row and no endpoint of its own is not something Runrail can reach.
    if (error instanceof ProviderError && options.endpoint === undefined) throw new ProviderError("PROVIDER_INVALID", "provider family is unsupported")
    throw error
  }
  return (protocol === "anthropic-messages" ? createAnthropicModelAdapter(options) : createOpenAIModelAdapter(options)) as ProviderModelAdapter
}
export interface CallerOwnedProviderModelOptions {
  readonly provider: string
  readonly providerName?: string
  readonly protocols: readonly ProviderProtocol[]
  readonly model: string
  readonly port: ProviderModelPort | (() => ProviderModelPort)
  readonly tier?: ModelDescriptor["tier"]
  readonly version?: string
  readonly capabilities?: readonly ModelCapability[]
  readonly contextTokens?: number
  readonly pricing?: ModelDescriptor["pricing"]
}

/** Wrap a caller-owned provider implementation without moving its credentials or transport into Runrail. */
export function createCallerOwnedProviderModelAdapter(options: CallerOwnedProviderModelOptions): ProviderModelAdapter {
  if (options === null || typeof options !== "object" || typeof options.provider !== "string" || !/^[a-z][a-z0-9._:-]{0,63}$/.test(options.provider) || typeof options.model !== "string" || options.model.length === 0 || options.model.length > 256 || /[\r\n\0]/.test(options.model) || !Array.isArray(options.protocols) || options.protocols.length === 0)
    throw new ProviderError("PROVIDER_INVALID", "caller-owned provider model options are invalid")
  if (typeof options.port !== "function" && !isRecord(options.port)) throw new ProviderError("PROVIDER_INVALID", "caller-owned provider model port is invalid")
  const capabilities = options.capabilities ?? ["streaming", "tools"]
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((capability) => capability !== "streaming" && capability !== "tools" && capability !== "multimodal" && capability !== "reasoning"))
    throw new ProviderError("PROVIDER_INVALID", "caller-owned provider capabilities are invalid")
  const contextTokens = options.contextTokens ?? 128_000
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1 || contextTokens > 10_000_000)
    throw new ProviderError("PROVIDER_INVALID", "caller-owned provider context limit is invalid")
  const providerName = options.providerName ?? options.provider
  if (typeof providerName !== "string" || providerName.length === 0 || providerName.length > 128 || /[\r\n\0]/.test(providerName))
    throw new ProviderError("PROVIDER_INVALID", "caller-owned provider name is invalid")
  let descriptor: ModelDescriptor
  try {
    descriptor = parseModelDescriptor({
      id: options.model,
      provider: options.provider,
      version: options.version ?? "caller-owned",
      tier: options.tier ?? "strong",
      capabilities: Object.freeze([...new Set(capabilities)]),
      contextTokens,
      ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    })
  } catch {
    throw new ProviderError("PROVIDER_INVALID", "caller-owned provider model descriptor is invalid")
  }
  const provider = providerDescriptor(options.provider, providerName, options.protocols, false, undefined, "caller-owned")
  return {
    provider,
    descriptor,
    create: () => {
      const port = typeof options.port === "function" ? options.port() : options.port
      if (!isRecord(port) || typeof port.complete !== "function") throw new ProviderError("PROVIDER_INVALID", "caller-owned provider factory returned an invalid port")
      return port as ProviderModelPort
    },
  }
}

export function providerDescriptor(id: string, name: string, protocols: readonly ProviderDescriptor["protocols"][number][], configured = false, credentialEnvironment?: string, ownership: ProviderOwnership = "native-adapter"): ProviderDescriptor {
  if (typeof id !== "string" || !/^[a-z][a-z0-9._:-]{0,63}$/.test(id) || typeof name !== "string" || name.length === 0 || name.length > 128 || /[\r\n\0]/.test(name) || !Array.isArray(protocols) || protocols.length === 0 || protocols.some((protocol) => !isProviderProtocol(protocol)) || typeof configured !== "boolean") throw new ProviderError("PROVIDER_INVALID", "provider descriptor is invalid")
  if (credentialEnvironment !== undefined && (typeof credentialEnvironment !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credentialEnvironment))) throw new ProviderError("PROVIDER_INVALID", "provider credential environment is invalid")
  if (ownership !== "native-adapter" && ownership !== "caller-owned") throw new ProviderError("PROVIDER_INVALID", "provider ownership is invalid")
  const capabilities: readonly ModelCapability[] = Object.freeze(["streaming", "tools", "multimodal", "reasoning"])
  return Object.freeze({ id, name, protocols: Object.freeze([...new Set(protocols)]), capabilities, ownership, configured, ...(credentialEnvironment === undefined ? {} : { credentialEnvironment }) })
}

function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === "openai-responses" || value === "openai-chat" || value === "anthropic-messages" || value === "openai-compatible" || value === "google-generative-ai" || value === "vertex-ai" || value === "aws-bedrock" || value === "llama.cpp"
}

function validateNonAuthHeaders(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || Object.keys(value).length > 32) throw new ProviderError("PROVIDER_INVALID", "provider headers are invalid")
  for (const [name, entry] of Object.entries(value)) if (typeof entry !== "string" || entry.length > 4_096 || /[\r\n]/.test(entry) || ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie"].includes(name.toLowerCase())) throw new ProviderError("PROVIDER_CREDENTIALS", "authentication headers are controlled by the credential resolver")
}

function parseDiscoveredModels(value: unknown, provider: string): readonly ModelDescriptor[] {
  const raw = isRecord(value) && Array.isArray(value.data) ? value.data : Array.isArray(value) ? value : undefined
  // Aggregators list hundreds of models (OpenRouter has several hundred), so the cap is far above that.
  if (raw === undefined || raw.length > 4_096) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider model discovery response is invalid")
  const ids = new Set<string>()
  const models: ModelDescriptor[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0 || item.id.length > 128 || /[\r\n]/.test(item.id)) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider model descriptor is invalid")
    if (ids.has(item.id)) continue
    ids.add(item.id)
    models.push(Object.freeze({ id: item.id, provider, version: "discovered", tier: "strong", capabilities: Object.freeze(["streaming", "tools"] as ModelCapability[]), contextTokens: 128_000 }))
  }
  return Object.freeze(models.sort((left, right) => left.id.localeCompare(right.id)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validateDefinition(definition: ProviderDefinition): void {
  if (definition === null || typeof definition !== "object" || definition.descriptor === undefined) throw new ProviderError("PROVIDER_INVALID", "provider definition is invalid")
  const descriptor = definition.descriptor
  if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(descriptor.id) || typeof descriptor.name !== "string" || descriptor.name.length === 0 || descriptor.name.length > 128 || !Array.isArray(descriptor.protocols) || descriptor.protocols.length === 0 || descriptor.protocols.some((protocol) => !isProviderProtocol(protocol)) || !Array.isArray(descriptor.capabilities) || descriptor.capabilities.some((capability) => capability !== "streaming" && capability !== "tools" && capability !== "multimodal" && capability !== "reasoning") || (descriptor.ownership !== undefined && descriptor.ownership !== "native-adapter" && descriptor.ownership !== "caller-owned")) throw new ProviderError("PROVIDER_INVALID", "provider descriptor is invalid")
  if (definition.models !== undefined && (!Array.isArray(definition.models) || definition.models.length > 256 || definition.models.some((model) => model === null || typeof model !== "object" || typeof model.create !== "function"))) throw new ProviderError("PROVIDER_INVALID", "provider models are invalid")
}

function freezeDefinition(definition: ProviderDefinition): ProviderDefinition {
  return Object.freeze({ ...definition, descriptor: Object.freeze({ ...definition.descriptor, protocols: Object.freeze([...definition.descriptor.protocols]), capabilities: Object.freeze([...definition.descriptor.capabilities]) }), ...(definition.models === undefined ? {} : { models: Object.freeze([...definition.models]) }) })
}
