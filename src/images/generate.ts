import { randomBytes } from "node:crypto"
import { isPrivateHost } from "../net/redirect.ts"
import { ProviderError, refusedField } from "../providers/errors.ts"
import { createProviderHttpClient } from "../providers/http.ts"
import { resolveProviderTarget } from "../providers/presets.ts"
import type { ProviderDiscoveryOptions } from "../providers/types.ts"
import type { ImageRoute } from "./models.ts"

/**
 * One picture from the person's chosen image model, sent with the connection's own
 * stored credential to the connection's own pinned address. Neither the prompt nor the picture is
 * logged or kept here.
 */

export type ImageShape = "square" | "landscape" | "portrait"
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp"

export interface ImageInput {
  readonly mediaType: ImageMediaType
  readonly bytes: Uint8Array
}

export interface ImageRequest {
  readonly model: string
  readonly route: ImageRoute
  readonly prompt: string
  readonly shape?: ImageShape
  /** A picture to change rather than one made from nothing. */
  readonly input?: ImageInput
}

export interface GeneratedImage {
  readonly mediaType: ImageMediaType
  readonly bytes: Uint8Array
}

export type ImageErrorCode =
  | "IMAGE_INVALID_INPUT"
  | "IMAGE_NO_MODEL"
  | "IMAGE_REFUSED"
  | "IMAGE_AUTH_FAILED"
  | "IMAGE_RATE_LIMITED"
  | "IMAGE_TIMEOUT"
  | "IMAGE_UNSUPPORTED"
  | "IMAGE_FAILED"

export class ImageError extends Error {
  constructor(readonly code: ImageErrorCode, message: string) {
    super(message)
    this.name = "ImageError"
  }
}

export const MAX_IMAGE_PROMPT = 4_000
export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
// Large, careful pictures take a provider a minute or more.
const IMAGE_TIMEOUT_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 60_000

const OPENAI_SIZES: Readonly<Record<ImageShape, string>> = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" }
const DALL_E_3_SIZES: Readonly<Record<ImageShape, string>> = { square: "1024x1024", landscape: "1792x1024", portrait: "1024x1792" }
const ASPECT: Readonly<Record<ImageShape, string>> = { square: "1:1", landscape: "3:2", portrait: "2:3" }

export async function generateImage(connection: ProviderDiscoveryOptions, request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  const target = resolveProviderTarget(connection)
  if (target.protocol === "anthropic-messages") throw new ImageError("IMAGE_UNSUPPORTED", "This connection serves no image models.")
  const client = createProviderHttpClient({
    baseUrl: target.endpoint,
    allowRemote: connection.allowRemote === true,
    allowInsecureRemote: connection.allowInsecureRemote,
    allowedHosts: connection.allowedHosts,
    timeoutMs: IMAGE_TIMEOUT_MS,
    maxRequestBytes: MAX_IMAGE_BYTES,
    maxResponseBytes: MAX_IMAGE_BYTES,
    // A second picture would be paid for twice; only a refused optional field is sent again.
    maxRetries: 0,
  })
  const resolver = connection.credentialResolver
  if (resolver === undefined) throw new ImageError("IMAGE_AUTH_FAILED", "The connection's key or sign-in is not available.")
  let secret: string
  try {
    secret = await resolver.resolve(connection.credential)
  } catch {
    throw new ImageError("IMAGE_AUTH_FAILED", "The connection's key or sign-in is not available. The person can check it in Settings > Connections.")
  }
  const headers = { ...(connection.headers ?? {}), accept: "application/json", authorization: `Bearer ${secret}` }
  const send = async (withShape: boolean): Promise<unknown> => {
    const shaped = withShape ? request.shape : undefined
    if (request.route === "chat") {
      const content = [{ type: "text", text: request.prompt }, ...(request.input === undefined ? [] : [{ type: "image_url", image_url: { url: dataUrl(request.input) } }])]
      const body = { model: request.model, messages: [{ role: "user", content }], modalities: ["image", "text"], stream: false, ...(shaped === undefined ? {} : { image_config: { aspect_ratio: ASPECT[shaped] } }) }
      return client.json({ path: "chat/completions", method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal }, (value) => value)
    }
    const size = shaped === undefined ? undefined : sizeFor(request.model, shaped)
    if (request.input !== undefined) {
      const form = multipart({ model: request.model, prompt: request.prompt, ...(size === undefined ? {} : { size }) }, { name: "image", file: request.input })
      return client.json({ path: "images/edits", method: "POST", headers: { ...headers, "content-type": form.contentType }, body: form.body, signal }, (value) => value)
    }
    const body = { model: request.model, prompt: request.prompt, n: 1, ...(size === undefined ? {} : { size }) }
    return client.json({ path: "images/generations", method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal }, (value) => value)
  }
  let answer: unknown
  try {
    try {
      answer = await send(true)
    } catch (error) {
      if (request.shape === undefined || !refusedField(error, ["size", "aspect", "image_config"])) throw error
      answer = await send(false)
    }
  } catch (error) {
    throw imageError(error, request)
  }
  return pictureOf(answer, request.route, signal)
}

