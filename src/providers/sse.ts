import { ProviderError } from "./errors.ts"

export interface SseEvent {
  readonly event?: string
  readonly data: string
  readonly id?: string
  readonly retry?: number
  readonly done?: boolean
}

export interface SseDecoderOptions {
  readonly maxLineBytes?: number
  readonly maxEventBytes?: number
  readonly maxStreamBytes?: number
  readonly maxEvents?: number
  readonly signal?: AbortSignal
}

/** Decode Server-Sent Events without retaining the stream or transcript. */
export async function* decodeSse(
  source: AsyncIterable<Uint8Array | string>,
  options: SseDecoderOptions = {},
): AsyncGenerator<SseEvent> {
  const maxLineBytes = bounded(options.maxLineBytes ?? 64 * 1024, 1, 4 * 1024 * 1024)
  const maxEventBytes = bounded(options.maxEventBytes ?? 256 * 1024, 1, 4 * 1024 * 1024)
  const maxStreamBytes = bounded(options.maxStreamBytes ?? 4 * 1024 * 1024, 1, 16 * 1024 * 1024)
  const maxEvents = bounded(options.maxEvents ?? 4_096, 1, 65_536)
  const decoder = new TextDecoder()
  let buffer = ""
  let streamBytes = 0
  let eventCount = 0
  let eventName: string | undefined
  let eventId: string | undefined
  let retry: number | undefined
  let data: string[] = []

  const dispatch = (): SseEvent | undefined => {
    if (data.length === 0 && eventName === undefined && eventId === undefined && retry === undefined) return undefined
    const joined = data.join("\n")
    if (Buffer.byteLength(joined, "utf8") > maxEventBytes) throw new ProviderError("PROVIDER_STREAM_FAILED", "SSE event exceeds its byte limit")
    const done = joined.trim() === "[DONE]"
    const result: SseEvent = Object.freeze({
      ...(eventName === undefined ? {} : { event: eventName }),
      data: done ? "" : joined,
      ...(eventId === undefined ? {} : { id: eventId }),
      ...(retry === undefined ? {} : { retry }),
      ...(done ? { done: true } : {}),
    })
    eventName = undefined
    eventId = undefined
    retry = undefined
    data = []
    return result
  }

  const consumeLine = (line: string): SseEvent | undefined => {
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new ProviderError("PROVIDER_STREAM_FAILED", "SSE line exceeds its byte limit")
    if (line.length === 0) return dispatch()
    if (line.startsWith(":")) return undefined
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "")
    if (field === "event") eventName = value.slice(0, 256)
    else if (field === "id") eventId = value.slice(0, 256)
    else if (field === "retry" && /^\d{1,9}$/.test(value)) retry = Number(value)
    else if (field === "data") {
      data.push(value)
      if (data.length > 4_096) throw new ProviderError("PROVIDER_STREAM_FAILED", "SSE event has too many data lines")
    }
    return undefined
  }

  for await (const chunk of source) {
    if (options.signal?.aborted === true) throw new ProviderError("PROVIDER_CANCELLED", "provider stream was cancelled")
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    streamBytes += Buffer.byteLength(text, "utf8")
    if (streamBytes > maxStreamBytes) throw new ProviderError("PROVIDER_STREAM_FAILED", "provider stream exceeds its byte limit")
    buffer += text
    for (;;) {
      const match = /\r\n|\n|\r/.exec(buffer)
      if (match === null) break
      // A CR at the end of a chunk may be the first half of a CRLF; the next chunk decides.
      if (match[0] === "\r" && match.index === buffer.length - 1) break
      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const event = consumeLine(line)
      if (event === undefined) continue
      eventCount += 1
      if (eventCount > maxEvents) throw new ProviderError("PROVIDER_STREAM_FAILED", "provider stream has too many events")
      yield event
    }
    if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) throw new ProviderError("PROVIDER_STREAM_FAILED", "SSE line exceeds its byte limit")
  }
  buffer += decoder.decode()
  if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1)
  if (buffer.length > 0) {
    const event = consumeLine(buffer)
    if (event !== undefined) {
      eventCount += 1
      if (eventCount > maxEvents) throw new ProviderError("PROVIDER_STREAM_FAILED", "provider stream has too many events")
      yield event
    }
  }
  const final = dispatch()
  if (final !== undefined) {
    eventCount += 1
    if (eventCount > maxEvents) throw new ProviderError("PROVIDER_STREAM_FAILED", "provider stream has too many events")
    yield final
  }
}

export async function collectSseJson<T>(
  source: AsyncIterable<Uint8Array | string>,
  parse: (value: unknown) => T,
  options: SseDecoderOptions = {},
): Promise<readonly T[]> {
  const values: T[] = []
  for await (const event of decodeSse(source, options)) {
    if (event.done || event.data.length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(event.data) as unknown
    } catch {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "SSE data is not valid JSON")
    }
    values.push(parse(value))
  }
  return Object.freeze(values)
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ProviderError("PROVIDER_INVALID", "SSE limit is invalid")
  return value
}
