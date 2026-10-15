import type { NativeModelChunk, NativeModelPort, NativeModelRequest, NativeModelResponse } from "@nifrajs/coding-agent"
import type { ModelAdapter, ModelDescriptor, ThinkingLevel } from "../model/catalog.ts"
import { createProviderHttpClient, type ProviderHttpClient } from "./http.ts"
import { ProviderError, providerStreamFailure, refusedField, STREAM_CUT_NOTE, streamCutOff, TRUNCATED_NOTE, truncatedOutput } from "./errors.ts"
import { createEnvironmentCredentialResolver, parseCredentialReference } from "./credentials.ts"
import { decodeSse, type SseEvent } from "./sse.ts"
import { resolveProviderTarget, type ProviderTarget } from "./presets.ts"
import type { ProviderContentModelPort, ProviderModelAdapter, ProviderModelOptions, ProviderModelPort, ProviderModelUsage, ProviderNotice, ProviderProtocol, ProviderQuirks } from "./types.ts"
import type { RunrailContentModelRequest, RunrailContentPart } from "../model/content.ts"
import { toolInputSchema } from "../tools/schemas.ts"
import { ConversationWindow, SHORTENED_TOOL_RESULT, ToolCallMemory, conversationChars, restoredToolCall, shortenText, shortenToolInput, toolResultText, type ConversationEntry } from "./tool-history.ts"

export interface OpenAIModelAdapterOptions extends ProviderModelOptions {
  readonly providerLabel?: string
}

export function createOpenAIModelAdapter(options: OpenAIModelAdapterOptions): ProviderModelAdapter {
  validateModelOptions(options)
  const target = openAITarget(options)
  const protocol = target.protocol
  const provider = options.providerLabel ?? options.provider
  const learned = newLearned()
  const descriptor: ModelDescriptor = Object.freeze({
    id: options.model,
    provider,
    version: options.descriptor?.version ?? "v1",
    tier: options.descriptor?.tier ?? "strong",
    capabilities: Object.freeze([...(options.descriptor?.capabilities ?? ["streaming", "tools", "multimodal", "reasoning"])]),
    contextTokens: options.descriptor?.contextTokens ?? 128_000,
    ...(options.descriptor?.pricing === undefined ? {} : { pricing: options.descriptor.pricing }),
  })
  return Object.freeze({
    descriptor,
    contentAware: true,
    provider: Object.freeze({ id: provider, name: target.name, protocols: Object.freeze([protocol] as ProviderProtocol[]), capabilities: Object.freeze(["streaming", "tools", "multimodal", "reasoning"] as const), configured: true }),
    // Every port of this adapter shares what the endpoint has refused, so a refusal is probed once,
    // not once per turn.
    create: ({ thinking }: { readonly thinking: ThinkingLevel }) => createPort({ ...options, protocol, provider: options.provider, thinking }, learned),
  })
}

export interface OpenAIModelPortOptions extends Omit<OpenAIModelAdapterOptions, "protocol"> {
  readonly protocol: "openai-responses" | "openai-chat"
  readonly provider: OpenAIModelAdapterOptions["provider"]
  readonly thinking: ThinkingLevel
}

export function createOpenAIModelPort(options: OpenAIModelPortOptions): ProviderModelPort & ProviderContentModelPort {
  return createPort(options, newLearned())
}

type OpenAITarget = ProviderTarget & { readonly protocol: OpenAIModelPortOptions["protocol"] }

function openAITarget(options: Pick<OpenAIModelAdapterOptions, "provider" | "endpoint" | "authStyle" | "quirks" | "displayName"> & { readonly protocol?: ProviderModelOptions["protocol"] | OpenAIModelPortOptions["protocol"] }): OpenAITarget {
  const target = resolveProviderTarget(options)
  if (target.protocol === "anthropic-messages") throw new ProviderError("PROVIDER_INVALID", "OpenAI provider kind is invalid")
  return target as OpenAITarget
}

function createPort(options: OpenAIModelPortOptions, learned: OpenAILearned): ProviderModelPort & ProviderContentModelPort {
  validateModelOptions(options)
  const target = openAITarget(options)
  const client = createProviderHttpClient({
    baseUrl: target.endpoint,
    allowRemote: options.allowRemote === true,
    allowInsecureRemote: options.allowInsecureRemote,
    allowedHosts: options.allowedHosts,
    timeoutMs: options.timeoutMs,
    maxRequestBytes: options.maxRequestBytes,
    maxResponseBytes: options.maxResponseBytes,
    maxStreamBytes: options.maxStreamBytes,
    maxEvents: options.maxEvents,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
  })
  const resolver = options.credentialResolver ?? createEnvironmentCredentialResolver()
  const state: OpenAIPortState = { calls: new ToolCallMemory(), window: new ConversationWindow(conversationChars(options.descriptor?.contextTokens)), quirks: target.quirks, learned, refusalNoticed: false }
  let lastUsage: ProviderModelUsage | undefined
  const port: ProviderModelPort & ProviderContentModelPort = {
    get lastUsage() { return lastUsage },
    takeUsage() {
      const value = lastUsage
      lastUsage = undefined
      return value
    },
    complete(request: NativeModelRequest | RunrailContentModelRequest) {
      return completeOpenAI(client, resolver, options, state, request as RunrailContentModelRequest, (usage) => { lastUsage = usage })
    },
  }
  return port
}

