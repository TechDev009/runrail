import type { AgentEvent } from "@nifrajs/agent-protocol"
import { isThinkingLevel } from "../model/catalog.ts"
import { describeToolCall } from "../tools/presentation.ts"
import { redactCommandText } from "../background/redact.ts"
import { planModelName } from "../harness/plan-limits.ts"
import { apiRetryFrame } from "../harness/api-retry.ts"
import { reviewFrame } from "../harness/review.ts"
import type { RunrailBackgroundControl, RunrailBackgroundEntry, RunrailBackgroundStateFrame, RunrailLiveFrame, RunrailLiveFrameInput, RunrailLiveSink, RunrailPlanLimitWindowId, RunrailPlanStep } from "./types.ts"

const MAX_ID = 256
const MAX_TITLE = 160
const MAX_TEXT_BYTES = 16 * 1024
const MAX_EXPLANATION_BYTES = 2 * 1024
const MAX_STEPS = 64
const MAX_STEP_TEXT = 1_024
const MAX_REFUSAL_BYTES = 1_024
const MAX_TRACKED_CALLS = 1_024
/** Four named Claude Code windows and up to eight of one model's own. */
const MAX_LIMIT_WINDOWS = 12
/** A month; no plan window is longer. */
const MAX_WINDOW_MINUTES = 44_640
const PLAN_WINDOW_IDS: ReadonlySet<string> = new Set<RunrailPlanLimitWindowId>(["five-hour", "weekly", "weekly-opus", "weekly-sonnet", "weekly-model", "primary", "secondary"])
const PLAN_NAME = /^[a-z0-9_-]{1,40}$/
/** Finished entries go first past this; running ones only past the hard limit. */
const MAX_BACKGROUND = 32
const MAX_BACKGROUND_HARD = 64
const MAX_BACKGROUND_LABEL = 200
const MAX_BACKGROUND_DETAIL = 500
const BACKGROUND_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed", "stopped", "unknown"])
const DEFAULT_MAX_FRAMES = 4_096
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

export class LiveFrameCursorError extends Error {
  readonly code = "CONTROL_LIVE_CURSOR_EXPIRED"
  constructor() {
    super("live frame cursor has expired")
    this.name = "LiveFrameCursorError"
  }
}

export interface LiveFrameHubOptions {
  readonly sessionId?: string
  readonly maxFrames?: number
  readonly maxBytes?: number
}

/**
 * Bounded in-memory ring of live frames. Harnesses push frames through `sink`; observed
 * AgentEvents derive plan and subagent frames from tool calls. Nothing here is persisted.
 */
export class LiveFrameHub {
  readonly sink: RunrailLiveSink
  private readonly frames: { readonly frame: RunrailLiveFrame; readonly bytes: number }[] = []
  /** Frames before this index are dropped; they are cut away in a batch, since `shift` on a long ring is linear. */
  private head = 0
  private readonly listeners = new Set<(frame: RunrailLiveFrame) => void>()
  private readonly agentCalls = new Set<string>()
  private readonly detachedAgentCalls = new Set<string>()
  private readonly parents = new Map<string, string>()
  private readonly background = new Map<string, RunrailBackgroundEntry>()
  private readonly controls = new Map<string, RunrailBackgroundControl>()
  private readonly maxFrames: number
  private readonly maxBytes: number
  private sessionId: string
  private nextLiveSeq = 1
  private lastEventSeq = 0
  private activeTurnId: string | undefined
  private bytes = 0

  constructor(options: LiveFrameHubOptions = {}) {
    this.sessionId = options.sessionId ?? ""
    this.maxFrames = boundedLimit(options.maxFrames, DEFAULT_MAX_FRAMES, 65_536)
    this.maxBytes = boundedLimit(options.maxBytes, DEFAULT_MAX_BYTES, 256 * 1024 * 1024)
    this.sink = (input) => {
      try {
        this.emit(input)
      } catch {
        // Live frames are best-effort presentation; they never fail a harness turn.
      }
    }
  }

