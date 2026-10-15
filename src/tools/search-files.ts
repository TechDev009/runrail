import type { NativeTool } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"

export function createSearchFilesTool(policy: WorkspacePolicy): NativeTool {
  return {
    name: "search_files",
    description: "Search bounded UTF-8 workspace files for an exact text query.",
    capabilities: ["filesystem.read"],
    execute: async (input) => {
      const value = parseSearchInput(input)
      return { matches: await policy.search(value.path, value.query, value.maxResults, value.maxFileBytes) }
    },
  }
}

function parseSearchInput(input: unknown): {
  readonly path: string
  readonly query: string
  readonly maxResults: number
  readonly maxFileBytes: number
} {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("search_files input is invalid")
  const value = input as { path?: unknown; query?: unknown; maxResults?: unknown; maxFileBytes?: unknown }
  if (typeof value.query !== "string" || value.query.length === 0 || value.query.length > 512)
    throw new TypeError("search_files requires a bounded query")
  const path = value.path === undefined ? "" : value.path
  if (typeof path !== "string") throw new TypeError("search_files path must be a string")
  return {
    path,
    query: value.query,
    maxResults: bounded(value.maxResults ?? 128, 1, 512, "maxResults"),
    maxFileBytes: bounded(value.maxFileBytes ?? 256 * 1024, 1, 256 * 1024, "maxFileBytes"),
  }
}

function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max}`)
  return value
}
