import type { NativeModelChunk, NativeModelPort, NativeModelRequest, NativeModelResponse } from "@nifrajs/coding-agent"

export interface ModelFallbackOptions {
  readonly shouldFallback?: (error: unknown, request: NativeModelRequest) => boolean
}

/** Retry a failed model decision with a caller-owned fallback before any tool side effect occurs. */
export class FallbackModelPort implements NativeModelPort {
  constructor(
    private readonly primary: NativeModelPort,
    private readonly fallback: NativeModelPort,
    private readonly options: ModelFallbackOptions = {},
  ) {}

  async *complete(request: NativeModelRequest): AsyncGenerator<NativeModelChunk> {
    let emitted = false
    try {
      const result = this.primary.complete(request)
      if (isAsyncIterable(result)) {
        for await (const chunk of result) {
          emitted = true
          yield chunk
        }
      } else {
        const response = await result
        emitted = true
        yield { type: "response", response }
      }
      return
    } catch (error) {
      if (emitted || request.signal.aborted || !(this.options.shouldFallback?.(error, request) ?? true)) throw error
    }
    const result = this.fallback.complete(request)
    if (isAsyncIterable(result)) {
      for await (const chunk of result) yield chunk
    } else {
      const response = await result
      yield { type: "response", response }
    }
  }
  takeUsage(): unknown {
    const primary = this.primary as unknown
    if (isRecord(primary) && typeof primary.takeUsage === "function") {
      const usage = primary.takeUsage()
      if (usage !== undefined) return usage
    }
    const fallback = this.fallback as unknown
    return isRecord(fallback) && typeof fallback.takeUsage === "function" ? fallback.takeUsage() : undefined
  }
}

export function createFallbackModelPort(primary: NativeModelPort, fallback: NativeModelPort, options: ModelFallbackOptions = {}): NativeModelPort {
  return new FallbackModelPort(primary, fallback, options)
}

function isAsyncIterable(value: NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk>): value is AsyncIterable<NativeModelChunk> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function"
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
