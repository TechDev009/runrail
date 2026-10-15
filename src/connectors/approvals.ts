import { createHash } from "node:crypto"

const TICKET_TTL_MS = 10 * 60_000
const MAX_TICKETS = 256
const MAX_DEPTH = 32

/**
 * The connector calls the person approved in Claude Code's prompt. `POST /connectors` runs a tool
 * that waits for approval only by spending one of these: the same tool with the same input, once,
 * within ten minutes. A call that reaches the route any other way (a print-mode Claude Code, or the
 * agent posting to the endpoint itself) finds none and is refused.
 */
export class ConnectorApprovals {
  private readonly tickets = new Map<string, number[]>()
  private count = 0

  constructor(private readonly now: () => number = Date.now) {}

  approve(name: string, input: unknown): void {
    this.prune()
    if (this.count >= MAX_TICKETS) return
    const key = ticketKey(name, input)
    if (key === undefined) return
    const expiries = this.tickets.get(key) ?? []
    expiries.push(this.now() + TICKET_TTL_MS)
    this.tickets.set(key, expiries)
    this.count += 1
  }

  /** Spends the approval for this exact call; false when there is none. */
  take(name: string, input: unknown): boolean {
    this.prune()
    const key = ticketKey(name, input)
    if (key === undefined) return false
    const expiries = this.tickets.get(key)
    if (expiries === undefined || expiries.length === 0) return false
    expiries.shift()
    this.count -= 1
    if (expiries.length === 0) this.tickets.delete(key)
    return true
  }

  private prune(): void {
    const now = this.now()
    for (const [key, expiries] of this.tickets) {
      const live = expiries.filter((expiry) => expiry > now)
      this.count -= expiries.length - live.length
      if (live.length === 0) this.tickets.delete(key)
      else this.tickets.set(key, live)
    }
  }
}

function ticketKey(name: string, input: unknown): string | undefined {
  const canonical = canonicalJson(input ?? {}, 0)
  if (canonical === undefined) return undefined
  return `${name}\0${createHash("sha256").update(canonical).digest("hex")}`
}

/** JSON with object keys sorted, so the approved input and the posted one compare whatever their key order. */
function canonicalJson(value: unknown, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined
  if (Array.isArray(value)) {
    const items: string[] = []
    for (const item of value) {
      const encoded = canonicalJson(item, depth + 1)
      if (encoded === undefined) return undefined
      items.push(encoded)
    }
    return `[${items.join(",")}]`
  }
  if (typeof value === "object") {
    const entries: string[] = []
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) continue
      const encoded = canonicalJson(item, depth + 1)
      if (encoded === undefined) return undefined
      entries.push(`${JSON.stringify(key)}:${encoded}`)
    }
    return `{${entries.join(",")}}`
  }
  return undefined
}
