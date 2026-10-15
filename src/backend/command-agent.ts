import { RUNRAIL_VERSION } from "../version.ts"
import type {
  AgentBackend,
  AgentBackendInfo,
  AgentEvent,
  AgentSessionSnapshot,
  CreateSessionInput,
  ReloadResult,
  SendMessageInput,
} from "@nifrajs/agent-protocol"
import { isAgentEvent } from "@nifrajs/agent-protocol"
import { HarnessAuthError, isRouteEnvironment, parseHarnessAuthOptions, resolveHarnessEnvironment } from "../harness/auth.ts"
import { credentialValues, exitReason, failureWords } from "../harness/failure-words.ts"
import { isMessageMark, isVendorSessionId } from "../harness/launch.ts"
import { mappedEvents, type HarnessAuthOptions, type HarnessEventMapper, type HarnessEventMappingContext, type HarnessMetadataSink } from "../harness/types.ts"
import { vendorSessionEntry, type VendorSessionStore } from "../harness/vendor-session-store.ts"
import type { RunrailLiveSink } from "../live/types.ts"
import { terminateProcessTree } from "./process-tree.ts"
import type { RunrailBackendAdapter } from "./registry.ts"
export type CommandAgentPromptMode = "jsonl" | "argument" | "stdin"
export interface CommandAgentTurn {
  /** The vendor conversation to continue, when an earlier run reported one. */
  readonly vendorSessionId?: string
  /** The conversation is still another program's: continue a copy under a new id. */
  readonly fork?: boolean
  /** With `fork`: the copy continues from this message, as a rewind left it. */
  readonly at?: string
}
export interface CommandAgentBackendOptions {
  readonly name?: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Variables the route sets on the command, such as a tool's config folder. Never a credential. */
  readonly routeEnv?: Readonly<Record<string, string>>
  readonly auth?: HarnessAuthOptions
  /** `jsonl` is the Runrail bridge; `argument` and `stdin` hand the bare prompt to vendor print/exec CLIs. */
  readonly promptMode?: CommandAgentPromptMode
  /** Arguments computed for each run and placed after `args`. */
  readonly turnArgs?: (turn: CommandAgentTurn) => readonly string[]
  /** Keeps the vendor conversation id so a later backend instance continues the same conversation. */
  readonly vendorSessions?: VendorSessionStore
  /** Skip vendor record types the mapper does not know instead of failing the turn. */
  readonly tolerateUnknownEvents?: boolean
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** Maximum normalized events accepted from one command invocation. */
  readonly maxEvents?: number
  readonly eventMapper?: HarnessEventMapper
  /** Caller-owned transient sink for bounded vendor metadata. */
  readonly onMetadata?: HarnessMetadataSink
  /** Caller-owned transient sink for reasoning, plan, and subagent lineage frames. */
  readonly onLive?: RunrailLiveSink
}

export type CommandAgentBackendErrorCode = "COMMAND_AGENT_INVALID" | "COMMAND_AGENT_AUTH_INVALID" | "COMMAND_AGENT_CREDENTIALS_UNAVAILABLE" | "COMMAND_AGENT_NOT_FOUND" | "COMMAND_AGENT_AUTH_FAILED" | "COMMAND_AGENT_RATE_LIMITED" | "COMMAND_AGENT_TIMEOUT" | "COMMAND_AGENT_CANCELLED" | "COMMAND_AGENT_OUTPUT_INVALID" | "COMMAND_AGENT_UNSUPPORTED" | "COMMAND_AGENT_FAILED"

export class CommandAgentBackendError extends Error {
  constructor(readonly code: CommandAgentBackendErrorCode, readonly reason: string) {
    super(`command agent backend: ${reason}`)
    this.name = "CommandAgentBackendError"
  }
}

