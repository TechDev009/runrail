import type { RunrailBackgroundStatus, RunrailLiveSink } from "../live/types.ts"
import { processGroupAlive, terminateProcessTree } from "../backend/process-tree.ts"
import { filteredEnvironment } from "../workspace/policy.ts"

/**
 * Commands Runrail's own agent starts in the background (`run_command` with `background: true`).
 * Each runs in its own process group so Stop ends its children too, keeps the end of its output in
 * memory, and is stopped when the session closes or the engine shuts down. An engine killed
 * outright (SIGKILL) cannot stop them.
 */
export const MAX_RUNNING_COMMANDS = 4
const MAX_KEPT_COMMANDS = 16
const OUTPUT_CHARS = 256 * 1024
const STOP_GRACE_MS = 3_000

export class BackgroundCommandError extends Error {
  constructor(
    readonly code: "BACKGROUND_LIMIT" | "BACKGROUND_NOT_FOUND" | "BACKGROUND_START_FAILED" | "BACKGROUND_CLOSED",
    message: string,
  ) {
    super(message)
    this.name = "BackgroundCommandError"
  }
}

export interface BackgroundCommandOutput {
  readonly id: string
  readonly running: boolean
  readonly exitCode?: number
  readonly text: string
  /** Pass back as `afterSeq` to read only what came later. */
  readonly nextSeq: number
  /** Output between `afterSeq` and the kept tail was dropped. */
  readonly truncated: boolean
}

interface Command {
  readonly id: string
  readonly child: ReturnType<typeof Bun.spawn>
  output: string
  dropped: number
  running: boolean
  stopped: boolean
  /** The command exited, but processes it started still run in its group. */
  lingering: boolean
  exitCode?: number
  stopping?: Promise<void>
}

export interface NativeBackgroundCommandsOptions {
  readonly root: string
  readonly onLive?: RunrailLiveSink
}

export class NativeBackgroundCommands {
  private readonly commands = new Map<string, Command>()
  private next = 1
  private closed = false

  constructor(private readonly options: NativeBackgroundCommandsOptions) {}

  get running(): number {
    for (const command of this.commands.values()) if (command.lingering && !processGroupAlive(command.child)) command.lingering = false
    return [...this.commands.values()].filter((command) => command.running || command.lingering).length
  }

  start(program: string, args: readonly string[], label: string): { readonly id: string } {
    if (this.closed) throw new BackgroundCommandError("BACKGROUND_CLOSED", "the session is closing")
    if (this.running >= MAX_RUNNING_COMMANDS) throw new BackgroundCommandError("BACKGROUND_LIMIT", `at most ${MAX_RUNNING_COMMANDS} background commands run at once; stop one first`)
    const id = `cmd-${this.next++}`
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([program, ...args], { cwd: this.options.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: filteredEnvironment(), detached: true })
    } catch {
      throw new BackgroundCommandError("BACKGROUND_START_FAILED", `${program} could not start`)
    }
    const command: Command = { id, child, output: "", dropped: 0, running: true, stopped: false, lingering: false }
    this.commands.set(id, command)
    this.prune()
    void this.read(command, child.stdout as ReadableStream<Uint8Array>)
    void this.read(command, child.stderr as ReadableStream<Uint8Array>)
    void child.exited.then(
      (code) => this.finish(command, code),
      () => this.finish(command, undefined),
    )
    this.emit(command, { kind: "command", label, status: "running", startedAt: Date.now(), foreground: false })
    return { id }
  }

  output(id: string, afterSeq = 0, maxChars = 64 * 1024): BackgroundCommandOutput {
    const command = this.find(id)
    const end = command.dropped + command.output.length
    const from = Math.max(afterSeq, command.dropped, end - maxChars)
    return {
      id,
      running: command.running,
      ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
      text: command.output.slice(from - command.dropped),
      nextSeq: end,
      truncated: from > afterSeq,
    }
  }

  async stop(id: string): Promise<void> {
    const command = this.find(id)
    if (!command.running && !(command.lingering && processGroupAlive(command.child))) return
    command.stopped = true
    command.stopping ??= terminateProcessTree(command.child, STOP_GRACE_MS)
    await command.stopping
    command.lingering = false
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.commands.values()].filter((command) => command.running || command.lingering).map((command) => this.stop(command.id).catch(() => undefined)))
  }

  private find(id: string): Command {
    const command = typeof id === "string" ? this.commands.get(id) : undefined
    if (command === undefined) throw new BackgroundCommandError("BACKGROUND_NOT_FOUND", "no background command has that id")
    return command
  }

  private async read(command: Command, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stream) this.append(command, decoder.decode(chunk, { stream: true }))
      this.append(command, decoder.decode())
    } catch {
      // The stream ends with the process.
    }
  }

  private append(command: Command, text: string): void {
    if (text.length === 0) return
    command.output += text
    if (command.output.length > OUTPUT_CHARS) {
      const cut = command.output.length - OUTPUT_CHARS
      command.output = command.output.slice(cut)
      command.dropped += cut
    }
  }

  private finish(command: Command, code: number | undefined): void {
    command.running = false
    command.lingering = processGroupAlive(command.child)
    if (code !== undefined) command.exitCode = code
    const status: RunrailBackgroundStatus = command.stopped ? "stopped" : code === 0 ? "completed" : "failed"
    this.emit(command, { status, endedAt: Date.now(), ...(code === undefined ? {} : { exitCode: code }) })
  }

  private prune(): void {
    for (const [id, command] of this.commands) {
      if (this.commands.size <= MAX_KEPT_COMMANDS) return
      if (!command.running && !command.lingering) this.commands.delete(id)
    }
  }

  private emit(command: Command, entry: Record<string, unknown>): void {
    const onLive = this.options.onLive
    if (onLive === undefined) return
    try {
      onLive({
        type: "background.state",
        entry: { id: `native:${command.id}`, ...entry },
        control: {
          stop: () => this.stop(command.id),
          output: async (maxBytes) => {
            const output = this.output(command.id, 0, maxBytes)
            return { text: output.text, truncated: output.truncated }
          },
        },
      })
    } catch {
      // Presentation only.
    }
  }
}
