/**
 * A coding tool deciding a call for the person: Codex's own reviewer (Approve for me), Claude
 * Code's auto mode, and the rules and modes Claude Code denies by. The shared agent protocol takes
 * only its own event types, so these travel as Runrail live frames and the session keeps them in
 * its transcript.
 */

import { unwrapShell } from "../backend/codex-background.ts"
import type { RunrailApprovalReviewedFrame, RunrailReviewerNoticeFrame } from "../live/types.ts"

export const APPROVAL_REVIEWED = "approval.reviewed"
export const REVIEWER_NOTICE = "reviewer.notice"

export type Reviewer = "codex" | "claude-code"
export type ReviewDecision = "reviewing" | "approved" | "denied" | "timed-out" | "aborted"
export type ReviewRisk = "low" | "medium" | "high" | "critical"
/** What decided inside Claude Code: its auto mode's reviewer, a deny rule, or its mode. */
export type ReviewSource = "reviewer" | "rule" | "mode"
export type ReviewerNoticeKind = "unavailable" | "warning"

export interface ApprovalReview {
  /** The same id for a review's start and its decision. */
  readonly reviewId: string
  readonly reviewer: Reviewer
  readonly decision: ReviewDecision
  readonly action: string
  readonly capability: string
  readonly risk?: ReviewRisk
  readonly source?: ReviewSource
  /** What was reviewed: the command, the files, or the address. */
  readonly detail?: string
  /** The reviewer's own words. */
  readonly rationale?: string
}

export interface ReviewerNotice {
  readonly reviewer: Reviewer
  readonly notice: ReviewerNoticeKind
  readonly message?: string
}

export const MAX_REVIEW_DETAIL = 512
export const MAX_REVIEW_TEXT = 1_024
const REVIEW_ID = /^[A-Za-z0-9._:-]{1,128}$/
const TURN_ID = /^[A-Za-z0-9._:\/-]{1,128}$/
const DECISIONS: ReadonlySet<string> = new Set<ReviewDecision>(["reviewing", "approved", "denied", "timed-out", "aborted"])
const RISKS: ReadonlySet<string> = new Set<ReviewRisk>(["low", "medium", "high", "critical"])
const SOURCES: ReadonlySet<string> = new Set<ReviewSource>(["reviewer", "rule", "mode"])
const CODEX_STATUS: Readonly<Record<string, ReviewDecision>> = Object.freeze({ inProgress: "reviewing", approved: "approved", denied: "denied", timedOut: "timed-out", aborted: "aborted" })
const MAX_FILES_SHOWN = 3
// Codex 0.160 sends every decision again as a warning in this form; the review's own row already says it.
const RESTATED_REVIEW = /^Automatic approval review \S+ \(risk: [^,()]*, authorization: [^()]*\): /

/** Codex's `item/autoApprovalReview/started` and `completed`, in Runrail's words. */
export function codexReview(method: string, params: Record<string, unknown>): ApprovalReview | undefined {
  if (method !== "item/autoApprovalReview/started" && method !== "item/autoApprovalReview/completed") return undefined
  const reviewId = typeof params.reviewId === "string" && REVIEW_ID.test(params.reviewId) ? params.reviewId : undefined
  const review = record(params.review)
  const status = typeof review.status === "string" ? CODEX_STATUS[review.status] : undefined
  if (reviewId === undefined || status === undefined) return undefined
  // A start that already carries a verdict is still only a start; the decision comes with `completed`.
  const decision = method === "item/autoApprovalReview/started" ? "reviewing" : status === "reviewing" ? undefined : status
  if (decision === undefined) return undefined
  const risk = typeof review.riskLevel === "string" && RISKS.has(review.riskLevel) ? review.riskLevel as ReviewRisk : undefined
  const rationale = oneLine(review.rationale, MAX_REVIEW_TEXT)
  const target = codexAction(record(params.action))
  return Object.freeze({
    reviewId: `codex-${reviewId}`,
    reviewer: "codex",
    decision,
    action: target.action,
    capability: target.capability,
    ...(risk === undefined ? {} : { risk }),
    ...(target.detail === undefined ? {} : { detail: target.detail }),
    ...(rationale === undefined ? {} : { rationale }),
  })
}

