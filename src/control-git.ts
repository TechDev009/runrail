import {
  GIT_MAX_BRANCHES,
  GitError,
  parseCommitMessage,
  parseFetchSource,
  parseBranchName,
  parseGitPaths,
  parseOptionalGitPaths,
  parseRemoteName,
  parseWorktreeId,
  type GitDiffScope,
  type GitWorkspace,
  type ThreadWorktrees,
} from "./git/index.ts"

export const RUNRAIL_CONTROL_GIT_METHODS = Object.freeze([
  "git.status",
  "git.diff",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "git.log",
  "git.remote.list",
  "git.push.preview",
  "git.push",
  "git.branches",
  "git.fetch",
  "git.pull",
] as const)

export const RUNRAIL_CONTROL_WORKTREE_METHODS = Object.freeze(["worktree.list", "worktree.create", "worktree.remove", "worktree.apply"] as const)

export type RunrailControlGitMethod = (typeof RUNRAIL_CONTROL_GIT_METHODS)[number]
export type RunrailControlWorktreeMethod = (typeof RUNRAIL_CONTROL_WORKTREE_METHODS)[number]

const DEFAULT_STATUS_ENTRIES = 1_000
const MAX_STATUS_ENTRIES = 4_096

export function isControlGitMethod(method: string): method is RunrailControlGitMethod {
  return (RUNRAIL_CONTROL_GIT_METHODS as readonly string[]).includes(method)
}

export function isControlWorktreeMethod(method: string): method is RunrailControlWorktreeMethod {
  return (RUNRAIL_CONTROL_WORKTREE_METHODS as readonly string[]).includes(method)
}

/**
 * Dispatches one `worktree.*` control method. The returned `cwd` lets a desktop host supervise a
 * second `runrail control --cwd <cwd>` session for the thread.
 */
export async function dispatchControlWorktree(
  worktrees: ThreadWorktrees,
  method: RunrailControlWorktreeMethod,
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  switch (method) {
    case "worktree.list":
      return { worktrees: await worktrees.list() }
    case "worktree.create":
      return worktrees.create({
        id: parseWorktreeId(params.id),
        ...(params.revision === undefined ? {} : { revision: requireText(params.revision, "revision") }),
        ...(params.branch === undefined ? {} : { branch: requireText(params.branch, "branch") }),
      })
    case "worktree.remove":
      return worktrees.remove(params.id, flag(params.force, "force") ?? false, flag(params.deleteBranch, "deleteBranch") ?? false)
    case "worktree.apply":
      return worktrees.apply(params.id)
  }
}

/** Dispatches one `git.*` control method. Params are parsed here; the workspace runs git. */
export async function dispatchControlGit(
  git: GitWorkspace,
  method: RunrailControlGitMethod,
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  switch (method) {
    case "git.status":
      return git.status(bound(params.maxEntries, 1, MAX_STATUS_ENTRIES, "maxEntries") ?? DEFAULT_STATUS_ENTRIES)
    case "git.diff":
      return git.diff({
        scope: diffScope(params.scope),
        ...(params.paths === undefined ? {} : { paths: parseGitPaths(params.paths) }),
        maxFiles: bound(params.maxFiles, 1, 1_000, "maxFiles") ?? 300,
        maxBytes: bound(params.maxBytes, 1_024, 16 * 1024 * 1024, "maxBytes") ?? 4 * 1024 * 1024,
        maxFileBytes: bound(params.maxFileBytes, 1_024, 4 * 1024 * 1024, "maxFileBytes") ?? 512 * 1024,
        contextLines: bound(params.contextLines, 0, 20, "contextLines") ?? 3,
        includeUntracked: flag(params.includeUntracked, "includeUntracked") ?? true,
        statsOnly: flag(params.statsOnly, "statsOnly") ?? false,
      })
    case "git.stage":
      return { paths: await git.stage(parseGitPaths(params.paths)), status: await git.status(DEFAULT_STATUS_ENTRIES) }
    case "git.unstage":
      return { paths: await git.unstage(parseGitPaths(params.paths)), status: await git.status(DEFAULT_STATUS_ENTRIES) }
    case "git.discard": {
      const result = await git.discard(
        parseGitPaths(params.paths),
        discardScope(params.scope),
        flag(params.includeUntracked, "includeUntracked") ?? false,
      )
      return { ...result, status: await git.status(DEFAULT_STATUS_ENTRIES) }
    }
    case "git.commit": {
      const paths = parseOptionalGitPaths(params.paths)
      const commit = await git.commit({
        message: parseCommitMessage(params.message),
        ...(paths === undefined ? {} : { paths }),
        runHooks: flag(params.runHooks, "runHooks") ?? false,
      })
      return { ...commit, status: await git.status(DEFAULT_STATUS_ENTRIES) }
    }
    case "git.log": {
      const paths = parseOptionalGitPaths(params.paths)
      return {
        commits: await git.log({
          limit: bound(params.limit, 1, 200, "limit") ?? 50,
          skip: bound(params.skip, 0, 1_000_000, "skip") ?? 0,
          ...(paths === undefined ? {} : { paths }),
        }),
      }
    }
    case "git.remote.list":
      return { remotes: await git.remotes() }
    case "git.push.preview":
      return git.pushPreview(pushTarget(params))
    case "git.push": {
      const pushed = await git.push({
        ...pushTarget(params),
        confirmation: confirmation(params.confirmation),
        runHooks: flag(params.runHooks, "runHooks") ?? false,
      })
      return { ...pushed, status: await git.status(DEFAULT_STATUS_ENTRIES) }
    }
    case "git.branches":
      return git.branches(bound(params.maxBranches, 1, GIT_MAX_BRANCHES, "maxBranches") ?? 200)
    case "git.fetch":
      return git.fetch(parseFetchSource(params))
    case "git.pull": {
      const pulled = await git.pull({ runHooks: flag(params.runHooks, "runHooks") ?? false })
      return { ...pulled, status: await git.status(DEFAULT_STATUS_ENTRIES) }
    }
  }
}

function pushTarget(params: Readonly<Record<string, unknown>>): { readonly remote?: string; readonly branch?: string } {
  const remote = parseRemoteName(params.remote)
  const branch = parseBranchName(params.branch)
  return { ...(remote === undefined ? {} : { remote }), ...(branch === undefined ? {} : { branch }) }
}

function confirmation(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new GitError("GIT_INVALID", "confirmation must come from git.push.preview")
  return value
}

function bound(value: unknown, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new GitError("GIT_INVALID", `${name} must be an integer from ${min} to ${max}`)
  return value
}

function flag(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new GitError("GIT_INVALID", `${name} must be a boolean`)
  return value
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new GitError("GIT_INVALID", `${name} is invalid`)
  return value
}

function diffScope(value: unknown): GitDiffScope {
  if (value === undefined) return "unstaged"
  if (value === "unstaged" || value === "staged" || value === "head") return value
  throw new GitError("GIT_INVALID", "scope must be unstaged, staged, or head")
}

function discardScope(value: unknown): "unstaged" | "all" {
  if (value === undefined) return "unstaged"
  if (value === "unstaged" || value === "all") return value
  throw new GitError("GIT_INVALID", "scope must be unstaged or all")
}
