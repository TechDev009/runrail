import type { NativeModelChunk, NativeModelRequest, NativeModelResponse } from "@nifrajs/coding-agent"
import type { ModelAdapter, ModelDescriptor, ThinkingLevel } from "../model/catalog.ts"
import type { RunrailContentModelRequest, RunrailContentPart } from "../model/content.ts"
import { createProviderHttpClient, type ProviderHttpClient } from "./http.ts"
import { ProviderError, providerStreamFailure, refusedField, STREAM_CUT_NOTE, streamCutOff, TRUNCATED_NOTE, truncatedOutput } from "./errors.ts"
import { createEnvironmentCredentialResolver, parseCredentialReference } from "./credentials.ts"
import { decodeSse } from "./sse.ts"
import { resolveProviderTarget, type ProviderTarget } from "./presets.ts"
import type { ProviderContentModelPort, ProviderModelAdapter, ProviderModelOptions, ProviderModelPort, ProviderModelUsage } from "./types.ts"
import { toolInputSchema } from "../tools/schemas.ts"
import { ConversationWindow, SHORTENED_TOOL_RESULT, ToolCallMemory, conversationChars, restoredToolCall, shortenText, shortenToolInput, toolResultText, type ConversationEntry, type RestoredToolCall } from "./tool-history.ts"

/**
 * The assistant content blocks of a turn that ended in a tool call, as the API returned them:
 * signed thinking blocks first, then any text, then the call. They are replayed unchanged because
 * the API refuses a tool result whose call, or whose thinking block, is missing.
 */
type AnthropicBlocks = readonly Readonly<Record<string, unknown>>[]

/**
 * Answer length asked for when the caller sets none. Current models write far past the old 4096
 * default, and a coding turn that stops mid-file is worse than a larger cap.
 */
const DEFAULT_MAX_TOKENS = 16_384
/** Every Messages model accepts this much. Used once an endpoint has refused the default. */
const FALLBACK_MAX_TOKENS = 4_096

/** What this endpoint has refused, shared by every port of one adapter. */
interface AnthropicLearned {
  defaultCapRejected: boolean
  /** The endpoint answered 400 to a request with cache markers and took the same request without them. */
  cacheRejected: boolean
}

/**
 * Marks where a Messages endpoint may cache the request up to: after the instructions (which also
 * covers the tool list before them) and after the newest message, so each step of a turn reads
 * what the step before it wrote.
 */
const CACHE_MARK = Object.freeze({ type: "ephemeral" })

function anthropicTarget(options: ProviderModelOptions): ProviderTarget {
  // The `anthropic` family has always ignored `protocol`; every other id must resolve to Messages.
  const target = resolveProviderTarget(options.provider === "anthropic" ? { ...options, protocol: "messages" } : options)
  if (target.protocol !== "anthropic-messages") throw new ProviderError("PROVIDER_INVALID", "Anthropic model options are invalid")
  return target
}

export function createAnthropicModelAdapter(options: ProviderModelOptions): ProviderModelAdapter {
  validateAnthropicOptions(options)
  const target = anthropicTarget(options)
  const learned: AnthropicLearned = { defaultCapRejected: false, cacheRejected: false }
  const descriptor: ModelDescriptor = Object.freeze({ id: options.model, provider: options.provider, version: options.descriptor?.version ?? "v1", tier: options.descriptor?.tier ?? "strong", capabilities: Object.freeze([...(options.descriptor?.capabilities ?? ["streaming", "tools", "multimodal", "reasoning"])]), contextTokens: options.descriptor?.contextTokens ?? 200_000, ...(options.descriptor?.pricing === undefined ? {} : { pricing: options.descriptor.pricing }) })
  return Object.freeze({
    descriptor,
    contentAware: true,
    provider: Object.freeze({ id: options.provider, name: target.name, protocols: Object.freeze(["anthropic-messages"] as const), capabilities: Object.freeze(["streaming", "tools", "multimodal", "reasoning"] as const), configured: true }),
    create: (context: { readonly thinking: ThinkingLevel }) => createPort({ ...options, thinking: context.thinking }, learned),
  })
}
export function createAnthropicModelPort(options: ProviderModelOptions & { readonly thinking?: ThinkingLevel }): ProviderModelPort & ProviderContentModelPort {
  return createPort(options, { defaultCapRejected: false, cacheRejected: false })
}

