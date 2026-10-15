import { describe, expect, test } from "bun:test"
import { createProviderHttpClient, normalizeProviderEndpoint, ProviderError } from "../../src/index.ts"

describe("provider HTTP transport", () => {
  test("returns a provider quota rejection without retrying it", async () => {
    let attempts = 0
    const server = Bun.serve({ port: 0, fetch: () => { attempts += 1; return Response.json({ error: { code: "insufficient_quota" } }, { status: 429 }) } })
    try {
      const client = createProviderHttpClient({ baseUrl: server.url.toString(), maxRetries: 2, retryDelayMs: 0 })
      await expect(client.json({ path: "/models", method: "GET", retryable: true }, (value) => value)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", status: 429 })
      expect(attempts).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("a refused request's body is released, and only its start is kept for the adapter", async () => {
    let cancelled = false
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new TextEncoder().encode("unsupported parameter: reasoning ".repeat(256))) },
        cancel() { cancelled = true },
      }), { status: 400 }),
    })
    try {
      const client = createProviderHttpClient({ baseUrl: server.url.toString(), maxRetries: 0, retryDelayMs: 0 })
      const error = await client.json({ path: "/x", method: "POST", body: "{}" }, (value) => value).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: "PROVIDER_FAILED", status: 400 })
      expect((error as ProviderError).rejection?.length).toBeLessThanOrEqual(2_048)
      expect((error as ProviderError).rejection).toContain("unsupported parameter")
      expect(JSON.stringify(error)).not.toContain("unsupported")
      await Bun.sleep(20)
      expect(cancelled).toBe(true)
    } finally {
      await server.stop(true)
    }
  })

  test("enforces endpoint policy and accepts loopback HTTP", () => {
    expect(() => normalizeProviderEndpoint({ baseUrl: "https://example.test/api" })).toThrow(ProviderError)
    expect(() => normalizeProviderEndpoint({ baseUrl: "http://example.test/api", allowRemote: true })).toThrow(ProviderError)
    expect(normalizeProviderEndpoint({ baseUrl: "http://127.0.0.1:1/api" }).endpoint.pathname).toBe("/api/")
    expect(() => normalizeProviderEndpoint({ baseUrl: "https://user:pass@example.test/api", allowRemote: true })).toThrow(ProviderError)
  })

  test("retries only an explicitly retryable bounded request", async () => {
    let attempts = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        attempts += 1
        return attempts === 1 ? new Response("retry", { status: 503 }) : Response.json({ ok: true })
      },
    })
    try {
      const client = createProviderHttpClient({ baseUrl: server.url.toString(), maxRetries: 1, retryDelayMs: 0 })
      await expect(client.json({ path: "/status", method: "GET", retryable: true }, (value) => value)).resolves.toEqual({ ok: true })
      expect(attempts).toBe(2)
    } finally {
      await server.stop()
    }
  })

  test("preserves an endpoint path prefix for leading-slash requests", async () => {
    let pathname = ""
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        pathname = new URL(request.url).pathname
        return Response.json({ ok: true })
      },
    })
    try {
      const client = createProviderHttpClient({ baseUrl: `${server.url}v1` })
      await expect(client.json({ path: "/models", method: "GET" }, (value) => value)).resolves.toEqual({ ok: true })
      expect(pathname).toBe("/v1/models")
    } finally {
      await server.stop()
    }
  })

  test("bounds request/response and propagates cancellation", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return Response.json({ value: "x".repeat(1_000) })
      },
    })
    try {
      const client = createProviderHttpClient({ baseUrl: server.url.toString(), maxResponseBytes: 128, timeoutMs: 5_000 })
      await expect(client.json({ path: "/large", method: "GET" }, (value) => value)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" })
      const controller = new AbortController()
      const request = client.json({ path: "/cancel", method: "GET", signal: controller.signal }, (value) => value)
      controller.abort()
      await expect(request).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" })
    } finally {
      await server.stop()
    }
  })

  test("a request cancelled before it starts is never sent", async () => {
    let requests = 0
    const server = Bun.serve({ port: 0, fetch: () => { requests += 1; return Response.json({}) } })
    try {
      const client = createProviderHttpClient({ baseUrl: server.url.toString(), maxRetries: 0 })
      const controller = new AbortController()
      controller.abort()
      await expect(client.json({ path: "/x", method: "POST", body: "{}", signal: controller.signal }, (value) => value)).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" })
      await expect(client.stream({ path: "/x", method: "POST", body: "{}", signal: controller.signal })).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" })
      expect(requests).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test("a stream the consumer leaves early is cancelled, not left downloading", async () => {
    let cancelled = false
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new TextEncoder().encode("data: {}\n\n")) },
        cancel() { cancelled = true },
      }), { headers: { "content-type": "text/event-stream" } }),
    })
    try {
      const client = createProviderHttpClient({ baseUrl: server.url.toString(), maxRetries: 0 })
      const response = await client.stream({ path: "/x", method: "POST", body: "{}" })
      for await (const _chunk of response.body) break
      for (let attempt = 0; attempt < 50 && !cancelled; attempt += 1) await Bun.sleep(10)
      expect(cancelled).toBe(true)
    } finally {
      await server.stop(true)
    }
  })
})
