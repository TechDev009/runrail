/**
 * Setups: who plans, who executes, who reviews, and the rules between them. A setup is
 * configuration only; `runner.ts` turns one into a run.
 */

export const SETUP_ROUTES = ["native", "claude-code", "codex", "pi", "copilot", "opencode", "gemini", "goose", "replay"] as const
export type SetupRoute = (typeof SETUP_ROUTES)[number]
export const SETUP_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const
export type SetupEffort = (typeof SETUP_EFFORTS)[number]
/** What a role may do in the worktree. The planner and reviewer always run read only. */
export const SETUP_ACCESS = ["ask", "auto-edit", "auto", "full"] as const
export type SetupAccess = (typeof SETUP_ACCESS)[number]
export const SETUP_ROLES = ["planner", "executor", "reviewer"] as const
export type SetupRoleName = (typeof SETUP_ROLES)[number]

export interface SetupRole {
  readonly route: SetupRoute
  readonly model?: string
  readonly connectionId?: string
  readonly effort?: SetupEffort
  readonly access?: SetupAccess
}

export interface SetupRules {
  /** The person approves the planner's plan before anything is changed. */
  readonly approvePlan: boolean
  /** Review and fix rounds after the steps; 0 skips the reviewer. */
  readonly reviewRounds: number
  /** Run after each step and after each fix, in the worktree. */
  readonly check?: string
  readonly budget: SetupBudget
}

/** The run stops when either is reached. */
export interface SetupBudget {
  readonly maxTurns: number
  readonly maxMinutes: number
}

export interface Setup {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly roles: { readonly planner?: SetupRole; readonly executor: SetupRole; readonly reviewer?: SetupRole }
  readonly rules: SetupRules
}

export class SetupError extends Error {
  constructor(
    readonly code: "SETUP_INVALID" | "SETUP_NOT_FOUND" | "SETUP_READ_ONLY" | "SETUP_LIMIT" | "SETUP_RUN_NOT_FOUND" | "SETUP_RUN_NOT_WAITING" | "SETUP_STORE_FAILED" | "SETUP_UNTRUSTED",
    message: string,
  ) {
    super(message)
    this.name = "SetupError"
  }
}

export const SETUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const MAX_SETUPS = 64
export const MAX_REVIEW_ROUNDS = 5
export const DEFAULT_BUDGET: SetupBudget = Object.freeze({ maxTurns: 40, maxMinutes: 120 })
const MODEL = /^[^\0\r\n]{1,200}$/
const CONNECTION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function invalid(message: string): never {
  throw new SetupError("SETUP_INVALID", message)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${what} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) invalid(`${what} must be text up to ${String(max)} characters`)
  return value.trim()
}

