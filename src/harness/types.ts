import type { AgentBackend, AgentBackendInfo, AgentEvent, AgentSessionSnapshot } from "@nifrajs/agent-protocol"
import type { AgentCapabilityManifest } from "@nifrajs/coding-agent"
import type { RunrailLiveSink } from "../live/types.ts"

export type HarnessAuthMode = "subscription" | "environment" | "caller"

/**
 * How a coding tool is driven. `jsonl` and `app-server` are Codex's exec and app-server routes;
 * `print` and `sdk` are Claude Code's print mode and its persistent Agent SDK route.
 */
export type HarnessProtocol = "jsonl" | "app-server" | "print" | "sdk"
export const HARNESS_PROTOCOLS: readonly HarnessProtocol[] = Object.freeze(["jsonl", "app-server", "print", "sdk"])

export type HarnessCredentialResolver = (
  environmentNames: readonly string[],
) => Readonly<Record<string, string | undefined>> | PromiseLike<Readonly<Record<string, string | undefined>>>

export interface HarnessAuthOptions {
  /** Subscription uses the vendor CLI's existing login/session under HOME. */
  readonly mode?: HarnessAuthMode
  /** Environment names explicitly eligible for credential injection. */
  readonly credentialEnvironment?: readonly string[]
  /** Caller-owned resolver used by library embeddings, never by CLI parsing. */
  readonly credentialResolver?: HarnessCredentialResolver
}

export type HarnessKind = "native" | "pi" | "codex" | "claude-code" | "copilot" | "gemini" | "opencode" | "aider" | "goose" | "grok" | "pty" | "remote" | "a2a" | "custom"

/** Controls that a harness may expose through the shared lifecycle contract. */
export type HarnessControl =
  | "follow-up"
  | "cancel"
  | "interrupt"
  | "approve"
  | "reject"
  | "resume"
  | "fork"
  | "compact"
  | "model"
  | "thinking"
  | "sandbox"
  | "mcp"
  | "inspect"
  | "close"

/** Normalized event families used by the versioned compatibility matrix. */
export type HarnessEventFamily =
  | "lifecycle"
  | "turn"
  | "assistant"
  | "tool"
  | "approval"
  | "usage"
  | "rate-limit"
  | "compaction"
  | "cancellation"
  | "failure"

export type HarnessCapabilityClassification = "native" | "pass-through" | "adapter" | "caller-owned" | "unavailable"

export type HarnessFeature =
  | "sessions"
  | "streaming"
  | "tools"
  | "approvals"
  | "reload"
  | "compact"
  | "fork"
  | "mcp"
  | "skills"
  | "connectors"
  | "worktrees"
  | "provider.switch"
  | "verification"
  | "repair"

export interface HarnessDescriptor {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly kind: HarnessKind
  readonly features: readonly HarnessFeature[]
  readonly capabilities: readonly string[]
  /** Runtime version when it is distinct from the Runrail adapter version. */
  readonly runtimeVersion?: string
  /** Machine protocol version used by the adapter, when known. */
  readonly protocolVersion?: string
  /** Explicit control operations. Missing controls must not be inferred. */
  readonly controls?: readonly HarnessControl[]
  /** Event families the adapter has fixtures for. */
  readonly events?: readonly HarnessEventFamily[]
  /** High-level ownership classification for the adapter. */
  readonly classification?: HarnessCapabilityClassification
  readonly securityManifest?: AgentCapabilityManifest
  readonly firstParty?: boolean
  readonly authModes?: readonly HarnessAuthMode[]
  readonly defaultAuthMode?: HarnessAuthMode
}

/**
 * Bounded vendor metadata that does not fit the published AgentEvent union.
 * It is delivered through an explicit caller-owned sink and is never persisted
 * by Runrail. Payload-bearing vendor records are intentionally not represented.
 */
export type HarnessMetadataEvent =
  | HarnessUsageMetadataEvent
  | HarnessRateLimitMetadataEvent
  | HarnessReasoningMetadataEvent
  | HarnessCompactionMetadataEvent

export interface HarnessMetadataBase {
  readonly version: 1
  readonly sessionId: string
  readonly seq: number
  readonly kind: "usage" | "rate-limit" | "reasoning" | "compaction"
  readonly turnId?: string
}

