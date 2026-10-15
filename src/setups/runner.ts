import { randomUUID } from "node:crypto"
import type { RunPlan } from "@nifrajs/agent-protocol"
import type { CheckResult } from "../check/run.ts"
import { RunrailPlanRunner } from "../plan-runner.ts"
import { PLAN_FORMAT, parsePlanBlock, planOf, SetupError, type Setup, type SetupAccess, type SetupPlan, type SetupRole, type SetupRoleName } from "./schema.ts"

/**
 * A setup run: plan, approve, execute step by step with a check after each, then review
 * and fix for the setup's rounds. The engine decides every next step. A coding-tool turn is
 * handed to a `SetupTurnPort`: the desktop runs it as a thread the person can watch, or a headless
 * port runs it in process. Prompts and answers live only in memory, for the run's life.
 */

export interface SetupTurnRequest {
  readonly stepId: string
  readonly role: SetupRoleName
  /** The same key continues the same thread. */
  readonly thread: string
  readonly runsOn: SetupRole
  /** Planner and reviewer read only; the executor works with the role's access. */
  readonly mode: "plan" | "agent"
  readonly access: SetupAccess
  readonly title: string
  readonly prompt: string
  /** Set when the run was started in a worktree of the engine's choosing (evals); threads go there. */
  readonly worktree?: SetupWorktree
  /** The run works in the project's checkout, not a worktree (a workflow that asks for that). */
  readonly checkout?: true
}

export interface SetupWorktree {
  readonly id: string
  readonly path: string
  readonly cwd: string
  readonly branch?: string
}

export interface SetupTurnAnswer {
  readonly ok: boolean
  /** The turn's last answer. */
  readonly text?: string
  /** The worktree the run works in; the first turn's answer names it. */
  readonly worktree?: string
  readonly error?: string
}

export interface SetupTurnPort {
  turn(runId: string, request: SetupTurnRequest, signal: AbortSignal): Promise<SetupTurnAnswer>
}

export interface SetupApproval {
  readonly approved: boolean
  /** The plan as the person edited or reordered it. */
  readonly plan?: SetupPlan
  /** Sent back to the planner when not approved. */
  readonly feedback?: string
}

export type SetupRunState = "running" | "waiting" | "succeeded" | "failed" | "stopped"
export type SetupStepKind = "plan" | "approve" | "step" | "check" | "review" | "fix"

export interface SetupRunStep {
  readonly id: string
  readonly kind: SetupStepKind
  readonly title: string
  status: "running" | "done" | "failed" | "skipped"
  role?: SetupRoleName
  thread?: string
  /** One short line: a check's counts, a review's finding count. Never an answer's text. */
  note?: string
}

/** What started a run that is part of something larger: a workflow run's step. */
export interface SetupRunOwner {
  readonly kind: "workflow"
  readonly runId: string
  readonly name: string
}

export type SetupWaiting = ({ readonly kind: "turn" } & SetupTurnRequest) | { readonly kind: "approve"; readonly stepId: string; readonly plan: SetupPlan }

export interface SetupRunStatus {
  readonly runId: string
  readonly setupId: string
  readonly setupName: string
  readonly task: string
  readonly state: SetupRunState
  readonly startedAt: number
  readonly endedAt?: number
  readonly turns: number
  readonly worktree?: string
  /** It works in the project's checkout, not a worktree. */
  readonly checkout?: true
  readonly plan?: SetupPlan
  readonly steps: readonly SetupRunStep[]
  readonly waiting?: SetupWaiting
  readonly error?: { readonly code: string; readonly message: string }
  readonly owner?: SetupRunOwner
}

export interface SetupStartOptions {
  readonly worktree?: SetupWorktree
  readonly checkout?: boolean
  readonly owner?: SetupRunOwner
}

export interface SetupRunsOptions {
  /** Runs the setup's check in a given checkout's folder (an eval's), the run's worktree, or the project's checkout. */
  readonly check: (input: { readonly id: string; readonly worktree?: string; readonly cwd?: string; readonly command: string }) => Promise<CheckResult>
  readonly stopCheck?: (id: string) => Promise<unknown>
  readonly now?: () => number
  readonly maxRuns?: number
}

const MAX_SEND_BACKS = 3
const MAX_KEPT_RUNS = 32
const CHECK_TAIL_FOR_PROMPT = 8_000

