import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { FileLockError, withFileLock } from "../auth/lock.ts"
import { nextRun, parseWorkflow, WorkflowError, type Workflow, type WorkflowState, type WorkflowTrigger } from "./schema.ts"

/**
 * Every project's workflows in one file, `~/.runrail/workflows.json`, so the app-wide engine can
 * tell what is due without starting each project's engine. A run's record keeps ids, states,
 * counts and times only.
 */

export type WorkflowRunState = "running" | "waiting" | "succeeded" | "failed" | "stopped"

export interface WorkflowRunRecord {
  readonly runId: string
  readonly trigger: WorkflowTrigger["kind"]
  readonly pr?: number
  readonly state: WorkflowRunState
  readonly startedAt: number
  readonly endedAt?: number
  readonly steps: readonly { readonly id: string; readonly status: string; readonly note?: string }[]
  /** An error code, never its message. */
  readonly error?: string
}

export interface StoredWorkflow extends Workflow {
  /** The project's key (`projectKey`): a worktree's engine finds its checkout's workflows. */
  readonly project: string
  /** The project's folder when it was last saved, so the app can tell which project it is. */
  readonly root: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly enabledAt?: number
  /** When a schedule last started it. */
  readonly firedAt?: number
  /** Pull requests a PR trigger has seen, so each starts one run. */
  readonly watch?: { readonly polledAt: number; readonly seen: readonly number[] }
  readonly runs: readonly WorkflowRunRecord[]
}

export interface PullRequestRef {
  readonly number: number
  readonly title?: string
  readonly url?: string
}

export interface DueRun {
  readonly workflowId: string
  readonly name: string
  readonly root: string
  readonly trigger: WorkflowTrigger["kind"]
  readonly pr?: PullRequestRef
}

/** Workflows that start by themselves, and the next scheduled start. */
export interface Upcoming {
  readonly armed: number
  readonly next?: { readonly workflowId: string; readonly name: string; readonly root: string; readonly at: number }
}

export const MAX_WORKFLOWS = 256
const MAX_RUNS_KEPT = 20
const MAX_SEEN = 200
const MAX_PR_RUNS_PER_POLL = 3
/** A PR trigger asks GitHub at most this often. */
export const PR_POLL_MS = 5 * 60_000

export class WorkflowStore {
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async list(project?: string): Promise<readonly StoredWorkflow[]> {
    const all = await this.#read()
    return project === undefined ? all : all.filter((item) => item.project === project)
  }

