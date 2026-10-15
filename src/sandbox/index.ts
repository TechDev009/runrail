export type SandboxKind = "none" | "os" | "container" | "vm" | "caller"

export interface SandboxDescriptor {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly kind: SandboxKind
  readonly isolated: boolean
  readonly capabilities: readonly string[]
  readonly platform?: string
}

export interface SandboxRequirements {
  readonly requireIsolation?: boolean
  readonly preferredKind?: SandboxKind
  readonly requiredCapabilities?: readonly string[]
}

export interface SandboxRunInput {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly signal: AbortSignal
}

export interface SandboxRunResult {
  readonly status: number
  readonly stdout?: string
  readonly stderr?: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly cancelled: boolean
}

export interface SandboxExecutor {
  readonly descriptor: SandboxDescriptor
  run(input: SandboxRunInput): SandboxRunResult | PromiseLike<SandboxRunResult>
  close?(): void | PromiseLike<void>
}

export type SandboxErrorCode = "SANDBOX_INVALID" | "SANDBOX_DUPLICATE" | "SANDBOX_NOT_FOUND" | "SANDBOX_ISOLATION_REQUIRED" | "SANDBOX_CAPABILITY_DENIED" | "SANDBOX_LIMIT" | "SANDBOX_FAILED"

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode, reason: string) {
    super(`sandbox: ${reason}`)
    this.name = "SandboxError"
  }
}

/** Descriptor for the default local process boundary, which is intentionally not isolated. */
export const UNSANDBOXED_PROCESS_DESCRIPTOR: SandboxDescriptor = Object.freeze({
  id: "local-process",
  name: "Local process",
  version: "1.0.0",
  kind: "none",
  isolated: false,
  capabilities: Object.freeze(["process.exec"]),
})

export class SandboxRegistry {
  private readonly executors = new Map<string, SandboxExecutor>()

  constructor(executors: readonly SandboxExecutor[] = []) {
    for (const executor of executors) this.register(executor)
  }

  register(executor: SandboxExecutor): this {
    validateExecutor(executor)
    if (this.executors.has(executor.descriptor.id)) throw new SandboxError("SANDBOX_DUPLICATE", "duplicate sandbox id")
    this.executors.set(executor.descriptor.id, freezeExecutor(executor))
    return this
  }

  get(id: string): SandboxExecutor | undefined {
    return this.executors.get(id)
  }

  list(): readonly SandboxDescriptor[] {
    return Object.freeze([...this.executors.values()].map((executor) => executor.descriptor).sort((left, right) => left.id.localeCompare(right.id)))
  }

  select(requirements: SandboxRequirements = {}): SandboxExecutor {
    validateRequirements(requirements)
    const required = requirements.requiredCapabilities ?? []
    const candidates = [...this.executors.values()].filter((executor) =>
      (!requirements.requireIsolation || executor.descriptor.isolated) &&
      (requirements.preferredKind === undefined || executor.descriptor.kind === requirements.preferredKind) &&
      required.every((capability) => executor.descriptor.capabilities.includes(capability)),
    )
    if (candidates.length === 0) {
      if (requirements.requireIsolation) throw new SandboxError("SANDBOX_ISOLATION_REQUIRED", "no isolated executor satisfies the request")
      if (required.length > 0) throw new SandboxError("SANDBOX_CAPABILITY_DENIED", "no sandbox satisfies the requested capabilities")
      throw new SandboxError("SANDBOX_NOT_FOUND", "no sandbox executor is available")
    }
    return candidates.sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id))[0]!
  }

  async close(): Promise<void> {
    for (const executor of this.executors.values()) await executor.close?.()
  }
}

export function createSandboxRegistry(executors: readonly SandboxExecutor[] = []): SandboxRegistry {
  return new SandboxRegistry(executors)
}

export function createCallerSandboxExecutor(
  descriptor: SandboxDescriptor,
  run: (input: SandboxRunInput) => SandboxRunResult | PromiseLike<SandboxRunResult>,
  close?: () => void | PromiseLike<void>,
): SandboxExecutor {
  validateDescriptor(descriptor)
  if (typeof run !== "function") throw new SandboxError("SANDBOX_INVALID", "sandbox runner is invalid")
  return Object.freeze({ descriptor: freezeDescriptor(descriptor), run: async (input: SandboxRunInput) => {
    validateRunInput(input)
    let result: unknown
    try {
      result = await run(input)
    } catch {
      throw new SandboxError("SANDBOX_FAILED", "sandbox execution failed")
    }
    return validateRunResult(result)
  }, ...(close === undefined ? {} : { close }) })
}

export function parseSandboxDescriptor(value: unknown): SandboxDescriptor {
  validateDescriptor(value)
  return freezeDescriptor(value)
}

