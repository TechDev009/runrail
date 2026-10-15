import { describe, expect, test } from "bun:test"
import { claudeDenial, claudeUnaskedDenial, codexReview, codexWarning, oneLine, parseApprovalReview, parseReviewerNotice } from "../../src/harness/review.ts"

const review = (status: string, extra: Record<string, unknown> = {}) => ({ status, riskLevel: null, userAuthorization: null, rationale: null, ...extra })

describe("Codex's own reviewer", () => {
  test("names what was reviewed for each kind of action Codex sends", () => {
    const decided = (action: Record<string, unknown>) => codexReview("item/autoApprovalReview/completed", { reviewId: "r1", review: review("denied"), action })
    expect(decided({ type: "command", command: "rm -rf build", cwd: "/w" })).toMatchObject({ action: "command", capability: "process.exec", detail: "rm -rf build" })
    // Codex runs every command through a login shell; the row names the command.
    expect(decided({ type: "command", command: `/bin/zsh -lc 'curl -sSI -o /dev/null -w "%{http_code}" https://example.com'` })).toMatchObject({ detail: 'curl -sSI -o /dev/null -w "%{http_code}" https://example.com' })
    expect(decided({ type: "execve", program: "/bin/ls", argv: ["ls", "-la", 3] })).toMatchObject({ action: "command", capability: "process.exec", detail: "ls -la" })
    expect(decided({ type: "execve", program: "/bin/ls", argv: [] })).toMatchObject({ detail: "/bin/ls" })
    // What a running command is sent can be a secret.
    expect(JSON.stringify(decided({ type: "writeStdin", stdin: "hunter2", approvalId: "a", processId: "p" }))).not.toContain("hunter2")
    expect(decided({ type: "applyPatch", files: ["a.ts", "b.ts"] })).toMatchObject({ action: "file_change", capability: "filesystem.write", detail: "a.ts, b.ts" })
    expect(decided({ type: "applyPatch", files: ["a", "b", "c", "d"] })).toMatchObject({ detail: "a, b, c and 1 more" })
    expect(decided({ type: "networkAccess", host: "example.com", port: 443, target: "https://example.com/x" })).toMatchObject({ action: "permission", capability: "network.request", detail: "example.com" })
    expect(decided({ type: "networkAccess", host: "localhost", port: 8080, target: "http://localhost:8080" })).toMatchObject({ detail: "localhost:8080" })
    expect(decided({ type: "mcpToolCall", server: "gh", toolName: "create_issue", connectorName: null, toolTitle: "Create issue" })).toMatchObject({ capability: "tool.use", detail: "gh: Create issue" })
    expect(decided({ type: "requestPermissions", reason: "needs the network", permissions: {} })).toMatchObject({ capability: "sandbox.permission", detail: "needs the network" })
    expect(decided({ type: "somethingNew" })).toEqual({ reviewId: "codex-r1", reviewer: "codex", decision: "denied", action: "permission", capability: "tool.use" })
  })

  test("a start is only a start, and an unknown status or id is not a review", () => {
    expect(codexReview("item/autoApprovalReview/started", { reviewId: "r1", review: review("approved"), action: {} })).toMatchObject({ decision: "reviewing" })
    expect(codexReview("item/autoApprovalReview/completed", { reviewId: "r1", review: review("inProgress"), action: {} })).toBeUndefined()
    expect(codexReview("item/autoApprovalReview/completed", { reviewId: "r1", review: review("timedOut", { riskLevel: "critical", rationale: "slow\n\tthinking" }), action: {} })).toMatchObject({ decision: "timed-out", risk: "critical", rationale: "slow thinking" })
    expect(codexReview("item/autoApprovalReview/completed", { reviewId: "r1", review: review("approved", { riskLevel: "extreme" }), action: {} })).not.toHaveProperty("risk")
    expect(codexReview("item/autoApprovalReview/completed", { reviewId: "r1", review: review("vetoed"), action: {} })).toBeUndefined()
    expect(codexReview("item/autoApprovalReview/completed", { reviewId: "x".repeat(129), review: review("approved"), action: {} })).toBeUndefined()
    expect(codexReview("item/autoApprovalReview/completed", { review: review("approved"), action: {} })).toBeUndefined()
    expect(codexReview("item/commandExecution/requestApproval", { reviewId: "r1", review: review("approved") })).toBeUndefined()
  })
})

