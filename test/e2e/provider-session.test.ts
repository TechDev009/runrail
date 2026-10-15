import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import type { NativeApprovalPort } from "@nifrajs/coding-agent"
import { runRunrail, createCallerCredentialResolver } from "../../src/index.ts"

const project = resolve(import.meta.dir, "../fixtures/repair-project")
const verifier = resolve(import.meta.dir, "../fixtures/local-typecheck-verifier")
const allowLocalToolApproval: NativeApprovalPort = { request: ({ signal }) => !signal.aborted }

describe("native first-party provider session", () => {
  test("runs a local OpenAI-compatible provider through tools and verification", async () => {
    const cwd = await mkdtemp("/tmp/runrail-provider-session-")
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests += 1
        const body = await request.json() as { readonly model?: string; readonly tools?: readonly unknown[] }
        expect(body.model).toBe("fixture-model")
        if (requests === 1) {
          const input = { path: "index.ts", content: "const answer: number = 42\n\nexport { answer }\n" }
          const argumentsText = JSON.stringify(input)
          const stream = [
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "apply_patch", arguments: argumentsText } }] } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 10, total_tokens: 18 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join("")
          return new Response(stream, { headers: { "content-type": "text/event-stream" } })
        }
        return new Response(["data: {\"choices\":[{\"delta\":{\"content\":\"verified\"}}]}\n\n", "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      await cp(project, cwd, { recursive: true })
      const result = await runRunrail({
        cwd,
        backend: "native",
        approval: allowLocalToolApproval,
        verificationCommand: verifier,
        provider: {
          provider: "openai-compatible",
          model: "fixture-model",
          endpoint: server.url.toString(),
          credential: { kind: "caller", account: "fixture" },
          credentialResolver: createCallerCredentialResolver(() => "fixture-secret"),
          thinking: "off",
        },
      })
      expect(result.status).toBe("succeeded")
      expect(result.events.some((event) => event.type === "tool.completed" && event.tool === "apply_patch")).toBe(true)
      expect(result.events.some((event) => event.type === "verification.completed" && event.ok === true)).toBe(true)
      expect(result.usage?.inputTokens).toBeGreaterThanOrEqual(8)
      expect(result.usage?.outputTokens).toBeGreaterThanOrEqual(10)
      expect(await readFile(resolve(cwd, "index.ts"), "utf8")).toContain("const answer: number = 42")
    } finally {
      await server.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
