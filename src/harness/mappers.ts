import { agentError, isAgentEvent, type AgentEvent, type AgentSessionSnapshot } from "@nifrajs/agent-protocol"
import { claudeApiRetry } from "./api-retry.ts"
import { mapClaudeTask } from "./claude-tasks.ts"
import { isMessageMark } from "./launch.ts"
import { eventText, eventTextPieces } from "./event-text.ts"
import { claudePlanLimits } from "./plan-limits.ts"
import { harnessRateLimitMessage } from "./rate-limit.ts"
import { oneLine } from "./review.ts"
import { boundToolInput } from "./tool-input.ts"
import type { RunrailLiveFrameInput } from "../live/types.ts"
import { mappedEvents, type HarnessEventMapper, type HarnessEventMappingContext, type HarnessMetadataEvent } from "./types.ts"

const CONTEXT_USED = "context:used"
const CONTEXT_MODEL = "context:model"

export const mapCodexEvent: HarnessEventMapper = (value, context) => {
  if (isAgentEvent(value)) return value
  const record = object(value)
  bindVendorSession(context, record.thread_id, "Codex")
  const type = stringValue(record.type)
  const seq = context.nextSeq
  const turnId = stringValue(record.turn_id) ?? stringValue(record.turnId) ?? context.turnId ?? "turn"
  if (type !== "rate_limit_event") {
    const limitMessage = harnessRateLimitMessage(record, "Codex")
    if (limitMessage !== undefined) return failed(context, seq, "HARNESS_RATE_LIMITED", limitMessage)
  }
  if (type === "thread.started" || type === "session.started") return started(context, seq)
  if (type === "turn.started") return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "turn.started", turnId, prompt: promptText(record.prompt ?? record.input, "turn") })
  if (type === "item.started" || type === "item.updated" || type === "item.completed") return mapCodexItem(record, type === "item.completed", context, seq, turnId)
  if (type === "turn.completed" || type === "thread.completed" || type === "result") {
    if (isObject(record.usage)) emitUsage(context, seq, turnId, record)
    return completed(context, seq)
  }
  if (type === "turn.interrupted" || type === "turn.cancelled") return stopped(context, seq, "interrupted")
  if (type === "turn.failed" || type === "error" || type === "failure") return failed(context, seq, isHarnessAuthenticationFailure(record) ? "HARNESS_AUTH_FAILED" : "HARNESS_FAILED", vendorFailure(record))
  if (type === "rate_limit_event") {
    emitRateLimit(context, seq, turnId, record)
    const limitMessage = harnessRateLimitMessage(record, "Codex")
    return limitMessage === undefined ? undefined : failed(context, seq, "HARNESS_RATE_LIMITED", limitMessage)
  }
  if (type === "usage") {
    emitUsage(context, seq, turnId, record)
    return undefined
  }
  if (type === "approval.required" || type === "permission_request" || type === "tool_permission_request") return approval(context, seq, turnId, record)
  if (context.tolerateUnknown === true) return undefined
  throw new Error("unsupported Codex event")
}

export const mapClaudeCodeEvent: HarnessEventMapper = (value, context) => {
  if (isAgentEvent(value)) return value
  const record = object(value)
  const result = mapClaudeRecord(record, context)
  const parentCallId = stringValue(record.parent_tool_use_id)
  if (parentCallId !== undefined) {
    for (const event of mappedEvents(result)) {
      if (event.type === "tool.started" || event.type === "tool.completed") {
        if (event.callId !== parentCallId) emitLive(context, { type: "lineage", parentCallId, callId: event.callId })
      } else emitLive(context, { type: "lineage", parentCallId, eventSeq: event.seq })
    }
  }
  return result
}