/** A tool call this port returned, kept so its result can be replayed as a valid call and answer pair. */
interface OpenAIToolCall {
  readonly id: string
  readonly arguments: string
  readonly text: string
  /** Reasoning text streamed before the call. Kept only for endpoints that want it replayed. */
  readonly reasoning: string
  /**
   * Responses reasoning items that led to the call, as the endpoint sealed them. With `store: false`
   * nothing is kept on the provider's side, so they are sent back for the model to keep its line of
   * thought across the steps of a turn. Held in memory only.
   */
  readonly reasoningItems: readonly ReasoningItem[]
}

interface ReasoningItem {
  readonly summary: readonly Record<string, unknown>[]
  readonly encrypted_content: string
}

/** Optional request fields an endpoint refused, and then accepted the same request without. */
interface OpenAILearned {
  /** The thinking fields refused, one entry per level as sent, so another level is still tried. */
  readonly thinkingRejected: Set<string>
  parallelRejected: boolean
  /** A Responses endpoint that refuses the request for sealed reasoning items. */
  includeRejected: boolean
}

interface OpenAIPortState {
  readonly calls: ToolCallMemory<OpenAIToolCall>
  readonly window: ConversationWindow
  readonly quirks: ProviderQuirks
  readonly learned: OpenAILearned
  /** Set once this port has said its level was refused, so a long turn says it once. */
  refusalNoticed: boolean
}

function notify(sink: ((notice: ProviderNotice) => void) | undefined, notice: ProviderNotice): void {
  if (sink === undefined) return
  try { sink(notice) } catch { /* A notice is best-effort. */ }
}

function newLearned(): OpenAILearned {
  return { thinkingRejected: new Set(), parallelRejected: false, includeRejected: false }
}

/** Which optional fields one attempt carries. */
interface OpenAIAttempt {
  readonly thinking: boolean
  readonly parallel: boolean
  /** Ask a Responses endpoint for sealed reasoning items, and send back the ones it gave. */
  readonly include: boolean
}

