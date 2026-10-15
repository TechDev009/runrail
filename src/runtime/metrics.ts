import { createHash } from "node:crypto"
import type {
  NativeModelChunk,
  NativeModelPort,
  NativeModelRequest,
  NativeModelResponse,
} from "@nifrajs/coding-agent"
import type { ModelDescriptor } from "../model/catalog.ts"
import type { RunrailUsage } from "../model/budget.ts"

export interface RunrailMetricsSnapshot {
  readonly modelCalls: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly runs: number
  readonly successfulRuns: number
  readonly repairs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly toolCalls: number
  readonly elapsedMs: number
}

/** In-memory counters only. Callers decide whether and where aggregate metrics are retained. */
export class RunrailMetrics {
  private snapshotValue: RunrailMetricsSnapshot = Object.freeze({
    modelCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    runs: 0,
    successfulRuns: 0,
    repairs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    elapsedMs: 0,
  })

  /** Running totals of sessions still in progress, by the ledger that keeps them. */
  private readonly live = new Map<object, RunrailUsage>()

  snapshot(): RunrailMetricsSnapshot {
    if (this.live.size === 0) return this.snapshotValue
    let merged = this.snapshotValue
    for (const usage of this.live.values())
      merged = {
        ...merged,
        inputTokens: merged.inputTokens + usage.inputTokens,
        outputTokens: merged.outputTokens + usage.outputTokens,
        costUsd: merged.costUsd + usage.costUsd,
        toolCalls: merged.toolCalls + usage.toolCalls,
        elapsedMs: merged.elapsedMs + usage.elapsedMs,
      }
    return Object.freeze(merged)
  }

  /**
   * A session's totals so far, shown while it runs. They replace the owner's previous totals and
   * join the counters for good when the session records its final usage.
   */
  trackUsage(owner: object, usage: RunrailUsage): void {
    requireUsage(usage)
    this.live.set(owner, usage)
  }

  recordModelCall(): void {
    this.update({ modelCalls: this.snapshotValue.modelCalls + 1 })
  }

  recordCache(hit: boolean): void {
    this.update(hit ? { cacheHits: this.snapshotValue.cacheHits + 1 } : { cacheMisses: this.snapshotValue.cacheMisses + 1 })
  }

  recordRun(success: boolean, repairs = 0): void {
    if (!Number.isSafeInteger(repairs) || repairs < 0 || repairs > 512) throw new RangeError("repairs is invalid")
    this.update({
      runs: this.snapshotValue.runs + 1,
      successfulRuns: this.snapshotValue.successfulRuns + (success ? 1 : 0),
      repairs: this.snapshotValue.repairs + repairs,
    })
  }

  /** A finished session's usage. `owner` is the ledger it was tracked under, whose running totals it replaces. */
  recordUsage(usage: RunrailUsage, owner?: object): void {
    requireUsage(usage)
    if (owner !== undefined) this.live.delete(owner)
    this.update({
      inputTokens: this.snapshotValue.inputTokens + usage.inputTokens,
      outputTokens: this.snapshotValue.outputTokens + usage.outputTokens,
      costUsd: this.snapshotValue.costUsd + usage.costUsd,
      toolCalls: this.snapshotValue.toolCalls + usage.toolCalls,
      elapsedMs: this.snapshotValue.elapsedMs + usage.elapsedMs,
    })
  }

  /**
   * Adds totals an earlier process recorded for the same session, so they outlive a restart.
   * Anything that is not a whole set of non-negative counters is ignored; returns whether it was taken.
   */
  restore(previous: unknown): boolean {
    if (previous === null || typeof previous !== "object" || Array.isArray(previous)) return false
    const value = previous as Record<string, unknown>
    const counters = ["modelCalls", "cacheHits", "cacheMisses", "runs", "successfulRuns", "repairs", "inputTokens", "outputTokens", "toolCalls"] as const
    if (!counters.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return false
    if (![value.costUsd, value.elapsedMs].every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0)) return false
    const next: Record<string, number> = {}
    for (const key of counters) next[key] = this.snapshotValue[key] + (value[key] as number)
    next.costUsd = this.snapshotValue.costUsd + (value.costUsd as number)
    next.elapsedMs = this.snapshotValue.elapsedMs + (value.elapsedMs as number)
    this.update(next as Partial<RunrailMetricsSnapshot>)
    return true
  }

  /** Tokens a turn used outside the model port, such as a coding tool that reports its own. */
  recordTokens(inputTokens: number, outputTokens: number): void {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new RangeError("tokens are invalid")
    this.update({ inputTokens: this.snapshotValue.inputTokens + inputTokens, outputTokens: this.snapshotValue.outputTokens + outputTokens })
  }