function createPort(options: ProviderModelOptions & { readonly thinking?: ThinkingLevel }, learned: AnthropicLearned): ProviderModelPort & ProviderContentModelPort {
  validateAnthropicOptions(options)
  const target = anthropicTarget(options)
  const client = createProviderHttpClient({ baseUrl: target.endpoint, allowRemote: options.allowRemote === true, allowInsecureRemote: options.allowInsecureRemote, allowedHosts: options.allowedHosts, timeoutMs: options.timeoutMs, maxRequestBytes: options.maxRequestBytes, maxResponseBytes: options.maxResponseBytes, maxStreamBytes: options.maxStreamBytes, maxEvents: options.maxEvents, maxRetries: options.maxRetries, retryDelayMs: options.retryDelayMs })
  const resolver = options.credentialResolver ?? createEnvironmentCredentialResolver()
  const calls = new ToolCallMemory<AnthropicBlocks>()
  const window = new ConversationWindow(conversationChars(options.descriptor?.contextTokens ?? 200_000))
  let lastUsage: ProviderModelUsage | undefined
  const port: ProviderModelPort & ProviderContentModelPort = {
    get lastUsage() { return lastUsage },
    takeUsage() { const value = lastUsage; lastUsage = undefined; return value },
    complete(request: NativeModelRequest | RunrailContentModelRequest) { return completeAnthropic(client, resolver, options, { calls, learned, window, bearer: target.authStyle === "bearer", caching: target.quirks.promptCaching !== false }, request as RunrailContentModelRequest, (usage) => { lastUsage = usage }) },
  }
  return port
}

interface AnthropicPortState {
  readonly calls: ToolCallMemory<AnthropicBlocks>
  readonly learned: AnthropicLearned
  readonly window: ConversationWindow
  /** Some compatible endpoints read the key from `authorization` instead of `x-api-key`. */
  readonly bearer: boolean
  /** Whether this endpoint is sent cache markers at all. */
  readonly caching: boolean
}

