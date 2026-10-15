import { createInterface } from "node:readline"

const mode = process.argv[2] ?? "events"
let approvalPending = false

function send(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

const input = createInterface({ input: process.stdin })
for await (const line of input) {
  if (line.trim().length === 0) continue
  const record = JSON.parse(line) as Record<string, unknown>
  if (record.type === "reload") {
    send({
      type: "response",
      command: "reload",
      success: true,
      data: { revision: "fixture:1", loaded: [], disabled: [], rolledBack: false },
    })
    continue
  }
  if (record.type === "abort") {
    send({ type: "agent_end" })
    continue
  }
  if (record.type === "extension_ui_response" && approvalPending) {
    approvalPending = false
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "approved" }] },
    })
    send({ type: "agent_end" })
    continue
  }
  if (record.type !== "prompt") continue
  if (mode === "approval") {
    approvalPending = true
    send({
      type: "extension_ui_request",
      id: "approval-fixture",
      method: "confirm",
      title: "Approve bounded write",
      message: "The fixture requests an approval.",
    })
    continue
  }
  if (mode === "hold") continue
  if (mode === "argv") {
    // The arguments Runrail added after this fixture's own, so a test sees what Pi would be started with.
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(3)) }] } })
    send({ type: "agent_end" })
    continue
  }
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  })
  send({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  })
  if (mode === "events") {
    send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file", args: { path: "index.ts" } })
    send({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read_file",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    })
  }
  send({ type: "agent_end" })
}
