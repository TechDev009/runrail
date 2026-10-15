import type { RunrailApiRetryError, RunrailApiRetryFrame } from "../live/types.ts"

export const API_RETRY = "api.retry"

const ERRORS: ReadonlySet<string> = new Set<RunrailApiRetryError>(["oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error", "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens", "cloud_credential_error"])
const TURN_ID = /^[A-Za-z0-9._:\/-]{1,128}$/
const MAX_ATTEMPTS = 1_000
const MAX_WAIT_MS = 24 * 60 * 60_000

/** Claude Code's `api_retry` message for the turn. Its error text is left behind. */
export function claudeApiRetry(value: Readonly<Record<string, unknown>>, turnId: string): RunrailApiRetryFrame | undefined {
  const noResponse = value.no_response !== null && typeof value.no_response === "object" ? value.no_response as { readonly waited_ms?: unknown } : undefined
  return apiRetryFrame({ type: API_RETRY, turnId, source: "claude-code", attempt: value.attempt, maxRetries: value.max_retries, delayMs: value.retry_delay_ms, status: value.error_status, error: value.error, waitedMs: noResponse?.waited_ms })
}

/** An `api.retry` frame or recorded event, checked and bounded; read back as untrusted input. */
export function apiRetryFrame(value: unknown): RunrailApiRetryFrame | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const event = value as Record<string, unknown>
  if (event.type !== API_RETRY || event.source !== "claude-code") return undefined
  if (!count(event.attempt, 1, MAX_ATTEMPTS) || !count(event.maxRetries, 0, MAX_ATTEMPTS) || !count(event.delayMs, 0, MAX_WAIT_MS)) return undefined
  const status = count(event.status, 100, 599) ? event.status : undefined
  const error = typeof event.error === "string" && ERRORS.has(event.error) ? event.error as RunrailApiRetryError : undefined
  const waitedMs = count(event.waitedMs, 0, MAX_WAIT_MS) ? event.waitedMs : undefined
  return Object.freeze({
    type: API_RETRY,
    ...(typeof event.turnId === "string" && TURN_ID.test(event.turnId) ? { turnId: event.turnId } : {}),
    source: "claude-code",
    attempt: event.attempt,
    maxRetries: event.maxRetries,
    delayMs: event.delayMs,
    ...(status === undefined ? {} : { status }),
    ...(error === undefined ? {} : { error }),
    ...(waitedMs === undefined ? {} : { waitedMs }),
  })
}

function count(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
}
