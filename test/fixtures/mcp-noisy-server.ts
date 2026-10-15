import { createInterface } from "node:readline"

// An MCP server that logs to stdout, pings the client, and names itself from its configured environment.
const write = (value: unknown): void => { process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`) }
let pinged = false
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: string | number; method?: string; result?: unknown }
  if (message.method === "initialize") {
    write("server starting up (a log line on stdout)")
    write({ jsonrpc: "2.0", id: "ping-1", method: "ping" })
    write({ jsonrpc: "2.0", id: "roots-1", method: "roots/list" })
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `noisy-${process.env.FIXTURE_SERVER_NAME ?? "unset"}`, version: "1" } } })
  } else if (message.id === "ping-1") pinged = true
  else if (message.method === "tools/list") write({ jsonrpc: "2.0", id: message.id, result: { tools: pinged ? [{ name: "pinged", inputSchema: { type: "object" } }] : [] } })
}