class RunStopped extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface Run {
  readonly id: string
  readonly setup: Setup
  readonly task: string
  readonly controller: AbortController
  readonly startedAt: number
  readonly given?: SetupWorktree
  readonly checkout: boolean
  readonly owner?: SetupRunOwner
  state: SetupRunState
  endedAt?: number
  turns: number
  worktree?: string
  plan?: SetupPlan
  steps: SetupRunStep[]
  waiting?: SetupWaiting
  resolve?: (value: SetupTurnAnswer | SetupApproval) => void
  error?: { readonly code: string; readonly message: string }
  checkId?: string
  /** The latest check's verdict; a run that ends on a failing check has not succeeded. */
  lastCheckPassed?: boolean
  settled: Promise<void>
}

/** Runs setups in this project. A run waits on the desktop for each turn through `pending`. */
export class SetupRuns {
  readonly #runs = new Map<string, Run>()
  readonly #now: () => number

  constructor(private readonly options: SetupRunsOptions) {
    this.#now = options.now ?? Date.now
  }

  /** The default port: a turn waits in the run's status until `answer` brings its result. */
  readonly pending: SetupTurnPort = {
    turn: (runId, request, signal) => this.#wait<SetupTurnAnswer>(runId, { kind: "turn", ...request }, signal),
  }

  start(setup: Setup, task: string, port: SetupTurnPort = this.pending, options: SetupStartOptions = {}): SetupRunStatus {
    const running = [...this.#runs.values()].filter((run) => run.state === "running" || run.state === "waiting").length
    if (running >= (this.options.maxRuns ?? 4)) throw new SetupError("SETUP_LIMIT", "too many setup runs at once in this project; stop one first")
    const id = `setup-${randomUUID()}`
    const run: Run = {
      id,
      setup,
      task,
      controller: new AbortController(),
      startedAt: this.#now(),
      checkout: options.checkout === true && options.worktree === undefined,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      state: "running",
      turns: 0,
      steps: [],
      settled: Promise.resolve(),
      ...(options.worktree === undefined ? {} : { given: options.worktree, worktree: options.worktree.id }),
    }
    this.#runs.set(id, run)
    this.#prune()
    run.settled = this.#execute(run, port)
    return this.status(id)
  }

  status(runId: string): SetupRunStatus {
    const run = this.#find(runId)
    return {
      runId: run.id,
      setupId: run.setup.id,
      setupName: run.setup.name,
      task: run.task,
      state: run.state,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      turns: run.turns,
      ...(run.worktree === undefined ? {} : { worktree: run.worktree }),
      ...(run.checkout ? { checkout: true as const } : {}),
      ...(run.plan === undefined ? {} : { plan: run.plan }),
      steps: run.steps.map((step) => ({ ...step })),
      ...(run.waiting === undefined ? {} : { waiting: run.waiting }),
      ...(run.error === undefined ? {} : { error: run.error }),
      ...(run.owner === undefined ? {} : { owner: run.owner }),
    }
  }

  /** Resolves when the run has ended, however it ended. */
  async settled(runId: string): Promise<SetupRunStatus> {
    await this.#find(runId).settled
    return this.status(runId)
  }

  list(): readonly SetupRunStatus[] {
    return [...this.#runs.keys()].map((id) => this.status(id)).sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Brings a waiting turn's result or the person's answer on the plan. */
  answer(runId: string, stepId: string, value: unknown): SetupRunStatus {
    const run = this.#find(runId)
    const waiting = run.waiting
    if (waiting === undefined || waiting.stepId !== stepId || run.resolve === undefined) throw new SetupError("SETUP_RUN_NOT_WAITING", "the run is not waiting on that step")
    const item = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
    const resolve = run.resolve
    run.waiting = undefined
    run.resolve = undefined
    run.state = "running"
    if (waiting.kind === "approve") {
      const plan = typeof item.plan === "object" && item.plan !== null && !Array.isArray(item.plan) ? planOf(item.plan as Record<string, unknown>) : undefined
      const feedback = typeof item.feedback === "string" && item.feedback.trim().length > 0 ? item.feedback.trim().slice(0, 4_000) : undefined
      resolve({ approved: item.approved === true, ...(plan === undefined ? {} : { plan }), ...(feedback === undefined ? {} : { feedback }) })
    } else {
      const worktree = typeof item.worktree === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.worktree) ? item.worktree : undefined
      const text = typeof item.text === "string" ? item.text.slice(-200_000) : undefined
      const error = typeof item.error === "string" ? item.error.slice(0, 500) : undefined
      resolve({ ok: item.ok === true, ...(text === undefined ? {} : { text }), ...(worktree === undefined ? {} : { worktree }), ...(error === undefined ? {} : { error }) })
    }
    return this.status(runId)
  }

  async stop(runId: string): Promise<SetupRunStatus> {
    const run = this.#find(runId)
    if (run.state === "running" || run.state === "waiting") {
      run.controller.abort(new RunStopped("SETUP_STOPPED", "the person stopped the run"))
      if (run.checkId !== undefined) await this.options.stopCheck?.(run.checkId)
      await run.settled
    }
    return this.status(runId)
  }

  async close(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((id) => this.stop(id).catch(() => undefined)))
  }

  #find(runId: string): Run {
    const run = typeof runId === "string" ? this.#runs.get(runId) : undefined
    if (run === undefined) throw new SetupError("SETUP_RUN_NOT_FOUND", "no setup run has that id")
    return run
  }

