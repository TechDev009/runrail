import type { NativeTool } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"

export function createFindFilesTool(policy: WorkspacePolicy): NativeTool {
  return {
    name: "find_files",
    description: "Find bounded workspace paths using a simple * and ? pattern.",
    capabilities: ["filesystem.read"],
    execute: async (input) => {
      const value = parseFindInput(input)
      return { entries: await policy.find(value.path, value.pattern, value.depth, value.maxEntries) }
    },
  }
}

function parseFindInput(input: unknown): {
  readonly path: string
  readonly pattern: string
  readonly depth: number
  readonly maxEntries: number
} {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("find_files input is invalid")
  const value = input as { path?: unknown; pattern?: unknown; depth?: unknown; maxEntries?: unknown }
  if (typeof value.pattern !== "string" || value.pattern.length === 0)
    throw new TypeError("find_files requires a pattern")
  const path = value.path === undefined ? "" : value.path
  if (typeof path !== "string") throw new TypeError("find_files path must be a string")
  return {
    path,
    pattern: value.pattern,
    depth: bounded(value.depth ?? 16, 0, 32, "depth"),
    maxEntries: bounded(value.maxEntries ?? 256, 1, 2_048, "maxEntries"),
  }
}

function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max}`)
  return value
}
