export type PiResourceCompatibilityErrorCode =
  | "PI_RESOURCE_INVALID"
  | "PI_RESOURCE_UNSUPPORTED"
  | "PI_RESOURCE_LIMIT"
  | "PI_RESOURCE_NOT_FOUND"

export class PiResourceCompatibilityError extends Error {
  constructor(readonly code: PiResourceCompatibilityErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "PiResourceCompatibilityError"
  }
}
