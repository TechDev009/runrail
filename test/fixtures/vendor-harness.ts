import { createInterface } from "node:readline"

const mode = process.argv[2] ?? "codex"
const input = createInterface({ input: process.stdin })

for await (const line of input) {
  let value: unknown
  try { value = JSON.parse(line) as unknown } catch { continue }
  if (!isRecord(value) || value.type !== "prompt") continue
  if (mode === "codex") {
    process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-vendor-thread" })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "turn.started", thread_id: "codex-vendor-thread", turn_id: "turn-1", prompt: "fixture" })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "item.completed", thread_id: "codex-vendor-thread", item: { type: "agent_message", text: "codex answer" } })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "turn.completed", thread_id: "codex-vendor-thread" })}\n`)
  } else if (mode === "claude-failure") {
    process.stdout.write(`${JSON.stringify({ type: "system", session_id: "claude-vendor-session" })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "result", session_id: "claude-vendor-session", is_error: true })}\n`)
  } else if (mode === "claude-auth") {
    process.stdout.write(`${JSON.stringify({ type: "system", session_id: "claude-auth-session" })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "result", session_id: "claude-auth-session", is_error: true, result: "OAuth session expired and could not be refreshed" })}\n`)
    process.stderr.write("OAuth session expired and could not be refreshed\n")
    process.exitCode = 1
  } else {
    process.stdout.write(`${JSON.stringify({ type: "system", session_id: "claude-vendor-session" })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: "claude-vendor-session", message: { content: [{ type: "text", text: "claude answer" }] } })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "result", session_id: "claude-vendor-session", is_error: false })}\n`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
