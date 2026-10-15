export const RUNRAIL_TERMINAL_MAX_INPUT_BYTES = 65_536 as const
export const RUNRAIL_TERMINAL_MAX_OUTPUT_BYTES = 1_048_576 as const

export type RunrailTerminalCapability = "create" | "write" | "read" | "resize" | "close"
export type RunrailTerminalSessionStatus = "running" | "closed"

export interface RunrailTerminalDescriptor {
  readonly id: string
  readonly version: string
  readonly capabilities: readonly RunrailTerminalCapability[]
}

export interface RunrailTerminalSession {
  readonly sessionId: string
  readonly cols: number
  readonly rows: number
  readonly status: RunrailTerminalSessionStatus
}

export interface RunrailTerminalChunk {
  readonly seq: number
  readonly data: string
}

export interface RunrailTerminalReadResult {
  readonly session: RunrailTerminalSession
  readonly chunks: readonly RunrailTerminalChunk[]
  readonly nextSeq: number
  readonly closed: boolean
  /** Output after `afterSeq` was dropped from the bounded buffer before this read. */
  readonly truncated?: true
}

export interface RunrailTerminalBridge {
  /** Caller-owned descriptor. Command paths, environment, and credentials are not part of it. */
  readonly descriptor: RunrailTerminalDescriptor
  readonly create: (input: {
    readonly sessionId: string
    readonly cwd: string
    readonly cols: number
    readonly rows: number
  }) => RunrailTerminalSession | PromiseLike<RunrailTerminalSession>
  readonly write: (input: {
    readonly sessionId: string
    readonly data: string
  }) => { readonly acceptedBytes: number } | PromiseLike<{ readonly acceptedBytes: number }>
  readonly read: (input: {
    readonly sessionId: string
    readonly afterSeq: number
    readonly maxBytes: number
    readonly maxChunks: number
  }) => RunrailTerminalReadResult | PromiseLike<RunrailTerminalReadResult>
  readonly resize: (input: {
    readonly sessionId: string
    readonly cols: number
    readonly rows: number
  }) => RunrailTerminalSession | PromiseLike<RunrailTerminalSession>
  readonly close: (input: {
    readonly sessionId: string
  }) => RunrailTerminalSession | PromiseLike<RunrailTerminalSession>
}

/** Validate the caller-owned terminal seam before it can be advertised. */
export function validateRunrailTerminalBridge(value: unknown): asserts value is RunrailTerminalBridge {
  if (!isRecord(value)) throw new TypeError("terminal bridge is invalid")
  const descriptor = value.descriptor
  if (!isRecord(descriptor)) throw new TypeError("terminal descriptor is invalid")
  const capabilities = descriptor.capabilities
  if (!validName(descriptor.id, 64) || !validVersion(descriptor.version, 64)) throw new TypeError("terminal descriptor metadata is invalid")
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 8 || capabilities.some((capability) => !isCapability(capability)) || new Set(capabilities).size !== capabilities.length)
    throw new TypeError("terminal descriptor capabilities are invalid")
  if (typeof value.create !== "function" || typeof value.write !== "function" || typeof value.read !== "function" || typeof value.resize !== "function" || typeof value.close !== "function")
    throw new TypeError("terminal bridge methods are invalid")
}

function isCapability(value: unknown): value is RunrailTerminalCapability {
  return value === "create" || value === "write" || value === "read" || value === "resize" || value === "close"
}

function validName(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(value)
}

function validVersion(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9.+:_/-]{0,63}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