function mapClaudeRecord(record: Record<string, unknown>, context: HarnessEventMappingContext): AgentEvent | readonly AgentEvent[] | undefined {
  bindVendorSession(context, record.session_id, "Claude Code")
  const type = stringValue(record.type)
  const seq = context.nextSeq
  const turnId = stringValue(record.turn_id) ?? stringValue(record.parent_tool_use_id) ?? context.turnId ?? "turn"
  const limitMessage = harnessRateLimitMessage(record, "Claude Code")
  if (limitMessage !== undefined) {
    if (type === "rate_limit_event") {
      emitRateLimit(context, seq, turnId, record)
      const limits = claudePlanLimits(record.rate_limit_info)
      if (limits !== undefined) emitLive(context, limits)
    }
    return failed(context, seq, "HARNESS_RATE_LIMITED", limitMessage)
  }
  if (type === "system" || type === "session.started") {
    if (record.subtype === "error") return failed(context, seq, "HARNESS_FAILED", vendorFailure(record))
    // A refused key or sign-in is retried for over a minute without changing the answer.
    if (record.subtype === "api_retry" && record.error === "authentication_failed") return failed(context, seq, "HARNESS_AUTH_FAILED")
    if (record.subtype === "api_retry") {
      const retry = claudeApiRetry(record, turnId)
      if (retry !== undefined) emitLive(context, retry)
      return undefined
    }
    if (mapClaudeTask(record, context)) return undefined
    if (record.subtype === "compact_boundary") return claudeCompacted(context, seq, record)
    // Claude Code also reports hooks and status as `system` records; only `init` opens a session.
    if (type === "system" && record.subtype !== undefined && record.subtype !== "init") return undefined
    return started(context, seq)
  }
  // Claude Code names each message of its conversation; a rewind can continue from the last one a turn left.
  // A subagent's messages are its own conversation's, so only the main one's are kept.
  if ((type === "assistant" || type === "user") && record.parent_tool_use_id == null && isMessageMark(record.uuid)) context.vendorMessageId = record.uuid
  if (type === "assistant") return mapClaudeAssistant(record, context, seq, turnId)
  if (type === "tool_use" || type === "tool.started") return toolStarted(context, seq, turnId, record)
  if (type === "tool_result" || type === "tool.completed") return toolCompleted(context, seq, turnId, record)
  if (type === "message_start" || type === "turn.started") return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "turn.started", turnId, prompt: promptText(record.prompt, "") })
  if (type === "result" || type === "session.completed") {
    emitClaudeContextWindow(record, context, turnId)
    if (record.subtype === "cancelled" || record.subtype === "canceled" || record.stop_reason === "cancelled" || record.stop_reason === "canceled") return stopped(context, seq, "cancelled")
    if (isObject(record.usage)) emitUsage(context, seq, turnId, record)
    return record.is_error === true || record.subtype === "error" ? failed(context, seq, isHarnessAuthenticationFailure(record) ? "HARNESS_AUTH_FAILED" : "HARNESS_FAILED", claudeResultFailure(record)) : completed(context, seq)
  }
  if (type === "error" || type === "failure") return failed(context, seq, isHarnessAuthenticationFailure(record) ? "HARNESS_AUTH_FAILED" : "HARNESS_FAILED", vendorFailure(record))
  if (type === "approval.required" || type === "permission_request" || type === "tool_permission_request") return approval(context, seq, turnId, record)
  if (type === "stream_event") return mapClaudeStreamEvent(record, context, seq, turnId)
  if (type === "rate_limit_event") {
    emitRateLimit(context, seq, turnId, record)
    const limits = claudePlanLimits(record.rate_limit_info)
    if (limits !== undefined) emitLive(context, limits)
    return undefined
  }
  if (type === "message_start" || type === "message_delta" || type === "message_stop") {
    if (type === "message_start" || type === "message_delta") emitUsage(context, seq, turnId, record)
    return undefined
  }
  if (type === "user") return mapClaudeUser(record, context, seq, turnId)
  if (context.tolerateUnknown === true) return undefined
  throw new Error("unsupported Claude Code event")
}

