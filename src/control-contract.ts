import { RUNRAIL_VERSION } from "./version.ts"

/** Version negotiated by the Runrail-native desktop control surface. */
export const RUNRAIL_CONTROL_PROTOCOL = 1 as const
export const RUNRAIL_CONTROL_API_VERSION = "1.0" as const
export const RUNRAIL_CONTROL_MAX_EVENT_BYTES = 1_048_576 as const
export const RUNRAIL_CONTROL_MAX_LIVE_EVENTS = 8_192 as const
export const RUNRAIL_CONTROL_MAX_REPLAY_EVENTS = 4_096 as const

/**
 * Stable capability families exposed by the control server.
 *
 * Keep this list provider-neutral. A client may use it to decide whether a
 * feature is available without knowing Runrail's private TypeScript layout.
 */
export const RUNRAIL_CONTROL_CAPABILITIES = [
  "control.describe",
  "turn.enqueue",
  "turn.steer",
  "turn.cancel",
  "model.switch",
  "backend.switch",
  "backend.list",
  "session.transfer",
  "session.history",
  "session.context",
  "session.tree",
  "session.transcript",
  "session.controls",
  "events.stream",
  "events.durable",
  "tasks",
  "plugins",
  "connectors",
  "agents",
  "providers",
  "harnesses",
  "provider.discovery",
  "skills",
  "skills.invoke",
  "accounts",
  "account.secrets",
  "auth.signin",
  "connections",
  "packages",
  "sharing",
  "metrics",
  "workspace.list",
  "workspace.read",
  "workspace.write",
  "workspace.folders",
  "terminal.describe",
  "terminal.create",
  "terminal.write",
  "terminal.read",
  "terminal.resize",
  "terminal.close",
  "git.read",
  "git.write",
  "git.remote",
  "git.pr",
  "git.branches",
  "git.fetch",
  "git.pr.list",
  "git.pr.reviews",
  "git.pr.review.post",
  "git.pr.merge",
  "git.pr.checks",
  "git.pull",
  "git.diff.stats",
  "codehosts",
  "codehost.remotes",
  "worktrees",
  "checks",
  "setups",
  "evals",
  "memory",
  "workflows",
  "tool.presentation",
  "live.frames",
  "session.conversation",
  "conversation.peek",
  "usage.read",
  "session.external",
  "task.rename",
  "harness.status",
  "mcp",
  "nifra",
  "connection.import",
  "background",
  "browser",
  "approval.scope",
  "approval.questions",
  "approval.followUp",
  "connection.settings",
  "connection.tools",
  "connection.signin",
  "connection.login",
  "session.compact",
  "turn.steer.live",
  "session.usage",
  "checkpoints",
  "session.rewind",
  "thread.copy",
  "threads.tools",
  "computer.tools",
  "image.tools",
  "push",
] as const

export type RunrailControlCapability = (typeof RUNRAIL_CONTROL_CAPABILITIES)[number]
export type RunrailControlCapabilityStatus = "available" | "configurable" | "unavailable"

export interface RunrailControlContract {
  readonly protocol: typeof RUNRAIL_CONTROL_PROTOCOL
  readonly apiVersion: typeof RUNRAIL_CONTROL_API_VERSION
  readonly supportedProtocols: readonly [typeof RUNRAIL_CONTROL_PROTOCOL]
  readonly runrailVersion: string
  readonly sessionId: string
  readonly projectId: string
  readonly scope: "single-session"
  readonly capabilities: typeof RUNRAIL_CONTROL_CAPABILITIES
  /**
   * Capability state is explicit because caller-owned integrations are only
   * available when the embedding process supplies their implementation.
   */
  readonly capabilityStatus: Readonly<Record<RunrailControlCapability, RunrailControlCapabilityStatus>>
  readonly limits: {
    readonly maxRequestBytes: number
    readonly maxEventBytes: typeof RUNRAIL_CONTROL_MAX_EVENT_BYTES
    readonly maxLiveEvents: typeof RUNRAIL_CONTROL_MAX_LIVE_EVENTS
    readonly maxReplayEvents: typeof RUNRAIL_CONTROL_MAX_REPLAY_EVENTS
    readonly maxTaskEvents: number
  }
  readonly eventRecovery: {
    readonly live: "/events"
    readonly durable: "task.events"
    readonly cursor: "afterSeq"
    readonly cursorExpiry: "bounded-window"
  }
}

export function createRunrailControlContract(input: {
  readonly sessionId: string
  readonly projectId: string
  readonly maxRequestBytes: number
  readonly maxTaskEvents?: number
  readonly capabilityStatus?: Partial<Record<RunrailControlCapability, RunrailControlCapabilityStatus>>
}): RunrailControlContract {
  const capabilityStatus = createCapabilityStatus(input.capabilityStatus)
  return Object.freeze({
    protocol: RUNRAIL_CONTROL_PROTOCOL,
    apiVersion: RUNRAIL_CONTROL_API_VERSION,
    supportedProtocols: Object.freeze([RUNRAIL_CONTROL_PROTOCOL]) as [typeof RUNRAIL_CONTROL_PROTOCOL],
    runrailVersion: RUNRAIL_VERSION,
    sessionId: input.sessionId,
    projectId: input.projectId,
    scope: "single-session",
    capabilities: RUNRAIL_CONTROL_CAPABILITIES,
    capabilityStatus,
    limits: Object.freeze({
      maxRequestBytes: input.maxRequestBytes,
      maxEventBytes: RUNRAIL_CONTROL_MAX_EVENT_BYTES,
      maxLiveEvents: RUNRAIL_CONTROL_MAX_LIVE_EVENTS,
      maxReplayEvents: RUNRAIL_CONTROL_MAX_REPLAY_EVENTS,
      maxTaskEvents: input.maxTaskEvents ?? RUNRAIL_CONTROL_MAX_LIVE_EVENTS,
    }),
    eventRecovery: Object.freeze({
      live: "/events",
      durable: "task.events",
      cursor: "afterSeq",
      cursorExpiry: "bounded-window",
    }),
  })
}

function createCapabilityStatus(
  overrides: Partial<Record<RunrailControlCapability, RunrailControlCapabilityStatus>> | undefined,
): Readonly<Record<RunrailControlCapability, RunrailControlCapabilityStatus>> {
  const callerOwned = new Set<RunrailControlCapability>([
    "session.transcript",
    "session.external",
    "plugins",
    "connectors",
    "agents",
    "account.secrets",
    "auth.signin",
    "terminal.describe",
    "terminal.create",
    "terminal.write",
    "terminal.read",
    "terminal.resize",
    "terminal.close",
    "browser",
    "threads.tools",
  "computer.tools",
    "image.tools",
  ])
  const entries = RUNRAIL_CONTROL_CAPABILITIES.map((capability) => [
    capability,
    overrides?.[capability] ?? (callerOwned.has(capability) ? "configurable" : "available"),
  ] as const)
  // The entries are generated from the closed public capability tuple above.
  return Object.freeze(Object.fromEntries(entries) as Record<RunrailControlCapability, RunrailControlCapabilityStatus>)
}
