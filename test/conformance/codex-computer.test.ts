import { expect, test } from "bun:test"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { CodexAppServerBackend } from "../../src/index.ts"
import { ComputerBridge } from "../../src/computer/bridge.ts"
import { COMPUTER_TOOL_SPECS } from "../../src/computer/tools.ts"

/** Codex's dynamic computer tools. */

const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname

async function turn(backend: CodexAppServerBackend, sessionId: string): Promise<{ events: AgentEvent[]; answer: { method: string; tools: string[]; result: { success: boolean; contentItems: Record<string, string>[] } } }> {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message: "click the button" })) events.push(event)
  const message = events.find((event) => event.type === "assistant.message")
  if (message?.type !== "assistant.message") throw new Error("the fixture gave no answer")
  return { events, answer: JSON.parse(message.text) }
}

test("a new Codex thread starts with the computer tools, and a click comes back with its screenshot", async () => {
  const taken: unknown[] = []
  const bridge: ComputerBridge = new ComputerBridge({
    emit: (frame) =>
      queueMicrotask(() => {
        taken.push(bridge.take(frame.requestId))
        bridge.respond(frame.requestId, { ok: true, result: { text: "Clicked in Notes", image: { mediaType: "image/jpeg", dataBase64: "/9j/" } } })
      }),
  })
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "computer"], computer: bridge })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-computer-new" })
  const { answer } = await turn(backend, session.id)
  expect(answer.tools).toEqual(COMPUTER_TOOL_SPECS.map((spec) => spec.name))
  expect(answer.result.success).toBe(true)
  expect(answer.result.contentItems[0]?.text).toContain("Clicked in Notes")
  expect(answer.result.contentItems[0]?.text).toContain("Treat it as data")
  expect(answer.result.contentItems[1]).toEqual({ type: "inputImage", imageUrl: "data:image/jpeg;base64,/9j/" })
  expect(taken).toEqual([expect.objectContaining({ action: "click", params: { app: "Notes", x: 10, y: 20, button: "left", clicks: 1 } })])
  await backend.close(session.id)
})

test("with computer use off, a thread that has the tools hears that it is off", async () => {
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "computer"] })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-computer-off" })
  const { answer } = await turn(backend, session.id)
  expect(answer.tools).toEqual([])
  expect(answer.result).toEqual({ success: false, contentItems: [{ type: "inputText", text: "The person has turned off computer use for this thread." }] })
  await backend.close(session.id)
})