function mapCodexItem(record: Record<string, unknown>, completedItem: boolean, context: HarnessEventMappingContext, seq: number, turnId: string): AgentEvent | readonly AgentEvent[] | undefined {
  const item = isObject(record.item) ? record.item : record
  const itemType = stringValue(item.type) ?? "item"
  const name = stringValue(item.name) ?? stringValue(item.command) ?? itemType
  if (itemType === "reasoning") {
    emitReasoning(context, seq, turnId, item)
    if (completedItem) {
      const text = reasoningText(item)
      const itemId = stringValue(item.id)
      emitLive(context, { type: "reasoning.completed", turnId, ...(itemId === undefined ? {} : { itemId }), ...(text === undefined ? {} : { text }) })
    }
    return undefined
  }
  if (itemType === "context_usage") {
    emitUsage(context, seq, turnId, item)
    return undefined
  }
  if (itemType === "compaction") {
    emitCompaction(context, seq, turnId, item)
    return undefined
  }
  if (itemType === "rate_limit") {
    emitRateLimit(context, seq, turnId, item)
    return undefined
  }
  if (itemType === "agent_message" || itemType === "assistant_message" || typeof item.text === "string") {
    const text = item.text ?? item.message
    return textEvents(context, seq, turnId, completedItem ? "assistant.message" : "assistant.delta", typeof text === "string" ? text : "")
  }
  if (completedItem) return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "tool.completed", turnId, callId: stringValue(item.id) ?? `call-${seq}`, name, ok: item.status !== "failed" && item.ok !== false && !nonzeroExit(item), ...(item.error === undefined && !nonzeroExit(item) ? {} : { error: agentError("HARNESS_TOOL_FAILED", codexItemFailure(item)) }) })
  const input = boundToolInput(item)
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "tool.started", turnId, callId: stringValue(item.id) ?? `call-${seq}`, name, ...(input === undefined ? {} : { input }) })
}

function mapClaudeAssistant(record: Record<string, unknown>, context: HarnessEventMappingContext, seq: number, turnId: string): AgentEvent | readonly AgentEvent[] | undefined {
  const message = isObject(record.message) ? record.message : record
  if (record.parent_tool_use_id === undefined || record.parent_tool_use_id === null) emitClaudeContext(message, context, turnId)
  const content = message.content
  if (!Array.isArray(content)) throw new Error("Claude Code assistant content is invalid")
  const events: AgentEvent[] = []
  for (const block of content) {
    if (!isObject(block)) continue
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
      const parentCallId = stringValue(record.parent_tool_use_id)
      emitLive(context, { type: "reasoning.completed", turnId, ...(parentCallId === undefined ? {} : { parentCallId }), text: block.thinking })
      continue
    }
    if (block.type === "text" && typeof block.text === "string") events.push(...mappedEvents(textEvents(context, seq + events.length, turnId, "assistant.message", block.text)))
    else if (block.type === "tool_use") events.push(toolStarted(context, seq + events.length, turnId, block))
  }
  return events.length === 0 ? undefined : events.length === 1 ? events[0] : Object.freeze(events)
}

function mapClaudeStreamEvent(record: Record<string, unknown>, context: HarnessEventMappingContext, seq: number, turnId: string): AgentEvent | readonly AgentEvent[] | undefined {
  const event = isObject(record.event) ? record.event : record
  const type = stringValue(event.type)
  // A tool call is reported once, by the `assistant` record that carries its whole input.
  if (type !== "content_block_delta" || !isObject(event.delta)) return undefined
  if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
    const parentCallId = stringValue(record.parent_tool_use_id)
    if (event.delta.thinking.length > 0) emitLive(context, { type: "reasoning.delta", turnId, ...(parentCallId === undefined ? {} : { parentCallId }), text: event.delta.thinking })
    return undefined
  }
  if (typeof event.delta.text !== "string") return undefined
  return textEvents(context, seq, turnId, "assistant.delta", event.delta.text)
}

