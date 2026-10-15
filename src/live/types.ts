import type { ApprovalReview, ReviewerNotice } from "../harness/review.ts"
import type { ThinkingLevel } from "../model/catalog.ts"

/**
 * Runrail-owned live frames for a coding UI. They carry bounded content (reasoning text, plan
 * steps, subagent lineage, a coding tool's own reviews) that the published AgentEvent union cannot
 * express. Frames travel only over the authenticated loopback control stream. Only reviews, reviewer
 * notices, and retries are persisted: the session keeps them in its transcript.
 */
export type RunrailPlanStepStatus = "pending" | "in_progress" | "completed"

export interface RunrailPlanStep {
  readonly text: string
  readonly status: RunrailPlanStepStatus
}

export interface RunrailReasoningDeltaFrame {
  readonly type: "reasoning.delta"
  readonly turnId?: string
  readonly parentCallId?: string
  readonly itemId?: string
  /** Text to append to the reasoning block identified by `itemId` (or the turn). */
  readonly text: string
}

export interface RunrailReasoningCompletedFrame {
  readonly type: "reasoning.completed"
  readonly turnId?: string
  readonly parentCallId?: string
  readonly itemId?: string
  /** Final reasoning text when the source provides it; replaces accumulated deltas. */
  readonly text?: string
}

export interface RunrailPlanUpdatedFrame {
  readonly type: "plan.updated"
  readonly turnId?: string
  /** Tool call that carried the plan, when the plan came from a tool. */
  readonly callId?: string
  readonly explanation?: string
  readonly steps: readonly RunrailPlanStep[]
}

export interface RunrailAgentSpawnedFrame {
  readonly type: "agent.spawned"
  readonly turnId?: string
  readonly callId: string
  readonly parentCallId?: string
  readonly title: string
  readonly agentType?: string
}

export interface RunrailAgentCompletedFrame {
  readonly type: "agent.completed"
  readonly turnId?: string
  readonly callId: string
  readonly ok: boolean
}

/** Links a tool call or event produced inside a subagent to the agent's call. */
export interface RunrailLineageFrame {
  readonly type: "lineage"
  readonly parentCallId: string
  readonly callId?: string
  readonly eventSeq?: number
}

/** Something the model's provider changed so a turn could go through. Stable codes only. */
export interface RunrailModelNoticeFrame {
  readonly type: "model.notice"
  readonly turnId?: string
  /** `THINKING_REFUSED`: the model refused this reasoning level and the turn ran without one. */
  readonly code: "THINKING_REFUSED"
  readonly thinking: ThinkingLevel
}

/**
 * A request a coding tool made of Runrail that Runrail refused without asking the person. The tool
 * keeps only its own fixed words for a refusal, so this is where the person reads why.
 */
export interface RunrailRequestRefusedFrame {
  readonly type: "request.refused"
  readonly turnId?: string
  readonly source: "codex" | "claude-code"
  /** What was asked and why it was refused, on one line. */
  readonly message: string
}

/** A coding tool's request that failed and that the tool will make again after a wait. Counts, the status, and the tool's kind of error only. */
export interface RunrailApiRetryFrame {
  readonly type: "api.retry"
  readonly turnId?: string
  readonly source: "claude-code"
  /** This retry's number, from 1. */
  readonly attempt: number
  readonly maxRetries: number
  /** How long the tool waits before this retry. */
  readonly delayMs: number
  /** The HTTP status of the failed attempt; left out when no answer came. */
  readonly status?: number
  /** The tool's kind of error, such as `overloaded` or `server_error`. */
  readonly error?: RunrailApiRetryError
  /** The API sent no response headers in this long, so the attempt was given up. */
  readonly waitedMs?: number
}

export type RunrailApiRetryError = "oauth_org_not_allowed" | "account_on_hold" | "verification_required" | "billing_error" | "overloaded" | "invalid_request" | "model_not_found" | "server_error" | "unknown" | "max_output_tokens" | "cloud_credential_error"

/** A coding tool deciding a call for the person: Codex's reviewer, Claude Code's auto mode, a rule, or a mode. */
export type RunrailApprovalReviewedFrame = { readonly type: "approval.reviewed"; readonly turnId?: string } & ApprovalReview

/** A coding tool's reviewer that is unavailable, or warned about something. */
export type RunrailReviewerNoticeFrame = { readonly type: "reviewer.notice"; readonly turnId?: string } & ReviewerNotice

/** How full the model's context was after its latest request. Counts only. */
export interface RunrailContextUsageFrame {
  readonly type: "context.usage"
  readonly turnId?: string
  /** The latest request's prompt plus its answer. */
  readonly usedTokens: number
  /** The model's context window, when its descriptor names one. */
  readonly windowTokens?: number
  /** Where the coding tool compacts on its own, in tokens, when it says. */
  readonly autoCompactAt?: number
  /** The provider reported no usage, so the count is Runrail's estimate. */
  readonly estimated: boolean
}

export type RunrailPlanLimitWindowId = "five-hour" | "weekly" | "weekly-opus" | "weekly-sonnet" | "weekly-model" | "primary" | "secondary"

