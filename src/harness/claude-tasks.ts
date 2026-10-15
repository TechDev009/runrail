import { readAnnouncedOutput } from "../background/output-file.ts"
import type { RunrailBackgroundControl, RunrailBackgroundEntry, RunrailBackgroundStatus } from "../live/types.ts"
import type { HarnessEventMappingContext } from "./types.ts"

/**
 * Claude Code's `task_*` system messages (2.1.227: `task_started`, `task_progress`,
 * `task_updated`, `task_notification`, `background_tasks_changed`) as background entries. A shell
 * shows in the Tasks list once Claude Code moves it to the background; a subagent shows at once.
 */
const COMMAND_TYPES: ReadonlySet<string> = new Set(["local_bash"])
const AGENT_TYPES: ReadonlySet<string> = new Set(["local_agent", "remote_agent", "in_process_teammate", "local_workflow"])
const UPDATED_STATUS: Readonly<Record<string, RunrailBackgroundStatus>> = { pending: "running", running: "running", paused: "running", completed: "completed", failed: "failed", killed: "stopped" }
const NOTIFIED_STATUS: Readonly<Record<string, RunrailBackgroundStatus>> = { completed: "completed", failed: "failed", stopped: "stopped" }

type Emit = (entry: Partial<RunrailBackgroundEntry> & { readonly id: string }, control?: RunrailBackgroundControl) => void

/** True when the record was a task message; the caller then maps nothing else from it. */
export function mapClaudeTask(record: Record<string, unknown>, context: Pick<HarnessEventMappingContext, "onLive">, stopTask?: (taskId: string) => Promise<void>): boolean {
  const subtype = record.subtype
  if (record.type !== "system" || typeof subtype !== "string" || (!subtype.startsWith("task_") && subtype !== "background_tasks_changed")) return false
  const emit: Emit = (entry, control) => {
    if (context.onLive === undefined) return
    try {
      context.onLive({ type: "background.state", entry, ...(control === undefined ? {} : { control }) })
    } catch {
      // A task the hub never saw start is dropped there; presentation never fails a turn.
    }
  }
  if (subtype === "background_tasks_changed") {
    for (const task of Array.isArray(record.tasks) ? record.tasks.slice(0, 64) : []) {
      const taskId = id(isRecord(task) ? task.task_id : undefined)
      if (taskId !== undefined) emit({ id: entryId(taskId), foreground: false })
    }
    return true
  }
  const taskId = id(record.task_id)
  if (taskId === undefined) return true
  const key = entryId(taskId)
  switch (subtype) {
    case "task_started": {
      if (record.skip_transcript === true) return true
      const taskType = id(record.task_type)
      const agentType = id(record.subagent_type)
      const kind = taskType !== undefined && COMMAND_TYPES.has(taskType) ? "command" : (taskType !== undefined && AGENT_TYPES.has(taskType)) || (taskType === undefined && agentType !== undefined) ? "agent" : undefined
      if (kind === undefined) return true
      const label = line(record.description) ?? line(record.workflow_name) ?? (kind === "agent" ? "Subagent" : "Command")
      const callId = id(record.tool_use_id)
      const control = stopTask === undefined ? undefined : { stop: () => stopTask(taskId) }
      emit(
        {
          id: key,
          kind,
          label,
          status: "running",
          startedAt: Date.now(),
          ...(agentType === undefined ? {} : { agentType }),
          ...(callId === undefined ? {} : { callId }),
          ...(kind === "command" ? { foreground: true } : {}),
          ...(control === undefined ? { stopHint: "turn" as const } : {}),
        },
        control,
      )
      return true
    }
    case "task_progress": {
      const usage = isRecord(record.usage) ? record.usage : {}
      const detail = line(record.summary) ?? line(record.last_tool_name)
      emit({ id: key, ...counts(usage), ...(detail === undefined ? {} : { detail }) })
      return true
    }
    case "task_updated": {
      const patch = isRecord(record.patch) ? record.patch : {}
      const status = typeof patch.status === "string" ? UPDATED_STATUS[patch.status] : undefined
      const label = line(patch.description)
      const error = line(patch.error)
      emit({
        id: key,
        ...(status === undefined ? {} : { status }),
        ...(label === undefined ? {} : { label }),
        ...(error === undefined ? {} : { detail: error }),
        ...(typeof patch.is_backgrounded === "boolean" ? { foreground: !patch.is_backgrounded } : {}),
        ...(status !== undefined && status !== "running" ? { endedAt: epoch(patch.end_time) ?? Date.now() } : {}),
      })
      return true
    }
    case "task_notification": {
      const status = typeof record.status === "string" ? NOTIFIED_STATUS[record.status] ?? "unknown" : "unknown"
      const summary = line(record.summary)
      const outputFile = typeof record.output_file === "string" && record.output_file.length > 0 ? record.output_file : undefined
      const control = outputFile === undefined ? undefined : { output: (maxBytes: number) => readAnnouncedOutput(outputFile, maxBytes) }
      emit({ id: key, status, endedAt: Date.now(), ...(summary === undefined ? {} : { detail: summary }), ...counts(isRecord(record.usage) ? record.usage : {}) }, control)
      return true
    }
    default:
      return true
  }
}

function entryId(taskId: string): string {
  return `claude:${taskId}`
}

function counts(usage: Record<string, unknown>): Partial<Pick<RunrailBackgroundEntry, "tokens" | "toolUses" | "durationMs">> {
  const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000_000 ? value : undefined)
  const tokens = count(usage.total_tokens)
  const toolUses = count(usage.tool_uses)
  const durationMs = count(usage.duration_ms)
  return { ...(tokens === undefined ? {} : { tokens }), ...(toolUses === undefined ? {} : { toolUses }), ...(durationMs === undefined ? {} : { durationMs }) }
}

function epoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value) ? value : undefined
}

function line(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
