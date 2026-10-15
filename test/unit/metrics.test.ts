import { expect, test } from "bun:test"
import type { NativeModelResponse } from "@nifrajs/coding-agent"
import { CachedModelPort, RunrailMetrics } from "../../src/runtime/metrics.ts"

class MemoryCache {
  private readonly values = new Map<string, NativeModelResponse>()
  get(key: string): NativeModelResponse | undefined { return this.values.get(key) }
  set(key: string, response: NativeModelResponse): void { this.values.set(key, response) }
}

test("caller-owned model cache is content-keyed and observable without evidence", async () => {
  let calls = 0
  const metrics = new RunrailMetrics()
  const model = {
    id: "fixture",
    provider: "fixture",
    version: "1.0.0",
    tier: "fast" as const,
    capabilities: ["tools"] as const,
    contextTokens: 1024,
  }
  const port = new CachedModelPort({
    complete: () => {
      calls += 1
      return { type: "text", text: "done" }
    },
  }, model, new MemoryCache(), metrics)
  const request = {
    sessionId: "s",
    cwd: "/tmp",
    messages: [{ role: "user" as const, text: "go" }],
    tools: [],
    signal: new AbortController().signal,
  }
  await port.complete(request)
  await port.complete(request)
  expect(calls).toBe(1)
  expect(metrics.snapshot()).toMatchObject({ modelCalls: 1, cacheMisses: 1, cacheHits: 1 })
})

test("a session's running totals show while it runs, and count once when it records them", () => {
  const metrics = new RunrailMetrics()
  const first = {}
  const second = {}
  const usage = (tokens: number) => ({ inputTokens: tokens, outputTokens: tokens / 10, totalTokens: tokens * 1.1, costUsd: 0, toolCalls: 1, elapsedMs: 5 })
  metrics.trackUsage(first, usage(100))
  metrics.trackUsage(first, usage(300))
  metrics.trackUsage(second, usage(50))
  expect(metrics.snapshot()).toMatchObject({ inputTokens: 350, outputTokens: 35, toolCalls: 2 })
  metrics.recordUsage(usage(300), first)
  expect(metrics.snapshot()).toMatchObject({ inputTokens: 350, outputTokens: 35, toolCalls: 2 })
  metrics.recordUsage(usage(50), second)
  expect(metrics.snapshot()).toMatchObject({ inputTokens: 350, outputTokens: 35 })
  // Tokens a coding tool reports are added as they arrive.
  metrics.recordTokens(10, 2)
  expect(metrics.snapshot()).toMatchObject({ inputTokens: 360, outputTokens: 37 })
  expect(() => metrics.trackUsage(first, { ...usage(1), inputTokens: -1 })).toThrow(RangeError)
  expect(() => metrics.recordTokens(1.5, 0)).toThrow(RangeError)
})