interface CommandSession {
  snapshot: AgentSessionSnapshot
  active?: Bun.Subprocess<"pipe", "pipe", "pipe">
  cancelled?: string
  running?: boolean
  vendorSessionId?: string
  vendorSessionFork?: boolean
  vendorSessionAt?: string
  /** The vendor's newest message once the last turn ended, in the conversation it belongs to. */
  vendorMark?: { readonly session: string; readonly at: string }
  saving?: Promise<void>
}

/** State of one prompt, shared by every record the command prints for it. */
interface Invocation {
  readonly requestId: string
  readonly turnId: string
  readonly turnState: Map<string, unknown>
  vendorSessionId: string | undefined
  vendorMessageId?: string
}

const MAX_ARGUMENTS = 128
/** What the person reads on a request a print run made; the tool goes on by its own permission settings. */
export const UNANSWERABLE = "This route cannot send an answer back; the tool follows its own permission settings"
const MAX_TURN_ARGUMENT_CHARS = 64 * 1024

/** Provider-neutral command AgentBackend for normalized wrappers and vendor print/exec CLIs. */
export class CommandAgentBackend implements AgentBackend {
  readonly info: AgentBackendInfo
  private readonly options: Required<Pick<CommandAgentBackendOptions, "timeoutMs" | "maxOutputBytes" | "maxEvents">>
  private readonly commandOptions: CommandAgentBackendOptions
  private readonly auth: HarnessAuthOptions
  private readonly promptMode: CommandAgentPromptMode
  private readonly sessions = new Map<string, CommandSession>()
  private sequence = 0
  private turnSequence = 0

