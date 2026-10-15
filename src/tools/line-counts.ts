/**
 * Lines added and removed between two texts, as a line diff counts them. Shared lines at the
 * start and end are set aside, and the middle is matched by longest common subsequence when it is
 * small enough; a larger middle counts lines by how often each appears, which never undercounts
 * a real change by more than the lines that only moved.
 */

/** Middle sizes up to this product use the exact match (about 4 MB of work at most). */
const MAX_EXACT_CELLS = 4_000_000

export interface LineCounts {
  readonly additions: number
  readonly deletions: number
}

export function lineCounts(before: string, after: string): LineCounts {
  const old = splitLines(before)
  const next = splitLines(after)
  let start = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1
  let oldEnd = old.length
  let nextEnd = next.length
  while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd -= 1
    nextEnd -= 1
  }
  const a = old.slice(start, oldEnd)
  const b = next.slice(start, nextEnd)
  if (a.length === 0 || b.length === 0) return { additions: b.length, deletions: a.length }
  const common = a.length * b.length <= MAX_EXACT_CELLS ? longestCommon(a, b) : sharedByCount(a, b)
  return { additions: b.length - common, deletions: a.length - common }
}

function splitLines(text: string): readonly string[] {
  if (text.length === 0) return []
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

function longestCommon(a: readonly string[], b: readonly string[]): number {
  let previous = new Uint32Array(b.length + 1)
  let current = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!)
    ;[previous, current] = [current, previous]
  }
  return previous[b.length]!
}

function sharedByCount(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  let shared = 0
  for (const line of b) {
    const left = counts.get(line) ?? 0
    if (left > 0) {
      shared += 1
      counts.set(line, left - 1)
    }
  }
  return shared
}