async function* completeAnthropic(client: ProviderHttpClient, resolver: { resolve: (reference: ProviderModelOptions["credential"]) => string | PromiseLike<string> }, options: ProviderModelOptions, state: AnthropicPortState, request: RunrailContentModelRequest, onUsage: (usage: ProviderModelUsage | undefined) => void): AsyncGenerator<NativeModelChunk> {
  const { calls, learned } = state
  let secret: string
  try { secret = await resolver.resolve(options.credential) } catch { throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential is unavailable") }
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 16 * 1024) throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential is invalid")
  const headers = { ...(options.headers ?? {}), "anthropic-version": "2023-06-01", accept: "text/event-stream", "content-type": "application/json", ...(state.bearer ? { authorization: `Bearer ${secret}` } : { "x-api-key": secret }) }
  const send = (attempt: AnthropicAttempt) => client.stream({ path: "/messages", method: "POST", headers, body: JSON.stringify(buildAnthropicBody(options, request, state, attempt)), signal: request.signal, retryable: true })
  // Two things in a request were chosen by nobody: the default answer cap and the cache markers. An
  // older or smaller model refuses a cap above its own limit, and a compatible endpoint may refuse
  // the markers; both answer 400. The turn goes out again without the one, then the other, and what
  // the endpoint took is remembered.
  const probing = options.maxOutputTokens === undefined && !learned.defaultCapRejected
  const caching = state.caching && !learned.cacheRejected
  const cap = options.maxOutputTokens ?? (probing ? DEFAULT_MAX_TOKENS : FALLBACK_MAX_TOKENS)
  const attempts: AnthropicAttempt[] = [{ maxTokens: cap, cache: caching }]
  if (probing) attempts.push({ maxTokens: FALLBACK_MAX_TOKENS, cache: caching })
  if (caching) attempts.push({ maxTokens: cap, cache: false })
  if (probing && caching) attempts.push({ maxTokens: FALLBACK_MAX_TOKENS, cache: false })
  let response: Awaited<ReturnType<typeof send>> | undefined
  // The next attempt tried is the first that leaves out a field the refusal names.
  const dropped = (from: AnthropicAttempt, to: AnthropicAttempt): string[] => [...(to.maxTokens !== from.maxTokens ? ["max_tokens"] : []), ...(to.cache !== from.cache ? ["cache_control", "cache"] : [])]
  for (let index = 0; index < attempts.length;) {
    const attempt = attempts[index]!
    try {
      response = await send(attempt)
      if (attempt.maxTokens !== cap) learned.defaultCapRejected = true
      if (caching && !attempt.cache) learned.cacheRejected = true
      break
    } catch (error) {
      const next = attempts.findIndex((candidate, at) => at > index && refusedField(error, dropped(attempt, candidate)))
      if (next < 0) throw error
      index = next
    }
  }
  if (response === undefined) throw new ProviderError("PROVIDER_FAILED", "Anthropic request failed")
  if (response.status < 200 || response.status >= 300) throw new ProviderError("PROVIDER_FAILED", "Anthropic request failed", { status: response.status })
  const contentType = response.headers["content-type"] ?? ""
  if (contentType.includes("application/json")) {
    const body = parseJson(await collect(response.body))
    const truncated = isRecord(body) && body.stop_reason === "max_tokens"
    let parsed: ReturnType<typeof parseAnthropicResponse>
    try {
      parsed = parseAnthropicResponse(body)
    } catch (error) {
      throw truncated ? truncatedOutput("before it wrote any reply") : error
    }
    onUsage(parsed.usage)
    if (truncated && parsed.response.type === "tool") throw truncatedOutput()
    if (truncated) {
      yield { type: "text_delta", text: `${parsed.text}${TRUNCATED_NOTE}` }
      yield { type: "response", response: { type: "text", text: `${parsed.text}${TRUNCATED_NOTE}` } }
      return
    }
    if (parsed.response.type === "tool") calls.remember(request.messages, parsed.response.name, parsed.blocks)
    if (parsed.text.length > 0) yield { type: "text_delta", text: parsed.text }
    yield { type: "response", response: parsed.response }
    return
  }
  let text = ""
  const blocks = new Map<number, StreamBlock>()
  let usage: ProviderModelUsage | undefined
  let stopReason: string | undefined
  // A message ends with message_stop; a stream that stops before it was cut off.
  let stopped = false
  for await (const event of decodeSse(response.body, { maxEvents: client.limits.maxEvents, maxStreamBytes: client.limits.maxStreamBytes, signal: request.signal })) {
    if (event.done) break
    let value: unknown
    try { value = JSON.parse(event.data) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Anthropic SSE event is invalid") }
    if (!isRecord(value)) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Anthropic SSE event is invalid")
    const failure = providerStreamFailure(value)
    if (failure !== undefined) throw failure
    const index = integer(value.index) ?? 0
    if (value.type === "content_block_start" && isRecord(value.content_block)) {
      const started = startBlock(value.content_block)
      if (started !== undefined) blocks.set(index, started)
    } else if (value.type === "content_block_delta" && isRecord(value.delta)) {
      const block = blocks.get(index)
      if (typeof value.delta.text === "string") {
        text += value.delta.text
        if (block?.kind === "text") block.text += value.delta.text
        yield { type: "text_delta", text: value.delta.text }
      }
      if (value.delta.type === "thinking_delta" && typeof value.delta.thinking === "string" && value.delta.thinking.length > 0) {
        if (block?.kind === "thinking") block.thinking += value.delta.thinking
        reportReasoning(options.onReasoning, value.delta.thinking)
      }
      if (value.delta.type === "signature_delta" && typeof value.delta.signature === "string" && block?.kind === "thinking") block.signature += value.delta.signature
      if (typeof value.delta.partial_json === "string" && block?.kind === "tool") block.json += value.delta.partial_json
    } else if (value.type === "message_delta") {
      if (isRecord(value.usage)) usage = mergeUsage(usage, parseUsage(value.usage))
      if (isRecord(value.delta) && typeof value.delta.stop_reason === "string") stopReason = value.delta.stop_reason
    }
    else if (value.type === "message_start" && isRecord(value.message) && isRecord(value.message.usage)) usage = mergeUsage(usage, parseUsage(value.message.usage))
    else if (value.type === "message_stop") stopped = true
  }
  onUsage(usage)
  const ordered = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block)
  // The native loop runs one tool per step and the request disables parallel calls. If several
  // arrive anyway, the first one runs and the model asks again for the rest.
  const tool = ordered.find((block): block is Extract<StreamBlock, { kind: "tool" }> => block.kind === "tool")
  if (!stopped && stopReason === undefined) {
    if (tool !== undefined) throw streamCutOff()
    if (text.length === 0) throw new ProviderError("PROVIDER_STREAM_FAILED", "Anthropic stream ended before any output")
    yield { type: "text_delta", text: STREAM_CUT_NOTE }
    yield { type: "response", response: { type: "text", text: `${text}${STREAM_CUT_NOTE}` } }
    return
  }
  if (stopReason === "max_tokens" && tool !== undefined) throw truncatedOutput()
  if (stopReason === "max_tokens" && text.length === 0) throw truncatedOutput("before it wrote any reply")
  if (tool === undefined) {
    if (stopReason === "max_tokens") yield { type: "text_delta", text: TRUNCATED_NOTE }
    yield { type: "response", response: { type: "text", text: stopReason === "max_tokens" ? `${text}${TRUNCATED_NOTE}` : text } }
    return
  }
  let input: unknown
  try { input = tool.json.length === 0 ? {} : JSON.parse(tool.json) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Anthropic tool input is invalid") }
  const replay: Record<string, unknown>[] = []
  for (const block of ordered) {
    if (block === tool) break
    if (block.kind === "thinking" && block.signature.length > 0) replay.push({ type: "thinking", thinking: block.thinking, signature: block.signature })
    else if (block.kind === "redacted") replay.push({ type: "redacted_thinking", data: block.data })
    else if (block.kind === "text" && block.text.length > 0) replay.push({ type: "text", text: block.text })
  }
  replay.push({ type: "tool_use", id: tool.id, name: tool.name, input: isRecord(input) ? input : {} })
  calls.remember(request.messages, tool.name, replay)
  yield { type: "response", response: { type: "tool", name: tool.name, input } }
}

type StreamBlock =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "thinking"; thinking: string; signature: string }
  | { readonly kind: "redacted"; readonly data: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; json: string }

