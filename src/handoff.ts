import { isAbsolute } from "node:path"
import type { ArtifactRef } from "@nifrajs/agent-protocol"
import { parseArtifactRef } from "@nifrajs/agent-protocol"
import { sha256HexOf } from "@nifrajs/coding-agent/orchestration"
import type { VerificationName } from "./cli.ts"

export const RUNRAIL_HANDOFF_VERSION = 1 as const
export const HANDOFF_MAX_BYTES = 4_096

export type PortableHandoffStatus = "pending" | "accepted" | "declined"

/** Content-free state transferred between two harness adapters. */
export interface PortableHandoff {
  readonly version: typeof RUNRAIL_HANDOFF_VERSION
  readonly handoffId: string
  readonly runId: string
  readonly source: string
  readonly target: string
  readonly status: PortableHandoffStatus
  readonly objectiveDigest: string
  readonly acceptanceDigest: string
  readonly completedNodeIds: readonly string[]
  readonly remainingNodeIds: readonly string[]
  readonly changedPaths: readonly string[]
  readonly artifacts: readonly ArtifactRef[]
  /** Caller-owned opaque repository/workspace reference; never an absolute local path. */
  readonly workspaceRef?: string
  readonly verification?: {
    readonly name: VerificationName
    readonly ok: boolean
    readonly status: number | null
  }
  readonly workspaceDigest?: string
  readonly blockerCode?: string
  readonly nextActionCode?: string
}

export interface PortableHandoffInput {
  readonly handoffId: string
  readonly runId: string
  readonly source: string
  readonly target: string
  readonly objective: string
  readonly acceptance: string
  readonly status?: PortableHandoffStatus
  readonly completedNodeIds?: readonly string[]
  readonly remainingNodeIds?: readonly string[]
  readonly changedPaths?: readonly string[]
  readonly artifacts?: readonly ArtifactRef[]
  readonly workspaceRef?: string
  readonly verification?: PortableHandoff["verification"]
  readonly workspaceDigest?: string
  readonly blockerCode?: string
  readonly nextActionCode?: string
}

export class HandoffContractError extends Error {
  constructor(readonly reason: string) {
    super(`handoff contract: ${reason}`)
    this.name = "HandoffContractError"
  }
}

export async function createPortableHandoff(input: PortableHandoffInput): Promise<PortableHandoff> {
  const objective = boundedText(input.objective, "objective")
  const acceptance = boundedText(input.acceptance, "acceptance")
  const packet = parsePortableHandoff({
    version: RUNRAIL_HANDOFF_VERSION,
    handoffId: input.handoffId,
    runId: input.runId,
    source: input.source,
    target: input.target,
    status: input.status ?? "pending",
    objectiveDigest: await sha256HexOf(objective),
    acceptanceDigest: await sha256HexOf(acceptance),
    completedNodeIds: input.completedNodeIds ?? [],
    remainingNodeIds: input.remainingNodeIds ?? [],
    changedPaths: input.changedPaths ?? [],
    artifacts: input.artifacts ?? [],
    ...(input.workspaceRef === undefined ? {} : { workspaceRef: input.workspaceRef }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.workspaceDigest === undefined ? {} : { workspaceDigest: input.workspaceDigest }),
    ...(input.blockerCode === undefined ? {} : { blockerCode: input.blockerCode }),
    ...(input.nextActionCode === undefined ? {} : { nextActionCode: input.nextActionCode }),
  })
  assertHandoffSize(packet)
  return packet
}

export function parsePortableHandoff(value: unknown): PortableHandoff {
  const input = record(value)
  rejectKeys(input)
  if (input.version !== RUNRAIL_HANDOFF_VERSION)
    throw new HandoffContractError("unsupported version")
  const packet: PortableHandoff = {
    version: RUNRAIL_HANDOFF_VERSION,
    handoffId: token(input.handoffId, "handoffId"),
    runId: token(input.runId, "runId"),
    source: token(input.source, "source"),
    target: token(input.target, "target"),
    status: parseStatus(input.status),
    objectiveDigest: digest(input.objectiveDigest, "objectiveDigest"),
    acceptanceDigest: digest(input.acceptanceDigest, "acceptanceDigest"),
    completedNodeIds: tokens(input.completedNodeIds ?? [], "completedNodeIds", 256),
    remainingNodeIds: tokens(input.remainingNodeIds ?? [], "remainingNodeIds", 256),
    changedPaths: paths(input.changedPaths ?? []),
    artifacts: parseArtifacts(input.artifacts ?? []),
    ...(input.workspaceRef === undefined ? {} : { workspaceRef: opaqueRef(input.workspaceRef, "workspaceRef") }),
    ...(input.verification === undefined ? {} : { verification: parseVerification(input.verification) }),
    ...(input.workspaceDigest === undefined ? {} : { workspaceDigest: digest(input.workspaceDigest, "workspaceDigest") }),
    ...(input.blockerCode === undefined ? {} : { blockerCode: token(input.blockerCode, "blockerCode") }),
    ...(input.nextActionCode === undefined ? {} : { nextActionCode: token(input.nextActionCode, "nextActionCode") }),
  }
  assertHandoffSize(packet)
  return Object.freeze({
    ...packet,
    completedNodeIds: Object.freeze([...packet.completedNodeIds]),
    remainingNodeIds: Object.freeze([...packet.remainingNodeIds]),
    changedPaths: Object.freeze([...packet.changedPaths]),
    artifacts: Object.freeze([...packet.artifacts]),
    ...(packet.verification === undefined ? {} : { verification: Object.freeze(packet.verification) }),
  })
}

