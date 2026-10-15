import { posix } from "node:path"
import { isSensitiveWorkspacePath } from "../workspace/policy.ts"
import { GitError } from "./errors.ts"
import { isRunrailRuntimePath, stripPrefix } from "./paths.ts"
import { runGit, type GitRunOptions } from "./run.ts"

export type GitChange = "unmodified" | "modified" | "typechange" | "added" | "deleted" | "renamed" | "copied" | "unmerged" | "untracked"

export interface GitRepository {
  /** Workspace root the session runs in. */
  readonly root: string
  /** Absolute repository work-tree root. */
  readonly toplevel: string
  /** Workspace position inside the work tree: `""` at the top level, otherwise `dir/`. */
  readonly prefix: string
}

export interface GitStatusEntry {
  /** Workspace-relative path. */
  readonly path: string
  readonly originalPath?: string
  readonly index: GitChange
  readonly worktree: GitChange
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
  readonly submodule: boolean
  /** Credential file: listed for review, never diffed. */
  readonly sensitive: boolean
}

export interface GitStatusCounts {
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly conflicted: number
}

export interface GitStatusSnapshot {
  readonly branch?: string
  readonly detached: boolean
  /** No commit exists yet on the current branch. */
  readonly initial: boolean
  readonly head?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly entries: readonly GitStatusEntry[]
  readonly counts: GitStatusCounts
  readonly truncated: boolean
}

type Runner = (options: GitRunOptions) => ReturnType<typeof runGit>

const OUTSIDE_WORK_TREE = "workspace is not a git work tree"

/** Whether a probe failed because the folder is outside a work tree, rather than git being missing. */
export function outsideWorkTree(error: unknown): boolean {
  return error instanceof GitError && error.code === "GIT_UNAVAILABLE" && error.message === OUTSIDE_WORK_TREE
}

export async function probeGitRepository(root: string, run: Runner = runGit, signal?: AbortSignal): Promise<GitRepository> {
  const result = await run({
    cwd: root,
    args: ["rev-parse", "--is-inside-work-tree", "--show-prefix", "--show-toplevel"],
    okExitCodes: [0, 128],
    maxOutputBytes: 16 * 1024,
    ...(signal === undefined ? {} : { signal }),
  })
  const [inside, prefix = "", toplevel = ""] = result.stdout.split("\n")
  if (result.exitCode !== 0 || inside !== "true" || toplevel.length === 0)
    throw new GitError("GIT_UNAVAILABLE", OUTSIDE_WORK_TREE)
  return Object.freeze({ root, toplevel, prefix })
}

export async function readGitStatus(
  repo: GitRepository,
  maxEntries: number,
  run: Runner = runGit,
  signal?: AbortSignal,
  includeRuntime = false,
): Promise<GitStatusSnapshot> {
  const result = await run({
    cwd: repo.root,
    args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."],
    maxOutputBytes: 8 * 1024 * 1024,
    overflow: "truncate",
    timeoutMs: 60_000,
    ...(signal === undefined ? {} : { signal }),
  })
  return parsePorcelainV2(result.stdout, repo.prefix, maxEntries, result.truncated, includeRuntime)
}

export interface GitHead {
  readonly branch?: string
  readonly detached: boolean
  /** No commit exists yet on the current branch. */
  readonly initial: boolean
  readonly head?: string
}

/** The checkout's branch and commit without reading the work tree, so a folder no thread opened costs two small reads. */
export async function readGitHead(repo: GitRepository, run: Runner = runGit, signal?: AbortSignal): Promise<GitHead> {
  const read = (args: readonly string[]) => run({ cwd: repo.root, args, okExitCodes: [0, 1], maxOutputBytes: 4_096, timeoutMs: 10_000, ...(signal === undefined ? {} : { signal }) })
  // `symbolic-ref` fails on a detached HEAD; `rev-parse` fails before the first commit.
  const [symbolic, commit] = await Promise.all([read(["symbolic-ref", "--quiet", "--short", "HEAD"]), read(["rev-parse", "--verify", "--quiet", "HEAD"])])
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : ""
  const head = commit.exitCode === 0 ? commit.stdout.trim() : ""
  return Object.freeze({ ...(branch.length > 0 ? { branch } : {}), detached: branch.length === 0, initial: head.length === 0, ...(head.length > 0 ? { head } : {}) })
}

