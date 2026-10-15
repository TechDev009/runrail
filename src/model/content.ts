import type {
  NativeModelChunk,
  NativeModelPort,
  NativeModelRequest,
  NativeModelResponse,
} from "@nifrajs/coding-agent"

export type ImageMediaType = "image/gif" | "image/jpeg" | "image/png" | "image/webp"

export type RunrailContentPart =
  | {
      readonly kind: "text"
      readonly text: string
    }
  | {
      readonly kind: "file"
      readonly path: string
      readonly text: string
      readonly mediaType?: string
    }
  | {
      readonly kind: "image"
      readonly path?: string
      readonly mediaType: ImageMediaType
      readonly dataBase64: string
      readonly bytes: number
    }
  | {
      readonly kind: "binary"
      readonly mediaType: string
      readonly dataBase64: string
      readonly bytes: number
    }

export type RunrailContentPartInput =
  | {
      readonly kind: "text"
      readonly text: string
    }
  | {
      readonly kind: "file"
      readonly path: string
      readonly mediaType?: string
    }
  | {
      readonly kind: "image"
      readonly path?: string
      readonly mediaType?: string
      readonly dataBase64?: string
    }
  | {
      readonly kind: "binary"
      readonly mediaType: string
      readonly dataBase64: string
    }

export interface RunrailContentModelRequest extends NativeModelRequest {
  readonly parts: readonly RunrailContentPart[]
  /** Instructions a provider sends as its system prompt. Absent when the conversation carries its own context. */
  readonly system?: string
}

export interface RunrailContentModelPort {
  complete(
    request: RunrailContentModelRequest,
  ): NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk>
}

/** Bridge canonical transient content parts into the ordinary Nifra native model port. */
export class ContentModelPortBridge implements NativeModelPort {
  constructor(
    private readonly inner: RunrailContentModelPort,
    private readonly parts: () => readonly RunrailContentPart[],
  ) {}

  complete(request: NativeModelRequest) {
    // Attachments belong to the turn's prompt, never to guidance sent while the turn runs
    // (a steer is marked `steer: true`), so they are not attached when a steer is the newest message.
    const newest = request.messages[request.messages.length - 1] as { readonly steer?: unknown } | undefined
    return this.inner.complete({
      ...request,
      parts: newest?.steer === true ? Object.freeze([]) : Object.freeze([...this.parts()]),
    })
  }

  takeUsage(): unknown {
    const inner = this.inner as unknown
    return isRecord(inner) && typeof inner.takeUsage === "function" ? inner.takeUsage() : undefined
  }

}
export function createContentModelPort(
  inner: RunrailContentModelPort,
  parts: () => readonly RunrailContentPart[],
): NativeModelPort {
  return new ContentModelPortBridge(inner, parts)
}

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === "image/gif" || value === "image/jpeg" || value === "image/png" || value === "image/webp"
}

export function isRunrailContentPart(value: unknown): value is RunrailContentPart {
  if (!isRecord(value) || typeof value.kind !== "string") return false
  if (value.kind === "text") return typeof value.text === "string"
  if (value.kind === "file") return typeof value.path === "string" && typeof value.text === "string"
  if (value.kind === "image")
    return (
      isImageMediaType(value.mediaType) &&
      typeof value.dataBase64 === "string" &&
      typeof value.bytes === "number"
    )
  return (
    value.kind === "binary" &&
    typeof value.mediaType === "string" &&
    typeof value.dataBase64 === "string" &&
    typeof value.bytes === "number"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
