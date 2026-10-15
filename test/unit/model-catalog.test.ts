import { describe, expect, test } from "bun:test"
import type { NativeModelPort } from "@nifrajs/coding-agent"
import { createGatewayContentModelPort, createGatewayModelAdapter } from "../../src/model/gateway.ts"
import {
  BudgetedModelPort,
  ModelCatalogError,
  RunrailBudgetError,
  BudgetLedger,
  createModelCatalog,
  createRoutedModelPort,
} from "../../src/model/index.ts"

function adapter(id: string, tier: "cheap" | "fast" | "strong", text: string) {
  const port: NativeModelPort = { complete: () => ({ type: "text", text }) }
  return {
    descriptor: {
      id,
      provider: "fixture",
      version: "1.0.0",
      tier,
      capabilities: ["tools", "streaming"] as const,
      contextTokens: 16_000,
    },
    create: () => port,
  }
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<import("@nifrajs/coding-agent").NativeModelChunk> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function"
}
describe("native model catalog", () => {
  test("selects by quality and rejects missing capabilities", async () => {
    const catalog = createModelCatalog([adapter("cheap", "cheap", "small"), adapter("strong", "strong", "large")])
    expect(catalog.select({ quality: "strong" }).descriptor.id).toBe("strong")
    await expect(
      catalog.create({ requiredCapabilities: ["multimodal"] }, { cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "MODEL_CAPABILITY_UNAVAILABLE" })
  })

  test("switches a routed port without changing its public contract", async () => {
    const catalog = createModelCatalog([adapter("cheap", "cheap", "one"), adapter("fast", "fast", "two")])
    const routed = await createRoutedModelPort(catalog, { id: "cheap" }, { cwd: "/tmp" })
    expect(routed.current.descriptor.id).toBe("cheap")
    await expect(routed.switch({ id: "fast" })).resolves.toMatchObject({ id: "fast" })
    expect(routed.current.descriptor.id).toBe("fast")
  })

  test("enforces bounded usage on a model response", async () => {
    const model = adapter("cheap", "cheap", "this response is too long")
    const ledger = new BudgetLedger({
      model: model.descriptor,
      budget: { maxOutputTokens: 1 },
    })
    const port = new BudgetedModelPort(model.create(), ledger)
    await expect(
      port.complete({
        sessionId: "s",
        cwd: "/tmp",
        messages: [{ role: "user", text: "go" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RunrailBudgetError)
    // The request ran, so what it used is counted even though it broke the budget.
    expect(ledger.snapshot().outputTokens).toBeGreaterThan(1)
  })

  test("prices cached input at the model's cache rates", async () => {
    const inner: NativeModelPort & { takeUsage(): unknown } = {
      complete: async () => ({ type: "text", text: "ok" }),
      takeUsage: () => ({ inputTokens: 1_000_000, cacheReadTokens: 800_000, cacheWriteTokens: 100_000, outputTokens: 0 }),
    }
    const ledger = new BudgetLedger({ model: { id: "cached", provider: "fixture", version: "1", tier: "strong", capabilities: ["streaming"], contextTokens: 1024, pricing: { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 20, cacheReadUsdPerMillionTokens: 1, cacheWriteUsdPerMillionTokens: 12.5 } } })
    await new BudgetedModelPort(inner, ledger).complete({ sessionId: "s", cwd: "/tmp", messages: [{ role: "user", text: "go" }], tools: [], signal: new AbortController().signal })
    // 100k fresh at $10, 800k read at $1, 100k written at $12.50 per million.
    expect(ledger.snapshot().costUsd).toBeCloseTo(1 + 0.8 + 1.25, 6)
  })

  test("adapts a caller-owned provider-neutral gateway", async () => {
    const catalog = createModelCatalog([createGatewayModelAdapter({
      descriptor: {
        id: "gateway",
        provider: "caller",
        version: "1.0.0",
        tier: "strong",
        capabilities: ["tools"],
        contextTokens: 4096,
      },
      gateway: { complete: () => ({ ok: true, output: { type: "text", text: "gateway response" } }) },
      policy: { routes: ["fixture-route"], retryableCodes: [], maxAttempts: 1 },
    })])
    const created = await catalog.create({ id: "gateway" }, { cwd: "/tmp" })
    await expect(created.port.complete({
      sessionId: "s",
      cwd: "/tmp",
      messages: [{ role: "user", text: "go" }],
      tools: [],
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ type: "text", text: "gateway response" })
  })



  test("passes canonical content parts through the gateway adapter", async () => {
    let seenParts = 0
    const port = createGatewayContentModelPort({
      gateway: {
        complete: ({ input }) => {
          if (isRecord(input) && Array.isArray(input.parts)) seenParts = input.parts.length
          return { ok: true, output: { type: "text", text: "gateway content" } }
        },
      },
      policy: { routes: ["fixture-route"], retryableCodes: [], maxAttempts: 1 },
    })
    await expect(port.complete({
      sessionId: "s",
      cwd: "/tmp",
      messages: [{ role: "user", text: "review" }],
      tools: [],
      parts: [{ kind: "text", text: "review" }],
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ type: "text", text: "gateway content" })
    expect(seenParts).toBe(1)
  })

  test("uses stable typed error codes", () => {
    const catalog = createModelCatalog([adapter("cheap", "cheap", "small")])
    expect(() => catalog.select({ id: "missing" })).toThrow(ModelCatalogError)
    try {
      catalog.select({ id: "missing" })
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_NOT_FOUND" })
    }
  })
  test("reconciles provider-reported usage exactly once", async () => {
    let usageTaken = 0
    const inner: NativeModelPort & { takeUsage(): unknown } = {
      complete: async function* () { yield { type: "response", response: { type: "text", text: "ok" } } },
      takeUsage: () => {
        usageTaken += 1
        return { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.25 }
      },
    }
    const ledger = new BudgetLedger({ model: { id: "priced", provider: "fixture", version: "1", tier: "strong", capabilities: ["streaming"], contextTokens: 1024, pricing: { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 20 } }, budget: { maxInputTokens: 3, maxOutputTokens: 2, maxCostUsd: 0.25 } })
    const port = new BudgetedModelPort(inner, ledger)
    const result = port.complete({ sessionId: "s", cwd: "/tmp", messages: [{ role: "user", text: "long enough" }], tools: [], signal: new AbortController().signal })
    if (isAsyncIterable(result)) for await (const _chunk of result) {}
    expect(usageTaken).toBe(1)
    expect(ledger.snapshot()).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.25 })
  })

  test("keeps concurrent model reservations independent", async () => {
    const model = adapter("concurrent", "fast", "ok")
    const ledger = new BudgetLedger({ model: model.descriptor, budget: { maxInputTokens: 11, maxOutputTokens: 2 } })
    const inner: NativeModelPort = {
      complete: async (request) => {
        const text = request.messages[0]?.text ?? ""
        await new Promise((resolve) => setTimeout(resolve, text.length > 10 ? 5 : 25))
        return { type: "text", text: "ok" }
      },
    }
    const port = new BudgetedModelPort(inner, ledger)
    const first = port.complete({ sessionId: "s", cwd: "/tmp", messages: [{ role: "user", text: "a" }], tools: [], signal: new AbortController().signal })
    const second = port.complete({ sessionId: "s", cwd: "/tmp", messages: [{ role: "user", text: "b".repeat(40) }], tools: [], signal: new AbortController().signal })
    await Promise.all([first, second])
    expect(ledger.snapshot()).toMatchObject({ inputTokens: 11, outputTokens: 2, totalTokens: 13 })
  })
})
