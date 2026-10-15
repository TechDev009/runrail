import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { NativeApprovalPort, NativeMessage } from "@nifrajs/coding-agent"
import { RunrailSessionController } from "../../src/control.ts"
import { ConversationBuilder, transcriptEntry } from "../../src/conversation/index.ts"
import { createCallerCredentialResolver } from "../../src/index.ts"
import { createRunrailSession } from "../../src/session.ts"
import { place, SteeringModelPort } from "../../src/session/steer.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
const allow: NativeApprovalPort = { request: ({ signal }) => !signal.aborted }

type Body = Record<string, unknown>
type WireMessage = { readonly role: string; readonly content?: unknown; readonly tool_call_id?: string }

const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const sse = (lines: readonly unknown[]): string => lines.map((line) => typeof line === "string" ? line : `data: ${JSON.stringify(line)}\n\n`).join("")
const TOOL = sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_live_1", function: { name: "read_file", arguments: "{\"path\":\"notes.txt\"}" } }] } }] }, "data: [DONE]\n\n"])
const text = (value: string): string => sse([{ choices: [{ delta: { content: value } }] }, "data: [DONE]\n\n"])

/** Roles of a Chat request, with the text of each user message. */
function shape(body: Body): string[] {
  const words = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : ""
  return (body.messages as WireMessage[]).map((message) => message.role === "user" ? `user:${words(message.content)}` : message.role)
}

describe("placing a steer among the loop's messages", () => {
  const user: NativeMessage = { role: "user", text: "fix it" }
  const tool: NativeMessage = { role: "tool", name: "read_file", text: "body" }
  const answer: NativeMessage = { role: "assistant", text: "done" }

  test("goes after the message it followed, found by identity or by content, and is left out once that message is gone", () => {
    expect(place([user, tool, answer], [{ after: tool, text: "use tabs" }]).map((message) => message.text)).toEqual(["fix it", "body", "use tabs", "done"])
    // A copy of the message is the same message.
    expect(place([user, { ...tool }, answer], [{ after: tool, text: "use tabs" }]).map((message) => message.text)).toEqual(["fix it", "body", "use tabs", "done"])
    // Two steers on the same step keep their order.
    expect(place([user, tool], [{ after: tool, text: "a" }, { after: tool, text: "b" }]).map((message) => message.text)).toEqual(["fix it", "body", "a", "b"])
    // Compacted away: the steer is dropped rather than put somewhere it was not.
    expect(place([answer], [{ after: tool, text: "use tabs" }]).map((message) => message.text)).toEqual(["done"])
  })

  test("takes only text it can carry, and hands back what no step took", () => {
    const port = new SteeringModelPort({ complete: () => ({ type: "text", text: "ok" }) })
    expect(port.push("")).toBe(false)
    expect(port.push("x".repeat(64 * 1024 + 1))).toBe(false)
    expect(port.push("a\0b")).toBe(false)
    for (let index = 0; index < 16; index += 1) expect(port.push(`steer ${String(index)}`)).toBe(true)
    expect(port.push("one too many")).toBe(false)
    expect(port.takeUndelivered()).toHaveLength(16)
    expect(port.takeUndelivered()).toEqual([])
  })
})

describe("steering a running turn on a connected model", () => {
  test("joins the turn at the model's next step, stays in place, is recorded where it happened, and runs as the next turn when too late", async () => {
    const cwd = await realpath(await mkdtemp(join("/tmp", "runrail-steer-")))
    const transcripts = await mkdtemp(join("/tmp", "runrail-steer-transcripts-"))
    await writeFile(join(cwd, "notes.txt"), "fixture note\n")
    cleanup.push(() => rm(cwd, { recursive: true, force: true }), () => rm(transcripts, { recursive: true, force: true }))
    const bodies: Body[] = []
    // One request at a time can be held, so a steer is sent while the model is on that step.
    let hold = { at: 1, arrived: () => undefined as void, release: Promise.resolve() }
    const holdRequest = (at: number): { readonly arrived: Promise<void>; readonly release: () => void } => {
      let arrived: () => void = () => undefined
      let release: () => void = () => undefined
      const seen = new Promise<void>((resolve) => { arrived = resolve })
      hold = { at, arrived: () => arrived(), release: new Promise<void>((resolve) => { release = resolve }) }
      return { arrived: seen, release: () => release() }
    }
    const first = holdRequest(1)
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json() as Body
        bodies.push(body)
        if (bodies.length === hold.at) {
          hold.arrived()
          await hold.release
        }
        return new Response(bodies.length === 1 ? TOOL : text(`answer ${String(bodies.length)}`), { headers: { "content-type": "text/event-stream" } })
      },
    })
    cleanup.push(() => server.stop(true))
    const store = new FileTranscriptStore({ root: transcripts })
    const session = await createRunrailSession({
      cwd,
      backend: "native",
      approval: allow,
      verify: "check",
      verificationCommand: verifier,
      maxRepairAttempts: 0,
      loadExtensions: false,
      transcriptStore: store,
      sessionId: "steer-session",
      defaultSystemPrompt: false,
      provider: {
        provider: "custom-openai-chat",
        model: "fixture-model",
        maxOutputTokens: 1_024,
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        credential: { kind: "caller", account: "fixture" },
        credentialResolver: createCallerCredentialResolver(() => "fixture-secret"),
      },
    })
    const controller = new RunrailSessionController(session)
    cleanup.push(() => session.close())

    const turn = controller.enqueue("read the notes")
    await first.arrived
    // Mid-turn: accepted at once, with no turn of its own.
    expect(await controller.steer("prefer short answers")).toEqual([])
    first.release()
    await turn
    expect(bodies.map(shape)).toEqual([
      ["user:read the notes"],
      // The next step carries it after the tool result, before the model answers.
      ["user:read the notes", "assistant", "tool", "user:prefer short answers"],
    ])

    // The next turn still has it in the same place.
    await controller.enqueue("thanks")
    expect(shape(bodies[2]!)).toEqual(["user:read the notes", "assistant", "tool", "user:prefer short answers", "assistant", "user:thanks"])

    // Recorded where the model first read it, and marked as a steer when the thread is read back.
    const builder = new ConversationBuilder()
    for (const record of await store.read("steer-session")) {
      const entry = transcriptEntry(record)
      if (entry !== undefined) builder.add(entry)
    }
    const items = builder.items().filter((item) => item.kind !== "notice")
    expect(items.map((item) => item.kind === "user" ? `user:${item.text}${item.steer === true ? " (steer)" : ""}` : item.kind)).toEqual(["user:read the notes", "tool", "user:prefer short answers (steer)", "assistant", "user:thanks", "assistant"])

    // Sent while the model writes its last step, no step is left to read it: it runs as the next turn.
    const last = holdRequest(bodies.length + 1)
    const late = controller.enqueue("one more")
    await last.arrived
    expect(await controller.steer("and then this")).toEqual([])
    last.release()
    await late
    await controller.whenIdle()
    expect(shape(bodies.at(-2)!)).not.toContain("user:and then this")
    expect(shape(bodies.at(-1)!).at(-1)).toBe("user:and then this")
  })
})
