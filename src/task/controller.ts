import type { AgentEvent } from "@nifrajs/agent-protocol"
import type { RunrailSessionController } from "../control.ts"
import { parseNativeCommand, type NativeCommandName, type NativeCommandResult } from "../native/commands.ts"
import type { NativeEventType } from "../native/events.ts"
import type { NativeTaskInput, NativeTaskKernel, NativeTaskOperationEvent, NativeTaskRecord } from "./types.ts"

export interface NativeTaskController {
  readonly task: NativeTaskRecord
  enqueue(message: string, idempotencyKey: string, signal?: AbortSignal): Promise<NativeCommandResult>
  steer(message: string, idempotencyKey: string, signal?: AbortSignal): Promise<NativeCommandResult>
  start(message: string, idempotencyKey: string, signal?: AbortSignal): Promise<NativeCommandResult>
  snapshot(): Promise<NativeTaskRecord>
  events(afterSeq?: number, maxEvents?: number): readonly import("../native/events.ts").NativeEvent[]
}

export async function createNativeTaskController(
  input: NativeTaskInput,
  controller: RunrailSessionController,
  kernel: NativeTaskKernel,
): Promise<NativeTaskController> {
  return bindNativeTaskController(await kernel.create(input), controller, kernel)
}

export async function openNativeTaskController(
  taskId: string,
  controller: RunrailSessionController,
  kernel: NativeTaskKernel,
): Promise<NativeTaskController> {
  return bindNativeTaskController(await kernel.snapshot(taskId), controller, kernel)
}

function bindNativeTaskController(
  task: NativeTaskRecord,
  controller: RunrailSessionController,
  kernel: NativeTaskKernel,
): NativeTaskController {
  return {
    task,
    enqueue: (message, idempotencyKey, signal) => executeMessage("task.enqueue", message, idempotencyKey, task, controller, kernel, signal),
    steer: (message, idempotencyKey, signal) => executeMessage("task.steer", message, idempotencyKey, task, controller, kernel, signal),
    start: (message, idempotencyKey, signal) => executeMessage("task.start", message, idempotencyKey, task, controller, kernel, signal),
    snapshot: () => kernel.snapshot(task.taskId),
    events: (afterSeq, maxEvents) => kernel.events(task.taskId, afterSeq, maxEvents),
  }
}

async function executeMessage(
  name: Extract<NativeCommandName, "task.enqueue" | "task.steer" | "task.start">,
  message: string,
  idempotencyKey: string,
  task: NativeTaskRecord,
  controller: RunrailSessionController,
  kernel: NativeTaskKernel,
  signal?: AbortSignal,
): Promise<NativeCommandResult> {
  const command = parseNativeCommand({
    contractVersion: 1,
    commandId: `native-command-${idempotencyKey}`,
    idempotencyKey,
    taskId: task.taskId,
    sessionId: task.sessionId,
    name,
    requestedAt: Date.now(),
    timeoutMs: 120_000,
    payload: { message },
  })
  return kernel.execute(command, async (_task, operationSignal) => {
    const events = await (name === "task.steer" ? controller.steer(message, operationSignal) : controller.enqueue(message, operationSignal))
    return {
      status: statusFromAgentEvents(events),
      events: events.map(toNativeOperationEvent),
    }
  }, signal ?? operationSignalFallback())
}

function toNativeOperationEvent(event: AgentEvent): NativeTaskOperationEvent {
  switch (event.type) {
    case "session.started": return { type: "task.started" }
    case "turn.started": return { type: "turn.started", turnId: event.turnId }
    case "tool.started": return { type: "tool.started", metadata: { name: event.name } }
    case "tool.completed": return { type: "tool.completed", metadata: { name: event.name, ok: event.ok } }
    case "approval.required": return { type: "approval.required", capability: event.capability, metadata: { approvalId: event.approvalId } }
    case "approval.resolved": return { type: "approval.resolved", metadata: { approvalId: event.approvalId, approved: event.approved } }
    case "verification.completed": return { type: "verification.completed", code: event.ok ? undefined : "VERIFICATION_FAILED", metadata: { name: event.name, ok: event.ok } }
    case "repair.required": return { type: "repair.attempt", metadata: { taskId: event.task.id, reason: event.task.reason } }
    case "session.completed": return { type: "task.completed", terminal: "completed" }
    case "session.failed": return { type: "task.failed", terminal: "failed", code: event.error.code }
    case "session.stopped": return { type: "task.cancelled", terminal: "cancelled", code: event.reason }
    default: return { type: passthroughType(event.type) }
  }
}

function statusFromAgentEvents(events: readonly AgentEvent[]): "running" | "waiting" | "completed" | "failed" | "cancelled" | undefined {
  if (events.length === 0) return undefined
  if (events.some((event) => event.type === "session.failed")) return "failed"
  if (events.some((event) => event.type === "session.stopped")) return "cancelled"
  if (events.some((event) => event.type === "session.completed")) return "completed"
  if (events.some((event) => event.type === "approval.required")) return "waiting"
  return "running"
}

function passthroughType(type: AgentEvent["type"]): NativeEventType {
  if (type === "session.updated") return "task.started"
  if (type === "assistant.delta" || type === "assistant.message") return "turn.completed"
  if (type === "memory.compacted" || type === "extension.reloaded") return "turn.completed"
  return "turn.completed"
}

function operationSignalFallback(): AbortSignal {
  return new AbortController().signal
}