  get lastLiveSeq(): number {
    return this.nextLiveSeq - 1
  }

  bind(sessionId: string): void {
    if (typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= MAX_ID) this.sessionId = sessionId
  }

  subscribe(listener: (frame: RunrailLiveFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Bounded replay after a live cursor. Throws when the cursor fell out of the ring. */
  since(afterLiveSeq = 0, maxFrames = 512): readonly RunrailLiveFrame[] {
    if (!Number.isSafeInteger(afterLiveSeq) || afterLiveSeq < 0) throw new RangeError("live frame cursor is invalid")
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new RangeError("live frame limit is invalid")
    const first = this.frames[this.head]
    if (first !== undefined && afterLiveSeq < first.frame.liveSeq - 1) throw new LiveFrameCursorError()
    // `liveSeq` rises along the ring, so the first frame after the cursor is found by halving.
    let low = this.head
    let high = this.frames.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.frames[middle]!.frame.liveSeq <= afterLiveSeq) low = middle + 1
      else high = middle
    }
    const result: RunrailLiveFrame[] = []
    for (let index = low; index < this.frames.length && result.length < maxFrames; index += 1) result.push(this.frames[index]!.frame)
    return Object.freeze(result)
  }

  /** Oldest live cursor still replayable; used by streams that tolerate gaps. */
  oldestCursor(): number {
    const first = this.frames[this.head]
    return first === undefined ? this.lastLiveSeq : first.frame.liveSeq - 1
  }

  clear(): void {
    this.frames.length = 0
    this.head = 0
    this.bytes = 0
    this.agentCalls.clear()
    this.detachedAgentCalls.clear()
    this.parents.clear()
    this.background.clear()
    this.controls.clear()
    this.activeTurnId = undefined
  }

  /** Every known background entry, oldest first. */
  backgroundEntries(): readonly RunrailBackgroundEntry[] {
    return Object.freeze([...this.background.values()])
  }

  backgroundEntry(id: string): RunrailBackgroundEntry | undefined {
    return this.background.get(id)
  }

  backgroundControl(id: string): RunrailBackgroundControl | undefined {
    return this.controls.get(id)
  }

  /** Track session progress and derive plan and subagent frames from tool calls. */
  observe(event: AgentEvent): void {
    if (event.sessionId !== this.sessionId && event.sessionId.length > 0 && event.sessionId.length <= MAX_ID) {
      // Provider or backend switches start a new session whose event cursor restarts.
      this.sessionId = event.sessionId
      this.lastEventSeq = 0
      this.activeTurnId = undefined
    }
    if (event.seq > this.lastEventSeq) this.lastEventSeq = event.seq
    if (event.type === "turn.started") this.activeTurnId = event.turnId
    if (event.type === "session.completed" || event.type === "session.failed" || event.type === "session.stopped") {
      this.activeTurnId = undefined
      this.endTurnBoundWork()
    }
    if (event.type === "tool.started") {
      const presentation = describeToolCall(event.name, event.input)
      if (presentation.kind === "plan" && presentation.plan !== undefined) {
        const explanation = explanationOf(event.input)
        this.emit({ type: "plan.updated", turnId: event.turnId, callId: event.callId, steps: presentation.plan, ...(explanation === undefined ? {} : { explanation }) })
      } else if (presentation.kind === "agent" && !this.agentCalls.has(event.callId)) {
        this.remember(this.agentCalls, event.callId)
        if (event.name === "collabAgentToolCall" && event.input !== null && typeof event.input === "object" && !Array.isArray(event.input) && (event.input as Record<string, unknown>).tool === "spawnAgent") this.remember(this.detachedAgentCalls, event.callId)
        const parentCallId = this.parents.get(event.callId)
        const agentType = agentTypeOf(event.input)
        this.emit({ type: "agent.spawned", turnId: event.turnId, callId: event.callId, title: agentTitleOf(event.input) ?? presentation.title, ...(parentCallId === undefined ? {} : { parentCallId }), ...(agentType === undefined ? {} : { agentType }) })
      }
    } else if (event.type === "tool.completed" && this.agentCalls.has(event.callId) && (!event.ok || !this.detachedAgentCalls.has(event.callId))) {
      this.agentCalls.delete(event.callId)
      this.emit({ type: "agent.completed", turnId: event.turnId, callId: event.callId, ok: event.ok })
    }
  }

