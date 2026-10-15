import { posix } from "node:path"
import { GitError } from "./errors.ts"

export const GIT_MAX_PATHS = 256
const MAX_PATH_LENGTH = 1_024

/**
 * Parses caller paths into workspace-relative POSIX paths. `.` selects the whole workspace.
 * Absolute paths, parent escapes, option-like paths, and `.git` internals are rejected.
 */
export function parseGitPaths(value: unknown, name = "paths"): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > GIT_MAX_PATHS)
    throw new GitError("GIT_INVALID", `${name} must be a non-empty list of at most ${GIT_MAX_PATHS} paths`)
  const result: string[] = []
  for (const item of value) {
    const path = parseGitPath(item, name)
    if (!result.includes(path)) result.push(path)
  }
  return Object.freeze(result)
}

export function parseOptionalGitPaths(value: unknown, name = "paths"): readonly string[] | undefined {
  return value === undefined ? undefined : parseGitPaths(value, name)
}

export function parseGitPath(value: unknown, name = "path"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(value))
    throw new GitError("GIT_INVALID", `${name} is invalid`)
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("-"))
    throw new GitError("GIT_INVALID", `${name} must be relative to the workspace`)
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/\/+$/, "")
  if (normalized === "" || normalized === ".") return "."
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("-"))
    throw new GitError("GIT_FORBIDDEN", `${name} escapes the workspace`)
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git"))
    throw new GitError("GIT_FORBIDDEN", `${name} targets git internals`)
  return normalized
}

export const RUNRAIL_RUNTIME_DIRS = Object.freeze([".runrail/native", ".runrail/worktrees"] as const)

/**
 * True for Runrail's own runtime state inside the workspace (task journals, subagent leases).
 * The review surface hides it and bulk staging never picks it up, so session state is not
 * committed by accident. Explicit paths inside it are still honoured.
 */
export function isRunrailRuntimePath(path: string): boolean {
  return RUNRAIL_RUNTIME_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`))
}

/** True when `path` equals `scope` or sits below it. `.` contains everything. */
export function pathWithin(path: string, scope: string): boolean {
  return scope === "." || path === scope || path.startsWith(`${scope}/`)
}

/** Converts a repository-root-relative git path into a workspace-relative path. */
export function stripPrefix(path: string, prefix: string): string | undefined {
  if (prefix.length === 0) return path
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  return undefined
}
