import {
  BoundedSubagentRunner,
  type SubagentExecutor,
  type SubagentResult,
  type SubagentRunnerOptions,
  type SubagentSpec,
} from "@nifrajs/coding-agent"
import { createHash } from "node:crypto"
import { relative, resolve, sep } from "node:path"
import { createRunrailSession } from "../session.ts"
import type { RunrailSessionOptions } from "../session.ts"

export interface RunrailAgentProfile {
  readonly id: string
  readonly role: string
  readonly description?: string
  readonly capabilities: readonly string[]
  readonly maxDepth?: number
  readonly timeoutMs?: number
}

export type RunrailAgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled"
export interface RunrailAgentRunSnapshot {
  readonly id: string
  readonly profile: string
  readonly role: string
  readonly status: RunrailAgentRunStatus
  readonly attempts: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly elapsedMs: number
  readonly errorCode?: string
  readonly digest: string
}

export interface RunrailAgentTask {
  readonly id: string
  readonly profile: string
  readonly prompt: string
  readonly cwd?: string
  readonly requiredCapabilities?: readonly string[]
  readonly timeoutMs?: number
  readonly maxDepth?: number
  readonly retryable?: boolean
  readonly maxRetries?: number
}

export interface RunrailAgentRunOptions {
  readonly signal?: AbortSignal
  readonly maxConcurrency?: number
}

export interface RunrailAgentResult {
  readonly id: string
  readonly profile: string
  readonly role: string
  readonly ok: boolean
  readonly output?: unknown
  readonly errorCode?: string
  readonly attempts: number
  readonly elapsedMs: number
  readonly digest: string
}

export interface MultiAgentCoordinatorOptions {
  readonly profiles: readonly RunrailAgentProfile[] | AgentProfileRegistry
  readonly executor: SubagentExecutor
  readonly cwd: string
  readonly maxChildren?: number
  readonly maxDepth?: number
  readonly allowedCapabilities?: readonly string[]
  readonly workspace?: SubagentRunnerOptions["workspace"]
  readonly maxRunSnapshots?: number
}

export type AgentRegistryErrorCode = "AGENT_INVALID" | "AGENT_DUPLICATE" | "AGENT_NOT_FOUND" | "AGENT_CAPABILITY_DENIED" | "AGENT_LIMIT" | "AGENT_FAILED" | "AGENT_CANCELLED"

export class AgentRegistryError extends Error {
  constructor(readonly code: AgentRegistryErrorCode, reason: string) {
    super(`agent registry: ${reason}`)
    this.name = "AgentRegistryError"
  }
}

/** Registry of explicit, capability-bounded agent roles. */
export class AgentProfileRegistry {
  private readonly profiles = new Map<string, RunrailAgentProfile>()

  constructor(profiles: readonly RunrailAgentProfile[] = []) {
    for (const profile of profiles) this.register(profile)
  }

  register(profile: RunrailAgentProfile): this {
    validateProfile(profile)
    if (this.profiles.has(profile.id)) throw new AgentRegistryError("AGENT_DUPLICATE", `duplicate agent profile '${profile.id}'`)
    this.profiles.set(profile.id, Object.freeze({ ...profile, capabilities: Object.freeze([...profile.capabilities].sort()) }))
    return this
  }

  get(id: string): RunrailAgentProfile | undefined {
    return this.profiles.get(id)
  }

  list(): readonly RunrailAgentProfile[] {
    return Object.freeze([...this.profiles.values()].sort((left, right) => left.id.localeCompare(right.id)))
  }

  require(id: string): RunrailAgentProfile {
    const profile = this.profiles.get(id)
    if (profile === undefined) throw new AgentRegistryError("AGENT_NOT_FOUND", `unknown agent profile '${id}'`)
    return profile
  }
}

