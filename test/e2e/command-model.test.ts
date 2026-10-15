import { describe, expect, test } from "bun:test"
import { CommandContentModelPort, CommandModelPort } from "../../src/model/command.ts"

describe("JSONL command model adapter", () => {
  test("streams a typed response and filters credential environment", async () => {
    const script = `let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { console.log(JSON.stringify({ type: "text_delta", text: "hello" })); console.log(JSON.stringify({ type: "response", response: { type: "text", text: process.env.RUNRAIL_SECRET || "safe" } })); })`
    const port = new CommandModelPort({ command: process.execPath, args: ["-e", script] })
    const chunks = []
    for await (const chunk of port.complete({
      sessionId: "s",
      cwd: "/tmp",
      messages: [{ role: "user", text: "hello" }],
      tools: [],
      signal: new AbortController().signal,
    })) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "response", response: { type: "text", text: "safe" } },
    ])
  })

  test("passes canonical content parts to the caller-owned process", async () => {
    const script = `process.stdin.on("data", chunk => { const request = JSON.parse(String(chunk)); console.log(JSON.stringify({ type: "text", text: request.parts?.some(part => part.kind === "image") ? "parts-present" : "parts-missing" })) })`
    const port = new CommandContentModelPort({ command: process.execPath, args: ["-e", script] })
    const chunks = []
    for await (const chunk of port.complete({
      sessionId: "s",
      cwd: "/tmp",
      messages: [{ role: "user", text: "review" }],
      tools: [],
      parts: [
        { kind: "text", text: "review" },
        { kind: "image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=", bytes: 8 },
      ],
      signal: new AbortController().signal,
    })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: "response", response: { type: "text", text: "parts-present" } })
  })
})
