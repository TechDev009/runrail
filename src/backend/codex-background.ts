import type { RunrailBackgroundControl, RunrailBackgroundEntry, RunrailBackgroundStatus, RunrailLiveFrameInput } from "../live/types.ts"
import { wrappedScript } from "../tools/command-intent.ts"

/**
 * Background work in a Codex app-server thread, from what Codex reports (0.160, checked against a
 * real server on 2026-10-02): a `commandExecution` item from unified exec that is still running
 * when its turn completes keeps running in a background terminal until its `item/completed`; a
 * `subAgentActivity` item starts a subagent whose own thread's turns stream on the same connection.
 */
const MAX_TRACKED_COMMANDS = 32
const MAX_KEPT_OUTPUTS = 16
const MAX_AGENTS = 32
const OUTPUT_BYTES = 64 * 1024
const STOP_TIMEOUT_MS = 5_000
const TURN_STATUS: Readonly<Record<string, RunrailBackgroundStatus>> = { completed: "completed", interrupted: "stopped", failed: "failed" }

function turnStatus(value: string | undefined): RunrailBackgroundStatus {
  return value !== undefined && Object.hasOwn(TURN_STATUS, value) ? TURN_STATUS[value]! : "unknown"
}

interface TrackedCommand {
  readonly itemId: string
  readonly processId: string | undefined
  readonly threadId: string
  readonly turnId: string | undefined
  readonly label: string
  readonly startedAt: number
  output: string
  truncated: boolean
  background: boolean
  done: boolean
  stopRequested: boolean
}

interface TrackedAgent {
  readonly threadId: string
  turnId: string | undefined
  stopRequested: boolean
}

export interface CodexBackgroundOptions {
  readonly emit: (frame: RunrailLiveFrameInput) => void
  readonly request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>
}

export class CodexBackgroundTracker {
  private readonly commands = new Map<string, TrackedCommand>()
  private readonly agents = new Map<string, TrackedAgent>()

  constructor(private readonly options: CodexBackgroundOptions) {}

  /** Sees every notification, before the backend narrows them to its own thread and turn. */
  observe(method: string, input: Record<string, unknown>): void {
    const threadId = text(input.threadId)
    if (method === "item/started" || method === "item/completed") {
      const item = record(input.item)
      if (item.type === "commandExecution") this.command(method === "item/completed", item, threadId, text(input.turnId))
      else if (item.type === "subAgentActivity") this.agentActivity(item)
      return
    }
    if (method === "item/commandExecution/outputDelta") {
      const tracked = this.commands.get(text(input.itemId) ?? "")
      if (tracked !== undefined && typeof input.delta === "string") append(tracked, input.delta)
      return
    }
    if (threadId === undefined) return
    if (method === "turn/started") {
      const agent = this.agents.get(threadId)
      if (agent === undefined) return
      agent.turnId = text(record(input.turn).id)
      this.emit({ id: agentId(threadId), status: "running" }, this.agentControl(agent))
      return
    }
    if (method === "turn/completed") {
      const turn = record(input.turn)
      const turnId = text(turn.id)
      for (const tracked of this.commands.values()) {
        if (tracked.threadId !== threadId || tracked.done || tracked.background || (tracked.turnId !== undefined && turnId !== undefined && tracked.turnId !== turnId)) continue
        tracked.background = true
        this.emit(
          { id: commandId(tracked), kind: "command", label: tracked.label, status: "running", startedAt: tracked.startedAt, callId: tracked.itemId, foreground: false },
          this.commandControl(tracked),
        )
      }
      const agent = this.agents.get(threadId)
      if (agent !== undefined && agent.turnId === turnId) {
        agent.turnId = undefined
        const status = agent.stopRequested ? "stopped" : turnStatus(text(turn.status))
        this.emit({ id: agentId(threadId), status, endedAt: Date.now() })
      }
    }
  }

  /** The app-server is gone, and its terminals and subagents with it. */
  close(): void {
    for (const tracked of this.commands.values()) {
      if (tracked.background && !tracked.done) this.emit({ id: commandId(tracked), status: "stopped", endedAt: Date.now() })
    }
    for (const agent of this.agents.values()) {
      if (agent.turnId !== undefined) this.emit({ id: agentId(agent.threadId), status: "stopped", endedAt: Date.now() })
    }
    this.commands.clear()
    this.agents.clear()
  }