  constructor(options: CommandAgentBackendOptions) {
    validateOptions(options)
    try {
      this.auth = parseHarnessAuthOptions(options.auth)
    } catch {
      throw new CommandAgentBackendError("COMMAND_AGENT_AUTH_INVALID", "harness authentication options are invalid")
    }
    this.commandOptions = options
    this.promptMode = options.promptMode ?? "jsonl"
    this.options = { timeoutMs: options.timeoutMs ?? 120_000, maxOutputBytes: options.maxOutputBytes ?? 512 * 1024, maxEvents: options.maxEvents ?? 4_096 }
    this.info = Object.freeze({
      name: options.name ?? "command-agent",
      version: options.version ?? RUNRAIL_VERSION,
      capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming"])].sort()),
    })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.length > 4_096) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "session cwd is invalid")
    const id = input.sessionId ?? `${this.info.name}-${++this.sequence}`
    if (!validId(id) || this.sessions.has(id)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "session id is invalid or already exists")
    const snapshot = makeSnapshot(id, this.info.name, input.cwd, "idle", -1, this.info.capabilities)
    const session: CommandSession = { snapshot }
    this.sessions.set(id, session)
    await this.loadVendorSession(session)
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    return this.run(input)
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    session.cancelled = reason.slice(0, 256)
    if (session.active !== undefined) await terminateProcessTree(session.active)
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId).snapshot
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    this.requireSession(sessionId)
    return Object.freeze({ revision: `${this.info.version}:reload`, loaded: Object.freeze([]), disabled: Object.freeze([]), rolledBack: false })
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.cancelled = "closed"
    if (session.active !== undefined) await terminateProcessTree(session.active)
    await session.saving
    this.sessions.delete(sessionId)
  }

  private async *run(input: SendMessageInput): AsyncGenerator<AgentEvent> {
    if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 256 * 1024) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent message is invalid")
    if (this.promptMode === "argument" && Buffer.byteLength(input.message, "utf8") > 128 * 1024) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "argument-mode prompt exceeds its byte limit")
    const session = this.requireSession(input.sessionId)
    if (session.running === true) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent session is already running")
    session.running = true
    try {
      session.cancelled = undefined
      // A conversation seeded after the session opened (an import continued in this tool) is found here,
      // after the reset above, so a cancel that lands while it loads still stops the turn.
      if (session.vendorSessionId === undefined) await this.loadVendorSession(session)
      const requestId = `runrail-request-${++this.turnSequence}`
      const turnId = `runrail-turn-${this.turnSequence}`
      // Only a command that is told which conversation to continue can find that conversation gone.
      const resume = this.commandOptions.turnArgs === undefined ? undefined : session.vendorSessionId
      const outcome = { resumeMissing: false }
      // A vendor CLI's stream does not say a turn began, so the turn names itself and its prompt first.
      // An agent speaking Runrail's JSONL protocol announces its own turns.
      if (this.promptMode !== "jsonl") yield startTurn(session, turnId, input.message)
      yield* this.invoke(input, session, { requestId, turnId, turnState: new Map(), vendorSessionId: undefined }, resume, outcome)
      if (!outcome.resumeMissing) return
      // The vendor no longer has that conversation. Forget it and run the prompt once from a clean start.
      this.rememberVendorSession(session, undefined)
      if (input.signal?.aborted === true || session.cancelled !== undefined) {
        yield stopTurn(session)
        return
      }
      yield* this.invoke(input, session, { requestId, turnId, turnState: new Map(), vendorSessionId: undefined }, undefined, { resumeMissing: false })
    } finally {
      session.running = false
    }
  }

  private async *invoke(input: SendMessageInput, session: CommandSession, invocation: Invocation, resume: string | undefined, outcome: { resumeMissing: boolean }): AsyncGenerator<AgentEvent> {
    const fork = resume !== undefined && session.vendorSessionFork === true
    const commandArguments = this.commandArguments(input.message, resume, fork, fork ? session.vendorSessionAt : undefined)
    let spawned: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
    let secrets: readonly string[] = []
    try {
      const env = await this.commandEnvironment()
      secrets = credentialValues(env, this.auth.credentialEnvironment)
      // A cancel that lands while the environment resolves has no process to stop; spawning now would orphan one.
      if (input.signal?.aborted !== true && session.cancelled === undefined) {
        spawned = Bun.spawn([this.commandOptions.command, ...commandArguments], { cwd: session.snapshot.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true, env })
      }
    } catch (error) {
      if (isMissingCommand(error)) throw new CommandAgentBackendError("COMMAND_AGENT_NOT_FOUND", "agent command was not found")
      if (error instanceof CommandAgentBackendError) throw error
      throw new CommandAgentBackendError("COMMAND_AGENT_FAILED", "agent command could not start")
    }
    if (spawned === undefined) {
      if (!hasStopped(session.snapshot)) yield stopTurn(session)
      return
    }
    const child = spawned
    const stderrPromise = collectStderr(child.stderr)
    session.active = child
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      void terminateProcessTree(child)
    }, this.options.timeoutMs)
    const abort = (): void => {
      cancelled = true
      session.cancelled = "cancelled"
      void terminateProcessTree(child)
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    try {
      try {
        if (this.promptMode === "jsonl") await child.stdin.write(`${JSON.stringify({ type: "prompt", sessionId: input.sessionId, requestId: invocation.requestId, turnId: invocation.turnId, message: input.message })}\n`)
        else if (this.promptMode === "stdin") await child.stdin.write(input.message)
      } catch {
        // A vendor CLI that exits before it reads the prompt explains itself through its exit status; a cancelled one is stopped below.
        if (this.promptMode !== "stdin" && session.cancelled === undefined) {
          await Promise.race([child.exited, delay(1_000)])
          const words = failureWords(await Promise.race([stderrPromise, delay(1_000).then(() => "")]), secrets)
          throw new CommandAgentBackendError("COMMAND_AGENT_FAILED", words === undefined ? "agent prompt could not be written" : `agent prompt could not be written: ${words}`)
        }
      }
      closeInput(child.stdin)
      const decoder = new TextDecoder()
      let buffer = ""
      let outputBytes = 0
      let eventCount = 0
      // True once the command has done work that a second run would repeat.
      let progressed = false
      const accept = async (line: string): Promise<readonly AgentEvent[]> => {
        const events = validateEvents(line, session, this.commandOptions, invocation)
        if (events.length === 0) {
          this.noteVendorSession(session, invocation)
          return events
        }
        eventCount += events.length
        if (eventCount > this.options.maxEvents) {
          await terminateProcessTree(child)
          throw new CommandAgentBackendError("COMMAND_AGENT_OUTPUT_INVALID", "agent emitted too many events")
        }
        if (events.some((event) => event.type === "session.failed")) await terminateProcessTree(child)
        // A failed run may name a conversation that was never created; only a working one is kept.
        else this.noteVendorSession(session, invocation)
        return events
      }
      const resumeWentMissing = async (): Promise<boolean> => {
        if (resume === undefined || progressed) return false
        await child.exited
        return looksLikeMissingSession(await stderrPromise)
      }
      const maxOutputBytes = this.options.maxOutputBytes
      const lines = async function* (): AsyncGenerator<string> {
        for await (const chunk of child.stdout) {
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
          outputBytes += Buffer.byteLength(text, "utf8")
          if (outputBytes > maxOutputBytes) {
            await terminateProcessTree(child)
            throw new CommandAgentBackendError("COMMAND_AGENT_OUTPUT_INVALID", "agent output exceeded its byte limit")
          }
          buffer += text
          for (;;) {
            const newline = buffer.indexOf("\n")
            if (newline < 0) break
            const line = buffer.slice(0, newline).replace(/\r$/, "")
            buffer = buffer.slice(newline + 1)
            if (line.trim().length > 0) yield line
          }
        }
        buffer += decoder.decode()
        if (buffer.trim().length > 0) yield buffer.trim()
      }
      for await (const line of lines()) {
        const before = session.snapshot
        for (const event of await accept(line)) {
          if (event.type === "turn.started" && this.promptMode !== "jsonl") continue
          if (event.type === "session.failed") {
            if (await resumeWentMissing()) {
              session.snapshot = before
              outcome.resumeMissing = true
              return
            }
            yield event
            throw terminalFailure(event)
          }
          if (event.type !== "session.started") progressed = true
          yield event
          // A print run's input is closed once the prompt is in, so nobody can answer its request:
          // the card says so instead of waiting on the person. A JSONL bridge numbers its own events.
          if (event.type === "approval.required" && this.commandOptions.eventMapper !== undefined) yield settleUnanswerable(session, event)
        }
      }
      const status = await child.exited
      if (timedOut) throw new CommandAgentBackendError("COMMAND_AGENT_TIMEOUT", "agent command timed out")
      if (cancelled || input.signal?.aborted === true || session.cancelled !== undefined) {
        if (!hasStopped(session.snapshot)) yield stopTurn(session)
        return
      }
      const stderr = await stderrPromise
      if (status !== 0) {
        if (resume !== undefined && !progressed && looksLikeMissingSession(stderr)) {
          outcome.resumeMissing = true
          return
        }
        if (looksLikeAuthFailure(stderr)) throw new CommandAgentBackendError("COMMAND_AGENT_AUTH_FAILED", "harness authentication failed")
        throw new CommandAgentBackendError("COMMAND_AGENT_FAILED", exitReason("agent command", status, failureWords(stderr, secrets)))
      }
      if (!hasTerminal(session.snapshot)) {
        const words = failureWords(stderr, secrets)
        throw new CommandAgentBackendError("COMMAND_AGENT_OUTPUT_INVALID", words === undefined ? "agent stream has no terminal event" : `agent stream has no terminal event: ${words}`)
      }
      if (session.vendorSessionId !== undefined && invocation.vendorMessageId !== undefined) session.vendorMark = Object.freeze({ session: session.vendorSessionId, at: invocation.vendorMessageId })
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      // Invalid output or a consumer that stopped reading: the process ends before its handle is dropped.
      if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child)
      session.active = undefined
      // The pointer is on disk before the turn is over, so an engine that stops next still continues it.
      await session.saving
    }
  }

  private requireSession(id: string): CommandSession {
    if (!validId(id)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "session id is invalid")
    const session = this.sessions.get(id)
    if (session === undefined) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent session is unknown")
    return session
  }

  private commandArguments(message: string, resume: string | undefined, fork: boolean, at?: string): readonly string[] {
    const fixed = this.commandOptions.args ?? []
    let turn: readonly string[] = []
    if (this.commandOptions.turnArgs !== undefined) {
      try {
        turn = this.commandOptions.turnArgs(resume === undefined ? {} : { vendorSessionId: resume, ...(fork ? { fork: true } : {}), ...(fork && at !== undefined ? { at } : {}) })
      } catch {
        throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent turn arguments are invalid")
      }
    }
    if (!Array.isArray(turn) || fixed.length + turn.length > MAX_ARGUMENTS || turn.some((arg) => typeof arg !== "string" || arg.length > MAX_TURN_ARGUMENT_CHARS || arg.includes("\0"))) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent turn arguments are invalid")
    if (this.promptMode !== "argument") return Object.freeze([...fixed, ...turn])
    // A prompt that starts with a hyphen would be read as an option; `--` ends the options first.
    return Object.freeze(message.startsWith("-") ? [...fixed, ...turn, "--", message] : [...fixed, ...turn, message])
  }

  /** Where the tool's own conversation stood once the last turn ended. */
  vendorMark(sessionId: string): { readonly session: string; readonly at: string } | undefined {
    return this.sessions.get(sessionId)?.vendorMark
  }

  /**
   * An exact rewind for a tool that continues a conversation from one of its messages: the next run
   * continues a copy of `before`'s conversation from its mark, so nothing after it is seen and the
   * conversation it came from is left as it was. Returns the step that records this, which the
   * caller takes after it forgot the old pointers; undefined when there is no such mark.
   */
  async prepareRewind(sessionId: string, target: { readonly before?: { readonly session: string; readonly at: string } }): Promise<(() => Promise<void>) | undefined> {
    const store = this.commandOptions.vendorSessions
    const before = target.before
    if (store === undefined || this.commandOptions.turnArgs === undefined || before === undefined || !isVendorSessionId(before.session) || !isMessageMark(before.at)) return undefined
    return async () => {
      await store.save(sessionId, before.session, { fork: true, at: before.at })
      const session = this.sessions.get(sessionId)
      if (session === undefined) return
      session.vendorSessionId = before.session
      session.vendorSessionFork = true
      session.vendorSessionAt = before.at
      session.vendorMark = before
    }
  }

  private async loadVendorSession(session: CommandSession): Promise<void> {
    const store = this.commandOptions.vendorSessions
    if (store === undefined) return
    try {
      const stored = await vendorSessionEntry(store, session.snapshot.id)
      if (stored !== undefined && isVendorSessionId(stored.vendorSessionId)) {
        session.vendorSessionId = stored.vendorSessionId
        session.vendorSessionFork = stored.fork
        session.vendorSessionAt = stored.at
      }
    } catch {
      // A lost pointer costs the vendor's history, not the session.
    }
  }

  private noteVendorSession(session: CommandSession, invocation: Invocation): void {
    const reported = invocation.vendorSessionId
    if (reported === undefined || reported === session.vendorSessionId || !isVendorSessionId(reported)) return
    this.rememberVendorSession(session, reported)
  }

  private rememberVendorSession(session: CommandSession, vendorSessionId: string | undefined): void {
    session.vendorSessionId = vendorSessionId
    session.vendorSessionFork = false
    session.vendorSessionAt = undefined
    const store = this.commandOptions.vendorSessions
    if (store === undefined) return
    const id = session.snapshot.id
    // Writes are chained so a later id is never overwritten by an earlier one; a failed write is not a failed turn.
    session.saving = (session.saving ?? Promise.resolve()).then(() => store.save(id, vendorSessionId)).catch(() => {})
  }

  private async commandEnvironment(): Promise<Record<string, string>> {
    try {
      return { ...await resolveHarnessEnvironment(this.commandOptions.env, this.auth), ...this.commandOptions.routeEnv }
    } catch (error) {
      if (error instanceof HarnessAuthError) throw new CommandAgentBackendError("COMMAND_AGENT_CREDENTIALS_UNAVAILABLE", "harness credentials are unavailable")
      throw error
    }
  }
}

