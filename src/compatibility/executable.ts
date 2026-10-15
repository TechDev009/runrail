import type { PiCompatibilityProbeResult, PiProbeStatus } from "./probes.ts"
import { terminateProcessTree } from "../backend/process-tree.ts"

export type PiExecutableProbeExpectation = "pass" | "refused"

export interface PiExecutableProbe {
  readonly id: string
  readonly featureId: string
  /** Explicit executable path or a bounded executable name resolved by the caller's PATH. */
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly expectation?: PiExecutableProbeExpectation
  readonly expectedExitCode?: number
  readonly refusalCode?: string
  /** `jsonl` validates and records only event type names; all other output is discarded. */
  readonly outputMode?: "ignore" | "jsonl"
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

export interface PiExecutableProbeOptions {
  readonly maxProbes?: number
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly signal?: AbortSignal
}

export type PiExecutableProbeErrorCode = "PI_EXECUTABLE_PROBE_INVALID" | "PI_EXECUTABLE_PROBE_LIMIT"

export class PiExecutableProbeError extends Error {
  constructor(readonly code: PiExecutableProbeErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "PiExecutableProbeError"
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Execute caller-supplied compatibility fixtures through a real process boundary.
 * Only exit status, bounded event names, and stable result codes leave this module.
 */
export async function runPiExecutableProbes(
  probes: readonly PiExecutableProbe[],
  options: PiExecutableProbeOptions = {},
): Promise<readonly PiCompatibilityProbeResult[]> {
  const maxProbes = options.maxProbes ?? 256
  const timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS)
  const maxOutputBytes = boundedInteger(options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES)
  if (!Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > 1_024)
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_LIMIT", "probe limit is invalid")
  if (!Array.isArray(probes) || probes.length > maxProbes)
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_LIMIT", "probe count exceeds the configured limit")

  const ids = new Set<string>()
  for (const probe of probes) {
    validateProbe(probe, timeoutMs, maxOutputBytes)
    if (ids.has(probe.id)) throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "probe ids must be unique")
    ids.add(probe.id)
  }

  const results: PiCompatibilityProbeResult[] = []
  for (const probe of probes) results.push(await runProbe(probe, options.signal, timeoutMs, maxOutputBytes))
  return Object.freeze(results)
}

async function runProbe(
  probe: PiExecutableProbe,
  signal: AbortSignal | undefined,
  defaultTimeoutMs: number,
  defaultMaxOutputBytes: number,
): Promise<PiCompatibilityProbeResult> {
  const started = performance.now()
  if (signal?.aborted) return result(probe, "cancelled", elapsed(started), "PROBE_CANCELLED")

  const timeoutMs = probe.timeoutMs ?? defaultTimeoutMs
  const maxOutputBytes = probe.maxOutputBytes ?? defaultMaxOutputBytes
  const expected = probe.expectation ?? "pass"
  const expectedExitCode = probe.expectedExitCode ?? (expected === "pass" ? 0 : 78)
  let child: Bun.Subprocess
  try {
    child = Bun.spawn([probe.command, ...(probe.args ?? [])], {
      ...(probe.cwd === undefined ? {} : { cwd: probe.cwd }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      detached: true,
    })
  } catch {
    return result(probe, "failed", elapsed(started), "PROBE_SPAWN_FAILED")
  }

  let interruption: "cancelled" | "timeout" | undefined
  const stopChild = (reason: "cancelled" | "timeout"): void => {
    if (interruption !== undefined) return
    interruption = reason
    void terminateProcessTree(child)
  }
  const onAbort = (): void => stopChild("cancelled")
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => stopChild("timeout"), timeoutMs)
  const stdout = consumeOutput(child.stdout, maxOutputBytes, probe.outputMode ?? "ignore")
  const stderr = consumeOutput(child.stderr, maxOutputBytes, "ignore")

  try {
    const exitCode = await child.exited
    const [stdoutResult, stderrResult] = await Promise.all([stdout, stderr])
    if (interruption === "cancelled") return result(probe, "cancelled", elapsed(started), "PROBE_CANCELLED")
    if (interruption === "timeout") return result(probe, "failed", elapsed(started), "PROBE_TIMEOUT")
    if (!stdoutResult.ok || !stderrResult.ok) return result(probe, "failed", elapsed(started), stdoutResult.code ?? stderrResult.code ?? "PROBE_OUTPUT_INVALID")
    if (exitCode !== expectedExitCode) {
      return result(probe, "failed", elapsed(started), expected === "refused" ? "PROBE_EXPECTED_REFUSAL" : "PROBE_EXIT_NONZERO", stdoutResult.eventTypes)
    }
    if (expected === "refused") return result(probe, "refused", elapsed(started), probe.refusalCode ?? "PI_UNSUPPORTED", stdoutResult.eventTypes)
    return result(probe, "pass", elapsed(started), undefined, stdoutResult.eventTypes)
  } catch {
    return result(probe, "failed", elapsed(started), "PROBE_EXECUTION_FAILED")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

interface OutputResult {
  readonly ok: boolean
  readonly code?: string
  readonly eventTypes?: readonly string[]
}

async function consumeOutput(
  stream: Bun.Subprocess["stdout"] | Bun.Subprocess["stderr"],
  maxBytes: number,
  mode: "ignore" | "jsonl",
): Promise<OutputResult> {
  if (stream === null || stream === undefined || typeof stream === "number") return { ok: false, code: "PROBE_OUTPUT_INVALID" }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  let exceeded = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        exceeded = true
        continue
      }
      if (!exceeded && mode === "jsonl") text += decoder.decode(chunk.value, { stream: true })
    }
    if (exceeded) return { ok: false, code: "PROBE_OUTPUT_LIMIT" }
    if (mode === "ignore") return { ok: true }
    text += decoder.decode()
    const eventTypes: string[] = []
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        return { ok: false, code: "PROBE_OUTPUT_INVALID" }
      }
      if (!isRecord(value) || typeof value.type !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(value.type))
        return { ok: false, code: "PROBE_OUTPUT_INVALID" }
      eventTypes.push(value.type)
    }
    return { ok: true, eventTypes: Object.freeze(eventTypes) }
  } finally {
    reader.releaseLock()
  }
}

