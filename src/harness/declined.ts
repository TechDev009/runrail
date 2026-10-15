/** What a coding tool's model reads when the person says no to a call. */
export const DECLINED = "The user declined this action."

const MAX_NOTE_CHARS = 2_000

/** The person's note for the model, cut short when long rather than replaced. */
export function userNote(value: string): string {
  const text = value.replaceAll("\0", "").trim()
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS - 3)}...` : text
}

/** The refusal, followed by the person's note when they left one, so the model knows who said no. */
export function declinedMessage(note: string | undefined): string {
  const text = note === undefined ? "" : userNote(note)
  return text.length === 0 ? DECLINED : `The user declined this action: ${text}`
}
