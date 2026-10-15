import { createInterface } from "node:readline"

const mode = process.argv[2] ?? "events"
const input = createInterface({ input: process.stdin })
let count = 0

for await (const line of input) {
  let value: unknown
  try { value = JSON.parse(line) as unknown } catch { continue }
  if (!isRecord(value) || value.type !== "prompt" || typeof value.sessionId !== "string" || typeof value.message !== "string") continue
  if (mode === "hold" || value.message === "hold-this-turn") continue
  if (mode === "die") {
    process.stderr.write("connecting\nfatal: model server unreachable\n")
    process.exit(4)
  }
  count += 1
  const sessionId = value.sessionId
  if (mode === "correlation-drift") {
    process.stdout.write(`${JSON.stringify({ version: 1, requestId: "wrong-request", sessionId, seq: 0, at: 0, type: "session.completed", snapshot: { version: 1, id: sessionId, backend: "fixture", cwd: process.cwd(), status: "completed", createdAt: 0, updatedAt: 0, lastSeq: 0, capabilities: ["sessions", "streaming", "persistent"] } })}\n`)
    continue
  }
  if (mode === "echo-correlation" && typeof value.requestId === "string" && typeof value.turnId === "string") {
    process.stdout.write(`${JSON.stringify({ version: 1, requestId: value.requestId, sessionId, seq: 0, at: 0, type: "turn.started", turnId: value.turnId, prompt: value.message })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, requestId: value.requestId, sessionId, seq: 1, at: 1, type: "session.completed", snapshot: { version: 1, id: sessionId, backend: "fixture", cwd: process.cwd(), status: "completed", createdAt: 0, updatedAt: 1, lastSeq: 1, capabilities: ["sessions", "streaming", "persistent"] } })}\n`)
    continue
  }
  if (value.message === "approval") {
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "turn.started", turnId: `turn-${count}`, prompt: value.message })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "approval.required", turnId: `turn-${count}`, approvalId: "fixture-approval", action: "fixture action", capability: "fixture.command" })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 2, at: 2, type: "session.completed", snapshot: { version: 1, id: sessionId, backend: "fixture", cwd: process.cwd(), status: "completed", createdAt: 0, updatedAt: 2, lastSeq: 2, capabilities: ["sessions", "streaming", "persistent"] } })}\n`)
    continue
  }
  if (mode === "hold-on-second" && count === 2) continue
  process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "turn.started", turnId: `turn-${count}`, prompt: value.message })}\n`)
  process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "assistant.message", turnId: `turn-${count}`, text: value.message })}\n`)
  process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 2, at: 2, type: "session.completed", snapshot: { version: 1, id: sessionId, backend: "fixture", cwd: process.cwd(), status: "completed", createdAt: 0, updatedAt: 2, lastSeq: 2, capabilities: ["sessions", "streaming", "persistent"] } })}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
