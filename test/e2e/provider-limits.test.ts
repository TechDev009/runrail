import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createCallerCredentialResolver, createRunrailSession } from "../../src/index.ts"
import type { AgentEvent } from "@nifrajs/agent-protocol"

test.each(["openai", "anthropic", "openai-compatible", "xai"] as const)("native %s ends a quota rejection without retrying or asking for sign-in", async (provider) => {
  const cwd = await mkdtemp("/tmp/runrail-provider-quota-")
  let requests = 0
  const server = Bun.serve({ port: 0, fetch: () => { requests += 1; return Response.json({ error: { type: "insufficient_quota", message: "Weekly quota exhausted: sk-must-not-leak" } }, { status: 429 }) } })
  const session = await createRunrailSession({ cwd, backend: "native", loadExtensions: false, verifyAfterTurn: false, provider: { provider, model: "fixture-model", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret") } })
  try {
    const events: AgentEvent[] = []
    for await (const event of session.prompt("hello")) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "session.failed", error: { code: "NATIVE_TURN_FAILED", message: expect.stringContaining("limit") } })
    expect(JSON.stringify(events)).not.toContain("sk-must-not-leak")
    expect(requests).toBe(1)
  } finally {
    await session.close()
    await server.stop()
    await rm(cwd, { recursive: true, force: true })
  }
})

test.each([
  { provider: "openai", protocol: "responses", frame: { type: "response.failed", response: { status: "failed", error: { code: "insufficient_quota", message: "sk-must-not-leak" } } } },
  { provider: "anthropic", protocol: "messages", frame: { type: "error", error: { type: "rate_limit_error", message: "sk-must-not-leak" } } },
  { provider: "openai-compatible", protocol: "chat", frame: { error: { code: "rate_limit_exceeded", message: "sk-must-not-leak" } } },
  { provider: "xai", protocol: "chat", frame: { error: { code: "too_many_requests", message: "sk-must-not-leak" } } },
] as const)("a native provider's streamed quota error ends with a quota message: %j", async ({ provider, protocol, frame }) => {
  const cwd = await mkdtemp("/tmp/runrail-provider-stream-quota-")
  const server = Bun.serve({ port: 0, fetch: () => new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "content-type": "text/event-stream" } }) })
  const session = await createRunrailSession({ cwd, backend: "native", loadExtensions: false, verifyAfterTurn: false, provider: { provider, protocol, model: "fixture-model", endpoint: server.url.toString(), credential: { kind: "caller", account: "fixture" }, credentialResolver: createCallerCredentialResolver(() => "fixture-secret") } })
  try {
    const events: AgentEvent[] = []
    for await (const event of session.prompt("hello")) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "session.failed", error: { message: expect.stringContaining("usage limit reached") } })
    expect(JSON.stringify(events)).not.toContain("sk-must-not-leak")
  } finally {
    await session.close()
    await server.stop()
    await rm(cwd, { recursive: true, force: true })
  }
})