function sizeFor(model: string, shape: ImageShape): string | undefined {
  const id = model.toLowerCase()
  if (/(?:^|\/)dall-e-3/.test(id)) return DALL_E_3_SIZES[shape]
  if (/(?:^|\/)dall-e-2/.test(id)) return shape === "square" ? "1024x1024" : undefined
  if (/(?:^|\/)(?:gpt-image|chatgpt-image)/.test(id)) return OPENAI_SIZES[shape]
  // Other providers spell sizes their own way; their default shape is left to them.
  return undefined
}

async function pictureOf(answer: unknown, route: ImageRoute, signal: AbortSignal | undefined): Promise<GeneratedImage> {
  const found = route === "chat" ? chatPicture(answer) : imagesPicture(answer)
  if (found === undefined) throw new ImageError("IMAGE_FAILED", "The model answered without a picture.")
  const bytes = found.kind === "base64" ? decodeBase64(found.value) : await download(found.value, signal)
  const mediaType = sniffImage(bytes)
  if (mediaType === undefined) throw new ImageError("IMAGE_FAILED", "The model answered with something that is not a PNG, JPEG, or WebP picture.")
  return Object.freeze({ mediaType, bytes })
}

type Found = { readonly kind: "base64" | "url"; readonly value: string }

function imagesPicture(answer: unknown): Found | undefined {
  const first = isRecord(answer) && Array.isArray(answer.data) ? answer.data[0] : undefined
  if (!isRecord(first)) return undefined
  if (typeof first.b64_json === "string") return { kind: "base64", value: first.b64_json }
  if (typeof first.url === "string") return fromUrl(first.url)
  return undefined
}

function chatPicture(answer: unknown): Found | undefined {
  const choice = isRecord(answer) && Array.isArray(answer.choices) ? answer.choices[0] : undefined
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined
  if (message === undefined) return undefined
  const parts = [...(Array.isArray(message.images) ? message.images : []), ...(Array.isArray(message.content) ? message.content : [])]
  for (const part of parts) {
    if (!isRecord(part)) continue
    const url = isRecord(part.image_url) ? part.image_url.url : part.image_url
    if (typeof url === "string") return fromUrl(url)
  }
  return undefined
}

function fromUrl(url: string): Found | undefined {
  const data = /^data:image\/[a-z+.-]+;base64,/i.exec(url)
  if (data !== null) return { kind: "base64", value: url.slice(data[0].length) }
  return url.startsWith("https://") ? { kind: "url", value: url } : undefined
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/=\s]*$/.test(value)) throw new ImageError("IMAGE_FAILED", "The model answered with a picture that could not be read.")
  return new Uint8Array(Buffer.from(value, "base64"))
}

/**
 * Some providers answer with an address on their own file host instead of the picture. It is
 * fetched without the connection's credential, over https, never from this machine or its network.
 */
