import { createRunrailSessionController, type RunrailSessionController } from "./control.ts"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import type { ModelSelection } from "./model/catalog.ts"
import type { RunrailSessionOptions } from "./session.ts"
import { mayContinue } from "./harness/event-text.ts"
import { cloneWorkbenchCommandRegistry, WorkbenchCommandRegistry } from "./workbench/commands.ts"
import { terminalText } from "./workbench/terminal-text.ts"
import { nifraNotice } from "./nifra.ts"
import { createInterface } from "node:readline"

export interface RunrailConsoleOptions extends RunrailSessionOptions {
  readonly input?: AsyncIterable<string>
  readonly output?: { readonly write: (text: string) => void }
  readonly commandRegistry?: WorkbenchCommandRegistry
}

export type RunrailConsoleStatus = "completed" | "stopped" | "failed"

/** Run a thin native console through the same queue and control facade used by API clients. */
export async function runRunrailConsole(options: RunrailConsoleOptions): Promise<RunrailConsoleStatus> {
  const controller = await createRunrailSessionController(options)
  const output = options.output ?? { write: (text: string) => process.stdout.write(text) }
  const input = options.input ?? defaultInput()
  const commandRegistry = options.commandRegistry
    ?? (options.piExtensions === undefined ? new WorkbenchCommandRegistry() : cloneWorkbenchCommandRegistry(options.piExtensions.commandRegistry))
  for (const command of controller.session.plugins?.commands ?? []) {
    if (commandRegistry.get(command.name) === undefined) {
      commandRegistry.register({
        id: command.name,
        description: command.description,
        execute: ({ args }) => command.execute(args.join(" ")),
      })
    }
  }
  const jobs = new Set<Promise<readonly AgentEvent[]>>()
  let failed = false
  let stopped = false
  const render = createEventRenderer(output, controller)
  const unsubscribe = controller.subscribe((event) => {
    // A turn that fails reports it as an event; its promise still resolves.
    if (event.type === "session.failed") failed = true
    render(event)
  })

  const submit = (message: string): void => {
    const job = controller.enqueue(message)
    jobs.add(job)
    void job.then(
      () => {
        jobs.delete(job)
      },
      (error: unknown) => {
        jobs.delete(job)
        if (stopped) return
        failed = true
        output.write(`error: ${terminalText(error instanceof Error ? error.message : String(error))}\n`)
      },
    )
  }

  output.write("Runrail console. Commands: :help, :models, :backends, :model <id>, :backend <name>, :approve <id> [yes|no], :checkpoint, :cancel, :quit\n")
  const nifra = nifraNotice(controller.session.nifraUse())
  if (nifra !== undefined) output.write(`${nifra}\n`)
  try {
    for await (const line of input) {
      const command = line.trim()
      if (command === ":quit" || command === ":exit") {
        stopped = true
        controller.cancel("console closed", true)
        break
      }
    if (command === ":cancel") {
        controller.cancel("console cancelled")
        stopped = true
        output.write("cancelled\n")
      continue
    }
    if (command === ":help") {
      for (const descriptor of commandRegistry.list()) output.write(`${terminalText(`:${descriptor.id}\t${descriptor.description}`)}\n`)
      continue
    }
      if (command === ":models") {
        for (const model of controller.session.listModels()) output.write(`${terminalText(`${model.id}\t${model.tier}\t${model.provider}`)}\n`)
        continue
      }
      if (command === ":backends") {
        for (const backend of controller.listBackends()) output.write(`${terminalText(`${backend.name}\t${backend.version ?? "unknown"}`)}\n`)
        continue
      }
      if (command.startsWith(":backend ")) {
        const backend = command.slice(9).trim()
        if (backend.length === 0) {
          output.write("usage: :backend <name>\n")
          continue
        }
        try {
          const info = await controller.switchBackend(backend)
          output.write(`backend: ${terminalText(info.name)}\n`)
        } catch (error) {
          output.write(`error: ${terminalText(error instanceof Error ? error.message : String(error))}\n`)
        }
        continue
      }
      if (command.startsWith(":model ")) {
        const id = command.slice(7).trim()
        if (id.length === 0) {
          output.write("usage: :model <id>\n")
          continue
        }
        try {
          const model = await controller.switchModel(parseConsoleModelCommand(id))
          output.write(`model: ${terminalText(model.id)}\n`)
        } catch (error) {
          output.write(`error: ${terminalText(error instanceof Error ? error.message : String(error))}\n`)
        }
        continue
      }
      if (command.startsWith(":approve ")) {
        const parts = command.slice(9).trim().split(/\s+/)
        const approvalId = parts[0]
        if (approvalId === undefined || approvalId.length === 0) {
          output.write("usage: :approve <id> [yes|no]\n")
          continue
        }
        const approved = parts[1] !== "no" && parts[1] !== "false"
        try {
          if (await controller.resolveApproval(approvalId, approved) === undefined) output.write(`error: nothing is waiting for approval ${terminalText(approvalId)}\n`)
        } catch (error) {
          output.write(`error: ${terminalText(error instanceof Error ? error.message : "approval failed")}\n`)
        }
        continue
      }
    if (command === ":checkpoint") {
        await controller.session.checkpoint()
        output.write("checkpointed\n")
      continue
    }
    if (command.startsWith(":")) {
      const parts = command.slice(1).trim().split(/\s+/)
      const name = parts.shift()
      if (name === undefined || name.length === 0) {
        output.write("usage: :<command> [args]\n")
        continue
      }
      try {
        const result = await commandRegistry.dispatch(name, parts)
        if (typeof result === "string") output.write(`${terminalText(result)}\n`)
      } catch (error) {
        output.write(`error: ${terminalText(error instanceof Error ? error.message : "command failed")}\n`)
      }
      continue
    }
      if (command.length === 0) continue
      submit(line)
    }
    await Promise.allSettled([...jobs])
  } finally {
    unsubscribe()
    await controller.close(stopped ? "console cancelled" : "console closed")
  }
  if (failed) return "failed"
  return stopped ? "stopped" : "completed"
}

