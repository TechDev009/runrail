import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createPtyAgentBackend, PtyAgentBackendError } from "../../src/index.ts"

const fixture = join(process.cwd(), "test/fixtures/agent-jsonl.ts")
const command = process.execPath

async function collect(source: AsyncIterable<unknown>): Promise<readonly unknown[]> {
  const events: unknown[] = []
  for await (const event of source) events.push(event)
  return events
}

describe("PTY command agent backend", () => {
  test("streams normalized events through a real Bun PTY without echoing the prompt", async () => {
    const backend = createPtyAgentBackend({ command, args: [fixture, "events"], name: "pty-fixture" })
    const session = await backend.createSession({ cwd: process.cwd(), backend: "pty-fixture", sessionId: "pty-success" })
    const events = await collect(backend.send({ sessionId: session.id, message: "pty prompt must not be retained", signal: new AbortController().signal }))
    expect(events.map((event) => (event as { readonly type: string }).type)).toEqual(["turn.started", "assistant.delta", "assistant.message", "session.completed"])
    expect(await backend.snapshot(session.id)).toMatchObject({ status: "completed", lastSeq: 3 })
    expect(JSON.stringify(events)).not.toContain("pty prompt must not be retained")
    await backend.close(session.id)
  })

  test("a prompt longer than the terminal's line limit arrives whole", async () => {
    const backend = createPtyAgentBackend({ command, args: [fixture, "length"], name: "pty-length", timeoutMs: 10_000 })
    const session = await backend.createSession({ cwd: process.cwd(), backend: "pty-length", sessionId: "pty-length" })
    const events = await collect(backend.send({ sessionId: session.id, message: "p".repeat(20_000), signal: new AbortController().signal }))
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "length 20000" }))
    await backend.close(session.id)
  })

  test("supports resize and cancellation while a PTY process is active", async () => {
    const backend = createPtyAgentBackend({ command, args: [fixture, "hold"], name: "pty-hold", timeoutMs: 2_000 })
    const session = await backend.createSession({ cwd: process.cwd(), backend: "pty-hold", sessionId: "pty-cancel" })
    const abort = new AbortController()
    const running = collect(backend.send({ sessionId: session.id, message: "hold", signal: abort.signal }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    backend.resize(session.id, 100, 30)
    abort.abort()
    await expect(running).resolves.toContainEqual(expect.objectContaining({ type: "session.stopped" }))
    expect(await backend.snapshot(session.id)).toMatchObject({ status: "stopped" })
    await backend.close(session.id)
  })

  test("rejects malformed options and oversized PTY output with stable errors", async () => {
    expect(() => createPtyAgentBackend({ command: "bad command" })).toThrow(PtyAgentBackendError)
    const backend = createPtyAgentBackend({ command, args: [fixture, "huge"], name: "pty-huge", maxStreamBytes: 128 })
    const session = await backend.createSession({ cwd: process.cwd(), backend: "pty-huge", sessionId: "pty-huge" })
    await expect(collect(backend.send({ sessionId: session.id, message: "huge", signal: new AbortController().signal }))).rejects.toMatchObject({ code: "PTY_AGENT_OUTPUT_INVALID" })
    await backend.close(session.id)
  })

  test("a program that fails says why in what it printed, never the credential it was given; a missing one is named", async () => {
    const backend = createPtyAgentBackend({ command, args: [fixture, "fail-stderr"], name: "pty-fail", env: { RUNRAIL_HARNESS_SECRET: "fixture-secret-value" }, auth: { mode: "environment", credentialEnvironment: ["RUNRAIL_HARNESS_SECRET"] } })
    const session = await backend.createSession({ cwd: process.cwd(), sessionId: "pty-fail-words" })
    const failed = await collect(backend.send({ sessionId: session.id, message: "run" })).then(() => undefined, (error: unknown) => error)
    // Its error shares the terminal with the protocol, so the line that broke the stream says why.
    expect(failed).toMatchObject({ code: "PTY_AGENT_OUTPUT_INVALID", reason: "agent PTY emitted invalid JSONL: error: unknown option '--frobnicate' (key ***)" })
    expect(String(failed)).not.toContain("fixture-secret-value")
    await backend.close(session.id)

    const missing = createPtyAgentBackend({ command: "runrail-command-not-installed" })
    const other = await missing.createSession({ cwd: process.cwd(), sessionId: "pty-missing" })
    await expect(collect(missing.send({ sessionId: other.id, message: "run" }))).rejects.toMatchObject({ code: "PTY_AGENT_FAILED", reason: "agent command was not found" })
    await missing.close(other.id)
  })

  test("uses subscription auth by default and forwards only named credentials", async () => {
    const subscription = createPtyAgentBackend({ command, args: [fixture, "env"], env: { RUNRAIL_HARNESS_SECRET: "must-not-forward" } })
    const subscriptionSession = await subscription.createSession({ cwd: process.cwd(), sessionId: "pty-subscription-auth" })
    await expect(collect(subscription.send({ sessionId: subscriptionSession.id, message: "check auth" }))).resolves.toContainEqual(expect.objectContaining({ type: "assistant.message", text: "credential-absent" }))
    await subscription.close(subscriptionSession.id)

    const environment = createPtyAgentBackend({ command, args: [fixture, "env"], env: { RUNRAIL_HARNESS_SECRET: "present" }, auth: { mode: "environment", credentialEnvironment: ["RUNRAIL_HARNESS_SECRET"] } })
    const environmentSession = await environment.createSession({ cwd: process.cwd(), sessionId: "pty-environment-auth" })
    await expect(collect(environment.send({ sessionId: environmentSession.id, message: "check auth" }))).resolves.toContainEqual(expect.objectContaining({ type: "assistant.message", text: "credential-present" }))
    await environment.close(environmentSession.id)
  })
})
