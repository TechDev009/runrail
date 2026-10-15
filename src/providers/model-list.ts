import { createEnvironmentCredentialResolver } from "./credentials.ts"
import { ProviderError } from "./errors.ts"
import { createProviderHttpClient } from "./http.ts"
import { MODELS_SNAPSHOT, type ModelListPrice, type ModelMetadata, type ModelsSnapshot } from "./models-snapshot.ts"
import { resolveProviderTarget } from "./presets.ts"
import type { ProviderDiscoveryOptions } from "./types.ts"

/** One model a person can pick for a connection. */
export interface ListedModel extends ModelMetadata {
  /** `live`: the endpoint listed it. `snapshot`: only the bundled data knows it. */
  readonly source: "live" | "snapshot"
}

/** Read-only view over bundled model facts. Tests and embedders may supply their own. */
export interface ModelMetadataSource {
  readonly generatedAt?: string
  models(presetId: string): readonly ModelMetadata[]
}

const MAX_LISTED_MODELS = 2_000
const MODEL_LIST_TIMEOUT_MS = 15_000
const MODEL_LIST_MAX_BYTES = 8 * 1024 * 1024

export function createModelMetadataSource(snapshot: ModelsSnapshot = MODELS_SNAPSHOT): ModelMetadataSource {
  return Object.freeze({
    ...(snapshot.generatedAt === undefined ? {} : { generatedAt: snapshot.generatedAt }),
    models: (presetId: string): readonly ModelMetadata[] => Object.hasOwn(snapshot.providers, presetId) ? snapshot.providers[presetId] ?? [] : [],
  })
}

/**
 * Asks the endpoint which models it serves. One bounded `GET /models`; the raw answer is parsed and
 * dropped, never stored.
 */
export async function fetchModelList(options: ProviderDiscoveryOptions): Promise<readonly ListedModel[]> {
  return parseModelList(await fetchModelListAnswer(options))
}

/** The endpoint's own answer to `GET /models`, for a caller that reads more from it than chat models. */
export async function fetchModelListAnswer(options: ProviderDiscoveryOptions): Promise<unknown> {
  if (options === null || typeof options !== "object") throw new ProviderError("PROVIDER_INVALID", "model list options are invalid")
  const target = resolveProviderTarget(options.provider === "anthropic" ? { ...options, protocol: "messages" } : options)
  const client = createProviderHttpClient({
    baseUrl: target.endpoint,
    allowRemote: options.allowRemote === true,
    allowInsecureRemote: options.allowInsecureRemote,
    allowedHosts: options.allowedHosts,
    timeoutMs: Math.min(options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS, MODEL_LIST_TIMEOUT_MS),
    maxResponseBytes: MODEL_LIST_MAX_BYTES,
    maxRetries: Math.min(options.maxRetries ?? 1, 1),
    retryDelayMs: options.retryDelayMs,
  })
  const resolver = options.credentialResolver ?? createEnvironmentCredentialResolver()
  let secret: string
  try { secret = await resolver.resolve(options.credential) } catch { throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential is unavailable") }
  const messages = target.protocol === "anthropic-messages"
  const headers = {
    ...(options.headers ?? {}),
    accept: "application/json",
    ...(messages ? { "anthropic-version": "2023-06-01" } : {}),
    ...(target.authStyle === "bearer" ? { authorization: `Bearer ${secret}` } : { "x-api-key": secret }),
  }
  // Anthropic pages its list at 20 by default; one large page avoids a cursor loop.
  return client.json({ path: messages ? "models?limit=1000" : "models", method: "GET", headers, signal: undefined, retryable: true }, (value) => value)
}

/**
 * Reads the list shapes endpoints actually return: `{ data: [] }`, `{ models: [] }`, or a bare
 * array. Entries it cannot use are skipped rather than failing the whole list.
 */
export function parseModelList(value: unknown): readonly ListedModel[] {
  const raw = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.data) ? value.data : isRecord(value) && Array.isArray(value.models) ? value.models : undefined
  if (raw === undefined) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider model list is invalid")
  const seen = new Set<string>()
  const models: ListedModel[] = []
  for (const item of raw.slice(0, MAX_LISTED_MODELS)) {
    const id = typeof item === "string" ? item : isRecord(item) ? typeof item.id === "string" ? item.id : item.name : undefined
    if (typeof id !== "string" || id.length === 0 || id.length > 256 || /[\0-\x1f\x7f]/.test(id) || seen.has(id) || !isChatModelId(id)) continue
    seen.add(id)
    const record = isRecord(item) ? item : {}
    const name = text(record.display_name) ?? (record.name === id ? undefined : text(record.name))
    const contextTokens = count(record.context_length) ?? count(record.context_window) ?? count(record.max_input_tokens)
    const maxOutputTokens = count(record.max_completion_tokens) ?? count(record.max_output_tokens) ?? (isRecord(record.top_provider) ? count(record.top_provider.max_completion_tokens) : undefined)
    const reasoning = Array.isArray(record.supported_parameters) ? record.supported_parameters.includes("reasoning") : undefined
    const pricing = listedPrice(record.pricing)
    models.push(Object.freeze({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(pricing === undefined ? {} : { pricing }),
      source: "live" as const,
    }))
  }
  return Object.freeze(models.sort((left, right) => left.id.localeCompare(right.id)))
}