function codexAction(action: Record<string, unknown>): { readonly action: string; readonly capability: string; readonly detail?: string } {
  const detail = (value: string | undefined): { readonly detail?: string } => (value === undefined ? {} : { detail: value })
  switch (action.type) {
    case "command":
      return { action: "command", capability: "process.exec", ...detail(oneLine(typeof action.command === "string" ? unwrapShell(action.command) : undefined, MAX_REVIEW_DETAIL)) }
    case "execve": {
      const argv = Array.isArray(action.argv) ? action.argv.filter((part): part is string => typeof part === "string") : []
      return { action: "command", capability: "process.exec", ...detail(oneLine(argv.length > 0 ? argv.join(" ") : action.program, MAX_REVIEW_DETAIL)) }
    }
    // What a running command is sent can be a secret, so it is never shown.
    case "writeStdin":
      return { action: "command", capability: "process.exec", detail: "Input to a running command" }
    case "applyPatch": {
      const files = Array.isArray(action.files) ? action.files.filter((file): file is string => typeof file === "string") : []
      const shown = files.slice(0, MAX_FILES_SHOWN).join(", ") + (files.length > MAX_FILES_SHOWN ? ` and ${String(files.length - MAX_FILES_SHOWN)} more` : "")
      return { action: "file_change", capability: "filesystem.write", ...detail(oneLine(shown, MAX_REVIEW_DETAIL)) }
    }
    case "networkAccess": {
      const host = oneLine(action.host, 256)
      const port = typeof action.port === "number" && Number.isSafeInteger(action.port) && action.port !== 80 && action.port !== 443 ? `:${String(action.port)}` : ""
      return { action: "permission", capability: "network.request", ...detail(host === undefined ? oneLine(action.target, MAX_REVIEW_DETAIL) : `${host}${port}`) }
    }
    case "mcpToolCall": {
      const tool = oneLine(action.toolTitle, 128) ?? oneLine(action.toolName, 128)
      const server = oneLine(action.connectorName, 128) ?? oneLine(action.server, 128)
      return { action: "permission", capability: "tool.use", ...detail(server === undefined ? tool : tool === undefined ? server : `${server}: ${tool}`) }
    }
    case "requestPermissions":
      return { action: "permission", capability: "sandbox.permission", ...detail(oneLine(action.reason, MAX_REVIEW_DETAIL)) }
    default:
      return { action: "permission", capability: "tool.use" }
  }
}

/** Codex's `guardianWarning`, unless it only restates a review's decision. */
export function codexWarning(message: unknown): string | undefined {
  const text = oneLine(message, MAX_REVIEW_TEXT)
  return text === undefined || RESTATED_REVIEW.test(text) ? undefined : text
}

/**
 * Claude Code's `system/permission_denied`: a call it refused without asking. Its auto mode's
 * reviewer reports as `classifier`; a deny rule as `rule`; its mode as `mode`.
 */
export function claudeDenial(message: Record<string, unknown>, kind: { readonly action: string; readonly capability: string }, detail?: string): ApprovalReview | undefined {
  if (message.type !== "system" || message.subtype !== "permission_denied") return undefined
  const toolUseId = typeof message.tool_use_id === "string" && REVIEW_ID.test(message.tool_use_id) ? message.tool_use_id : undefined
  if (toolUseId === undefined) return undefined
  const reason = message.decision_reason_type
  const source: ReviewSource | undefined = reason === "classifier" ? "reviewer" : reason === "rule" ? "rule" : reason === "mode" ? "mode" : undefined
  const rationale = oneLine(message.decision_reason, MAX_REVIEW_TEXT) ?? oneLine(message.message, MAX_REVIEW_TEXT)
  const shown = oneLine(detail, MAX_REVIEW_DETAIL)
  return Object.freeze({
    reviewId: `claude-denied-${toolUseId}`,
    reviewer: "claude-code",
    decision: "denied",
    action: kind.action,
    capability: kind.capability,
    ...(source === undefined ? {} : { source }),
    ...(shown === undefined ? {} : { detail: shown }),
    ...(rationale === undefined ? {} : { rationale }),
  })
}

