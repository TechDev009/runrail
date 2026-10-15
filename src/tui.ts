import { createInterface } from "node:readline"
import { MAX_PROMPT_CHARS } from "./context/resources.ts"
import { runRunrailConsole, type RunrailConsoleOptions, type RunrailConsoleStatus } from "./console.ts"
import { runRunrailWorkbench } from "./workbench/runner.ts"
import { TerminalInputError, type WorkbenchKey } from "./workbench/input.ts"

export interface RunrailTuiOptions extends Omit<RunrailConsoleOptions, "input"> {
  readonly historySize?: number
  readonly prompt?: string
  /** Deterministic key stream for tests and embedders. */
  readonly keys?: AsyncIterable<WorkbenchKey>
}

/** Native terminal shell with raw workbench mode on TTYs and readline fallback elsewhere. */
export async function runRunrailTui(options: RunrailTuiOptions): Promise<RunrailConsoleStatus> {
  const { historySize, prompt, keys, ...sessionOptions } = options
  if (keys !== undefined || (process.stdin.isTTY === true && process.stdout.isTTY === true)) {
    const status = await runRunrailWorkbench({
      ...sessionOptions,
      ...(keys === undefined ? {} : { input: keys }),
      width: process.stdout.columns ?? 100,
      height: process.stdout.rows ?? 30,
    })
    return status
  }
  const resolvedHistorySize = historySize ?? 256
  if (!Number.isSafeInteger(resolvedHistorySize) || resolvedHistorySize < 0 || resolvedHistorySize > 2_048)
    throw new RangeError("historySize must be between 0 and 2048")
  const resolvedPrompt = prompt ?? "runrail> "
  if (resolvedPrompt.length > 128) throw new TypeError("terminal prompt is invalid")
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    historySize: resolvedHistorySize,
    prompt: resolvedPrompt,
  })
  const lines = createBufferedLineInput(terminal)
  try {
    return await runRunrailConsole({ ...sessionOptions, input: lines })
  } finally {
    terminal.close()
  }
}

interface PendingLine {
  readonly resolve: (result: IteratorResult<string>) => void
  readonly reject: (error: unknown) => void
}

function createBufferedLineInput(terminal: ReturnType<typeof createInterface>): AsyncIterable<string> {
  const queue: string[] = []
  const pending: PendingLine[] = []
  let closed = false
  let failure: unknown

  const cleanup = (): void => {
    terminal.off("line", onLine)
    terminal.off("close", onClose)
  }
  const settleClose = (): void => {
    while (pending.length > 0) {
      const waiter = pending.shift()!
      if (failure === undefined) waiter.resolve({ done: true, value: undefined as never })
      else waiter.reject(failure)
    }
  }
  const onLine = (line: string): void => {
    if (closed) return
    if (line.length > MAX_PROMPT_CHARS || queue.length >= 2_048) {
      failure = new TerminalInputError("TERMINAL_INPUT_LIMIT", line.length > MAX_PROMPT_CHARS ? "terminal line is too large" : "too many pending terminal lines")
      closed = true
      cleanup()
      terminal.close()
      settleClose()
      return
    }
    const waiter = pending.shift()
    if (waiter === undefined) queue.push(line)
    else waiter.resolve({ done: false, value: line })
  }
  const onClose = (): void => {
    closed = true
    cleanup()
    settleClose()
  }
  terminal.on("line", onLine)
  terminal.once("close", onClose)
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next: (): Promise<IteratorResult<string>> => {
          const line = queue.shift()
          if (line !== undefined) return Promise.resolve({ done: false, value: line })
          if (closed) {
            if (failure !== undefined) return Promise.reject(failure)
            return Promise.resolve({ done: true, value: undefined as never })
          }
          return new Promise<IteratorResult<string>>((resolve, reject) => pending.push({ resolve, reject }))
        },
        return: (): Promise<IteratorResult<string>> => {
          closed = true
          cleanup()
          settleClose()
          return Promise.resolve({ done: true, value: undefined as never })
        },
      }
    },
  }
}
