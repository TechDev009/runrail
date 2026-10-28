import type { RunrailSession } from "../session.ts"
import type { SetupTurnAnswer, SetupTurnPort, SetupTurnRequest } from "./runner.ts"

/**
 * A setup run's turns in this process, for runs no one watches (a headless eval). Each role's
 * thread is a Runrail session kept for the run's life, in the folder the run names. No one can
 * answer an approval, so each is declined: the role's access decides what runs without one.
 */

export interface HeadlessTurnsOptions {
  /** Opens a role's thread in `cwd`, on the role's route, model, and access. */
  readonly open: (request: SetupTurnRequest, cwd: string) => Promise<RunrailSession>
  /** The project's folder, for a run that works in the checkout. */
  readonly root: string
}

export const NO_ONE_TO_ASK = "no one is watching this run to answer; the role's access decides what runs"

export class HeadlessTurns implements SetupTurnPort {
  readonly #threads = new Map<string, Promise<RunrailSession>>()

  constructor(private readonly options: HeadlessTurnsOptions) {}

  async turn(_runId: string, request: SetupTurnRequest, signal: AbortSignal): Promise<SetupTurnAnswer> {
    const cwd = request.worktree?.cwd ?? (request.checkout === true ? this.options.root : undefined)
    if (cwd === undefined) return { ok: false, error: "a run no one watches works in a worktree it is given or in the checkout" }
    let session: RunrailSession
    try {
      session = await this.#thread(request, cwd)
    } catch (error) {
      return { ok: false, error: reason(error, "the role's thread could not start") }
    }
    const texts: string[] = []
    let failure: string | undefined
    try {
      for await (const event of session.prompt(request.prompt, signal)) {
        if (event.type === "assistant.message") texts.push(event.text)
        else if (event.type === "approval.required") await session.resolveApproval(event.approvalId, false, NO_ONE_TO_ASK)
        else if (event.type === "session.failed") failure = event.error.message
      }
    } catch (error) {
      failure = reason(error, "the turn failed")
    }
    const usage = session.metrics?.snapshot()
    const tokens = usage === undefined ? undefined : Math.round(usage.inputTokens + usage.outputTokens)
    const counted = tokens !== undefined && Number.isSafeInteger(tokens) && tokens > 0 ? { tokens } : {}
    if (signal.aborted) return { ok: false, error: "the turn was stopped", ...counted }
    if (failure !== undefined) return { ok: false, error: failure.slice(0, 500), ...counted }
    return { ok: true, text: texts.join("\n\n"), ...(request.worktree === undefined ? {} : { worktree: request.worktree.id }), ...counted }
  }

  /** The run ended: its threads stop. */
  async release(runId: string): Promise<void> {
    const ended = [...this.#threads.entries()].filter(([thread]) => thread.startsWith(`${runId}:`))
    for (const [thread] of ended) this.#threads.delete(thread)
    await Promise.all(ended.map(([, opened]) => opened.then((session) => session.stop("completed"), () => undefined).catch(() => undefined)))
  }

  async close(): Promise<void> {
    const runs = new Set([...this.#threads.keys()].map((thread) => thread.slice(0, thread.lastIndexOf(":"))))
    await Promise.all([...runs].map((runId) => this.release(runId)))
  }

  #thread(request: SetupTurnRequest, cwd: string): Promise<RunrailSession> {
    const existing = this.#threads.get(request.thread)
    if (existing !== undefined) return existing
    const opened = this.options.open(request, cwd)
    this.#threads.set(request.thread, opened)
    opened.catch(() => this.#threads.delete(request.thread))
    return opened
  }
}

function reason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message.slice(0, 500) : fallback
}
