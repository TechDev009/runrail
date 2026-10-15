import type {
  NativeModelChunk,
  NativeModelPort,
  NativeModelRequest,
  NativeModelResponse,
} from "@nifrajs/coding-agent"
import type { ModelDescriptor } from "./catalog.ts"

export interface RunrailBudget {
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly maxTotalTokens?: number
  readonly maxCostUsd?: number
  readonly maxToolCalls?: number
  readonly maxDurationMs?: number
}

export interface RunrailUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly costUsd: number
  readonly toolCalls: number
  readonly elapsedMs: number
}

/** Validated usage reported by a provider for the currently completing request. */
export interface ReportedModelUsage {
  readonly inputTokens?: number
  /** The parts of `inputTokens` read from and written to the provider's prompt cache. */
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly costUsd?: number
  readonly elapsedMs?: number
}

export type BudgetErrorCode =
  | "BUDGET_INVALID"
  | "BUDGET_INPUT_EXCEEDED"
  | "BUDGET_OUTPUT_EXCEEDED"
  | "BUDGET_TOTAL_EXCEEDED"
  | "BUDGET_COST_EXCEEDED"
  | "BUDGET_TOOL_CALLS_EXCEEDED"
  | "BUDGET_TIME_EXCEEDED"

export class RunrailBudgetError extends Error {
  constructor(readonly code: BudgetErrorCode, reason: string) {
    super(`runrail budget: ${reason}`)
    this.name = "RunrailBudgetError"
  }
}

/** One finished model request: provider counts when reported, estimates otherwise. */
export interface ModelRequestUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimated: boolean
}

export interface BudgetLedgerOptions {
  readonly budget?: RunrailBudget
  readonly model: ModelDescriptor
  readonly clock?: () => number
  readonly onUsage?: (usage: RunrailUsage) => void
  readonly onRequest?: (usage: ModelRequestUsage) => void
}

export interface BudgetReservation {
  readonly id: number
  readonly inputTokens: number
  readonly inputCostUsd: number
}

/** Counts transient model usage without persisting prompts, responses, or credentials. */
export class BudgetLedger {
  readonly budget: RunrailBudget
  private model: ModelDescriptor
  private readonly clock: () => number
  private readonly startedAt: number
  private readonly onUsage?: (usage: RunrailUsage) => void
  private readonly onRequest?: (usage: ModelRequestUsage) => void
  private inputTokens = 0
  private outputTokens = 0
  private toolCalls = 0
  private costUsd = 0
  private readonly pending = new Map<number, BudgetReservation>()
  private pendingInputTokens = 0
  private pendingInputCostUsd = 0
  private nextReservationId = 0

  constructor(options: BudgetLedgerOptions) {
    this.budget = parseBudget(options.budget ?? {})
    this.model = options.model
    this.clock = options.clock ?? Date.now
    this.startedAt = this.clock()
    this.onUsage = options.onUsage
    this.onRequest = options.onRequest
  }

  beforeRequest(request: NativeModelRequest): BudgetReservation {
    this.checkTime()
    const inputTokens = estimateMessages(request)
    const nextInput = this.inputTokens + this.pendingInputTokens + inputTokens
    if (this.budget.maxInputTokens !== undefined && nextInput > this.budget.maxInputTokens)
      throw new RunrailBudgetError("BUDGET_INPUT_EXCEEDED", "input token budget exceeded")
    if (this.budget.maxTotalTokens !== undefined && nextInput + this.outputTokens > this.budget.maxTotalTokens)
      throw new RunrailBudgetError("BUDGET_TOTAL_EXCEEDED", "total token budget exceeded")
    if (this.budget.maxToolCalls !== undefined && this.toolCalls >= this.budget.maxToolCalls)
      throw new RunrailBudgetError("BUDGET_TOOL_CALLS_EXCEEDED", "tool call budget exceeded")
    const inputCost = calculateCost(this.model, inputTokens, 0)
    const nextCost = this.costUsd + this.pendingInputCostUsd + inputCost
    if (this.budget.maxCostUsd !== undefined && nextCost > this.budget.maxCostUsd)
      throw new RunrailBudgetError("BUDGET_COST_EXCEEDED", "model cost budget exceeded")
    const reservation = Object.freeze({ id: ++this.nextReservationId, inputTokens, inputCostUsd: inputCost })
    this.pending.set(reservation.id, reservation)
    this.pendingInputTokens += inputTokens
    this.pendingInputCostUsd += inputCost
    this.publish()
    return reservation
  }

