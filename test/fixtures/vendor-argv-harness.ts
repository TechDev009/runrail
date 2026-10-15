const mode = process.argv[2] ?? "codex"
const prompt = process.argv[3] ?? ""
const received = prompt === "argument prompt" ? "received" : "missing"

if (mode === "codex") {
  emit({ type: "thread.started" })
  emit({ type: "turn.started", turn_id: "turn-1" })
  emit({ type: "item.completed", item: { type: "agent_message", text: `codex argv ${received}` } })
  emit({ type: "turn.completed" })
} else {
  emit({ type: "system" })
  emit({ type: "assistant", message: { content: [{ type: "text", text: `claude argv ${received}` }] } })
  emit({ type: "result", is_error: false })
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export {}
