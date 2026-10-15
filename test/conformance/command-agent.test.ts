import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { CommandAgentBackend, CommandAgentBackendError, UNANSWERABLE } from "../../src/backend/command-agent.ts"

const fixture = resolve(import.meta.dir, "../fixtures/agent-jsonl.ts")
const command = { command: "bun", args: ["run", fixture] }

describe("provider-neutral command agent backend", () => {
  test("maps streamed JSONL lifecycle events", async () => {
    const backend = new CommandAgentBackend(command)
    const snapshot = await backend.createSession({ cwd: process.cwd(), sessionId: "command-session" })
    const events = []
    for await (const event of backend.send({ sessionId: snapshot.id, message: "finish" })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(["turn.started", "assistant.delta", "assistant.message", "session.completed"])
    await expect(backend.snapshot(snapshot.id)).resolves.toMatchObject({ status: "completed", lastSeq: 3 })
    await backend.close(snapshot.id)
  })

  test("cancels a held process and emits a stopped event", async () => {
    const backend = new CommandAgentBackend({ ...command, args: ["run", fixture, "hold"] })
    const snapshot = await backend.createSession({ cwd: process.cwd(), sessionId: "command-cancel" })
    const stream = backend.send({ sessionId: snapshot.id, message: "hold" })
    setTimeout(() => void backend.cancel(snapshot.id, "test cancellation"), 15)
    const events = []
    for await (const event of stream) events.push(event)
    expect(events.at(-1)?.type).toBe("session.stopped")
    await backend.close(snapshot.id)
  })

  test("a cancel that lands before the spawn stops the turn without starting the command", async () => {
    const backend = new CommandAgentBackend({ ...command, args: ["run", fixture, "hold"] })
    const snapshot = await backend.createSession({ cwd: process.cwd(), sessionId: "command-cancel-early" })
    const stream = backend.send({ sessionId: snapshot.id, message: "hold" })[Symbol.asyncIterator]()
    // The first step runs up to the environment lookup, so the cancel finds no process yet.
    const first = stream.next()
    await backend.cancel(snapshot.id, "early cancellation")
    const event = (await first).value
    expect(event?.type).toBe("session.stopped")
    expect(event?.type === "session.stopped" ? event.reason : undefined).toBe("early cancellation")
    expect((await stream.next()).done).toBe(true)
    await backend.close(snapshot.id)
  })

  test("rejects malformed events and oversized output", async () => {
    const bad = new CommandAgentBackend({ ...command, args: ["run", fixture, "bad"] })
    const badSession = await bad.createSession({ cwd: process.cwd(), sessionId: "command-bad" })
    await expect((async () => { for await (const _event of bad.send({ sessionId: badSession.id, message: "bad" })) {} })()).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })
    await bad.close(badSession.id)
    const huge = new CommandAgentBackend({ ...command, args: ["run", fixture, "huge"], maxOutputBytes: 64 })
    const hugeSession = await huge.createSession({ cwd: process.cwd(), sessionId: "command-huge" })
    await expect((async () => { for await (const _event of huge.send({ sessionId: hugeSession.id, message: "huge" })) {} })()).rejects.toBeInstanceOf(CommandAgentBackendError)
    await huge.close(hugeSession.id)

    const argument = new CommandAgentBackend({ ...command, promptMode: "argument" })
    const argumentSession = await argument.createSession({ cwd: process.cwd(), sessionId: "command-argument-bound" })
    await expect((async () => {
      for await (const _event of argument.send({ sessionId: argumentSession.id, message: "x".repeat(128 * 1024 + 1) })) {}
    })()).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    await argument.close(argumentSession.id)
  })

  test("rejects a stream that exceeds its event bound", async () => {
    const bounded = new CommandAgentBackend({ ...command, maxEvents: 3 })
    const session = await bounded.createSession({ cwd: process.cwd(), sessionId: "command-event-bound" })
    await expect((async () => {
      for await (const _event of bounded.send({ sessionId: session.id, message: "bounded" })) {}
    })()).rejects.toMatchObject({ code: "COMMAND_AGENT_OUTPUT_INVALID" })
    await bounded.close(session.id)
  })

  test("uses the subscription environment by default and does not forward arbitrary credentials", async () => {
    const backend = new CommandAgentBackend({
      ...command,
      env: { RUNRAIL_HARNESS_SECRET: "must-not-forward" },
      args: ["run", fixture, "env"],
    })
    const session = await backend.createSession({ cwd: process.cwd(), sessionId: "command-subscription" })
    const events = []
    for await (const event of backend.send({ sessionId: session.id, message: "check auth" })) events.push(event)
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "credential-absent" }))
    await backend.close(session.id)
  })

  test("forwards only explicitly named environment credentials", async () => {
    const backend = new CommandAgentBackend({
      ...command,
      env: { RUNRAIL_HARNESS_SECRET: "present" },
      auth: { mode: "environment", credentialEnvironment: ["RUNRAIL_HARNESS_SECRET"] },
      args: ["run", fixture, "env"],
    })
    const session = await backend.createSession({ cwd: process.cwd(), sessionId: "command-environment-auth" })
    const events = []
    for await (const event of backend.send({ sessionId: session.id, message: "check auth" })) events.push(event)
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "credential-present" }))
    await backend.close(session.id)
  })

  test("supports caller-owned credential resolution without exposing the secret", async () => {
    const seen: string[][] = []
    const backend = new CommandAgentBackend({
      ...command,
      auth: {
        mode: "caller",
        credentialEnvironment: ["RUNRAIL_HARNESS_SECRET"],
        credentialResolver: (names) => {
          seen.push([...names])
          return { RUNRAIL_HARNESS_SECRET: "caller-secret" }
        },
      },
      args: ["run", fixture, "env"],
    })
    const session = await backend.createSession({ cwd: process.cwd(), sessionId: "command-caller-auth" })
    const events = []
    for await (const event of backend.send({ sessionId: session.id, message: "check auth" })) events.push(event)
    expect(seen).toEqual([["RUNRAIL_HARNESS_SECRET"]])
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "credential-present" }))
    expect(JSON.stringify(events)).not.toContain("caller-secret")
    await backend.close(session.id)
  })

  test("fails closed for missing credentials, missing commands, and login failures", async () => {
    const missingCredential = new CommandAgentBackend({
      ...command,
      auth: { mode: "environment", credentialEnvironment: ["RUNRAIL_MISSING_HARNESS_SECRET"] },
    })
    const missingCredentialSession = await missingCredential.createSession({ cwd: process.cwd(), sessionId: "command-missing-credential" })
    await expect((async () => {
      for await (const _event of missingCredential.send({ sessionId: missingCredentialSession.id, message: "run" })) {}
    })()).rejects.toMatchObject({ code: "COMMAND_AGENT_CREDENTIALS_UNAVAILABLE" })
    await missingCredential.close(missingCredentialSession.id)

    const missingCommand = new CommandAgentBackend({ command: "runrail-command-not-installed" })
    const missingCommandSession = await missingCommand.createSession({ cwd: process.cwd(), sessionId: "command-missing" })
    await expect((async () => {
      for await (const _event of missingCommand.send({ sessionId: missingCommandSession.id, message: "run" })) {}
    })()).rejects.toMatchObject({ code: "COMMAND_AGENT_NOT_FOUND" })
    await missingCommand.close(missingCommandSession.id)

    const loginFailure = new CommandAgentBackend({ ...command, args: ["run", fixture, "auth-failure"] })
    const loginFailureSession = await loginFailure.createSession({ cwd: process.cwd(), sessionId: "command-login-failure" })
    const failure = await (async () => {
      try {
        for await (const _event of loginFailure.send({ sessionId: loginFailureSession.id, message: "run" })) {}
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(failure).toMatchObject({ code: "COMMAND_AGENT_AUTH_FAILED" })
    expect(failure instanceof Error ? failure.message : "").not.toContain("not logged in")
    await loginFailure.close(loginFailureSession.id)
  })
})

describe("a command agent that fails or asks", () => {
  async function failure(backend: CommandAgentBackend, sessionId: string): Promise<unknown> {
    const session = await backend.createSession({ cwd: process.cwd(), sessionId })
    try {
      for await (const _event of backend.send({ sessionId: session.id, message: "run" })) {}
      return undefined
    } catch (error) {
      return error
    } finally {
      await backend.close(session.id)
    }
  }

  test("an unsuccessful exit says why in the command's own words, never the credential it was given", async () => {
    const backend = new CommandAgentBackend({ ...command, args: ["run", fixture, "fail-stderr"], env: { RUNRAIL_HARNESS_SECRET: "fixture-secret-value" }, auth: { mode: "environment", credentialEnvironment: ["RUNRAIL_HARNESS_SECRET"] } })
    const error = await failure(backend, "command-fail-words")
    expect(error).toMatchObject({ code: "COMMAND_AGENT_FAILED", reason: "agent command exited with code 2: error: unknown option '--frobnicate' (key ***)" })
    expect(String(error)).not.toContain("fixture-secret-value")
  })

  test("a print run's request is settled at once: nothing can carry an answer back to it", async () => {
    // A vendor CLI's records go through a mapper, which numbers them after the backend's own.
    const backend = new CommandAgentBackend({ ...command, args: ["run", fixture, "approval"], eventMapper: (value, context) => ({ ...(value as AgentEvent), seq: context.nextSeq }) as AgentEvent })
    const session = await backend.createSession({ cwd: process.cwd(), sessionId: "command-print-approval" })
    const events: AgentEvent[] = []
    for await (const event of backend.send({ sessionId: session.id, message: "run" })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(["turn.started", "approval.required", "approval.resolved", "session.completed"])
    expect(events[2]).toMatchObject({ approvalId: "fixture-approval", approved: false, withdrawn: true, reason: UNANSWERABLE })
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    await backend.close(session.id)
  })
})

test("a prompt that starts with a hyphen is never read as an option", () => {
  const backend = new CommandAgentBackend({ command: "agent", args: ["exec", "--json"], promptMode: "argument" })
  const argv = (message: string) => (backend as unknown as { commandArguments(message: string, resume: undefined): readonly string[] }).commandArguments(message, undefined)
  expect(argv("--dangerously-bypass-approvals")).toEqual(["exec", "--json", "--", "--dangerously-bypass-approvals"])
  expect(argv("fix the build")).toEqual(["exec", "--json", "fix the build"])
})
