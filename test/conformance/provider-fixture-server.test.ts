import { describe, expect, test } from "bun:test"
import { createProviderFixtureServer } from "../../examples/provider-fixtures/server.ts"
import { createAnthropicModelPort, createCallerCredentialResolver, createOpenAIModelPort, discoverProviderModels } from "../../src/index.ts"
import type { NativeModelChunk } from "@nifrajs/coding-agent"
import type { RunrailContentModelRequest } from "../../src/model/content.ts"

const request: RunrailContentModelRequest = {
  sessionId: "provider-fixture-server",
  cwd: process.cwd(),
  messages: [{ role: "user", text: "fixture" }],
  tools: [],
  parts: [],
  signal: new AbortController().signal,
}

async function collect(source: AsyncIterable<NativeModelChunk>): Promise<readonly NativeModelChunk[]> {
  const chunks: NativeModelChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

describe("runnable provider fixture server", () => {
  test("serves discovery, OpenAI Responses/Chat, and Anthropic Messages locally", async () => {
    const fixture = createProviderFixtureServer()
    try {
      const credentialResolver = createCallerCredentialResolver(() => "fixture")
      const reference = { kind: "caller" as const, account: "fixture" }
      const models = await discoverProviderModels({ provider: "openai", endpoint: fixture.url, credential: reference, credentialResolver, allowRemote: false })
      expect(models.map((model) => model.id)).toEqual(["runrail-fixture-model"])
      const chat = await collect(createOpenAIModelPort({ provider: "openai", model: "fixture", protocol: "openai-chat", endpoint: fixture.url, credential: reference, credentialResolver, allowRemote: false, thinking: "off" }).complete(request) as AsyncIterable<NativeModelChunk>)
      expect(chat.at(-1)).toEqual({ type: "response", response: { type: "text", text: "chat fixture" } })
      const responses = await collect(createOpenAIModelPort({ provider: "openai", model: "fixture", protocol: "openai-responses", endpoint: fixture.url, credential: reference, credentialResolver, allowRemote: false, thinking: "off" }).complete(request) as AsyncIterable<NativeModelChunk>)
      expect(responses.at(-1)).toEqual({ type: "response", response: { type: "text", text: "responses fixture" } })
      const anthropic = await collect(createAnthropicModelPort({ provider: "anthropic", model: "fixture", endpoint: fixture.url, credential: reference, credentialResolver, allowRemote: false, thinking: "off" }).complete(request) as AsyncIterable<NativeModelChunk>)
      expect(anthropic.at(-1)).toEqual({ type: "response", response: { type: "text", text: "anthropic fixture" } })
    } finally {
      await fixture.stop()
    }
  })
})
