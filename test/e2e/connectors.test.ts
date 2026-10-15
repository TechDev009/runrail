import { describe, expect, test } from "bun:test"
import { createConnectorRegistry, ConnectorError } from "../../src/connectors/index.ts"

const signal = new AbortController().signal

function fixtureRegistry() {
  return createConnectorRegistry([{
    descriptor: { id: "issue-tracker", version: "1.0.0", capabilities: ["connector.read", "connector.write"] },
    actions: [
      { name: "search", description: "Search issues", kind: "search", capabilities: ["connector.read"], execute: (input) => ({ input, issues: ["ISSUE-1"] }) },
      { name: "comment", description: "Add an issue comment", kind: "write", capabilities: ["connector.write"], requiresApproval: true, execute: () => ({ ok: true }) },
    ],
  }])
}

describe("caller-owned connectors", () => {
  test("enforces capabilities and approvals and projects native tools", async () => {
    const registry = fixtureRegistry()
    const definition = registry.get("issue-tracker")!
    await expect(registry.invoke("issue-tracker", "search", { query: "bug" }, { cwd: "/tmp", signal, allowedCapabilities: ["connector.read"] })).resolves.toMatchObject({ issues: ["ISSUE-1"] })
    await expect(registry.invoke("issue-tracker", "comment", {}, { cwd: "/tmp", signal, allowedCapabilities: ["connector.write"] })).rejects.toMatchObject({ code: "CONNECTOR_APPROVAL_DENIED" })
    await expect(registry.invoke("issue-tracker", "comment", {}, { cwd: "/tmp", signal, allowedCapabilities: ["connector.write"], approve: () => true })).resolves.toMatchObject({ ok: true })
    await expect(registry.invoke("issue-tracker", "comment", {}, { cwd: "/tmp", signal, allowedCapabilities: ["connector.read"], approve: () => true })).rejects.toMatchObject({ code: "CONNECTOR_CAPABILITY_DENIED" })
    const tools = await registry.nativeTools({ cwd: "/tmp", allowedCapabilities: ["connector.read"], approve: () => true })
    expect(tools.map((tool) => tool.name)).toEqual(["connector.issue-tracker.search", "connector.issue-tracker.comment"])
    expect(definition.descriptor).not.toHaveProperty("credential")
  })

  test("rejects invalid definitions and bounded payloads", async () => {
    expect(() => createConnectorRegistry([{
      descriptor: { id: "bad", version: "1.0.0", capabilities: [] },
      actions: [{ name: "write", description: "write", kind: "write", capabilities: ["connector.write"], execute: () => "bad" }],
    }])).toThrow(ConnectorError)
    const registry = fixtureRegistry()
    await expect(registry.invoke("issue-tracker", "search", "x".repeat(300_000), { cwd: "/tmp", signal, allowedCapabilities: ["connector.read"], maxInputBytes: 1024 })).rejects.toMatchObject({ code: "CONNECTOR_LIMIT" })
    const outputBound = createConnectorRegistry([{
      descriptor: { id: "output", version: "1.0.0", capabilities: ["connector.read"] },
      actions: [{ name: "large", description: "Large result", kind: "read", capabilities: ["connector.read"], execute: () => "x".repeat(2_000) }],
    }])
    await expect(outputBound.invoke("output", "large", {}, { cwd: "/tmp", signal, allowedCapabilities: ["connector.read"], maxOutputBytes: 128 })).rejects.toMatchObject({ code: "CONNECTOR_LIMIT" })
  })

  test("a caller's connector failure crosses as a fixed message, not the text it threw", async () => {
    const registry = createConnectorRegistry([{
      descriptor: { id: "leaky", version: "1.0.0", capabilities: ["connector.read"] },
      actions: [{ name: "fetch", description: "Fetch", kind: "read", capabilities: ["connector.read"], execute: () => { throw new Error("token=private-canary-value") } }],
    }])
    const failure = await registry.invoke("leaky", "fetch", {}, { cwd: "/tmp", signal, allowedCapabilities: ["connector.read"] }).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: "CONNECTOR_FAILED", message: "connector: action 'fetch' failed" })
    expect(JSON.stringify(failure)).not.toContain("private-canary-value")
  })

  test("a ConnectorError a caller's connector throws keeps its code, with credentials in its text masked", async () => {
    const registry = createConnectorRegistry([{
      descriptor: { id: "leaky", version: "1.0.0", capabilities: ["connector.read"] },
      actions: [{ name: "fetch", description: "Fetch", kind: "read", capabilities: ["connector.read"], execute: () => { throw new ConnectorError("CONNECTOR_AUTH_FAILED", `refused Authorization: Bearer abcdefgh12345678 and ${"x".repeat(400)}`) } }],
    }])
    const failure = await registry.invoke("leaky", "fetch", {}, { cwd: "/tmp", signal, allowedCapabilities: ["connector.read"] }).then(() => undefined, (error: unknown) => error) as ConnectorError
    expect(failure).toBeInstanceOf(ConnectorError)
    expect(failure.code).toBe("CONNECTOR_AUTH_FAILED")
    expect(failure.message).toStartWith("connector: refused Authorization: ***")
    expect(failure.message).not.toContain("abcdefgh12345678")
    expect(failure.message.length).toBeLessThan(220)
  })
})