async function* completeOpenAI(
  client: ProviderHttpClient,
  resolver: ReturnType<typeof createEnvironmentCredentialResolver> | NonNullable<OpenAIModelAdapterOptions["credentialResolver"]>,
  options: OpenAIModelPortOptions,
  state: OpenAIPortState,
  request: RunrailContentModelRequest,
  onUsage: (usage: ProviderModelUsage | undefined) => void,
): AsyncGenerator<NativeModelChunk> {
  const secret = await resolveSecret(resolver, options)
  const send = (attempt: OpenAIAttempt) => client.stream({
    path: options.protocol === "openai-responses" ? "/responses" : "/chat/completions",
    method: "POST",
    headers: { ...(options.headers ?? {}), accept: "text/event-stream", "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(options.protocol === "openai-responses" ? buildResponsesBody(options, request, state, attempt) : buildChatBody(options, request, state, attempt)),
    signal: request.signal,
    retryable: false,
  })
  // Three request fields are hints, not the turn itself: the thinking switch, the single-tool-call
  // flag, and the request for sealed reasoning items. A model or endpoint that does not know one
  // answers 400 or 422. The turn matters more than the hint, so the same request goes out again
  // without it, and the refusal is remembered.
  const fields = thinkingFields(options, state.quirks)
  const thinkingKey = JSON.stringify(fields)
  const wanted = Object.keys(fields).length > 0
  const thinking = wanted && !state.learned.thinkingRejected.has(thinkingKey)
  const parallel = !state.learned.parallelRejected && request.tools.length > 0
  const include = thinking && options.protocol === "openai-responses" && options.thinking !== "off" && !state.learned.includeRejected
  const attempts: OpenAIAttempt[] = [{ thinking, parallel, include }]
  if (include) attempts.push({ thinking, parallel, include: false })
  if (thinking) attempts.push({ thinking: false, parallel, include: false })
  if (parallel) attempts.push({ thinking, parallel: false, include: false })
  if (thinking && parallel) attempts.push({ thinking: false, parallel: false, include: false })
  let response: Awaited<ReturnType<typeof send>> | undefined
  let sent: OpenAIAttempt = attempts[0]!
  // The next attempt tried is the first that leaves out a field the refusal names.
  const dropped = (from: OpenAIAttempt, to: OpenAIAttempt): string[] => [
    ...(to.include !== from.include ? ["include", "encrypted"] : []),
    ...(to.thinking !== from.thinking ? ["reasoning", "thinking", ...Object.keys(fields).map((key) => key.toLowerCase())] : []),
    ...(to.parallel !== from.parallel ? ["parallel_tool_calls", "parallel"] : []),
  ]
  for (let index = 0; index < attempts.length;) {
    const attempt = attempts[index]!
    try {
      response = await send(attempt)
      sent = attempt
      if (include && !attempt.include) state.learned.includeRejected = true
      if (thinking && !attempt.thinking) state.learned.thinkingRejected.add(thinkingKey)
      if (parallel && !attempt.parallel) state.learned.parallelRejected = true
      break
    } catch (error) {
      const next = attempts.findIndex((candidate, at) => at > index && refusedField(error, dropped(attempt, candidate)))
      if (next < 0) throw error
      index = next
    }
  }

  if (response === undefined) throw new ProviderError("PROVIDER_FAILED", "OpenAI request failed")
  if (wanted && !sent.thinking && !state.refusalNoticed) {
    state.refusalNoticed = true
    notify(options.onNotice, { code: "THINKING_REFUSED", thinking: options.thinking })
  }
  const keepReasoning = state.quirks.reasoningReplay === true && sent.thinking
  if (response.status < 200 || response.status >= 300) throw new ProviderError("PROVIDER_FAILED", "OpenAI request failed", { status: response.status })
  const contentType = response.headers["content-type"] ?? ""
  if (contentType.includes("application/json")) {
    const value = parseJsonBytes(await collectStream(response.body))
    const truncated = isTruncatedResponse(value)
    let parsed: ReturnType<typeof parseOpenAIResponse>
    try {
      parsed = parseOpenAIResponse(value)
    } catch (error) {
      throw truncated ? truncatedOutput("before it wrote any reply") : error
    }
    onUsage(parsed.usage)
    if (truncated && parsed.response.type === "tool") throw truncatedOutput()
    const answer = truncated && parsed.response.type === "text" ? { type: "text" as const, text: `${parsed.response.text}${TRUNCATED_NOTE}` } : parsed.response
    rememberCall(state, request, answer, parsed.callId, "", "", sent.include ? parsed.reasoningItems : [])
    if (parsed.text.length > 0 || truncated) yield { type: "text_delta", text: truncated ? `${parsed.text}${TRUNCATED_NOTE}` : parsed.text }
    yield { type: "response", response: answer }
    return
  }
  let text = ""
  let reasoningText = ""
  let callId: string | undefined
  const toolCalls = new Map<number, { readonly id?: string; readonly name?: string; readonly arguments: string }>()
  let usage: ProviderModelUsage | undefined
  let terminal: NativeModelResponse | undefined
  let truncated = false
  // Chat ends with a finish reason or [DONE], Responses with response.completed.
  let finished = false
  const reasoningItems: ReasoningItem[] = []
  for await (const event of decodeSse(response.body, { maxStreamBytes: client.limits.maxStreamBytes, maxEvents: Math.min(options.maxEvents ?? client.limits.maxEvents, client.limits.maxEvents), signal: request.signal })) {
    if (event.done) {
      finished = true
      break
    }
    for (const parsed of parseSseEvent(event, options.protocol)) {
      if (parsed.kind === "finished" || parsed.kind === "final" || parsed.kind === "truncated") finished = true
      if (parsed.kind === "text") {
        text += parsed.value
        yield { type: "text_delta", text: parsed.value }
      } else if (parsed.kind === "reasoning") {
        if (keepReasoning) reasoningText += parsed.value
        if (options.onReasoning !== undefined) {
          try { options.onReasoning(parsed.value) } catch { /* Reasoning display is best-effort. */ }
        }
      } else if (parsed.kind === "tool") {
        const index = parsed.index ?? 0
        const current = toolCalls.get(index)
        toolCalls.set(index, { id: parsed.id ?? current?.id, name: parsed.name ?? current?.name, arguments: `${current?.arguments ?? ""}${parsed.arguments ?? ""}` })
      } else if (parsed.kind === "reasoning-item") {
        if (sent.include && reasoningItems.length < MAX_REASONING_ITEMS) reasoningItems.push(parsed.item)
      } else if (parsed.kind === "usage") {
        usage = parsed.usage
      } else if (parsed.kind === "truncated") {
        truncated = true
        if (parsed.usage !== undefined) usage = parsed.usage
      } else if (parsed.kind === "finished") {
        if (parsed.usage !== undefined) usage = parsed.usage
      } else if (parsed.kind === "final") {
        terminal = parsed.response
        callId = parsed.callId
        if (parsed.usage !== undefined) usage = parsed.usage
      }
    }
  }
  // The native loop runs one tool per step and the request disables parallel calls. If an endpoint
  // sends several anyway, the first one runs and the model asks again for the rest.
  const toolCall = [...toolCalls.entries()].sort(([left], [right]) => left - right)[0]?.[1]
  if (!finished && !truncated) {
    if (toolCall !== undefined || terminal?.type === "tool") throw streamCutOff()
    if (text.length === 0) throw new ProviderError("PROVIDER_STREAM_FAILED", "OpenAI stream ended before any output")
    yield { type: "text_delta", text: STREAM_CUT_NOTE }
    text += STREAM_CUT_NOTE
  }
  if (truncated && (toolCall !== undefined || terminal?.type === "tool")) throw truncatedOutput()
  if (truncated && text.length === 0) throw truncatedOutput("before it wrote any reply")
  if (truncated) {
    yield { type: "text_delta", text: TRUNCATED_NOTE }
    text += TRUNCATED_NOTE
    terminal = undefined
  }
  if (toolCall !== undefined) {
    if (toolCall.name === undefined) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI tool name is missing")
    let input: unknown
    try { input = toolCall.arguments.length === 0 ? {} : JSON.parse(toolCall.arguments) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI tool arguments are invalid") }
    terminal = { type: "tool", name: toolCall.name, input }
    callId = toolCall.id ?? callId
  }
  onUsage(usage)
  if (terminal === undefined) {
    if (text.length === 0) throw new ProviderError("PROVIDER_STREAM_FAILED", "OpenAI stream has no terminal output")
    terminal = { type: "text", text }
  }
  rememberCall(state, request, terminal, callId, text, reasoningText, reasoningItems)
  yield { type: "response", response: terminal }
}

function rememberCall(state: OpenAIPortState, request: RunrailContentModelRequest, response: NativeModelResponse, id: string | undefined, text: string, reasoning: string, reasoningItems: readonly ReasoningItem[]): void {
  if (response.type !== "tool") return
  state.calls.remember(request.messages, response.name, { id: id ?? `call_${crypto.randomUUID().replaceAll("-", "")}`, arguments: JSON.stringify(response.input ?? {}), text, reasoning, reasoningItems })
}

const MAX_REASONING_ITEMS = 8
const MAX_SEALED_REASONING_CHARS = 512 * 1024

/** A sealed reasoning item worth sending back: the opaque content, and the summary it came with. */
function reasoningItemOf(item: Record<string, unknown>): ReasoningItem | undefined {
  if (item.type !== "reasoning" || typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0 || item.encrypted_content.length > MAX_SEALED_REASONING_CHARS) return undefined
  const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "summary_text" && typeof part.text === "string" && part.text.length <= 16 * 1024).slice(0, 16).map((part) => ({ type: "summary_text", text: part.text })) : []
  return { summary, encrypted_content: item.encrypted_content }
}

/** One message of the request with the call behind it, when it is a tool result whose call is known. */
interface OpenAITurn {
  readonly message: RunrailContentModelRequest["messages"][number]
  readonly call?: OpenAIToolCall
  /** True when this message is in the oldest part of the conversation, sent shortened. */
  readonly short: boolean
}

/**
 * Pairs every tool result with its call (one this port returned, or one rebuilt from the local
 * transcript) and shortens the oldest part of a conversation that no longer fits the model.
 */
function planConversation(request: RunrailContentModelRequest, state: OpenAIPortState): readonly OpenAITurn[] {
  const calls: (OpenAIToolCall | undefined)[] = []
  const entries: ConversationEntry[] = []
  let ordinal = 0
  for (const [index, message] of request.messages.entries()) {
    if (message.role !== "tool") {
      calls.push(undefined)
      entries.push({ role: message.role, chars: message.text.length })
      continue
    }
    const live = state.calls.recall(ordinal, message.name ?? "tool", index)
    const restored = live === undefined ? restoredToolCall(message) : undefined
    const call = live ?? (restored === undefined ? undefined : { id: `call_restored_${ordinal}`, arguments: JSON.stringify(restored.input ?? {}), text: restored.text ?? "", reasoning: "", reasoningItems: [] })
    calls.push(call)
    entries.push({ role: "tool", chars: message.text.length + (call === undefined ? 0 : call.arguments.length + call.text.length) })
    ordinal += 1
  }
  const boundary = state.window.boundary(request.sessionId, entries)
  return request.messages.map((message, index): OpenAITurn => {
    const short = index < boundary
    const call = calls[index]
    if (!short) return { message, short, ...(call === undefined ? {} : { call }) }
    if (message.role !== "tool") return { message: { ...message, text: shortenText(message.text) }, short }
    return { message: { ...message, text: SHORTENED_TOOL_RESULT }, short, ...(call === undefined ? {} : { call: { ...call, arguments: shortenArguments(call.arguments), text: shortenText(call.text), reasoning: "", reasoningItems: [] } }) }
  })
}

function shortenArguments(value: string): string {
  try { return JSON.stringify(shortenToolInput(JSON.parse(value) as unknown)) } catch { return "{}" }
}

function buildChatBody(options: OpenAIModelPortOptions, request: RunrailContentModelRequest, state: OpenAIPortState, attempt: OpenAIAttempt): Record<string, unknown> {
  const { quirks } = state
  // An endpoint that checks the thinking of earlier turns refuses an assistant message without the
  // field, so while thinking is on every one carries it: the remembered text, or an empty string.
  const replay = quirks.reasoningReplay === true && attempt.thinking && options.thinking !== "off"
  const messages: Record<string, unknown>[] = typeof request.system === "string" && request.system.length > 0 ? [{ role: "system", content: request.system }] : []
  const newest = request.messages.length - 1
  for (const [index, { message, call }] of planConversation(request, state).entries()) {
    if (message.role !== "tool") {
      messages.push({ role: message.role, content: message.role === "user" ? chatContent(request, message.text, index === newest) : message.text, ...(replay && message.role === "assistant" ? { reasoning_content: "" } : {}) })
      continue
    }
    const name = message.name ?? "tool"
    if (call === undefined) messages.push({ role: "user", content: toolResultText(name, message.text) })
    else messages.push({ role: "assistant", content: call.text.length > 0 ? call.text : null, ...(replay ? { reasoning_content: call.reasoning } : {}), tool_calls: [{ id: call.id, type: "function", function: { name, arguments: call.arguments } }] }, { role: "tool", tool_call_id: call.id, content: message.text })
  }
  const tools = request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool.name) } }))
  return {
    model: options.model,
    messages,
    stream: true,
    ...(quirks.streamOptions === false ? {} : { stream_options: { include_usage: true } }),
    ...(tools.length === 0 ? {} : { tools, ...(attempt.parallel ? { parallel_tool_calls: false } : {}) }),
    ...(options.maxOutputTokens === undefined ? {} : { [quirks.maxTokensField ?? "max_tokens"]: options.maxOutputTokens }),
    ...(attempt.thinking ? thinkingFields(options, quirks) : {}),
  }
}

