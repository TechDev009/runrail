/**
 * Memory: what Runrail remembers for a project or for the person, kept locally by
 * default, or in an external memory server reached over MCP.
 */

/** `person`, or `project:<16 hex>` from the project's root. */
export type MemoryScope = string

export type MemorySourceKind = "manual" | "suggested" | "folder" | "github" | "feed"

export interface Memory {
  readonly id: string
  readonly scope: MemoryScope
  readonly text: string
  readonly source: { readonly kind: MemorySourceKind; readonly id?: string; readonly ref?: string }
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RecallHit extends Memory {
  /** Share of the query's words the memory has, 0 to 1. */
  readonly score: number
}

export interface MemoryAdd {
  readonly scope: MemoryScope
  readonly text: string
  readonly source?: Memory["source"]
}

export interface MemoryListInput {
  readonly scopes?: readonly MemoryScope[]
  readonly sourceId?: string
  readonly query?: string
  readonly limit: number
  readonly before?: number
}

export interface MemoryProvider {
  readonly kind: "local" | "mcp"
  recall(query: string, scopes: readonly MemoryScope[], limit: number): Promise<readonly RecallHit[]>
  add(input: MemoryAdd): Promise<Memory>
  update(id: string, text: string): Promise<Memory>
  forget(id: string): Promise<boolean>
  list(input: MemoryListInput): Promise<readonly Memory[]>
  health(): Promise<{ readonly ok: boolean; readonly detail?: string }>
  close(): Promise<void>
}

export class MemoryError extends Error {
  constructor(
    readonly code: "MEMORY_INVALID" | "MEMORY_NOT_FOUND" | "MEMORY_UNAVAILABLE" | "MEMORY_LIMIT" | "MEMORY_STORE_FAILED" | "MEMORY_SOURCE_FAILED",
    message: string,
  ) {
    super(message)
    this.name = "MemoryError"
  }
}

export const MAX_MEMORY_TEXT = 4_000

export function memoryText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_MEMORY_TEXT || value.includes("\0")) throw new MemoryError("MEMORY_INVALID", `a memory is text up to ${String(MAX_MEMORY_TEXT)} characters`)
  return value.trim()
}

const STOPWORDS = new Set(
  "the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when your into than then them these some just also only very more most such over does did how why who its use used using should could make made like want need get".split(" "),
)

/** A recall's score counts a memory's words out of at most this many of the query's. */
export const RECALL_TERMS = 4

/**
 * The share of the query's words a memory has, out of at most RECALL_TERMS of them, so a message
 * longer than its question still recalls the fact it names, while one shared word of many does not.
 */
export function recallScore(matched: number, terms: number): number {
  return terms === 0 ? 0 : Math.min(1, matched / Math.min(terms, RECALL_TERMS))
}

/** The words a recall looks for: lowercase, three letters or more, no common words, at most 12. */
export function queryTerms(query: string): readonly string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []
  return [...new Set(words.filter((word) => !STOPWORDS.has(word)))].slice(0, 12)
}