  #prune(): void {
    const ended = [...this.#runs.values()].filter((run) => run.endedAt !== undefined).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    while (this.#runs.size > MAX_KEPT_RUNS && ended.length > 0) {
      const oldest = ended.shift()
      if (oldest !== undefined) this.#runs.delete(oldest.id)
    }
  }

  #wait<T extends SetupTurnAnswer | SetupApproval>(runId: string, waiting: SetupWaiting, signal: AbortSignal): Promise<T> {
    const run = this.#find(runId)
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason as Error)
      const abort = (): void => {
        run.waiting = undefined
        run.resolve = undefined
        reject(signal.reason as Error)
      }
      signal.addEventListener("abort", abort, { once: true })
      run.waiting = waiting
      run.state = "waiting"
      run.resolve = (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value as T)
      }
    })
  }

  async #execute(run: Run, port: SetupTurnPort): Promise<void> {
    const signal = run.controller.signal
    const deadline = run.startedAt + run.setup.rules.budget.maxMinutes * 60_000
    const budgetTimer = setTimeout(() => run.controller.abort(new RunStopped("SETUP_BUDGET", `the run reached its ${String(run.setup.rules.budget.maxMinutes)}-minute budget`)), Math.max(0, deadline - this.#now()))
    const step = (kind: SetupStepKind, title: string, role?: SetupRoleName): SetupRunStep => {
      const entry: SetupRunStep = { id: `${String(run.steps.length + 1)}`, kind, title, status: "running", ...(role === undefined ? {} : { role, thread: `${run.id}:${role}` }) }
      run.steps.push(entry)
      return entry
    }
    const turn = async (entry: SetupRunStep, role: SetupRoleName, prompt: string): Promise<string> => {
      const runsOn = role === "planner" ? run.setup.roles.planner : role === "reviewer" ? run.setup.roles.reviewer : run.setup.roles.executor
      if (runsOn === undefined) throw new RunStopped("SETUP_INVALID", `the setup has no ${role}`)
      if (run.turns >= run.setup.rules.budget.maxTurns) throw new RunStopped("SETUP_BUDGET", `the run reached its budget of ${String(run.setup.rules.budget.maxTurns)} turns`)
      run.turns += 1
      const answer = await port.turn(
        run.id,
        { stepId: `${entry.id}-${String(run.turns)}`, role, thread: `${run.id}:${role}`, runsOn, mode: role === "executor" ? "agent" : "plan", access: role === "executor" ? (runsOn.access ?? "ask") : "ask", title: `${run.setup.name}: ${role}`, prompt, ...(run.given === undefined ? {} : { worktree: run.given }), ...(run.checkout ? { checkout: true as const } : {}) },
        signal,
      )
      if (answer.worktree !== undefined) run.worktree ??= answer.worktree
      if (!answer.ok) throw new RunStopped("SETUP_TURN_FAILED", `the ${role}'s turn did not finish${answer.error === undefined ? "" : `: ${answer.error}`}`)
      return answer.text ?? ""
    }
    const check = async (title: string): Promise<CheckResult | undefined> => {
      const command = run.setup.rules.check
      if (command === undefined) return undefined
      const entry = step("check", title)
      if (run.worktree === undefined && !run.checkout) {
        entry.status = "skipped"
        entry.note = "no worktree to check"
        return undefined
      }
      run.checkId = `${run.id.slice(0, 40)}-c${entry.id}`
      try {
        const where = run.given !== undefined ? { cwd: run.given.cwd } : run.worktree === undefined ? {} : { worktree: run.worktree }
        const result = await this.options.check({ id: run.checkId, ...where, command })
        if (signal.aborted) throw signal.reason as Error
        entry.status = result.passed ? "done" : "failed"
        entry.note = checkNote(result)
        run.lastCheckPassed = result.passed
        return result
      } finally {
        run.checkId = undefined
      }
    }

    const plan = new RunrailPlanRunner({
      catalog: {
        "setup.plan": { kind: "task", run: async () => this.#plan(run, step, turn) },
        "setup.approve": { kind: "task", run: async () => this.#approve(run, step, turn) },
        "setup.execute": { kind: "task", run: async () => this.#steps(run, step, turn, check) },
        "setup.review": { kind: "task", run: async () => this.#review(run, step, turn, check) },
      },
    })
    const nodes: RunPlan["nodes"] = [
      {
        id: "setup",
        kind: "sequence",
        children: [
          ...(run.setup.roles.planner === undefined ? [] : [{ id: "plan", kind: "task" as const, step: "setup.plan" }]),
          ...(run.setup.roles.planner !== undefined && run.setup.rules.approvePlan ? [{ id: "approve", kind: "task" as const, step: "setup.approve" }] : []),
          { id: "execute", kind: "task" as const, step: "setup.execute" },
          ...(run.setup.rules.reviewRounds > 0 ? [{ id: "review", kind: "task" as const, step: "setup.review" }] : []),
        ],
      },
    ]
    try {
      const result = await plan.run({ version: 1, id: "setup-run", nodes }, { runId: run.id, signal })
      if (result.status === "succeeded" && run.lastCheckPassed === false) throw new RunStopped("SETUP_CHECK_FAILED", "the check still fails after the fix and review rounds")
      if (result.status === "succeeded") run.state = "succeeded"
      else throw signal.aborted ? (signal.reason as Error) : new RunStopped(result.failureCode ?? "SETUP_FAILED", run.error?.message ?? "the run failed")
    } catch (error) {
      const stopped = error instanceof RunStopped ? error : signal.aborted && signal.reason instanceof RunStopped ? signal.reason : undefined
      run.state = stopped?.code === "SETUP_STOPPED" ? "stopped" : "failed"
      run.error ??= stopped === undefined ? { code: "SETUP_FAILED", message: "the run failed" } : { code: stopped.code, message: stopped.message }
    } finally {
      clearTimeout(budgetTimer)
      for (const entry of run.steps) if (entry.status === "running") entry.status = run.state === "succeeded" ? "done" : "failed"
      run.waiting = undefined
      run.resolve = undefined
      run.endedAt = this.#now()
    }
  }

  // Each step keeps its own error on the run: Nifra's result carries only a code.
  async #guard<T>(run: Run, work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (error instanceof RunStopped) run.error ??= { code: error.code, message: error.message }
      else if (!run.controller.signal.aborted) run.error ??= { code: "SETUP_FAILED", message: "the run failed" }
      throw error
    }
  }

  #plan(run: Run, step: StepFn, turn: TurnFn): Promise<void> {
    return this.#guard(run, async () => {
      const entry = step("plan", "Plan", "planner")
      let text = await turn(entry, "planner", planPrompt(run.task))
      let parsed = parsePlanBlock(text)
      // One more ask for the format before the run gives up on the plan.
      if (parsed === undefined) {
        text = await turn(entry, "planner", `End your answer with the plan block, as asked.\n\n${PLAN_FORMAT}`)
        parsed = parsePlanBlock(text)
      }
      if (parsed === undefined) {
        entry.status = "failed"
        throw new RunStopped("SETUP_PLAN_FORMAT", "the planner did not end with a plan in the expected format")
      }
      run.plan = parsed
      entry.status = "done"
      entry.note = `${String(parsed.steps.length)} step${parsed.steps.length === 1 ? "" : "s"}`
    })
  }

  #approve(run: Run, step: StepFn, turn: TurnFn): Promise<void> {
    return this.#guard(run, async () => {
      for (let round = 0; ; round += 1) {
        const plan = run.plan
        if (plan === undefined) throw new RunStopped("SETUP_FAILED", "there is no plan to approve")
        const entry = step("approve", "Approve the plan")
        const answer = await this.#wait<SetupApproval>(run.id, { kind: "approve", stepId: `approve-${entry.id}`, plan }, run.controller.signal)
        if (answer.approved) {
          if (answer.plan !== undefined) run.plan = answer.plan
          entry.status = "done"
          return
        }
        entry.status = "failed"
        entry.note = "sent back"
        if (answer.feedback === undefined || round + 1 >= MAX_SEND_BACKS) throw new RunStopped("SETUP_PLAN_DECLINED", "the plan was declined")
        const revise = step("plan", "Revise the plan", "planner")
        const revised = parsePlanBlock(await turn(revise, "planner", `The plan was sent back with this note:\n\n${answer.feedback}\n\nRevise it.\n\n${PLAN_FORMAT}`))
        if (revised === undefined) {
          revise.status = "failed"
          throw new RunStopped("SETUP_PLAN_FORMAT", "the planner did not end with a plan in the expected format")
        }
        run.plan = revised
        revise.status = "done"
        revise.note = `${String(revised.steps.length)} step${revised.steps.length === 1 ? "" : "s"}`
      }
    })
  }

  #steps(run: Run, step: StepFn, turn: TurnFn, check: CheckFn): Promise<void> {
    return this.#guard(run, async () => {
      const steps = run.plan?.steps ?? [{ title: taskTitle(run.task) }]
      for (const [index, item] of steps.entries()) {
        const entry = step("step", `${String(index + 1)}. ${item.title}`, "executor")
        await turn(entry, "executor", stepPrompt(run.task, run.plan, index))
        entry.status = "done"
        const result = await check(`Check after step ${String(index + 1)}`)
        if (result === undefined || result.passed) continue
        // One fix per step; what still fails is left to the review rounds.
        const fix = step("fix", `Fix step ${String(index + 1)}'s check`, "executor")
        await turn(fix, "executor", checkFailurePrompt(run.setup.rules.check ?? "", result))
        fix.status = "done"
        await check(`Check after the fix`)
      }
    })
  }

  #review(run: Run, step: StepFn, turn: TurnFn, check: CheckFn): Promise<void> {
    return this.#guard(run, async () => {
      for (let round = 1; round <= run.setup.rules.reviewRounds; round += 1) {
        const entry = step("review", `Review, round ${String(round)}`, "reviewer")
        const findings = parseReviewBlock(await turn(entry, "reviewer", reviewPrompt(run.task, run.plan)))
        if (findings === undefined) {
          entry.status = "failed"
          entry.note = "no findings block"
          return
        }
        const blocking = findings.filter((finding) => finding.severity === "high" || finding.severity === "medium")
        entry.status = "done"
        entry.note = blocking.length === 0 ? "nothing blocking" : `${String(blocking.length)} to fix`
        if (blocking.length === 0) return
        const fix = step("fix", `Fix the review, round ${String(round)}`, "executor")
        await turn(fix, "executor", fixPrompt(blocking))
        fix.status = "done"
        await check(`Check after round ${String(round)}`)
      }
    })
  }
}

