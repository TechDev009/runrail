import { createHash } from "node:crypto"
import type { NativeModelChunk, NativeModelResponse } from "@nifrajs/coding-agent"
import type { RunrailContentModelRequest } from "../model/content.ts"
import type { ProviderModelPort, ProviderModelUsage } from "../providers/types.ts"

export const RUNRAIL_PROVIDER_CERTIFICATION_VERSION = 1 as const
export type ProviderCertificationKind = "openai" | "anthropic" | "openai-compatible" | "xai"

export interface ProviderCertificationProfile {
  readonly id: string
  readonly kind: ProviderCertificationKind
  readonly version: string
  readonly capabilities: readonly string[]
  readonly create: () => ProviderModelPort | PromiseLike<ProviderModelPort>
  readonly timeoutMs?: number
  readonly request?: RunrailContentModelRequest
}

export interface ProviderCertificationCheck {
  readonly name: string
  readonly ok: boolean
  readonly code?: string
}

export interface ProviderCertificationResult {
  readonly version: typeof RUNRAIL_PROVIDER_CERTIFICATION_VERSION
  readonly id: string
  readonly kind: ProviderCertificationKind
  readonly adapterVersion: string
  readonly capabilities: readonly string[]
  readonly ok: boolean
  readonly checks: readonly ProviderCertificationCheck[]
  readonly chunkCount: number
  readonly streamedDeltas: number
  readonly terminal: boolean
  readonly usage?: ProviderModelUsage
  readonly elapsedMs: number
  readonly digest: string
}

export class ProviderCertificationError extends Error {
  constructor(readonly code: "PROVIDER_CERTIFICATION_INVALID" | "PROVIDER_CERTIFICATION_TIMEOUT" | "PROVIDER_CERTIFICATION_FAILED", reason: string) {
    super(`provider certification: ${reason}`)
    this.name = "ProviderCertificationError"
  }
}

/** Certify a provider model port using metadata-only results and a caller-supplied fixture request. */
export async function certifyProviderModel(
  profile: ProviderCertificationProfile,
  options: { readonly cwd?: string; readonly sessionId?: string } = {},
): Promise<ProviderCertificationResult> {
  validateProfile(profile)
  const started = performance.now()
  const checks: ProviderCertificationCheck[] = []
  const metadata: string[] = []
  let port: ProviderModelPort | undefined
  let chunks: NativeModelChunk[] = []
  // A check that times out stops its request too, rather than leaving it running unread.
  const abort = new AbortController()
  try {
    port = await withTimeout(Promise.resolve(profile.create()), profile.timeoutMs ?? 30_000)
    checks.push(check("port", port !== null && typeof port === "object" && typeof port.complete === "function", "PROVIDER_CERTIFICATION_PORT"))
    if (!checks.every((item) => item.ok)) return finish(profile, checks, metadata, started, chunks, undefined)
    const request = profile.request === undefined
      ? defaultRequest(options.cwd ?? process.cwd(), options.sessionId ?? "provider-certification", abort.signal)
      : { ...profile.request, signal: AbortSignal.any([profile.request.signal, abort.signal]) }
    const result = port.complete(request)
    if (isAsyncIterable(result)) {
      const iterator = result[Symbol.asyncIterator]()
      for (;;) {
        const next = await withTimeout(iterator.next(), profile.timeoutMs ?? 30_000)
        if (next.done) break
        chunks.push(next.value)
        if (chunks.length > 4_096) throw new ProviderCertificationError("PROVIDER_CERTIFICATION_FAILED", "provider emitted too many chunks")
      }
    } else {
      const response = await withTimeout(Promise.resolve(result), profile.timeoutMs ?? 30_000)
      chunks = [{ type: "response", response }]
    }
    const terminal = chunks.some((chunk) => chunk.type === "response")
    const streamedDeltas = chunks.filter((chunk) => chunk.type === "text_delta").length
    checks.push(check("terminal", terminal, "PROVIDER_CERTIFICATION_TERMINAL"))
    checks.push(check("output", terminal || streamedDeltas > 0, "PROVIDER_CERTIFICATION_OUTPUT"))
    metadata.push(...chunks.map((chunk) => chunk.type === "text_delta" || chunk.type === "reasoning_delta" ? `${chunk.type === "text_delta" ? "delta" : "reasoning"}:${chunk.text.length}` : chunk.type === "usage" ? `usage:${chunk.usedTokens}` : `response:${chunk.response.type}`))
    const usage = readUsage(port)
    return finish(profile, checks, metadata, started, chunks, usage)
  } catch (error) {
    abort.abort()
    checks.push(check("execution", false, error instanceof ProviderCertificationError ? error.code : "PROVIDER_CERTIFICATION_FAILED"))
    return finish(profile, checks, metadata, started, chunks, undefined)
  }
}

