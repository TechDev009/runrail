import { expect, test } from "bun:test"
import { FallbackModelPort } from "../../src/model/fallback.ts"

test("fallback model retries a failed decision before any tool response", async () => {
  let primaryCalls = 0
  let fallbackCalls = 0
  const port = new FallbackModelPort(
    { complete: () => { primaryCalls += 1; throw new Error("primary unavailable") } },
    { complete: () => { fallbackCalls += 1; return { type: "tool", name: "read_file", input: { path: "index.ts" } } } },
  )
  const chunks = []
  for await (const chunk of port.complete({
    sessionId: "s",
    cwd: "/tmp",
    messages: [{ role: "user", text: "inspect" }],
    tools: [],
    signal: new AbortController().signal,
  })) chunks.push(chunk)
  expect(chunks).toEqual([{ type: "response", response: { type: "tool", name: "read_file", input: { path: "index.ts" } } }])
  expect({ primaryCalls, fallbackCalls }).toEqual({ primaryCalls: 1, fallbackCalls: 1 })
})
