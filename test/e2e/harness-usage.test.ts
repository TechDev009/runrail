import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { createCallerCredentialResolver, createRunrailSession, type RunrailLiveFrameInput } from "../../src/index.ts"

const fixture = resolve(import.meta.dir, "../fixtures/usage-harness.ts")
const verifier = resolve(import.meta.dir, "../fixtures/env-verifier")

async function turnTokens(backend: "claude-code" | "codex", turns: number): Promise<unknown> {
  const session = await createRunrailSession({ cwd: "/tmp", backend, loadExtensions: false, harnessCommand: "bun", harnessArgs: ["run", fixture, backend === "codex" ? "codex" : "claude"], harnessProtocol: backend === "codex" ? "jsonl" : undefined, verify: "check", verificationCommand: verifier, maxRepairAttempts: 0 })
  try {
    for (let turn = 0; turn < turns; turn += 1) for await (const _event of session.prompt("go")) { /* drain */ }
    const { inputTokens, outputTokens } = session.metrics!.snapshot()
    return { inputTokens, outputTokens }
  } finally {
    await session.close()
  }
}

describe("token usage from coding tools", () => {
  test("Claude Code turns count their cached prompt tokens as input, as a connected Anthropic model does", async () => {
    expect(await turnTokens("claude-code", 2)).toEqual({ inputTokens: 2_000, outputTokens: 60 })
  })

  test("Codex turns count input as Codex reports it, cached part included", async () => {
    expect(await turnTokens("codex", 1)).toEqual({ inputTokens: 1_200, outputTokens: 40 })
  })

  test("a coding tool's turns count their tool calls and working time, which no model port saw", async () => {
    const appServer = resolve(import.meta.dir, "../fixtures/codex-app-server.ts")
    const session = await createRunrailSession({ cwd: "/tmp", backend: "codex", loadExtensions: false, harnessCommand: process.execPath, harnessArgs: [appServer, "approval"], harnessProtocol: "app-server", verify: "check", verificationCommand: verifier, maxRepairAttempts: 0 })
    try {
      for await (const event of session.prompt("go")) if (event.type === "approval.required") await session.resolveApproval(event.approvalId, true)
      const { toolCalls, elapsedMs } = session.metrics!.snapshot()
      expect(toolCalls).toBe(1)
      expect(elapsedMs).toBeGreaterThan(0)
    } finally {
      await session.close()
    }
  })
})

describe("a connected model's session", () => {
  test("shows its tokens while it runs, and a refused reasoning level reaches the live stream once", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json() as Record<string, unknown>
        bodies.push(body)
        if (body.reasoning_effort !== undefined) return Response.json({ error: { message: "unsupported parameter" } }, { status: 400 })
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const live: RunrailLiveFrameInput[] = []
    const session = await createRunrailSession({
      cwd: "/tmp",
      backend: "native",
      verify: "check",
      verificationCommand: verifier,
      maxRepairAttempts: 0,
      loadExtensions: false,
      onLive: (frame) => live.push(frame),
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
      for (let turn = 0; turn < 2; turn += 1) for await (const _event of session.prompt("go")) { /* drain */ }
      expect(session.metrics!.snapshot()).toMatchObject({ inputTokens: 240, outputTokens: 14 })
      expect(bodies.map((body) => body.reasoning_effort ?? null)).toEqual(["medium", null, null])
      expect(live.filter((frame) => frame.type === "model.notice")).toEqual([{ type: "model.notice", code: "THINKING_REFUSED", thinking: "medium" }])
      // Each answered request reports how full the context was, from the provider's own counts.
      expect(live.filter((frame) => frame.type === "context.usage")).toEqual([
        expect.objectContaining({ usedTokens: 127, estimated: false }),
        expect.objectContaining({ usedTokens: 127, estimated: false }),
      ])
    } finally {
      await session.close()
      await server.stop(true)
    }
  })
})
