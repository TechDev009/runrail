/**
 * Whether `value` matches `pattern`, where `*` stands for any run of characters and `?` for one.
 * Patterns can come from a model, so this never backtracks the way a regex of `.*` does: the
 * work is at most the two lengths multiplied.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  const wanted = Array.from(pattern)
  const text = Array.from(value)
  let at = 0
  let index = 0
  let star = -1
  let resume = 0
  while (index < text.length) {
    const next = wanted[at]
    if (next !== undefined && next !== "*" && (next === "?" || next === text[index])) {
      at += 1
      index += 1
    } else if (next === "*") {
      star = at
      at += 1
      resume = index
    } else if (star >= 0) {
      at = star + 1
      resume += 1
      index = resume
    } else {
      return false
    }
  }
  while (wanted[at] === "*") at += 1
  return at === wanted.length
}
