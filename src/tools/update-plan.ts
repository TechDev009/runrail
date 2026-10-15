import type { NativeTool } from "@nifrajs/coding-agent"

const MAX_STEPS = 64
const MAX_STEP_TEXT = 1_024
const MAX_EXPLANATION = 2_048
const STATUSES = new Set(["pending", "in_progress", "completed"])

/**
 * Records the agent's working plan. The plan is shown live by control clients through
 * tool presentation and `plan.updated` frames; the tool itself keeps no state.
 */
export function createUpdatePlanTool(): NativeTool {
  return {
    name: "update_plan",
    description: "Share or update the step-by-step plan for the current task. Mark exactly the step being worked on as in_progress and finished steps as completed.",
    capabilities: [],
    execute: (input) => {
      const plan = parsePlanInput(input)
      return { ok: true, steps: plan.length, completed: plan.filter((step) => step.status === "completed").length }
    },
  }
}

function parsePlanInput(input: unknown): readonly { readonly step: string; readonly status: string }[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("update_plan input is invalid")
  const value = input as { plan?: unknown; explanation?: unknown }
  if (value.explanation !== undefined && (typeof value.explanation !== "string" || value.explanation.length > MAX_EXPLANATION))
    throw new TypeError("update_plan explanation is invalid")
  if (!Array.isArray(value.plan) || value.plan.length === 0 || value.plan.length > MAX_STEPS)
    throw new RangeError(`update_plan plan must have 1 to ${MAX_STEPS} steps`)
  let active = 0
  const steps = value.plan.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("update_plan step is invalid")
    const { step, status } = entry as { step?: unknown; status?: unknown }
    if (typeof step !== "string" || step.trim().length === 0 || step.length > MAX_STEP_TEXT) throw new TypeError("update_plan step text is invalid")
    if (typeof status !== "string" || !STATUSES.has(status)) throw new TypeError("update_plan step status must be pending, in_progress, or completed")
    if (status === "in_progress") active += 1
    return { step, status }
  })
  if (active > 1) throw new RangeError("update_plan allows at most one in_progress step")
  return steps
}