  /** Tool calls and working time of a turn a coding tool ran, which no model port counted. */
  recordActivity(toolCalls: number, elapsedMs: number): void {
    if (!Number.isSafeInteger(toolCalls) || toolCalls < 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError("activity is invalid")
    this.update({ toolCalls: this.snapshotValue.toolCalls + toolCalls, elapsedMs: this.snapshotValue.elapsedMs + elapsedMs })
  }

  private update(changes: Partial<RunrailMetricsSnapshot>): void {
    this.snapshotValue = Object.freeze({ ...this.snapshotValue, ...changes })
  }
}

function requireUsage(usage: RunrailUsage): void {
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0 || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || !Number.isSafeInteger(usage.toolCalls) || usage.toolCalls < 0 || !Number.isFinite(usage.elapsedMs) || usage.elapsedMs < 0)
    throw new RangeError("usage is invalid")
}

export interface ModelCache {
  get(key: string): NativeModelResponse | undefined
  set(key: string, response: NativeModelResponse): void
}

/**
 * A caller-owned cache adapter. Runrail supplies a digest key and never stores cache payloads itself.
 * It belongs where the request is complete, history and instructions in: the key covers only what
 * the request carries, plus `context` for what is added further in (attachments, the thinking level).
 */
export class CachedModelPort implements NativeModelPort {
  private hit = false

  constructor(
    private readonly inner: NativeModelPort,
    private readonly model: ModelDescriptor | (() => ModelDescriptor),
    private readonly cache: ModelCache,
    private readonly metrics?: RunrailMetrics,
    private readonly context?: () => unknown,
  ) {}

  complete(request: NativeModelRequest): NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk> {
    const key = cacheKey(resolveModel(this.model), request, this.context?.())
    const cached = this.cache.get(key)
    this.hit = isModelResponse(cached)
    if (this.hit) {
      this.metrics?.recordCache(true)
      return cached as NativeModelResponse
    }
    this.metrics?.recordCache(false)
    this.metrics?.recordModelCall()
    const result = this.inner.complete(request)
    if (isAsyncIterable(result)) return this.consume(result, key)
    return this.consumeResponse(result, key)
  }

  private async consumeResponse(
    result: NativeModelResponse | PromiseLike<NativeModelResponse>,
    key: string,
  ): Promise<NativeModelResponse> {
    const response = await result
    this.cache.set(key, response)
    return response
  }

  private async *consume(source: AsyncIterable<NativeModelChunk>, key: string): AsyncGenerator<NativeModelChunk> {
    let response: NativeModelResponse | undefined
    for await (const chunk of source) {
      if (chunk.type === "response") response = chunk.response
      yield chunk
    }
    if (response !== undefined) this.cache.set(key, response)
  }

  /** A cached answer cost nothing; a fresh one reports what its provider counted. */
  takeUsage(): unknown {
    if (this.hit) return { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    const inner = this.inner as unknown
    return isRecord(inner) && typeof inner.takeUsage === "function" ? inner.takeUsage() : undefined
  }
}

function isModelResponse(value: unknown): value is NativeModelResponse {
  if (!isRecord(value)) return false
  return (value.type === "text" && typeof value.text === "string") || (value.type === "tool" && typeof value.name === "string" && value.name.length > 0)
}

/** Add model-call counters without changing complete's response or streaming shape. */
export class MeteredModelPort implements NativeModelPort {
  constructor(private readonly inner: NativeModelPort, private readonly metrics: RunrailMetrics) {}

  complete(request: NativeModelRequest) {
    this.metrics.recordModelCall()
    return this.inner.complete(request)
  }
}

export function createMetrics(): RunrailMetrics {
  return new RunrailMetrics()
}

function cacheKey(model: ModelDescriptor, request: NativeModelRequest, context: unknown): string {
  const value = request as unknown
  const parts = isRecord(value) && Array.isArray(value.parts) ? value.parts.map(contentMetadata) : []
  const normalized = {
    provider: model.provider,
    model: model.id,
    version: model.version,
    cwd: request.cwd,
    system: isRecord(value) && typeof value.system === "string" ? value.system : undefined,
    messages: request.messages.map((message) => {
      const extra = message as unknown as Record<string, unknown>
      return { role: message.role, name: message.name, text: message.text, call: extra.call, steer: extra.steer }
    }),
    tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, capabilities: tool.capabilities, input: (tool as unknown as Record<string, unknown>).inputSchema })),
    parts,
    context: context === undefined ? undefined : digest(context),
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" && item.length > 256 ? `sha256:${createHash("sha256").update(item).digest("hex")}` : item))).digest("hex")
}

function contentMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { kind: "invalid" }
  const data = typeof value.dataBase64 === "string" ? createHash("sha256").update(value.dataBase64).digest("hex") : typeof value.text === "string" ? createHash("sha256").update(value.text).digest("hex") : undefined
  return {
    kind: typeof value.kind === "string" ? value.kind : "invalid",
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    ...(data === undefined ? {} : { digest: data }),
  }
}

function resolveModel(model: ModelDescriptor | (() => ModelDescriptor)): ModelDescriptor {
  return typeof model === "function" ? model() : model
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<NativeModelChunk> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  )
}