function startBlock(block: Record<string, unknown>): StreamBlock | undefined {
  if (block.type === "text") return { kind: "text", text: typeof block.text === "string" ? block.text : "" }
  if (block.type === "thinking") return { kind: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "", signature: typeof block.signature === "string" ? block.signature : "" }
  if (block.type === "redacted_thinking" && typeof block.data === "string") return { kind: "redacted", data: block.data }
  if (block.type === "tool_use" && typeof block.name === "string") return { kind: "tool", id: toolUseId(block.id), name: block.name, json: "" }
  return undefined
}

function toolUseId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : `toolu_${crypto.randomUUID().replaceAll("-", "")}`
}

/** Which of the two unchosen request fields one attempt carries. */
interface AnthropicAttempt {
  readonly maxTokens: number
  readonly cache: boolean
}

/** A message of the request with the call behind it, when it is a tool result whose call is known. */
interface AnthropicTurn {
  readonly message: RunrailContentModelRequest["messages"][number]
  /** Blocks this port returned for the call, replayed as they came. */
  readonly live?: AnthropicBlocks
  /** A call rebuilt from the local transcript. */
  readonly restored?: RestoredToolCall
  readonly ordinal: number
}

function buildAnthropicBody(options: ProviderModelOptions & { readonly thinking?: ThinkingLevel }, request: RunrailContentModelRequest, state: AnthropicPortState, attempt: AnthropicAttempt): Record<string, unknown> {
  const turns: AnthropicTurn[] = []
  const entries: ConversationEntry[] = []
  let ordinal = 0
  for (const [index, message] of request.messages.entries()) {
    if (message.role !== "tool") {
      turns.push({ message, ordinal })
      entries.push({ role: message.role, chars: message.text.length })
      continue
    }
    const live = state.calls.recall(ordinal, message.name ?? "tool", index)
    const usable = live?.some((block) => block.type === "tool_use") === true ? live : undefined
    const restored = usable === undefined ? restoredToolCall(message) : undefined
    turns.push({ message, ordinal, ...(usable === undefined ? {} : { live: usable }), ...(restored === undefined ? {} : { restored }) })
    entries.push({ role: "tool", chars: message.text.length + (usable !== undefined ? JSON.stringify(usable).length : restored !== undefined ? JSON.stringify(restored.input ?? {}).length + (restored.text?.length ?? 0) : 0) })
    ordinal += 1
  }
  const boundary = state.window.boundary(request.sessionId, entries)
  const messages: Record<string, unknown>[] = []
  for (const [index, turn] of turns.entries()) {
    const { message } = turn
    const short = index < boundary
    if (message.role === "user") messages.push({ role: "user", content: anthropicContent(request, short ? shortenText(message.text) : message.text, message === request.messages.at(-1)) })
    else if (message.role === "assistant") {
      // The API refuses empty text content.
      if (message.text.length > 0) messages.push({ role: "assistant", content: short ? shortenText(message.text) : message.text })
    } else {
      const name = message.name ?? "tool"
      const result = short ? SHORTENED_TOOL_RESULT : message.text
      const blocks = turn.live !== undefined ? (short ? shortenBlocks(turn.live) : turn.live) : turn.restored !== undefined ? restoredBlocks(name, turn.ordinal, turn.restored, short) : undefined
      const call = blocks?.find((block) => block.type === "tool_use")
      if (blocks === undefined || call === undefined) messages.push({ role: "user", content: toolResultText(name, result) })
      else messages.push({ role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: result }] })
    }
  }
  const tools: Record<string, unknown>[] = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: toolInputSchema(tool.name) }))
  const system = typeof request.system === "string" && request.system.length > 0 ? request.system : undefined
  if (attempt.cache) {
    // The tool list comes before the instructions in what is cached, so one mark covers both.
    const lastTool = tools.at(-1)
    if (system === undefined && lastTool !== undefined) tools[tools.length - 1] = { ...lastTool, cache_control: CACHE_MARK }
    markNewestMessage(messages)
  }
  // With thinking on, the API requires the assistant turn a tool result answers to open with its
  // signed thinking. A call rebuilt from the transcript has none, so that request goes without it.
  const budget = options.thinking === undefined || options.thinking === "off" || continuesUnsignedCall(messages) ? undefined : thinkingBudget(options.thinking, attempt.maxTokens)
  return {
    model: options.model,
    max_tokens: attempt.maxTokens,
    ...(system === undefined ? {} : { system: [{ type: "text", text: system, ...(attempt.cache ? { cache_control: CACHE_MARK } : {}) }] }),
    messages,
    ...(tools.length === 0 ? {} : { tools, tool_choice: { type: "auto", disable_parallel_tool_use: true } }),
    stream: true,
    ...(budget === undefined ? {} : { thinking: { type: "enabled", budget_tokens: budget } }),
  }
}