export function createCommandAgentBackend(options: CommandAgentBackendOptions): CommandAgentBackend {
  return new CommandAgentBackend(options)
}
export function createCommandAgentAdapter(options: CommandAgentBackendOptions): RunrailBackendAdapter {
  validateOptions(options)
  return {
    name: options.name ?? "command-agent",
    version: options.version ?? RUNRAIL_VERSION,
    capabilities: Object.freeze([...(options.capabilities ?? ["sessions", "streaming"])]),
    create: () => createCommandAgentBackend(options),
  }
}

function validateOptions(options: CommandAgentBackendOptions): void {
  if (options === null || typeof options !== "object" || typeof options.command !== "string" || options.command.length === 0 || options.command.length > 256 || /\s/.test(options.command) || options.command.startsWith("-")) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent command is invalid")
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.length > MAX_ARGUMENTS || options.args.some((arg) => typeof arg !== "string" || arg.length > 4_096))) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent arguments are invalid")
  if (options.name !== undefined && !validId(options.name)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent backend name is invalid")
  if (options.version !== undefined && (typeof options.version !== "string" || options.version.length === 0 || options.version.length > 64)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent backend version is invalid")
  const capabilities = options.capabilities ?? ["sessions", "streaming"]
  if (!Array.isArray(capabilities) || capabilities.length > 32 || capabilities.some((value) => !validCapability(value))) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent backend capabilities are invalid")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent timeout is invalid")
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 1024 * 1024 * 1024)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent output limit is invalid")
  if (options.maxEvents !== undefined && (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 1_000_000)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent event limit is invalid")
  if (options.eventMapper !== undefined && typeof options.eventMapper !== "function") throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent event mapper is invalid")
  if (options.onMetadata !== undefined && typeof options.onMetadata !== "function") throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent metadata sink is invalid")
  if (options.onLive !== undefined && typeof options.onLive !== "function") throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent live sink is invalid")
  if (options.promptMode !== undefined && options.promptMode !== "jsonl" && options.promptMode !== "argument" && options.promptMode !== "stdin") throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent prompt mode is invalid")
  if (options.turnArgs !== undefined && typeof options.turnArgs !== "function") throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent turn arguments are invalid")
  if (options.vendorSessions !== undefined && (options.vendorSessions === null || typeof options.vendorSessions !== "object" || typeof options.vendorSessions.load !== "function" || typeof options.vendorSessions.save !== "function")) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent vendor session store is invalid")
  if (options.tolerateUnknownEvents !== undefined && typeof options.tolerateUnknownEvents !== "boolean") throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent unknown-event setting is invalid")
  if (options.routeEnv !== undefined && !isRouteEnvironment(options.routeEnv)) throw new CommandAgentBackendError("COMMAND_AGENT_INVALID", "agent route environment is invalid")
  try {
    parseHarnessAuthOptions(options.auth)
  } catch {
    throw new CommandAgentBackendError("COMMAND_AGENT_AUTH_INVALID", "harness authentication options are invalid")
  }
}