export function parseConsoleModelCommand(value: string): ModelSelection {
  const id = value.trim()
  if (id.length === 0 || id.length > 128) throw new TypeError("console model id is invalid")
  return { id }
}

/** Standard input one line at a time, as text; piped input arrives in chunks that need not end on a line. */
async function* defaultInput(): AsyncIterable<string> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  try {
    for await (const line of lines) yield line
  } finally {
    lines.close()
  }
}

/** Model and tool text can carry terminal escapes, so everything shown passes `terminalText`. */
function createEventRenderer(
  output: { readonly write: (text: string) => void },
  controller: RunrailSessionController,
): (event: AgentEvent) => void {
  // The final message repeats what streamed, so it only ends the line then.
  let streamed = false
  // A reply past one event's text arrives as consecutive messages, printed as one.
  let continuing = false
  return (event) => {
    if (continuing && event.type !== "assistant.message") {
      output.write("\n")
      streamed = false
    }
    continuing = false
    switch (event.type) {
      case "assistant.delta":
        streamed = true
        output.write(terminalText(event.text))
        break
      case "assistant.message":
        if (!streamed) output.write(terminalText(event.text))
        continuing = mayContinue(event.text)
        if (!continuing) {
          output.write("\n")
          streamed = false
        }
        break
      case "tool.started":
        output.write(`[tool ${terminalText(event.name)}]\n`)
        break
      case "approval.required": {
        const id = terminalText(event.approvalId)
        output.write(`[approval ${id}] use :approve ${id} yes|no\n`)
        break
      }
      case "verification.completed":
        output.write(`[verification ${terminalText(event.name)}: ${event.ok ? "passed" : "failed"}]\n`)
        break
      case "session.failed":
        output.write(`session failed: ${terminalText(event.error.code)}\n`)
        break
      case "session.completed":
        if (controller.session.usage !== undefined) {
          const usage = controller.session.usage.snapshot()
          output.write(`[usage ${usage.totalTokens} tokens, ${usage.costUsd.toFixed(6)} USD]\n`)
        }
        break
      default:
        break
    }
  }
}