  /** Validate, bound, and publish one frame. Invalid frames are rejected with a RangeError. */
  emit(input: RunrailLiveFrameInput): RunrailLiveFrame {
    const body = input?.type === "background.state" ? this.mergeBackground(input) : normalize(input, this.activeTurnId)
    if (body.type === "agent.completed") {
      this.agentCalls.delete(body.callId)
      this.detachedAgentCalls.delete(body.callId)
      for (const entry of [...this.background.values()]) {
        if (entry.kind === "agent" && entry.callId === body.callId && entry.status === "running") this.emit({ type: "background.state", entry: { id: entry.id, status: body.ok ? "completed" : "failed", endedAt: Date.now() } })
      }
    }
    if (body.type === "lineage" && body.callId !== undefined) this.rememberParent(body.callId, body.parentCallId)
    const frame = Object.freeze({ ...body, version: 1 as const, sessionId: this.sessionId, liveSeq: this.nextLiveSeq, at: Date.now(), afterSeq: this.lastEventSeq }) as RunrailLiveFrame
    this.nextLiveSeq += 1
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8")
    this.frames.push({ frame, bytes })
    this.bytes += bytes
    while (this.frames.length - this.head > this.maxFrames || (this.bytes > this.maxBytes && this.frames.length - this.head > 1)) {
      const dropped = this.frames[this.head]
      this.head += 1
      if (dropped !== undefined) this.bytes -= dropped.bytes
    }
    if (this.head >= 1_024 && this.head * 2 >= this.frames.length) {
      this.frames.splice(0, this.head)
      this.head = 0
    }
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // Observer failure must not interrupt the harness.
      }
    }
    return frame
  }

  private mergeBackground(input: RunrailBackgroundStateFrame): RunrailLiveFrameInput {
    const patch = input.entry
    if (patch === null || typeof patch !== "object") throw new RangeError("background entry is invalid")
    const id = requiredId(patch.id)
    const previous = this.background.get(id)
    const kind = patch.kind ?? previous?.kind
    const label = patch.label === undefined ? previous?.label : redactCommandText(String(patch.label), MAX_BACKGROUND_LABEL)
    if ((kind !== "agent" && kind !== "command") || label === undefined || label.length === 0) throw new RangeError("background entry needs a kind and a label")
    const status = patch.status === undefined ? previous?.status ?? "running" : patch.status
    if (!BACKGROUND_STATUSES.has(status)) throw new RangeError("background status is invalid")
    const control = input.control === undefined ? this.controls.get(id) : Object.freeze({ ...this.controls.get(id), ...input.control })
    if (control !== undefined) this.controls.set(id, control)
    const detail = patch.detail === undefined ? previous?.detail : redactCommandText(String(patch.detail), MAX_BACKGROUND_DETAIL)
    const pick = <K extends keyof RunrailBackgroundEntry>(key: K, valid: (value: unknown) => boolean): Partial<Pick<RunrailBackgroundEntry, K>> => {
      const value = patch[key] === undefined ? previous?.[key] : patch[key]
      return value !== undefined && valid(value) ? ({ [key]: value } as Partial<Pick<RunrailBackgroundEntry, K>>) : {}
    }
    const entry: RunrailBackgroundEntry = Object.freeze({
      id,
      kind,
      status,
      label,
      ...(detail === undefined || detail.length === 0 ? {} : { detail }),
      ...pick("agentType", (value) => optionalId(value) !== undefined),
      ...pick("callId", (value) => optionalId(value) !== undefined),
      ...pick("foreground", (value) => typeof value === "boolean"),
      ...pick("startedAt", epochMs),
      ...pick("endedAt", epochMs),
      ...pick("exitCode", (value) => Number.isSafeInteger(value)),
      ...pick("tokens", tokenCount),
      ...pick("toolUses", tokenCount),
      ...pick("durationMs", tokenCount),
      // Stop and output are offered only when a source registered how to do them.
      stoppable: status === "running" && control?.stop !== undefined && patch.stoppable !== false,
      ...(status === "running" && control?.stop === undefined && (patch.stopHint ?? previous?.stopHint) === "turn" ? { stopHint: "turn" as const } : {}),
      hasOutput: control?.output !== undefined && patch.hasOutput !== false,
    })
    this.background.delete(id)
    this.background.set(id, entry)
    this.evictBackground()
    return Object.freeze({ type: "background.state", entry })
  }

  /** Work that lives only as long as its turn (a print-mode Claude Code process) ends with it. */
  private endTurnBoundWork(): void {
    for (const entry of [...this.background.values()]) {
      if (entry.status === "running" && entry.stopHint === "turn") this.emit({ type: "background.state", entry: { id: entry.id, status: "stopped", endedAt: Date.now(), detail: "Ended with its turn" } })
    }
  }

  private evictBackground(): void {
    for (const [id, entry] of this.background) {
      if (this.background.size <= MAX_BACKGROUND) return
      if (entry.status === "running") continue
      this.background.delete(id)
      this.controls.delete(id)
    }
    for (const id of this.background.keys()) {
      if (this.background.size <= MAX_BACKGROUND_HARD) return
      this.background.delete(id)
      this.controls.delete(id)
    }
  }

  private rememberParent(callId: string, parentCallId: string): void {
    if (this.parents.size >= MAX_TRACKED_CALLS) {
      const oldest = this.parents.keys().next().value
      if (oldest !== undefined) this.parents.delete(oldest)
    }
    this.parents.set(callId, parentCallId)
  }

  private remember(set: Set<string>, value: string): void {
    if (set.size >= MAX_TRACKED_CALLS) {
      const oldest = set.values().next().value
      if (oldest !== undefined) set.delete(oldest)
    }
    set.add(value)
  }
}