type StepFn = (kind: SetupStepKind, title: string, role?: SetupRoleName) => SetupRunStep
type TurnFn = (entry: SetupRunStep, role: SetupRoleName, prompt: string) => Promise<string>
type CheckFn = (title: string) => Promise<CheckResult | undefined>

/** A planless run's one step is named by the task's first line, bounded like a planner's step titles. */
function taskTitle(task: string): string {
  return (task.split("\n").find((line) => line.trim().length > 0) ?? task).trim().slice(0, 200)
}

function checkNote(result: CheckResult): string {
  if (result.timedOut) return "timed out"
  if (result.stopped) return "stopped"
  const counts = result.counts
  if (result.passed) return counts === undefined ? "passed" : `passed ${String(counts.passed)}/${String(counts.total)}`
  return counts !== undefined && counts.failed > 0 ? `failed ${String(counts.failed)} of ${String(counts.total)}` : `failed${result.exitCode === undefined ? "" : ` (exit ${String(result.exitCode)})`}`
}

export function planPrompt(task: string): string {
  return [
    "Plan this task. Read the code you need; do not change anything.",
    "",
    task,
    "",
    PLAN_FORMAT,
  ].join("\n")
}

export function stepPrompt(task: string, plan: SetupPlan | undefined, index: number): string {
  if (plan === undefined) return task
  const current = plan.steps[index]
  const list = plan.steps.map((item, at) => `${String(at + 1)}. ${item.title}`).join("\n")
  return [
    ...(index === 0 ? ["The task:", "", task, "", "The approved plan:", "", list, ""] : []),
    `Do step ${String(index + 1)} of ${String(plan.steps.length)}: ${current?.title ?? ""}`,
    ...(current?.detail === undefined ? [] : ["", current.detail]),
    "",
    "Do only this step, then stop. Runrail runs the checks after it.",
  ].join("\n")
}

