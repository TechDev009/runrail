import type { SessionLogEntry, SessionStore } from "@nifrajs/coding-agent"

export const RUNRAIL_SESSION_EVIDENCE_VERSION = 1 as const

export interface SessionEvidenceEvent {
  readonly version: 1
  readonly seq: number
  readonly type: string
  readonly pinned?: boolean
}

export interface SessionEvidenceBundle {
  readonly version: typeof RUNRAIL_SESSION_EVIDENCE_VERSION
  readonly sessionId: string
  readonly events: readonly SessionEvidenceEvent[]
}

export type SessionTransferErrorCode = "SESSION_TRANSFER_INVALID" | "SESSION_TRANSFER_LIMIT"

export class SessionTransferError extends Error {
  constructor(readonly code: SessionTransferErrorCode, reason: string) {
    super(`session transfer: ${reason}`)
    this.name = "SessionTransferError"
  }
}

export async function exportSessionEvidence(
  store: SessionStore,
  sessionId: string,
  maxEntries = 2_048,
): Promise<string> {
  assertBound(maxEntries, 1, 16_384)
  validateSessionId(sessionId)
  const entries = await store.read(sessionId)
  if (entries.length > maxEntries) throw new SessionTransferError("SESSION_TRANSFER_LIMIT", "session has too many evidence entries")
  const events = entries.map(toEvidenceEvent)
  return JSON.stringify({ version: 1, sessionId, events })
}

export function parseSessionEvidence(text: string, maxEntries = 2_048): SessionEvidenceBundle {
  assertBound(maxEntries, 1, 16_384)
  if (typeof text !== "string" || text.length === 0 || text.length > 4 * 1024 * 1024)
    throw new SessionTransferError("SESSION_TRANSFER_INVALID", "session evidence text is invalid")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SessionTransferError("SESSION_TRANSFER_INVALID", "session evidence JSON cannot be parsed")
  }
  if (!isRecord(value) || value.version !== RUNRAIL_SESSION_EVIDENCE_VERSION || typeof value.sessionId !== "string" || !Array.isArray(value.events))
    throw new SessionTransferError("SESSION_TRANSFER_INVALID", "session evidence shape is invalid")
  if (value.sessionId.length === 0 || value.sessionId.length > 256 || value.events.length > maxEntries)
    throw new SessionTransferError("SESSION_TRANSFER_LIMIT", "session evidence exceeds its bounds")
  validateSessionId(value.sessionId)
  const events: SessionEvidenceEvent[] = []
  let previousSequence = -1
  for (const event of value.events) {
    if (!isRecord(event) || event.version !== 1 || !isSafeSequence(event.seq) || event.seq <= previousSequence || typeof event.type !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(event.type) || (event.pinned !== undefined && typeof event.pinned !== "boolean"))
      throw new SessionTransferError("SESSION_TRANSFER_INVALID", "session evidence event is invalid")
    previousSequence = event.seq
    events.push(Object.freeze({
      version: 1,
      seq: event.seq,
      type: event.type,
      ...(event.pinned === undefined ? {} : { pinned: event.pinned }),
    }))
  }
  return Object.freeze({ version: 1, sessionId: value.sessionId, events: Object.freeze(events) })
}

/** Import only event identity and pin metadata; all source payloads are intentionally discarded. */
export async function importSessionEvidence(
  store: SessionStore,
  source: string | SessionEvidenceBundle,
  targetSessionId?: string,
): Promise<{ readonly sessionId: string; readonly imported: number }> {
  const bundle = typeof source === "string" ? parseSessionEvidence(source) : parseSessionEvidence(JSON.stringify(source))
  const sessionId = targetSessionId === undefined ? bundle.sessionId : validateSessionId(targetSessionId)
  const existing = await store.read(sessionId)
  // The target numbers what it appends itself, so an import is known by where it came from, which the
  // entry keeps: its source session and sequence, and nothing of the source's content.
  const origins = new Set(existing.flatMap((entry) => originOf(entry.payload) ?? []))
  // Back into the session it came from, an event is already there under its own number.
  const own = sessionId === bundle.sessionId ? new Set(existing.map((entry) => `${entry.seq}:${entry.type}`)) : new Set<string>()
  let imported = 0
  for (const event of bundle.events) {
    const origin = originKey(bundle.sessionId, event.seq)
    if (origins.has(origin) || own.has(`${event.seq}:${event.type}`)) continue
    await store.append(sessionId, event.type, { importedFrom: { sessionId: bundle.sessionId, seq: event.seq } }, event.pinned === undefined ? undefined : { pinned: event.pinned })
    origins.add(origin)
    imported += 1
  }
  return Object.freeze({ sessionId, imported })
}

function originKey(sessionId: string, seq: number): string {
  return `${sessionId}\0${String(seq)}`
}

/** An imported entry's payload: where it came from, with nothing of the source's content. */
export function isImportedEvidencePayload(payload: unknown): boolean {
  return originOf(payload) !== undefined && isRecord(payload) && Object.keys(payload).length === 1 && Object.keys(payload.importedFrom as Record<string, unknown>).length === 2
}

function originOf(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.importedFrom)) return undefined
  const { sessionId, seq } = payload.importedFrom
  return typeof sessionId === "string" && isSafeSequence(seq) ? originKey(sessionId, seq) : undefined
}

function toEvidenceEvent(entry: SessionLogEntry): SessionEvidenceEvent {
  return Object.freeze({
    version: 1,
    seq: entry.seq,
    type: entry.type,
    ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
  })
}

function assertBound(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new SessionTransferError("SESSION_TRANSFER_LIMIT", "session transfer limit is invalid")
}

function validateSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value))
    throw new SessionTransferError("SESSION_TRANSFER_INVALID", "session id is invalid")
  return value
}

function isSafeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