  async get(id: string, project?: string): Promise<StoredWorkflow> {
    const found = (await this.#read()).find((item) => item.id === id && (project === undefined || item.project === project))
    if (found === undefined) throw new WorkflowError("WORKFLOW_NOT_FOUND", "no workflow has that id")
    return found
  }

  /** Adds or replaces a workflow, keeping its history; turning it on starts its trigger from now. */
  save(workflow: Workflow, where: { readonly project: string; readonly root: string }, now = Date.now()): Promise<StoredWorkflow> {
    return this.#change((all) => {
      const index = all.findIndex((item) => item.id === workflow.id)
      const before = index < 0 ? undefined : all[index]
      if (before !== undefined && before.project !== where.project) throw new WorkflowError("WORKFLOW_INVALID", "another project has a workflow with that id")
      if (before === undefined && all.length >= MAX_WORKFLOWS) throw new WorkflowError("WORKFLOW_INVALID", `there are already ${String(MAX_WORKFLOWS)} workflows`)
      const sameTrigger = before !== undefined && JSON.stringify(before.trigger) === JSON.stringify(workflow.trigger)
      const turnedOn = workflow.state === "on" && before?.state !== "on"
      const saved: StoredWorkflow = {
        ...plainOf(workflow),
        project: where.project,
        root: where.root,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
        ...(workflow.state !== "on" ? {} : turnedOn || !sameTrigger ? { enabledAt: now } : before?.enabledAt === undefined ? {} : { enabledAt: before.enabledAt }),
        ...(sameTrigger && !turnedOn && before?.firedAt !== undefined ? { firedAt: before.firedAt } : {}),
        ...(sameTrigger && !turnedOn && before?.watch !== undefined ? { watch: before.watch } : {}),
        runs: before?.runs ?? [],
      }
      return { all: index < 0 ? [...all, saved] : all.map((item, at) => (at === index ? saved : item)), result: saved }
    })
  }

  async setState(id: string, project: string, state: WorkflowState, now = Date.now()): Promise<StoredWorkflow> {
    const current = await this.get(id, project)
    return this.save({ ...current, state }, { project, root: current.root }, now)
  }

  delete(id: string, project: string): Promise<{ readonly deleted: boolean }> {
    return this.#change((all) => {
      const kept = all.filter((item) => !(item.id === id && item.project === project))
      return { all: kept, result: { deleted: kept.length !== all.length } }
    })
  }

  /** Adds or updates a run's record, newest first. */
  record(id: string, run: WorkflowRunRecord): Promise<void> {
    return this.#change((all) => ({
      all: all.map((item) => (item.id === id ? { ...item, runs: [run, ...item.runs.filter((entry) => entry.runId !== run.runId)].slice(0, MAX_RUNS_KEPT) } : item)),
      result: undefined,
    }))
  }

  /** Read only: workflows on with a schedule or a PR trigger, and when the soonest schedule fires. */
  async upcoming(now: number): Promise<Upcoming> {
    let armed = 0
    let next: Upcoming["next"]
    for (const item of await this.#read()) {
      if (item.state !== "on" || item.trigger.kind === "manual") continue
      armed += 1
      if (item.trigger.kind !== "schedule") continue
      // A slot missed while nothing asked fires on the next ask, so it is shown as now.
      const at = Math.max(now, nextRun(item.trigger.schedule, item.firedAt ?? item.enabledAt ?? item.createdAt))
      if (next === undefined || at < next.at) next = { workflowId: item.id, name: item.name, root: item.root, at }
    }
    return { armed, ...(next === undefined ? {} : { next }) }
  }

  /**
   * What is due now, marked as started so it starts once (a run missed while the app was
   * closed starts once on the next tick). A PR trigger's first look only learns what is open.
   */
  async due(now: number, listPullRequests: (root: string, trigger: "pr-review-requested" | "pr-opened") => Promise<readonly PullRequestRef[]>): Promise<readonly DueRun[]> {
    const polls = await this.#poll(now, listPullRequests)
    return this.#change((all) => {
      const { all: next, due } = settle(all, now, polls)
      return { all: next, result: due }
    })
  }

  /**
   * What `due` would start now, marking nothing: the wake service only looks, and
   * the app it opens starts the runs. Without `listPullRequests`, PR triggers are not asked.
   */
  async peek(now: number, listPullRequests?: (root: string, trigger: "pr-review-requested" | "pr-opened") => Promise<readonly PullRequestRef[]>): Promise<readonly DueRun[]> {
    const polls = listPullRequests === undefined ? new Map<string, readonly PullRequestRef[] | undefined>() : await this.#poll(now, listPullRequests)
    return settle(await this.#read(), now, polls).due
  }

  async #poll(now: number, listPullRequests: (root: string, trigger: "pr-review-requested" | "pr-opened") => Promise<readonly PullRequestRef[]>): Promise<Map<string, readonly PullRequestRef[] | undefined>> {
    const polls = new Map<string, readonly PullRequestRef[] | undefined>()
    for (const item of await this.#read()) {
      if (item.state !== "on" || (item.trigger.kind !== "pr-review-requested" && item.trigger.kind !== "pr-opened")) continue
      if (item.watch !== undefined && now - item.watch.polledAt < PR_POLL_MS) continue
      polls.set(item.id, await listPullRequests(item.root, item.trigger.kind).catch(() => undefined))
    }
    return polls
  }

  #change<T>(work: (all: readonly StoredWorkflow[]) => { readonly all: readonly StoredWorkflow[]; readonly result: T }): Promise<T> {
    // Several engines share this file, so each read-modify-write holds a lock every process honours.
    const next = this.#queue.then(() => withFileLock(`${this.path}.lock`, async () => {
      const { all, result } = work(await this.#read())
      await this.#write(all)
      return result
    }).catch((error: unknown) => {
      if (error instanceof FileLockError) throw new WorkflowError("WORKFLOW_STORE_FAILED", "the workflows file is busy")
      throw error
    }))
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #read(): Promise<readonly StoredWorkflow[]> {
    let text: string
    try {
      text = await readFile(this.path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw new WorkflowError("WORKFLOW_STORE_FAILED", "the workflows file could not be read")
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new WorkflowError("WORKFLOW_STORE_FAILED", "the workflows file is not valid JSON")
    }
    const list = typeof parsed === "object" && parsed !== null ? (parsed as { workflows?: unknown }).workflows : undefined
    if (!Array.isArray(list)) return []
    return list.slice(0, MAX_WORKFLOWS).flatMap((entry: unknown) => {
      const stored = storedOf(entry)
      return stored === undefined ? [] : [stored]
    })
  }

  async #write(all: readonly StoredWorkflow[]): Promise<void> {
    const temporary = `${this.path}.${randomBytes(8).toString("hex")}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, `${JSON.stringify({ version: 1, workflows: all }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
      await rename(temporary, this.path)
    } catch {
      await unlink(temporary).catch(() => undefined)
      throw new WorkflowError("WORKFLOW_STORE_FAILED", "the workflows file could not be written")
    }
  }
}

