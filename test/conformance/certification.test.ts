import { describe, expect, test } from "bun:test"
import type {
  AgentBackend,
  AgentEvent,
  AgentSessionSnapshot,
  ReloadResult,
} from "@nifrajs/agent-protocol"
import {
  certifyAdapter,
  certifyAdapters,
  type AdapterCertificationProfile,
  type CertificationAdapterKind,
} from "../../src/certification/harness.ts"

const fixtureCapabilities = Object.freeze(["sessions", "streaming", "tools", "approvals", "reload"])
const fixtureKinds: readonly CertificationAdapterKind[] = [
  "pi-compatible",
  "codex-compatible",
  "claude-compatible",
  "grok-compatible",
  "remote",
  "a2a-compatible",
]

interface FixtureSession {
  snapshot: AgentSessionSnapshot
  approvalResolved: boolean
}

function createCertificationFixture(name: string): AgentBackend {
  const sessions = new Map<string, FixtureSession>()
  const info = Object.freeze({ name, version: "fixture-1.0.0", capabilities: fixtureCapabilities })
  return {
    info,
    createSession: async (input) => {
      const id = input.sessionId ?? `${name}-session`
      const snapshot = makeSnapshot(id, name, input.cwd, "idle", -1)
      sessions.set(id, { snapshot, approvalResolved: false })
      return snapshot
    },
    send: (input) => (async function* (): AsyncGenerator<AgentEvent> {
      const session = sessions.get(input.sessionId)
      if (session === undefined) throw new Error("fixture session is missing")
      const turnId = "fixture-turn"
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 0,
        at: 0,
        type: "turn.started",
        turnId,
        prompt: "fixture prompt must not be persisted",
      }
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 1,
        at: 1,
        type: "assistant.delta",
        turnId,
        text: "fixture streamed output",
      }
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 2,
        at: 2,
        type: "assistant.message",
        turnId,
        text: "fixture assistant message",
      }
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 3,
        at: 3,
        type: "tool.started",
        turnId,
        callId: "fixture-call",
        name: "fixture_tool",
        input: { secret: "tool input must not be persisted" },
      }
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 4,
        at: 4,
        type: "tool.completed",
        turnId,
        callId: "fixture-call",
        name: "fixture_tool",
        ok: true,
        output: { secret: "tool output must not be persisted" },
      }
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 5,
        at: 5,
        type: "approval.required",
        turnId,
        approvalId: "fixture-approval",
        action: "fixture action",
        capability: "tools",
      }
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 6,
        at: 6,
        type: "approval.resolved",
        turnId,
        approvalId: "fixture-approval",
        approved: session.approvalResolved,
      }
      const snapshot = makeSnapshot(input.sessionId, name, session.snapshot.cwd, "completed", 7)
      session.snapshot = snapshot
      yield {
        version: 1,
        sessionId: input.sessionId,
        seq: 7,
        at: 7,
        type: "session.completed",
        snapshot,
      }
    })(),
    cancel: async (sessionId, reason) => {
      const session = sessions.get(sessionId)
      if (session !== undefined) session.snapshot = makeSnapshot(sessionId, name, session.snapshot.cwd, "stopped", session.snapshot.lastSeq)
      void reason
    },
    snapshot: async (sessionId) => {
      const session = sessions.get(sessionId)
      if (session === undefined) throw new Error("fixture session is missing")
      return session.snapshot
    },
    reload: async (): Promise<ReloadResult> => ({ revision: "fixture:1", loaded: [], disabled: [], rolledBack: false }),
    resolveApproval: async (sessionId, approvalId, approved) => {
      if (approvalId !== "fixture-approval") return false
      const session = sessions.get(sessionId)
      if (session === undefined) return false
      session.approvalResolved = approved
      return true
    },
    close: async (sessionId) => {
      sessions.delete(sessionId)
    },
  }
}