function continuesUnsignedCall(messages: readonly Record<string, unknown>[]): boolean {
  const last = messages.at(-1)
  const call = messages.at(-2)
  if (last?.role !== "user" || !Array.isArray(last.content) || !last.content.some((block) => isRecord(block) && block.type === "tool_result")) return false
  if (call?.role !== "assistant" || !Array.isArray(call.content)) return false
  const first: unknown = call.content[0]
  return !isRecord(first) || (first.type !== "thinking" && first.type !== "redacted_thinking")
}

/** A call rebuilt from the transcript, in the API's shape. The id only has to pair it with its result. */
function restoredBlocks(name: string, ordinal: number, call: RestoredToolCall, short: boolean): AnthropicBlocks {
  const input = short ? shortenToolInput(call.input) : call.input
  const text = call.text === undefined ? undefined : short ? shortenText(call.text) : call.text
  return [...(text === undefined ? [] : [{ type: "text", text }]), { type: "tool_use", id: `toolu_restored_${ordinal}`, name, input: isRecord(input) ? input : {} }]
}

/** An old call with its thinking dropped and its text and arguments clipped. Thinking is only required on the newest assistant message. */
function shortenBlocks(blocks: AnthropicBlocks): AnthropicBlocks {
  return blocks.flatMap((block): Record<string, unknown>[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: shortenText(block.text) }]
    if (block.type === "tool_use") return [{ ...block, input: shortenToolInput(block.input) }]
    return []
  })
}