/** A reply longer than one event's text travels as consecutive events, numbered from `seq`. */
function textEvents(context: HarnessEventMappingContext, seq: number, turnId: string, type: "assistant.message" | "assistant.delta", text: string): AgentEvent | readonly AgentEvent[] {
  const events = eventTextPieces(text).map((piece, index): AgentEvent => Object.freeze({ version: 1, sessionId: context.sessionId, seq: seq + index, at: Date.now(), type, turnId, text: piece }))
  const [first] = events
  return events.length === 1 && first !== undefined ? first : Object.freeze(events)
}

function promptText(value: unknown, fallback: string): string {
  return typeof value === "string" ? eventText(value) : fallback
}

function mapClaudeUser(record: Record<string, unknown>, context: HarnessEventMappingContext, seq: number, turnId: string): AgentEvent | readonly AgentEvent[] | undefined {
  const message = isObject(record.message) ? record.message : record
  if (!Array.isArray(message.content)) return undefined
  const events: AgentEvent[] = []
  for (const block of message.content) {
    if (isObject(block) && block.type === "tool_result") events.push(toolCompleted(context, seq + events.length, turnId, block))
  }
  return events.length === 0 ? undefined : events.length === 1 ? events[0] : Object.freeze(events)
}

/** Claude Code summarized the conversation: on its own near a full context, or when asked. */
function claudeCompacted(context: HarnessEventMappingContext, seq: number, record: Record<string, unknown>): AgentEvent {
  const metadata = isObject(record.compact_metadata) ? record.compact_metadata : {}
  const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000 ? value : 0)
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "memory.compacted", before: count(metadata.pre_tokens), after: count(metadata.post_tokens), reason: metadata.trigger === "auto" ? "threshold" : "manual" })
}

function started(context: HarnessEventMappingContext, seq: number): AgentEvent {
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "session.started", snapshot: snapshot(context, "idle", seq) })
}

function completed(context: HarnessEventMappingContext, seq: number): AgentEvent {
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "session.completed", snapshot: snapshot(context, "completed", seq) })
}

function stopped(context: HarnessEventMappingContext, seq: number, reason: string): AgentEvent {
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "session.stopped", reason })
}

function failed(context: HarnessEventMappingContext, seq: number, code: "HARNESS_FAILED" | "HARNESS_AUTH_FAILED" | "HARNESS_RATE_LIMITED" = "HARNESS_FAILED", message?: string): AgentEvent {
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "session.failed", error: agentError(code, message ?? (code === "HARNESS_AUTH_FAILED" ? "harness authentication failed" : "harness reported a failure")), recoverable: false })
}

/** The vendor's own words for a failure, when it gives them as plain text. */
function vendorFailure(record: Record<string, unknown>): string | undefined {
  const error = isObject(record.error) ? record.error : undefined
  const text = [record.message, error?.message, record.error].find((value): value is string => typeof value === "string" && value.trim().length > 0)
  // eslint-disable-next-line no-control-regex
  return text === undefined ? undefined : text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500)
}

const CLAUDE_RESULT_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  error_max_turns: "Claude Code stopped at its turn limit",
  error_max_budget_usd: "Claude Code reached its spending limit",
  error_max_structured_output_retries: "Claude Code could not produce the structured output",
  error_during_execution: "Claude Code failed while running",
})

/** A failed Claude result carries its words in `result` or `errors`; otherwise the subtype names it. */
function claudeResultFailure(record: Record<string, unknown>): string | undefined {
  const errors = Array.isArray(record.errors) ? record.errors.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : []
  const subtype = typeof record.subtype === "string" ? CLAUDE_RESULT_FAILURES[record.subtype] : undefined
  const words = vendorFailure({ message: typeof record.result === "string" && record.result.trim().length > 0 ? record.result : errors.join("; ") })
  return subtype === undefined ? words : words === undefined ? subtype : `${subtype}: ${words}`.slice(0, 500)
}