  /** Finish the pending request using valid provider totals, or bounded estimates when absent. */
  record(response: NativeModelResponse, reported?: ReportedModelUsage, reservation?: BudgetReservation): void {
    this.checkTime()
    const pending = this.takeReservation(reservation)
    const estimatedOutput = estimateResponse(response)
    const inputTokens = validUsageInteger(reported?.inputTokens) ? reported.inputTokens : pending.inputTokens
    const outputTokens = validUsageInteger(reported?.outputTokens) ? reported.outputTokens : estimatedOutput
    const cache = validUsageInteger(reported?.inputTokens) ? { read: reported.cacheReadTokens ?? 0, write: reported.cacheWriteTokens ?? 0 } : { read: 0, write: 0 }
    const responseCost = validUsageNumber(reported?.costUsd) ? reported.costUsd : calculateCost(this.model, inputTokens, outputTokens, cache.read, cache.write)
    // The request already ran and was paid for, so it is counted before any limit is enforced.
    this.inputTokens += inputTokens
    this.outputTokens += outputTokens
    if (response.type === "tool") this.toolCalls += 1
    this.costUsd += responseCost
    this.publish()
    this.onRequest?.(Object.freeze({ inputTokens, outputTokens, estimated: !validUsageInteger(reported?.inputTokens) }))
    const nextInput = this.inputTokens + this.pendingInputTokens
    if (this.budget.maxInputTokens !== undefined && nextInput > this.budget.maxInputTokens)
      throw new RunrailBudgetError("BUDGET_INPUT_EXCEEDED", "input token budget exceeded")
    if (this.budget.maxOutputTokens !== undefined && this.outputTokens > this.budget.maxOutputTokens)
      throw new RunrailBudgetError("BUDGET_OUTPUT_EXCEEDED", "output token budget exceeded")
    if (this.budget.maxTotalTokens !== undefined && nextInput + this.outputTokens > this.budget.maxTotalTokens)
      throw new RunrailBudgetError("BUDGET_TOTAL_EXCEEDED", "total token budget exceeded")
    if (this.budget.maxCostUsd !== undefined && this.costUsd + this.pendingInputCostUsd > this.budget.maxCostUsd)
      throw new RunrailBudgetError("BUDGET_COST_EXCEEDED", "model cost budget exceeded")
  }

  /** Release a request that failed before producing a model response. */
  release(reservation: BudgetReservation): void {
    if (!this.pending.delete(reservation.id)) return
    this.pendingInputTokens -= reservation.inputTokens
    this.pendingInputCostUsd -= reservation.inputCostUsd
    this.publish()
  }

  setModel(model: ModelDescriptor): void {
    this.model = model
    this.publish()
  }

  snapshot(): RunrailUsage {
    return Object.freeze({
      inputTokens: this.inputTokens + this.pendingInputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.pendingInputTokens + this.outputTokens,
      costUsd: this.costUsd + this.pendingInputCostUsd,
      toolCalls: this.toolCalls,
      elapsedMs: Math.max(0, this.clock() - this.startedAt),
    })
  }

  private checkTime(): void {
    if (this.budget.maxDurationMs !== undefined && this.clock() - this.startedAt > this.budget.maxDurationMs)
      throw new RunrailBudgetError("BUDGET_TIME_EXCEEDED", "run duration budget exceeded")
  }

  private publish(): void {
    this.onUsage?.(this.snapshot())
  }

  private takeReservation(reservation: BudgetReservation | undefined): BudgetReservation {
    const selected = reservation ?? (this.pending.size === 1 ? this.pending.values().next().value : undefined)
    if (selected === undefined || !this.pending.has(selected.id)) throw new RunrailBudgetError("BUDGET_INVALID", "model request reservation is unknown")
    this.pending.delete(selected.id)
    this.pendingInputTokens -= selected.inputTokens
    this.pendingInputCostUsd -= selected.inputCostUsd
    return selected
  }
}

/** Enforce budgets around any provider-neutral model adapter. */
export class BudgetedModelPort implements NativeModelPort {
  constructor(
    private readonly inner: NativeModelPort,
    readonly ledger: BudgetLedger,
  ) {}

  complete(request: NativeModelRequest) {
    const reservation = this.ledger.beforeRequest(request)
    try {
      const result = this.inner.complete(request)
      if (isAsyncIterable(result)) return this.consume(result, reservation)
      return this.consumeResponse(result, reservation)
    } catch (error) {
      this.ledger.release(reservation)
      throw error
    }
  }

  private async consumeResponse(
    result: NativeModelResponse | PromiseLike<NativeModelResponse>,
    reservation: BudgetReservation,
  ): Promise<NativeModelResponse> {
    try {
      const response = await result
      this.ledger.record(response, readReportedUsage(this.inner), reservation)
      return response
    } catch (error) {
      this.ledger.release(reservation)
      throw error
    }
  }

  private async *consume(source: AsyncIterable<NativeModelChunk>, reservation: BudgetReservation): AsyncGenerator<NativeModelChunk> {
    let finalResponse: NativeModelResponse | undefined
    try {
      for await (const chunk of source) {
        if (chunk.type === "response") finalResponse = chunk.response
        yield chunk
      }
      if (finalResponse !== undefined) this.ledger.record(finalResponse, readReportedUsage(this.inner), reservation)
      else this.ledger.release(reservation)
    } catch (error) {
      this.ledger.release(reservation)
      throw error
    }
  }
}