/** Puts the cache mark on the last block of the newest message, which is always the user's side. */
function markNewestMessage(messages: Record<string, unknown>[]): void {
  const newest = messages.at(-1)
  if (newest === undefined || newest.role !== "user") return
  const content = newest.content
  if (typeof content === "string") {
    if (content.length > 0) messages[messages.length - 1] = { ...newest, content: [{ type: "text", text: content, cache_control: CACHE_MARK }] }
    return
  }
  if (!Array.isArray(content) || content.length === 0) return
  const last = content.at(-1) as unknown
  if (!isRecord(last)) return
  messages[messages.length - 1] = { ...newest, content: [...content.slice(0, -1), { ...last, cache_control: CACHE_MARK }] }
}

function anthropicContent(request: RunrailContentModelRequest, text: string, last: boolean | undefined): unknown {
  if (!last || request.parts === undefined || request.parts.length === 0) return [{ type: "text", text }]
  return [{ type: "text", text }, ...request.parts.filter((part) => part.kind !== "text").map(partToAnthropic)]
}

function partToAnthropic(part: Exclude<RunrailContentPart, { readonly kind: "text" }>): unknown {
  if (part.kind === "file") return { type: "text", text: `[workspace file ${part.path}]\n${part.text}` }
  if (part.kind === "image") return { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.dataBase64 } }
  throw new ProviderError("PROVIDER_CONTENT_UNSUPPORTED", "Anthropic does not accept this binary content part")
}

function parseAnthropicResponse(value: unknown): { readonly response: NativeModelResponse; readonly text: string; readonly blocks: AnthropicBlocks; readonly usage?: ProviderModelUsage } {
  if (!isRecord(value)) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Anthropic response is invalid")
  const usage = isRecord(value.usage) ? parseUsage(value.usage) : undefined
  const content = value.content
  if (!Array.isArray(content)) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Anthropic response content is invalid")
  const blocks: Record<string, unknown>[] = []
  let text = ""
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text
      if (block.text.length > 0) blocks.push({ type: "text", text: block.text })
    } else if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string" && block.signature.length > 0) blocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature })
    else if (block.type === "redacted_thinking" && typeof block.data === "string") blocks.push({ type: "redacted_thinking", data: block.data })
    else if (block.type === "tool_use" && typeof block.name === "string") {
      blocks.push({ type: "tool_use", id: toolUseId(block.id), name: block.name, input: isRecord(block.input) ? block.input : {} })
      return { response: { type: "tool", name: block.name, input: block.input }, text, blocks, ...(usage === undefined ? {} : { usage }) }
    }
  }
  if (text.length > 0) return { response: { type: "text", text }, text, blocks, ...(usage === undefined ? {} : { usage }) }
  throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Anthropic response has no supported output")
}

