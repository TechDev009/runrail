import { createInterface } from "node:readline"

const mode = process.argv[2] ?? "codex"
const input = createInterface({ input: process.stdin })

for await (const line of input) {
  let value: unknown
  try { value = JSON.parse(line) as unknown } catch { continue }
  if (!isRecord(value) || value.type !== "prompt") continue
  if (mode === "codex") {
    emit({ type: "thread.started", thread_id: "persistent-codex-thread" })
    emit({ type: "turn.started", thread_id: "persistent-codex-thread", turn_id: "turn-1" })
    emit({ type: "item.completed", thread_id: "persistent-codex-thread", item: { type: "agent_message", text: "persistent codex answer" } })
    emit({ type: "turn.completed", thread_id: "persistent-codex-thread" })
  } else if (mode === "claude-auth") {
    emit({ type: "system", session_id: "persistent-claude-auth" })
    emit({ type: "result", session_id: "persistent-claude-auth", is_error: true, result: "OAuth session expired and could not be refreshed" })
    process.stderr.write("authentication required\n")
    setTimeout(() => process.exit(1), 0)
  } else {
    emit({ type: "system", session_id: "persistent-claude-session" })
    emit({ type: "assistant", session_id: "persistent-claude-session", message: { content: [{ type: "text", text: "persistent claude answer" }] } })
    emit({ type: "result", session_id: "persistent-claude-session", is_error: false })
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
