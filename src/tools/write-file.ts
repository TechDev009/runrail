import type { NativeTool } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"
import { lineCounts } from "./line-counts.ts"

export function createWriteFileTool(
  policy: WorkspacePolicy,
  options: { readonly allowWrite?: boolean } = {},
): NativeTool {
  return {
    name: "write_file",
    description: "Write one bounded UTF-8 file inside the authorized workspace.",
    capabilities: ["filesystem.write"],
    requiresApproval: options.allowWrite !== true,
    execute: async (input) => {
      const value = parseWriteInput(input)
      // What the file held before, so a review can count the lines this write changed.
      const before = await previous(policy, value.path)
      const written = await policy.write(value.path, value.content)
      if (before === UNREADABLE) return { ...written, created: false }
      const counts = lineCounts(before ?? "", value.content)
      return { ...written, created: before === undefined, additions: counts.additions, deletions: counts.deletions }
    },
  }
}

const UNREADABLE = Symbol("unreadable")

/** The file's text, undefined when there is no file, or UNREADABLE when it is there but cannot be read (too large, not a file). */
async function previous(policy: WorkspacePolicy, path: string): Promise<string | undefined | typeof UNREADABLE> {
  try {
    return await policy.read(path)
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : UNREADABLE
  }
}

function parseWriteInput(input: unknown): { readonly path: string; readonly content: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("write_file input is invalid")
  const value = input as { path?: unknown; content?: unknown }
  if (typeof value.path !== "string" || typeof value.content !== "string")
    throw new TypeError("write_file requires path and content")
  if (value.content.length > 256 * 1024) throw new RangeError("write_file content is too large")
  return { path: value.path, content: value.content }
}