  private command(completed: boolean, item: Record<string, unknown>, threadId: string | undefined, turnId: string | undefined): void {
    const itemId = text(item.id)
    if (itemId === undefined) return
    const tracked = this.commands.get(itemId)
    if (completed) {
      if (tracked === undefined) return
      tracked.done = true
      if (!tracked.background) {
        this.commands.delete(itemId)
        return
      }
      const exitCode = Number.isSafeInteger(item.exitCode) ? (item.exitCode as number) : undefined
      // "completed" says the command ended, not that it worked; an exit code, when there is one, decides.
      const status = tracked.stopRequested ? "stopped" : (exitCode === undefined ? text(item.status) === "completed" : exitCode === 0) ? "completed" : "failed"
      this.emit({ id: commandId(tracked), status, endedAt: Date.now(), ...(exitCode === undefined ? {} : { exitCode }) })
      this.pruneOutputs()
      return
    }
    // Only unified exec keeps a command alive past its turn.
    if (tracked !== undefined || threadId === undefined || item.source !== "unifiedExecStartup" || text(item.status) !== "inProgress") return
    this.commands.set(itemId, {
      itemId,
      processId: text(item.processId),
      threadId,
      turnId,
      label: typeof item.command === "string" && item.command.trim().length > 0 ? unwrapShell(item.command) : "Command",
      startedAt: Date.now(),
      output: "",
      truncated: false,
      background: false,
      done: false,
      stopRequested: false,
    })
    for (const [key, candidate] of this.commands) {
      if (this.commands.size <= MAX_TRACKED_COMMANDS) break
      if (!candidate.background || candidate.done) this.commands.delete(key)
    }
  }

  private agentActivity(item: Record<string, unknown>): void {
    const threadId = text(item.agentThreadId)
    if (threadId === undefined) return
    const kind = text(item.kind)
    let agent = this.agents.get(threadId)
    if (agent === undefined) {
      if (kind !== "started" && kind !== "interacted") return
      agent = { threadId, turnId: undefined, stopRequested: false }
      this.agents.set(threadId, agent)
      for (const key of this.agents.keys()) {
        if (this.agents.size <= MAX_AGENTS) break
        this.agents.delete(key)
      }
      this.emit({ id: agentId(threadId), kind: "agent", label: agentLabel(text(item.agentPath)), status: "running", startedAt: Date.now() }, this.agentControl(agent))
      return
    }
    if (kind === "completed" || kind === "interrupted") {
      agent.turnId = undefined
      this.emit({ id: agentId(threadId), status: kind === "completed" && !agent.stopRequested ? "completed" : "stopped", endedAt: Date.now() })
    } else if (kind === "interacted") this.emit({ id: agentId(threadId), status: "running" })
  }

  private commandControl(tracked: TrackedCommand): RunrailBackgroundControl {
    const output = async (maxBytes: number) => {
      const text = tracked.output.length > maxBytes ? tracked.output.slice(-maxBytes) : tracked.output
      return { text, truncated: tracked.truncated || text.length < tracked.output.length }
    }
    const processId = tracked.processId
    if (processId === undefined) return { output }
    return {
      output,
      stop: async () => {
        tracked.stopRequested = true
        const result = record(await this.options.request("thread/backgroundTerminals/terminate", { threadId: tracked.threadId, processId }, STOP_TIMEOUT_MS))
        // `false` means Codex no longer has it: it ended on its own, and its item says how.
        if (result.terminated !== true && !tracked.done) tracked.stopRequested = false
      },
    }
  }

  private agentControl(agent: TrackedAgent): RunrailBackgroundControl {
    return {
      stop: async () => {
        agent.stopRequested = true
        if (agent.turnId !== undefined) await this.options.request("turn/interrupt", { threadId: agent.threadId, turnId: agent.turnId }, STOP_TIMEOUT_MS)
        // An interrupted subagent's own background commands keep running otherwise.
        await this.options.request("thread/backgroundTerminals/clean", { threadId: agent.threadId }, STOP_TIMEOUT_MS).catch(() => undefined)
      },
    }
  }

  private pruneOutputs(): void {
    const finished = [...this.commands.values()].filter((tracked) => tracked.done)
    for (const tracked of finished.slice(0, Math.max(0, finished.length - MAX_KEPT_OUTPUTS))) this.commands.delete(tracked.itemId)
  }

  private emit(entry: Partial<RunrailBackgroundEntry> & { readonly id: string }, control?: RunrailBackgroundControl): void {
    try {
      this.options.emit({ type: "background.state", entry, ...(control === undefined ? {} : { control }) })
    } catch {
      // Presentation only.
    }
  }
}

function append(tracked: TrackedCommand, delta: string): void {
  tracked.output += delta
  if (tracked.output.length > OUTPUT_BYTES) {
    tracked.output = tracked.output.slice(-OUTPUT_BYTES)
    tracked.truncated = true
  }
}

/** `/bin/zsh -lc 'npm run dev'` is shown as `npm run dev`. */
export function unwrapShell(command: string): string {
  return wrappedScript(command) ?? command
}

function agentLabel(path: string | undefined): string {
  const name = path?.split("/").filter((part) => part.length > 0).pop()
  return name === undefined ? "Subagent" : `Subagent ${name}`
}

function commandId(tracked: TrackedCommand): string {
  return `codex:command:${tracked.itemId}`
}

function agentId(threadId: string): string {
  return `codex:agent:${threadId}`
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined
}
