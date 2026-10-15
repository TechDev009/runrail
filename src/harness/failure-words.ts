import { redactCommandText } from "../background/redact.ts"

/**
 * Why a coding tool's process failed, in its own words: the last line it printed that reads as an
 * error, else its last line. Kept to one bounded line with credentials masked: first the exact values
 * the process was given, then the shapes keys usually take. Protocol records and stack frames are not
 * words for a person.
 */

const ERROR_LINE = /\b(?:error|errors|failed|failure|fatal|denied|refused|rejected|invalid|not found|no such|not available|unavailable|cannot|can't|could not|unable|unknown|missing|expired|exceeded|timed out|unauthori[sz]ed|forbidden|exception|panic(?:ked)?|abort(?:ed)?)\b/i
const STACK_FRAME = /^at\s|^node:internal|^Node\.js v\d|^Bun v\d|^\^+$/
// CSI and OSC sequences a terminal program colours or titles its output with.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const LINES_SEEN = 40
const MIN_SECRET_CHARS = 6

export function failureWords(text: string, secrets: readonly string[] = [], max = 300): string | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined
  const lines = text.slice(-16 * 1024).replace(ESCAPES, "").split(/\r?\n|\r/).map((line) => line.trim()).filter((line) => line.length > 0 && !STACK_FRAME.test(line) && !isRecordLine(line)).slice(-LINES_SEEN)
  const chosen = [...lines].reverse().find((line) => ERROR_LINE.test(line)) ?? lines.at(-1)
  return chosen === undefined ? undefined : masked(chosen, secrets, max)
}

/** A tool's own error message, whole: one bounded line with credentials masked the same way. */
export function messageWords(message: string, secrets: readonly string[] = [], max = 300): string | undefined {
  return typeof message === "string" ? masked(message.slice(0, 8 * 1024).replace(ESCAPES, ""), secrets, max) : undefined
}

function masked(text: string, secrets: readonly string[], max: number): string | undefined {
  let value = text
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= MIN_SECRET_CHARS) value = value.split(secret).join("***")
  const words = redactCommandText(value, max)
  return words.length === 0 ? undefined : words
}

/** The credential values a process was started with, so its words never repeat them. */
export function credentialValues(environment: Readonly<Record<string, string>>, names: readonly string[] | undefined): readonly string[] {
  return (names ?? []).flatMap((name) => {
    const value = environment[name]
    return typeof value === "string" && value.length > 0 ? [value] : []
  })
}

/** `exited with code 1: <words>`: the status a process ended with, and why when it said. */
export function exitReason(subject: string, status: number | null, words: string | undefined): string {
  const how = typeof status === "number" && status !== 0 ? `${subject} exited with code ${String(status)}` : `${subject} exited`
  return words === undefined ? how : `${how}: ${words}`
}

function isRecordLine(line: string): boolean {
  if (!line.startsWith("{") || !line.endsWith("}")) return false
  try {
    JSON.parse(line)
    return true
  } catch {
    return false
  }
}