export function checkFailurePrompt(command: string, result: CheckResult): string {
  const tail = result.tail.length > CHECK_TAIL_FOR_PROMPT ? result.tail.slice(-CHECK_TAIL_FOR_PROMPT) : result.tail
  const fence = tail.includes("```") ? "~~~~" : "```"
  return [`The check \`${command}\` ${checkNote(result)}. The end of its output:`, "", fence, tail, fence, "", "Fix what it reports, then stop."].join("\n")
}

const REVIEW_FORMAT = [
  "End your final message with exactly one fenced code block tagged json, and nothing after it, in this shape:",
  "```json",
  '{"summary": "one or two sentences", "findings": [{"severity": "high", "path": "src/file.ts", "line": 42, "title": "short statement of the problem", "body": "why it matters and what to do"}]}',
  "```",
  "severity is high, medium, or low. Use an empty findings list when nothing needs fixing.",
].join("\n")

export function reviewPrompt(task: string, plan: SetupPlan | undefined): string {
  return [
    "Review the changes in this worktree (compare with the commit it started from, for example `git diff HEAD`) against the task below. You are reviewing only: do not edit files.",
    "",
    task,
    ...(plan === undefined ? [] : ["", "The plan it followed:", "", ...plan.steps.map((item, at) => `${String(at + 1)}. ${item.title}`)]),
    "",
    "Look for bugs, missing tests, and anything the task asked for that is not done. Skip style nits.",
    "",
    REVIEW_FORMAT,
  ].join("\n")
}

