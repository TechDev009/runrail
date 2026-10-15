import { describe, expect, test } from "bun:test"
import type { AgentBackend } from "@nifrajs/agent-protocol"
import {
  BackendRegistryError,
  createBackendRegistry,
  type RunrailBackendAdapter,
} from "../../src/backend/registry.ts"

const fakeBackend = (name: string): AgentBackend => ({
  info: { name, capabilities: [] },
  createSession: async () => {
    throw new Error("not used")
  },
  send: () => {
    throw new Error("not used")
  },
  cancel: async () => {},
  snapshot: async () => {
    throw new Error("not used")
  },
  reload: async () => ({ revision: "test", loaded: [], disabled: [], rolledBack: false }),
  close: async () => {},
})

function adapter(name: string, capabilities: readonly string[]): RunrailBackendAdapter {
  return {
    name,
    version: "test",
    capabilities,
    create: () => fakeBackend(name),
  }
}

describe("backend registry", () => {
  test("selects the deterministic first capable adapter", () => {
    const registry = createBackendRegistry([
      adapter("zeta", ["sessions", "streaming"]),
      adapter("alpha", ["sessions", "streaming", "approvals"]),
    ])
    expect(registry.select({ requiredCapabilities: ["streaming", "sessions"] }).name).toBe("alpha")
    expect(registry.list().map((entry) => entry.name)).toEqual(["alpha", "zeta"])
  })

  test("honors a preferred capable adapter without weakening requirements", () => {
    const registry = createBackendRegistry([
      adapter("alpha", ["sessions", "streaming"]),
      adapter("pi", ["sessions", "streaming", "interactive"]),
    ])
    expect(
      registry.select({ requiredCapabilities: ["interactive"], preferred: "pi" }).name,
    ).toBe("pi")
    expect(() => registry.select({ requiredCapabilities: ["interactive"], preferred: "alpha" })).toThrow(
      BackendRegistryError,
    )
    try {
      registry.select({ requiredCapabilities: ["interactive"], preferred: "alpha" })
    } catch (error) {
      expect(error).toMatchObject({ code: "BACKEND_CAPABILITY_UNAVAILABLE" })
    }
  })

  test("rejects duplicate adapter identities", () => {
    expect(() => createBackendRegistry([adapter("pi", []), adapter("pi", [])])).toThrow(BackendRegistryError)
    try {
      createBackendRegistry([adapter("pi", []), adapter("pi", [])])
    } catch (error) {
      expect(error).toMatchObject({ code: "BACKEND_DUPLICATE" })
    }
  })

  test("rejects malformed security manifests", () => {
    expect(() =>
      createBackendRegistry([
        {
          ...adapter("unsafe", []),
          securityManifest: { version: 1, requested: ["unknown"], trusted: [] } as never,
        },
      ]),
    ).toThrow(BackendRegistryError)
  })
})
