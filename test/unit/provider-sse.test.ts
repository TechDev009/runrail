import { describe, expect, test } from "bun:test"
import { decodeSse, ProviderError } from "../../src/index.ts"

async function* chunks(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value
}

describe("provider SSE decoder", () => {
  test("handles split UTF-8 framing, CRLF, comments, and done markers", async () => {
    const events = []
    for await (const event of decodeSse(chunks([": ping\r\n", "event: message\r\n", "data: {\"a\":", "1}\r\n", "data: next\r\n\r\n", "data: [DONE]\r\n\r\n"]))) events.push(event)
    expect(events).toEqual([
      { event: "message", data: "{\"a\":1}\nnext" },
      { data: "", done: true },
    ])
  })

  test("a CRLF split between chunks ends one line, not two", async () => {
    const events = []
    for await (const event of decodeSse(chunks(["data: one\r", "\ndata: two\r", "\n\r", "\ndata: three\r\n\r"]))) events.push(event)
    expect(events).toEqual([{ data: "one\ntwo" }, { data: "three" }])
  })

  test("rejects oversized lines and malformed JSON through the JSON helper", async () => {
    await expect((async () => {
      for await (const _event of decodeSse(chunks([`data: ${"x".repeat(32)}\n\n`]), { maxLineBytes: 8 })) {}
    })()).rejects.toMatchObject({ code: "PROVIDER_STREAM_FAILED" })
    await expect((async () => {
      const { collectSseJson } = await import("../../src/providers/sse.ts")
      await collectSseJson(chunks(["data: not-json\n\n"]), (value) => value)
    })()).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" })
    expect(ProviderError).toBeDefined()
  })

  test("honors cancellation before consuming another chunk", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect((async () => {
      for await (const _event of decodeSse(chunks(["data: x\n\n"]), { signal: controller.signal })) {}
    })()).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" })
  })
})
