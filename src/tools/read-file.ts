import type { NativeTool } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"

export function createReadFileTool(policy: WorkspacePolicy): NativeTool {
  return {
    name: "read_file",
    description: "Read one non-sensitive UTF-8 file inside the authorized workspace.",
    capabilities: ["read"],
    execute: async (input) => {
      const path = parsePath(input)
      return { path, content: await policy.read(path) }
    },
  }
}

function parsePath(input: unknown): string {
  if (input === null || typeof input !== "object" || typeof (input as { path?: unknown }).path !== "string")
    throw new TypeError("read_file input requires a path")
  return (input as { path: string }).path
}