/** The thinking switch in the spelling this endpoint reads. Empty when there is nothing to send. */
function thinkingFields(options: OpenAIModelPortOptions, quirks: ProviderQuirks): Record<string, unknown> {
  const on = options.thinking !== "off"
  const shape = quirks.thinking ?? "effort"
  if (shape === "none") return {}
  if (options.protocol === "openai-responses") return on ? { reasoning: { effort: thinkingValue(options.thinking) } } : {}
  if (shape === "reasoning-object") return on ? { reasoning: { effort: thinkingValue(options.thinking) } } : {}
  if (shape === "thinking-type") return { thinking: { type: on ? "enabled" : "disabled" } }
  if (shape === "zhipu") return { thinking: on ? { type: "enabled", clear_thinking: false } : { type: "disabled" } }
  if (shape === "together") return { reasoning: { enabled: on } }
  if (shape === "qwen") return { enable_thinking: on }
  return on ? { reasoning_effort: thinkingValue(options.thinking) } : {}
}

function buildResponsesBody(options: OpenAIModelPortOptions, request: RunrailContentModelRequest, state: OpenAIPortState, attempt: OpenAIAttempt): Record<string, unknown> {
  const { quirks } = state
  const input: Record<string, unknown>[] = []
  const newest = request.messages.length - 1
  for (const [index, { message, call }] of planConversation(request, state).entries()) {
    if (message.role === "user") input.push({ role: "user", content: responseContent(request, message.text, index === newest) })
    else if (message.role === "assistant") input.push({ role: "assistant", content: [{ type: "output_text", text: message.text }] })
    else {
      const name = message.name ?? "tool"
      if (call === undefined) input.push({ role: "user", content: [{ type: "input_text", text: toolResultText(name, message.text) }] })
      else {
        // Sealed reasoning goes back only to an endpoint that was asked for it on this attempt.
        if (attempt.include) for (const item of call.reasoningItems) input.push({ type: "reasoning", summary: item.summary, encrypted_content: item.encrypted_content })
        if (call.text.length > 0) input.push({ role: "assistant", content: [{ type: "output_text", text: call.text }] })
        input.push({ type: "function_call", call_id: call.id, name, arguments: call.arguments }, { type: "function_call_output", call_id: call.id, output: message.text })
      }
    }
  }
  const system = typeof request.system === "string" && request.system.length > 0 ? request.system : undefined
  const tools = request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: toolInputSchema(tool.name) }))
  // `store: false`: the conversation lives in Runrail's journal, not on the provider's side, and
  // sign-in based endpoints refuse stored responses.
  return { model: options.model, ...(system === undefined ? {} : { instructions: system }), input, stream: true, store: false, ...(attempt.include ? { include: ["reasoning.encrypted_content"] } : {}), ...(tools.length === 0 ? {} : { tools, ...(attempt.parallel ? { parallel_tool_calls: false } : {}) }), ...(options.maxOutputTokens === undefined ? {} : { max_output_tokens: options.maxOutputTokens }), ...(attempt.thinking ? thinkingFields(options, quirks) : {}) }
}

