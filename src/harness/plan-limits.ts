import type { RunrailPlanLimitsFrame, RunrailPlanLimitWindow, RunrailPlanLimitWindowId } from "../live/types.ts"

/**
 * Subscription usage as Codex and Claude Code report it, reduced to shares used and reset times.
 * Account ids, balances, and anything else in the vendor's payload are dropped here.
 */

const CLAUDE_WINDOWS: Readonly<Record<string, RunrailPlanLimitWindowId>> = {
  five_hour: "five-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly-opus",
  seven_day_sonnet: "weekly-sonnet",
}

/** Codex's `RateLimitSnapshot`: up to two windows, named only by their length. */
export function codexPlanLimits(value: unknown): RunrailPlanLimitsFrame | undefined {
  const snapshot = record(value)
  const windows = [codexWindow(snapshot.primary, "primary"), codexWindow(snapshot.secondary, "secondary")].filter((window) => window !== undefined)
  if (windows.length === 0) return undefined
  const plan = planName(snapshot.planType)
  return { type: "plan.limits", source: "codex", ...(plan === undefined ? {} : { plan }), windows }
}

function codexWindow(value: unknown, fallback: "primary" | "secondary"): RunrailPlanLimitWindow | undefined {
  const window = record(value)
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return undefined
  const minutes = Number.isSafeInteger(window.windowDurationMins) && (window.windowDurationMins as number) > 0 ? window.windowDurationMins as number : undefined
  const id = minutes === 300 ? "five-hour" : minutes === 10_080 ? "weekly" : fallback
  const resetsAt = epochMs(window.resetsAt)
  return { id, usedPercent: clampPercent(window.usedPercent), ...(resetsAt === undefined ? {} : { resetsAt }), ...(minutes === undefined ? {} : { windowMinutes: minutes }) }
}

/**
 * Claude Code's `rate_limit_info`. Current versions carry every window's share in
 * `unifiedWindows` on each event; older ones name one window, with an optional top-level
 * `utilization`. A share is from 0 to 1; a rejected request with no share means the window is
 * used up.
 */
export function claudePlanLimits(value: unknown): RunrailPlanLimitsFrame | undefined {
  const info = record(value)
  const unified = record(info.unifiedWindows)
  const windows = Object.entries(CLAUDE_WINDOWS).flatMap(([name, id]): RunrailPlanLimitWindow[] => {
    const window = record(unified[name])
    const share = finiteNumber(window.utilization)
    if (share === undefined) return []
    const resetsAt = epochMs(window.resetsAt)
    return [{ id, usedPercent: clampPercent(share <= 1 ? share * 100 : share), ...(resetsAt === undefined ? {} : { resetsAt }) }]
  })
  const extra = info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning" ? true : info.overageStatus === "rejected" ? false : undefined
  const extraUsage = extra === undefined ? {} : { extraUsage: extra }
  if (windows.length > 0) return { type: "plan.limits", source: "claude-code", windows, ...extraUsage }
  const id = typeof info.rateLimitType === "string" ? CLAUDE_WINDOWS[info.rateLimitType] : undefined
  if (id === undefined) return undefined
  const share = finiteNumber(info.utilization) ?? (info.status === "rejected" ? 1 : undefined)
  if (share === undefined) return undefined
  const resetsAt = epochMs(info.resetsAt)
  return { type: "plan.limits", source: "claude-code", windows: [{ id, usedPercent: clampPercent(share <= 1 ? share * 100 : share), ...(resetsAt === undefined ? {} : { resetsAt }) }], ...extraUsage }
}

const MAX_MODEL_WINDOWS = 8

/**
 * The SDK's answer behind `/usage`: each window's `utilization` from 0 to 100 and an ISO
 * `resets_at`. Newer responses use `limits` rows with `kind` and `percent`; these take precedence
 * over the legacy fields. Windows under internal code names are left out.
 */
export function claudeUsageLimits(value: unknown): RunrailPlanLimitsFrame | undefined {
  const usage = record(value)
  if (usage.rate_limits_available === false) return undefined
  const limits = record(usage.rate_limits)
  const named = Object.entries(CLAUDE_WINDOWS).flatMap(([name, id]): RunrailPlanLimitWindow[] => {
    const window = record(limits[name])
    const percent = finiteNumber(window.utilization)
    if (percent === undefined) return []
    const resetsAt = isoMs(window.resets_at)
    return [{ id, usedPercent: clampPercent(percent), ...(resetsAt === undefined ? {} : { resetsAt }) }]
  })
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : []
  const perModel = scoped.flatMap((entry): RunrailPlanLimitWindow[] => {
    const window = record(entry)
    const model = planModelName(window.display_name)
    const percent = finiteNumber(window.utilization)
    if (model === undefined || percent === undefined) return []
    const resetsAt = isoMs(window.resets_at)
    return [{ id: "weekly-model", model, usedPercent: clampPercent(percent), ...(resetsAt === undefined ? {} : { resetsAt }) }]
  }).slice(0, MAX_MODEL_WINDOWS)
  const windowsByKey = new Map([...named, ...perModel].map((window) => [claudeWindowKey(window), window]))
  const structured = Array.isArray(limits.limits) ? limits.limits.slice(0, 64) : []
  for (const entry of structured) {
    const window = record(entry)
    const percent = finiteNumber(window.percent)
    if (percent === undefined) continue
    const model = window.kind === "weekly_scoped" ? planModelName(record(window.scope).model) : undefined
    const id = window.kind === "session" ? "five-hour" : window.kind === "weekly_all" ? "weekly" : model === undefined ? undefined : "weekly-model"
    if (id === undefined) continue
    const resetsAt = isoMs(window.resets_at)
    const parsed: RunrailPlanLimitWindow = { id, ...(model === undefined ? {} : { model }), usedPercent: clampPercent(percent), ...(resetsAt === undefined ? {} : { resetsAt }) }
    const key = claudeWindowKey(parsed)
    const previous = windowsByKey.get(key)
    windowsByKey.set(key, { ...parsed, ...(previous?.model === undefined ? {} : { model: previous.model }) })
  }
  const all = [...windowsByKey.values()]
  const windows = [...Object.values(CLAUDE_WINDOWS).flatMap((id) => all.filter((window) => window.id === id)), ...all.filter((window) => window.id === "weekly-model").slice(0, MAX_MODEL_WINDOWS)]
  if (windows.length === 0) return undefined
  const plan = planName(usage.subscription_type)
  // `is_enabled` is false while extra usage cannot cover sends; a plan without it sends null.
  const extra = limits.extra_usage === null ? false : typeof record(limits.extra_usage).is_enabled === "boolean" ? record(limits.extra_usage).is_enabled as boolean : undefined
  return { type: "plan.limits", source: "claude-code", ...(plan === undefined ? {} : { plan }), windows, ...(extra === undefined ? {} : { extraUsage: extra }) }
}

function claudeWindowKey(window: RunrailPlanLimitWindow): string {
  return window.model === undefined ? window.id : `${window.id}:${window.model.toLowerCase()}`
}

/** Both tools send seconds; a value already in milliseconds is kept. */
function epochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined
  return value < 100_000_000_000 ? value * 1_000 : value
}

function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined
  const at = Date.parse(value)
  return Number.isSafeInteger(at) && at > 0 ? at : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

/** A model's name from the vendor's server, shown as it is: 1 to 40 characters, none of them control or format characters. */
export function planModelName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const name = value.trim()
  return name.length > 0 && name.length <= 40 && !/\p{C}/u.test(name) ? name : undefined
}

function planName(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_-]{1,40}$/.test(value) && value !== "unknown" ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