describe("Codex's reviewer warnings", () => {
  test("a restated decision is left to the review's row; any other warning is Codex's own words", () => {
    expect(codexWarning("Automatic approval review approved (risk: low, authorization: high): The user explicitly authorized rerunning this exact curl command.")).toBeUndefined()
    expect(codexWarning("Automatic approval review denied (risk: high, authorization: unknown): Pushes to a shared remote.")).toBeUndefined()
    expect(codexWarning("Automatic approval review failed: reviewer\nunavailable")).toBe("Automatic approval review failed: reviewer unavailable")
    expect(codexWarning("Automatic approval review rejected too many approval requests for this turn (3 consecutive, 5 in the last 10 reviews); interrupting the turn.")).toContain("interrupting the turn")
    expect(codexWarning(" ")).toBeUndefined()
    expect(codexWarning(7)).toBeUndefined()
  })
})

describe("Claude Code's denials", () => {
  test("say what decided and in whose words", () => {
    const denied = (extra: Record<string, unknown>) => claudeDenial({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_1", message: "Denied.", ...extra }, { action: "command", capability: "process.exec" }, "git push")
    expect(denied({ decision_reason_type: "classifier", decision_reason: "Risky." })).toEqual({ reviewId: "claude-denied-toolu_1", reviewer: "claude-code", decision: "denied", action: "command", capability: "process.exec", source: "reviewer", detail: "git push", rationale: "Risky." })
    expect(denied({ decision_reason_type: "asyncAgent" })).toEqual({ reviewId: "claude-denied-toolu_1", reviewer: "claude-code", decision: "denied", action: "command", capability: "process.exec", detail: "git push", rationale: "Denied." })
    expect(denied({ tool_use_id: 7 })).toBeUndefined()
    expect(claudeDenial({ type: "system", subtype: "init", tool_use_id: "toolu_1" }, { action: "command", capability: "process.exec" })).toBeUndefined()
  })

  test("one refused silently names no source and no reason, only what was refused", () => {
    expect(claudeUnaskedDenial("toolu_1", { action: "command", capability: "process.exec" }, "echo\ndenied-check")).toEqual({ reviewId: "claude-denied-toolu_1", reviewer: "claude-code", decision: "denied", action: "command", capability: "process.exec", detail: "echo denied-check" })
    expect(claudeUnaskedDenial("toolu_1", { action: "file_change", capability: "filesystem.write" })).toEqual({ reviewId: "claude-denied-toolu_1", reviewer: "claude-code", decision: "denied", action: "file_change", capability: "filesystem.write" })
    expect(claudeUnaskedDenial("toolu 1", { action: "command", capability: "process.exec" })).toBeUndefined()
  })
})

describe("recorded review events", () => {
  test("are read back bounded, and refused when malformed", () => {
    const base = { type: "approval.reviewed", turnId: "t1", reviewId: "codex-r1", reviewer: "codex", decision: "approved", action: "command", capability: "process.exec" }
    expect(parseApprovalReview({ ...base, risk: "low", source: "rule", detail: "x".repeat(600), rationale: "fine" })).toMatchObject({ turnId: "t1", risk: "low", source: "rule", rationale: "fine" })
    expect(parseApprovalReview({ ...base, detail: "x".repeat(600) })?.detail).toHaveLength(512)
    expect(parseApprovalReview({ ...base, risk: "huge", source: "magic" })).not.toHaveProperty("risk")
    for (const broken of [{ type: "approval.required" }, { reviewId: 3 }, { reviewer: "gemini" }, { decision: "maybe" }, { action: undefined }]) expect(parseApprovalReview({ ...base, ...broken })).toBeUndefined()
    expect(parseReviewerNotice({ type: "reviewer.notice", reviewer: "claude-code", notice: "unavailable" })).toEqual({ reviewer: "claude-code", notice: "unavailable" })
    expect(parseReviewerNotice({ type: "reviewer.notice", reviewer: "codex", notice: "warning", message: " a\n b " })).toEqual({ reviewer: "codex", notice: "warning", message: "a b" })
    expect(parseReviewerNotice({ type: "reviewer.notice", reviewer: "codex", notice: "panic" })).toBeUndefined()
  })

  test("one line keeps text readable and bounded", () => {
    expect(oneLine("a\u0000b\r\n\tc", 10)).toBe("a b c")
    expect(oneLine("abcdef", 4)).toBe("abc…")
    expect(oneLine("   ", 4)).toBeUndefined()
    expect(oneLine(5, 4)).toBeUndefined()
  })
})
