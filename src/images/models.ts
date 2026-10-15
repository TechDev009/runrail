import type { ProviderPresetProtocol } from "../providers/presets.ts"

/**
 * Image models a connection serves. Runrail names no provider: whatever image
 * models the person's own connections list are the ones on offer, and the person picks one.
 */

/**
 * How a model is asked for a picture.
 * - `images`: OpenAI's images API (`images/generations`, `images/edits`), which OpenAI, xAI, Google's
 *   compatible endpoint, Together and most compatible servers answer.
 * - `chat`: a chat completion that answers with an image (`modalities`), as OpenRouter serves them.
 */
export type ImageRoute = "images" | "chat"

export interface ImageModel {
  readonly id: string
  readonly name?: string
  readonly route: ImageRoute
}

const MAX_IMAGE_MODELS = 500

const IMAGE_ID = /(?:^|[-_/.:])(?:gpt-image|chatgpt-image|dall-e|imagen|image|flux|seedream|cogview|stable-diffusion|sdxl|sd3|qwen-image|wanx|kolors|hidream|recraft|ideogram|playground-v)(?=$|[-_/.:]|\d)/i
// Image readers and other media models that a name alone would let in.
const NOT_IMAGE = /(?:^|[-_/.:])(?:embed|embedding|embeddings|video|veo|sora|tts|whisper|transcribe|vision|vl|ocr|caption|understanding)(?=$|[-_/.:]|\d)/i

/**
 * The image generators in a `GET /models` answer. A listing that says what a model outputs is
 * believed (`architecture.output_modalities`, `type: "image"`); otherwise the id decides.
 */
export function parseImageModels(value: unknown, target: { readonly presetId: string; readonly protocol: ProviderPresetProtocol }): readonly ImageModel[] {
  // Messages endpoints serve no image generators.
  if (target.protocol === "anthropic-messages") return Object.freeze([])
  const raw = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.data) ? value.data : isRecord(value) && Array.isArray(value.models) ? value.models : []
  const seen = new Set<string>()
  const models: ImageModel[] = []
  for (const item of raw.slice(0, 2_000)) {
    const record = isRecord(item) ? item : {}
    const id = typeof item === "string" ? item : typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined
    if (id === undefined || id.length === 0 || id.length > 256 || /[\0-\x1f\x7f]/.test(id) || seen.has(id)) continue
    const outputs = isRecord(record.architecture) && Array.isArray(record.architecture.output_modalities) ? record.architecture.output_modalities : undefined
    const route: ImageRoute | undefined = outputs !== undefined
      ? outputs.includes("image") ? "chat" : undefined
      : record.type === "image" ? "images" : typeof record.type === "string" && record.type !== "model" ? undefined : IMAGE_ID.test(id) && !NOT_IMAGE.test(id) ? "images" : undefined
    if (route === undefined) continue
    // Google's compatible images API serves Imagen only; its Gemini image models answer elsewhere.
    if (target.presetId === "google" && !/imagen/i.test(id)) continue
    seen.add(id)
    const name = text(record.display_name) ?? (record.name === id ? undefined : text(record.name))
    models.push(Object.freeze({ id, ...(name === undefined ? {} : { name }), route }))
    if (models.length >= MAX_IMAGE_MODELS) break
  }
  return Object.freeze(models.sort((left, right) => left.id.localeCompare(right.id)))
}

export function isImageRoute(value: unknown): value is ImageRoute {
  return value === "images" || value === "chat"
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\0-\x1f\x7f]/.test(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