/** Bounded multi-agent facade; all actual model/provider execution stays caller-owned. */
export class MultiAgentCoordinator {
  readonly profiles: AgentProfileRegistry
  private readonly executor: SubagentExecutor
  private readonly cwd: string
  private readonly runnerOptions: Omit<SubagentRunnerOptions, "signal">
  private readonly runs = new Map<string, RunrailAgentRunSnapshot>()
  private readonly maxRunSnapshots: number
  private reservedChildren = 0
  private readonly reservedIds = new Set<string>()
  constructor(options: MultiAgentCoordinatorOptions) {
    if (options === null || typeof options !== "object" || typeof options.cwd !== "string" || options.cwd.length === 0 || options.cwd.length > 4_096)
      throw new AgentRegistryError("AGENT_INVALID", "coordinator options are invalid")
    this.profiles = options.profiles instanceof AgentProfileRegistry ? options.profiles : new AgentProfileRegistry(options.profiles)
    this.executor = options.executor
    this.cwd = options.cwd
    const maxChildren = options.maxChildren ?? 16
    const maxDepth = options.maxDepth ?? 4
    const maxRunSnapshots = options.maxRunSnapshots ?? 256
    if (!Number.isSafeInteger(maxChildren) || maxChildren < 1 || maxChildren > 128 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 16 || !Number.isSafeInteger(maxRunSnapshots) || maxRunSnapshots < 1 || maxRunSnapshots > 1_024)
      throw new AgentRegistryError("AGENT_LIMIT", "coordinator limits are invalid")
    this.maxRunSnapshots = maxRunSnapshots
    if (options.allowedCapabilities !== undefined && (!Array.isArray(options.allowedCapabilities) || options.allowedCapabilities.length > 64 || options.allowedCapabilities.some((value) => !validCapability(value))))
      throw new AgentRegistryError("AGENT_INVALID", "allowed capabilities are invalid")
    this.runnerOptions = {
      maxChildren,
      maxDepth,
      ...(options.allowedCapabilities === undefined ? {} : { allowedCapabilities: Object.freeze([...new Set(options.allowedCapabilities)].sort()) }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    }
  }


  listProfiles(): readonly RunrailAgentProfile[] {
    return this.profiles.list()
  }

  listRuns(): readonly RunrailAgentRunSnapshot[] {
    return Object.freeze([...this.runs.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)))
  }

  async run(task: RunrailAgentTask, options: RunrailAgentRunOptions = {}): Promise<RunrailAgentResult> {
    const results = await this.runMany([task], { ...options, maxConcurrency: 1 })
    return results[0]!
  }

