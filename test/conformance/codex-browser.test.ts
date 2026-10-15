import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { BrowserBridge, type BrowserRequestFrame } from "../../src/browser/bridge.ts"
import { BROWSER_TOOL_SPECS } from "../../src/browser/tools.ts"
import { createConnectorRegistry } from "../../src/connectors/registry.ts"
import { grantedConnectorTools } from "../../src/connectors/tools.ts"
import { CodexAppServerBackend, createFileVendorSessionStore } from "../../src/index.ts"
import type { RunrailLiveFrameInput } from "../../src/live/types.ts"

const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname
let state: string

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "runrail-codex-browser-"))
})

afterAll(async () => {
  await rm(state, { recursive: true, force: true })
})

async function turn(backend: CodexAppServerBackend, sessionId: string): Promise<{ events: AgentEvent[]; answer: { method: string; tools: string[]; result: { success: boolean; contentItems: Record<string, string>[] } } }> {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message: "look at the app" })) events.push(event)
  const message = events.find((event) => event.type === "assistant.message")
  if (message?.type !== "assistant.message") throw new Error("the fixture gave no answer")
  return { events, answer: JSON.parse(message.text) }
}

/** A desktop that answers every screenshot with a tiny image. */
function desktop(): { bridge: BrowserBridge; frames: BrowserRequestFrame[] } {
  const frames: BrowserRequestFrame[] = []
  const bridge: BrowserBridge = new BrowserBridge({
    anySite: false,
    emit: (frame) => {
      frames.push(frame)
      queueMicrotask(() => {
        bridge.take(frame.requestId)
        bridge.respond(frame.requestId, { ok: true, result: { text: "", image: { mediaType: "image/jpeg", dataBase64: "QUJD" } } })
      })
    },
  })
  return { bridge, frames }
}

test("a new Codex thread starts with the browser tools, and a screenshot comes back as an image", async () => {
  const { bridge, frames } = desktop()
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "browser"], browser: bridge, browserThreads: createFileVendorSessionStore(state, "codex.browser"), vendorSessions: createFileVendorSessionStore(state, "codex") })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-browser-new" })
  const { events, answer } = await turn(backend, session.id)
  expect(answer.method).toBe("thread/start")
  expect(answer.tools).toEqual(BROWSER_TOOL_SPECS.map((spec) => spec.name))
  expect(answer.result).toEqual({ success: true, contentItems: [{ type: "inputText", text: "Done." }, { type: "inputImage", imageUrl: "data:image/jpeg;base64,QUJD" }] })
  expect(frames).toHaveLength(1)
  expect(events.find((event) => event.type === "tool.started")).toMatchObject({ name: "browser_screenshot" })
  expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ name: "browser_screenshot", ok: true })
  expect(await createFileVendorSessionStore(state, "codex.browser").load(session.id)).toBe("fixture-codex-thread")
  await backend.close(session.id)
})

test("a tool call that names another thread is refused without touching the browser", async () => {
  const { bridge, frames } = desktop()
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "browser-foreign"], browser: bridge, browserThreads: createFileVendorSessionStore(state, "codex.browser-foreign") })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-browser-foreign" })
  const { answer } = await turn(backend, session.id)
  expect(answer.result).toEqual({ success: false, contentItems: [{ type: "inputText", text: "This tool call is not part of the running turn." }] })
  expect(frames).toHaveLength(0)
  await backend.close(session.id)
})

test("with browser use off, a thread that has the tools hears that it is off", async () => {
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "browser"] })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-browser-off" })
  const { answer, events } = await turn(backend, session.id)
  expect(answer.tools).toEqual([])
  expect(answer.result.success).toBe(false)
  expect(answer.result.contentItems[0]?.text).toContain("turned off browser use")
  expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ ok: false })
  await backend.close(session.id)
})

test("a conversation that started without the tools tells the desktop it cannot use them", async () => {
  const vendorSessions = createFileVendorSessionStore(state, "codex")
  const first = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "normal"], vendorSessions })
  const opened = await first.createSession({ cwd: "/tmp", sessionId: "codex-browser-late" })
  for await (const _ of first.send({ sessionId: opened.id, message: "hello" })) void _
  await first.close(opened.id)

  const live: RunrailLiveFrameInput[] = []
  const { bridge } = desktop()
  const second = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "normal"], vendorSessions, browser: bridge, browserThreads: createFileVendorSessionStore(state, "codex.browser"), onLive: (frame) => live.push(frame) })
  const resumed = await second.createSession({ cwd: "/tmp", sessionId: "codex-browser-late" })
  for await (const _ of second.send({ sessionId: resumed.id, message: "now look" })) void _
  expect(live).toContainEqual({ type: "browser.notice", code: "BROWSER_TOOLS_UNAVAILABLE" })
  await second.close(resumed.id)
})

test("a bridge of the wrong kind is refused", () => {
  expect(() => new CodexAppServerBackend({ browser: {} as BrowserBridge })).toThrow("browser bridge is invalid")
})

test("a Codex thread starts with the connector tools its grants allow unasked, and a call reaches the connector", async () => {
  const calls: unknown[] = []
  const registry = createConnectorRegistry([{ descriptor: { id: "slack", version: "1.0.0", capabilities: ["connector.read", "connector.notify"] }, actions: [
    { name: "listChannels", description: "List channels.", kind: "read", capabilities: ["connector.read"], execute: (input) => (calls.push(input), { channels: [{ id: "C1", name: "general" }] }) },
    { name: "sendMessage", description: "Send a message.", kind: "notify", capabilities: ["connector.notify"], execute: () => ({ ok: true }) },
  ] }])
  // Write grants both, but sending asks first, and Codex cannot ask before a dynamic tool runs.
  const tools = grantedConnectorTools(registry, { slack: "write" }).filter((tool) => !tool.approval)
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "connector"], connectors: { registry, tools } })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-connector" })
  const { events, answer } = await turn(backend, session.id)
  expect(answer.tools).toEqual(["slack_listChannels"])
  expect(answer.result).toEqual({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ channels: [{ id: "C1", name: "general" }] }) }] })
  expect(calls).toEqual([{ limit: 1 }])
  expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ ok: true })
  await backend.close(session.id)
})
