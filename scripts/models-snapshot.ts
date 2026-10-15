/**
 * Regenerates `src/providers/models-snapshot.ts` from a models.dev catalog file.
 *
 *   bun run scripts/models-snapshot.ts --from catalog.json                       # summary only
 *   bun run scripts/models-snapshot.ts --from catalog.json --write --license-confirmed
 *   bun run scripts/models-snapshot.ts --fetch --write --license-confirmed
 *
 * Nothing is bundled until a person has confirmed the catalog's license allows it, so writing and
 * fetching both need `--license-confirmed`. Runrail never calls models.dev at run time.
 *
 * Expected input: `{ <providerId>: { models: { <modelId>: { id, name, reasoning, modalities: { input,
 * output }, limit: { context, output }, cost: { input, output } } } } }` (cost in US dollars per
 * million tokens). Entries that do not fit are skipped, not guessed.
 */
import { resolve } from "node:path"
import { isChatModelId } from "../src/providers/model-list.ts"
import type { ModelMetadata, ModelsSnapshot } from "../src/providers/models-snapshot.ts"
import { PROVIDER_PRESETS } from "../src/providers/presets.ts"

const CATALOG_URL = "https://models.dev/api.json"
const MAX_CATALOG_BYTES = 64 * 1024 * 1024
const MAX_MODELS_PER_PROVIDER = 400
const OUTPUT_PATH = "src/providers/models-snapshot.ts"

/** Keeps the facts Runrail uses, for the providers it has a preset for, and nothing else. */
export function buildModelsSnapshot(catalog: unknown, generatedAt: string, presetIds: readonly string[] = PROVIDER_PRESETS.map((preset) => preset.id)): ModelsSnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(generatedAt)) throw new Error("generatedAt must be a YYYY-MM-DD date")
  if (!isRecord(catalog)) throw new Error("catalog must be an object keyed by provider id")
  const providers: Record<string, readonly ModelMetadata[]> = {}
  for (const presetId of [...presetIds].sort()) {
    const provider = Object.hasOwn(catalog, presetId) ? catalog[presetId] : undefined
    if (!isRecord(provider) || !isRecord(provider.models)) continue
    const models: ModelMetadata[] = []
    for (const [key, value] of Object.entries(provider.models)) {
      if (!isRecord(value)) continue
      const id = text(value.id, 256) ?? text(key, 256)
      if (id === undefined || !isChatModelId(id) || models.some((model) => model.id === id)) continue
      const modalities = isRecord(value.modalities) ? value.modalities : {}
      // A model that cannot answer in text is not one a conversation can use.
      if (Array.isArray(modalities.output) && !modalities.output.includes("text")) continue
      const limit = isRecord(value.limit) ? value.limit : {}
      const name = text(value.name, 160)
      const contextTokens = count(limit.context)
      const maxOutputTokens = count(limit.output)
      const cost = isRecord(value.cost) ? value.cost : {}
      const input = price(cost.input)
      const output = price(cost.output)
      const cacheRead = price(cost.cache_read)
      const cacheWrite = price(cost.cache_write)
      models.push({
        id,
        ...(name === undefined || name === id ? {} : { name }),
        ...(contextTokens === undefined ? {} : { contextTokens }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
        ...(Array.isArray(modalities.input) ? { images: modalities.input.includes("image") } : {}),
        ...(input === undefined && output === undefined ? {} : { pricing: { ...(input === undefined ? {} : { inputUsdPerMillionTokens: input }), ...(output === undefined ? {} : { outputUsdPerMillionTokens: output }), ...(cacheRead === undefined ? {} : { cacheReadUsdPerMillionTokens: cacheRead }), ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillionTokens: cacheWrite }) } }),
      })
    }
    if (models.length === 0) continue
    providers[presetId] = models.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).slice(0, MAX_MODELS_PER_PROVIDER)
  }
  return Object.keys(providers).length === 0 ? { providers } : { generatedAt, providers }
}

/** The full text of `src/providers/models-snapshot.ts` for a snapshot. */
export function renderModelsSnapshot(snapshot: ModelsSnapshot): string {
  const providers = Object.entries(snapshot.providers)
  const body = providers.length === 0
    ? "Object.freeze({ providers: Object.freeze({}) })"
    : [
        "Object.freeze({",
        ...(snapshot.generatedAt === undefined ? [] : [`  generatedAt: ${JSON.stringify(snapshot.generatedAt)},`]),
        "  providers: Object.freeze({",
        ...providers.flatMap(([id, models]) => [`    ${JSON.stringify(id)}: Object.freeze([`, ...models.map((model) => `      Object.freeze(${renderModel(model)}),`), "    ]),"]),
        "  }),",
        "})",
      ].join("\n")
  return `${HEADER}export const MODELS_SNAPSHOT: ModelsSnapshot = ${body}\n`
}