  async runMany(tasks: readonly RunrailAgentTask[], options: RunrailAgentRunOptions = {}): Promise<readonly RunrailAgentResult[]> {
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 128) throw new AgentRegistryError("AGENT_LIMIT", "agent task list is invalid")
    const ids = tasks.map((task) => { validateTask(task); return task.id })
    if (new Set(ids).size !== ids.length || ids.some((id) => this.reservedIds.has(id))) throw new AgentRegistryError("AGENT_DUPLICATE", "agent task id is already admitted")
    if (this.reservedChildren + tasks.length > this.runnerOptions.maxChildren!) throw new AgentRegistryError("AGENT_LIMIT", "coordinator child limit exceeded")
    this.reservedChildren += tasks.length
    for (const id of ids) this.reservedIds.add(id)
    try {
      return await this.runBatch(tasks, options)
    } finally {
      this.reservedChildren -= tasks.length
      for (const id of ids) this.reservedIds.delete(id)
    }
  }

  private async runBatch(tasks: readonly RunrailAgentTask[], options: RunrailAgentRunOptions): Promise<readonly RunrailAgentResult[]> {
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 128) throw new AgentRegistryError("AGENT_LIMIT", "agent task list is invalid")
    const normalized = tasks.map((task) => this.normalizeTask(task))
    if (new Set(normalized.map((task) => task.id)).size !== normalized.length) throw new AgentRegistryError("AGENT_INVALID", "agent task ids must be unique")
    const queuedAt = Date.now()
    for (const task of normalized) {
      const profile = this.profiles.require(task.profile)
      this.setRun(runSnapshot(task, profile, "queued", 0, queuedAt, queuedAt, 0))
    }
    const maxConcurrency = options.maxConcurrency ?? Math.min(normalized.length, 8)
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) throw new AgentRegistryError("AGENT_LIMIT", "agent concurrency is invalid")
    const runner = new BoundedSubagentRunner(this.executor, { ...this.runnerOptions, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    const results: RunrailAgentResult[] = Array.from({ length: normalized.length })
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= normalized.length) return
        const task = normalized[index]!
        const profile = this.profiles.require(task.profile)
        const startedAt = Date.now()
        const started = performance.now()
        const attempts = Math.min(task.maxRetries ?? 0, task.retryable === true ? 3 : 0) + 1
        let raw: SubagentResult | undefined
        let made = 0
        let cancelled = false
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          // Every task left gets its cancelled result, so the batch never returns a hole or leaves one queued.
          if (options.signal?.aborted) {
            const result = failedResult(task, profile, attempt, started, "AGENT_CANCELLED")
            results[index] = result
            this.setRun(resultSnapshot(result, profile, "cancelled", startedAt))
            cancelled = true
            break
          }
          this.setRun(runSnapshot(task, profile, "running", attempt + 1, startedAt, Date.now(), performance.now() - started))
          made += 1
          raw = await runner.run(toSpec(task, profile)).catch((error: unknown) => ({ id: task.id, role: profile.role, ok: false, error: error instanceof Error ? error.message : "agent execution failed" }))
          if (raw.ok || task.retryable !== true) break
        }
        if (cancelled) continue
        const result = normalizeResult(task, profile, raw!, made, performance.now() - started)
        results[index] = result
        this.setRun(resultSnapshot(result, profile, result.ok ? "completed" : "failed", startedAt))
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, normalized.length) }, () => worker()))
    return Object.freeze(results)
  }

  private normalizeTask(task: RunrailAgentTask): RunrailAgentTask {
    validateTask(task)
    const profile = this.profiles.require(task.profile)
    const required = task.requiredCapabilities ?? profile.capabilities
    if (!required.every((capability) => profile.capabilities.includes(capability))) throw new AgentRegistryError("AGENT_CAPABILITY_DENIED", `agent profile '${profile.id}' cannot satisfy requested capabilities`)
    if (this.runnerOptions.allowedCapabilities !== undefined && !profile.capabilities.every((capability) => this.runnerOptions.allowedCapabilities!.includes(capability))) throw new AgentRegistryError("AGENT_CAPABILITY_DENIED", `agent profile '${profile.id}' exceeds coordinator capabilities`)
    if (this.runnerOptions.allowedCapabilities !== undefined && !required.every((capability) => this.runnerOptions.allowedCapabilities!.includes(capability))) throw new AgentRegistryError("AGENT_CAPABILITY_DENIED", "agent task exceeds coordinator capabilities")
    if (task.cwd !== undefined && this.runnerOptions.workspace !== undefined) {
      const roots = this.runnerOptions.workspace.allowedRoots ?? [this.runnerOptions.workspace.root]
      if (!within(this.runnerOptions.workspace.root, task.cwd) || !roots.some((root) => within(root, task.cwd!))) throw new AgentRegistryError("AGENT_CAPABILITY_DENIED", "agent task workspace is not authorized")
    }
    return Object.freeze({ ...task, requiredCapabilities: Object.freeze([...new Set(required)].sort()), cwd: task.cwd ?? this.cwd })
  }
  private setRun(snapshot: RunrailAgentRunSnapshot): void {
    this.runs.set(snapshot.id, snapshot)
    while (this.runs.size > this.maxRunSnapshots) {
      const oldest = [...this.runs.values()].sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))[0]
      if (oldest === undefined) return
      this.runs.delete(oldest.id)
    }
  }

}

export interface RunrailSessionAgentExecutorOptions {
  readonly session: Omit<RunrailSessionOptions, "cwd" | "sessionId">
  readonly maxOutputChars?: number
}

