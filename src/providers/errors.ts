export type ProviderErrorCode =
  | "PROVIDER_INVALID"
  | "PROVIDER_CREDENTIALS"
  | "PROVIDER_ENDPOINT_DENIED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_CANCELLED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_STREAM_FAILED"
  | "PROVIDER_CONTENT_UNSUPPORTED"
  | "PROVIDER_CALLER_OWNED"
  | "PROVIDER_FAILED"
  /** The model reached its output limit before it finished. */
  | "PROVIDER_OUTPUT_TRUNCATED"

/** Public provider failure with bounded, payload-free diagnostics. */
export class ProviderError extends Error {
  readonly status?: number
  readonly retryable: boolean

  constructor(
    readonly code: ProviderErrorCode,
    reason: string,
    options: { readonly status?: number; readonly retryable?: boolean } = {},
  ) {
    super(`provider: ${safeReason(reason)}`)
    this.name = "ProviderError"
    this.status = options.status
    this.retryable = options.retryable === true
  }

  /**
   * The start of a refused request's error text, kept off the message and out of serialization, so
   * an adapter can tell which request field the endpoint objected to.
   */
  get rejection(): string | undefined {
    return rejections.get(this)
  }
}

const rejections = new WeakMap<ProviderError, string>()

export function withRejection(error: ProviderError, text: string): ProviderError {
  if (text.length > 0) rejections.set(error, text.slice(0, 2_048).toLowerCase())
  return error
}

/**
 * Whether a 400 or 422 is worth sending again without an optional field: it names one of `fields`,
 * objects to a parameter without naming it, or says nothing at all. Any other refusal (a prompt too
 * long, an empty message, a bad image) is final: sending it again would only fail again.
 */
export function refusedField(error: unknown, fields: readonly string[]): boolean {
  if (!(error instanceof ProviderError) || (error.status !== 400 && error.status !== 422)) return false
  const text = error.rejection
  if (text === undefined || fields.some((field) => text.includes(field))) return true
  return PARAMETER_REFUSAL.test(text) && !OTHER_REFUSAL.test(text)
}

const PARAMETER_REFUSAL = /unsupported|not supported|unknown|unrecognized|not permitted|not allowed|extra (?:inputs|fields)|additional propert|invalid (?:parameter|field|argument)/
const OTHER_REFUSAL = /too long|context length|context window|too many tokens|non-empty|must not be empty|image|tool_use_id|tool_result|messages\.\d/

export function providerError(
  code: ProviderErrorCode,
  reason: string,
  options: { readonly status?: number; readonly retryable?: boolean } = {},
): ProviderError {
  return new ProviderError(code, reason, options)
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError
}

/** A provider can reject a request after HTTP 200 opens the stream. Never echo its diagnostic payload. */
export function providerStreamFailure(value: unknown): ProviderError | undefined {
  if (!isRecord(value)) return undefined
  const failedResponse = value.type === "response.failed"
  const response = isRecord(value.response) ? value.response : undefined
  const payload = failedResponse ? response?.error : value.error
  if (!failedResponse && value.type !== "error" && (payload === undefined || payload === null)) return undefined
  const error = isRecord(payload) ? payload : value
  const code = typeof error.code === "string" ? error.code : error.type
  if (typeof code === "string" && ["rate_limit", "rate_limit_error", "rate_limit_exceeded", "insufficient_quota", "quota_exceeded", "too_many_requests", "RESOURCE_EXHAUSTED"].includes(code)) return new ProviderError("PROVIDER_RATE_LIMITED", "provider usage limit reached", { status: 429 })
  if (typeof code === "string" && ["authentication_error", "invalid_api_key", "unauthorized"].includes(code)) return new ProviderError("PROVIDER_AUTH_FAILED", "provider authentication failed", { status: 401 })
  return new ProviderError("PROVIDER_STREAM_FAILED", "provider stream failed")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Provider messages are reduced to bounded safe text and never echo secret-bearing fields. */
function safeReason(value: string): string {
  if (typeof value !== "string") return "provider operation failed"
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()
  if (normalized.length === 0) return "provider operation failed"
  if (/(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/i.test(normalized) || /(?:api[-_]?key|authorization|x-api-key|cookie)\s*[:=]/i.test(normalized)) return "provider operation failed"
  try {
    const parsed = new URL(normalized)
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0) return "provider operation failed"
  } catch {
    // Non-URL reasons are handled by the bounded text path below.
  }
  return normalized.length > 256 ? normalized.slice(0, 256) : normalized
}

/** Said in the reply, so the person and the next step both see that it stopped short. */
export const TRUNCATED_NOTE = "\n\n[Runrail: this reply was cut off at the model's output limit]"
export const STREAM_CUT_NOTE = "\n\n[Runrail: the connection ended before the model finished this reply]"

/** A stream that stopped before its protocol's last event, so a tool call in it is not the model's decision yet. */
export function streamCutOff(): ProviderError {
  return new ProviderError("PROVIDER_STREAM_FAILED", "the stream ended before the model finished its tool call")
}

export function truncatedOutput(when = "before it finished a tool call"): ProviderError {
  return new ProviderError("PROVIDER_OUTPUT_TRUNCATED", `the model reached its output limit ${when}`)
}