/** One usage window of the account's plan. `primary` and `secondary` are windows the tool did not name. */
export interface RunrailPlanLimitWindow {
  readonly id: RunrailPlanLimitWindowId
  /** A `weekly-model` window's model, as the vendor's server names it, such as `Fable`. */
  readonly model?: string
  /** Share of the window used, 0 to 100. */
  readonly usedPercent: number
  /** Milliseconds since the epoch. */
  readonly resetsAt?: number
  readonly windowMinutes?: number
}

/** How much of the subscription a coding tool says is used. Shares and reset times only: no account, no amounts. */
export interface RunrailPlanLimitsFrame {
  readonly type: "plan.limits"
  readonly source: "codex" | "claude-code"
  /** The plan's name as the tool spells it, such as `pro`. */
  readonly plan?: string
  readonly windows: readonly RunrailPlanLimitWindow[]
  /** Whether extra usage can serve requests past a used-up window; left out when the tool did not say. */
  readonly extraUsage?: boolean
}

/** What a coding tool says on request about its context and the plan, for a person looking at it. */
export interface RunrailUsageReading {
  readonly context?: Omit<RunrailContextUsageFrame, "type" | "turnId">
  readonly plan?: RunrailPlanLimitsFrame
}

export type RunrailBackgroundKind = "agent" | "command"
export type RunrailBackgroundStatus = "running" | "completed" | "failed" | "stopped" | "unknown"

/** Work an agent left running: a subagent or a shell command. Labels are redacted; no paths, pids, or prompts. */
export interface RunrailBackgroundEntry {
  readonly id: string
  readonly kind: RunrailBackgroundKind
  readonly status: RunrailBackgroundStatus
  readonly label: string
  /** The latest summary or step, redacted. */
  readonly detail?: string
  readonly agentType?: string
  /** The tool call that started it, so its steps can be found in the timeline. */
  readonly callId?: string
  /** Still attached to the turn that started it; the Tasks list shows such commands once they detach. */
  readonly foreground?: boolean
  readonly startedAt?: number
  readonly endedAt?: number
  readonly exitCode?: number
  readonly tokens?: number
  readonly toolUses?: number
  readonly durationMs?: number
  readonly stoppable: boolean
  /** `turn`: only stopping the turn ends it. */
  readonly stopHint?: "turn"
  readonly hasOutput: boolean
}

/** What a source can do for an entry. In-process only: the hub keeps it and never serializes it. */
export interface RunrailBackgroundControl {
  stop?(): Promise<void>
  output?(maxBytes: number): Promise<{ readonly text: string; readonly truncated: boolean }>
}

/** A change to one entry; fields left out keep their last value. A new entry needs `kind` and `label`. */
export interface RunrailBackgroundStateFrame {
  readonly type: "background.state"
  readonly entry: Partial<RunrailBackgroundEntry> & { readonly id: string }
  readonly control?: RunrailBackgroundControl
}

/** The agent asked for the browser preview; the desktop claims it with `browser.take`. Carries no parameters. */
export interface RunrailBrowserRequestFrame {
  readonly type: "browser.request"
  readonly requestId: string
  readonly action: string
}

/** The agent asked about or messaged another thread; the desktop claims it with `threads.take`. Carries no parameters. */
export interface RunrailThreadsRequestFrame {
  readonly type: "threads.request"
  readonly requestId: string
  readonly action: string
}

/** The agent asked to see or use an app on the person's Mac; the desktop claims it with `computer.take`. Carries no parameters. */
export interface RunrailComputerRequestFrame {
  readonly type: "computer.request"
  readonly requestId: string
  readonly action: string
}

/** `BROWSER_TOOLS_UNAVAILABLE`: browser use is on, but this Codex conversation started without the tools. */
export interface RunrailBrowserNoticeFrame {
  readonly type: "browser.notice"
  readonly code: "BROWSER_TOOLS_UNAVAILABLE"
}

export type RunrailLiveFrameInput =
  | RunrailBackgroundStateFrame
  | RunrailBrowserRequestFrame
  | RunrailBrowserNoticeFrame
  | RunrailThreadsRequestFrame
  | RunrailComputerRequestFrame
  | RunrailReasoningDeltaFrame
  | RunrailReasoningCompletedFrame
  | RunrailPlanUpdatedFrame
  | RunrailAgentSpawnedFrame
  | RunrailAgentCompletedFrame
  | RunrailLineageFrame
  | RunrailModelNoticeFrame
  | RunrailRequestRefusedFrame
  | RunrailContextUsageFrame
  | RunrailPlanLimitsFrame
  | RunrailApprovalReviewedFrame
  | RunrailReviewerNoticeFrame
  | RunrailApiRetryFrame

export type RunrailLiveFrame = RunrailLiveFrameInput & {
  readonly version: 1
  readonly sessionId: string
  readonly liveSeq: number
  readonly at: number
  /** Highest AgentEvent seq observed when the frame was emitted, for ordering in a timeline. */
  readonly afterSeq: number
}

/** Caller-owned transient sink. It must not throw into the harness; failures are dropped. */
export type RunrailLiveSink = (frame: RunrailLiveFrameInput) => void