async function collectStderr(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return ""
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    for await (const chunk of stream) {
      if (bytes >= 16 * 1024) continue
      const decoded = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
      const remaining = 16 * 1024 - bytes
      text += decoded.slice(0, remaining)
      bytes = Buffer.byteLength(text, "utf8")
    }
    if (bytes < 16 * 1024) text += decoder.decode()
    return text.slice(0, 16 * 1024)
  } catch {
    // Stderr is diagnostic-only and may contain credentials; the exit status remains authoritative.
    return ""
  }
}

function looksLikeAuthFailure(stderr: string): boolean {
  return /not\s+(?:logged\s+in|authenticated)|authentication\s+(?:failed|required)|unauthori[sz]ed|login\s+required|sign\s+in|api\s+key|credential|subscription\s+(?:required|expired|inactive)|oauth\s+session\s+expired|session\s+expired|could\s+not\s+be\s+refreshed/i.test(stderr)
}

/** Matches only the vendor's "that conversation does not exist" wording; the text itself is never kept. */
function looksLikeMissingSession(stderr: string): boolean {
  return /no\s+(?:conversation|session|thread|rollout)\s+found|(?:conversation|session|thread|rollout)\s+(?:\S+\s+)?(?:was\s+)?not\s+found|could\s+not\s+find\s+(?:a\s+|the\s+)?(?:conversation|session|thread|rollout)/i.test(stderr)
}