export async function certifyProviderModels(profiles: readonly ProviderCertificationProfile[], options: { readonly cwd?: string; readonly maxProfiles?: number } = {}): Promise<readonly ProviderCertificationResult[]> {
  const maxProfiles = options.maxProfiles ?? 32
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > maxProfiles || !Number.isSafeInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 256) throw new ProviderCertificationError("PROVIDER_CERTIFICATION_INVALID", "provider profile list is invalid")
  const results: ProviderCertificationResult[] = []
  for (const profile of profiles) results.push(await certifyProviderModel(profile, options))
  return Object.freeze(results)
}

function finish(profile: ProviderCertificationProfile, checks: readonly ProviderCertificationCheck[], metadata: readonly string[], started: number, chunks: readonly NativeModelChunk[], usage: ProviderModelUsage | undefined): ProviderCertificationResult {
  const digest = createHash("sha256").update(JSON.stringify({ id: profile.id, kind: profile.kind, version: profile.version, metadata, usage: usage === undefined ? undefined : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd } })).digest("hex")
  return Object.freeze({ version: 1, id: profile.id, kind: profile.kind, adapterVersion: profile.version, capabilities: Object.freeze([...profile.capabilities].sort()), ok: checks.every((check) => check.ok), checks: Object.freeze([...checks]), chunkCount: chunks.length, streamedDeltas: chunks.filter((chunk) => chunk.type === "text_delta").length, terminal: chunks.some((chunk) => chunk.type === "response"), ...(usage === undefined ? {} : { usage }), elapsedMs: Math.max(0, performance.now() - started), digest })
}

function defaultRequest(cwd: string, sessionId: string, signal: AbortSignal): RunrailContentModelRequest {
  return Object.freeze({ sessionId, cwd, messages: Object.freeze([{ role: "user" as const, text: "certification" }]), tools: Object.freeze([]), parts: Object.freeze([]), signal })
}

function readUsage(port: ProviderModelPort): ProviderModelUsage | undefined {
  let reported: unknown
  try { reported = typeof port.takeUsage === "function" ? port.takeUsage() : port.lastUsage } catch { return undefined }
  if (!isRecord(reported)) return undefined
  const inputTokens = validUsageInteger(reported.inputTokens)
  const outputTokens = validUsageInteger(reported.outputTokens)
  const totalTokens = validUsageInteger(reported.totalTokens)
  const costUsd = validUsageNumber(reported.costUsd)
  const cacheReadTokens = validUsageInteger(reported.cacheReadTokens)
  const cacheWriteTokens = validUsageInteger(reported.cacheWriteTokens)
  const elapsedMs = validUsageNumber(reported.elapsedMs)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && costUsd === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined && elapsedMs === undefined) return undefined
  return Object.freeze({ ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }), ...(costUsd === undefined ? {} : { costUsd }), ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }), ...(elapsedMs === undefined ? {} : { elapsedMs }) })
}

function validateProfile(profile: ProviderCertificationProfile): void {
  if (profile === null || typeof profile !== "object" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(profile.id) || !isKind(profile.kind) || typeof profile.version !== "string" || profile.version.length === 0 || profile.version.length > 64 || !Array.isArray(profile.capabilities) || profile.capabilities.length > 64 || profile.capabilities.some((value) => typeof value !== "string" || value.length === 0 || value.length > 128) || typeof profile.create !== "function") throw new ProviderCertificationError("PROVIDER_CERTIFICATION_INVALID", "provider certification profile is invalid")
  if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 120_000)) throw new ProviderCertificationError("PROVIDER_CERTIFICATION_INVALID", "provider certification timeout is invalid")
}

function isKind(value: unknown): value is ProviderCertificationKind { return value === "openai" || value === "anthropic" || value === "openai-compatible" || value === "xai" }
function check(name: string, ok: boolean, code: string): ProviderCertificationCheck { return Object.freeze({ name, ok, ...(ok ? {} : { code }) }) }
function isAsyncIterable(value: unknown): value is AsyncIterable<NativeModelChunk> { return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function" }
function withTimeout<T>(value: PromiseLike<T>, timeoutMs: number): Promise<T> { return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new ProviderCertificationError("PROVIDER_CERTIFICATION_TIMEOUT", "provider certification timed out")), timeoutMs); Promise.resolve(value).then((result) => { clearTimeout(timer); resolve(result) }, (error: unknown) => { clearTimeout(timer); reject(error) }) }) }
function validUsageInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000 ? value : undefined }
function validUsageNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : undefined }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
