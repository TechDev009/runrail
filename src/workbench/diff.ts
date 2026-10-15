import type { WorkspacePolicy } from "../workspace/policy.ts"

export type DiffLineKind = "context" | "added" | "removed"

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
  readonly oldLine?: number
  readonly newLine?: number
}

export interface BoundedDiff {
  readonly lines: readonly DiffLine[]
  readonly added: number
  readonly removed: number
  readonly truncated: boolean
}

export interface DiffOptions {
  /** Lines of each side compared; the rest is left out and the diff marked truncated. */
  readonly maxInputLines?: number
  readonly maxOutputLines?: number
  /** Characters kept of each line; a longer line is cut and the diff marked truncated. */
  readonly maxLineChars?: number
}

export type DiffErrorCode = "DIFF_INVALID" | "DIFF_LIMIT" | "DIFF_NOT_FOUND"

export class DiffError extends Error {
  constructor(readonly code: DiffErrorCode, reason: string) {
    super(`diff review: ${reason}`)
    this.name = "DiffError"
  }
}

/** Deterministic bounded line diff. Contents are transient and never persisted by this module. */
export function createBoundedDiff(
  before: string,
  after: string,
  options: DiffOptions = {},
): BoundedDiff {
  const maxInputLines = options.maxInputLines ?? 512
  const maxOutputLines = options.maxOutputLines ?? 1_024
  const maxLineChars = options.maxLineChars ?? 4_096
  assertLimit(maxInputLines, 1, 2_048, "maxInputLines")
  assertLimit(maxOutputLines, 1, 8_192, "maxOutputLines")
  assertLimit(maxLineChars, 1, 16_384, "maxLineChars")
  if (typeof before !== "string" || typeof after !== "string") throw new DiffError("DIFF_INVALID", "diff text is invalid")
  const left = boundedLines(before, maxInputLines, maxLineChars)
  const right = boundedLines(after, maxInputLines, maxLineChars)
  const matrix: number[][] = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1)
      matrix[i]![j] = left[i] === right[j] ? matrix[i + 1]![j + 1]! + 1 : Math.max(matrix[i + 1]![j]!, matrix[i]![j + 1]!)
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  let added = 0
  let removed = 0
  let truncated = left.cut || right.cut
  const push = (line: DiffLine): void => {
    if (lines.length >= maxOutputLines) {
      truncated = true
      return
    }
    lines.push(Object.freeze(line))
  }
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      push({ kind: "context", text: left[i]!, oldLine: i + 1, newLine: j + 1 })
      i += 1
      j += 1
      continue
    }
    if (j < right.length && (i === left.length || matrix[i]![j + 1]! >= matrix[i + 1]![j]!)) {
      added += 1
      push({ kind: "added", text: right[j]!, newLine: j + 1 })
      j += 1
      continue
    }
    removed += 1
    push({ kind: "removed", text: left[i]!, oldLine: i + 1 })
    i += 1
  }
  return Object.freeze({ lines: Object.freeze(lines), added, removed, truncated })
}

export interface WorkspaceDiffOptions extends DiffOptions {
  readonly maxFiles?: number
  /** Bytes read of each file. Default 256 KiB. */
  readonly maxFileBytes?: number
}

/** Capture a transient baseline and inspect bounded changes under workspace policy. */
export class WorkspaceDiffReview {
  private readonly baseline = new Map<string, string>()
  private readonly options: Required<Pick<WorkspaceDiffOptions, "maxFiles">> & WorkspaceDiffOptions

  constructor(private readonly policy: WorkspacePolicy, options: WorkspaceDiffOptions = {}) {
    const maxFiles = options.maxFiles ?? 32
    assertLimit(maxFiles, 1, 128, "maxFiles")
    assertLimit(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1, DEFAULT_MAX_FILE_BYTES, "maxFileBytes")
    this.options = { ...options, maxFiles }
  }

  async capture(paths: readonly string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > this.options.maxFiles)
      throw new DiffError("DIFF_LIMIT", "too many baseline files")
    for (const path of paths) {
      const relativePath = parsePath(path)
      try {
        this.baseline.set(relativePath, await this.policy.read(relativePath, this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES))
      } catch (error) {
        if (!isNotFound(error)) throw error
        this.baseline.set(relativePath, "")
      }
    }
  }

  async inspect(paths?: readonly string[]): Promise<readonly WorkspaceDiffEntry[]> {
    const selected = paths === undefined ? [...this.baseline.keys()] : paths.map(parsePath)
    if (selected.length > this.options.maxFiles) throw new DiffError("DIFF_LIMIT", "too many diff files")
    const results: WorkspaceDiffEntry[] = []
    for (const path of selected) {
      const before = this.baseline.get(path) ?? ""
      let after = ""
      try {
        after = await this.policy.read(path, this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      const diff = createBoundedDiff(before, after, this.options)
      if (diff.added === 0 && diff.removed === 0) continue
      results.push(Object.freeze({ path, diff }))
    }
    return Object.freeze(results)
  }
}

export interface WorkspaceDiffEntry {
  readonly path: string
  readonly diff: BoundedDiff
}

export function createWorkspaceDiffReview(policy: WorkspacePolicy, options: WorkspaceDiffOptions = {}): WorkspaceDiffReview {
  return new WorkspaceDiffReview(policy, options)
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024

function splitLines(value: string): string[] {
  if (value.length === 0) return []
  return value.replace(/\r\n/g, "\n").split("\n")
}

function boundedLines(value: string, maxLines: number, maxLineChars: number): string[] & { cut: boolean } {
  const all = splitLines(value)
  let cut = all.length > maxLines
  const lines = all.slice(0, maxLines).map((line) => {
    if (line.length <= maxLineChars) return line
    cut = true
    return `${line.slice(0, maxLineChars)}...`
  })
  return Object.assign(lines, { cut })
}

function assertLimit(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DiffError("DIFF_LIMIT", `${name} is invalid`)
}

function parsePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.startsWith("/") || value.split("/").includes(".."))
    throw new DiffError("DIFF_INVALID", "diff path is invalid")
  return value
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && String((error as { readonly code: unknown }).code) === "ENOENT"
}