/** Adapt Runrail sessions to the public Nifra subagent executor contract. */
export function createRunrailSessionAgentExecutor(options: RunrailSessionAgentExecutorOptions): SubagentExecutor {
  const maxOutputChars = options.maxOutputChars ?? 256 * 1024
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > 4 * 1024 * 1024) throw new AgentRegistryError("AGENT_LIMIT", "agent output limit is invalid")
  return {
    run: async ({ spec, signal, cwd }) => {
      const aliases: Readonly<Record<string, readonly string[]>> = { read: ["read", "filesystem.read"], write: ["write", "filesystem.write"], exec: ["process", "process.exec"] }
      const capabilities = (spec.capabilities ?? []).flatMap((capability) => Object.hasOwn(aliases, capability) ? aliases[capability]! : [capability])
      const ceiling = options.session.allowedToolCapabilities
      const allowedToolCapabilities = capabilities.filter((capability) => ceiling === undefined || ceiling.includes(capability))
      const session = await createRunrailSession({ ...options.session, cwd: cwd ?? process.cwd(), sessionId: `agent-${spec.id}`, allowedToolCapabilities, loadExtensions: false, verifyAfterTurn: allowedToolCapabilities.includes("process.exec") && options.session.verifyAfterTurn !== false, checkpoints: false })
      // A message repeats the deltas streamed before it, so it replaces them instead of adding to them.
      const output: string[] = []
      let bytes = 0
      let streamed = ""
      let streamedBytes = 0
      let status = "idle"
      try {
        for await (const event of session.prompt(spec.prompt, signal)) {
          if (event.type === "assistant.delta") {
            streamed += event.text
            streamedBytes += Buffer.byteLength(event.text, "utf8")
          }
          if (event.type === "assistant.message") {
            output.push(event.text)
            bytes += Buffer.byteLength(event.text, "utf8")
            streamed = ""
            streamedBytes = 0
          }
          if (bytes + streamedBytes > maxOutputChars) throw new AgentRegistryError("AGENT_LIMIT", "agent output exceeds its byte limit")
          if (event.type === "session.completed") status = "completed"
          if (event.type === "session.stopped") status = "stopped"
          if (event.type === "session.failed") {
            status = "failed"
            throw new AgentRegistryError("AGENT_FAILED", "agent session failed")
          }
        }
        if (signal.aborted) throw new AgentRegistryError("AGENT_CANCELLED", "agent session was cancelled")
        return Object.freeze({ status, text: output.join("") + streamed })
      } finally {
        await session.stop(signal.aborted ? "agent cancelled" : "agent complete")
      }
    },
  }
}

export async function createAgentHandoff(input: {
  readonly handoffId: string
  readonly runId: string
  readonly source: string
  readonly target: string
  readonly objective: string
  readonly acceptance: string
  readonly completedNodeIds?: readonly string[]
  readonly remainingNodeIds?: readonly string[]
  readonly changedPaths?: readonly string[]
}): Promise<import("../handoff.ts").PortableHandoff> {
  return import("../handoff.ts").then(({ createPortableHandoff }) => createPortableHandoff(input))
}

function toSpec(task: RunrailAgentTask, profile: RunrailAgentProfile): SubagentSpec {
  return {
    id: task.id,
    role: profile.role,
    prompt: task.prompt,
    capabilities: task.requiredCapabilities ?? profile.capabilities,
    ...(task.maxDepth === undefined && profile.maxDepth === undefined ? {} : { maxDepth: Math.min(task.maxDepth ?? profile.maxDepth!, profile.maxDepth ?? task.maxDepth!) }),
    ...(task.timeoutMs === undefined && profile.timeoutMs === undefined ? {} : { timeoutMs: Math.min(task.timeoutMs ?? profile.timeoutMs!, profile.timeoutMs ?? task.timeoutMs!) }),
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
  }
}

function normalizeResult(task: RunrailAgentTask, profile: RunrailAgentProfile, raw: SubagentResult, attempts: number, elapsedMs: number): RunrailAgentResult {
  const digest = createHash("sha256").update(JSON.stringify({ id: task.id, profile: profile.id, ok: raw.ok, error: raw.error })).digest("hex")
  return Object.freeze({ id: task.id, profile: profile.id, role: profile.role, ok: raw.ok, ...(raw.output === undefined ? {} : { output: raw.output }), ...(raw.ok ? {} : { errorCode: agentErrorCode(raw.error) }), attempts, elapsedMs: Math.max(0, elapsedMs), digest })
}