function renderModel(model: ModelMetadata): string {
  const fields = [
    `id: ${JSON.stringify(model.id)}`,
    ...(model.name === undefined ? [] : [`name: ${JSON.stringify(model.name)}`]),
    ...(model.contextTokens === undefined ? [] : [`contextTokens: ${model.contextTokens}`]),
    ...(model.maxOutputTokens === undefined ? [] : [`maxOutputTokens: ${model.maxOutputTokens}`]),
    ...(model.reasoning === undefined ? [] : [`reasoning: ${model.reasoning}`]),
    ...(model.images === undefined ? [] : [`images: ${model.images}`]),
    ...(model.pricing === undefined ? [] : [`pricing: Object.freeze({ ${Object.entries(model.pricing).map(([key, value]) => `${key}: ${String(value)}`).join(", ")} })`]),
  ]
  return `{ ${fields.join(", ")} }`
}

const HEADER = `/**
 * Model facts that an endpoint's own list does not carry: context window, answer cap, whether the
 * model reasons, whether it reads images, and its list price.
 *
 * GENERATED by \`scripts/models-snapshot.ts\`. Do not edit by hand. The data comes from models.dev
 * (https://models.dev, MIT License, Copyright (c) 2025 models.dev; see NOTICE). Every consumer
 * works without it.
 */
export interface ModelMetadata {
  readonly id: string
  readonly name?: string
  readonly contextTokens?: number
  readonly maxOutputTokens?: number
  readonly reasoning?: boolean
  readonly images?: boolean
  /** US dollars per million tokens, as listed; a provider may bill differently. */
  readonly pricing?: ModelListPrice
}

export interface ModelListPrice {
  readonly inputUsdPerMillionTokens?: number
  readonly outputUsdPerMillionTokens?: number
  readonly cacheReadUsdPerMillionTokens?: number
  readonly cacheWriteUsdPerMillionTokens?: number
}

export interface ModelsSnapshot {
  /** ISO date the data was taken. Absent while the snapshot is empty. */
  readonly generatedAt?: string
  /** Keyed by preset id from \`PROVIDER_PRESETS\`. */
  readonly providers: Readonly<Record<string, readonly ModelMetadata[]>>
}

`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0-\x1f\x7f]/.test(value) ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A list price, rounded to a hundredth of a cent per million tokens. Zero is a real price (free). */
function price(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000 ? Math.round(value * 10_000) / 10_000 : undefined
}

async function readCatalog(args: readonly string[]): Promise<unknown> {
  const from = args.indexOf("--from")
  if (from !== -1) {
    const path = args[from + 1]
    if (path === undefined) throw new Error("--from needs a file path")
    const file = Bun.file(resolve(path))
    if (file.size > MAX_CATALOG_BYTES) throw new Error("catalog file is too large")
    return await file.json()
  }
  if (!args.includes("--fetch")) throw new Error("pass --from <file> or --fetch")
  if (!args.includes("--license-confirmed")) throw new Error("--fetch needs --license-confirmed")
  const response = await fetch(CATALOG_URL, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`catalog request failed with status ${response.status}`)
  // Counted as it arrives, so an oversized answer is cut off instead of held whole first.
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of response.body ?? []) {
    received += chunk.byteLength
    if (received > MAX_CATALOG_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error("catalog answer is too large")
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const dateIndex = args.indexOf("--date")
  const generatedAt = dateIndex === -1 ? new Date().toISOString().slice(0, 10) : args[dateIndex + 1] ?? ""
  const snapshot = buildModelsSnapshot(await readCatalog(args), generatedAt)
  const counts = Object.entries(snapshot.providers).map(([id, models]) => `${id}: ${models.length}`)
  console.log(`${counts.length} providers, ${Object.values(snapshot.providers).reduce((total, models) => total + models.length, 0)} models`)
  for (const line of counts) console.log(`  ${line}`)
  const missing = PROVIDER_PRESETS.map((preset) => preset.id).filter((id) => !Object.hasOwn(snapshot.providers, id))
  if (missing.length > 0) console.log(`no catalog entry for: ${missing.join(", ")}`)
  if (args.includes("--write")) {
    if (!args.includes("--license-confirmed")) throw new Error("--write needs --license-confirmed")
    await Bun.write(resolve(OUTPUT_PATH), renderModelsSnapshot(snapshot))
    console.log(`wrote ${OUTPUT_PATH}`)
  }
}
