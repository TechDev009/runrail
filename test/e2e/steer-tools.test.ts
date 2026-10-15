import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"
import { ReplayBackend } from "@nifrajs/coding-agent"
import { createRunrailSessionController, type RunrailSessionController } from "../../src/control.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import type { CodexAppServerBackend } from "../../src/backend/codex-app-server.ts"
import { ConversationBuilder, transcriptEntry } from "../../src/conversation/index.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

const fixture = resolve(import.meta.dir, "../fixtures/codex-app-server.ts")
const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
const token = "control-steer-live-token-1234567890abcdef"
const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join("/tmp", `runrail-steer-${name}-`))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const base = { version: 1 as const, sessionId: "tool-fixture", at: 0 }

/**
 * A coding tool stand-in that takes guidance only while its tool runs, as Claude Code does. Its
 * tool waits for `release`.
 */
function toolThatSteers(options: { readonly steers?: boolean } = {}) {
  const inner = new ReplayBackend({
    events: [
      { ...base, seq: 0, type: "turn.started", turnId: "turn-1", prompt: "ping" },
      { ...base, seq: 1, type: "tool.started", turnId: "turn-1", callId: "call-1", name: "Bash", input: { command: "ping" } },
      { ...base, seq: 2, type: "tool.completed", turnId: "turn-1", callId: "call-1", name: "Bash", ok: true },
      { ...base, seq: 3, type: "assistant.message", turnId: "turn-1", text: "done" },
    ],
  })
  let running = false
  let release: () => void = () => undefined
  const steered: string[] = []
  const backend = {
    info: { ...inner.info, name: "tool" },
    createSession: (input: Parameters<AgentBackend["createSession"]>[0]) => inner.createSession(input),
    async *send(input: Parameters<AgentBackend["send"]>[0]) {
      for await (const event of inner.send(input)) {
        if (event.type === "tool.started") running = true
        if (event.type === "tool.completed") {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          running = false
        }
        yield event
      }
    },
    cancel: (sessionId: string, reason?: string) => inner.cancel(sessionId, reason),
    snapshot: (sessionId: string) => inner.snapshot(sessionId),
    reload: (sessionId: string) => inner.reload(sessionId),
    close: (sessionId: string) => inner.close(sessionId),
    ...(options.steers === false
      ? {}
      : {
          steer: (_sessionId: string, text: string): boolean => {
            if (!running) return false
            steered.push(text)
            return true
          },
        }),
  } as unknown as AgentBackend
  return { backend, steered, release: () => release() }
}

const adapter = (backend: AgentBackend) => ({ name: "tool", version: "1.0.0", capabilities: ["sessions"], create: () => backend })

/** Resolves when the controller publishes an event of `type`. */
function seen(controller: RunrailSessionController, type: AgentEvent["type"]): Promise<void> {
  return new Promise((resolve) => {
    const stop = controller.subscribe((event) => {
      if (event.type !== type) return
      stop()
      resolve()
    })
  })
}

