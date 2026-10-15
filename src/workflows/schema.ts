import type { RunNode, RunPlan } from "@nifrajs/agent-protocol"
import { parseSetupRole, SETUP_ID, type SetupRole } from "../setups/schema.ts"

/**
 * Workflows: a trigger and a vertical list of steps. Agent and setup steps run as
 * setup runs; a decision reads the agent step before it; a failing check can send its log back to
 * an earlier step. Automations are workflows with a schedule trigger. A workflow an agent
 * proposes is stored as proposed and never runs until the person approves it.
 */

export type WorkflowSchedule =
  | { readonly kind: "interval"; readonly minutes: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekdays"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekly"; readonly day: number; readonly hour: number; readonly minute: number }

export type WorkflowTrigger =
  | { readonly kind: "manual" }
  | { readonly kind: "schedule"; readonly schedule: WorkflowSchedule }
  /** A pull request in this project's repository asks for the person's own review. */
  | { readonly kind: "pr-review-requested" }
  /** A pull request is opened in this project's repository. */
  | { readonly kind: "pr-opened" }
  /** A call to the workflow's own link, which the desktop serves on the person's tailnet. */
  | { readonly kind: "webhook" }

export type WorkflowStep =
  | { readonly id: string; readonly kind: "agent"; readonly title: string; readonly prompt: string; readonly runsOn: SetupRole }
  | { readonly id: string; readonly kind: "setup"; readonly title: string; readonly setupId: string; readonly task: string }
  | { readonly id: string; readonly kind: "check"; readonly title: string; readonly command: string; readonly repeat: number; readonly timeoutMinutes: number; readonly retry?: { readonly step: string; readonly times: number } }
  | { readonly id: string; readonly kind: "decision"; readonly title: string; readonly question: string; readonly stopWhen: "yes" | "no" }
  | { readonly id: string; readonly kind: "approval"; readonly title: string; readonly detail?: string }
  | { readonly id: string; readonly kind: "action"; readonly title: string; readonly action: "open-pr"; readonly draft: boolean }
  | { readonly id: string; readonly kind: "action"; readonly title: string; readonly action: "notify"; readonly text: string }
  | { readonly id: string; readonly kind: "action"; readonly title: string; readonly action: "slack"; readonly channel: string; readonly text: string }

export type WorkflowState = "proposed" | "on" | "off"

export interface Workflow {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly state: WorkflowState
  readonly trigger: WorkflowTrigger
  /** A worktree of its own per run, or the project's checkout. */
  readonly where: "worktree" | "checkout"
  readonly steps: readonly WorkflowStep[]
  readonly budget: { readonly maxMinutes: number }
  /** The thread an agent proposed it from, by title. */
  readonly proposedBy?: { readonly thread: string }
}

export class WorkflowError extends Error {
  constructor(
    readonly code: "WORKFLOW_INVALID" | "WORKFLOW_NOT_FOUND" | "WORKFLOW_PROPOSED" | "WORKFLOW_RUNNING" | "WORKFLOW_RUN_NOT_FOUND" | "WORKFLOW_RUN_NOT_WAITING" | "WORKFLOW_STORE_FAILED",
    message: string,
  ) {
    super(message)
    this.name = "WorkflowError"
  }
}

export const MAX_STEPS = 20
export const MAX_DECISIONS = 8
export const MAX_RETRY = 5
export const MAX_REPEAT = 10
export const DEFAULT_MAX_MINUTES = 120
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CHANNEL = /^[#@]?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function invalid(message: string): never {
  throw new WorkflowError("WORKFLOW_INVALID", message)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${what} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) invalid(`${what} must be text up to ${String(max)} characters`)
  return value.trim()
}

function line(value: unknown, what: string, max: number): string {
  const result = text(value, what, max)
  if (/[\r\n]/.test(result)) invalid(`${what} must be one line`)
  return result
}

