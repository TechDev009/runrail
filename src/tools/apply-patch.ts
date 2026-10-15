import type { NativeTool } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"

export interface ApplyPatchInput {
  readonly path: string
  readonly content: string
}

export function createApplyPatchTool(
  policy: WorkspacePolicy,
  options: { readonly allowWrite?: boolean } = {},
): NativeTool {
  const allowWrite = options.allowWrite === true
  return {
    name: "apply_patch",
    description: "Replace one UTF-8 file inside the authorized workspace with bounded content.",
    capabilities: ["write"],
    requiresApproval: !allowWrite,
    execute: async (input) => {
      const patch = parsePatch(input)
      return policy.write(patch.path, patch.content)
    },
  }
}

function parsePatch(input: unknown): ApplyPatchInput {
  if (input === null || typeof input !== "object") throw new TypeError("apply_patch input is invalid")
  const value = input as { path?: unknown; content?: unknown }
  if (typeof value.path !== "string" || typeof value.content !== "string")
    throw new TypeError("apply_patch requires path and content")
  if (value.content.length > 256 * 1024) throw new RangeError("apply_patch content is too large")
  return { path: value.path, content: value.content }
}