function validateProbe(probe: PiExecutableProbe, defaultTimeoutMs: number, defaultMaxOutputBytes: number): void {
  if (!isRecord(probe)) throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "probe shape is invalid")
  identifier(probe.id, "probe id")
  identifier(probe.featureId, "feature id")
  if (typeof probe.command !== "string" || probe.command.length === 0 || probe.command.length > 4_096 || probe.command.includes("\0"))
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "command is invalid")
  if (!isAbsoluteCommand(probe.command)) throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "command must be an explicit path or executable name")
  validateArgs(probe.args)
  if (probe.cwd !== undefined && (typeof probe.cwd !== "string" || probe.cwd.length === 0 || probe.cwd.length > 4_096 || probe.cwd.includes("\0")))
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "working directory is invalid")
  if (probe.expectation !== undefined && probe.expectation !== "pass" && probe.expectation !== "refused")
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "expectation is invalid")
  if (probe.expectedExitCode !== undefined && (!Number.isSafeInteger(probe.expectedExitCode) || probe.expectedExitCode < 0 || probe.expectedExitCode > 255))
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "expected exit code is invalid")
  if (probe.refusalCode !== undefined) identifier(probe.refusalCode, "refusal code")
  if (probe.outputMode !== undefined && probe.outputMode !== "ignore" && probe.outputMode !== "jsonl")
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "output mode is invalid")
  if (probe.timeoutMs !== undefined) boundedInteger(probe.timeoutMs, 1, MAX_TIMEOUT_MS)
  if (probe.maxOutputBytes !== undefined) boundedInteger(probe.maxOutputBytes, 1_024, MAX_OUTPUT_BYTES)
  boundedInteger(defaultTimeoutMs, 1, MAX_TIMEOUT_MS)
  boundedInteger(defaultMaxOutputBytes, 1_024, MAX_OUTPUT_BYTES)
}

function validateArgs(args: readonly string[] | undefined): void {
  if (args === undefined) return
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 4_096 || arg.includes("\0")))
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", "arguments are invalid")
}

function isAbsoluteCommand(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z0-9._+-]+$/.test(value)
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_INVALID", `${field} is invalid`)
  return value
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new PiExecutableProbeError("PI_EXECUTABLE_PROBE_LIMIT", "probe bounds are invalid")
  return value
}

function result(
  probe: PiExecutableProbe,
  status: PiProbeStatus,
  durationMs: number,
  code: string | undefined,
  eventTypes?: readonly string[],
): PiCompatibilityProbeResult {
  return Object.freeze({
    id: probe.id,
    featureId: probe.featureId,
    status,
    durationMs,
    ...(code === undefined ? {} : { code }),
    ...(eventTypes === undefined ? {} : { eventTypes }),
  })
}

function elapsed(started: number): number {
  return Math.max(0, Math.min(86_400_000, performance.now() - started))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
