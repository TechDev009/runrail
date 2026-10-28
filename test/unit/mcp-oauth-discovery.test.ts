import { expect, test } from "bun:test"
import { discoverMcpOAuth } from "../../src/mcp/oauth.ts"

async function withFetch(handler: (url: string, method: string) => Response, run: (seen: string[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    seen.push(url)
    return handler(url, init?.method ?? "GET")
  }, { preconnect: original.preconnect })
  try {
    await run(seen)
  } finally {
    globalThis.fetch = original
  }
}

const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

test("a remote server cannot point sign-in discovery at a private address", async () => {
  await withFetch((url, method) => {
    if (method === "POST") return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1:9/meta"' } })
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") return json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://10.0.0.5"] })
    return new Response(null, { status: 404 })
  }, async (seen) => {
    await expect(discoverMcpOAuth("https://mcp.example.com/mcp", new AbortController().signal)).rejects.toThrow("private address")
    expect(seen.some((url) => url.includes("127.0.0.1") || url.includes("10.0.0.5"))).toBe(false)
  })
})
