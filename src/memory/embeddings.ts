import { ProviderError, refusedField } from "../providers/errors.ts"
import { createProviderHttpClient } from "../providers/http.ts"
import { resolveProviderTarget, type ProviderPresetProtocol } from "../providers/presets.ts"
import type { ProviderDiscoveryOptions } from "../providers/types.ts"
import { MemoryError } from "./types.ts"

/**
 * Recall by meaning: the embedding model the person picked on one of their own connections, asked
 * over the OpenAI-style `embeddings` API. Nothing is sent anywhere until a model is picked, and
 * neither the text nor its vectors are logged here.
 */

export interface EmbeddingChoice {
  readonly connectionId: string
  readonly model: string
}

export interface EmbeddingModel {
  readonly id: string
  readonly name?: string
}

/** Unit-length vectors, one per text, in the order given. */
export type Embed = (choice: EmbeddingChoice, texts: readonly string[], signal: AbortSignal) => Promise<readonly Float32Array[]>

export const MAX_EMBED_BATCH = 64
const MAX_DIMENSIONS = 8_192
const MAX_EMBEDDING_MODELS = 500
const EMBED_TIMEOUT_MS = 60_000
// 64 texts of up to 4,000 characters each.
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
// The provider client's ceiling; 64 vectors of 8,192 numbers written out as JSON take about 11 MB.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

const EMBEDDING_ID = /(?:^|[-_/.:])(?:embed|embedding|embeddings|bge|gte|e5)(?=$|[-_/.:]|\d)/i

/**
 * The embedding models in a `GET /models` answer. A listing that says what a model is or outputs is
 * believed (`type`, `architecture.output_modalities`); otherwise the id decides.
 */
export function parseEmbeddingModels(value: unknown, target: { readonly protocol: ProviderPresetProtocol }): readonly EmbeddingModel[] {
  // Messages endpoints serve no embeddings.
  if (target.protocol === "anthropic-messages") return Object.freeze([])
  const raw = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.data) ? value.data : isRecord(value) && Array.isArray(value.models) ? value.models : []
  const seen = new Set<string>()
  const models: EmbeddingModel[] = []
  for (const item of raw.slice(0, 2_000)) {
    const record = isRecord(item) ? item : {}
    const id = typeof item === "string" ? item : typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined
    if (id === undefined || id.length === 0 || id.length > 256 || /[\0-\x1f\x7f]/.test(id) || seen.has(id)) continue
    const outputs = isRecord(record.architecture) && Array.isArray(record.architecture.output_modalities) ? record.architecture.output_modalities : undefined
    const embeds = outputs !== undefined
      ? outputs.includes("embeddings") || outputs.includes("embedding")
      : typeof record.type === "string" && record.type !== "model" ? record.type === "embedding" || record.type === "embeddings" : EMBEDDING_ID.test(id)
    if (!embeds) continue
    seen.add(id)
    const name = text(record.display_name) ?? (record.name === id ? undefined : text(record.name))
    models.push(Object.freeze({ id, ...(name === undefined ? {} : { name }) }))
    if (models.length >= MAX_EMBEDDING_MODELS) break
  }
  return Object.freeze(models.sort((left, right) => left.id.localeCompare(right.id)))
}

/** Asks the connection's own pinned address, with its own stored credential, for one batch. */
export async function embedTexts(connection: ProviderDiscoveryOptions, model: string, texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]> {
  if (texts.length === 0) return []
  if (texts.length > MAX_EMBED_BATCH) throw new MemoryError("MEMORY_INVALID", `at most ${String(MAX_EMBED_BATCH)} texts are embedded at once`)
  const target = resolveProviderTarget(connection)
  if (target.protocol === "anthropic-messages") throw new MemoryError("MEMORY_UNAVAILABLE", "This connection serves no embedding models.")
  const client = createProviderHttpClient({
    baseUrl: target.endpoint,
    allowRemote: connection.allowRemote === true,
    allowInsecureRemote: connection.allowInsecureRemote,
    allowedHosts: connection.allowedHosts,
    timeoutMs: EMBED_TIMEOUT_MS,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxRetries: 1,
  })
  const resolver = connection.credentialResolver
  if (resolver === undefined) throw new MemoryError("MEMORY_UNAVAILABLE", "The embedding model's key or sign-in is not available.")
  let secret: string
  try {
    secret = await resolver.resolve(connection.credential)
  } catch {
    throw new MemoryError("MEMORY_UNAVAILABLE", "The embedding model's key or sign-in is not available. Check it in Settings > Connections.")
  }
  const headers = { ...(connection.headers ?? {}), accept: "application/json", "content-type": "application/json", authorization: `Bearer ${secret}` }
  const send = (asFloats: boolean): Promise<unknown> =>
    client.json({ path: "embeddings", method: "POST", headers, body: JSON.stringify({ model, input: texts, ...(asFloats ? { encoding_format: "float" } : {}) }), ...(signal === undefined ? {} : { signal }) }, (value) => value)
  let answer: unknown
  try {
    try {
      answer = await send(true)
    } catch (error) {
      if (!refusedField(error, ["encoding_format"])) throw error
      answer = await send(false)
    }
  } catch (error) {
    throw embeddingError(error)
  }
  return vectorsOf(answer, texts.length)
}

