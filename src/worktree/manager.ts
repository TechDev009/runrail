import { realpath, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { SubagentRunnerOptions, SubagentSpec } from "@nifrajs/coding-agent"
import { filteredEnvironment } from "../workspace/policy.ts"
import { repositoryProgramOverrides } from "../git/repo-config.ts"
import { containedPath, ensureContainedDirectory } from "../runtime/contained-path.ts"

export interface WorktreeManagerOptions {
  readonly workspaceRoot: string
  readonly worktreeRoot?: string
  readonly gitCommand?: string
  readonly gitArgs?: readonly string[]
  readonly maxLeases?: number
}

export interface WorktreeRequest {
  readonly id: string
  readonly revision?: string
  readonly signal?: AbortSignal
}

export interface WorktreeLease {
  readonly id: string
  readonly cwd: string
  readonly revision: string
  readonly cleanup: () => Promise<void>
}

export type WorktreeErrorCode = "WORKTREE_INVALID" | "WORKTREE_LIMIT" | "WORKTREE_FAILED" | "WORKTREE_CANCELLED"

export class WorktreeError extends Error {
  constructor(readonly code: WorktreeErrorCode, reason: string) {
    super(`worktree: ${reason}`)
    this.name = "WorktreeError"
  }
}

/** Explicit local git worktree leases for bounded agent isolation. No branch/PR service is assumed. */
export class LocalGitWorktreeManager {
  readonly workspaceRoot: string
  readonly worktreeRoot: string
  private readonly gitCommand: string
  private readonly gitArgs: readonly string[]
  private readonly maxLeases: number
  private readonly active = new Map<string, WorktreeLease>()
  /** Creations under way, holding their id and a slot from before their first await. */
  private readonly starting = new Map<string, Promise<unknown>>()

  constructor(options: WorktreeManagerOptions) {
    if (options === null || typeof options !== "object" || typeof options.workspaceRoot !== "string" || options.workspaceRoot.length === 0 || options.workspaceRoot.length > 4_096)
      throw new WorktreeError("WORKTREE_INVALID", "workspace root is invalid")
    this.workspaceRoot = resolve(options.workspaceRoot)
    this.worktreeRoot = resolve(options.worktreeRoot ?? resolve(this.workspaceRoot, ".runrail", "worktrees"))
    assertInside(this.workspaceRoot, this.worktreeRoot)
    this.gitCommand = options.gitCommand ?? "git"
    this.gitArgs = Object.freeze([...(options.gitArgs ?? [])])
    if (!validCommand(this.gitCommand) || this.gitArgs.length > 32 || this.gitArgs.some((arg) => typeof arg !== "string" || arg.length > 4_096)) throw new WorktreeError("WORKTREE_INVALID", "git command is invalid")
    this.maxLeases = options.maxLeases ?? 16
    if (!Number.isSafeInteger(this.maxLeases) || this.maxLeases < 1 || this.maxLeases > 128) throw new WorktreeError("WORKTREE_LIMIT", "worktree lease limit is invalid")
  }

  async create(request: WorktreeRequest): Promise<WorktreeLease> {
    validateRequest(request)
    if (request.signal?.aborted === true) throw new WorktreeError("WORKTREE_CANCELLED", "worktree creation was cancelled")
    if (this.active.size + this.starting.size >= this.maxLeases) throw new WorktreeError("WORKTREE_LIMIT", "active worktree lease limit exceeded")
    if (this.active.has(request.id) || this.starting.has(request.id)) throw new WorktreeError("WORKTREE_INVALID", "worktree lease id is already active")
    const creating = this.add(request)
    this.starting.set(request.id, creating.catch(() => undefined))
    try {
      return await creating
    } finally {
      this.starting.delete(request.id)
    }
  }

  private async add(request: WorktreeRequest): Promise<WorktreeLease> {
    let canonicalWorktreeRoot: string
    let leaseRoot: string
    try {
      canonicalWorktreeRoot = await ensureContainedDirectory(this.workspaceRoot, this.worktreeRoot)
      leaseRoot = await containedPath(canonicalWorktreeRoot, resolve(canonicalWorktreeRoot, request.id))
    } catch {
      throw new WorktreeError("WORKTREE_INVALID", "worktree root is not an unlinked directory inside the workspace")
    }
    const root = await realpath(this.workspaceRoot)
    assertInside(root, leaseRoot)
    const revision = request.revision ?? "HEAD"
    await this.runGit(["-C", root, "worktree", "add", "--detach", leaseRoot, revision], request.signal)
    let released = false
    const cleanup = async (): Promise<void> => {
      if (released) return
      released = true
      this.active.delete(request.id)
      await this.runGit(["-C", root, "worktree", "remove", "--force", leaseRoot]).catch(() => undefined)
      await rm(leaseRoot, { recursive: true, force: true })
    }
    const lease = Object.freeze({ id: request.id, cwd: leaseRoot, revision, cleanup })
    this.active.set(request.id, lease)
    return lease
  }

  async close(): Promise<void> {
    await Promise.all(this.starting.values())
    for (const lease of [...this.active.values()]) await lease.cleanup()
  }

  subagentPolicy(): NonNullable<SubagentRunnerOptions["workspace"]> {
    return {
      root: this.workspaceRoot,
      allowedRoots: Object.freeze([this.workspaceRoot]),
      isolatedWorktree: async (spec: SubagentSpec, signal: AbortSignal) => {
        const lease = await this.create({ id: spec.id, signal })
        return lease
      },
    }
  }

  private async runGit(args: readonly string[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new WorktreeError("WORKTREE_CANCELLED", "worktree command was cancelled")
    const env = filteredEnvironment()
    // A checkout runs hooks and smudge filters; the repository's own config may name neither.
    const overrides = await repositoryProgramOverrides(this.gitCommand, this.workspaceRoot, env).catch(() => {
      throw new WorktreeError("WORKTREE_FAILED", "the repository's git configuration could not be read")
    })
    const safety = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", ...overrides]
    let child: Bun.Subprocess<"ignore", "ignore", "ignore">
    try {
      child = Bun.spawn([this.gitCommand, ...this.gitArgs, ...safety, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env })
    } catch (error) {
      throw new WorktreeError("WORKTREE_FAILED", error instanceof Error ? error.message : "git worktree command failed")
    }
    const abort = (): void => child.kill()
    signal?.addEventListener("abort", abort, { once: true })
    try {
      const status = await child.exited
      if (signal?.aborted) throw new WorktreeError("WORKTREE_CANCELLED", "worktree command was cancelled")
      if (status !== 0) throw new WorktreeError("WORKTREE_FAILED", "git worktree command failed")
    } finally {
      signal?.removeEventListener("abort", abort)
    }
  }
}

export function createLocalGitWorktreeManager(options: WorktreeManagerOptions): LocalGitWorktreeManager {
  return new LocalGitWorktreeManager(options)
}

export function createSubagentWorkspacePolicy(manager: LocalGitWorktreeManager): NonNullable<SubagentRunnerOptions["workspace"]> {
  return manager.subagentPolicy()
}

function validateRequest(request: WorktreeRequest): void {
  if (request === null || typeof request !== "object" || !validId(request.id) || (request.revision !== undefined && (!validRevision(request.revision))) || (request.signal !== undefined && !(request.signal instanceof AbortSignal))) throw new WorktreeError("WORKTREE_INVALID", "worktree request is invalid")
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validRevision(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.startsWith("-") && !/[\0\r\n]/.test(value)
}

function validCommand(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s/.test(value) && !value.startsWith("-")
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new WorktreeError("WORKTREE_INVALID", "worktree path escapes workspace root")
}
