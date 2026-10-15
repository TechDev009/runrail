import { createHash } from "node:crypto"
import type {
  AgentBackend,
  AgentEvent,
  AgentSessionSnapshot,
  ReloadResult,
} from "@nifrajs/agent-protocol"

export const RUNRAIL_CERTIFICATION_VERSION = 1 as const

export type CertificationAdapterKind =
  | "pi-compatible"
  | "codex-compatible"
  | "claude-compatible"
  | "grok-compatible"
  | "remote"
  | "a2a-compatible"

export type CertificationBehavior =
  | "session-lifecycle"
  | "streaming"
  | "tool-mapping"
  | "approval"
  | "cancellation"
  | "output-bounds"
  | "capability-rejection"
  | "retry-fallback"
  | "verification-repair"

export interface CertificationProbeContext {
  readonly backend: AgentBackend
  readonly sessionId: string
  readonly snapshot: AgentSessionSnapshot
  readonly events: readonly AgentEvent[]
}

export type CertificationProbe = (context: CertificationProbeContext) => boolean | PromiseLike<boolean>

export interface AdapterCertificationProfile {
  readonly id: string
  readonly kind: CertificationAdapterKind
  readonly version: string
  readonly capabilities: readonly string[]
  readonly create: () => AgentBackend | PromiseLike<AgentBackend>
  readonly requiredCapabilities?: readonly string[]
  readonly timeoutMs?: number
  readonly resolveApproval?: (input: {
    readonly backend: AgentBackend
    readonly sessionId: string
    readonly approvalId: string
  }) => boolean | PromiseLike<boolean>
  readonly requiredBehaviors?: readonly CertificationBehavior[]
  readonly probes?: Partial<Record<CertificationBehavior, CertificationProbe>>

}
export interface CertificationCheck {
  readonly name: string
  readonly ok: boolean
  readonly code?: string
}

export interface AdapterCertificationResult {
  readonly version: typeof RUNRAIL_CERTIFICATION_VERSION
  readonly id: string
  readonly kind: CertificationAdapterKind
  readonly adapterVersion: string
  readonly capabilities: readonly string[]
  readonly ok: boolean
  readonly checks: readonly CertificationCheck[]
  readonly eventCount: number
  readonly streamedDeltas: number
  readonly approvals: number
  readonly elapsedMs: number
  readonly digest: string
}

export interface CertificationSuiteResult {
  readonly version: typeof RUNRAIL_CERTIFICATION_VERSION
  readonly ok: boolean
  readonly results: readonly AdapterCertificationResult[]
}

export type CertificationErrorCode =
  | "CERTIFICATION_INVALID"
  | "CERTIFICATION_TIMEOUT"
  | "CERTIFICATION_FAILED"

export class CertificationError extends Error {
  constructor(readonly code: CertificationErrorCode, reason: string) {
    super(`adapter certification: ${reason}`)
    this.name = "CertificationError"
  }
}

/**
 * Certify an adapter through only the public AgentBackend contract. Results contain metadata,
 * counters, status codes, and a digest - never prompts, transcripts, tool payloads, or credentials.
 */
