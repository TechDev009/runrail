import { RUNRAIL_VERSION } from "../version.ts"
import {
  NifraBackend,
  type ApprovalTimeout,
  type NativeApprovalPort,
  type NativeModelPort,
  type NativeTool,
} from "@nifrajs/coding-agent"
import {
  agentError,
  type AgentBackend,
  type AgentBackendInfo,
  type AgentEvent,
  type AgentSessionSnapshot,
  type AgentToolCompletedEvent,
  type CreateSessionInput,
  type ReloadResult,
  type SendMessageInput,
} from "@nifrajs/agent-protocol"

export interface RunrailBackendOptions {
  readonly model: NativeModelPort
  readonly tools?: readonly NativeTool[]
  readonly approval?: NativeApprovalPort
  readonly approvalTimeoutMs?: ApprovalTimeout
  readonly maxSteps?: number
  readonly maxMessageChars?: number
  readonly maxReplyChars?: number
}

/** Runrail-specific composition around Nifra's public native backend contract. */
export class RunrailBackend implements AgentBackend {
  readonly info: AgentBackendInfo = Object.freeze({
    name: "runrail",
    version: RUNRAIL_VERSION,
    capabilities: Object.freeze([
      "sessions",
      "streaming",
      "approvals",
      "reload",
      "workspace.tools",
      "verification",
      "repair",
      "models",
      "model.routing",
      "context.resources",
      "console",
      "budgets",
      "metrics",
      "cache.hooks",
      "plugins",
      "session.transfer",
      "mcp",
      "skills",
      "agents",
      "connectors",
      "worktrees",
    ]),
  })
  private readonly inner: NifraBackend

  constructor(options: RunrailBackendOptions) {
    this.inner = new NifraBackend(options)
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    return mapSnapshot(await this.inner.createSession(input))
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const source = this.inner.send(input)
    return (async function* (): AsyncGenerator<AgentEvent> {
      for await (const event of source) yield mapEvent(event)
    })()
  }

  cancel(sessionId: string, reason?: string): Promise<void> {
    return this.inner.cancel(sessionId, reason)
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return mapSnapshot(await this.inner.snapshot(sessionId))
  }

  reload(sessionId: string): Promise<ReloadResult> {
    return this.inner.reload(sessionId)
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<boolean | undefined> {
    return this.inner.resolveApproval(sessionId, approvalId, approved, reason)
  }

  close(sessionId: string): Promise<void> {
    return this.inner.close(sessionId)
  }
}

function mapEvent(event: AgentEvent): AgentEvent {
  if (event.type === "session.updated" || event.type === "session.completed")
    return Object.freeze({ ...event, snapshot: mapSnapshot(event.snapshot) })
  if (event.type === "tool.completed" && event.ok) return commandOutcome(event)
  return event
}

/** Native tools whose result is a command's own outcome, `{ "ok": ..., "status": ... }` first. */
const COMMAND_FAILURES: ReadonlyMap<string, { readonly code: string; readonly label: string }> = new Map([
  ["run_command", { code: "COMMAND_FAILED", label: "command" }],
  ["run_verification", { code: "VERIFICATION_FAILED", label: "verification" }],
])
const FAILED_HEAD = /^\{"ok":false[,}]/
const STATUS_HEAD = /^\{"ok":false,"status":(-?\d+)[,}]/

/**
 * The native loop completes a tool `ok` whenever it returns, so a command that exited non-zero
 * read as a success. Its result says so in its first fields, even when the loop cut the text
 * short; the completion then fails with the output kept.
 */
function commandOutcome(event: AgentToolCompletedEvent): AgentEvent {
  const failure = COMMAND_FAILURES.get(event.name)
  const output = event.output
  if (failure === undefined || typeof output !== "string" || !FAILED_HEAD.test(output)) return event
  const result = resultOf(output)
  const status = STATUS_HEAD.exec(output)?.[1]
  const message = result?.timedOut === true ? `${failure.label} timed out`
    : result?.cancelled === true ? `${failure.label} was cancelled`
    : typeof result?.message === "string" ? result.message.slice(0, 256)
    : typeof result?.error === "string" ? result.error.slice(0, 256)
    : status === undefined ? `${failure.label} failed`
    : `${failure.label} exited with status ${status}`
  return Object.freeze({ ...event, ok: false, error: agentError(failure.code, message) })
}

function resultOf(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function mapSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  return Object.freeze({ ...snapshot, backend: "runrail" })
}