/** Parses `git status --porcelain=v2 -z --branch` output. Paths become workspace-relative. */
export function parsePorcelainV2(output: string, prefix: string, maxEntries: number, outputTruncated = false, includeRuntime = false): GitStatusSnapshot {
  const tokens = output.split("\0")
  tokens.pop()
  if (outputTruncated) tokens.pop()
  let branch: string | undefined
  let head: string | undefined
  let upstream: string | undefined
  let detached = false
  let initial = false
  let ahead = 0
  let behind = 0
  let truncated = outputTruncated
  const entries: GitStatusEntry[] = []
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ""
    if (token.startsWith("# ")) {
      const [, key = "", ...rest] = token.split(" ")
      const value = rest.join(" ")
      if (key === "branch.oid") {
        if (value === "(initial)") initial = true
        else head = value
      } else if (key === "branch.head") {
        if (value === "(detached)") detached = true
        else branch = value
      } else if (key === "branch.upstream") upstream = value
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match !== null) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
      continue
    }
    let entry: GitStatusEntry | undefined
    const kind = token[0]
    if (kind === "1") entry = trackedEntry(splitFields(token, 8), undefined, prefix)
    else if (kind === "2") {
      const original = tokens[index + 1]
      index += 1
      if (original === undefined) {
        truncated = true
        break
      }
      entry = trackedEntry(splitFields(token, 9), original, prefix)
    } else if (kind === "u") entry = conflictEntry(splitFields(token, 10), prefix)
    else if (kind === "?") entry = untrackedEntry(token.slice(2), prefix)
    if (entry === undefined || (isRunrailRuntimePath(entry.path) && !includeRuntime)) continue
    if (entry.staged) counts.staged += 1
    if (entry.unstaged) counts.unstaged += 1
    if (entry.untracked) counts.untracked += 1
    if (entry.conflicted) counts.conflicted += 1
    if (entries.length < maxEntries) entries.push(entry)
    else truncated = true
  }
  return Object.freeze({
    ...(branch === undefined ? {} : { branch }),
    detached,
    initial,
    ...(head === undefined ? {} : { head }),
    ...(upstream === undefined ? {} : { upstream }),
    ahead,
    behind,
    entries: Object.freeze(entries),
    counts: Object.freeze(counts),
    truncated,
  })
}

function splitFields(token: string, count: number): { readonly fields: readonly string[]; readonly path: string } | undefined {
  const fields: string[] = []
  let start = 0
  for (let field = 0; field < count; field += 1) {
    const end = token.indexOf(" ", start)
    if (end < 0) return undefined
    fields.push(token.slice(start, end))
    start = end + 1
  }
  const path = token.slice(start)
  return path.length === 0 ? undefined : { fields, path }
}

function trackedEntry(
  parsed: ReturnType<typeof splitFields>,
  original: string | undefined,
  prefix: string,
): GitStatusEntry | undefined {
  if (parsed === undefined) return undefined
  const path = stripPrefix(parsed.path, prefix)
  if (path === undefined) return undefined
  const xy = parsed.fields[1] ?? ".."
  const index = changeFor(xy[0])
  const worktree = changeFor(xy[1])
  const originalPath = original === undefined ? undefined : (stripPrefix(original, prefix) ?? posix.relative(prefix, original))
  return Object.freeze({
    path,
    ...(originalPath === undefined ? {} : { originalPath }),
    index,
    worktree,
    staged: index !== "unmodified",
    unstaged: worktree !== "unmodified",
    untracked: false,
    conflicted: false,
    submodule: (parsed.fields[2] ?? "N").startsWith("S"),
    sensitive: isSensitiveWorkspacePath(path) || (originalPath !== undefined && isSensitiveWorkspacePath(originalPath)),
  })
}

function conflictEntry(parsed: ReturnType<typeof splitFields>, prefix: string): GitStatusEntry | undefined {
  if (parsed === undefined) return undefined
  const path = stripPrefix(parsed.path, prefix)
  if (path === undefined) return undefined
  return Object.freeze({
    path,
    index: "unmerged",
    worktree: "unmerged",
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: true,
    submodule: (parsed.fields[2] ?? "N").startsWith("S"),
    sensitive: isSensitiveWorkspacePath(path),
  })
}

function untrackedEntry(rootPath: string, prefix: string): GitStatusEntry | undefined {
  const path = stripPrefix(rootPath, prefix)
  if (path === undefined || path.length === 0) return undefined
  return Object.freeze({
    path,
    index: "unmodified",
    worktree: "untracked",
    staged: false,
    unstaged: false,
    untracked: true,
    conflicted: false,
    submodule: false,
    sensitive: isSensitiveWorkspacePath(path),
  })
}

function changeFor(code: string | undefined): GitChange {
  switch (code) {
    case "M": return "modified"
    case "T": return "typechange"
    case "A": return "added"
    case "D": return "deleted"
    case "R": return "renamed"
    case "C": return "copied"
    case "U": return "unmerged"
    default: return "unmodified"
  }
}