export async function certifyAdapter(
  profile: AdapterCertificationProfile,
  options: { readonly cwd: string; readonly sessionId?: string } = { cwd: process.cwd() },
): Promise<AdapterCertificationResult> {
  validateProfile(profile, options.cwd)
  const started = performance.now()
  const checks: CertificationCheck[] = []
  let backend: AgentBackend | undefined
  let snapshot: AgentSessionSnapshot | undefined
  const metadata: string[] = []
  let streamedDeltas = 0
  let approvals = 0
  const turn = new AbortController()
  try {
    backend = await withTimeout(Promise.resolve(profile.create()), profile.timeoutMs ?? 30_000)
    checks.push(check("backend.info", isBackendInfo(backend.info), "CERTIFICATION_BACKEND_INFO"))
    checks.push(check("declared-capabilities", includesAll(profile.capabilities, backend.info.capabilities), "CERTIFICATION_CAPABILITIES"))
    const required = profile.requiredCapabilities ?? []
    checks.push(check("required-capabilities", includesAll(required, backend.info.capabilities), "CERTIFICATION_REQUIRED_CAPABILITIES"))
    if (!checks.every((item) => item.ok)) return finish(profile, checks, metadata, started, 0, 0, 0)
    snapshot = await withTimeout(
      backend.createSession({ cwd: options.cwd, backend: profile.id, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) }),
      profile.timeoutMs ?? 30_000,
    )
    metadata.push(`session:${snapshot.id}`, `cwd:${snapshot.cwd}`, `backend:${snapshot.backend}`)
    checks.push(check("session-created", snapshot.id.length > 0 && snapshot.cwd === options.cwd, "CERTIFICATION_SESSION"))
    const events: AgentEvent[] = []
    const stream = backend.send({ sessionId: snapshot.id, message: "certification fixture request", signal: turn.signal })
    for await (const event of withTimeoutStream(stream, profile.timeoutMs ?? 30_000)) {
      events.push(event)
      metadata.push(`${event.seq}:${event.type}`)
      if (event.type === "assistant.delta") streamedDeltas += 1
      if (event.type === "approval.required") {
        approvals += 1
        if (profile.resolveApproval === undefined) {
          checks.push(check("approval-resolution", false, "CERTIFICATION_APPROVAL_UNHANDLED"))
        } else if (backend.resolveApproval === undefined) {
          checks.push(check("approval-resolution", false, "CERTIFICATION_APPROVAL_UNSUPPORTED"))
        } else {
          const approved = await withTimeout(Promise.resolve(profile.resolveApproval({ backend, sessionId: snapshot.id, approvalId: event.approvalId })), profile.timeoutMs ?? 30_000)
          const resolved = await backend.resolveApproval(snapshot.id, event.approvalId, approved)
          checks.push(check("approval-resolution", resolved === true, "CERTIFICATION_APPROVAL_FAILED"))
        }
      }
    }
    checks.push(check("event-order", monotonic(events), "CERTIFICATION_EVENT_ORDER"))
    checks.push(check("streamed-or-message", streamedDeltas > 0 || events.some((event) => event.type === "assistant.message"), "CERTIFICATION_NO_OUTPUT"))
    checks.push(check("terminal-event", hasTerminal(events), "CERTIFICATION_NO_TERMINAL"))
    const reloaded = await withTimeout(backend.reload(snapshot.id), profile.timeoutMs ?? 30_000)
    checks.push(check("reload", isReloadResult(reloaded), "CERTIFICATION_RELOAD"))
    await runRequiredBehaviors(profile, backend, snapshot, events, checks, profile.timeoutMs ?? 30_000)
    return finish(profile, checks, metadata, started, events.length, streamedDeltas, approvals)
  } catch (error) {
    turn.abort()
    checks.push(check("execution", false, error instanceof CertificationError ? error.code : "CERTIFICATION_FAILED"))
    return finish(profile, checks, metadata, started, 0, streamedDeltas, approvals)
  } finally {
    if (backend !== undefined && snapshot !== undefined) await backend.close(snapshot.id).catch(() => undefined)
  }
}

export async function certifyAdapters(
  profiles: readonly AdapterCertificationProfile[],
  options: { readonly cwd: string; readonly maxProfiles?: number },
): Promise<CertificationSuiteResult> {
  const maxProfiles = options.maxProfiles ?? 32
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > maxProfiles || !Number.isSafeInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 256)
    throw new CertificationError("CERTIFICATION_INVALID", "profile list is invalid")
  const results: AdapterCertificationResult[] = []
  for (const profile of profiles) results.push(await certifyAdapter(profile, { cwd: options.cwd }))
  return Object.freeze({ version: 1, ok: results.every((result) => result.ok), results: Object.freeze(results) })
}

function finish(
  profile: AdapterCertificationProfile,
  checks: readonly CertificationCheck[],
  metadata: readonly string[],
  started: number,
  eventCount: number,
  streamedDeltas: number,
  approvals: number,
): AdapterCertificationResult {
  const normalized = metadata.join("\n")
  const digest = createHash("sha256").update(normalized).digest("hex")
  return Object.freeze({
    version: 1,
    id: profile.id,
    kind: profile.kind,
    adapterVersion: profile.version,
    capabilities: Object.freeze([...profile.capabilities].sort()),
    ok: checks.length > 0 && checks.every((item) => item.ok),
    checks: Object.freeze([...checks]),
    eventCount,
    streamedDeltas,
    approvals,
    elapsedMs: Math.max(0, performance.now() - started),
    digest,
  })
}

function validateProfile(profile: AdapterCertificationProfile, cwd: string): void {
  if (!isRecord(profile) || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(profile.id) || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/.test(profile.version) || !isCertificationKind(profile.kind) || !Array.isArray(profile.capabilities) || typeof profile.create !== "function" || typeof cwd !== "string" || cwd.length === 0)
    throw new CertificationError("CERTIFICATION_INVALID", "certification profile is invalid")
  if (profile.capabilities.some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)))
    throw new CertificationError("CERTIFICATION_INVALID", "certification capabilities are invalid")
  if (profile.requiredCapabilities !== undefined && (!Array.isArray(profile.requiredCapabilities) || profile.requiredCapabilities.some((value) => typeof value !== "string")))
    throw new CertificationError("CERTIFICATION_INVALID", "required capabilities are invalid")
  if (profile.requiredBehaviors !== undefined && (!Array.isArray(profile.requiredBehaviors) || profile.requiredBehaviors.length > 16 || profile.requiredBehaviors.some((value) => !isCertificationBehavior(value))))
    throw new CertificationError("CERTIFICATION_INVALID", "required certification behaviors are invalid")
  if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 120_000))
    throw new CertificationError("CERTIFICATION_INVALID", "certification timeout is invalid")
}

