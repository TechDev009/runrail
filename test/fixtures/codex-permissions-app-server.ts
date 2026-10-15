import { createInterface } from "node:readline"

const input = createInterface({ input: process.stdin })
const threadId = "fixture-codex-permission-thread"
const turnId = "fixture-permission-turn"

for await (const line of input) {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    continue
  }
  if (!isRecord(value)) continue
  const method = typeof value.method === "string" ? value.method : undefined
  if (method === "initialize") {
    emit({ id: value.id, result: { userAgent: "runrail-permission-fixture", codexHome: "/tmp/codex-fixture", platformFamily: "unix", platformOs: "test" } })
    continue
  }
  if (method === "initialized") continue
  if (method === "thread/start") {
    emit({ id: value.id, result: { thread: { id: threadId } } })
    emit({ method: "thread/started", params: { thread: { id: threadId } } })
    continue
  }
  if (method === "turn/start") {
    emit({ id: value.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } })
    emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } })
    emit({ method: "item/started", params: { threadId, turnId, item: { id: "fixture-command", type: "commandExecution", status: "inProgress" } } })
    emit({
      id: "fixture-permission-request",
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/tmp",
        itemId: "fixture-command",
        permissions: { fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/tmp" } }] }, network: { enabled: false } },
        reason: "fixture permission",
        startedAtMs: Date.now(),
        threadId,
        turnId,
      },
    })
    continue
  }
  if (value.id === "fixture-permission-request") {
    const result = isRecord(value.result) ? value.result : undefined
    if (!result || !isRecord(result.permissions)) {
      emit({ id: value.id, error: { code: -32003, message: "invalid permission response" } })
      continue
    }
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: "fixture-command", status: "completed", exitCode: 0, aggregatedOutput: "fixture command" }, completedAtMs: Date.now() } })
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "fixture-message", text: "fixture permission answer", phase: null, memoryCitation: null, delivery: null, questions: null }, completedAtMs: Date.now() } })
    emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } })
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