function normalize(input: RunrailLiveFrameInput, activeTurnId: string | undefined): RunrailLiveFrameInput {
  if (input === null || typeof input !== "object") throw new RangeError("live frame is invalid")
  const turnId = optionalId(input.type === "lineage" || input.type === "plan.limits" || input.type === "background.state" || input.type === "browser.request" || input.type === "browser.notice" || input.type === "threads.request" || input.type === "computer.request" ? undefined : input.turnId) ?? activeTurnId
  const withTurn = turnId === undefined ? {} : { turnId }
  switch (input.type) {
    case "browser.request": {
      if (typeof input.requestId !== "string" || !/^br-[0-9a-f]{32}$/.test(input.requestId) || typeof input.action !== "string" || !/^[a-z]{1,16}$/.test(input.action)) throw new RangeError("browser request frame is invalid")
      return Object.freeze({ type: input.type, requestId: input.requestId, action: input.action })
    }
    case "threads.request": {
      if (typeof input.requestId !== "string" || !/^tr-[0-9a-f]{32}$/.test(input.requestId) || (input.action !== "list" && input.action !== "read" && input.action !== "send")) throw new RangeError("threads request frame is invalid")
      return Object.freeze({ type: input.type, requestId: input.requestId, action: input.action })
    }
    case "computer.request": {
      if (typeof input.requestId !== "string" || !/^cu-[0-9a-f]{32}$/.test(input.requestId) || typeof input.action !== "string" || !/^[a-z]{1,16}$/.test(input.action)) throw new RangeError("computer request frame is invalid")
      return Object.freeze({ type: input.type, requestId: input.requestId, action: input.action })
    }
    case "browser.notice": {
      if (input.code !== "BROWSER_TOOLS_UNAVAILABLE") throw new RangeError("browser notice frame is invalid")
      return Object.freeze({ type: input.type, code: input.code })
    }
    case "reasoning.delta": {
      const text = clip(input.text, MAX_TEXT_BYTES)
      if (text === undefined || text.length === 0) throw new RangeError("reasoning delta is invalid")
      const itemId = optionalId(input.itemId)
      const parentCallId = optionalId(input.parentCallId)
      return Object.freeze({ type: input.type, ...withTurn, ...(parentCallId === undefined ? {} : { parentCallId }), ...(itemId === undefined ? {} : { itemId }), text })
    }
    case "reasoning.completed": {
      const itemId = optionalId(input.itemId)
      const parentCallId = optionalId(input.parentCallId)
      const text = input.text === undefined ? undefined : clip(input.text, MAX_TEXT_BYTES)
      return Object.freeze({ type: input.type, ...withTurn, ...(parentCallId === undefined ? {} : { parentCallId }), ...(itemId === undefined ? {} : { itemId }), ...(text === undefined || text.length === 0 ? {} : { text }) })
    }
    case "plan.updated": {
      if (!Array.isArray(input.steps)) throw new RangeError("plan steps are invalid")
      const steps: RunrailPlanStep[] = []
      for (const step of input.steps.slice(0, MAX_STEPS)) {
        if (step === null || typeof step !== "object") continue
        const text = clip(step.text, MAX_STEP_TEXT)?.trim()
        if (text === undefined || text.length === 0) continue
        steps.push(Object.freeze({ text, status: step.status === "completed" || step.status === "in_progress" ? step.status : "pending" }))
      }
      const callId = optionalId(input.callId)
      const explanation = input.explanation === undefined ? undefined : clip(input.explanation, MAX_EXPLANATION_BYTES)
      return Object.freeze({ type: input.type, ...withTurn, ...(callId === undefined ? {} : { callId }), ...(explanation === undefined || explanation.length === 0 ? {} : { explanation }), steps: Object.freeze(steps) })
    }
    case "agent.spawned": {
      const callId = requiredId(input.callId)
      const parentCallId = optionalId(input.parentCallId)
      const agentType = optionalId(input.agentType)
      const title = oneLine(input.title) ?? "Agent"
      return Object.freeze({ type: input.type, ...withTurn, callId, title, ...(parentCallId === undefined ? {} : { parentCallId }), ...(agentType === undefined ? {} : { agentType }) })
    }
    case "agent.completed":
      return Object.freeze({ type: input.type, ...withTurn, callId: requiredId(input.callId), ok: input.ok === true })
    case "lineage": {
      const parentCallId = requiredId(input.parentCallId)
      const callId = optionalId(input.callId)
      const eventSeq = Number.isSafeInteger(input.eventSeq) && (input.eventSeq ?? -1) >= 0 ? input.eventSeq : undefined
      if (callId === undefined && eventSeq === undefined) throw new RangeError("lineage frame needs a call or event")
      if (callId === parentCallId) throw new RangeError("lineage frame is circular")
      return Object.freeze({ type: input.type, parentCallId, ...(callId === undefined ? {} : { callId }), ...(eventSeq === undefined ? {} : { eventSeq }) })
    }
    case "approval.reviewed":
    case "reviewer.notice": {
      const frame = reviewFrame(input)
      if (frame === undefined || frame.type !== input.type) throw new RangeError("review frame is invalid")
      return Object.freeze({ ...frame, ...withTurn })
    }
    case "api.retry": {
      const frame = apiRetryFrame(input)
      if (frame === undefined) throw new RangeError("retry frame is invalid")
      return Object.freeze({ ...frame, ...withTurn })
    }
    case "model.notice":
      if (input.code !== "THINKING_REFUSED" || !isThinkingLevel(input.thinking)) throw new RangeError("model notice is invalid")
      return Object.freeze({ type: input.type, ...withTurn, code: input.code, thinking: input.thinking })
    case "request.refused": {
      const message = typeof input.message === "string" ? clip(input.message.replace(/\s+/g, " ").trim(), MAX_REFUSAL_BYTES) : undefined
      if ((input.source !== "codex" && input.source !== "claude-code") || message === undefined || message.length === 0) throw new RangeError("refused request frame is invalid")
      return Object.freeze({ type: input.type, ...withTurn, source: input.source, message })
    }
    case "context.usage": {
      if (!tokenCount(input.usedTokens)) throw new RangeError("context usage is invalid")
      const windowTokens = tokenCount(input.windowTokens) && input.windowTokens > 0 ? input.windowTokens : undefined
      const autoCompactAt = tokenCount(input.autoCompactAt) && input.autoCompactAt > 0 ? input.autoCompactAt : undefined
      return Object.freeze({ type: input.type, ...withTurn, usedTokens: input.usedTokens, ...(windowTokens === undefined ? {} : { windowTokens }), ...(autoCompactAt === undefined ? {} : { autoCompactAt }), estimated: input.estimated === true })
    }
    case "plan.limits": {
      if (input.source !== "codex" && input.source !== "claude-code") throw new RangeError("plan limits source is invalid")
      if (!Array.isArray(input.windows)) throw new RangeError("plan limits are invalid")
      const windows = input.windows.slice(0, MAX_LIMIT_WINDOWS).flatMap((window) => {
        const id = window?.id
        if (id === undefined || !PLAN_WINDOW_IDS.has(id) || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return []
        const model = id === "weekly-model" ? planModelName(window.model) : undefined
        if (id === "weekly-model" && model === undefined) return []
        const resetsAt = Number.isSafeInteger(window.resetsAt) && (window.resetsAt ?? 0) > 0 ? window.resetsAt : undefined
        const windowMinutes = Number.isSafeInteger(window.windowMinutes) && (window.windowMinutes ?? 0) > 0 && (window.windowMinutes ?? 0) <= MAX_WINDOW_MINUTES ? window.windowMinutes : undefined
        return [Object.freeze({ id, ...(model === undefined ? {} : { model }), usedPercent: Math.min(100, Math.max(0, window.usedPercent)), ...(resetsAt === undefined ? {} : { resetsAt }), ...(windowMinutes === undefined ? {} : { windowMinutes }) })]
      })
      if (windows.length === 0) throw new RangeError("plan limits are empty")
      const plan = typeof input.plan === "string" && PLAN_NAME.test(input.plan) ? input.plan : undefined
      return Object.freeze({ type: input.type, source: input.source, ...(plan === undefined ? {} : { plan }), windows: Object.freeze(windows), ...(typeof input.extraUsage === "boolean" ? { extraUsage: input.extraUsage } : {}) })
    }
    default:
      throw new RangeError("live frame type is unsupported")
  }
}

function epochMs(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 8_640_000_000_000_000
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000
}

function agentTypeOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  return optionalId(value.subagent_type ?? value.agent_type ?? value.agentType ?? value.role)
}

function agentTitleOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  return oneLine(value.description ?? value.title ?? value.name)
}

function oneLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const line = value.replace(/\s+/g, " ").trim()
  if (line.length === 0) return undefined
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 3)}...` : line
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID && !/[\0\r\n]/.test(value) ? value : undefined
}

function requiredId(value: unknown): string {
  const id = optionalId(value)
  if (id === undefined) throw new RangeError("live frame id is invalid")
  return id
}

function clip(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end = Math.floor(end * 0.9)
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError("live frame hub limit is invalid")
  return value
}

function explanationOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = (input as { explanation?: unknown }).explanation
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}
