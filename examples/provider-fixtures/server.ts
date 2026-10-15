export interface ProviderFixtureServerOptions {
  readonly hostname?: "127.0.0.1" | "localhost"
  readonly port?: number
}

export interface ProviderFixtureServerHandle {
  readonly url: string
  stop(): Promise<void>
}

/** Start deterministic local wire fixtures for Runrail provider adapter development. */
export function createProviderFixtureServer(options: ProviderFixtureServerOptions = {}): ProviderFixtureServerHandle {
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? 0
  if (hostname !== "127.0.0.1" && hostname !== "localhost") throw new TypeError("provider fixture hostname must be loopback")
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError("provider fixture port is invalid")
  const server = Bun.serve({ hostname, port, fetch: fixtureResponse })
  return {
    url: server.url.toString().replace(/\/$/, ""),
    stop: async () => {
      await server.stop()
    },
  }
}

async function fixtureResponse(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (pathname === "/models") return Response.json({ data: [{ id: "runrail-fixture-model", object: "model" }] })
  if (pathname === "/messages" || pathname.endsWith("/messages")) return sse([
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 7 } } }],
    ["content_block_delta", { type: "content_block_delta", delta: { text: "anthropic fixture" } }],
    ["message_delta", { type: "message_delta", usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ])
  if (pathname === "/responses" || pathname.endsWith("/responses")) return sse([
    ["", { type: "response.output_text.delta", delta: "responses fixture" }],
    ["", { type: "response.completed", response: { output_text: "responses fixture", usage: { input_tokens: 5, output_tokens: 2 } } }],
  ])
  if (pathname === "/chat/completions" || pathname.endsWith("/chat/completions")) return sse([
    ["", { choices: [{ delta: { content: "chat fixture" } }] }],
    ["", { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }],
    ["", "[DONE]"],
  ])
  return Response.json({ error: "fixture path not found" }, { status: 404 })
}

function sse(events: readonly (readonly [string, unknown])[]): Response {
  const body = events.map(([event, value]) => `${event.length === 0 ? "" : `event: ${event}\n`}data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } })
}

if (import.meta.main) {
  const fixture = createProviderFixtureServer()
  console.log(`Runrail provider fixtures listening at ${fixture.url}`)
}