export function assertHandoffSize(packet: PortableHandoff): void {
  let serialized: string
  try {
    serialized = JSON.stringify(packet)
  } catch {
    throw new HandoffContractError("packet is not serializable")
  }
  if (new TextEncoder().encode(serialized).byteLength > HANDOFF_MAX_BYTES)
    throw new HandoffContractError("packet exceeds byte limit")
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HandoffContractError("packet must be an object")
  return value as Record<string, unknown>
}

function rejectKeys(input: Record<string, unknown>): void {
  const allowed = new Set([
    "version",
    "handoffId",
    "runId",
    "source",
    "target",
    "status",
    "objectiveDigest",
    "acceptanceDigest",
    "completedNodeIds",
    "remainingNodeIds",
    "changedPaths",
    "artifacts",
    "workspaceRef",
    "verification",
    "workspaceDigest",
    "blockerCode",
    "nextActionCode",
  ])
  const forbidden = new Set([
    "objective",
    "acceptance",
    "prompt",
    "message",
    "text",
    "input",
    "output",
    "content",
    "transcript",
    "credentials",
    "secret",
  ])
  for (const key of Object.keys(input)) {
    if (forbidden.has(key.toLowerCase())) throw new HandoffContractError("content field is forbidden")
    if (!allowed.has(key)) throw new HandoffContractError(`unknown field '${key}'`)
  }
}

function token(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new HandoffContractError(`${name} is invalid`)
  return value
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 * 1024)
    throw new HandoffContractError(`${name} is invalid`)
  return value
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new HandoffContractError(`${name} is invalid`)
  return value
}

function opaqueRef(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ||
    value.includes("//") ||
    value.includes("..") ||
    value.startsWith("/")
  )
    throw new HandoffContractError(`${name} is invalid`)
  return value
}

function parseStatus(value: unknown): PortableHandoffStatus {
  if (value === "pending" || value === "accepted" || value === "declined") return value
  throw new HandoffContractError("status is invalid")
}

function tokens(value: unknown, name: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new HandoffContractError(`${name} is invalid`)
  const result = value.map((entry) => token(entry, name))
  if (new Set(result).size !== result.length) throw new HandoffContractError(`${name} contains duplicates`)
  return Object.freeze([...result].sort())
}

function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new HandoffContractError("changedPaths is invalid")
  const result = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 512 ||
      entry.includes("\0") ||
      entry.includes("\\") ||
      isAbsolute(entry) ||
      entry.split("/").some((part) => part === ".." || part === "")
    )
      throw new HandoffContractError("changedPaths contains an unsafe path")
    const name = entry.split("/").at(-1) ?? ""
    if (name === ".env" || name.startsWith(".env.") || /\.(pem|key)$/i.test(name))
      throw new HandoffContractError("changedPaths contains a sensitive path")
    return entry
  })
  if (new Set(result).size !== result.length) throw new HandoffContractError("changedPaths contains duplicates")
  return Object.freeze([...result].sort())
}

function parseArtifacts(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new HandoffContractError("artifacts is invalid")
  try {
    return Object.freeze(value.map((entry) => parseArtifactRef(entry)))
  } catch {
    throw new HandoffContractError("artifacts contain an invalid reference")
  }
}

function parseVerification(value: unknown): PortableHandoff["verification"] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HandoffContractError("verification is invalid")
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !["name", "ok", "status"].includes(key)))
    throw new HandoffContractError("verification contains an unknown field")
  const name = input.name
  if (name !== "check" && name !== "assure" && name !== "test")
    throw new HandoffContractError("verification name is invalid")
  if (typeof input.ok !== "boolean") throw new HandoffContractError("verification result is invalid")
  if (input.status !== null && (typeof input.status !== "number" || !Number.isSafeInteger(input.status)))
    throw new HandoffContractError("verification status is invalid")
  return { name, ok: input.ok, status: input.status }
}
