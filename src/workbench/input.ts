import type { ModelSelection } from "../model/catalog.ts"
import type { ProviderModelOptions } from "../providers/types.ts"
import type {
  TranscriptCompactionOptions,
  TranscriptReadOptions,
} from "../transcript/index.ts"

import type { RunrailAgentTask } from "../agents/runner.ts"
export type WorkbenchAction =
  | { readonly type: "session.tree" }
  | { readonly type: "session.history"; readonly limit?: number }
  | { readonly type: "session.fork"; readonly targetSessionId?: string }
  | { readonly type: "session.branch"; readonly targetSessionId?: string }
  | { readonly type: "session.clone"; readonly targetSessionId?: string }
  | { readonly type: "session.export"; readonly maxEntries?: number }
  | { readonly type: "session.import"; readonly evidence: string; readonly targetSessionId?: string }
  | { readonly type: "session.transcript.export"; readonly options?: TranscriptReadOptions }
  | { readonly type: "session.transcript.import"; readonly transcript: string; readonly targetSessionId?: string }
  | { readonly type: "session.transcript.branch"; readonly targetSessionId?: string }
  | { readonly type: "session.transcript.compact"; readonly options: TranscriptCompactionOptions }
  | { readonly type: "approval.resolve"; readonly approvalId: string; readonly approved: boolean; readonly reason?: string }
  | { readonly type: "backend.switch"; readonly backend: string }
  | { readonly type: "provider.switch"; readonly provider: ProviderModelOptions }
  | { readonly type: "model.switch"; readonly selection: ModelSelection }
  | { readonly type: "resources.refresh"; readonly query?: string }
  | { readonly type: "resource.select"; readonly id: string }
  | { readonly type: "diff.refresh"; readonly paths?: readonly string[] }
  | { readonly type: "context.reload" }
  | { readonly type: "agent.list" }
  | { readonly type: "agent.status" }
  | { readonly type: "agent.run"; readonly task: RunrailAgentTask }
  | { readonly type: "agent.runMany"; readonly tasks: readonly RunrailAgentTask[]; readonly maxConcurrency?: number }

export type WorkbenchKey =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "submit" }
  | { readonly type: "newline" }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "pageUp" }
  | { readonly type: "pageDown" }
  | { readonly type: "interrupt" }
  | { readonly type: "clear" }
  | { readonly type: "escape" }
  | { readonly type: "action"; readonly action: WorkbenchAction }
  | { readonly type: "resize"; readonly width: number; readonly height: number }

export type TerminalInputErrorCode = "TERMINAL_INPUT_INVALID" | "TERMINAL_INPUT_LIMIT"

export class TerminalInputError extends Error {
  constructor(readonly code: TerminalInputErrorCode, reason: string) {
    super(`terminal input: ${reason}`)
    this.name = "TerminalInputError"
  }
}

/** Stateful decoder for common ANSI terminal editing sequences. */
export class TerminalInputDecoder {
  private buffer = ""
  // One streaming decoder: a chunk can end inside a multi-byte character.
  private readonly bytes = new TextDecoder()

  feed(input: string | Uint8Array): readonly WorkbenchKey[] {
    const text = typeof input === "string" ? input : this.bytes.decode(input, { stream: true })
    if (text.length > 64 * 1024) throw new TerminalInputError("TERMINAL_INPUT_LIMIT", "input chunk is too large")
    this.buffer += text
    if (this.buffer.length > 128 * 1024) throw new TerminalInputError("TERMINAL_INPUT_LIMIT", "pending input is too large")
    const result: WorkbenchKey[] = []
    while (this.buffer.length > 0) {
      const parsed = parseOne(this.buffer)
      if (parsed === undefined) break
      const keys = Array.isArray(parsed) ? parsed : [parsed]
      for (const entry of keys) {
        this.buffer = this.buffer.slice(entry.consumed)
        if (!(entry.key.type === "text" && entry.key.text.length === 0)) result.push(entry.key)
      }
    }
    return Object.freeze(result)
  }

  flush(): readonly WorkbenchKey[] {
    this.buffer += this.bytes.decode()
    if (this.buffer.length === 0) return Object.freeze([])
    const value = this.buffer
    this.buffer = ""
    return Object.freeze([{ type: "text", text: value }])
  }
}