async function download(url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  let address: URL
  try {
    address = new URL(url)
  } catch {
    throw new ImageError("IMAGE_FAILED", "The model answered with a picture address that could not be read.")
  }
  if (address.protocol !== "https:" || address.username !== "" || address.password !== "" || isPrivateHost(address.hostname)) throw new ImageError("IMAGE_FAILED", "The model answered with a picture address Runrail will not fetch.")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const abort = (): void => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch(address, { signal: controller.signal, redirect: "error", headers: { accept: "image/*" } })
    if (!response.ok || response.body === null) throw new ImageError("IMAGE_FAILED", "The picture could not be fetched from the provider.")
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > MAX_IMAGE_BYTES) throw new ImageError("IMAGE_FAILED", "The picture is too large.")
      chunks.push(chunk)
    }
    return new Uint8Array(Buffer.concat(chunks))
  } catch (error) {
    if (error instanceof ImageError) throw error
    throw new ImageError(signal?.aborted === true ? "IMAGE_TIMEOUT" : "IMAGE_FAILED", "The picture could not be fetched from the provider.")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

/** The picture's real type, from its first bytes. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp"
  return undefined
}

/** Width and height from the picture's header, when it says. */
export function imageSize(bytes: Uint8Array, mediaType: ImageMediaType): { readonly width: number; readonly height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mediaType === "image/png") return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined
  if (mediaType === "image/webp") {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16))
    if (chunk === "VP8X" && bytes.length >= 30) return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) }
    if (chunk === "VP8 " && bytes.length >= 30) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return undefined
  }
  // JPEG: walk the segments to the frame header.
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]!
    const length = view.getUint16(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    offset += 2 + length
  }
  return undefined
}

function dataUrl(input: ImageInput): string {
  return `data:${input.mediaType};base64,${Buffer.from(input.bytes).toString("base64")}`
}

function multipart(fields: Readonly<Record<string, string>>, file: { readonly name: string; readonly file: ImageInput }): { readonly contentType: string; readonly body: Uint8Array } {
  const boundary = `runrail-${randomBytes(12).toString("hex")}`
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  const extension = file.file.mediaType === "image/png" ? "png" : file.file.mediaType === "image/jpeg" ? "jpg" : "webp"
  parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${file.name}"; filename="image.${extension}"\r\ncontent-type: ${file.file.mediaType}\r\n\r\n`), Buffer.from(file.file.bytes), Buffer.from(`\r\n--${boundary}--\r\n`))
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: new Uint8Array(Buffer.concat(parts)) }
}

/** The provider's refusal in Runrail's words; what the provider wrote back is never passed on. */
function imageError(error: unknown, request: ImageRequest): ImageError {
  if (error instanceof ImageError) return error
  if (!(error instanceof ProviderError)) return new ImageError("IMAGE_FAILED", "The picture could not be made.")
  switch (error.code) {
    case "PROVIDER_AUTH_FAILED": return new ImageError("IMAGE_AUTH_FAILED", "The provider refused the connection's key or sign-in for this model.")
    case "PROVIDER_RATE_LIMITED": return new ImageError("IMAGE_RATE_LIMITED", "The provider's usage limit for this account was reached. Try again later.")
    case "PROVIDER_TIMEOUT": return new ImageError("IMAGE_TIMEOUT", "The provider did not answer in time.")
    case "PROVIDER_CANCELLED": return new ImageError("IMAGE_TIMEOUT", "The picture was cancelled.")
    case "PROVIDER_RESPONSE_INVALID": return new ImageError("IMAGE_FAILED", "The provider answered with something that could not be read.")
    default: break
  }
  const refusal = error.rejection ?? ""
  if (/safety|content.?policy|moderation|not allowed|violat/.test(refusal)) return new ImageError("IMAGE_REFUSED", "The provider refused this prompt under its content rules.")
  if (error.status === 404 || error.status === 405) return new ImageError("IMAGE_UNSUPPORTED", request.input === undefined ? "This connection does not make pictures with this model." : "This model cannot change a picture through this connection; try making a new one.")
  if (error.status === 400 || error.status === 422) return new ImageError("IMAGE_UNSUPPORTED", request.input === undefined ? "The provider refused the request for this model." : "The provider refused to change this picture with this model.")
  return new ImageError("IMAGE_FAILED", "The provider could not make the picture.")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