function approval(context: HarnessEventMappingContext, seq: number, turnId: string, record: Record<string, unknown>): AgentEvent {
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "approval.required", turnId, approvalId: stringValue(record.approval_id) ?? `approval-${seq}`, action: boundedText(record.action, "harness action"), capability: boundedText(record.capability, "process.exec") })
}

const MAX_REMEMBERED_TOOL_CALLS = 4_096

function toolStarted(context: HarnessEventMappingContext, seq: number, turnId: string, record: Record<string, unknown>): AgentEvent {
  const input = record.input === undefined ? undefined : boundToolInput(record.input)
  const callId = stringValue(record.id) ?? stringValue(record.call_id) ?? `call-${seq}`
  const name = stringValue(record.name) ?? stringValue(record.tool_name) ?? "harness_tool"
  if (context.turnState !== undefined && context.turnState.size < MAX_REMEMBERED_TOOL_CALLS) context.turnState.set(`tool:${callId}`, name)
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "tool.started", turnId, callId, name, ...(input === undefined ? {} : { input }) })
}

function toolCompleted(context: HarnessEventMappingContext, seq: number, turnId: string, record: Record<string, unknown>): AgentEvent {
  // A Claude tool result names its call in `tool_use_id` and does not repeat the tool name.
  const callId = stringValue(record.tool_use_id) ?? stringValue(record.id) ?? stringValue(record.call_id) ?? `call-${seq}`
  const remembered = context.turnState?.get(`tool:${callId}`)
  const name = stringValue(record.name) ?? stringValue(record.tool_name) ?? (typeof remembered === "string" ? remembered : "harness_tool")
  const reason = record.is_error === true ? toolFailure(record.content) : undefined
  return Object.freeze({ version: 1, sessionId: context.sessionId, seq, at: Date.now(), type: "tool.completed", turnId, callId, name, ok: record.is_error !== true && record.ok !== false, ...(reason === undefined ? {} : { error: agentError("HARNESS_TOOL_FAILED", reason) }) })
}

const MAX_TOOL_FAILURE_CHARS = 300

/** Why Claude Code refused or failed a call, as one short line: a failed command's result holds its output, so only its start is kept. */
function toolFailure(content: unknown): string | undefined {
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.slice(0, 8).map((block) => (isObject(block) && block.type === "text" ? block.text : undefined)) : []
  const text = parts.filter((part): part is string => typeof part === "string").map((part) => part.slice(0, 4 * MAX_TOOL_FAILURE_CHARS)).join(" ")
  return oneLine(text.replace(/<\/?tool_use_error>/g, " "), MAX_TOOL_FAILURE_CHARS)
}

function emitUsage(context: HarnessEventMappingContext, seq: number, turnId: string, record: Record<string, unknown>): void {
  const source = nestedUsage(record)
  emitMetadata(context, {
    version: 1,
    sessionId: context.sessionId,
    seq,
    kind: "usage",
    turnId,
    ...optionalNumber("inputTokens", numberValue(source, ["input_tokens", "inputTokens"], 20_000_000)),
    ...optionalNumber("outputTokens", numberValue(source, ["output_tokens", "outputTokens"], 20_000_000)),
    ...optionalNumber("totalTokens", numberValue(source, ["total_tokens", "totalTokens"], 20_000_000)),
    ...optionalNumber("cacheReadTokens", numberValue(source, ["cache_read_tokens", "cache_read_input_tokens", "cached_input_tokens", "cacheReadTokens"], 20_000_000)),
    ...optionalNumber("cacheWriteTokens", numberValue(source, ["cache_write_tokens", "cache_creation_input_tokens", "cacheWriteTokens"], 20_000_000)),
  })
}

/**
 * How full the main agent's context is: each model request's prompt (fresh, cached, and written
 * to cache) plus its answer. A subagent's messages are its own context and are left out. The
 * window is only known from the turn's result, so it follows there.
 */
