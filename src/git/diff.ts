import { isSensitiveWorkspacePath } from "../workspace/policy.ts"
import { isRunrailRuntimePath } from "./paths.ts"
import { headerMatches, parseRawNumstat, splitPatch, type RawDiffRecord } from "./diff-parse.ts"
import { runGit, type GitRunOptions } from "./run.ts"
import type { GitChange, GitRepository } from "./status.ts"
import { untrackedPatch } from "./untracked.ts"

export type GitDiffScope = "unstaged" | "staged" | "head"
export type GitPatchOmission = "sensitive" | "binary" | "limit" | "unreadable" | "submodule"

export interface GitDiffOptions {
  readonly scope: GitDiffScope
  readonly paths?: readonly string[]
  readonly maxFiles: number
  readonly maxBytes: number
  readonly maxFileBytes: number
  readonly contextLines: number
  /** Include untracked files as added-file patches (`unstaged` and `head` scopes only). */
  readonly includeUntracked: boolean
  /** Counts only: no patch is built or returned. Untracked files are still read to count lines, within `maxBytes`. */
  readonly statsOnly?: boolean
  readonly signal?: AbortSignal
}

export interface GitDiffFile {
  readonly path: string
  readonly originalPath?: string
  readonly change: GitChange
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
  readonly sensitive: boolean
  readonly patch?: string
  readonly omitted?: GitPatchOmission
}

export interface GitDiff {
  readonly scope: GitDiffScope
  readonly files: readonly GitDiffFile[]
  readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number }
  readonly truncated: boolean
}

type Runner = (options: GitRunOptions) => ReturnType<typeof runGit>

const DIFF_FLAGS = Object.freeze(["--no-ext-diff", "--no-textconv", "--no-color", "-M", "--relative", "--submodule=short"])

export async function readGitDiff(repo: GitRepository, options: GitDiffOptions, run: Runner = runGit): Promise<GitDiff> {
  const signal = options.signal === undefined ? {} : { signal: options.signal }
  const base = await scopeArgs(repo, options.scope, run, options.signal)
  const pathspec = options.paths ?? ["."]
  const meta = await run({
    cwd: repo.root,
    args: [...base, ...DIFF_FLAGS, "--raw", "--numstat", "-z", "--", ...pathspec],
    maxOutputBytes: 8 * 1024 * 1024,
    overflow: "truncate",
    timeoutMs: 60_000,
    ...signal,
  })
  const parsed = parseRawNumstat(meta.stdout, meta.truncated)
  let truncated = meta.truncated || parsed.records.length > options.maxFiles
  const records = parsed.records.slice(0, options.maxFiles)
  const files: GitDiffFile[] = []
  const eligible: RawDiffRecord[] = []
  for (const record of records) {
    const stat = parsed.stats.get(record.path) ?? { additions: 0, deletions: 0, binary: false }
    const sensitive = isSensitiveWorkspacePath(record.path) || (record.originalPath !== undefined && isSensitiveWorkspacePath(record.originalPath))
    files.push(Object.freeze({
      path: record.path,
      ...(record.originalPath === undefined ? {} : { originalPath: record.originalPath }),
      change: record.change,
      additions: sensitive ? 0 : stat.additions,
      deletions: sensitive ? 0 : stat.deletions,
      binary: stat.binary,
      sensitive,
      ...(sensitive ? { omitted: "sensitive" as const } : stat.binary ? { omitted: "binary" as const } : record.submodule ? { omitted: "submodule" as const } : {}),
    }))
    if (!sensitive && !stat.binary && !record.submodule) eligible.push(record)
  }
  let budget = options.maxBytes
  if (eligible.length > 0 && options.statsOnly !== true) {
    const patchPaths = eligible.flatMap((record) => record.originalPath === undefined ? [record.path] : [record.originalPath, record.path])
    const patch = await run({
      cwd: repo.root,
      args: [...base, ...DIFF_FLAGS, "-p", `-U${options.contextLines}`, "--", ...patchPaths],
      maxOutputBytes: options.maxBytes,
      overflow: "truncate",
      timeoutMs: 60_000,
      ...signal,
    })
    budget = attachPatches(files, eligible, patch.stdout, patch.truncated, options.maxFileBytes, options.maxBytes)
    truncated ||= patch.truncated
  }
  if (options.includeUntracked && options.scope !== "staged" && files.length < options.maxFiles) {
    const untracked = await run({
      cwd: repo.root,
      args: ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec],
      maxOutputBytes: 4 * 1024 * 1024,
      overflow: "truncate",
      ...signal,
    })
    const listed = untracked.stdout.split("\0")
    listed.pop()
    if (untracked.truncated) listed.pop()
    const paths = listed.filter((path) => !isRunrailRuntimePath(path))
    const room = options.maxFiles - files.length
    truncated ||= untracked.truncated || paths.length > room
    for (const path of paths.slice(0, room)) {
      const file = await untrackedFile(repo.root, path, Math.min(options.maxFileBytes, budget))
      if (file.patch !== undefined) budget -= Buffer.byteLength(file.patch, "utf8")
      if (options.statsOnly !== true) {
        files.push(file)
        continue
      }
      // A file left unread for lack of budget would count as zero lines, so the totals say they are partial.
      truncated ||= file.omitted === "limit"
      const { patch: _patch, ...counted } = file
      files.push(Object.freeze(counted))
    }
  }
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return Object.freeze({
    scope: options.scope,
    files: Object.freeze(files),
    totals: Object.freeze({ files: files.length, additions, deletions }),
    truncated,
  })
}

