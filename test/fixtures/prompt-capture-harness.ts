import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

/**
 * A stand-in Claude Code that writes each prompt line it receives to the file named in argv[2],
 * then answers with one turn. It shows what a coding tool was sent; no real CLI runs.
 */
const capture = process.argv[2]
if (capture === undefined) throw new Error("capture path is required")
const input = createInterface({ input: process.stdin })

for await (const line of input) {
  if (line.trim().length === 0) continue
  appendFileSync(capture, `${JSON.stringify(line)}\n`)
  for (const record of [
    { type: "system", subtype: "init", session_id: "capture-session" },
    { type: "assistant", session_id: "capture-session", message: { content: [{ type: "text", text: "tool answer" }] } },
    { type: "result", session_id: "capture-session", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
  ]) process.stdout.write(`${JSON.stringify(record)}\n`)
  break
}