function emitClaudeContext(message: Record<string, unknown>, context: HarnessEventMappingContext, turnId: string): void {
  if (!isObject(message.usage)) return
  const parts = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].map((key) => numberValue(message.usage as Record<string, unknown>, [key], 20_000_000) ?? 0)
  const used = parts.reduce((total, part) => total + part, 0)
  if (used <= 0 || used > 20_000_000 || context.turnState?.get(CONTEXT_USED) === used) return
  context.turnState?.set(CONTEXT_USED, used)
  if (typeof message.model === "string") context.turnState?.set(CONTEXT_MODEL, message.model)
  emitLive(context, { type: "context.usage", turnId, usedTokens: used, estimated: false })
}

/** Claude Code's result names each model's context window under `modelUsage`. */
function emitClaudeContextWindow(record: Record<string, unknown>, context: HarnessEventMappingContext, turnId: string): void {
  const used = context.turnState?.get(CONTEXT_USED)
  if (typeof used !== "number" || !isObject(record.modelUsage)) return
  const usage = record.modelUsage
  const model = context.turnState?.get(CONTEXT_MODEL)
  const windowOf = (entry: unknown): number | undefined => (isObject(entry) ? numberValue(entry, ["contextWindow"], 20_000_000) : undefined)
  const named = typeof model === "string" ? windowOf(usage[model]) : undefined
  const windowTokens = named ?? Math.max(0, ...Object.values(usage).map((entry) => windowOf(entry) ?? 0))
  if (windowTokens > 0) emitLive(context, { type: "context.usage", turnId, usedTokens: used, windowTokens, estimated: false })
}

function emitRateLimit(context: HarnessEventMappingContext, seq: number, turnId: string, record: Record<string, unknown>): void {
  const source = isObject(record.rate_limit) ? record.rate_limit : record
  emitMetadata(context, {
    version: 1,
    sessionId: context.sessionId,
    seq,
    kind: "rate-limit",
    turnId,
    ...optionalNumber("retryAfterMs", numberValue(source, ["retry_after_ms", "retryAfterMs"], 86_400_000)),
    ...optionalNumber("remainingRequests", numberValue(source, ["remaining_requests", "remainingRequests"], 20_000_000)),
    ...optionalNumber("resetAt", numberValue(source, ["reset_at", "resetAt"], 10_000_000_000_000)),
  })
}

function emitReasoning(context: HarnessEventMappingContext, seq: number, turnId: string, record: Record<string, unknown>): void {
  const level = stringValue(record.level) ?? stringValue(record.effort) ?? stringValue(record.reasoning_level)
  emitMetadata(context, {
    version: 1,
    sessionId: context.sessionId,
    seq,
    kind: "reasoning",
    turnId,
    ...(level === undefined ? {} : { level }),
    ...optionalNumber("durationMs", numberValue(record, ["duration_ms", "durationMs"], 86_400_000)),
  })
}

function emitCompaction(context: HarnessEventMappingContext, seq: number, turnId: string, record: Record<string, unknown>): void {
  emitMetadata(context, {
    version: 1,
    sessionId: context.sessionId,
    seq,
    kind: "compaction",
    turnId,
    ...optionalNumber("before", numberValue(record, ["before", "before_tokens"], 20_000_000)),
    ...optionalNumber("after", numberValue(record, ["after", "after_tokens"], 20_000_000)),
  })
}

/** Live frames are best-effort presentation; a failing sink never fails the harness turn. */
export function emitLive(context: Pick<HarnessEventMappingContext, "onLive">, frame: RunrailLiveFrameInput): void {
  if (context.onLive === undefined) return
  try {
    context.onLive(frame)
  } catch {
    // Dropped intentionally.
  }
}