function chatContent(request: RunrailContentModelRequest, text: string, last: boolean | undefined): unknown {
  if (!last || request.parts === undefined || request.parts.length === 0) return text
  return request.parts.map((part) => partToChat(part, text))
}

function responseContent(request: RunrailContentModelRequest, text: string, last: boolean | undefined): unknown {
  if (!last || request.parts === undefined || request.parts.length === 0) return [{ type: "input_text", text }]
  return [{ type: "input_text", text }, ...request.parts.filter((part) => part.kind !== "text").map(partToResponse)]
}

function partToChat(part: RunrailContentPart, text: string): unknown {
  if (part.kind === "text") return { type: "text", text: part.text === text ? text : part.text }
  if (part.kind === "file") return { type: "text", text: `[workspace file ${part.path}]\n${part.text}` }
  if (part.kind === "image") return { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` } }
  throw new ProviderError("PROVIDER_CONTENT_UNSUPPORTED", "OpenAI Chat does not accept this binary content part")
}

function partToResponse(part: Exclude<RunrailContentPart, { readonly kind: "text" }>): unknown {
  if (part.kind === "file") return { type: "input_text", text: `[workspace file ${part.path}]\n${part.text}` }
  if (part.kind === "image") return { type: "input_image", image_url: `data:${part.mediaType};base64,${part.dataBase64}` }
  if (part.kind === "binary") return { type: "input_file", filename: "runrail-input", file_data: `data:${part.mediaType};base64,${part.dataBase64}` }
}

type ParsedSsePart =
  | { readonly kind: "text" | "reasoning"; readonly value: string }
  | { readonly kind: "tool"; readonly index?: number; readonly id?: string; readonly name?: string; readonly arguments?: string }
  | { readonly kind: "usage"; readonly usage: ProviderModelUsage }
  | { readonly kind: "reasoning-item"; readonly item: ReasoningItem }
  | { readonly kind: "final"; readonly response: NativeModelResponse; readonly callId?: string; readonly usage?: ProviderModelUsage }
  | { readonly kind: "truncated"; readonly usage?: ProviderModelUsage }
  | { readonly kind: "finished"; readonly usage?: ProviderModelUsage }

/** One SSE event can carry several parts: a Chat chunk may hold text, reasoning, and every tool call at once. */
function parseSseEvent(event: SseEvent, protocol: OpenAIModelPortOptions["protocol"]): readonly ParsedSsePart[] {
  const parsed = parseSingleSseEvent(event, protocol)
  if (parsed === undefined) return []
  return isPartList(parsed) ? parsed : [parsed]
}

function isPartList(value: ParsedSsePart | readonly ParsedSsePart[]): value is readonly ParsedSsePart[] {
  return Array.isArray(value)
}

function parseSingleSseEvent(event: SseEvent, protocol: OpenAIModelPortOptions["protocol"]): ParsedSsePart | readonly ParsedSsePart[] | undefined {
  let value: unknown
  try { value = JSON.parse(event.data) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI SSE event is invalid") }
  if (!isRecord(value)) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI SSE event is invalid")
  const failure = providerStreamFailure(value)
  if (failure !== undefined) throw failure
  if (protocol === "openai-chat") {
    const choices = value.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      if (isRecord(value.usage)) return { kind: "usage", usage: parseUsage(value.usage) }
      return undefined
    }
    const choice = choices[0]
    if (!isRecord(choice)) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI choice is invalid")
    const delta = choice.delta
    const parts: ParsedSsePart[] = []
    if (isRecord(delta)) {
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : undefined
      if (reasoning !== undefined && reasoning.length > 0) parts.push({ kind: "reasoning", value: reasoning })
      if (typeof delta.content === "string" && delta.content.length > 0) parts.push({ kind: "text", value: delta.content })
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const [position, call] of calls.entries()) {
        if (!isRecord(call)) continue
        const functionValue = isRecord(call.function) ? call.function : {}
        const index = integer(call.index) ?? position
        parts.push({ kind: "tool", index, ...(typeof call.id === "string" && call.id.length > 0 ? { id: call.id } : {}), ...(typeof functionValue.name === "string" ? { name: functionValue.name } : {}), ...(typeof functionValue.arguments === "string" ? { arguments: functionValue.arguments } : {}) })
      }
    }
    if (isRecord(value.usage)) parts.push({ kind: "usage", usage: parseUsage(value.usage) })
    if (choice.finish_reason === "length") parts.push({ kind: "truncated" })
    else if (typeof choice.finish_reason === "string") parts.push({ kind: "finished" })
    return parts
  }
  if (value.type === "response.output_text.delta" && typeof value.delta === "string") return { kind: "text", value: value.delta }
  if ((value.type === "response.reasoning_summary_text.delta" || value.type === "response.reasoning_text.delta") && typeof value.delta === "string" && value.delta.length > 0) return { kind: "reasoning", value: value.delta }
  if (value.type === "response.function_call_arguments.delta" && typeof value.delta === "string") return { kind: "tool", ...(integer(value.output_index) === undefined ? {} : { index: integer(value.output_index) }), arguments: value.delta }
  if (value.type === "response.output_item.added" && isRecord(value.item) && value.item.type === "function_call" && typeof value.item.name === "string") return { kind: "tool", ...(integer(value.output_index) === undefined ? {} : { index: integer(value.output_index) }), ...(typeof value.item.call_id === "string" && value.item.call_id.length > 0 ? { id: value.item.call_id } : {}), name: value.item.name }
  if (value.type === "response.output_item.done" && isRecord(value.item) && value.item.type === "reasoning") {
    const item = reasoningItemOf(value.item)
    return item === undefined ? undefined : { kind: "reasoning-item", item }
  }
  if (value.type === "response.incomplete" && isRecord(value.response)) {
    const usage = isRecord(value.response.usage) ? parseUsage(value.response.usage) : undefined
    return { kind: "truncated", ...(usage === undefined ? {} : { usage }) }
  }
  if (value.type === "response.completed" && isRecord(value.response)) {
    // The deltas already carried the output, so a summary that repeats none of it only marks the end.
    if (typeof value.response.output_text !== "string" && (!Array.isArray(value.response.output) || value.response.output.length === 0)) {
      const usage = isRecord(value.response.usage) ? parseUsage(value.response.usage) : undefined
      return { kind: "finished", ...(usage === undefined ? {} : { usage }) }
    }
    const parsed = parseOpenAIResponse(value.response)
    return { kind: "final", response: parsed.response, ...(parsed.callId === undefined ? {} : { callId: parsed.callId }), ...(parsed.usage === undefined ? {} : { usage: parsed.usage }) }
  }
  if (isRecord(value.usage)) return { kind: "usage", usage: parseUsage(value.usage) }
  return undefined
}

/** Chat says `finish_reason: "length"`; Responses says `status: "incomplete"`. */
function isTruncatedResponse(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.status === "incomplete") return true
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined
  return isRecord(choice) && choice.finish_reason === "length"
}

function parseOpenAIResponse(value: unknown): { readonly response: NativeModelResponse; readonly text: string; readonly callId?: string; readonly usage?: ProviderModelUsage; readonly reasoningItems: readonly ReasoningItem[] } {
  const parsed = parseOpenAIOutput(value)
  const output = isRecord(value) && Array.isArray(value.output) ? value.output : []
  const reasoningItems = output.flatMap((item): ReasoningItem[] => {
    const sealed = isRecord(item) ? reasoningItemOf(item) : undefined
    return sealed === undefined ? [] : [sealed]
  }).slice(0, MAX_REASONING_ITEMS)
  return { ...parsed, reasoningItems }
}

function parseOpenAIOutput(value: unknown): { readonly response: NativeModelResponse; readonly text: string; readonly callId?: string; readonly usage?: ProviderModelUsage } {
  if (!isRecord(value)) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI response is invalid")
  const usage = isRecord(value.usage) ? parseUsage(value.usage) : undefined
  if (typeof value.output_text === "string") return { response: { type: "text", text: value.output_text }, text: value.output_text, ...(usage === undefined ? {} : { usage }) }
  const choices = value.choices
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const message = isRecord(choices[0].message) ? choices[0].message : undefined
    if (message !== undefined && Array.isArray(message.tool_calls) && isRecord(message.tool_calls[0])) {
      const call = message.tool_calls[0]
      const fn = isRecord(call.function) ? call.function : undefined
      if (fn !== undefined && typeof fn.name === "string" && typeof fn.arguments === "string") {
        let input: unknown
        try { input = JSON.parse(fn.arguments) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI tool arguments are invalid") }
        return { response: { type: "tool", name: fn.name, input }, text: "", ...(typeof call.id === "string" && call.id.length > 0 ? { callId: call.id } : {}), ...(usage === undefined ? {} : { usage }) }
      }
    }
    if (message !== undefined && typeof message.content === "string") return { response: { type: "text", text: message.content }, text: message.content, ...(usage === undefined ? {} : { usage }) }
  }
  const output = value.output
  if (Array.isArray(output)) {
    const textParts: string[] = []
    for (const item of output) {
      if (!isRecord(item)) continue
      if (item.type === "function_call" && typeof item.name === "string" && typeof item.arguments === "string") {
        let input: unknown
        try { input = JSON.parse(item.arguments) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI tool arguments are invalid") }
        return { response: { type: "tool", name: item.name, input }, text: "", ...(typeof item.call_id === "string" && item.call_id.length > 0 ? { callId: item.call_id } : {}), ...(usage === undefined ? {} : { usage }) }
      }
      if (item.type === "message" && Array.isArray(item.content)) for (const block of item.content) if (isRecord(block) && typeof block.text === "string") textParts.push(block.text)
    }
    if (textParts.length > 0) return { response: { type: "text", text: textParts.join("") }, text: textParts.join(""), ...(usage === undefined ? {} : { usage }) }
  }
  throw new ProviderError("PROVIDER_RESPONSE_INVALID", "OpenAI response has no supported output")
}

/** Both OpenAI protocols count cached input inside the input total and report the cached part apart. */
function parseUsage(value: Record<string, unknown>): ProviderModelUsage {
  const inputTokens = integer(value.prompt_tokens ?? value.input_tokens)
  const outputTokens = integer(value.completion_tokens ?? value.output_tokens)
  const totalTokens = integer(value.total_tokens)
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined
  const cacheReadTokens = details === undefined ? undefined : integer(details.cached_tokens)
  return Object.freeze({ ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }), ...(cacheReadTokens === undefined || cacheReadTokens === 0 ? {} : { cacheReadTokens }) })
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

async function resolveSecret(resolver: { resolve: (reference: ProviderModelOptions["credential"]) => string | PromiseLike<string> }, options: { readonly credential: ProviderModelOptions["credential"] }): Promise<string> {
  try {
    const value = await resolver.resolve(options.credential)
    if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024) throw new Error()
    return value
  } catch {
    throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential is unavailable")
  }
}

function validateModelOptions(options: { readonly provider: unknown; readonly model: unknown; readonly credential?: unknown; readonly maxOutputTokens?: unknown; readonly headers?: unknown; readonly onReasoning?: unknown; readonly onNotice?: unknown }): void {
  if (options === null || typeof options !== "object" || typeof options.model !== "string" || options.model.length === 0 || options.model.length > 256 || /[\r\n]/.test(options.model)) throw new ProviderError("PROVIDER_INVALID", "provider model is invalid")
  if (typeof options.provider !== "string" || options.provider === "anthropic") throw new ProviderError("PROVIDER_INVALID", "OpenAI provider kind is invalid")
  if ("apiKey" in (options as object)) throw new ProviderError("PROVIDER_CREDENTIALS", "raw API keys are not accepted")
  if (options.credential === undefined || typeof options.credential !== "object") throw new ProviderError("PROVIDER_CREDENTIALS", "credential reference is required")
  parseCredentialReference(options.credential)
  const maxOutputTokens = options.maxOutputTokens
  if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_000_000)) throw new ProviderError("PROVIDER_INVALID", "provider output limit is invalid")
  if (options.onReasoning !== undefined && typeof options.onReasoning !== "function") throw new ProviderError("PROVIDER_INVALID", "provider reasoning sink is invalid")
  if (options.onNotice !== undefined && typeof options.onNotice !== "function") throw new ProviderError("PROVIDER_INVALID", "provider notice sink is invalid")
  validateHeaders(options.headers)
}

function validateHeaders(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || Object.keys(value).length > 32) throw new ProviderError("PROVIDER_INVALID", "provider headers are invalid")
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.length > 4_096 || /[\r\n]/.test(entry) || ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie", "set-cookie"].includes(name.toLowerCase())) throw new ProviderError("PROVIDER_CREDENTIALS", "authentication headers are controlled by the credential resolver")
  }
}

/** The effort word an OpenAI-style endpoint takes. Levels past high run as high, the top every endpoint knows. */
function thinkingValue(level: ThinkingLevel | undefined): string {
  return level === "high" || level === "xhigh" || level === "max" || level === "ultra" ? "high" : level === "medium" ? "medium" : level === "low" ? "low" : "minimal"
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw new ProviderError("PROVIDER_RESPONSE_INVALID", "provider response is not valid JSON") }
}

async function collectStream(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of source) { bytes += chunk.byteLength; chunks.push(chunk) }
  const result = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
