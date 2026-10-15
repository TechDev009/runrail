import type { RunrailSessionOptions } from "../session.ts"
import { nifraNotice } from "../nifra.ts"
import type { MultiAgentCoordinator } from "../agents/runner.ts"
import { RunrailSessionController } from "../control.ts"
import { RunrailWorkbench, renderWorkbench } from "./state.ts"
import { TerminalInputDecoder, type WorkbenchKey } from "./input.ts"
import type { WorkbenchResourcePicker } from "./resources.ts"
import type { WorkspaceDiffReview } from "./diff.ts"
import type { WorkbenchTheme } from "./theme.ts"
import { cloneHotkeyRegistry, cloneWorkbenchCommandRegistry, WorkbenchCommandRegistry, type HotkeyRegistry } from "./commands.ts"

export interface RunrailWorkbenchRunnerOptions extends RunrailSessionOptions {
  readonly input?: AsyncIterable<WorkbenchKey>
  readonly output?: { readonly write: (text: string) => void }
  readonly width?: number
  readonly height?: number
  readonly theme?: WorkbenchTheme
  readonly resources?: WorkbenchResourcePicker
  readonly diffReview?: WorkspaceDiffReview
  readonly agentCoordinator?: MultiAgentCoordinator
  readonly commandRegistry?: WorkbenchCommandRegistry
  readonly hotkeyRegistry?: HotkeyRegistry
}

export type WorkbenchRunnerStatus = "completed" | "stopped" | "failed"

/** Run the native workbench over raw terminal keys or a deterministic injected key stream. */
export async function runRunrailWorkbench(
  options: RunrailWorkbenchRunnerOptions,
): Promise<WorkbenchRunnerStatus> {
  const controller = await RunrailSessionController.create(options)
  const commandRegistry = options.commandRegistry
    ?? (options.piExtensions === undefined ? undefined : cloneWorkbenchCommandRegistry(options.piExtensions.commandRegistry))
    ?? (controller.session.plugins?.commands.length === 0 ? undefined : new WorkbenchCommandRegistry())
  const hotkeyRegistry = options.hotkeyRegistry
    ?? (options.piExtensions === undefined ? undefined : cloneHotkeyRegistry(options.piExtensions.hotkeyRegistry))
  for (const command of controller.session.plugins?.commands ?? []) {
    if (commandRegistry?.get(command.name) !== undefined) continue
    commandRegistry?.register({
      id: command.name,
      description: command.description,
      execute: ({ args }) => command.execute(args.join(" ")),
    })
  }
  const workbench = new RunrailWorkbench(controller, {
    width: options.width,
    height: options.height,
    theme: options.theme,
    resources: options.resources,
    diffReview: options.diffReview,
    agentCoordinator: options.agentCoordinator,
    commandRegistry,
    hotkeyRegistry,
  })
  const nifra = nifraNotice(controller.session.nifraUse())
  if (nifra !== undefined) workbench.note(nifra)
  const output = options.output ?? { write: (text: string) => process.stdout.write(text) }
  const input = options.input ?? rawTerminalInput()
  // Bracketed paste: a pasted block arrives marked, so its line breaks never submit it line by line.
  if (options.input === undefined) output.write("\x1b[?2004h")
  let failed = false
  let stopped = false
  let lastRendered: string | undefined
  const writeView = (): void => {
    const rendered = renderWorkbench(workbench.view())
    if (rendered === lastRendered) return
    lastRendered = rendered
    output.write("\x1b[2J\x1b[H" + rendered + "\n")
  }
  const unsubscribeView = workbench.subscribe(() => writeView())
  // A turn that fails reports it as an event; its promise still resolves.
  const unsubscribeFailures = controller.subscribe((event) => {
    if (event.type === "session.failed") failed = true
  })
  writeView()
  try {
    for await (const key of input) {
      try {
        await workbench.dispatch(key)
      } catch (error) {
        failed = true
        output.write(`\nerror: ${error instanceof Error ? error.message : "workbench input failed"}\n`)
      }
      writeView()
      if (key.type === "interrupt") {
        stopped = true
        break
      }
    }
    await workbench.waitForIdle()
  } finally {
    unsubscribeView()
    unsubscribeFailures()
    if (options.input === undefined) output.write("\x1b[?2004l")
    await workbench.close(stopped ? "terminal stopped" : "terminal closed")
  }
  if (failed) return "failed"
  return stopped ? "stopped" : "completed"
}

async function* rawTerminalInput(): AsyncIterable<WorkbenchKey> {
  const input = process.stdin
  if (!input.isTTY || typeof input.setRawMode !== "function")
    throw new Error("WORKBENCH_TTY_REQUIRED")
  const decoder = new TerminalInputDecoder()
  input.setRawMode(true)
  input.resume()
  try {
    for await (const chunk of input) {
      for (const key of decoder.feed(chunk)) yield key
    }
    for (const key of decoder.flush()) yield key
  } finally {
    input.setRawMode(false)
    input.pause()
  }
}