export function parseTerminalInput(input: string | Uint8Array): readonly WorkbenchKey[] {
  const decoder = new TerminalInputDecoder()
  return Object.freeze([...decoder.feed(input), ...decoder.flush()])
}

interface ParsedKey {
  readonly consumed: number
  readonly key: WorkbenchKey
}

function parseOne(value: string): ParsedKey | readonly ParsedKey[] | undefined {
  const first = value.charCodeAt(0)
  if (first === 0x1b) return parseEscape(value)
  if (first === 0x03) return { consumed: 1, key: { type: "interrupt" } }
  if (first === 0x01) return { consumed: 1, key: { type: "home" } }
  if (first === 0x04) return { consumed: 1, key: { type: "delete" } }
  if (first === 0x05) return { consumed: 1, key: { type: "end" } }
  if (first === 0x0c) return { consumed: 1, key: { type: "clear" } }
  if (first === 0x7f || first === 0x08) return { consumed: 1, key: { type: "backspace" } }
  if (first === 0x0d || first === 0x0a) return { consumed: 1, key: { type: "submit" } }
  if (first < 0x20) return { consumed: 1, key: { type: "text", text: value[0] ?? "" } }
  const codePoint = value.codePointAt(0)
  if (codePoint === undefined) return undefined
  const text = String.fromCodePoint(codePoint)
  return { consumed: text.length, key: { type: "text", text } }
}

const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"
const MAX_ESCAPE = 64

function parseEscape(value: string): ParsedKey | readonly ParsedKey[] | undefined {
  if (value.length === 1) return undefined
  if (value.startsWith(PASTE_START)) return parsePaste(value)
  // SS3: keys a terminal in application mode sends as ESC O <final>.
  if (value[1] === "O") {
    if (value.length < 3) return undefined
    return { consumed: 3, key: finalKey(value[2] ?? "", undefined) }
  }
  if (value[1] !== "[") return { consumed: 2, key: { type: "escape" } }
  // CSI: parameter bytes, intermediate bytes, one final byte (ECMA-48). Modifiers such as
  // Ctrl+Left (`1;5D`) and focus reports (`I`, `O`) are read whole, never left in the input.
  const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(value)
  if (match === null) {
    const rest = value.slice(2)
    if (rest.length < MAX_ESCAPE && /^[0-?]*[ -/]*$/.test(rest)) return undefined
    return { consumed: 2, key: { type: "escape" } }
  }
  const first = match[1]?.split(";")[0]
  const number = first === undefined || first.length === 0 || !/^\d{1,5}$/.test(first) ? undefined : Number.parseInt(first, 10)
  return { consumed: match[0].length, key: finalKey(match[3] ?? "", number) }
}

function finalKey(final: string, number: number | undefined): WorkbenchKey {
  if (final === "A") return { type: "up" }
  if (final === "B") return { type: "down" }
  if (final === "C") return { type: "right" }
  if (final === "D") return { type: "left" }
  if (final === "H") return { type: "home" }
  if (final === "F") return { type: "end" }
  if (final === "~") {
    if (number === 3) return { type: "delete" }
    if (number === 5) return { type: "pageUp" }
    if (number === 6) return { type: "pageDown" }
    if (number === 1 || number === 7) return { type: "home" }
    if (number === 4 || number === 8) return { type: "end" }
  }
  return { type: "escape" }
}

/** Pasted text arrives whole: its line breaks are new lines in the draft, never a submit. */
function parsePaste(value: string): readonly ParsedKey[] | undefined {
  const end = value.indexOf(PASTE_END, PASTE_START.length)
  if (end < 0) return undefined
  const pasted = value.slice(PASTE_START.length, end).replace(/\r\n?/g, "\n")
  const keys: WorkbenchKey[] = []
  pasted.split("\n").forEach((line, index) => {
    if (index > 0) keys.push({ type: "newline" })
    // eslint-disable-next-line no-control-regex
    const text = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    if (text.length > 0) keys.push({ type: "text", text })
  })
  const consumed = end + PASTE_END.length
  return keys.length === 0 ? [{ consumed, key: { type: "text", text: "" } }] : keys.map((key, index) => ({ consumed: index === keys.length - 1 ? consumed : 0, key }))
}