describe("guidance for the running turn only (liveOnly)", () => {
  test("a tool that takes guidance while its tool runs: steered then, refused and not queued before or after", async () => {
    const cwd = await tempDir("tool")
    const tool = toolThatSteers()
    const controller = await createRunrailSessionController({ cwd, backend: "tool", adapter: adapter(tool.backend), loadExtensions: false })
    cleanup.push(() => controller.close("test complete"))
    expect(controller.session.canSteerLive).toBe(true)
    expect(await controller.steerLive("before the turn")).toBe(false)
    expect(controller.snapshot().queued).toBe(0)

    const toolStarted = seen(controller, "tool.started")
    const turn = controller.enqueue("ping")
    await toolStarted
    expect(await controller.steerLive("add BANANA")).toBe(true)
    // Attachments are never steering text.
    expect(await controller.steerLive({ text: "see this", attachments: [{ kind: "text", name: "a.txt", text: "x" }] } as never)).toBe(false)
    tool.release()
    await turn
    expect(tool.steered).toEqual(["add BANANA"])
    expect(await controller.steerLive("after the turn")).toBe(false)
    expect(controller.snapshot().queued).toBe(0)
  })

  test("over the RPC: the capability follows the backend, a non-boolean is refused, and a refusal answers at once", async () => {
    const serve = async (backend: AgentBackend) => {
      const cwd = await tempDir("rpc")
      const running = await startRunrailControlRpcServer({ cwd, backend: "tool", adapter: adapter(backend), authToken: token, loadExtensions: false })
      cleanup.push(() => running.handle.stop())
      const rpc = async (method: string, params: Record<string, unknown> = {}) => {
        const response = await fetch(`${running.handle.url}/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })
        return { status: response.status, body: await response.json() as { result?: Record<string, unknown>; error?: { code: string } } }
      }
      const status = ((await rpc("control.describe")).body.result as { capabilityStatus: Record<string, string> }).capabilityStatus["turn.steer.live"]
      return { rpc, status }
    }
    const steers = await serve(toolThatSteers().backend)
    expect(steers.status).toBe("available")
    expect(await steers.rpc("turn.steer", { message: "now", liveOnly: "yes" })).toMatchObject({ status: 400, body: { error: { code: "CONTROL_INVALID_INPUT" } } })
    expect(await steers.rpc("turn.steer", { message: "now", liveOnly: true })).toMatchObject({ status: 200, body: { result: { steered: false, events: [] } } })
    expect((await steers.rpc("turn.cancel")).body.result).toMatchObject({ active: false, queued: 0 })

    expect((await serve(toolThatSteers({ steers: false }).backend)).status).toBe("unavailable")
    const native = await tempDir("native")
    const controller = await createRunrailSessionController({ cwd: native, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) } })
    cleanup.push(() => controller.close("test complete"))
    expect(controller.session.canSteerLive).toBe(true)
  })
})

describe("steering Codex through its own turn/steer", () => {
  async function codex(mode: "steer" | "steer-stale") {
    const cwd = await tempDir("codex")
    const transcripts = await tempDir("codex-transcripts")
    const store = new FileTranscriptStore({ root: transcripts })
    const controller = await createRunrailSessionController({
      cwd,
      backend: "codex",
      loadExtensions: false,
      harnessCommand: process.execPath,
      harnessArgs: [fixture, mode],
      harnessProtocol: "app-server",
      verify: "check",
      verificationCommand: verifier,
      maxRepairAttempts: 0,
      transcriptStore: store,
      sessionId: "codex-steer",
    })
    cleanup.push(() => controller.close("test complete"))
    return { controller, store }
  }

  test("joins the running turn, is read after the running command, and is recorded there as a steer", async () => {
    const { controller, store } = await codex("steer")
    expect(controller.session.canSteerLive).toBe(true)
    expect(await controller.steerLive("before any turn")).toBe(false)
    const toolStarted = seen(controller, "tool.started")
    const turn = controller.enqueue("run the command")
    await toolStarted
    expect(await controller.steerLive("add BANANA")).toBe(true)
    const events = await turn
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "steered: add BANANA" }))
    expect(await controller.steerLive("after the turn")).toBe(false)
    expect(controller.snapshot().queued).toBe(0)
    // The backend itself refuses with no turn of its own running, before asking Codex.
    const backend = controller.session.backend as unknown as CodexAppServerBackend
    expect(await backend.steerAsync(controller.session.snapshot.id, "no turn")).toBe(false)

    const builder = new ConversationBuilder()
    for (const record of await store.read("codex-steer")) {
      const entry = transcriptEntry(record)
      if (entry !== undefined) builder.add(entry)
    }
    const items = builder.items().filter((item) => item.kind !== "notice")
    expect(items.map((item) => (item.kind === "user" ? `user:${item.text}${item.steer === true ? " (steer)" : ""}` : item.kind))).toEqual(["user:run the command", "tool", "user:add BANANA (steer)", "assistant"])
  })

  test("refused when Codex has moved to another turn: nothing queued with liveOnly, first in the queue without it", async () => {
    const { controller } = await codex("steer-stale")
    const toolStarted = seen(controller, "tool.started")
    const turn = controller.enqueue("run the command")
    await toolStarted
    expect(await controller.steerLive("add BANANA")).toBe(false)
    expect(controller.snapshot().queued).toBe(0)
    const queued = controller.steer("then this").catch((error: unknown) => error)
    while (controller.snapshot().queued === 0) await Bun.sleep(5)
    expect(controller.snapshot().queued).toBe(1)
    controller.cancel("test complete", true)
    await turn.catch(() => undefined)
    expect(await queued).toBeInstanceOf(Error)
  })
})