/**
 * The API counts cached input apart from `input_tokens`. Here `inputTokens` is everything the
 * request sent, so budgets see the whole prompt, and the cached parts are reported beside it.
 */
function parseUsage(value: Record<string, unknown>): ProviderModelUsage {
  const fresh = integer(value.input_tokens)
  const cacheReadTokens = integer(value.cache_read_input_tokens)
  const cacheWriteTokens = integer(value.cache_creation_input_tokens)
  const inputTokens = fresh === undefined ? undefined : fresh + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  const outputTokens = integer(value.output_tokens)
  return usageOf(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
}
function mergeUsage(previous: ProviderModelUsage | undefined, next: ProviderModelUsage): ProviderModelUsage {
  return usageOf(next.inputTokens ?? previous?.inputTokens, next.outputTokens ?? previous?.outputTokens, next.cacheReadTokens ?? previous?.cacheReadTokens, next.cacheWriteTokens ?? previous?.cacheWriteTokens)
}
function usageOf(inputTokens: number | undefined, outputTokens: number | undefined, cacheReadTokens: number | undefined, cacheWriteTokens: number | undefined): ProviderModelUsage {
  return Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
    ...(cacheReadTokens === undefined || cacheReadTokens === 0 ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined || cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
  })
}
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
function reportReasoning(sink: ((text: string) => void) | undefined, text: string): void {
  if (sink === undefined) return
  try { sink(text) } catch { /* Reasoning display is best-effort. */ }
}

/** The API wants a budget of at least 1024 tokens that leaves room for the answer; below that, thinking stays off. */
/** Share of the answer cap each level gives to thinking. What is left, at least 1,024 tokens, is for the answer. */
const THINKING_SHARE: Readonly<Record<Exclude<ThinkingLevel, "off">, number>> = { minimal: 1 / 16, low: 1 / 8, medium: 1 / 4, high: 1 / 2, xhigh: 3 / 4, max: 15 / 16, ultra: 15 / 16 }

/** The thinking budget for a request whose answer may use `max` tokens; none when the cap leaves no room. */
function thinkingBudget(level: ThinkingLevel, max: number): number | undefined {
  if (level === "off") return undefined
  const budget = Math.min(Math.max(1_024, Math.floor(max * THINKING_SHARE[level])), max - 1_024)
  return budget < 1_024 ? undefined : budget
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> { const chunks: Uint8Array[] = []; let bytes = 0; for await (const chunk of source) { chunks.push(chunk); bytes += chunk.byteLength } const result = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength } return result }
function parseJson(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider response is not valid JSON") } }
function validateAnthropicOptions(options: ProviderModelOptions): void {
  if (options === null || typeof options !== "object" || typeof options.model !== "string" || options.model.length === 0 || options.model.length > 256 || typeof options.provider !== "string") throw new ProviderError("PROVIDER_INVALID", "Anthropic model options are invalid")
  if (options.credential === undefined || typeof options.credential !== "object") throw new ProviderError("PROVIDER_CREDENTIALS", "credential reference is required")
  if ("apiKey" in (options as object)) throw new ProviderError("PROVIDER_CREDENTIALS", "raw API keys are not accepted")
  parseCredentialReference(options.credential)
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 1_000_000)) throw new ProviderError("PROVIDER_INVALID", "provider output limit is invalid")
  if (options.onReasoning !== undefined && typeof options.onReasoning !== "function") throw new ProviderError("PROVIDER_INVALID", "provider reasoning sink is invalid")
  validateHeaders(options.headers)
}

function validateHeaders(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || Object.keys(value).length > 32) throw new ProviderError("PROVIDER_INVALID", "provider headers are invalid")
  for (const [name, entry] of Object.entries(value)) if (typeof entry !== "string" || entry.length > 4_096 || /[\r\n]/.test(entry) || ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie"].includes(name.toLowerCase())) throw new ProviderError("PROVIDER_CREDENTIALS", "authentication headers are controlled by the credential resolver")
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