export function parseBudget(value: unknown): RunrailBudget {
  if (!isRecord(value)) throw new RunrailBudgetError("BUDGET_INVALID", "budget must be an object")
  const budget: RunrailBudget = {
    ...(optionalBound(value.maxInputTokens, 1, 10_000_000, "maxInputTokens") === undefined
      ? {}
      : { maxInputTokens: optionalBound(value.maxInputTokens, 1, 10_000_000, "maxInputTokens") }),
    ...(optionalBound(value.maxOutputTokens, 1, 10_000_000, "maxOutputTokens") === undefined
      ? {}
      : { maxOutputTokens: optionalBound(value.maxOutputTokens, 1, 10_000_000, "maxOutputTokens") }),
    ...(optionalBound(value.maxTotalTokens, 1, 20_000_000, "maxTotalTokens") === undefined
      ? {}
      : { maxTotalTokens: optionalBound(value.maxTotalTokens, 1, 20_000_000, "maxTotalTokens") }),
    ...(optionalNumber(value.maxCostUsd, 0, 1_000_000, "maxCostUsd") === undefined
      ? {}
      : { maxCostUsd: optionalNumber(value.maxCostUsd, 0, 1_000_000, "maxCostUsd") }),
    ...(optionalBound(value.maxToolCalls, 1, 512, "maxToolCalls") === undefined
      ? {}
      : { maxToolCalls: optionalBound(value.maxToolCalls, 1, 512, "maxToolCalls") }),
    ...(optionalBound(value.maxDurationMs, 1, 86_400_000, "maxDurationMs") === undefined
      ? {}
      : { maxDurationMs: optionalBound(value.maxDurationMs, 1, 86_400_000, "maxDurationMs") }),
  }
  if (budget.maxTotalTokens !== undefined && budget.maxInputTokens !== undefined && budget.maxInputTokens > budget.maxTotalTokens)
    throw new RunrailBudgetError("BUDGET_INVALID", "input budget exceeds total budget")
  return Object.freeze(budget)
}

function estimateMessages(request: NativeModelRequest): number {
  const chars = request.messages.reduce((sum, message) => sum + message.text.length, 0)
  return Math.max(1, Math.ceil(chars / 4))
}

function estimateResponse(response: NativeModelResponse): number {
  if (response.type === "text") return Math.max(1, Math.ceil(response.text.length / 4))
  return Math.max(1, Math.ceil(JSON.stringify(response.input).length / 4))
}

function calculateCost(model: ModelDescriptor, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): number {
  const input = model.pricing?.inputUsdPerMillionTokens ?? 0
  const output = model.pricing?.outputUsdPerMillionTokens ?? 0
  const cacheRead = Math.min(cacheReadTokens, inputTokens)
  const cacheWrite = Math.min(cacheWriteTokens, inputTokens - cacheRead)
  const fresh = inputTokens - cacheRead - cacheWrite
  return (fresh * input + cacheRead * (model.pricing?.cacheReadUsdPerMillionTokens ?? input) + cacheWrite * (model.pricing?.cacheWriteUsdPerMillionTokens ?? input) + outputTokens * output) / 1_000_000
}

function readReportedUsage(value: unknown): ReportedModelUsage | undefined {
  if (!isRecord(value) || typeof value.takeUsage !== "function") return undefined
  let reported: unknown
  try { reported = value.takeUsage() } catch { return undefined }
  if (!isRecord(reported)) return undefined
  const inputTokens = validUsageInteger(reported.inputTokens) ? reported.inputTokens : undefined
  const cacheReadTokens = validUsageInteger(reported.cacheReadTokens) ? reported.cacheReadTokens : undefined
  const cacheWriteTokens = validUsageInteger(reported.cacheWriteTokens) ? reported.cacheWriteTokens : undefined
  const outputTokens = validUsageInteger(reported.outputTokens) ? reported.outputTokens : undefined
  const totalTokens = validUsageInteger(reported.totalTokens) ? reported.totalTokens : undefined
  const costUsd = validUsageNumber(reported.costUsd) ? reported.costUsd : undefined
  const elapsedMs = validUsageNumber(reported.elapsedMs) ? reported.elapsedMs : undefined
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && costUsd === undefined && elapsedMs === undefined) return undefined
  return Object.freeze({ ...(inputTokens === undefined ? {} : { inputTokens }), ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }), ...(costUsd === undefined ? {} : { costUsd }), ...(elapsedMs === undefined ? {} : { elapsedMs }) })
}

function validUsageInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000
}

function validUsageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000
}

function isAsyncIterable(value: unknown): value is AsyncIterable<NativeModelChunk> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function optionalBound(value: unknown, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RunrailBudgetError("BUDGET_INVALID", `${name} is invalid`)
  return value
}

function optionalNumber(value: unknown, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new RunrailBudgetError("BUDGET_INVALID", `${name} is invalid`)
  return value
}
