import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { createPiBackend } from "../../src/backend/pi.ts"
import { createRunrailSession } from "../../src/session.ts"

const fixture = resolve(import.meta.dir, "../fixtures/pi-rpc.ts")
const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")

describe("Pi backend conformance", () => {
  test("maps JSONL assistant and tool events and reloads", async () => {
    const backend = createPiBackend({ command: process.execPath, rpcArgs: [fixture, "events"], reloadCommand: "rpc" })
    const snapshot = await backend.createSession({ cwd: process.cwd(), sessionId: "pi-events" })
    const events = []
    for await (const event of backend.send({ sessionId: snapshot.id, message: "hello" })) events.push(event)
    expect(events.map((event) => event.type)).toEqual([
      "session.updated",
      "turn.started",
      "assistant.delta",
      "assistant.message",
      "tool.started",
      "tool.completed",
      "session.updated",
      "session.completed",
    ])
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ name: "read_file", ok: true })
    await expect(backend.reload(snapshot.id)).resolves.toMatchObject({ revision: "fixture:1" })
    await backend.close(snapshot.id)
  })

  test("maps and resolves a public approval request", async () => {
    const backend = createPiBackend({ command: process.execPath, rpcArgs: [fixture, "approval"] })
    const snapshot = await backend.createSession({ cwd: process.cwd(), sessionId: "pi-approval" })
    const events = []
    for await (const event of backend.send({ sessionId: snapshot.id, message: "approve" })) {
      events.push(event)
      if (event.type === "approval.required")
        await expect(backend.resolveApproval(snapshot.id, event.approvalId, true)).resolves.toBe(true)
    }
    expect(events.map((event) => event.type)).toContain("approval.required")
    expect(events.at(-1)?.type).toBe("session.completed")
    await backend.close(snapshot.id)
  })

  test("cancels a live JSONL turn", async () => {
    const backend = createPiBackend({ command: process.execPath, rpcArgs: [fixture, "hold"] })
    const snapshot = await backend.createSession({ cwd: process.cwd(), sessionId: "pi-cancel" })
    const stream = backend.send({ sessionId: snapshot.id, message: "hold" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await backend.cancel(snapshot.id, "test cancellation")
    const events = []
    for await (const event of stream) events.push(event)
    expect(events.some((event) => event.type === "session.stopped")).toBe(true)
    await backend.close(snapshot.id)
  })

  test("uses Pi controls through the shared Runrail session", async () => {
    const session = await createRunrailSession({
      cwd: process.cwd(),
      backend: "pi",
      verify: "check",
      verificationCommand: verifier,
      loadExtensions: false,
      pi: {
        command: process.execPath,
        rpcArgs: [fixture, "events"],
        noSession: true,
        reloadCommand: "rpc",
        appendSystemPrompt: "test prompt",
        enableNifraTools: false,
      },
    })
    try {
      const events = []
      for await (const event of session.prompt("hello")) events.push(event)
      expect(events.some((event) => event.type === "assistant.message")).toBe(true)
      await expect(session.reload()).resolves.toMatchObject({ revision: "fixture:1" })
    } finally {
      await session.stop("test complete")
    }
  })

  test("a model and a thinking level chosen in Runrail reach Pi as its own flags", async () => {
    const started = async (options: Partial<Parameters<typeof createRunrailSession>[0]>, args?: readonly string[]): Promise<unknown> => {
      const session = await createRunrailSession({
        cwd: process.cwd(),
        backend: "pi",
        verify: "check",
        verificationCommand: verifier,
        loadExtensions: false,
        pi: { command: process.execPath, rpcArgs: [fixture, "argv"], noSession: true, enableNifraTools: false, ...(args === undefined ? {} : { args }) },
        ...options,
      })
      try {
        let text = ""
        for await (const event of session.prompt("hello")) if (event.type === "assistant.message") text = event.text
        return JSON.parse(text)
      } finally {
        await session.stop("test complete")
      }
    }
    expect(await started({})).toEqual([])
    expect(await started({ modelSelection: { id: "github-copilot/gpt-fixture", thinking: "high" } })).toEqual(["--model", "github-copilot/gpt-fixture", "--thinking", "high"])
    expect(await started({ modelSelection: { thinking: "off" } })).toEqual(["--thinking", "off"])
    // What the caller wrote on Pi's command line stays as written.
    expect(await started({ modelSelection: { id: "openai/other", thinking: "low" } }, ["--model", "mine", "--thinking", "max"])).toEqual(["--model", "mine", "--thinking", "max"])
    // A model id is one argument and can never be read as a flag.
    expect(createRunrailSession({ cwd: process.cwd(), backend: "pi", loadExtensions: false, pi: { command: process.execPath, rpcArgs: [fixture, "argv"] }, modelSelection: { id: "--extension" } })).rejects.toMatchObject({ code: "HARNESS_LAUNCH_INVALID" })
  })
})
