import { ConversationBuilder, SESSION_CONTINUED, SESSION_IMPORTED, SESSION_REWOUND, transcriptEntry } from "../conversation/index.ts"
import { TranscriptStoreError, type TranscriptRecord, type TranscriptStore } from "../transcript/store.ts"

/**
 * The conversation a coding-tool route has never seen. A thread continued from another one, or
 * one that imported another agent's history, holds that history in its transcript, but the tool
 * keeps its own conversation and starts without it. Its first turn carries a recap instead.
 *
 * A rewind leaves a marker too: the tool's own conversation still held the removed turns, so the
 * thread starts the tool afresh and the recap carries what is left. A tool that cut its own
 * conversation at that turn needs none.
 *
 * Only history before the last marker counts, and only until the tool answers a turn after it:
 * from then on it holds the recap in its own conversation.
 */

const MAX_CARRY_BYTES = 32 * 1024
const MAX_MESSAGE_CHARS = 4 * 1024
const MARKERS: ReadonlySet<string> = new Set([SESSION_CONTINUED, SESSION_IMPORTED, SESSION_REWOUND])
/** Records that show a turn reached the tool. Coding tools do not all report a turn start. */
const ANSWERED: ReadonlySet<string> = new Set(["turn.started", "assistant.delta", "assistant.message", "tool.started", "session.completed"])

export function carryoverText(records: readonly TranscriptRecord[]): string | undefined {
  let marker = -1
  records.forEach((record, index) => {
    if (MARKERS.has(record.kind)) marker = index
  })
  if (marker < 0) return undefined
  // A session continued in its own tool, or a rewind the tool made in its own conversation: it already holds the history.
  if ((records[marker]!.kind === SESSION_IMPORTED || records[marker]!.kind === SESSION_REWOUND) && isInTool(records[marker]!.payload)) return undefined
  if (records.slice(marker + 1).some((record) => ANSWERED.has(record.kind))) return undefined
  const builder = new ConversationBuilder()
  for (const record of records.slice(0, marker)) {
    const entry = transcriptEntry(record)
    if (entry !== undefined) builder.add(entry)
  }
  const lines: string[] = []
  for (const item of builder.items()) {
    if (item.kind === "user") lines.push(`User: ${clip(item.text)}`)
    else if (item.kind === "assistant" && item.text.trim().length > 0) lines.push(`Assistant: ${clip(item.text)}`)
  }
  // The newest messages matter most; the oldest go first when the recap is too long.
  const kept: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(lines[index]!, "utf8") + 1
    if (bytes + size > MAX_CARRY_BYTES) break
    kept.unshift(lines[index]!)
    bytes += size
  }
  if (kept.length === 0) return undefined
  const cut = kept.length < lines.length ? "(Earlier messages left out.)\n" : ""
  const opening = records[marker]!.kind === SESSION_REWOUND ? "the conversation so far; the user took the thread back to here and later turns were removed" : "the conversation so far, from before this thread moved to you"
  return `[Runrail: ${opening}]\n${cut}${kept.join("\n")}\n[End of the conversation so far. The user's new message follows.]\n\n`
}

/**
 * Starts `sessionId` as the continuation of a session kept in another store: its records are
 * copied in and a marker says where this thread took over. Does nothing once `sessionId` has
 * records, so a restarted engine does not copy again. Returns whether it copied.
 *
 * With `beforeSeq`, only the records before that message are copied, a fork from earlier in the
 * conversation. The message must start a turn, so no turn is cut in half.
 */
export async function continueTranscript(from: TranscriptStore, fromSessionId: string, to: TranscriptStore, sessionId: string, beforeSeq?: number): Promise<boolean> {
  if (fromSessionId === sessionId) return false
  if ((await to.read(sessionId, { maxRecords: 1 })).length > 0) return false
  const bundle = await from.migrate(await from.export(fromSessionId))
  const records = beforeSeq === undefined ? bundle.records : recordsBefore(bundle.records, beforeSeq)
  const { imported } = records.length === 0 ? { imported: 0 } : await to.import({ ...bundle, records }, sessionId)
  if (imported === 0) return false
  await to.append(sessionId, { kind: SESSION_CONTINUED, payload: { type: SESSION_CONTINUED } })
  return true
}

function recordsBefore(records: readonly TranscriptRecord[], seq: number): readonly TranscriptRecord[] {
  const at = records.findIndex((record) => record.seq === seq)
  const payload = records[at]?.payload
  const steer = typeof payload === "object" && payload !== null && (payload as { readonly steer?: unknown }).steer === true
  if (records[at]?.kind !== "message.user" || steer) throw new TranscriptStoreError("TRANSCRIPT_INVALID", "beforeSeq does not name a message that starts a turn")
  return records.slice(0, at)
}

function isInTool(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { readonly inTool?: unknown }).inTool === true
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MAX_MESSAGE_CHARS ? trimmed : `${trimmed.slice(0, MAX_MESSAGE_CHARS)}…`
}