/** The runner reports a failure as text only; its known refusals map to codes a caller can act on. */
function agentErrorCode(error: string | undefined): string {
  if (error === undefined) return "AGENT_FAILED"
  if (/^(?:subagent capability denied|subagent workspace |isolated worktree escapes)/.test(error)) return "AGENT_CAPABILITY_DENIED"
  if (/^(?:invalid subagent id|subagent .*(?:limit exceeded|empty or too long|is invalid)$)/.test(error)) return "AGENT_LIMIT"
  if (/abort|cancel/i.test(error)) return "AGENT_CANCELLED"
  if (/timed? ?out|timeout/i.test(error)) return "AGENT_TIMEOUT"
  return "AGENT_FAILED"
}

function failedResult(task: RunrailAgentTask, profile: RunrailAgentProfile, attempts: number, started: number, errorCode: string): RunrailAgentResult {
  return Object.freeze({ id: task.id, profile: profile.id, role: profile.role, ok: false, errorCode, attempts, elapsedMs: Math.max(0, performance.now() - started), digest: createHash("sha256").update(JSON.stringify({ id: task.id, profile: profile.id, ok: false, errorCode })).digest("hex") })
}

function validateProfile(profile: RunrailAgentProfile): void {
  if (profile === null || typeof profile !== "object" || !validId(profile.id) || typeof profile.role !== "string" || profile.role.length === 0 || profile.role.length > 128 || !Array.isArray(profile.capabilities) || profile.capabilities.length > 64 || profile.capabilities.some((value) => !validCapability(value)) || (profile.description !== undefined && (typeof profile.description !== "string" || profile.description.length > 512)) || (profile.maxDepth !== undefined && (!Number.isSafeInteger(profile.maxDepth) || profile.maxDepth < 0 || profile.maxDepth > 16)) || (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 120_000))) throw new AgentRegistryError("AGENT_INVALID", "agent profile is invalid")
}

function validateTask(task: RunrailAgentTask): void {
  if (task === null || typeof task !== "object" || !validId(task.id) || !validId(task.profile) || typeof task.prompt !== "string" || task.prompt.length === 0 || task.prompt.length > 256 * 1024 || (task.cwd !== undefined && (typeof task.cwd !== "string" || task.cwd.length === 0 || task.cwd.length > 4_096)) || (task.requiredCapabilities !== undefined && (!Array.isArray(task.requiredCapabilities) || task.requiredCapabilities.length > 64 || task.requiredCapabilities.some((value) => !validCapability(value)))) || (task.timeoutMs !== undefined && (!Number.isSafeInteger(task.timeoutMs) || task.timeoutMs < 1 || task.timeoutMs > 120_000)) || (task.maxDepth !== undefined && (!Number.isSafeInteger(task.maxDepth) || task.maxDepth < 0 || task.maxDepth > 16)) || (task.retryable !== undefined && typeof task.retryable !== "boolean") || (task.maxRetries !== undefined && (!Number.isSafeInteger(task.maxRetries) || task.maxRetries < 0 || task.maxRetries > 3))) throw new AgentRegistryError("AGENT_INVALID", "agent task is invalid")
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function within(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith("/"))
}

function runSnapshot(task: RunrailAgentTask, profile: RunrailAgentProfile, status: RunrailAgentRunStatus, attempts: number, startedAt: number, updatedAt: number, elapsedMs: number, errorCode?: string): RunrailAgentRunSnapshot {
  const digest = createHash("sha256").update(JSON.stringify({ id: task.id, profile: profile.id, status, attempts, errorCode })).digest("hex")
  return Object.freeze({ id: task.id, profile: profile.id, role: profile.role, status, attempts, startedAt, updatedAt, elapsedMs: Math.max(0, elapsedMs), ...(errorCode === undefined ? {} : { errorCode }), digest })
}

function resultSnapshot(result: RunrailAgentResult, profile: RunrailAgentProfile, status: RunrailAgentRunStatus, startedAt: number): RunrailAgentRunSnapshot {
  return Object.freeze({ id: result.id, profile: result.profile, role: profile.role, status, attempts: result.attempts, startedAt, updatedAt: Date.now(), elapsedMs: result.elapsedMs, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }), digest: result.digest })
}
