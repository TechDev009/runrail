import { randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, extname } from "node:path"
import type { ImageModelChoice } from "../accounts/connection-settings.ts"
import type { ProviderDiscoveryOptions } from "../providers/types.ts"
import type { WorkspacePolicy } from "../workspace/policy.ts"
import { ImageError, MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_PROMPT, generateImage, imageSize, sniffImage, type GeneratedImage, type ImageMediaType, type ImageRequest, type ImageShape } from "./generate.ts"

/**
 * The image tools' engine side: reads the person's chosen image model, asks its
 * connection for a picture, and saves it in the workspace. Every backend's tool calls end here.
 */

export interface ImageSource {
  /** The chosen image model while its connection is on; undefined when none is chosen or it is off. */
  choice(): Promise<ImageModelChoice | undefined>
  /** The chosen connection's provider options, with its credential reference and resolver. */
  connection(connectionId: string): Promise<{ readonly name: string; readonly options: ProviderDiscoveryOptions }>
  /** Where the thread works now. */
  workspace(): WorkspacePolicy
}

export interface ImageToolResult {
  readonly text: string
  /** The picture, for a model that can look at tool results; left out when it is large. */
  readonly image?: { readonly mediaType: ImageMediaType; readonly dataBase64: string }
}

/** What a session takes to offer the image tool. */
export interface RunrailImageAccess {
  readonly service: ImageService
  /** The `--mcp-config` document that gives Claude Code the image tool. */
  readonly mcpConfig?: string
}

export interface ImageCall {
  readonly prompt: string
  readonly path: string
  readonly shape?: ImageShape
  readonly from?: string
}

const SHAPES: readonly ImageShape[] = ["square", "landscape", "portrait"]
const EXTENSIONS: Readonly<Record<ImageMediaType, string>> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }
const PATH_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp"])
// A picture larger than this goes back as text only, so it does not crowd the model's context.
const MAX_SHOWN_BYTES = 3 * 1024 * 1024
const MAX_PATH = 1_024

export type Generate = (connection: ProviderDiscoveryOptions, request: ImageRequest, signal?: AbortSignal) => Promise<GeneratedImage>

export class ImageService {
  private source: ImageSource | undefined

  constructor(private readonly generate: Generate = generateImage) {}

  /** The engine binds its connections and workspace once they exist. */
  bind(source: ImageSource): void {
    this.source = source
  }

  async request(input: unknown, signal?: AbortSignal): Promise<ImageToolResult> {
    const call = parseImageCall(input)
    const source = this.source
    if (source === undefined) throw new ImageError("IMAGE_NO_MODEL", "Image tools are not ready in this thread.")
    const choice = await source.choice()
    if (choice === undefined) throw new ImageError("IMAGE_NO_MODEL", "No image model is chosen. The person picks one from their connections in Settings > Connections > Image model.")
    const workspace = source.workspace()
    const from = call.from === undefined ? undefined : await readInput(workspace, call.from)
    const connection = await source.connection(choice.connectionId)
    const picture = await this.generate(connection.options, { model: choice.model, route: choice.route, prompt: call.prompt, ...(call.shape === undefined ? {} : { shape: call.shape }), ...(from === undefined ? {} : { input: from }) }, signal)
    const saved = await save(workspace, call.path, picture)
    const size = imageSize(picture.bytes, picture.mediaType)
    const kind = picture.mediaType === "image/png" ? "PNG" : picture.mediaType === "image/jpeg" ? "JPEG" : "WebP"
    const renamed = saved !== call.path ? ` (the model made a ${kind}, so the name ends in ${EXTENSIONS[picture.mediaType]})` : ""
    const text = `Saved a ${size === undefined ? "" : `${size.width}x${size.height} `}${kind} to ${saved}${renamed}, made by ${choice.model} through ${connection.name}.`
    return Object.freeze({
      text,
      ...(picture.bytes.byteLength > MAX_SHOWN_BYTES ? {} : { image: { mediaType: picture.mediaType, dataBase64: Buffer.from(picture.bytes).toString("base64") } }),
    })
  }
}

export function parseImageCall(input: unknown): ImageCall {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ImageError("IMAGE_INVALID_INPUT", "The image call is not valid.")
  const value = input as Record<string, unknown>
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) throw new ImageError("IMAGE_INVALID_INPUT", "Say what the picture should show.")
  if (value.prompt.length > MAX_IMAGE_PROMPT) throw new ImageError("IMAGE_INVALID_INPUT", `The prompt is longer than ${MAX_IMAGE_PROMPT} characters.`)
  const path = workspacePath(value.path, "path")
  if (!PATH_EXTENSIONS.has(extname(path).toLowerCase())) throw new ImageError("IMAGE_INVALID_INPUT", "The path must end in .png, .jpg, .jpeg, or .webp.")
  if (value.shape !== undefined && !SHAPES.includes(value.shape as ImageShape)) throw new ImageError("IMAGE_INVALID_INPUT", "The shape must be square, landscape, or portrait.")
  const from = value.from === undefined ? undefined : workspacePath(value.from, "from")
  return Object.freeze({ prompt: value.prompt, path, ...(value.shape === undefined ? {} : { shape: value.shape as ImageShape }), ...(from === undefined ? {} : { from }) })
}

function workspacePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_PATH || /[\0-\x1f\x7f]/.test(value)) throw new ImageError("IMAGE_INVALID_INPUT", `The ${field} is not a valid workspace path.`)
  return value
}

async function readInput(workspace: WorkspacePolicy, path: string): Promise<{ readonly mediaType: ImageMediaType; readonly bytes: Uint8Array }> {
  let file: string
  try {
    file = await workspace.resolveExisting(path)
  } catch {
    throw new ImageError("IMAGE_INVALID_INPUT", "The picture to change was not found in the workspace.")
  }
  const info = await lstat(file)
  if (!info.isFile()) throw new ImageError("IMAGE_INVALID_INPUT", "The picture to change is not a file.")
  if (info.size > MAX_IMAGE_INPUT_BYTES) throw new ImageError("IMAGE_INVALID_INPUT", "The picture to change is larger than 10 MB.")
  const bytes = new Uint8Array(await readFile(file))
  const mediaType = sniffImage(bytes)
  if (mediaType === undefined) throw new ImageError("IMAGE_INVALID_INPUT", "The picture to change must be a PNG, JPEG, or WebP file.")
  return { mediaType, bytes }
}

/** Writes inside the workspace only. The name keeps the picture's real type. */
async function save(workspace: WorkspacePolicy, path: string, picture: GeneratedImage): Promise<string> {
  const extension = extname(path)
  const matches = extension.toLowerCase() === EXTENSIONS[picture.mediaType] || (extension.toLowerCase() === ".jpeg" && picture.mediaType === "image/jpeg")
  const named = matches ? path : `${path.slice(0, path.length - extension.length)}${EXTENSIONS[picture.mediaType]}`
  let file: string
  try {
    file = await workspace.resolveForWrite(named)
  } catch {
    throw new ImageError("IMAGE_INVALID_INPUT", "The picture can only be saved inside the workspace.")
  }
  await mkdir(dirname(file), { recursive: true })
  // Written beside the target and moved over it, so a reader never sees half a picture.
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temporary, picture.bytes, { flag: "wx" })
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return named
}
