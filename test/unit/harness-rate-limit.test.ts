import { describe, expect, test } from "bun:test"
import { harnessRateLimitMessage } from "../../src/harness/rate-limit.ts"
import { resolveAccountsRoot } from "../../src/accounts/storage.ts"

describe("quota classification", () => {
  test.each(["allowed", "allowed_warning"])("a passive Claude usage report is not a failure: %s", (status) => {
    expect(harnessRateLimitMessage({ type: "rate_limit_event", rate_limit_info: { status, rateLimitType: "seven_day", utilization: 1 } }, "Claude Code")).toBeUndefined()
  })

  test.each([{ isUsingOverage: true }, { overageStatus: "allowed" }, { overageStatus: "allowed_warning" }])("extra usage can serve an exhausted included allowance: %j", (overage) => {
    expect(harnessRateLimitMessage({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", ...overage } }, "Claude Code")).toBeUndefined()
  })

  test("ordinary assistant content is not mistaken for a quota error", () => {
    expect(harnessRateLimitMessage({ type: "assistant", message: { content: [{ type: "text", text: "You've hit your weekly limit" }] } }, "Claude Code")).toBeUndefined()
    expect(harnessRateLimitMessage({ type: "system", subtype: "api_retry", error_status: 503, error: "overloaded" }, "Claude Code")).toBeUndefined()
  })

  test("Codex's typed limit and HTTP 429 retry faults are terminal, and omit raw diagnostics", () => {
    for (const codexErrorInfo of ["usageLimitExceeded", { responseStreamDisconnected: { httpStatusCode: 429 } }]) {
      const message = harnessRateLimitMessage({ error: { codexErrorInfo, message: "Weekly usage limit reached: sk-must-not-leak" } }, "Codex")
      expect(message).toBe("Codex weekly usage limit reached.")
    }
  })

  test("invalid reset fields and malformed payloads cannot be echoed or throw", () => {
    const value = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: "sk-never" } }
    expect(harnessRateLimitMessage(value, "Claude Code")).toBe("Claude Code weekly usage limit reached.")
    for (const input of [null, [], "quota exceeded", { type: "rate_limit_event", rate_limit_info: "rejected" }]) expect(harnessRateLimitMessage(input, "Claude Code")).toBeUndefined()
  })
})

test("account directory overrides are validated before they become shared storage", () => {
  for (const input of ["", "bad\0path", "bad\npath", 42, null]) expect(() => resolveAccountsRoot(input)).toThrow()
})
