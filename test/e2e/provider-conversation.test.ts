import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { NativeApprovalPort } from "@nifrajs/coding-agent"
import { createCallerCredentialResolver } from "../../src/index.ts"
import { createRunrailSession } from "../../src/session.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")
const allow: NativeApprovalPort = { request: ({ signal }) => !signal.aborted }
const NOTE = "fixture note 42"

type Protocol = "chat" | "responses" | "messages"
type Body = Record<string, unknown>

const PRESET: Readonly<Record<Protocol, string>> = { chat: "custom-openai-chat", responses: "custom-openai-responses", messages: "custom-anthropic" }

const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const sse = (lines: readonly unknown[]): string => lines.map((line) => typeof line === "string" ? line : `data: ${JSON.stringify(line)}\n\n`).join("")
const named = (value: Record<string, unknown>): string => `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`

/** The provider's reply: a `read_file` call on the first request of a script, text afterwards. */
function reply(protocol: Protocol, kind: "tool" | "text", text: string): string {
  if (protocol === "chat") {
    return kind === "tool"
      ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_live_1", function: { name: "read_file", arguments: "{\"path\":\"notes.txt\"}" } }] } }] }, "data: [DONE]\n\n"])
      : sse([{ choices: [{ delta: { content: text } }] }, "data: [DONE]\n\n"])
  }
  if (protocol === "responses") {
    return kind === "tool"
      ? sse([
          { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ type: "summary_text", text: "look at the notes" }], encrypted_content: "sealed-fixture-1" } },
          { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_live_1", name: "read_file" } },
          { type: "response.function_call_arguments.delta", output_index: 1, delta: "{\"path\":\"notes.txt\"}" },
          { type: "response.completed", response: { status: "completed" } },
        ])
      : sse([{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response: { status: "completed" } }])
  }
  return kind === "tool"
    ? [
        named({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_live_1", name: "read_file", input: {} } }),
        named({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"notes.txt\"}" } }),
        named({ type: "message_stop" }),
      ].join("")
    : [named({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }), named({ type: "message_stop" })].join("")
}

interface Desk {
  readonly cwd: string
  readonly bodies: Body[]
  /** Replies still to send, in order; after the last, the provider answers "ok". */
  readonly script: ("tool" | string)[]
  session(sessionId: string, extra?: Record<string, unknown>): ReturnType<typeof createRunrailSession>
}

async function desk(protocol: Protocol): Promise<Desk> {
  const cwd = await realpath(await mkdtemp(join("/tmp", `runrail-conversation-${protocol}-`)))
  const transcripts = await mkdtemp(join("/tmp", `runrail-conversation-${protocol}-transcripts-`))
  await writeFile(join(cwd, "notes.txt"), `${NOTE}\n`)
  const bodies: Body[] = []
  const script: ("tool" | string)[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      bodies.push(await request.json() as Body)
      const next = script.shift() ?? "ok"
      return new Response(reply(protocol, next === "tool" ? "tool" : "text", next), { headers: { "content-type": "text/event-stream" } })
    },
  })
  cleanup.push(() => server.stop(true), () => rm(cwd, { recursive: true, force: true }), () => rm(transcripts, { recursive: true, force: true }))
  const store = new FileTranscriptStore({ root: transcripts })
  return {
    cwd,
    bodies,
    script,
    session: (sessionId, extra = {}) => createRunrailSession({
      cwd,
      backend: "native",
      approval: allow,
      verify: "check",
      verificationCommand: verifier,
      loadExtensions: false,
      transcriptStore: store,
      sessionId,
      provider: {
        provider: PRESET[protocol],
        model: protocol === "messages" ? "claude-fixture" : "fixture-model",
        maxOutputTokens: 1_024,
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        credential: { kind: "caller", account: "fixture" },
        credentialResolver: createCallerCredentialResolver(() => "fixture-secret"),
        thinking: protocol === "responses" ? "high" : "off",
      },
      ...extra,
    }),
  }
}

async function turn(session: Awaited<ReturnType<typeof createRunrailSession>>, prompt: string): Promise<void> {
  const events = []
  for await (const event of session.prompt(prompt)) events.push(event)
  const failed = events.find((event) => event.type === "session.failed")
  if (failed !== undefined) throw new Error(`turn failed: ${JSON.stringify(failed)}`)
}

/** The system prompt a request carried, in whichever field its protocol uses. */
function systemOf(protocol: Protocol, body: Body): string | undefined {
  if (protocol === "responses") return typeof body.instructions === "string" ? body.instructions : undefined
  if (protocol === "chat") {
    const first = (body.messages as Body[])[0]
    return first?.role === "system" ? String(first.content) : undefined
  }
  const system = body.system as { text: string }[] | undefined
  return system?.map((block) => block.text).join("")
}