function isCertificationKind(value: unknown): value is CertificationAdapterKind {
  return value === "pi-compatible" || value === "codex-compatible" || value === "claude-compatible" || value === "grok-compatible" || value === "remote" || value === "a2a-compatible"
}

function isBackendInfo(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === "string")
}

function isReloadResult(value: unknown): value is ReloadResult {
  return isRecord(value) && typeof value.revision === "string" && Array.isArray(value.loaded) && Array.isArray(value.disabled) && typeof value.rolledBack === "boolean"
}

function check(name: string, ok: boolean, code: string): CertificationCheck {
  return Object.freeze({ name, ok, ...(ok ? {} : { code }) })
}

function includesAll(required: readonly string[], values: readonly string[]): boolean {
  return required.every((item) => values.includes(item))
}

function monotonic(events: readonly AgentEvent[]): boolean {
  let sequence = -1
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= sequence) return false
    sequence = event.seq
  }
  return true
}

function hasTerminal(events: readonly AgentEvent[]): boolean {
  return events.some((event) => event.type === "session.completed" || event.type === "session.failed" || event.type === "session.stopped")
}

async function runRequiredBehaviors(
  profile: AdapterCertificationProfile,
  backend: AgentBackend,
  snapshot: AgentSessionSnapshot,
  events: readonly AgentEvent[],
  checks: CertificationCheck[],
  timeoutMs: number,
): Promise<void> {
  for (const behavior of profile.requiredBehaviors ?? []) {
    if (behavior === "session-lifecycle") {
      checks.push(check(`behavior:${behavior}`, snapshot.id.length > 0 && hasTerminal(events), "CERTIFICATION_LIFECYCLE"))
      continue
    }
    if (behavior === "streaming") {
      checks.push(check(`behavior:${behavior}`, events.some((event) => event.type === "assistant.delta" || event.type === "assistant.message"), "CERTIFICATION_STREAMING"))
      continue
    }
    if (behavior === "tool-mapping") {
      checks.push(check(`behavior:${behavior}`, toolMapping(events), "CERTIFICATION_TOOL_MAPPING"))
      continue
    }
    if (behavior === "approval") {
      checks.push(check(`behavior:${behavior}`, events.some((event) => event.type === "approval.required") && checks.some((item) => item.name === "approval-resolution" && item.ok), "CERTIFICATION_APPROVAL"))
      continue
    }
    const probe = profile.probes?.[behavior]
    if (probe === undefined) {
      checks.push(check(`behavior:${behavior}`, false, "CERTIFICATION_PROBE_MISSING"))
      continue
    }
    try {
      const ok = await withTimeout(Promise.resolve(probe({ backend, sessionId: snapshot.id, snapshot, events })), timeoutMs)
      checks.push(check(`behavior:${behavior}`, ok === true, `CERTIFICATION_${behavior.toUpperCase().replaceAll("-", "_")}`))
    } catch (error) {
      checks.push(check(`behavior:${behavior}`, false, error instanceof CertificationError ? error.code : "CERTIFICATION_PROBE_FAILED"))
    }
  }
}

function toolMapping(events: readonly AgentEvent[]): boolean {
  const started = new Set<string>()
  const completed = new Set<string>()
  for (const event of events) {
    if (event.type === "tool.started") started.add(`${event.callId}:${event.name}`)
    if (event.type === "tool.completed") completed.add(`${event.callId}:${event.name}`)
  }
  return started.size > 0 && [...completed].every((key) => started.has(key))
}

function isCertificationBehavior(value: unknown): value is CertificationBehavior {
  return value === "session-lifecycle" || value === "streaming" || value === "tool-mapping" || value === "approval" || value === "cancellation" || value === "output-bounds" || value === "capability-rejection" || value === "retry-fallback" || value === "verification-repair"
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new CertificationError("CERTIFICATION_TIMEOUT", "adapter operation timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function* withTimeoutStream(stream: AsyncIterable<AgentEvent>, timeoutMs: number): AsyncGenerator<AgentEvent> {
  const iterator = stream[Symbol.asyncIterator]()
  for (;;) {
    const next = await withTimeout(iterator.next(), timeoutMs)
    if (next.done) return
    yield next.value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
