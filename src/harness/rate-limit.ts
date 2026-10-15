const LIMIT_CODES: ReadonlySet<string> = new Set(["rate_limit", "rate_limit_error", "rate_limit_exceeded", "insufficient_quota", "quota_exceeded", "usage_limit_exceeded", "usageLimitExceeded", "RESOURCE_EXHAUSTED", "resource_exhausted"])
const WINDOW_NAMES: Readonly<Record<string, string>> = { five_hour: "five-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet" }
const LIMIT_TEXT = /(?:usage|weekly|daily|rate|spending|credit)[ _-]*limit[\s\S]{0,80}(?:reach|exceed|exhaust)|(?:hit|reached|exceeded|exhausted)[\s\S]{0,80}(?:usage|weekly|daily|rate|spending|credit)?[ _-]*limit|(?:insufficient|exhausted|exceeded)[ _-]*quota|quota[\s\S]{0,40}(?:exceed|exhaust)|(?:no|out of|insufficient)[ _-]*credits/i

/** Recognizes a refused model request. Passive usage reports and ordinary assistant text cannot end a turn. */
export function harnessRateLimitMessage(value: unknown, source: string): string | undefined {
  if (!isRecord(value)) return undefined
  const info = isRecord(value.rate_limit_info) ? value.rate_limit_info : undefined
  if (value.type === "rate_limit_event") {
    // Extra usage can still serve the request after the included allowance is used up.
    if (info?.status !== "rejected" || info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning") return undefined
    return limitMessage(source, info.rateLimitType, info.resetsAt)
  }
  const retry = value.type === "system" && value.subtype === "api_retry"
  const error = isRecord(value.error) ? value.error : value
  const data = isRecord(error.data) ? error.data : undefined
  const known = limitCode(value.error) || limitCode(error.code) || limitCode(error.type) || limitCode(data?.code) || limitCode(data?.type) || limitCode(error.codexErrorInfo) || httpRateLimit(error.codexErrorInfo) || error.code === 429 || error.httpStatusCode === 429 || error.status === 429 || error.statusCode === 429 || (retry && value.error_status === 429)
  // Inspect vendor error fields only. An assistant explaining rate limits is still a normal answer.
  const failure = value.type === undefined || value.type === "error" || value.type === "failure" || value.type === "turn.failed" || value.is_error === true || retry
  const texts = errorTexts(value)
  if (!known && !(failure && texts.some((text) => LIMIT_TEXT.test(text)))) return undefined
  const weekly = texts.some((text) => /weekly|seven[ _-]?day/i.test(text))
  return limitMessage(source, weekly ? "seven_day" : undefined)
}

function limitMessage(source: string, window: unknown, reset?: unknown): string {
  const name = typeof window === "string" ? WINDOW_NAMES[window] : undefined
  let message = `${source}${name === undefined ? "" : ` ${name}`} usage limit reached.`
  if (typeof reset === "number" && Number.isSafeInteger(reset) && reset > 0) {
    const milliseconds = reset < 100_000_000_000 ? reset * 1_000 : reset
    if (milliseconds <= 8_640_000_000_000_000) message += ` Resets at ${new Date(milliseconds).toISOString()}.`
  }
  return message
}

function limitCode(value: unknown): boolean {
  return typeof value === "string" && LIMIT_CODES.has(value)
}

function httpRateLimit(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.values(value).slice(0, 16).some((detail) => isRecord(detail) && detail.httpStatusCode === 429)
}

/** Bounded extraction used only to classify errors; no vendor text is returned or stored. */
function errorTexts(value: unknown, depth = 0, budget = { remaining: 64 }): readonly string[] {
  if (depth > 5 || budget.remaining-- <= 0) return []
  if (typeof value === "string") return value.length <= 16_384 ? [value] : []
  if (Array.isArray(value)) return value.slice(0, 8).flatMap((entry) => errorTexts(entry, depth + 1, budget))
  if (!isRecord(value)) return []
  return ["error", "message", "result", "errors", "additionalDetails", "content", "text", "data", "details"].flatMap((key) => errorTexts(value[key], depth + 1, budget))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
