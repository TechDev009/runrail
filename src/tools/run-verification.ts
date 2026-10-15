import type { NativeTool } from "@nifrajs/coding-agent"
import { runNifraVerification } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"

export function createRunVerificationTool(
  policy: WorkspacePolicy,
  options: { readonly command?: string; readonly verification?: "check" | "assure" | "test" } = {},
): NativeTool {
  return {
    name: "run_verification",
    description: "Run one bounded Nifra verification gate in the authorized workspace.",
    capabilities: ["process"],
    requiresApproval: true,
    execute: async (input) => {
      const name = parseVerification(input, options.verification ?? "check")
      const { ok, status, ...rest } = await runNifraVerification(name, {
        cwd: policy.root,
        command: options.command,
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
      })
      // `ok` and `status` lead, as `run_command`'s do: the backend reads them from the result text.
      return { ok, status, ...rest }
    },
  }
}

function parseVerification(input: unknown, fallback: "check" | "assure" | "test"):
  | "check"
  | "assure"
  | "test" {
  if (input === undefined) return fallback
  if (input === null || typeof input !== "object" || typeof (input as { name?: unknown }).name !== "string")
    throw new TypeError("run_verification input requires a valid gate name")
  const name = (input as { name: string }).name
  if (name !== "check" && name !== "assure" && name !== "test") throw new TypeError("unknown verification gate")
  return name
}
