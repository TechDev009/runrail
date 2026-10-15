import type { NativeTool } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"

export function createListFilesTool(policy: WorkspacePolicy): NativeTool {
  return {
    name: "list_files",
    description: "List bounded files and directories inside the authorized workspace.",
    capabilities: ["filesystem.read"],
    execute: async (input) => {
      const value = parseListInput(input)
      return { entries: await policy.list(value.path, value.depth, value.maxEntries) }
    },
  }
}

function parseListInput(input: unknown): { readonly path: string; readonly depth: number; readonly maxEntries: number } {
  if (input === undefined) return { path: "", depth: 1, maxEntries: 256 }
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("list_files input is invalid")
  const value = input as { path?: unknown; depth?: unknown; maxEntries?: unknown }
  const path = value.path === undefined ? "" : value.path
  if (typeof path !== "string") throw new TypeError("list_files path must be a string")
  const depth = bounded(value.depth ?? 1, 0, 32, "depth")
  const maxEntries = bounded(value.maxEntries ?? 256, 1, 2_048, "maxEntries")
  return { path, depth, maxEntries }
}

function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max}`)
  return value
}