/** Reasoning text from a Codex reasoning item (`text`, `summary[]`, or `content[]`). */
export function reasoningText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string" && item.text.length > 0) return item.text
  const parts = (Array.isArray(item.summary) && item.summary.length > 0 ? item.summary : Array.isArray(item.content) ? item.content : [])
    .map((part) => typeof part === "string" ? part : isObject(part) && typeof part.text === "string" ? part.text : "")
    .filter((part) => part.length > 0)
  return parts.length === 0 ? undefined : parts.join("\n\n")
}

function emitMetadata(context: HarnessEventMappingContext, event: HarnessMetadataEvent): void {
  if (context.onMetadata === undefined) return
  try {
    context.onMetadata(Object.freeze(event))
  } catch {
    throw new Error("harness metadata sink failed")
  }
}

function nestedUsage(record: Record<string, unknown>): Record<string, unknown> {
  if (isObject(record.usage)) return record.usage
  if (isObject(record.message) && isObject(record.message.usage)) return record.message.usage
  if (isObject(record.event) && isObject(record.event.usage)) return record.event.usage
  return record
}

function numberValue(record: Record<string, unknown>, keys: readonly string[], max: number): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) continue
    if ((key.includes("token") || key.includes("request")) && !Number.isSafeInteger(value)) continue
    return value
  }
  return undefined
}

function optionalNumber(name: string, value: number | undefined): Record<string, number> {
  return value === undefined ? {} : { [name]: value }
}

/** A snapshot an event carries names that event as the session's last, as the agent protocol checks. */
export function stampEventSnapshot(payload: Record<string, unknown>, seq: number): Record<string, unknown> {
  const carried = payload.snapshot
  if (!isObject(carried)) return payload
  return { ...payload, snapshot: Object.freeze({ ...carried, lastSeq: seq }) }
}

function snapshot(context: HarnessEventMappingContext, status: AgentSessionSnapshot["status"], seq: number): AgentSessionSnapshot {
  return Object.freeze({ ...context.previous, status, lastSeq: seq, updatedAt: Date.now(), activeTurnId: undefined })
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("harness event is not an object")
  return value
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined }
function boundedText(value: unknown, fallback: string): string { return typeof value === "string" && value.length <= 256 * 1024 ? value : fallback }

function bindVendorSession(context: HarnessEventMappingContext, value: unknown, harness: string): void {
  if (value === undefined) return
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) throw new Error(`${harness} vendor session is invalid`)
  if (context.vendorSessionId !== undefined && context.vendorSessionId !== value) throw new Error(`${harness} vendor session does not match`)
  context.vendorSessionId = value
}

function isHarnessAuthenticationFailure(record: Record<string, unknown>): boolean {
  return record.is_error === true && [record.result, record.error, record.message, record.subtype].some((value) => authenticationText(value))
}

function authenticationText(value: unknown): boolean {
  if (typeof value === "string") return /not\s+(?:logged\s+in|authenticated)|authentication\s+(?:failed|required)|unauthori[sz]ed|login\s+required|sign\s+in|api\s+key|credential|subscription\s+(?:required|expired|inactive)|oauth\s+session\s+expired|session\s+expired|could\s+not\s+be\s+refreshed/i.test(value)
  if (!isObject(value)) return false
  return authenticationText(value.message) || authenticationText(value.error)
}

/** A command that ended with a failing exit code failed, whatever its lifecycle status says. */
/** Codex's own words for a failed item, else its exit code. */
function codexItemFailure(item: Record<string, unknown>): string {
  const error = isObject(item.error) ? item.error.message : item.error
  const code = item.exit_code ?? item.exitCode
  return oneLine(error, MAX_TOOL_FAILURE_CHARS) ?? (nonzeroExit(item) ? `Exited with code ${String(code)}` : "harness tool failed")
}

function nonzeroExit(item: Record<string, unknown>): boolean {
  const code = item.exit_code ?? item.exitCode
  return typeof code === "number" && Number.isSafeInteger(code) && code !== 0
}
