const MAX_DEPTH = 6
const MAX_STRING_BYTES = 16 * 1024
const MAX_ARRAY_ITEMS = 128
const MAX_OBJECT_KEYS = 64
const MAX_TOTAL_BYTES = 64 * 1024
const MAX_NODES = 2_048

/**
 * Copies a harness tool input into a bounded JSON value so tool-start events can carry it to a
 * control client. Strings, arrays, objects, depth, and total size are capped; anything that is
 * not plain JSON data is dropped. Returns undefined when nothing usable remains.
 */
export function boundToolInput(value: unknown): unknown {
  const budget = { remaining: MAX_TOTAL_BYTES, nodes: MAX_NODES }
  return copy(value, 0, budget)
}

function copy(value: unknown, depth: number, budget: { remaining: number; nodes: number }): unknown {
  if (budget.remaining <= 0 || budget.nodes <= 0) return undefined
  budget.nodes -= 1
  if (value === null || typeof value === "boolean") return value
  // The event protocol refuses a number past the safe-integer range, so it travels as text.
  if (typeof value === "number") return Number.isFinite(value) ? (Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : String(value)) : undefined
  if (typeof value === "string") {
    const limit = Math.min(MAX_STRING_BYTES, budget.remaining)
    const text = value.replaceAll("\0", "\uFFFD")
    const clipped = Buffer.byteLength(text, "utf8") <= limit ? text : Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "")
    budget.remaining -= Buffer.byteLength(clipped, "utf8")
    return clipped
  }
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      const next = copy(item, depth + 1, budget)
      if (next !== undefined) result.push(next)
    }
    return result
  }
  if (typeof value !== "object") return undefined
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (key.length === 0 || key.length > 128 || key.includes("\0")) continue
    budget.remaining -= key.length
    const next = copy(item, depth + 1, budget)
    if (next !== undefined) result[key] = next
  }
  return result
}
