import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createCallerCredentialResolver, createRunrailSession } from "../../src/index.ts"

const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")

test("a native turn runs well past a handful of tool calls by default", async () => {
  const calls = 12
  let served = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.json()
      served += 1
      const chunk = served <= calls
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${String(served)}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }] }, finish_reason: "tool_calls" }] }
        : { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const cwd = mkdtempSync(join(tmpdir(), "runrail-steps-"))
  writeFileSync(join(cwd, "a.txt"), "hello\n")
  const session = await createRunrailSession({
    cwd,
    backend: "native",
    verify: "check",
    verificationCommand: verifier,
    maxRepairAttempts: 0,
    loadExtensions: false,
    provider: {
      provider: "custom-openai-chat",
      model: "fixture-model",
      maxOutputTokens: 1_024,
      endpoint: `http://127.0.0.1:${server.port}/v1`,
      credential: { kind: "caller", account: "fixture" },
      credentialResolver: createCallerCredentialResolver(() => "fixture-secret"),
    },
  })
  try {
    const types: string[] = []
    for await (const event of session.prompt("read it many times")) types.push(event.type)
    expect(types.filter((type) => type === "tool.completed")).toHaveLength(calls)
    expect(types).toContain("session.completed")
    expect(types).not.toContain("session.failed")
  } finally {
    await session.close()
    await server.stop(true)
    rmSync(cwd, { recursive: true, force: true })
  }
})
