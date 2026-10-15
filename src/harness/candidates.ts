import { isAgentEvent, type AgentBackend, type AgentEvent } from "@nifrajs/agent-protocol"
import { RUNRAIL_VERSION } from "../version.ts"
import { CommandAgentBackend, type CommandAgentBackendOptions } from "../backend/command-agent.ts"
import { createJsonlHarnessAdapter } from "./jsonl-adapter.ts"
import type { HarnessAdapter, HarnessDescriptor, HarnessEventMappingContext, HarnessFeature, HarnessKind } from "./types.ts"

/** Candidate runtimes with a stable Runrail JSONL seam but caller-owned vendor protocol details. */
export type CandidateHarnessId = "gemini" | "opencode" | "aider" | "goose"

export interface CandidateHarnessOptions extends Omit<CommandAgentBackendOptions, "name" | "version" | "capabilities" | "command"> {
  readonly command?: string
  readonly capabilities?: readonly string[]
}

export const CANDIDATE_HARNESS_DESCRIPTORS: Readonly<Record<CandidateHarnessId, HarnessDescriptor>> = Object.freeze({
  gemini: descriptor("gemini", "Gemini CLI", "gemini"),
  opencode: descriptor("opencode", "OpenCode", "opencode"),
  aider: descriptor("aider", "Aider", "aider"),
  goose: descriptor("goose", "Goose", "goose"),
})

export function createCandidateHarnessAdapter(id: CandidateHarnessId, options: CandidateHarnessOptions = {}): HarnessAdapter {
  const descriptor = CANDIDATE_HARNESS_DESCRIPTORS[id]
  return createJsonlHarnessAdapter(descriptor, () => createCandidateHarness(id, options))
}

export function createCandidateHarness(id: CandidateHarnessId, options: CandidateHarnessOptions = {}): AgentBackend {
  const descriptor = CANDIDATE_HARNESS_DESCRIPTORS[id]
  return new CommandAgentBackend({
    ...options,
    command: options.command ?? id,
    name: id,
    version: RUNRAIL_VERSION,
    capabilities: options.capabilities ?? descriptor.capabilities,
    promptMode: options.promptMode ?? "jsonl",
    eventMapper: options.eventMapper ?? normalizeCandidateEvent,
  })
}

export function createCandidateHarnessAdapters(options: Readonly<Partial<Record<CandidateHarnessId, CandidateHarnessOptions>>> = {}): readonly HarnessAdapter[] {
  return Object.freeze((Object.keys(CANDIDATE_HARNESS_DESCRIPTORS) as CandidateHarnessId[]).map((id) => createCandidateHarnessAdapter(id, options[id] ?? {})))
}

function descriptor(id: CandidateHarnessId, name: string, kind: HarnessKind): HarnessDescriptor {
  return Object.freeze({
    id,
    name,
    version: RUNRAIL_VERSION,
    runtimeVersion: "caller-installed",
    protocolVersion: "runrail.jsonl",
    kind,
    classification: "caller-owned",
    controls: Object.freeze(["follow-up", "cancel", "inspect", "close"] as const),
    events: Object.freeze(["lifecycle", "turn", "assistant", "tool", "cancellation", "failure"] as const),
    features: Object.freeze(["sessions", "streaming", "reload", "verification", "repair"] as HarnessFeature[]),
    capabilities: Object.freeze(["sessions", "streaming", "runrail.jsonl", "caller.command"]),
    authModes: Object.freeze(["caller", "environment", "subscription"] as const),
    defaultAuthMode: "subscription",
    firstParty: true,
  })
}

function normalizeCandidateEvent(value: unknown, context: HarnessEventMappingContext): AgentEvent | undefined {
  if (!isAgentEvent(value)) throw new Error("candidate harness event is invalid")
  if (value.sessionId !== context.sessionId) throw new Error("candidate harness event session does not match")
  if (value.type !== "session.started" && value.type !== "session.updated" && value.type !== "session.completed") return value
  return Object.freeze({
    ...value,
    snapshot: Object.freeze({
      ...value.snapshot,
      id: context.sessionId,
      backend: context.backend,
      cwd: context.cwd,
      lastSeq: value.seq,
      updatedAt: Date.now(),
    }),
  })
}