async function scopeArgs(repo: GitRepository, scope: GitDiffScope, run: Runner, signal: AbortSignal | undefined): Promise<readonly string[]> {
  if (scope === "unstaged") return ["diff"]
  if (scope === "staged") return ["diff", "--cached"]
  const head = await run({ cwd: repo.root, args: ["rev-parse", "--verify", "-q", "HEAD"], okExitCodes: [0, 1], maxOutputBytes: 1_024, ...(signal === undefined ? {} : { signal }) })
  if (head.exitCode === 0) return ["diff", "HEAD"]
  const empty = await run({ cwd: repo.root, args: ["hash-object", "-t", "tree", "/dev/null"], maxOutputBytes: 1_024, ...(signal === undefined ? {} : { signal }) })
  return ["diff", empty.stdout.trim()]
}

/** Attaches patch chunks to files in diff order. Returns the remaining byte budget. */
function attachPatches(
  files: GitDiffFile[],
  eligible: readonly RawDiffRecord[],
  output: string,
  outputTruncated: boolean,
  maxFileBytes: number,
  maxBytes: number,
): number {
  const chunks = splitPatch(output)
  const patches = new Map<string, string | "limit">()
  let cursor = 0
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    if (chunk === undefined) continue
    let match = cursor
    while (match < eligible.length && !headerMatches(chunk.header, eligible[match]?.path ?? "")) match += 1
    const record = eligible[match]
    if (record === undefined) continue
    cursor = match + 1
    const partial = outputTruncated && index === chunks.length - 1
    patches.set(record.path, partial || Buffer.byteLength(chunk.text, "utf8") > maxFileBytes ? "limit" : chunk.text)
  }
  let used = 0
  const eligiblePaths = new Set(eligible.map((record) => record.path))
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    if (file === undefined || !eligiblePaths.has(file.path)) continue
    const patch = patches.get(file.path)
    if (patch === undefined || patch === "limit") {
      files[index] = Object.freeze({ ...file, omitted: patch === "limit" || outputTruncated ? "limit" : "unreadable" })
      continue
    }
    used += Buffer.byteLength(patch, "utf8")
    files[index] = Object.freeze({ ...file, patch })
  }
  return Math.max(0, maxBytes - used)
}

async function untrackedFile(root: string, path: string, maxBytes: number): Promise<GitDiffFile> {
  const base = { path, change: "untracked" as const, deletions: 0 }
  if (isSensitiveWorkspacePath(path))
    return Object.freeze({ ...base, additions: 0, binary: false, sensitive: true, omitted: "sensitive" })
  if (maxBytes <= 0) return Object.freeze({ ...base, additions: 0, binary: false, sensitive: false, omitted: "limit" })
  const result = await untrackedPatch(root, path, maxBytes)
  if (result.kind === "text")
    return Object.freeze({ ...base, additions: result.additions, binary: false, sensitive: false, patch: result.patch })
  return Object.freeze({ ...base, additions: 0, binary: result.kind === "binary", sensitive: false, omitted: result.kind })
}