function makeSnapshot(
  id: string,
  backend: string,
  cwd: string,
  status: AgentSessionSnapshot["status"],
  lastSeq: number,
): AgentSessionSnapshot {
  return Object.freeze({
    version: 1,
    id,
    backend,
    cwd,
    status,
    createdAt: 0,
    updatedAt: lastSeq,
    lastSeq,
    capabilities: fixtureCapabilities,
  })
}

function profile(kind: CertificationAdapterKind): AdapterCertificationProfile {
  return {
    id: `${kind}-fixture`,
    kind,
    version: "1.0.0",
    capabilities: fixtureCapabilities,
    requiredCapabilities: ["sessions", "streaming", "tools", "approvals", "reload"],
    requiredBehaviors: ["session-lifecycle", "streaming", "tool-mapping", "approval"],
    create: () => createCertificationFixture(`${kind}-backend`),
    resolveApproval: () => true,
  }
}

describe("adapter certification fixtures", () => {
  test("certifies every supported adapter kind without provider access", async () => {
    const suite = await certifyAdapters(fixtureKinds.map(profile), { cwd: process.cwd() })
    expect(suite.ok).toBe(true)
    expect(suite.results.map((result) => result.kind)).toEqual([...fixtureKinds])
    expect(suite.results.every((result) => result.eventCount === 8 && result.streamedDeltas === 1 && result.approvals === 1 && result.ok)).toBe(true)
    expect(JSON.stringify(suite)).not.toContain("fixture prompt must not be persisted")
    expect(JSON.stringify(suite)).not.toContain("tool input must not be persisted")
    expect(JSON.stringify(suite)).not.toContain("tool output must not be persisted")
  })

  test("reports capability rejection before creating a session", async () => {
    let sessions = 0
    const result = await certifyAdapter({
      ...profile("remote"),
      id: "capability-fixture",
      requiredCapabilities: ["network.request"],
      create: () => {
        sessions += 1
        return createCertificationFixture("capability-backend")
      },
    }, { cwd: process.cwd() })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual({ name: "required-capabilities", code: "CERTIFICATION_REQUIRED_CAPABILITIES", ok: false })
    expect(sessions).toBe(1)
    expect(result.eventCount).toBe(0)
  })

  test("fails approval certification when the backend has no resolver", async () => {
    const backend = createCertificationFixture("approval-without-resolver")
    const { resolveApproval: _resolveApproval, ...withoutResolver } = backend
    const result = await certifyAdapter({
      ...profile("remote"),
      id: "approval-without-resolver",
      create: () => withoutResolver,
    }, { cwd: process.cwd() })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual(expect.objectContaining({ name: "approval-resolution", code: "CERTIFICATION_APPROVAL_UNSUPPORTED", ok: false }))
  })

  test("converts an adapter initialization timeout to a stable failed result", async () => {
    const result = await certifyAdapter({
      ...profile("a2a-compatible"),
      id: "timeout-fixture",
      timeoutMs: 2,
      create: () => new Promise<AgentBackend>((resolve) => setTimeout(() => resolve(createCertificationFixture("late-backend")), 25)),
    }, { cwd: process.cwd() })
    expect(result.ok).toBe(false)
    expect(result.checks).toContainEqual({ name: "execution", code: "CERTIFICATION_TIMEOUT", ok: false })
  })
  test("runs caller-owned certification probes for cancellation, bounds, fallback, and repair", async () => {
    const result = await certifyAdapter({
      ...profile("remote"),
      id: "probed-fixture",
      requiredBehaviors: ["cancellation", "output-bounds", "capability-rejection", "retry-fallback", "verification-repair"],
      probes: {
        cancellation: ({ sessionId }) => sessionId.length > 0,
        "output-bounds": () => true,
        "capability-rejection": () => true,
        "retry-fallback": () => true,
        "verification-repair": () => true,
      },
    }, { cwd: process.cwd() })
    expect(result.ok).toBe(true)
    expect(result.checks.filter((check) => check.name.startsWith("behavior:")).every((check) => check.ok)).toBe(true)
  })
})