function whole(value: unknown, min: number, max: number, what: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${what} must be a whole number from ${String(min)} to ${String(max)}`)
  return value
}

function oneOf<T extends string>(value: unknown, options: readonly T[], what: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) invalid(`${what} must be one of ${options.join(", ")}`)
  return value as T
}

export function parseSetupRole(value: unknown, what: string): SetupRole {
  const item = record(value, what)
  const model = item.model === undefined ? undefined : typeof item.model === "string" && MODEL.test(item.model) ? item.model : invalid(`${what}.model is invalid`)
  const connectionId = item.connectionId === undefined ? undefined : typeof item.connectionId === "string" && CONNECTION.test(item.connectionId) ? item.connectionId : invalid(`${what}.connectionId is invalid`)
  return Object.freeze({
    route: oneOf(item.route, SETUP_ROUTES, `${what}.route`),
    ...(model === undefined ? {} : { model }),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(item.effort === undefined ? {} : { effort: oneOf(item.effort, SETUP_EFFORTS, `${what}.effort`) }),
    ...(item.access === undefined ? {} : { access: oneOf(item.access, SETUP_ACCESS, `${what}.access`) }),
  })
}

export function parseSetup(value: unknown): Setup {
  const item = record(value, "setup")
  if (typeof item.id !== "string" || !SETUP_ID.test(item.id)) invalid("setup.id must be 1-64 letters, digits, dots, dashes or underscores")
  const roles = record(item.roles, "setup.roles")
  const rules = record(item.rules ?? {}, "setup.rules")
  const budget = record(rules.budget ?? {}, "setup.rules.budget")
  const reviewRounds = whole(rules.reviewRounds, 0, MAX_REVIEW_ROUNDS, "setup.rules.reviewRounds", 1)
  const reviewer = roles.reviewer === undefined ? undefined : parseSetupRole(roles.reviewer, "setup.roles.reviewer")
  if (reviewRounds > 0 && reviewer === undefined) invalid("review rounds need a reviewer")
  const check = rules.check === undefined ? undefined : text(rules.check, "setup.rules.check", 4_000)
  return Object.freeze({
    id: item.id,
    name: text(item.name, "setup.name", 80),
    ...(item.description === undefined ? {} : { description: text(item.description, "setup.description", 500) }),
    roles: Object.freeze({
      ...(roles.planner === undefined ? {} : { planner: parseSetupRole(roles.planner, "setup.roles.planner") }),
      executor: parseSetupRole(roles.executor, "setup.roles.executor"),
      ...(reviewer === undefined ? {} : { reviewer }),
    }),
    rules: Object.freeze({
      approvePlan: rules.approvePlan === undefined ? roles.planner !== undefined : rules.approvePlan === true,
      reviewRounds,
      ...(check === undefined ? {} : { check }),
      budget: Object.freeze({ maxTurns: whole(budget.maxTurns, 1, 500, "setup.rules.budget.maxTurns", DEFAULT_BUDGET.maxTurns), maxMinutes: whole(budget.maxMinutes, 1, 24 * 60, "setup.rules.budget.maxMinutes", DEFAULT_BUDGET.maxMinutes) }),
    }),
  })
}

/** A planner's plan: the last fenced json block of its answer. */
export interface SetupPlan {
  readonly summary?: string
  readonly steps: readonly { readonly title: string; readonly detail?: string }[]
}

export const MAX_PLAN_STEPS = 20

export const PLAN_FORMAT = [
  "End your final message with exactly one fenced code block tagged json, and nothing after it, in this shape:",
  "```json",
  '{"summary": "one or two sentences on the approach", "steps": [{"title": "short imperative step", "detail": "what to change and how to know it is done"}]}',
  "```",
  `Use 1 to ${String(MAX_PLAN_STEPS)} steps, each small enough to do and check on its own, in the order they should be done.`,
].join("\n")

export function parsePlanBlock(message: string): SetupPlan | undefined {
  const tail = message.length > 200_000 ? message.slice(-200_000) : message
  const blocks = [...tail.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)]
  const raw = blocks[blocks.length - 1]?.[1]
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return planOf(value as Record<string, unknown>)
}

/** A plan from a planner block or from the person's edit; undefined when it has no usable step. */
export function planOf(value: Record<string, unknown>): SetupPlan | undefined {
  if (!Array.isArray(value.steps)) return undefined
  const steps = value.steps
    .slice(0, MAX_PLAN_STEPS)
    .map((step: unknown) => {
      if (typeof step !== "object" || step === null || Array.isArray(step)) return undefined
      const item = step as Record<string, unknown>
      const title = typeof item.title === "string" ? item.title.trim().slice(0, 200) : ""
      if (title.length === 0) return undefined
      const detail = typeof item.detail === "string" && item.detail.trim().length > 0 ? item.detail.trim().slice(0, 4_000) : undefined
      return detail === undefined ? { title } : { title, detail }
    })
    .filter((step) => step !== undefined)
  if (steps.length === 0) return undefined
  const summary = typeof value.summary === "string" && value.summary.trim().length > 0 ? value.summary.trim().slice(0, 2_000) : undefined
  return { ...(summary === undefined ? {} : { summary }), steps }
}
