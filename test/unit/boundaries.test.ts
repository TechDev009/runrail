import { describe, expect, test } from "bun:test"
import {
  HostingError,
  LOOPBACK_HOSTING_PROFILE,
  SandboxError,
  createCallerSandboxExecutor,
  createHostingProfile,
  createSandboxRegistry,
  hostingCapabilities,
  negotiateSandbox,
  parseHostingProfile,
  type SandboxRunInput,
} from "../../src/index.ts"

const signal = new AbortController().signal

function runResult() {
  return { status: 0, stdout: "ok", truncated: false, timedOut: false, cancelled: false }
}

describe("hosting and sandbox boundaries", () => {
  test("validates loopback and remote hosting profiles fail-closed", () => {
    expect(parseHostingProfile(LOOPBACK_HOSTING_PROFILE)).toEqual(LOOPBACK_HOSTING_PROFILE)
    const profile = createHostingProfile({ id: "edge", version: "1.0.0", kind: "reverse-proxy", hostname: "runrail.example", port: 443, allowRemote: true, tls: "terminated-proxy", auth: "bearer", durableState: true, sandboxId: "container-main" })
    expect(hostingCapabilities(profile)).toEqual(["control.rpc", "durable.state", "remote.access", "tls", "authenticated", "sandbox.boundary"])
    expect(() => createHostingProfile({ id: "unsafe", version: "1.0.0", kind: "managed", hostname: "runrail.example", port: 80, allowRemote: true, tls: "none", auth: "none", durableState: false })).toThrow(HostingError)
    expect(() => parseHostingProfile({ ...LOOPBACK_HOSTING_PROFILE, hostname: "0.0.0.0", allowRemote: false })).toThrow(HostingError)
  })

  test("selects an explicitly isolated caller executor and rejects unsafe requirements", async () => {
    const local = createCallerSandboxExecutor({ ...LOOPBACK_HOSTING_PROFILE, id: "local-boundary", name: "Local", kind: "none", isolated: false, capabilities: ["process.exec"] }, () => runResult())
    const isolated = createCallerSandboxExecutor({ id: "container-boundary", name: "Container", version: "1.0.0", kind: "container", isolated: true, capabilities: ["process.exec", "network.none"] }, (input: SandboxRunInput) => {
      expect(input.argv).toEqual(["fixture"])
      return runResult()
    })
    const registry = createSandboxRegistry([local, isolated])
    expect(registry.list().map((descriptor) => descriptor.id)).toEqual(["container-boundary", "local-boundary"])
    expect(registry.select({ requireIsolation: true }).descriptor.id).toBe("container-boundary")
    await expect(isolated.run({ argv: ["fixture"], cwd: "/tmp", signal })).resolves.toMatchObject({ status: 0, stdout: "ok" })
    expect(() => negotiateSandbox(local.descriptor, { requireIsolation: true })).toThrow(SandboxError)
    expect(() => registry.select({ requiredCapabilities: ["network.write"] })).toThrow(SandboxError)
  })

  test("bounds sandbox inputs and rejects malformed executor results", async () => {
    const executor = createCallerSandboxExecutor({ id: "bounded", name: "Bounded", version: "1.0.0", kind: "caller", isolated: true, capabilities: [] }, () => ({ status: 0, stdout: "secret-free", truncated: false, timedOut: false, cancelled: false, raw: "discard" }))
    await expect(executor.run({ argv: ["fixture"], cwd: "/tmp", signal })).resolves.toEqual({ status: 0, stdout: "secret-free", truncated: false, timedOut: false, cancelled: false })
    await expect(executor.run({ argv: [], cwd: "/tmp", signal })).rejects.toMatchObject({ code: "SANDBOX_INVALID" })
  })
})