/**
 * A call Claude Code refused before asking without a `permission_denied`: when the gate sends a call
 * to its prompt, its deny rules, hooks, and safety checks refuse it silently.
 */
export function claudeUnaskedDenial(toolUseId: string, kind: { readonly action: string; readonly capability: string }, detail?: string): ApprovalReview | undefined {
  if (!REVIEW_ID.test(toolUseId)) return undefined
  const shown = oneLine(detail, MAX_REVIEW_DETAIL)
  return Object.freeze({ reviewId: `claude-denied-${toolUseId}`, reviewer: "claude-code", decision: "denied", action: kind.action, capability: kind.capability, ...(shown === undefined ? {} : { detail: shown }) })
}

/** A review or reviewer notice frame, checked and bounded; anything else is not one. */
export function reviewFrame(value: unknown): RunrailApprovalReviewedFrame | RunrailReviewerNoticeFrame | undefined {
  const parsed = parseApprovalReview(value) ?? parseReviewerNotice(value)
  if (parsed === undefined) return undefined
  const { turnId, ...fields } = parsed
  const turn = turnId !== undefined && TURN_ID.test(turnId) ? { turnId } : {}
  return Object.freeze("reviewId" in fields ? { type: APPROVAL_REVIEWED, ...turn, ...fields } : { type: REVIEWER_NOTICE, ...turn, ...fields })
}

/** A recorded `approval.reviewed` frame or event, read back as untrusted input. */
export function parseApprovalReview(value: unknown): (ApprovalReview & { readonly turnId?: string }) | undefined {
  const event = record(value)
  if (event.type !== APPROVAL_REVIEWED) return undefined
  if (typeof event.reviewId !== "string" || !REVIEW_ID.test(event.reviewId)) return undefined
  if (event.reviewer !== "codex" && event.reviewer !== "claude-code") return undefined
  if (typeof event.decision !== "string" || !DECISIONS.has(event.decision)) return undefined
  if (typeof event.action !== "string" || typeof event.capability !== "string") return undefined
  const detail = oneLine(event.detail, MAX_REVIEW_DETAIL)
  const rationale = oneLine(event.rationale, MAX_REVIEW_TEXT)
  return Object.freeze({
    ...(typeof event.turnId === "string" ? { turnId: event.turnId } : {}),
    reviewId: event.reviewId,
    reviewer: event.reviewer,
    decision: event.decision as ReviewDecision,
    action: event.action.slice(0, 64),
    capability: event.capability.slice(0, 128),
    ...(typeof event.risk === "string" && RISKS.has(event.risk) ? { risk: event.risk as ReviewRisk } : {}),
    ...(typeof event.source === "string" && SOURCES.has(event.source) ? { source: event.source as ReviewSource } : {}),
    ...(detail === undefined ? {} : { detail }),
    ...(rationale === undefined ? {} : { rationale }),
  })
}

/** A recorded `reviewer.notice` frame or event, read back as untrusted input. */
export function parseReviewerNotice(value: unknown): (ReviewerNotice & { readonly turnId?: string }) | undefined {
  const event = record(value)
  if (event.type !== REVIEWER_NOTICE) return undefined
  if (event.reviewer !== "codex" && event.reviewer !== "claude-code") return undefined
  if (event.notice !== "unavailable" && event.notice !== "warning") return undefined
  const message = oneLine(event.message, MAX_REVIEW_TEXT)
  return Object.freeze({
    ...(typeof event.turnId === "string" ? { turnId: event.turnId } : {}),
    reviewer: event.reviewer,
    notice: event.notice,
    ...(message === undefined ? {} : { message }),
  })
}

/** Text from a tool, on one line and bounded; nothing when it is empty or not text. */
export function oneLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/[\0-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim()
  if (text.length === 0) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
