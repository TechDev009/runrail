export const NATIVE_CONTRACT_VERSION = 1 as const
export const NATIVE_API_VERSION = "1.0" as const

export type NativeErrorCode =
  | "NATIVE_INVALID"
  | "NATIVE_LIMIT"
  | "NATIVE_UNSUPPORTED_VERSION"
  | "NATIVE_DUPLICATE"
  | "NATIVE_CAPABILITY_DENIED"
  | "NATIVE_APPROVAL_REQUIRED"
  | "NATIVE_IDEMPOTENCY_CONFLICT"
  | "NATIVE_CURSOR_EXPIRED"
  | "NATIVE_STATE_CONFLICT"
  | "NATIVE_NOT_FOUND"
  | "NATIVE_AUTH_REQUIRED"
  | "NATIVE_OPERATION_FAILED"
  | "NATIVE_CANCELLED"

export class NativeContractError extends Error {
  constructor(readonly code: NativeErrorCode, reason: string) {
    super(`${code}: native contract: ${boundedReason(reason)}`)
    this.name = "NativeContractError"
  }
}

export function nativeInvalid(reason: string): never {
  throw new NativeContractError("NATIVE_INVALID", reason)
}

export function nativeLimit(reason: string): never {
  throw new NativeContractError("NATIVE_LIMIT", reason)
}

export function boundedNativeText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0") || /[\r\n]/.test(value))
    nativeInvalid(`${name} is invalid`)
  return value
}

export function boundedNativeOptionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined
  return boundedNativeText(value, name, max)
}

export function boundedNativeId(value: unknown, name: string, max = 128): string {
  const result = boundedNativeText(value, name, max)
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(result)) nativeInvalid(`${name} is invalid`)
  return result
}

export function boundedNativeReference(value: unknown, name: string, max = 256): string {
  const result = boundedNativeText(value, name, max)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) nativeInvalid(`${name} is invalid`)
  return result
}
export function boundedNativeCapability(value: unknown, name = "capability"): string {
  const result = boundedNativeText(value, name, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(result)) nativeInvalid(`${name} is invalid`)
  return result
}

export function boundedNativeList<T>(
  value: unknown,
  name: string,
  maxItems: number,
  parse: (entry: unknown, index: number) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maxItems) nativeLimit(`${name} is invalid`)
  const result = value.map(parse)
  return Object.freeze(result)
}

export function requireNativeBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") nativeInvalid(`${name} is invalid`)
  return value
}

export function requireNativeInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) nativeLimit(`${name} is invalid`)
  return value
}

export function requireNativeTimestamp(value: unknown, name = "timestamp"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 9_999_999_999_999) nativeLimit(`${name} is invalid`)
  return value
}

function boundedReason(value: string): string {
  if (typeof value !== "string" || value.length === 0) return "operation failed"
  return value.slice(0, 512).replace(/[\r\n\0]/g, " ")
}
