// The same contract as splitAgentText and boundAgentText in @nifrajs/agent-protocol from 4.1;
// Runrail keeps its own copy while it runs on 4.0, which has neither.
export const EVENT_TEXT_MAX = 256 * 1024

const TRUNCATED = "…[truncated]"
const REPLACEMENT = String.fromCodePoint(0xfffd)

/**
 * Splits text into pieces that each fit an event's text field, so a long reply travels as
 * consecutive events instead of failing validation. Joined, the pieces give back the text with
 * each NUL replaced by U+FFFD. A piece ends after a line break when one falls in its last
 * quarter, and never between the halves of a surrogate pair. Empty text gives one empty piece.
 */
export function eventTextPieces(text: string, maxChars = EVENT_TEXT_MAX): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > EVENT_TEXT_MAX) throw new RangeError(`event text pieces must be between 2 and ${EVENT_TEXT_MAX} characters`)
  const clean = text.replaceAll("\0", REPLACEMENT)
  if (clean.length <= maxChars) return [clean]
  const pieces: string[] = []
  let start = 0
  while (clean.length - start > maxChars) {
    let end = start + maxChars
    const searchFrom = start + Math.floor((maxChars * 3) / 4)
    const lineEnd = clean.slice(searchFrom, end).lastIndexOf("\n")
    if (lineEnd !== -1) end = searchFrom + lineEnd + 1
    else if (isHighSurrogate(clean.charCodeAt(end - 1)) && isLowSurrogate(clean.charCodeAt(end))) end -= 1
    pieces.push(clean.slice(start, end))
    start = end
  }
  pieces.push(clean.slice(start))
  return pieces
}

/**
 * Whether a message may be a piece of a longer reply that the very next message continues: every
 * piece but the last is longer than three quarters of the limit. A view joins such a message
 * with the message right after it in the same turn.
 */
export function mayContinue(text: string): boolean {
  return text.length > Math.floor((EVENT_TEXT_MAX * 3) / 4)
}

/** Text for one event field: NUL becomes U+FFFD and text past `maxChars` is cut, ending in a marker. */
export function eventText(text: string, maxChars = EVENT_TEXT_MAX): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < TRUNCATED.length || maxChars > EVENT_TEXT_MAX) throw new RangeError(`event text must be between ${TRUNCATED.length} and ${EVENT_TEXT_MAX} characters`)
  const clean = text.replaceAll("\0", REPLACEMENT)
  if (clean.length <= maxChars) return clean
  let end = maxChars - TRUNCATED.length
  if (end > 0 && isHighSurrogate(clean.charCodeAt(end - 1))) end -= 1
  return `${clean.slice(0, end)}${TRUNCATED}`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