/** What is due at `now` given the PR lists just read, and the workflows marked as started. */
function settle(all: readonly StoredWorkflow[], now: number, polls: ReadonlyMap<string, readonly PullRequestRef[] | undefined>): { readonly all: readonly StoredWorkflow[]; readonly due: readonly DueRun[] } {
  const due: DueRun[] = []
  const next = all.map((item): StoredWorkflow => {
    if (item.state !== "on") return item
    if (item.trigger.kind === "schedule") {
      if (nextRun(item.trigger.schedule, item.firedAt ?? item.enabledAt ?? item.createdAt) > now) return item
      due.push({ workflowId: item.id, name: item.name, root: item.root, trigger: "schedule" })
      return { ...item, firedAt: now }
    }
    if (!polls.has(item.id)) return item
    const open = polls.get(item.id)
    if (open === undefined) return { ...item, watch: { polledAt: now, seen: item.watch?.seen ?? [] } }
    const seen = new Set(item.watch?.seen ?? [])
    if (item.watch !== undefined) {
      for (const pr of open.filter((entry) => !seen.has(entry.number)).slice(0, MAX_PR_RUNS_PER_POLL)) {
        due.push({ workflowId: item.id, name: item.name, root: item.root, trigger: item.trigger.kind, pr })
        seen.add(pr.number)
      }
    } else for (const pr of open) seen.add(pr.number)
    return { ...item, watch: { polledAt: now, seen: [...seen].slice(-MAX_SEEN) } }
  })
  return { all: next, due }
}

/** The workflow alone, without what the store keeps beside it. */
function plainOf(workflow: Workflow): Workflow {
  const { id, name, description, state, trigger, where, steps, budget, proposedBy } = workflow
  return { id, name, ...(description === undefined ? {} : { description }), state, trigger, where, steps, budget, ...(proposedBy === undefined ? {} : { proposedBy }) }
}

/** A stored entry, or nothing when it no longer parses: one bad entry never hides the rest. */
function storedOf(value: unknown): StoredWorkflow | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const number = (field: unknown): number | undefined => (typeof field === "number" && Number.isFinite(field) ? field : undefined)
  if (typeof item.project !== "string" || typeof item.root !== "string" || number(item.createdAt) === undefined) return undefined
  let workflow: Workflow
  try {
    workflow = parseWorkflow(item)
  } catch {
    return undefined
  }
  const watch = typeof item.watch === "object" && item.watch !== null ? (item.watch as Record<string, unknown>) : undefined
  const runs = Array.isArray(item.runs) ? item.runs.slice(0, MAX_RUNS_KEPT).filter((run): run is WorkflowRunRecord => typeof run === "object" && run !== null && typeof (run as WorkflowRunRecord).runId === "string" && Array.isArray((run as WorkflowRunRecord).steps)) : []
  const enabledAt = number(item.enabledAt)
  const firedAt = number(item.firedAt)
  return {
    ...workflow,
    project: item.project,
    root: item.root,
    createdAt: number(item.createdAt) ?? 0,
    updatedAt: number(item.updatedAt) ?? number(item.createdAt) ?? 0,
    ...(enabledAt === undefined ? {} : { enabledAt }),
    ...(firedAt === undefined ? {} : { firedAt }),
    ...(watch === undefined || number(watch.polledAt) === undefined || !Array.isArray(watch.seen) ? {} : { watch: { polledAt: number(watch.polledAt) ?? 0, seen: watch.seen.filter((entry): entry is number => Number.isSafeInteger(entry)).slice(-MAX_SEEN) } }),
    runs,
  }
}