/** The tool call and its result as the request sent them, keyed by call id. */
function toolPairs(protocol: Protocol, body: Body): { id: string; name: string; input: unknown; result: string }[] {
  const pairs: { id: string; name: string; input: unknown; result: string }[] = []
  if (protocol === "chat") {
    const messages = body.messages as Body[]
    for (const message of messages) {
      for (const call of (message.tool_calls as Body[] | undefined) ?? []) {
        const fn = call.function as Body
        const result = messages.find((other) => other.role === "tool" && other.tool_call_id === call.id)
        pairs.push({ id: String(call.id), name: String(fn.name), input: JSON.parse(String(fn.arguments)), result: String(result?.content) })
      }
    }
  } else if (protocol === "responses") {
    const input = body.input as Body[]
    for (const item of input) {
      if (item.type !== "function_call") continue
      const result = input.find((other) => other.type === "function_call_output" && other.call_id === item.call_id)
      pairs.push({ id: String(item.call_id), name: String(item.name), input: JSON.parse(String(item.arguments)), result: String(result?.output) })
    }
  } else {
    const messages = body.messages as { role: string; content: string | Body[] }[]
    const blocks = messages.flatMap((message) => typeof message.content === "string" ? [] : message.content)
    for (const block of blocks) {
      if (block.type !== "tool_use") continue
      const result = blocks.find((other) => other.type === "tool_result" && other.tool_use_id === block.id)
      const content = result?.content
      pairs.push({ id: String(block.id), name: String(block.name), input: block.input, result: typeof content === "string" ? content : JSON.stringify(content) })
    }
  }
  return pairs
}

function userTexts(protocol: Protocol, body: Body): string[] {
  if (protocol === "responses") return (body.input as Body[]).filter((item) => item.role === "user").map((item) => JSON.stringify(item.content))
  const messages = body.messages as { role: string; content: unknown }[]
  return messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content))
}

describe("provider conversations carry earlier tool calls forward", () => {
  for (const protocol of ["chat", "responses", "messages"] as const) {
    test(`${protocol}: turn 2 holds turn 1's call and result, and the default instructions`, async () => {
      const d = await desk(protocol)
      d.script.push("tool", "I read the notes.", "Second answer.")
      const session = await d.session(`conv-${protocol}`)
      try {
        await turn(session, "first question")
        await turn(session, "second question")
      } finally {
        await session.stop("test complete")
      }
      // Turn 1: the call, then the request that carries its result. Turn 2 starts at the third.
      expect(d.bodies.length).toBeGreaterThanOrEqual(3)
      const second = d.bodies[2]!
      const liveId = protocol === "messages" ? "toolu_live_1" : "call_live_1"
      const pairs = toolPairs(protocol, second)
      expect(pairs).toHaveLength(1)
      expect(pairs[0]).toMatchObject({ id: liveId, name: "read_file", input: { path: "notes.txt" } })
      expect(pairs[0]!.result).toContain(NOTE)
      const asked = userTexts(protocol, second)
      expect(asked.some((text) => text.includes("first question"))).toBe(true)
      expect(asked.at(-1)).toContain("second question")

      // No instructions were given, so every request carries the default ones.
      for (const body of d.bodies) {
        const system = systemOf(protocol, body)
        expect(system).toContain("You are Runrail")
        expect(system).toContain(`Working folder: ${d.cwd}`)
      }

      if (protocol === "responses") {
        // Plan tokens refuse stored responses: nothing is kept on the provider, and the sealed
        // reasoning of turn 1 goes back in front of its call.
        expect(second).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] })
        const input = second.input as Body[]
        const reasoning = input.findIndex((item) => item.type === "reasoning")
        expect(input[reasoning]).toMatchObject({ encrypted_content: "sealed-fixture-1" })
        expect(input[reasoning + 1]).toMatchObject({ type: "function_call", call_id: "call_live_1" })
      }
      if (protocol === "messages") {
        const system = second.system as Body[]
        expect(system[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } })
      }
    })

    test(`${protocol}: a restarted session rebuilds the call from the transcript`, async () => {
      const d = await desk(protocol)
      d.script.push("tool", "I read the notes.")
      const first = await d.session(`restart-${protocol}`)
      try {
        await turn(first, "first question")
      } finally {
        await first.stop("test complete")
      }
      const before = d.bodies.length
      d.script.push("After the restart.")
      const again = await d.session(`restart-${protocol}`)
      try {
        await turn(again, "after restart")
      } finally {
        await again.stop("test complete")
      }
      const body = d.bodies[before]!
      const restoredId = protocol === "messages" ? "toolu_restored_0" : "call_restored_0"
      const pairs = toolPairs(protocol, body)
      expect(pairs).toHaveLength(1)
      expect(pairs[0]).toMatchObject({ id: restoredId, name: "read_file", input: { path: "notes.txt" } })
      expect(pairs[0]!.result).toContain(NOTE)
      const asked = userTexts(protocol, body)
      expect(asked[0]).toContain("first question")
      expect(asked.at(-1)).toContain("after restart")
      expect(JSON.stringify(body)).toContain("I read the notes.")
      // Sealed reasoning lives only in the process that received it; it is not written down.
      expect(JSON.stringify(body)).not.toContain("sealed-fixture-1")
    })
  }

  test("project instructions follow the default; turning the default off keeps only them", async () => {
    const d = await desk("chat")
    await writeFile(join(d.cwd, "AGENTS.md"), "Always answer in haiku.\n")
    const on = await d.session("prompt-on")
    try {
      await turn(on, "hello")
    } finally {
      await on.stop("test complete")
    }
    const withDefault = systemOf("chat", d.bodies[0]!)!
    expect(withDefault.indexOf("You are Runrail")).toBe(0)
    expect(withDefault.indexOf("# Project context")).toBeGreaterThan(withDefault.indexOf("# Environment"))
    expect(withDefault).toContain("Always answer in haiku.")

    const off = await d.session("prompt-off", { defaultSystemPrompt: false })
    try {
      await turn(off, "hello")
    } finally {
      await off.stop("test complete")
    }
    const without = systemOf("chat", d.bodies[1]!)!
    expect(without).not.toContain("You are Runrail")
    expect(without).toContain("Always answer in haiku.")
  })
})
