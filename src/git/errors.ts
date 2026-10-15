export type GitErrorCode =
  | "GIT_UNAVAILABLE"
  | "GIT_INVALID"
  | "GIT_FORBIDDEN"
  | "GIT_NOT_FOUND"
  | "GIT_LIMIT"
  | "GIT_IDENTITY_REQUIRED"
  | "GIT_NOTHING_TO_COMMIT"
  | "GIT_CONFLICT"
  | "GIT_DIVERGED"
  | "GIT_HOOK_REJECTED"
  | "GIT_TIMEOUT"
  | "GIT_CANCELLED"
  | "GIT_FAILED"

const STATUS: Readonly<Record<GitErrorCode, number>> = Object.freeze({
  GIT_UNAVAILABLE: 501,
  GIT_INVALID: 400,
  GIT_FORBIDDEN: 403,
  GIT_NOT_FOUND: 404,
  GIT_LIMIT: 413,
  GIT_IDENTITY_REQUIRED: 409,
  GIT_NOTHING_TO_COMMIT: 409,
  GIT_CONFLICT: 409,
  GIT_DIVERGED: 409,
  GIT_HOOK_REJECTED: 409,
  GIT_TIMEOUT: 504,
  GIT_CANCELLED: 409,
  GIT_FAILED: 500,
})

/** Stable git error. Messages are fixed strings and never carry git stderr, paths, or file content. */
export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "GitError"
  }

  get status(): number {
    return STATUS[this.code]
  }
}