/**
 * Joins the endpoint's list with the bundled facts. With a live list, only listed models are
 * returned and the bundle fills their gaps. Without one, the bundle is the list.
 */
export function mergeModelList(live: readonly ListedModel[] | undefined, metadata: readonly ModelMetadata[]): readonly ListedModel[] {
  const known = new Map<string, ModelMetadata>()
  for (const entry of metadata.slice(0, MAX_LISTED_MODELS)) if (isRecord(entry) && typeof entry.id === "string" && !known.has(entry.id)) known.set(entry.id, entry)
  if (live === undefined) return Object.freeze([...known.values()].filter((entry) => isChatModelId(entry.id)).map((entry) => Object.freeze({ ...entry, source: "snapshot" as const })).sort((left, right) => left.id.localeCompare(right.id)))
  return Object.freeze(live.map((model) => {
    // Google's compatible endpoint lists `models/<id>`; the bundle keys on the bare id.
    const facts = known.get(model.id) ?? known.get(model.id.replace(/^models\//, ""))
    return facts === undefined ? model : Object.freeze({ ...facts, ...model, id: model.id })
  }))
}

const NON_CHAT = /(?:^|[-_/.:])(?:embed|embedding|embeddings|whisper|tts|dall-e|moderation|rerank|reranker|transcribe|realtime|speech|image|imagen|veo|sora|aqa|babbage|davinci)(?=$|[-_/.:]|\d)/i

/** Drops models that cannot hold a conversation: embeddings, speech, image and video generators. */
export function isChatModelId(id: string): boolean {
  return !NON_CHAT.test(id)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\0-\x1f\x7f]/.test(value) ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : undefined
}

/**
 * OpenRouter-style `pricing: { prompt, completion }`: decimal strings in dollars per token. A
 * negative price marks a router whose price depends on the model it picks, so it is left out.
 */
function listedPrice(value: unknown): ModelListPrice | undefined {
  if (!isRecord(value)) return undefined
  const perMillion = (entry: unknown): number | undefined => {
    const number = typeof entry === "string" && /^\d{1,6}(?:\.\d{1,20})?$/.test(entry) ? Number(entry) : typeof entry === "number" ? entry : Number.NaN
    return Number.isFinite(number) && number >= 0 && number <= 0.1 ? Math.round(number * 1e10) / 1e4 : undefined
  }
  const input = perMillion(value.prompt)
  const output = perMillion(value.completion)
  const cacheRead = perMillion(value.input_cache_read)
  const cacheWrite = perMillion(value.input_cache_write)
  if (input === undefined && output === undefined) return undefined
  return Object.freeze({
    ...(input === undefined ? {} : { inputUsdPerMillionTokens: input }),
    ...(output === undefined ? {} : { outputUsdPerMillionTokens: output }),
    ...(cacheRead === undefined ? {} : { cacheReadUsdPerMillionTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillionTokens: cacheWrite }),
  })
}

/** What the bundled facts say about one model that a provider's descriptor can use. */
export function modelDescriptorFacts(metadata: ModelMetadataSource, presetId: string, model: string): { readonly contextTokens?: number; readonly pricing?: ModelListPrice } | undefined {
  const facts = metadata.models(presetId).find((entry) => entry.id === model)
  if (facts === undefined || (facts.contextTokens === undefined && facts.pricing === undefined)) return undefined
  return Object.freeze({ ...(facts.contextTokens === undefined ? {} : { contextTokens: facts.contextTokens }), ...(facts.pricing === undefined ? {} : { pricing: facts.pricing }) })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