function closeInput(stdin: { end(): unknown }): void {
  try {
    void Promise.resolve(stdin.end()).catch(() => {})
  } catch {
    // The command already closed its input.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isMissingCommand(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.code === "ENOENT"
}

function validateEvents(line: string, session: CommandSession, options: CommandAgentBackendOptions, invocation: Invocation): readonly AgentEvent[] {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    throw new CommandAgentBackendError("COMMAND_AGENT_OUTPUT_INVALID", "agent output is not valid JSONL")
  }
  // Only a JSONL prompt carries Runrail's request id to echo; Claude Code puts its API request id in `request_id`.
  if ((options.promptMode ?? "jsonl") === "jsonl") validateRequestCorrelation(value, invocation.requestId)
  const events: readonly unknown[] = options.eventMapper === undefined ? [value] : mapEvent(value, options.eventMapper, session, options, invocation)
  for (const event of events) {
    if (!isAgentEvent(event) || event.sessionId !== session.snapshot.id || event.seq <= session.snapshot.lastSeq || !ownsSnapshot(event, session)) throw new CommandAgentBackendError("COMMAND_AGENT_OUTPUT_INVALID", "agent output event is invalid")
    session.snapshot = eventSnapshot(event, session.snapshot)
  }
  return events as readonly AgentEvent[]
}