export function negotiateSandbox(descriptor: SandboxDescriptor, requirements: SandboxRequirements = {}): SandboxDescriptor {
  validateDescriptor(descriptor)
  validateRequirements(requirements)
  if (requirements.requireIsolation === true && !descriptor.isolated) throw new SandboxError("SANDBOX_ISOLATION_REQUIRED", "selected sandbox is not isolated")
  if (requirements.preferredKind !== undefined && descriptor.kind !== requirements.preferredKind) throw new SandboxError("SANDBOX_INVALID", "sandbox kind does not match the request")
  if (!(requirements.requiredCapabilities ?? []).every((capability) => descriptor.capabilities.includes(capability))) throw new SandboxError("SANDBOX_CAPABILITY_DENIED", "sandbox capabilities are insufficient")
  return freezeDescriptor(descriptor)
}

function validateExecutor(executor: SandboxExecutor): void {
  if (executor === null || typeof executor !== "object" || executor.descriptor === undefined || typeof executor.run !== "function") throw new SandboxError("SANDBOX_INVALID", "sandbox executor is invalid")
  validateDescriptor(executor.descriptor)
  if (executor.close !== undefined && typeof executor.close !== "function") throw new SandboxError("SANDBOX_INVALID", "sandbox close function is invalid")
}

function validateDescriptor(value: unknown): asserts value is SandboxDescriptor {
  if (!isRecord(value) || !validId(value.id) || typeof value.name !== "string" || value.name.length === 0 || value.name.length > 128 || !validVersion(value.version) || !isSandboxKind(value.kind) || typeof value.isolated !== "boolean" || !Array.isArray(value.capabilities) || value.capabilities.length > 64 || value.capabilities.some((capability) => !validCapability(capability)) || value.kind === "none" && value.isolated || value.platform !== undefined && (typeof value.platform !== "string" || value.platform.length === 0 || value.platform.length > 64)) throw new SandboxError("SANDBOX_INVALID", "sandbox descriptor is invalid")
}

function validateRequirements(value: SandboxRequirements): void {
  if (!isRecord(value) || value.requireIsolation !== undefined && typeof value.requireIsolation !== "boolean" || value.preferredKind !== undefined && !isSandboxKind(value.preferredKind) || value.requiredCapabilities !== undefined && (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length > 64 || value.requiredCapabilities.some((capability) => !validCapability(capability)))) throw new SandboxError("SANDBOX_INVALID", "sandbox requirements are invalid")
}

function validateRunInput(value: unknown): asserts value is SandboxRunInput {
  if (!isRecord(value) || !Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > 128 || value.argv.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 4_096) || typeof value.cwd !== "string" || value.cwd.length === 0 || value.cwd.length > 4_096 || value.env !== undefined && (!isRecord(value.env) || Object.entries(value.env).some(([name, entry]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof entry !== "string" || entry.length > 16 * 1024)) || value.timeoutMs !== undefined && !bounded(value.timeoutMs, 1, 120_000) || value.maxOutputBytes !== undefined && !bounded(value.maxOutputBytes, 1, 16 * 1024 * 1024) || !(value.signal instanceof AbortSignal)) throw new SandboxError("SANDBOX_INVALID", "sandbox run input is invalid")
}

function validateRunResult(value: unknown): SandboxRunResult {
  if (!isRecord(value)) throw new SandboxError("SANDBOX_FAILED", "sandbox result is invalid")
  const { status, stdout, stderr, truncated, timedOut, cancelled } = value
  if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 0 || status > 255 || typeof truncated !== "boolean" || typeof timedOut !== "boolean" || typeof cancelled !== "boolean" || stdout !== undefined && (typeof stdout !== "string" || stdout.length > 16 * 1024 * 1024) || stderr !== undefined && (typeof stderr !== "string" || stderr.length > 16 * 1024 * 1024)) throw new SandboxError("SANDBOX_FAILED", "sandbox result is invalid")
  return Object.freeze({ status, ...(stdout === undefined ? {} : { stdout }), ...(stderr === undefined ? {} : { stderr }), truncated, timedOut, cancelled })
}

function freezeExecutor(executor: SandboxExecutor): SandboxExecutor {
  return Object.freeze({ descriptor: freezeDescriptor(executor.descriptor), run: executor.run.bind(executor), ...(executor.close === undefined ? {} : { close: executor.close.bind(executor) }) })
}

function freezeDescriptor(descriptor: SandboxDescriptor): SandboxDescriptor {
  return Object.freeze({ ...descriptor, capabilities: Object.freeze([...descriptor.capabilities].sort()) })
}

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
}

function isSandboxKind(value: unknown): value is SandboxKind {
  return value === "none" || value === "os" || value === "container" || value === "vm" || value === "caller"
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9.+:-]{0,63}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
