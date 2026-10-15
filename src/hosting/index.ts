import { isIP } from "node:net"

export type HostingKind = "loopback" | "reverse-proxy" | "container" | "managed"
export type HostingTlsMode = "none" | "terminated-proxy" | "native"
export type HostingAuthMode = "none" | "bearer" | "caller"

export interface RunrailHostingProfile {
  readonly id: string
  readonly version: string
  readonly kind: HostingKind
  readonly hostname: string
  readonly port: number
  readonly allowRemote: boolean
  readonly tls: HostingTlsMode
  readonly auth: HostingAuthMode
  readonly durableState: boolean
  readonly sandboxId?: string
  readonly maxBodyBytes: number
}

export type HostingErrorCode = "HOSTING_INVALID" | "HOSTING_REMOTE_UNSAFE" | "HOSTING_AUTH_REQUIRED" | "HOSTING_LIMIT"

export class HostingError extends Error {
  constructor(readonly code: HostingErrorCode, reason: string) {
    super(`hosting: ${reason}`)
    this.name = "HostingError"
  }
}

/** A safe local default for the authenticated control server. */
export const LOOPBACK_HOSTING_PROFILE: RunrailHostingProfile = Object.freeze({
  id: "loopback",
  version: "1.0.0",
  kind: "loopback",
  hostname: "127.0.0.1",
  port: 0,
  allowRemote: false,
  tls: "none",
  auth: "bearer",
  durableState: false,
  maxBodyBytes: 1_048_576,
})

export function createHostingProfile(input: Omit<RunrailHostingProfile, "maxBodyBytes"> & { readonly maxBodyBytes?: number }): RunrailHostingProfile {
  const profile = { ...input, maxBodyBytes: input.maxBodyBytes ?? 1_048_576 }
  validateHostingProfile(profile)
  return freezeProfile(profile)
}

export function parseHostingProfile(value: unknown): RunrailHostingProfile {
  validateHostingProfile(value)
  return freezeProfile(value)
}

export function validateHostingProfile(value: unknown): asserts value is RunrailHostingProfile {
  if (!isRecord(value)) throw new HostingError("HOSTING_INVALID", "hosting profile is invalid")
  const { id, version, kind, hostname, port, allowRemote, tls, auth, durableState, sandboxId, maxBodyBytes } = value
  if (!validId(id) || !validVersion(version) || !isHostingKind(kind) || !validHostname(hostname) || typeof port !== "number" || !Number.isSafeInteger(port) || port < 0 || port > 65_535 || typeof allowRemote !== "boolean" || !isTlsMode(tls) || !isAuthMode(auth) || typeof durableState !== "boolean" || sandboxId !== undefined && !validId(sandboxId) || typeof maxBodyBytes !== "number" || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 16 * 1024 * 1024)
    throw new HostingError("HOSTING_INVALID", "hosting profile is invalid")
  const loopback = isLoopback(hostname)
  if (allowRemote && loopback) throw new HostingError("HOSTING_INVALID", "remote hosting requires a non-loopback bind host")
  if (!allowRemote && !loopback) throw new HostingError("HOSTING_REMOTE_UNSAFE", "non-loopback hosting requires explicit remote opt-in")
  if (allowRemote && tls === "none") throw new HostingError("HOSTING_REMOTE_UNSAFE", "remote hosting requires TLS")
  if (allowRemote && auth === "none") throw new HostingError("HOSTING_AUTH_REQUIRED", "remote hosting requires authentication")
  if (kind === "loopback" && !loopback) throw new HostingError("HOSTING_INVALID", "loopback hosting must bind to loopback")
}

export function hostingCapabilities(profile: RunrailHostingProfile): readonly string[] {
  validateHostingProfile(profile)
  return Object.freeze([
    "control.rpc",
    ...(profile.durableState ? ["durable.state"] : []),
    ...(profile.allowRemote ? ["remote.access", "tls", "authenticated"] : ["loopback.access"]),
    ...(profile.sandboxId === undefined ? [] : ["sandbox.boundary"]),
  ])
}

function freezeProfile(profile: RunrailHostingProfile): RunrailHostingProfile {
  return Object.freeze({ ...profile })
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9.+:-]{0,63}$/.test(value)
}

function validHostname(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 253 && !/[\r\n/\\]/.test(value) && (isLoopback(value) || /^[A-Za-z0-9.-]+$/.test(value))
}

function isLoopback(value: string): boolean {
  const hostname = value.toLowerCase()
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || isIP(hostname) === 4 && hostname.startsWith("127.")
}

function isHostingKind(value: unknown): value is HostingKind {
  return value === "loopback" || value === "reverse-proxy" || value === "container" || value === "managed"
}

function isTlsMode(value: unknown): value is HostingTlsMode {
  return value === "none" || value === "terminated-proxy" || value === "native"
}

function isAuthMode(value: unknown): value is HostingAuthMode {
  return value === "none" || value === "bearer" || value === "caller"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