function vectorsOf(answer: unknown, count: number): readonly Float32Array[] {
  const data = isRecord(answer) && Array.isArray(answer.data) ? answer.data : undefined
  if (data === undefined || data.length !== count) throw new MemoryError("MEMORY_UNAVAILABLE", "The embedding model answered with something that could not be read.")
  const ordered = data.map((item, position) => ({ item: isRecord(item) ? item : {}, at: isRecord(item) && typeof item.index === "number" ? item.index : position })).sort((left, right) => left.at - right.at)
  let dimensions: number | undefined
  return Object.freeze(ordered.map(({ item }) => {
    const values = item.embedding
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_DIMENSIONS || (dimensions !== undefined && values.length !== dimensions)) throw new MemoryError("MEMORY_UNAVAILABLE", "The embedding model answered with something that could not be read.")
    dimensions = values.length
    const vector = new Float32Array(values.length)
    let norm = 0
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]
      if (typeof value !== "number" || !Number.isFinite(value)) throw new MemoryError("MEMORY_UNAVAILABLE", "The embedding model answered with something that could not be read.")
      vector[index] = value
      norm += value * value
    }
    if (norm === 0) throw new MemoryError("MEMORY_UNAVAILABLE", "The embedding model answered with an empty vector.")
    const scale = 1 / Math.sqrt(norm)
    for (let index = 0; index < vector.length; index += 1) vector[index]! *= scale
    return vector
  }))
}

/** The provider's refusal in Runrail's words; what the provider wrote back is never passed on. */
function embeddingError(error: unknown): MemoryError {
  if (error instanceof MemoryError) return error
  if (!(error instanceof ProviderError)) return new MemoryError("MEMORY_UNAVAILABLE", "The embedding model could not be reached.")
  switch (error.code) {
    case "PROVIDER_AUTH_FAILED": return new MemoryError("MEMORY_UNAVAILABLE", "The provider refused the connection's key or sign-in for this embedding model.")
    case "PROVIDER_RATE_LIMITED": return new MemoryError("MEMORY_UNAVAILABLE", "The provider's usage limit for this account was reached.")
    case "PROVIDER_TIMEOUT": return new MemoryError("MEMORY_UNAVAILABLE", "The embedding model did not answer in time.")
    case "PROVIDER_CANCELLED": return new MemoryError("MEMORY_UNAVAILABLE", "The embedding request was cancelled.")
    case "PROVIDER_ENDPOINT_DENIED": return new MemoryError("MEMORY_UNAVAILABLE", "The connection's address is not allowed.")
    default: break
  }
  if (error.status === 404 || error.status === 405 || error.status === 400 || error.status === 422) return new MemoryError("MEMORY_UNAVAILABLE", "This connection does not serve embeddings with this model.")
  return new MemoryError("MEMORY_UNAVAILABLE", "The embedding model could not answer.")
}

/**
 * Sentences from one domain that share no subject. How alike a model finds them is its noise: what
 * "nothing in common" scores on its own scale, which differs widely from model to model.
 */
export const NOISE_TEXTS: readonly string[] = Object.freeze([
  "Run the database migrations before starting the server.",
  "The button color should match the brand palette.",
  "Invoices are emailed to customers on the first of the month.",
  "Use a binary search to find the insertion point.",
  "The mobile app caches images for offline use.",
  "Rotate the TLS certificates every ninety days.",
  "Translate the onboarding screens into Spanish.",
  "The CSV export includes a header row.",
  "Profile the slow loop with a flame graph.",
  "Keep the changelog entries in the past tense.",
  "The cron job deletes temporary files at midnight.",
  "Pair programming sessions are booked on Fridays.",
])

// Noise mean plus 2.75 standard deviations. On nomic-embed-text (floor 0.526) a labeled set of 20
// paraphrased questions found the right memory for 16, a wrong one too for 3, and none of 10
// unrelated questions recalled anything; 2 deviations let half the questions pull in a wrong one.
const NOISE_DEVIATIONS = 2.75
const MIN_FLOOR = 0.2
const MAX_FLOOR = 0.9

/** The similarity a memory must reach to be recalled by meaning, from the model's vectors of `NOISE_TEXTS`. */
export function meaningFloor(noise: readonly Float32Array[]): number {
  const pairs: number[] = []
  for (let left = 0; left < noise.length; left += 1) for (let right = left + 1; right < noise.length; right += 1) pairs.push(similarity(noise[left]!, noise[right]!))
  if (pairs.length === 0) return MAX_FLOOR
  const mean = pairs.reduce((sum, value) => sum + value, 0) / pairs.length
  const spread = Math.sqrt(pairs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pairs.length)
  return Math.round(Math.min(MAX_FLOOR, Math.max(MIN_FLOOR, mean + NOISE_DEVIATIONS * spread)) * 1_000) / 1_000
}

/** Both vectors are unit length, so their dot product is the cosine similarity. */
export function similarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return 0
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += left[index]! * right[index]!
  return sum
}

/** One bit per dimension, set where the vector is positive: a 768-dimension vector in 96 bytes. */
export function signCode(vector: Float32Array): Uint32Array {
  const code = new Uint32Array(Math.ceil(vector.length / 32))
  for (let index = 0; index < vector.length; index += 1) if (vector[index]! > 0) code[index >>> 5]! |= 1 << (index & 31)
  return code
}

/** How many bits two codes differ in; vectors that point the same way differ in few. */
export function codeDistance(left: Uint32Array, right: Uint32Array, at = 0): number {
  let distance = 0
  for (let word = 0; word < left.length; word += 1) {
    let bits = left[word]! ^ right[at + word]!
    bits -= (bits >>> 1) & 0x55555555
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333)
    distance += (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  }
  return distance
}

export function vectorBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

export function blobVector(blob: Uint8Array): Float32Array {
  // A copy, so the vector is aligned whatever offset the blob came at.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\0-\x1f\x7f]/.test(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
