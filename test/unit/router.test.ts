import { expect, test } from "bun:test"
import { createDefaultBackendRegistry } from "../../src/backend/defaults.ts"
import { routeBackend } from "../../src/router.ts"

test("routes to a capable preferred backend deterministically", () => {
  const decision = routeBackend(createDefaultBackendRegistry(), {
    requiredCapabilities: ["providers", "interactive"],
    preferred: "pi",
  })
  expect(decision.backend).toBe("pi")
  expect(decision.capabilities).toContain("providers")
})