function whole(value: unknown, min: number, max: number, what: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${what} must be a whole number from ${String(min)} to ${String(max)}`)
  return value
}

export function parseSchedule(value: unknown, what = "schedule"): WorkflowSchedule {
  const item = record(value, what)
  const hour = (): number => whole(item.hour, 0, 23, `${what}.hour`)
  const minute = (): number => whole(item.minute, 0, 59, `${what}.minute`)
  switch (item.kind) {
    case "interval":
      return { kind: "interval", minutes: whole(item.minutes, 5, 10_080, `${what}.minutes`) }
    case "daily":
      return { kind: "daily", hour: hour(), minute: minute() }
    case "weekdays":
      return { kind: "weekdays", hour: hour(), minute: minute() }
    case "weekly":
      return { kind: "weekly", day: whole(item.day, 0, 6, `${what}.day`), hour: hour(), minute: minute() }
    default:
      return invalid(`${what}.kind must be interval, daily, weekdays or weekly`)
  }
}

export function parseTrigger(value: unknown): WorkflowTrigger {
  const item = record(value ?? { kind: "manual" }, "trigger")
  switch (item.kind) {
    case "manual":
    case "pr-review-requested":
    case "pr-opened":
    case "webhook":
      return { kind: item.kind }
    case "schedule":
      return { kind: "schedule", schedule: parseSchedule(item.schedule, "trigger.schedule") }
    default:
      return invalid("trigger.kind must be manual, schedule, pr-review-requested, pr-opened or webhook")
  }
}

/** One step; `runsOn` fills an agent step that names no route (an agent's proposal). */
function parseStep(value: unknown, where: string, runsOn: SetupRole | undefined): WorkflowStep {
  const item = record(value, where)
  const id = typeof item.id === "string" && ID.test(item.id) ? item.id : invalid(`${where}.id must be 1-64 letters, digits, dots, dashes or underscores`)
  const title = line(item.title, `${where}.title`, 80)
  switch (item.kind) {
    case "agent":
      return { id, kind: "agent", title, prompt: text(item.prompt, `${where}.prompt`, 16_000), runsOn: item.runsOn === undefined && runsOn !== undefined ? runsOn : parseRole(item.runsOn, `${where}.runsOn`) }
    case "setup":
      return { id, kind: "setup", title, setupId: typeof item.setupId === "string" && SETUP_ID.test(item.setupId) ? item.setupId : invalid(`${where}.setupId must name a setup`), task: text(item.task, `${where}.task`, 16_000) }
    case "check": {
      const retry = item.retry === undefined || item.retry === null ? undefined : record(item.retry, `${where}.retry`)
      return {
        id,
        kind: "check",
        title,
        command: line(item.command, `${where}.command`, 4_000),
        repeat: whole(item.repeat, 1, MAX_REPEAT, `${where}.repeat`, 1),
        timeoutMinutes: whole(item.timeoutMinutes, 1, 120, `${where}.timeoutMinutes`, 15),
        ...(retry === undefined ? {} : { retry: { step: typeof retry.step === "string" && ID.test(retry.step) ? retry.step : invalid(`${where}.retry.step must name a step`), times: whole(retry.times, 1, MAX_RETRY, `${where}.retry.times`) } }),
      }
    }
    case "decision":
      return { id, kind: "decision", title, question: line(item.question, `${where}.question`, 300), stopWhen: item.stopWhen === "yes" ? "yes" : item.stopWhen === undefined || item.stopWhen === "no" ? "no" : invalid(`${where}.stopWhen must be yes or no`) }
    case "approval": {
      const detail = item.detail === undefined ? undefined : text(item.detail, `${where}.detail`, 500)
      return { id, kind: "approval", title, ...(detail === undefined ? {} : { detail }) }
    }
    case "action":
      switch (item.action) {
        case "open-pr":
          return { id, kind: "action", title, action: "open-pr", draft: item.draft !== false }
        case "notify":
          return { id, kind: "action", title, action: "notify", text: line(item.text, `${where}.text`, 500) }
        case "slack":
          return { id, kind: "action", title, action: "slack", channel: typeof item.channel === "string" && CHANNEL.test(item.channel) ? item.channel : invalid(`${where}.channel must be a Slack channel name or id`), text: text(item.text, `${where}.text`, 4_000) }
        default:
          return invalid(`${where}.action must be open-pr, notify or slack`)
      }
    default:
      return invalid(`${where}.kind must be agent, setup, check, decision, approval or action`)
  }
}

function parseRole(value: unknown, what: string): SetupRole {
  try {
    return parseSetupRole(value, what)
  } catch (error) {
    return invalid(error instanceof Error ? error.message : `${what} is invalid`)
  }
}

export interface ParseOptions {
  /** What an agent step without `runsOn` runs on. */
  readonly runsOn?: SetupRole
  /** The state a parsed workflow takes when it names none. */
  readonly state?: WorkflowState
}

export function parseWorkflow(value: unknown, options: ParseOptions = {}): Workflow {
  const item = record(value, "workflow")
  const id = typeof item.id === "string" && ID.test(item.id) ? item.id : invalid("workflow.id must be 1-64 letters, digits, dots, dashes or underscores")
  if (!Array.isArray(item.steps) || item.steps.length === 0 || item.steps.length > MAX_STEPS) invalid(`workflow.steps must list 1 to ${String(MAX_STEPS)} steps`)
  const steps = item.steps.map((step: unknown, index: number) => parseStep(step, `workflow.steps[${String(index)}]`, options.runsOn))
  const where = item.where === "checkout" ? "checkout" : item.where === undefined || item.where === "worktree" ? "worktree" : invalid("workflow.where must be worktree or checkout")
  checkOrder(steps, where)
  const state = item.state === undefined ? (options.state ?? "off") : item.state === "proposed" || item.state === "on" || item.state === "off" ? item.state : invalid("workflow.state must be proposed, on or off")
  const budget = record(item.budget ?? {}, "workflow.budget")
  const proposedBy = item.proposedBy === undefined ? undefined : record(item.proposedBy, "workflow.proposedBy")
  const description = item.description === undefined ? undefined : text(item.description, "workflow.description", 500)
  return {
    id,
    name: line(item.name, "workflow.name", 80),
    ...(description === undefined ? {} : { description }),
    state,
    trigger: parseTrigger(item.trigger),
    where,
    steps,
    budget: { maxMinutes: whole(budget.maxMinutes, 1, 24 * 60, "workflow.budget.maxMinutes", DEFAULT_MAX_MINUTES) },
    ...(proposedBy === undefined ? {} : { proposedBy: { thread: line(proposedBy.thread, "workflow.proposedBy.thread", 120) } }),
  }
}

/** Rules between steps, so a saved workflow always compiles and runs as it reads. */
function checkOrder(steps: readonly WorkflowStep[], where: Workflow["where"]): void {
  const seen = new Map<string, WorkflowStep>()
  let decisions = 0
  for (const [index, step] of steps.entries()) {
    if (seen.has(step.id)) invalid(`step ids must differ; ${step.id} is used twice`)
    const before = steps[index - 1]
    if (step.kind === "decision") {
      decisions += 1
      if (before?.kind !== "agent") invalid(`the decision "${step.title}" must follow an agent step, whose answer it reads`)
      if (index === steps.length - 1) invalid(`the decision "${step.title}" needs a step after it`)
    }
    if (step.kind === "check" && step.retry !== undefined) {
      const target = seen.get(step.retry.step)
      if (target === undefined || (target.kind !== "agent" && target.kind !== "setup")) invalid(`the check "${step.title}" can send its log back only to an agent or setup step before it`)
    }
    if (step.kind === "action" && step.action === "open-pr") {
      if (where !== "worktree") invalid("opening a pull request needs the workflow to run in a worktree")
      if (![...seen.values()].some((earlier) => earlier.kind === "approval")) invalid("opening a pull request needs an approval step before it")
    }
    seen.set(step.id, step)
  }
  if (decisions > MAX_DECISIONS) invalid(`a workflow has at most ${String(MAX_DECISIONS)} decisions`)
}

/** A workflow an agent proposed: the last fenced json block with a `workflow` object. */
export function parseProposalBlock(message: string): Record<string, unknown> | undefined {
  const tail = message.length > 200_000 ? message.slice(-200_000) : message
  const blocks = [...tail.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)]
  const raw = blocks[blocks.length - 1]?.[1]
  if (raw === undefined) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    const workflow = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { workflow?: unknown }).workflow : undefined
    return typeof workflow === "object" && workflow !== null && !Array.isArray(workflow) ? (workflow as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The first scheduled time strictly after `from`, in this machine's time zone. */
export function nextRun(schedule: WorkflowSchedule, from: number): number {
  if (schedule.kind === "interval") return from + schedule.minutes * 60_000
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setHours(schedule.hour, schedule.minute)
  if (schedule.kind === "weekly") {
    candidate.setDate(candidate.getDate() + ((schedule.day - candidate.getDay() + 7) % 7))
    if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 7)
    return candidate.getTime()
  }
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)
  if (schedule.kind === "weekdays") while (candidate.getDay() === 0 || candidate.getDay() === 6) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/**
 * The run plan: the steps in order; a decision is a `branch` whose `then` holds the steps after
 * it, and a check that sends its log back is a `retry`.
 */
export function compileWorkflow(workflow: Pick<Workflow, "steps">): RunPlan {
  const nodes = (steps: readonly WorkflowStep[]): RunNode[] => {
    const out: RunNode[] = []
    for (const [index, step] of steps.entries()) {
      if (step.kind === "decision") {
        out.push({ id: step.id, kind: "branch", step: `wf.${step.id}`, then: { id: `${step.id}.then`, kind: "sequence", children: nodes(steps.slice(index + 1)) } })
        return out
      }
      const leaf: RunNode = { id: step.id, kind: "task", step: `wf.${step.id}` }
      out.push(step.kind === "check" && step.retry !== undefined ? { id: `${step.id}.retry`, kind: "retry", attempts: step.retry.times + 1, child: leaf } : leaf)
    }
    return out
  }
  return { version: 1, id: "workflow-run", nodes: [{ id: "workflow", kind: "sequence", children: nodes(workflow.steps) }] }
}

/** The format an agent proposes a workflow in, for a thread that is asked to. */
export const PROPOSAL_FORMAT = [
  "End your final message with exactly one fenced code block tagged json, and nothing after it, in this shape:",
  "```json",
  '{"workflow": {"id": "fix-flaky-tests", "name": "Fix flaky tests weekly", "trigger": {"kind": "schedule", "schedule": {"kind": "weekly", "day": 1, "hour": 9, "minute": 0}}, "steps": [{"id": "find", "kind": "agent", "title": "Find flaky tests", "prompt": "..."}, {"id": "any", "kind": "decision", "title": "Any found?", "question": "Did you find a flaky test?", "stopWhen": "no"}, {"id": "fix", "kind": "agent", "title": "Fix each test", "prompt": "..."}, {"id": "check", "kind": "check", "title": "Run the tests", "command": "bun test", "repeat": 3, "retry": {"step": "fix", "times": 2}}, {"id": "ok", "kind": "approval", "title": "Approve the diff"}, {"id": "pr", "kind": "action", "title": "Open a draft pull request", "action": "open-pr"}]}}',
  "```",
  "Triggers: manual; schedule (interval minutes, daily, weekdays or weekly at hour and minute); pr-review-requested; pr-opened; webhook (a call to the workflow's own link; agent steps see what it sent). Step kinds: agent, setup (a saved setup's id and a task), check, decision (after an agent step; stopWhen yes or no), approval, action (open-pr after an approval, notify with text, slack with channel and text).",
].join("\n")