export interface SetupFinding {
  readonly severity: "high" | "medium" | "low"
  readonly title: string
  readonly body?: string
  readonly path?: string
  readonly line?: number
}

export function parseReviewBlock(message: string): readonly SetupFinding[] | undefined {
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
  const list = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { findings?: unknown }).findings : undefined
  if (!Array.isArray(list)) return undefined
  return list.slice(0, 50).flatMap((entry: unknown): SetupFinding[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    const severity = item.severity === "high" || item.severity === "medium" || item.severity === "low" ? item.severity : undefined
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 200) : ""
    if (severity === undefined || title.length === 0) return []
    const body = typeof item.body === "string" && item.body.trim().length > 0 ? item.body.trim().slice(0, 4_000) : undefined
    const path = typeof item.path === "string" && /^[^\0\r\n]{1,1024}$/.test(item.path) ? item.path : undefined
    const line = path !== undefined && typeof item.line === "number" && Number.isSafeInteger(item.line) && item.line > 0 ? item.line : undefined
    return [{ severity, title, ...(body === undefined ? {} : { body }), ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }) }]
  })
}

export function fixPrompt(findings: readonly SetupFinding[]): string {
  return [
    "A review of your changes found these. Fix each one that holds, then stop.",
    "",
    ...findings.map((finding, index) => `${String(index + 1)}. [${finding.severity}] ${finding.title}${finding.path === undefined ? "" : ` (${finding.path}${finding.line === undefined ? "" : `:${String(finding.line)}`})`}${finding.body === undefined ? "" : `\n   ${finding.body.replace(/\s*\n\s*/g, " ")}`}`),
  ].join("\n")
}
