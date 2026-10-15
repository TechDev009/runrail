import { createInterface } from "node:readline"

/**
 * A stand-in coding tool that answers each prompt line with one turn in its vendor's record shape
 * and the token counts that vendor reports at the end of a turn. Counts only; no real CLI runs.
 */
const vendor = process.argv[2] ?? "claude"
const input = createInterface({ input: process.stdin })

for await (const line of input) {
  if (line.trim().length === 0) continue
  const records = vendor === "codex"
    ? [
        { type: "thread.started", thread_id: "usage-thread" },
        { type: "turn.started", thread_id: "usage-thread", turn_id: "usage-turn" },
        { type: "item.completed", thread_id: "usage-thread", turn_id: "usage-turn", item: { type: "agent_message", text: "done" } },
        // Codex counts cached input inside `input_tokens`.
        { type: "turn.completed", thread_id: "usage-thread", turn_id: "usage-turn", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 40 } },
      ]
    : [
        { type: "system", subtype: "init", session_id: "usage-session" },
        { type: "assistant", session_id: "usage-session", message: { content: [{ type: "text", text: "done" }] } },
        // Claude Code, like Anthropic, reports cached prompt tokens apart from `input_tokens`.
        { type: "result", session_id: "usage-session", is_error: false, usage: { input_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 88, output_tokens: 30 } },
      ]
  for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`)
  break
}
