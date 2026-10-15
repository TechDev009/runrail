import { createInterface } from "node:readline"

/** A stand-in for `@modelcontextprotocol/server-memory`: entities with observations, in memory. */

const input = createInterface({ input: process.stdin })
const entities = new Map<string, { name: string; entityType: string; observations: string[] }>()

function send(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

for await (const line of input) {
  const message = JSON.parse(line) as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
  const id = message.id ?? null
  if (message.method === "notifications/initialized") continue
  if (message.method === "initialize") {
    send(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "memory-fixture", version: "1.0.0" } })
  } else if (message.method === "tools/list") {
    send(id, { tools: ["create_entities", "delete_entities", "search_nodes", "read_graph"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })) })
  } else if (message.method === "tools/call") {
    const args = message.params?.arguments ?? {}
    switch (message.params?.name) {
      case "create_entities":
        for (const entity of args.entities as { name: string; entityType: string; observations: string[] }[]) entities.set(entity.name, entity)
        send(id, text([...entities.values()]))
        break
      case "delete_entities":
        for (const name of args.entityNames as string[]) entities.delete(name)
        send(id, { content: [{ type: "text", text: "Entities deleted successfully" }] })
        break
      case "search_nodes": {
        // Like the real server: the whole query must appear in a name, a type or an observation.
        const query = String(args.query).toLowerCase()
        send(id, text({ entities: [...entities.values()].filter((entity) => entity.name.toLowerCase().includes(query) || entity.observations.some((item) => item.toLowerCase().includes(query))), relations: [] }))
        break
      }
      case "read_graph":
        send(id, text({ entities: [...entities.values()], relations: [] }))
        break
      default:
        send(id, { content: [{ type: "text", text: "unknown tool" }], isError: true })
    }
  } else if (id !== null) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })}\n`)
  }
}
