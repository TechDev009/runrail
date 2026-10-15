import {
  createVerificationRepairTask,
  type VerificationRepairTask,
  type VerificationResult,
} from "@nifrajs/coding-agent"

export type RepairDecision =
  | { readonly kind: "repair"; readonly attempt: number; readonly task: VerificationRepairTask }
  | { readonly kind: "exhausted"; readonly reason: "attempt_cap" | "repeated_failure" }

export class RepairController {
  readonly maxAttempts: number
  private attempts = 0
  private lastFingerprint: string | undefined

  constructor(maxAttempts = 2) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 8)
      throw new RangeError("repair attempts must be between 0 and 8")
    this.maxAttempts = maxAttempts
  }

  get attemptCount(): number {
    return this.attempts
  }

  next(result: VerificationResult, cwd: string): RepairDecision {
    if (result.ok) throw new Error("cannot repair a successful verification")
    const fingerprint = verificationFingerprint(result)
    if (this.lastFingerprint === fingerprint)
      return { kind: "exhausted", reason: "repeated_failure" }
    this.lastFingerprint = fingerprint
    if (this.attempts >= this.maxAttempts) return { kind: "exhausted", reason: "attempt_cap" }
    const task = createVerificationRepairTask(result, cwd)
    if (task === undefined) throw new Error("Nifra returned no repair task for a failed verification")
    this.attempts += 1
    return { kind: "repair", attempt: this.attempts, task }
  }
}

export function verificationFingerprint(result: VerificationResult): string {
  return JSON.stringify({
    name: result.name,
    ok: result.ok,
    status: result.status,
    error: result.error ?? "",
    report: result.report ?? null,
  })
}

export function buildRepairPrompt(task: VerificationRepairTask): string {
  const output = task.output === undefined ? "" : task.output.slice(0, 4_096)
  return [
    "[Runrail repair]",
    `Verification gate: ${task.verification}`,
    `Reason: ${task.reason.slice(0, 1_024)}`,
    output.length === 0 ? "Diagnostics: unavailable" : `Diagnostics (bounded):\n${output}`,
    "Repair only within the original workspace and preserve the verification command.",
  ].join("\n")
}