export interface HarnessUsageMetadataEvent extends HarnessMetadataBase {
  readonly kind: "usage"
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface HarnessRateLimitMetadataEvent extends HarnessMetadataBase {
  readonly kind: "rate-limit"
  readonly retryAfterMs?: number
  readonly remainingRequests?: number
  readonly resetAt?: number
}

export interface HarnessReasoningMetadataEvent extends HarnessMetadataBase {
  readonly kind: "reasoning"
  readonly level?: string
  readonly durationMs?: number
}

export interface HarnessCompactionMetadataEvent extends HarnessMetadataBase {
  readonly kind: "compaction"
  readonly before?: number
  readonly after?: number
}

export type HarnessMetadataSink = (event: HarnessMetadataEvent) => void

export interface HarnessAdapter {
  readonly descriptor: HarnessDescriptor
  readonly create: (context: { readonly cwd: string; readonly requestedFeatures: readonly HarnessFeature[] }) => AgentBackend | PromiseLike<AgentBackend>
}

export interface HarnessStatus {
  readonly descriptor: HarnessDescriptor
  readonly available: boolean
  readonly reason?: string
  /** Set only by a probe of the installed tool. Absent means "not checked", never "no". */
  readonly version?: string
  readonly signedIn?: boolean
  readonly models?: readonly HarnessModelDescriptor[]
  readonly efforts?: readonly string[]
  /** True when any model id the tool accepts may be typed, beyond the listed ones. */
  readonly freeTextModel?: boolean
  /** Where the tool's own settings send its model requests, when that is not its vendor. */
  readonly proxy?: { readonly address: string; readonly name?: string }
}

export interface HarnessModelDescriptor {
  readonly id: string
  readonly name: string
  /** The exact model an alias runs, as the tool reported it (`opus` -> `claude-opus-5-5`). */
  readonly resolved?: string
  /** Not in the tool's own list: from Runrail's model catalog, run by its id. The account may not have it. */
  readonly catalog?: boolean
  readonly default?: boolean
  readonly efforts?: readonly string[]
  /** False when the tool says this model does not reason, so no level applies. Absent: not said. */
  readonly reasoning?: boolean
}

export interface NormalizedHarnessEvent {
  readonly event: AgentEvent
}

export interface HarnessEventMappingContext {
  readonly sessionId: string
  readonly cwd: string
  readonly backend: string
  readonly nextSeq: number
  readonly previous: AgentSessionSnapshot
  /** Runrail-owned correlation id for the current request when available. */
  readonly requestId?: string
  /** Runrail-owned fallback turn id for the current request when available. */
  readonly turnId?: string
  /** Vendor-owned thread/session identity; built-in mappers bind and validate it separately. */
  vendorSessionId?: string
  /** The newest message the vendor named in its own conversation, for a later exact rewind. */
  vendorMessageId?: string
  /** Optional transient sink for bounded usage, rate-limit, and vendor metadata. */
  readonly onMetadata?: HarnessMetadataSink
  /** Optional transient sink for bounded reasoning, plan, and subagent lineage frames. */
  readonly onLive?: RunrailLiveSink
  /** Scratch space that lives for one request, so a mapper can pair a tool result with its call. */
  readonly turnState?: Map<string, unknown>
  /** Skip record types the mapper does not know instead of failing the turn. */
  readonly tolerateUnknown?: boolean
}

/** One vendor record can carry several things (a reply and a tool call), each its own event, numbered from `nextSeq`. */
export type HarnessEventMapper = (value: unknown, context: HarnessEventMappingContext) => AgentEvent | readonly AgentEvent[] | undefined

export function mappedEvents(result: AgentEvent | readonly AgentEvent[] | undefined): readonly AgentEvent[] {
  return result === undefined ? [] : Array.isArray(result) ? result : [result as AgentEvent]
}

export function harnessInfo(descriptor: HarnessDescriptor): AgentBackendInfo {
  return Object.freeze({ name: descriptor.id, version: descriptor.version, capabilities: Object.freeze([...descriptor.capabilities]) })
}
