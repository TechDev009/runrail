import { createInterface } from "node:readline"

const mode = process.argv[2] ?? "events"
const input = createInterface({ input: process.stdin })

for await (const line of input) {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    continue
  }
  if (!isRecord(value) || value.type !== "prompt" || typeof value.sessionId !== "string") continue
  const sessionId = value.sessionId
  if (mode === "hold") continue
  if (mode === "huge") {
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "assistant.message", turnId: "turn", text: "x".repeat(128) })}\n`)
    continue
  }
  if (mode === "env") {
    const present = valueFromEnvironment(process.env.RUNRAIL_HARNESS_SECRET)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "assistant.message", turnId: "turn", text: present ? "credential-present" : "credential-absent" })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "session.completed", snapshot: snapshot(sessionId, "completed", 1) })}\n`)
    continue
  }
  if (mode === "length") {
    const length = typeof value.message === "string" ? value.message.length : -1
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "assistant.message", turnId: "turn", text: `length ${length}` })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "session.completed", snapshot: snapshot(sessionId, "completed", 1) })}\n`)
    continue
  }
  if (mode === "fail-stderr") {
    // Why it failed, the key it was given, and a hint after: the error line is the one that says why.
    process.stderr.write(`error: unknown option '--frobnicate' (key ${process.env.RUNRAIL_HARNESS_SECRET ?? "none"})\nhint: see --help\n`)
    process.exitCode = 2
    continue
  }
  if (mode === "approval") {
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "turn.started", turnId: "turn", prompt: "fixture" })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "approval.required", turnId: "turn", approvalId: "fixture-approval", action: "command", capability: "process.exec", reason: "Run make" })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 2, at: 2, type: "session.completed", snapshot: snapshot(sessionId, "completed", 2) })}\n`)
    continue
  }
  if (mode === "auth-failure") {
    process.stderr.write("not logged in; please authenticate with the vendor CLI\n")
    process.exitCode = 1
    continue
  }
  if (mode === "bad") {
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 0, type: "assistant.message", turnId: "turn", text: "bad" })}\n`)
    process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "session.completed", snapshot: snapshot(sessionId, "completed", 1) })}\n`)
    continue
  }
  process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 0, at: 0, type: "turn.started", turnId: "turn", prompt: "fixture" })}\n`)
  process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 1, at: 1, type: "assistant.delta", turnId: "turn", text: "agent" })}\n`)
  process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 2, at: 2, type: "assistant.message", turnId: "turn", text: "agent output" })}\n`)
  process.stdout.write(`${JSON.stringify({ version: 1, sessionId, seq: 3, at: 3, type: "session.completed", snapshot: snapshot(sessionId, "completed", 3) })}\n`)
}

// The backend closes stdin after the prompt; a held agent stays up until it is signalled.
if (mode === "hold") setInterval(() => {}, 60_000)

function snapshot(id: string, status: "completed", lastSeq: number) {
  return { version: 1, id, backend: "command-fixture", cwd: process.cwd(), status, createdAt: 0, updatedAt: lastSeq, lastSeq, capabilities: ["sessions", "streaming"] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function valueFromEnvironment(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0
}