function mapEvent(value: unknown, mapper: HarnessEventMapper, session: CommandSession, options: CommandAgentBackendOptions, invocation: Invocation): readonly AgentEvent[] {
  const context: HarnessEventMappingContext = {
    sessionId: session.snapshot.id,
    cwd: session.snapshot.cwd,
    backend: session.snapshot.backend,
    nextSeq: session.snapshot.lastSeq + 1,
    previous: session.snapshot,
    requestId: invocation.requestId,
    turnId: invocation.turnId,
    turnState: invocation.turnState,
    ...(invocation.vendorSessionId === undefined ? {} : { vendorSessionId: invocation.vendorSessionId }),
    ...(options.tolerateUnknownEvents === true ? { tolerateUnknown: true } : {}),
    ...(options.onMetadata === undefined ? {} : { onMetadata: options.onMetadata }),
    ...(options.onLive === undefined ? {} : { onLive: options.onLive }),
  }
  try {
    const events = mappedEvents(mapper(value, context))
    invocation.vendorSessionId = context.vendorSessionId
    if (context.vendorMessageId !== undefined) invocation.vendorMessageId = context.vendorMessageId
    return events
  } catch (error) {
    if (error instanceof CommandAgentBackendError) throw error
    throw new CommandAgentBackendError("COMMAND_AGENT_OUTPUT_INVALID", "agent output event is unsupported")
  }
}

function terminalFailure(event: AgentEvent): CommandAgentBackendError {
  if (event.type === "session.failed" && event.error.code === "HARNESS_RATE_LIMITED") return new CommandAgentBackendError("COMMAND_AGENT_RATE_LIMITED", event.error.message)
  const authentication = event.type === "session.failed" && event.error.code === "HARNESS_AUTH_FAILED"
  if (authentication) return new CommandAgentBackendError("COMMAND_AGENT_AUTH_FAILED", "harness authentication failed")
  return new CommandAgentBackendError("COMMAND_AGENT_FAILED", event.type === "session.failed" ? event.error.message : "harness reported a failure")
}

function ownsSnapshot(event: AgentEvent, session: CommandSession): boolean {
  return event.type !== "session.started" && event.type !== "session.updated" && event.type !== "session.completed" || (event.snapshot.id === session.snapshot.id && event.snapshot.cwd === session.snapshot.cwd)
}

function eventSnapshot(event: AgentEvent, previous: AgentSessionSnapshot): AgentSessionSnapshot {
  if (event.type === "session.started" || event.type === "session.updated" || event.type === "session.completed") return event.snapshot
  if (event.type === "session.stopped") return makeSnapshot(previous.id, previous.backend, previous.cwd, "stopped", event.seq, previous.capabilities)
  if (event.type === "session.failed") return makeSnapshot(previous.id, previous.backend, previous.cwd, "failed", event.seq, previous.capabilities)
  if (event.type === "approval.required") return makeSnapshot(previous.id, previous.backend, previous.cwd, "waiting", event.seq, previous.capabilities)
  return makeSnapshot(previous.id, previous.backend, previous.cwd, "running", event.seq, previous.capabilities)
}

function startTurn(session: CommandSession, turnId: string, prompt: string): AgentEvent {
  const started: AgentEvent = Object.freeze({ version: 1, sessionId: session.snapshot.id, seq: session.snapshot.lastSeq + 1, at: Date.now(), type: "turn.started", turnId, prompt })
  session.snapshot = eventSnapshot(started, session.snapshot)
  return started
}

/** Settles a request nobody can answer on this route, so no card waits on the person. */
function settleUnanswerable(session: CommandSession, asked: AgentEvent & { readonly type: "approval.required" }): AgentEvent {
  const settled: AgentEvent = Object.freeze({ version: 1, sessionId: session.snapshot.id, seq: session.snapshot.lastSeq + 1, at: Date.now(), type: "approval.resolved", turnId: asked.turnId, approvalId: asked.approvalId, approved: false, withdrawn: true, reason: UNANSWERABLE })
  session.snapshot = eventSnapshot(settled, session.snapshot)
  return settled
}

function stopTurn(session: CommandSession): AgentEvent {
  const stopped: AgentEvent = Object.freeze({ version: 1, sessionId: session.snapshot.id, seq: session.snapshot.lastSeq + 1, at: Date.now(), type: "session.stopped", reason: session.cancelled ?? "cancelled" })
  session.snapshot = makeSnapshot(session.snapshot.id, session.snapshot.backend, session.snapshot.cwd, "stopped", stopped.seq, session.snapshot.capabilities)
  return stopped
}

function makeSnapshot(id: string, backend: string, cwd: string, status: AgentSessionSnapshot["status"], lastSeq: number, capabilities: readonly string[]): AgentSessionSnapshot {
  return Object.freeze({ version: 1, id, backend, cwd, status, createdAt: 0, updatedAt: Date.now(), lastSeq, capabilities: Object.freeze([...capabilities]) })
}

function hasTerminal(snapshot: AgentSessionSnapshot): boolean {
  return snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "stopped"
}

function hasStopped(snapshot: AgentSessionSnapshot): boolean {
  return snapshot.status === "stopped"
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function validateRequestCorrelation(value: unknown, requestId: string): void {
  if (!isRecord(value)) return
  const echoed = value.requestId ?? value.request_id
  if (echoed !== undefined && echoed !== requestId) throw new CommandAgentBackendError("COMMAND_AGENT_OUTPUT_INVALID", "agent output request does not match")
}
