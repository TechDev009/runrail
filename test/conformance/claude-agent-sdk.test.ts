import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAgentEvent, type AgentEvent } from "@nifrajs/agent-protocol"
import { APPROVAL_NEVER_EXPIRES_AT } from "@nifrajs/coding-agent"
import {
  ClaudeAgentSdkBackend,
  createDefaultBackendRegistry,
  createRunrailSession,
  createFileVendorSessionStore,
  loadClaudeAgentSdk,
  parseClaudeAgentSdk,
  registerClaudeAgentSdk,
  registerClaudeAgentSdkLoader,
  type ClaudeAgentSdk,
  type ClaudeAgentSdkBackendOptions,
  type ClaudeSdkElicitationRequest,
  type ClaudeSdkElicitationResult,
  type ClaudeSdkPermissionResult,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryOptions,
  type ClaudeSdkUserMessage,
  type RunrailLiveFrameInput,
} from "../../src/index.ts"
import { FileTranscriptStore } from "../../src/transcript/store.ts"

type TurnHandler = (text: string, query: FakeQuery) => Promise<void>

/** Stands in for the SDK's query: reads turns from the prompt stream and plays a scripted vendor side. */
class FakeQuery implements ClaudeSdkQuery {
  readonly interrupts: number[] = []
  readonly models: (string | undefined)[] = []
  readonly stoppedTasks: string[] = []
  readonly contextReads: unknown[] = []
  /** What `getContextUsage` and the experimental usage call answer. */
  contextUsage: unknown
  planUsage: unknown
  closed = false
  private readonly output: unknown[] = []
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = []
  private done = false
  private failure: Error | undefined
  private interrupted: (() => void) | undefined
  private readonly input: AsyncIterator<ClaudeSdkUserMessage>

  constructor(readonly options: ClaudeSdkQueryOptions, prompt: AsyncIterable<ClaudeSdkUserMessage>, private readonly onTurn: TurnHandler, start?: (query: FakeQuery) => Promise<void>) {
    this.input = prompt[Symbol.asyncIterator]()
    void this.consume(start)
  }

  /** The next message on the prompt stream, read while a turn is still running. */
  async nextInput(): Promise<ClaudeSdkUserMessage | undefined> {
    const next = await this.input.next()
    return next.done === true ? undefined : next.value
  }

  emit(value: unknown): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value })
    else this.output.push(value)
  }

  end(failure?: Error): void {
    if (this.done) return
    this.done = true
    this.failure = failure
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  ask(toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, signal = new AbortController().signal): Promise<ClaudeSdkPermissionResult> {
    return this.options.canUseTool(toolName, input, { signal, ...extra })
  }

  /** An MCP server's request, passed on as Claude Code does when no hook answers it. */
  elicit(request: ClaudeSdkElicitationRequest, signal = new AbortController().signal): Promise<ClaudeSdkElicitationResult> {
    if (this.options.onElicitation === undefined) throw new Error("no elicitation handler")
    return this.options.onElicitation(request, { signal, requestId: "elicitation-1" })
  }

  /**
   * A tool call as Claude Code makes one that its own rules would let run: the PreToolUse hooks
   * first, and only an "ask" from one of them reaches `canUseTool`.
   */
  async call(toolName: string, input: Record<string, unknown>, permissionMode: string, extra: Record<string, unknown> = {}): Promise<ClaudeSdkPermissionResult | "unasked"> {
    const decision = await this.gate(toolName, input, permissionMode, typeof extra.toolUseID === "string" ? extra.toolUseID : "toolu_hook")
    return decision === "ask" ? await this.ask(toolName, input, extra) : "unasked"
  }

  /** Only the PreToolUse hooks, as Claude Code runs them before its own rules decide. */
  async gate(toolName: string, input: Record<string, unknown>, permissionMode: string, toolUseId: string): Promise<string | undefined> {
    let decision: string | undefined
    for (const matcher of this.options.hooks?.PreToolUse ?? []) {
      for (const hook of matcher.hooks) {
        const output = await hook({ hook_event_name: "PreToolUse", session_id: "vendor-session-1", transcript_path: "/tmp/t.jsonl", cwd: "/tmp", permission_mode: permissionMode, tool_name: toolName, tool_input: input, tool_use_id: toolUseId }, toolUseId, { signal: new AbortController().signal })
        decision = output.hookSpecificOutput?.permissionDecision ?? decision
      }
    }
    return decision
  }

  untilInterrupted(): Promise<void> {
    return new Promise((resolve) => {
      this.interrupted = resolve
    })
  }

  async interrupt(): Promise<unknown> {
    this.interrupts.push(Date.now())
    this.interrupted?.()
    return { still_queued: [] }
  }

  async setModel(model?: string): Promise<void> {
    this.models.push(model)
  }

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId)
  }

  async getContextUsage(options?: unknown): Promise<unknown> {
    this.contextReads.push(options)
    return this.contextUsage
  }

  async readPlanUsage(): Promise<unknown> {
    if (this.planUsage === undefined) throw new Error("no plan")
    return this.planUsage
  }

  close(): void {
    this.closed = true
    this.end()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const value = this.output.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.done) return this.failure === undefined ? Promise.resolve({ done: true, value: undefined }) : Promise.reject(this.failure)
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }

  private async consume(start?: (query: FakeQuery) => Promise<void>): Promise<void> {
    if (start !== undefined) {
      await start(this)
      if (this.done) return
    }
    for (;;) {
      const message = await this.nextInput()
      if (message === undefined || this.done) return
      await this.onTurn(message.message.content, this)
    }
  }
}

function fakeSdk(onTurn: TurnHandler, start?: (query: FakeQuery, index: number) => Promise<void>): { readonly sdk: ClaudeAgentSdk; readonly queries: FakeQuery[] } {
  const queries: FakeQuery[] = []
  const sdk: ClaudeAgentSdk = {
    query: ({ prompt, options }) => {
      const index = queries.length
      const query = new FakeQuery(options, prompt, onTurn, start === undefined ? undefined : (created) => start(created, index))
      queries.push(query)
      return query
    },
  }
  return { sdk, queries }
}

const init = (sessionId = "vendor-session-1") => ({ type: "system", subtype: "init", session_id: sessionId })
const text = (value: string, sessionId = "vendor-session-1") => ({ type: "assistant", session_id: sessionId, parent_tool_use_id: null, message: { content: [{ type: "text", text: value }] } })
const success = (sessionId = "vendor-session-1") => ({ type: "result", subtype: "success", is_error: false, session_id: sessionId })

function backend(sdk: ClaudeAgentSdk, options: Partial<ClaudeAgentSdkBackendOptions> = {}): ClaudeAgentSdkBackend {
  return new ClaudeAgentSdkBackend({ sdk, command: process.execPath, ...options })
}

async function collect(target: ClaudeAgentSdkBackend, sessionId: string, message: string, onEvent?: (event: AgentEvent) => Promise<void> | void): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of target.send({ sessionId, message })) {
    events.push(event)
    await onEvent?.(event)
  }
  return events
}

const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type)

/** Runrail's own events of one type, without the envelope. */
/** Reviews and reviewer notices are live frames: the agent protocol takes only its own events. */
function live(frames: readonly unknown[], type: string): unknown[] {
  return frames.filter((frame) => (frame as { readonly type?: unknown }).type === type)
}

function own(events: readonly AgentEvent[], type: string): Record<string, unknown>[] {
  return events.filter((event) => (event.type as string) === type).map((event) => {
    const { version: _version, sessionId: _sessionId, seq: _seq, at: _at, ...rest } = event as unknown as Record<string, unknown>
    return rest
  })
}

afterEach(() => {
  registerClaudeAgentSdk(undefined)
  registerClaudeAgentSdkLoader(undefined)
})

describe("Claude Agent SDK backend", () => {
  test("runs a turn on the user's claude with a filtered environment and Claude Code's own prompt", async () => {
    process.env.RUNRAIL_SDK_TEST_SECRET = "must-not-leak"
    try {
      const { sdk, queries } = fakeSdk(async (_text, query) => {
        query.emit(init())
        query.emit({ type: "stream_event", session_id: "vendor-session-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } })
        query.emit(text("hello"))
        query.emit(success())
      })
      const target = backend(sdk, { launch: { appendSystemPrompt: "Follow the project rules.", model: "sonnet", effort: "ultra" } })
      const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-basic" })
      const events = await collect(target, session.id, "say hello")
      expect(types(events)).toEqual(["session.started", "turn.started", "assistant.delta", "assistant.message", "session.completed"])
      const options = queries[0]!.options
      expect(options.pathToClaudeCodeExecutable).toBe(process.execPath)
      expect(options.permissionMode).toBe("default")
      expect(options.model).toBe("sonnet")
      expect(options.effort).toBe("max")
      expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Follow the project rules." })
      expect(options.includePartialMessages).toBe(true)
      // A repository's own Claude Code settings (hooks, MCP servers) never load.
      expect(options.settingSources).toEqual(["user"])
      // Runrail's form shows every kind of question, and a question never goes on without an answer.
      expect(options.toolConfig).toEqual({ askUserQuestion: { extendedQuestions: true, previewFormat: "markdown", optionalDescriptions: true } })
      expect(options.settings).toEqual({ askUserQuestionTimeout: "never", dialogExpiry: "never" })
      expect(options.env.RUNRAIL_SDK_TEST_SECRET).toBeUndefined()
      expect(options.env.PATH).toBe(process.env.PATH ?? "")
      expect(options.env.CLAUDE_AGENT_SDK_CLIENT_APP).toStartWith("runrail/")
      await target.close(session.id)
      expect(queries[0]!.closed).toBe(true)
    } finally {
      delete process.env.RUNRAIL_SDK_TEST_SECRET
    }
  })

  test("keeps one process across turns and announces the session once", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit(text("ok"))
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-turns" })
    const first = await collect(target, session.id, "one")
    const second = await collect(target, session.id, "two")
    expect(types(first)[0]).toBe("session.started")
    expect(types(second)).toEqual(["turn.started", "assistant.message", "session.completed"])
    expect(queries.length).toBe(1)
    await target.close(session.id)
  })

  test("asks under Ask: an approved edit runs as Claude Code proposed it", async () => {
    let decision: ClaudeSdkPermissionResult | undefined
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decision = await query.ask("Write", { file_path: "/tmp/hello.txt", content: "hi" }, { toolUseID: "toolu_write", suggestions: [{ type: "addRules", rules: [{ toolName: "Write" }] }] })
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "ask" } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-ask" })
    const events = await collect(target, session.id, "write it", async (event) => {
      if (event.type === "approval.required") {
        expect(event).toMatchObject({ approvalId: "claude-toolu_write", action: "file_change", capability: "filesystem.write", reason: "Write: /tmp/hello.txt" })
        expect(await target.resolveApproval(session.id, event.approvalId, true)).toBe(true)
      }
    })
    expect(types(events)).toEqual(["session.started", "turn.started", "approval.required", "approval.resolved", "session.completed"])
    expect(decision).toEqual({ behavior: "allow", updatedInput: { file_path: "/tmp/hello.txt", content: "hi" } })
    await target.close(session.id)
  })

  test("a session-scoped approval hands back Claude Code's own suggested rule", async () => {
    let decision: ClaudeSdkPermissionResult | undefined
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      // Claude Code suggests saving the rule to the project's local settings; it must stay in the session.
      decision = await query.ask("Bash", { command: "npm test" }, { toolUseID: "toolu_bash", suggestions: [{ ...suggestion, destination: "localSettings" }] })
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "accept-edits" } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-scope" })
    await collect(target, session.id, "test it", async (event) => {
      if (event.type !== "approval.required") return
      expect(event).toMatchObject({ action: "command", capability: "process.exec", reason: "Bash: npm test" })
      expect(target.setApprovalScope(session.id, event.approvalId, "session")).toBe(true)
      await target.resolveApproval(session.id, event.approvalId, true)
    })
    expect(queries[0]!.options.permissionMode).toBe("acceptEdits")
    expect(decision).toEqual({ behavior: "allow", updatedInput: { command: "npm test" }, updatedPermissions: [suggestion] })
    expect(() => target.setApprovalScope(session.id, "claude-unknown", "forever" as never)).toThrow()
    expect(target.setApprovalScope(session.id, "claude-unknown", "session")).toBe(false)
    await target.close(session.id)
  })

  test("Ask asks before a command Claude Code would run unasked; reads stay unasked", async () => {
    const decisions: (ClaudeSdkPermissionResult | "unasked")[] = []
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decisions.push(await query.call("Read", { file_path: "/tmp/a.ts" }, "default"))
      decisions.push(await query.call("Bash", { command: "sleep 1; echo hi" }, "default", { toolUseID: "toolu_sleep" }))
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "ask" } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-gate-ask" })
    const events = await collect(target, session.id, "run it", async (event) => {
      if (event.type !== "approval.required") return
      expect(event).toMatchObject({ approvalId: "claude-toolu_sleep", action: "command", capability: "process.exec", reason: "Bash: sleep 1; echo hi" })
      await target.resolveApproval(session.id, event.approvalId, true)
    })
    expect(queries[0]!.options.permissionMode).toBe("default")
    expect(types(events)).toEqual(["session.started", "turn.started", "approval.required", "approval.resolved", "session.completed"])
    expect(decisions).toEqual(["unasked", { behavior: "allow", updatedInput: { command: "sleep 1; echo hi" } }])
    await target.close(session.id)
  })

  test("Auto-edit asks before commands only; Auto is left to Claude Code unless it fell back to default", async () => {
    const run = async (permissionMode: "accept-edits" | "auto", calls: readonly (readonly [string, string])[]): Promise<{ readonly sdkMode: string; readonly decisions: (ClaudeSdkPermissionResult | "unasked")[] }> => {
      const decisions: (ClaudeSdkPermissionResult | "unasked")[] = []
      const { sdk, queries } = fakeSdk(async (_text, query) => {
        query.emit(init())
        for (const [tool, mode] of calls) decisions.push(await query.call(tool, tool === "Bash" ? { command: "ls" } : { file_path: "/tmp/a.ts" }, mode))
        query.emit(success())
      })
      const target = backend(sdk, { launch: { permissionMode } })
      const session = await target.createSession({ cwd: "/tmp", sessionId: `sdk-gate-${permissionMode}` })
      await collect(target, session.id, "go", async (event) => {
        if (event.type === "approval.required") await target.resolveApproval(session.id, event.approvalId, false)
      })
      await target.close(session.id)
      return { sdkMode: queries[0]!.options.permissionMode, decisions }
    }
    const edits = await run("accept-edits", [["Edit", "acceptEdits"], ["Bash", "acceptEdits"]])
    expect(edits.sdkMode).toBe("acceptEdits")
    expect(edits.decisions).toEqual(["unasked", { behavior: "deny", message: "The user declined this action." }])
    // Claude Code runs an unavailable auto mode as default and says so in the hook's input.
    const auto = await run("auto", [["Bash", "auto"], ["Edit", "auto"], ["Bash", "default"]])
    expect(auto.sdkMode).toBe("auto")
    expect(auto.decisions).toEqual(["unasked", "unasked", { behavior: "deny", message: "The user declined this action." }])
  })

  test("shows what Claude Code denied without asking: its auto mode's reviewer, a rule, or its mode", async () => {
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit({ ...init(), permissionMode: "auto" })
      query.emit({ type: "assistant", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_push", name: "Bash", input: { command: "git push --force\norigin main" } }] } })
      query.emit({ type: "system", subtype: "permission_denied", session_id: "vendor-session-1", tool_name: "Bash", tool_use_id: "toolu_push", decision_reason_type: "classifier", decision_reason: "Force-pushes over\nshared history.", message: "Permission to use Bash has been denied." })
      query.emit({ type: "user", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_push", is_error: true, content: "Permission denied" }] } })
      // A call the stream never named still shows, without what it named.
      query.emit({ type: "system", subtype: "permission_denied", session_id: "vendor-session-1", tool_name: "Write", tool_use_id: "toolu_unseen", decision_reason_type: "rule", message: "Denied by a rule." })
      query.emit({ type: "system", subtype: "permission_denied", session_id: "vendor-session-1", tool_name: "WebFetch", tool_use_id: "toolu_mode", decision_reason_type: "mode", message: "Not in this mode." })
      query.emit({ type: "system", subtype: "permission_denied", session_id: "vendor-session-1", tool_name: "Bash", tool_use_id: "bad id!", decision_reason_type: "classifier", message: "malformed" })
      query.emit(text("done"))
      query.emit(success())
    })
    const frames: unknown[] = []
    const target = backend(sdk, { launch: { permissionMode: "auto" }, onLive: (frame) => frames.push(frame) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-denials" })
    const events = await collect(target, session.id, "go")
    expect(events.every((event) => isAgentEvent(event))).toBe(true)
    expect(live(frames, "approval.reviewed")).toEqual([
      { type: "approval.reviewed", turnId: "turn-1", reviewId: "claude-denied-toolu_push", reviewer: "claude-code", decision: "denied", action: "command", capability: "process.exec", source: "reviewer", detail: "git push --force origin main", rationale: "Force-pushes over shared history." },
      { type: "approval.reviewed", turnId: "turn-1", reviewId: "claude-denied-toolu_unseen", reviewer: "claude-code", decision: "denied", action: "file_change", capability: "filesystem.write", source: "rule", rationale: "Denied by a rule." },
      { type: "approval.reviewed", turnId: "turn-1", reviewId: "claude-denied-toolu_mode", reviewer: "claude-code", decision: "denied", action: "permission", capability: "network.request", source: "mode", rationale: "Not in this mode." },
    ])
    // The denied call ends as Claude Code's denial, not a failure and not the person's.
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ callId: "toolu_push", ok: false, error: { code: "REVIEW_DENIED" } })
    // Claude Code ran auto mode as asked, so nothing says it is missing.
    expect(live(frames, "reviewer.notice")).toEqual([])
    expect(types(events)).not.toContain("approval.required")
    await target.close(session.id)
  })

  test("under Ask, a call Claude Code refuses before asking reads as its denial; one the person refuses does not", async () => {
    const use = (id: string, command: string) => ({ type: "assistant", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } })
    const failed = (id: string) => ({ type: "user", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "denied" }] } })
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      // A deny rule in the project's settings: the gate asks, and Claude Code refuses before its prompt, reporting nothing.
      query.emit(use("toolu_rule", "echo denied-check"))
      expect(await query.gate("Bash", { command: "echo denied-check" }, "default", "toolu_rule")).toBe("ask")
      query.emit(failed("toolu_rule"))
      query.emit(use("toolu_person", "rm -rf build"))
      await query.call("Bash", { command: "rm -rf build" }, "default", { toolUseID: "toolu_person" })
      query.emit(failed("toolu_person"))
      query.emit(text("done"))
      query.emit(success())
    })
    const frames: unknown[] = []
    const target = backend(sdk, { launch: { permissionMode: "ask" }, onLive: (frame) => frames.push(frame) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-unasked-denial" })
    const events = await collect(target, session.id, "go", async (event) => {
      if (event.type === "approval.required") await target.resolveApproval(session.id, event.approvalId, false)
    })
    expect(live(frames, "approval.reviewed")).toEqual([{ type: "approval.reviewed", turnId: "turn-1", reviewId: "claude-denied-toolu_rule", reviewer: "claude-code", decision: "denied", action: "command", capability: "process.exec", detail: "echo denied-check" }])
    const completed = events.filter((event) => event.type === "tool.completed")
    expect(completed[0]).toMatchObject({ callId: "toolu_rule", ok: false, error: { code: "REVIEW_DENIED" } })
    expect(completed[1]).toMatchObject({ callId: "toolu_person", ok: false, error: { code: "HARNESS_TOOL_FAILED", message: "denied" } })
    await target.close(session.id)
  })

  test("a call the gate asked about that fails because the turn was stopped is not a denial", async () => {
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      expect(await query.gate("Bash", { command: "sleep 60" }, "default", "toolu_stop")).toBe("ask")
      query.emit({ type: "assistant", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_stop", name: "Bash", input: { command: "sleep 60" } }] } })
      await query.untilInterrupted()
      query.emit({ type: "user", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_stop", is_error: true, content: "Interrupted" }] } })
      query.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "vendor-session-1" })
    })
    const frames: unknown[] = []
    const target = backend(sdk, { launch: { permissionMode: "ask" }, onLive: (frame) => frames.push(frame) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-gated-stop" })
    const events = await collect(target, session.id, "wait", async (event) => {
      if (event.type === "tool.started") await target.interrupt(session.id, "user stopped")
    })
    expect(live(frames, "approval.reviewed")).toEqual([])
    const completed = events.find((event) => event.type === "tool.completed")
    expect(completed).toMatchObject({ callId: "toolu_stop", ok: false, error: { code: "HARNESS_TOOL_FAILED", message: "Interrupted" } })
    expect(types(events).at(-1)).toBe("session.stopped")
    await target.close(session.id)
  })

  test("a call Claude Code refuses on its own ends with its reason, not as a denial", async () => {
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "assistant", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "todo" } }] } })
      query.emit({ type: "user", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_grep", is_error: true, content: "<tool_use_error>Error: No such tool available: Grep.</tool_use_error>" }] } })
      query.emit(text("done"))
      query.emit(success())
    })
    const frames: unknown[] = []
    const target = backend(sdk, { launch: { permissionMode: "ask" }, onLive: (frame) => frames.push(frame) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-refused-tool" })
    const events = await collect(target, session.id, "go")
    expect(events.every((event) => isAgentEvent(event))).toBe(true)
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ callId: "toolu_grep", name: "Grep", ok: false, error: { code: "HARNESS_TOOL_FAILED", message: "Error: No such tool available: Grep." } })
    expect(live(frames, "approval.reviewed")).toEqual([])
    await target.close(session.id)
  })

  test("Auto says when Claude Code runs it as default, once until it changes; Ask and plan mode never do", async () => {
    const run = async (permissionMode: "ask" | "auto", reported: readonly string[]): Promise<unknown[][]> => {
      let turn = 0
      const { sdk } = fakeSdk(async (_text, query) => {
        query.emit({ ...init(), permissionMode: reported[turn++] })
        query.emit(text("ok"))
        query.emit(success())
      })
      const frames: unknown[] = []
      const target = backend(sdk, { launch: { permissionMode }, onLive: (frame) => frames.push(frame) })
      const session = await target.createSession({ cwd: "/tmp", sessionId: `sdk-fallback-${permissionMode}` })
      const notices: unknown[][] = []
      for (let index = 0; index < reported.length; index += 1) {
        const before = frames.length
        await collect(target, session.id, "go")
        notices.push(live(frames.slice(before), "reviewer.notice"))
      }
      await target.close(session.id)
      return notices
    }
    const unavailable = (turnId: string) => [{ type: "reviewer.notice", turnId, reviewer: "claude-code", notice: "unavailable" }]
    expect(await run("auto", ["default", "default", "auto", "plan", "default"])).toEqual([unavailable("turn-1"), [], [], [], unavailable("turn-5")])
    expect(await run("ask", ["default", "default"])).toEqual([[], []])
  })

  test("allow for this session covers later calls by Claude Code's own rule, never a chained command", async () => {
    const decisions: (ClaudeSdkPermissionResult | "unasked")[] = []
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" }
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decisions.push(await query.call("Bash", { command: "npm test" }, "default", { toolUseID: "toolu_first", suggestions: [suggestion] }))
      decisions.push(await query.call("Bash", { command: "npm test -- --watch" }, "default", { toolUseID: "toolu_again" }))
      decisions.push(await query.call("Bash", { command: "npm test && rm -rf build" }, "default", { toolUseID: "toolu_chained" }))
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "ask" } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-gate-session" })
    const asked: string[] = []
    await collect(target, session.id, "test it", async (event) => {
      if (event.type !== "approval.required") return
      asked.push(event.approvalId)
      if (event.approvalId === "claude-toolu_first") target.setApprovalScope(session.id, event.approvalId, "session")
      await target.resolveApproval(session.id, event.approvalId, event.approvalId === "claude-toolu_first")
    })
    expect(asked).toEqual(["claude-toolu_first", "claude-toolu_chained"])
    expect(decisions).toEqual([
      { behavior: "allow", updatedInput: { command: "npm test" }, updatedPermissions: [suggestion] },
      { behavior: "allow", updatedInput: { command: "npm test -- --watch" } },
      { behavior: "deny", message: "The user declined this action." },
    ])
    await target.close(session.id)
  })

  test("a tool that asks every time is never allowed for the session, and each approval of it is reported", async () => {
    const decisions: (ClaudeSdkPermissionResult | "unasked")[] = []
    const approved: [string, unknown][] = []
    const send = "mcp__runrail_connectors__slack_sendMessage"
    const suggestion = { type: "addRules", rules: [{ toolName: send }], behavior: "allow", destination: "session" }
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decisions.push(await query.call(send, { channel: "C1", text: "one" }, "bypassPermissions", { toolUseID: "toolu_one", suggestions: [suggestion] }))
      decisions.push(await query.call(send, { channel: "C1", text: "two" }, "bypassPermissions", { toolUseID: "toolu_two" }))
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "bypass", allowedTools: ["mcp__runrail_connectors"], askTools: [send] }, onApproved: (tool, input) => approved.push([tool, input]) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-ask-every-time" })
    const asked: string[] = []
    await collect(target, session.id, "post", async (event) => {
      if (event.type !== "approval.required") return
      asked.push(event.approvalId)
      target.setApprovalScope(session.id, event.approvalId, "session")
      await target.resolveApproval(session.id, event.approvalId, event.approvalId === "claude-toolu_one")
    })
    expect(asked).toEqual(["claude-toolu_one", "claude-toolu_two"])
    expect(decisions).toEqual([
      { behavior: "allow", updatedInput: { channel: "C1", text: "one" } },
      { behavior: "deny", message: "The user declined this action." },
    ])
    expect(approved).toEqual([[send, { channel: "C1", text: "one" }]])
    await target.close(session.id)
  })

  test("a tool the launch lets run unasked stays unasked under Ask", async () => {
    const decisions: (ClaudeSdkPermissionResult | "unasked")[] = []
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decisions.push(await query.call("mcp__runrail_browser__click", { selector: "#go" }, "default"))
      decisions.push(await query.call("mcp__github__create_issue", { title: "x" }, "default", { toolUseID: "toolu_issue" }))
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "ask", allowedTools: ["mcp__runrail_browser"] } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-gate-allowed" })
    await collect(target, session.id, "go", async (event) => {
      if (event.type === "approval.required") await target.resolveApproval(session.id, event.approvalId, false)
    })
    expect(decisions).toEqual(["unasked", { behavior: "deny", message: "The user declined this action." }])
    await target.close(session.id)
  })

  test("a declined approval tells Claude Code why", async () => {
    let decision: ClaudeSdkPermissionResult | undefined
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decision = await query.ask("Edit", { file_path: "/tmp/a.ts" }, { toolUseID: "toolu_edit" })
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-deny" })
    await collect(target, session.id, "edit", async (event) => {
      if (event.type === "approval.required") await target.resolveApproval(session.id, event.approvalId, false, "not this file")
    })
    // The model hears who said no, with the person's note after it.
    expect(decision).toEqual({ behavior: "deny", message: "The user declined this action: not this file" })
    expect(await target.resolveApproval(session.id, "claude-toolu_edit", true)).toBe(false)
    await target.close(session.id)
  })

  test("a long note from the person reaches Claude Code cut short, never as a stock word", async () => {
    let decision: ClaudeSdkPermissionResult | undefined
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decision = await query.ask("Edit", { file_path: "/tmp/a.ts" }, { toolUseID: "toolu_long" })
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-deny-long" })
    const note = `use the helper in utils instead ${"x".repeat(3_000)}`
    await collect(target, session.id, "edit", async (event) => {
      if (event.type === "approval.required") await target.resolveApproval(session.id, event.approvalId, false, note)
    })
    const message = decision?.behavior === "deny" ? decision.message : ""
    expect(message.startsWith("The user declined this action: use the helper in utils instead")).toBe(true)
    expect(message.endsWith("...")).toBe(true)
    expect(message).not.toContain("cancelled")
    await target.close(session.id)
  })

  test("leaving plan mode is an approval; a question is sent back to the reply", async () => {
    const decisions: ClaudeSdkPermissionResult[] = []
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decisions.push(await query.ask("AskUserQuestion", { questions: [] }, { toolUseID: "toolu_q" }))
      decisions.push(await query.ask("ExitPlanMode", { plan: "steps" }, { toolUseID: "toolu_plan" }))
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "plan" } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-plan" })
    const approvals: AgentEvent[] = []
    await collect(target, session.id, "plan", async (event) => {
      if (event.type !== "approval.required") return
      approvals.push(event)
      await target.resolveApproval(session.id, event.approvalId, true)
    })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ approvalId: "claude-toolu_plan", action: "plan", reason: "Leave plan mode and start making changes" })
    expect(decisions[0]).toMatchObject({ behavior: "deny" })
    expect(decisions[1]).toMatchObject({ behavior: "allow" })
    await target.close(session.id)
  })

  describe("a question Claude Code asks the person", () => {
    const asked = [
      { question: "Which library should we use?", header: "Library", options: [{ label: "date-fns", description: "Small" }, { label: "Luxon", description: "Time zones" }], multiSelect: false },
      { question: "Which checks should run?", header: "Checks", options: [{ label: "Tests", description: "" }, { label: "Lint", description: "" }], multiSelect: true },
    ]
    let sessions = 0
    const run = async (respond: (target: ClaudeAgentSdkBackend, sessionId: string, approvalId: string) => Promise<void>, input: Record<string, unknown> = { questions: asked }) => {
      const decisions: ClaudeSdkPermissionResult[] = []
      const { sdk } = fakeSdk(async (_text, query) => {
        query.emit(init())
        query.emit({ type: "assistant", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input }] } })
        const decision = await query.ask("AskUserQuestion", input, { toolUseID: "toolu_q" })
        decisions.push(decision)
        const result = decision.behavior === "allow" ? { content: "User has answered your questions." } : { is_error: true, content: `<tool_use_error>${decision.message}</tool_use_error>` }
        query.emit({ type: "user", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", ...result }] } })
        query.emit(text("ok"))
        query.emit(success())
      })
      const target = backend(sdk, { launch: { permissionMode: "ask" } })
      const session = await target.createSession({ cwd: "/tmp", sessionId: `sdk-question-${++sessions}` })
      const events = await collect(target, session.id, "go", async (event) => {
        if (event.type === "approval.required") await respond(target, session.id, event.approvalId)
      })
      await target.close(session.id)
      return { decision: decisions[0], events, completed: events.find((event) => event.type === "tool.completed") }
    }

    test("shows its questions and hands back the person's answers, keyed as Claude Code reads them", async () => {
      const { decision, events, completed } = await run(async (target, sessionId, approvalId) => {
        expect(target.setApprovalAnswers(sessionId, approvalId, { q1: ["Luxon"], q2: ["Tests", "Lint"] })).toBe(true)
        expect(await target.resolveApproval(sessionId, approvalId, true)).toBe(true)
      })
      expect(events.find((event) => event.type === "approval.required")).toMatchObject({
        approvalId: "claude-toolu_q",
        action: "question",
        capability: "user.input",
        reason: "Which library should we use? (and 1 more)",
        questions: [
          { id: "q1", question: "Which library should we use?", header: "Library", options: [{ label: "date-fns", description: "Small" }, { label: "Luxon", description: "Time zones" }], other: true },
          { id: "q2", question: "Which checks should run?", header: "Checks", options: [{ label: "Tests" }, { label: "Lint" }], multiSelect: true, other: true },
        ],
      })
      expect(decision).toEqual({ behavior: "allow", updatedInput: { questions: asked, answers: { "Which library should we use?": "Luxon", "Which checks should run?": "Tests, Lint" } } })
      expect(events.find((event) => event.type === "approval.resolved")).toMatchObject({ approvalId: "claude-toolu_q", approved: true, answers: { q1: ["Luxon"], q2: ["Tests", "Lint"] } })
      expect(completed).toMatchObject({ callId: "toolu_q", ok: true })
      expect(events.every((event) => isAgentEvent(event))).toBe(true)
    })

    test("every kind it asks is shown, and the answers go back with the picked choice's preview", async () => {
      const extended = {
        title: "Set up the deck",
        questions: [
          { question: "Which layout?", header: "Layout", options: [{ label: "Grid (Recommended)", description: "Even", preview: "| a | b |" }, { label: "Stack", description: "One column", preview: "a\nb" }] },
          { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "Tests" }, { label: "Lint" }] },
          { question: "What should the title say?", header: "Title", kind: "text", placeholder: "A short title" },
          { question: "How many slides?", header: "Slides", kind: "number", min: 1, max: 20, step: 1, defaultValue: 5, unit: "slides" },
        ],
      }
      const { decision, events } = await run(async (target, sessionId, approvalId) => {
        expect(() => target.setApprovalAnswers(sessionId, approvalId, { q1: ["Stack"], q2: ["Lint"], q3: ["Deck"], q4: ["25"] })).toThrow("from 1 to 20")
        target.setApprovalAnswers(sessionId, approvalId, { q1: ["Grid (Recommended)"], q2: ["Tests", "a check of my own"], q3: ["Q3 review"], q4: ["8"] })
        expect(await target.resolveApproval(sessionId, approvalId, true)).toBe(true)
      }, extended)
      expect(events.find((event) => event.type === "approval.required")).toMatchObject({
        reason: "Set up the deck",
        questions: [
          { id: "q1", options: [{ label: "Grid (Recommended)", recommended: true, preview: "| a | b |" }, { label: "Stack", preview: "a\nb" }], other: true },
          { id: "q2", multiSelect: true, other: true },
          { id: "q3", kind: "text", placeholder: "A short title", other: true },
          { id: "q4", kind: "number", min: 1, max: 20, step: 1, defaultValue: 5, unit: "slides" },
        ],
      })
      expect(decision).toEqual({
        behavior: "allow",
        updatedInput: {
          ...extended,
          answers: { "Which layout?": "Grid (Recommended)", "Which checks?": "Tests, a check of my own", "What should the title say?": "Q3 review", "How many slides?": "8" },
          annotations: { "Which layout?": { preview: "| a | b |" } },
        },
      })
    })

    test("the person may ask for more questions, with the answers so far and a note", async () => {
      // Claude Code names every question's kind when extended questions are on.
      const extended = {
        questions: [
          { question: "Which layout?", header: "Layout", kind: "choice", multiSelect: false, options: [{ label: "Grid" }, { label: "Stack" }] },
          { question: "How many slides?", header: "Slides", kind: "number", min: 1, max: 20, options: [], multiSelect: false },
        ],
      }
      const { decision, events } = await run(async (target, sessionId, approvalId) => {
        expect(() => target.setApprovalAnswers(sessionId, approvalId, { q2: ["30"] }, {})).toThrow("from 1 to 20")
        target.setApprovalAnswers(sessionId, approvalId, { q1: ["Grid"] }, { note: "Ask about colours too" })
        expect(await target.resolveApproval(sessionId, approvalId, true)).toBe(true)
      }, extended)
      expect(events.find((event) => event.type === "approval.required")).toMatchObject({ takesFollowUp: true })
      expect(decision).toEqual({ behavior: "allow", updatedInput: { ...extended, answers: { "Which layout?": "Grid" }, followUp: true, response: "Ask about colours too" } })
      expect(events.find((event) => event.type === "approval.resolved")).toMatchObject({ approved: true, answers: { q1: ["Grid"] }, followUp: true, note: "Ask about colours too" })

      const none = await run(async (target, sessionId, approvalId) => {
        target.setApprovalAnswers(sessionId, approvalId, {}, {})
        await target.resolveApproval(sessionId, approvalId, true)
      }, extended)
      expect(none.decision).toEqual({ behavior: "allow", updatedInput: { ...extended, answers: {}, followUp: true } })
    })

    test("questions without kinds cannot be followed up, since Claude Code would refuse it", async () => {
      const { decision, events } = await run(async (target, sessionId, approvalId) => {
        expect(() => target.setApprovalAnswers(sessionId, approvalId, { q1: ["Luxon"] }, {})).toThrow("cannot be asked for more questions")
        await target.resolveApproval(sessionId, approvalId, false)
      })
      expect(events.find((event) => event.type === "approval.required")).not.toHaveProperty("takesFollowUp")
      expect(decision).toMatchObject({ behavior: "deny" })
    })

    test("answers that do not fit are refused and the question keeps waiting", async () => {
      const { decision } = await run(async (target, sessionId, approvalId) => {
        expect(() => target.setApprovalAnswers(sessionId, approvalId, { q1: ["date-fns", "Luxon"], q2: ["Tests"] })).toThrow("single-choice")
        expect(() => target.setApprovalAnswers(sessionId, approvalId, { q1: ["Luxon"] })).toThrow("every question")
        expect(() => target.setApprovalAnswers(sessionId, approvalId, { q1: ["Luxon"], q2: ["Tests"], q3: ["x"] })).toThrow("names no question")
        expect(target.setApprovalAnswers(sessionId, "claude-unknown", { q1: ["Luxon"] })).toBe(false)
        // Claude Code always takes a written answer of the person's own.
        target.setApprovalAnswers(sessionId, approvalId, { q1: ["Temporal, once it ships"], q2: ["Tests"] })
        await target.resolveApproval(sessionId, approvalId, true)
      })
      expect(decision).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which library should we use?": "Temporal, once it ships", "Which checks should run?": "Tests" } } })
    })

    test("one the person declines tells Claude Code so, with their words", async () => {
      const { decision, completed, events } = await run(async (target, sessionId, approvalId) => {
        await target.resolveApproval(sessionId, approvalId, false, "pick yourself")
      })
      expect(decision).toEqual({ behavior: "deny", message: "The user chose not to answer: pick yourself" })
      expect(events.find((event) => event.type === "approval.resolved")).not.toHaveProperty("answers")
      expect(completed).toMatchObject({ ok: false, error: { code: "HARNESS_TOOL_FAILED", message: "The user chose not to answer: pick yourself" } })
    })

    test("approving it without answers is refused in every mode, and it keeps waiting for the person", async () => {
      for (const permissionMode of ["ask", "auto", "bypass"] as const) {
        const decisions: ClaudeSdkPermissionResult[] = []
        const { sdk } = fakeSdk(async (_text, query) => {
          query.emit(init())
          decisions.push(await query.ask("AskUserQuestion", { questions: asked }, { toolUseID: "toolu_q" }))
          query.emit(success())
        })
        const target = backend(sdk, { launch: { permissionMode } })
        const session = await target.createSession({ cwd: "/tmp", sessionId: `sdk-question-unanswered-${permissionMode}` })
        const events = await collect(target, session.id, "go", async (event) => {
          if (event.type !== "approval.required") return
          expect(event).toMatchObject({ action: "question", questions: [{ id: "q1" }, { id: "q2" }] })
          await expect(target.resolveApproval(session.id, event.approvalId, true)).rejects.toThrow("answer it or decline it")
          expect(decisions).toHaveLength(0)
          target.setApprovalAnswers(session.id, event.approvalId, { q1: ["Luxon"], q2: ["Tests"] })
          expect(await target.resolveApproval(session.id, event.approvalId, true)).toBe(true)
        })
        await target.close(session.id)
        expect(decisions[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which library should we use?": "Luxon" } } })
        expect(events.filter((event) => event.type === "approval.resolved")).toHaveLength(1)
      }
    })

    test("a malformed question is not shown; Claude Code asks in its reply", async () => {
      let asked = false
      const { decision, completed } = await run(async () => {
        asked = true
      }, { questions: [{ question: "Which?", options: "none" }] })
      expect(asked).toBe(false)
      expect(decision).toMatchObject({ behavior: "deny", message: expect.stringContaining("Ask the user in your reply instead") })
      expect(completed).toMatchObject({ error: { code: "QUESTION_IN_REPLY" } })
    })
  })

  describe("an MCP server's form Claude Code passes on", () => {
    const form = { type: "object", properties: { branch: { type: "string", title: "Branch", enum: ["main", "next"], enumNames: ["Main", "Next"] }, reviewer: { type: "string", title: "Reviewer", format: "email" }, draft: { type: "boolean", title: "Draft" } } }
    let sessions = 0
    const run = async (request: ClaudeSdkElicitationRequest, respond: (target: ClaudeAgentSdkBackend, sessionId: string, approvalId: string) => Promise<void> = async () => {}, signal?: AbortSignal) => {
      const results: ClaudeSdkElicitationResult[] = []
      const { sdk, queries } = fakeSdk(async (_text, query) => {
        query.emit(init())
        results.push(await query.elicit(request, signal))
        query.emit(text("ok"))
        query.emit(success())
      })
      const target = backend(sdk, { launch: { permissionMode: "ask" } })
      const session = await target.createSession({ cwd: "/tmp", sessionId: `sdk-elicitation-${++sessions}` })
      const events = await collect(target, session.id, "go", async (event) => {
        if (event.type === "approval.required") await respond(target, session.id, event.approvalId)
      })
      // Between turns nobody is there to answer.
      const between = await queries[0]?.elicit(request)
      await target.close(session.id)
      return { result: results[0], between, events, required: events.find((event) => event.type === "approval.required"), resolved: events.find((event) => event.type === "approval.resolved") }
    }

    test("is asked as questions, and the answers go back as the form's content", async () => {
      const { result, between, events, required, resolved } = await run({ serverName: "github", message: "Open the pull request?", mode: "form", requestedSchema: form }, async (target, sessionId, approvalId) => {
        expect(() => target.setApprovalAnswers(sessionId, approvalId, { q1: ["Next"], q2: ["nobody"], q3: ["No"] })).toThrow("not an email address")
        expect(target.setApprovalAnswers(sessionId, approvalId, { q1: ["Next"], q2: ["ada@example.com"], q3: ["No"] })).toBe(true)
        expect(await target.resolveApproval(sessionId, approvalId, true)).toBe(true)
      })
      expect(required).toMatchObject({
        action: "question",
        capability: "user.input",
        reason: "github: Open the pull request?",
        questions: [
          { id: "q1", question: "Branch", header: "github", options: [{ label: "Main" }, { label: "Next" }] },
          { id: "q2", question: "Reviewer", header: "github", options: [], other: true },
          { id: "q3", question: "Draft", header: "github", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      })
      expect(result).toEqual({ action: "accept", content: { branch: "next", reviewer: "ada@example.com", draft: false } })
      expect(resolved).toMatchObject({ approved: true, answers: { q1: ["Next"], q2: ["ada@example.com"], q3: ["No"] } })
      expect(between).toEqual({ action: "cancel" })
      expect(events.every((event) => isAgentEvent(event))).toBe(true)
    })

    test("one field asks in the server's own words; declined, the server hears decline", async () => {
      const { result, required, resolved } = await run({ serverName: "github", message: "Which branch?", requestedSchema: { type: "object", properties: { branch: { type: "string" } } } }, async (target, sessionId, approvalId) => {
        await target.resolveApproval(sessionId, approvalId, false, "not now")
      })
      expect(required).toMatchObject({ questions: [{ id: "q1", question: "Which branch?", header: "github", options: [], other: true }] })
      expect(result).toEqual({ action: "decline" })
      expect(resolved).toMatchObject({ approved: false, reason: "not now" })
      expect(resolved).not.toHaveProperty("answers")
    })

    test("one Runrail cannot show is declined without asking, and the person sees it and why", async () => {
      const { result, required, resolved } = await run({ serverName: "github", message: "Sign in to GitHub", mode: "url", url: "https://github.com/login/device", elicitationId: "e-1" }, async (target, sessionId, approvalId) => {
        expect(await target.resolveApproval(sessionId, approvalId, true)).toBe(false)
      })
      expect(required).toMatchObject({ action: "Sign in to GitHub", capability: "user.input", reason: "github: Sign in to GitHub" })
      expect(required).not.toHaveProperty("questions")
      expect(resolved).toMatchObject({ approved: false, reason: "It asks you to open a web page, which Runrail cannot show yet" })
      expect(result).toEqual({ action: "decline" })
    })

    test("one Claude Code takes back is withdrawn, and the server hears cancel", async () => {
      const abort = new AbortController()
      const { result, resolved } = await run({ serverName: "github", message: "Open the pull request?", requestedSchema: form }, async () => {
        abort.abort()
      }, abort.signal)
      expect(resolved).toMatchObject({ approved: false, withdrawn: true })
      expect(result).toEqual({ action: "cancel" })
    })
  })

  test("guidance sent while a tool runs joins the running turn; at other points it is refused", async () => {
    let steer: ClaudeSdkUserMessage | undefined
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      // The tool starts only after the test has tried to steer before it.
      await gate
      query.emit({ type: "assistant", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_ping", name: "Bash", input: { command: "ping" } }] } })
      steer = await query.nextInput()
      query.emit({ type: "user", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_ping", is_error: false }] } })
      query.emit(text("done BANANA"))
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-steer" })
    expect(target.steer(session.id, "too early")).toBe(false)
    const accepted: boolean[] = []
    const events = await collect(target, session.id, "ping", (event) => {
      if (event.type === "turn.started") {
        accepted.push(target.steer(session.id, "before any tool"))
        release()
      }
      if (event.type === "tool.started") accepted.push(target.steer(session.id, "add BANANA"))
      if (event.type === "tool.completed") accepted.push(target.steer(session.id, "after the tool"))
    })
    expect(accepted).toEqual([false, true, false])
    expect(steer).toEqual({ type: "user", message: { role: "user", content: "add BANANA" }, parent_tool_use_id: null, priority: "next" })
    expect(types(events)).toEqual(["session.started", "turn.started", "tool.started", "tool.completed", "assistant.message", "session.completed"])
    expect(target.steer(session.id, "after the turn")).toBe(false)
    await target.close(session.id)
  })

  test("interrupt ends the turn and stops the background tasks it started", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "system", subtype: "task_started", task_id: "task-ping", task_type: "local_bash", description: "ping", session_id: "vendor-session-1" })
      query.emit({ type: "assistant", session_id: "vendor-session-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_ping", name: "Bash", input: { command: "ping" } }] } })
      await query.untilInterrupted()
      query.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "vendor-session-1" })
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-interrupt" })
    const events = await collect(target, session.id, "ping", async (event) => {
      if (event.type === "tool.started") await target.interrupt(session.id, "user stopped")
    })
    expect(types(events).at(-1)).toBe("session.stopped")
    expect(events.at(-1)).toMatchObject({ reason: "user stopped" })
    expect(queries[0]!.interrupts).toHaveLength(1)
    expect(queries[0]!.stoppedTasks).toEqual(["task-ping"])
    expect(queries[0]!.closed).toBe(false)
    await target.close(session.id)
  })

  test("cancel while an approval waits denies it and stops the turn", async () => {
    let decision: ClaudeSdkPermissionResult | undefined
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decision = await query.ask("Bash", { command: "rm -rf build" }, { toolUseID: "toolu_rm" })
      await query.untilInterrupted().catch(() => undefined)
      query.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "vendor-session-1" })
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-cancel" })
    const events = await collect(target, session.id, "clean", async (event) => {
      if (event.type === "approval.required") await target.cancel(session.id, "user cancelled")
    })
    expect(decision).toMatchObject({ behavior: "deny", interrupt: true })
    expect(types(events).at(-1)).toBe("session.stopped")
    expect(await target.resolveApproval(session.id, "claude-toolu_rm", true)).toBe(false)
    await target.close(session.id)
  })

  test("an approval withdrawn by Claude Code is removed, and its card says so", async () => {
    const controller = new AbortController()
    let decision: ClaudeSdkPermissionResult | undefined
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      const asked = query.ask("Bash", { command: "ls" }, { toolUseID: "toolu_ls" }, controller.signal)
      controller.abort()
      decision = await asked
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-withdrawn" })
    const events = await collect(target, session.id, "list")
    expect(decision).toMatchObject({ behavior: "deny" })
    expect(events.find((event) => event.type === "approval.resolved")).toMatchObject({ approvalId: "claude-toolu_ls", approved: false, withdrawn: true })
    expect(await target.resolveApproval(session.id, "claude-toolu_ls", true)).toBe(false)
    await target.close(session.id)
  })

  test("continues the stored conversation and keeps the one Claude Code reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-sdk-"))
    try {
      const store = createFileVendorSessionStore(root, "claude-code")
      await store.save("sdk-resume", "vendor-old")
      const { sdk, queries } = fakeSdk(async (_text, query) => {
        query.emit(init("vendor-old"))
        query.emit(success("vendor-old"))
      })
      const target = backend(sdk, { vendorSessions: store })
      const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-resume" })
      await collect(target, session.id, "continue")
      expect(queries[0]!.options.resume).toBe("vendor-old")
      expect(await store.load("sdk-resume")).toBe("vendor-old")
      await target.close(session.id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a fork copies the conversation for the target session, which then continues the copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-sdk-"))
    try {
      const store = createFileVendorSessionStore(root, "claude-code")
      const forks: unknown[][] = []
      let target: ClaudeAgentSdkBackend | undefined
      const duringTurn: Promise<unknown>[] = []
      const { sdk, queries } = fakeSdk(async (_text, query) => {
        const vendor = query.options.resume ?? "vendor-session-1"
        query.emit(init(vendor))
        duringTurn.push(target!.fork({ sessionId: "sdk-fork-parent" }).then(() => "forked", (error: { code?: string }) => error.code))
        query.emit(success(vendor))
      })
      const forking: ClaudeAgentSdk = { ...sdk, forkSession: async (...args) => {
        forks.push(args)
        return { sessionId: "vendor-fork-1" }
      } }
      target = backend(forking, { vendorSessions: store })
      const parent = await target.createSession({ cwd: "/tmp/project", sessionId: "sdk-fork-parent" })
      await collect(target, parent.id, "first")
      expect(await Promise.all(duringTurn)).toEqual(["COMMAND_AGENT_INVALID"])
      await expect(target.fork({ sessionId: parent.id, targetSessionId: parent.id })).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
      await expect(target.fork({ sessionId: parent.id, targetSessionId: "sdk-fork-child" })).resolves.toEqual({ sessionId: "sdk-fork-child", parentSessionId: parent.id })
      expect(forks).toEqual([["vendor-session-1", { dir: "/tmp/project" }]])
      expect(await store.load("sdk-fork-child")).toBe("vendor-fork-1")
      expect(await store.load(parent.id)).toBe("vendor-session-1")
      await target.close(parent.id)

      const child = backend(forking, { vendorSessions: store })
      const opened = await child.createSession({ cwd: "/tmp/project", sessionId: "sdk-fork-child" })
      expect((await collect(child, opened.id, "continue the copy")).at(-1)).toMatchObject({ type: "session.completed" })
      expect(queries.at(-1)!.options.resume).toBe("vendor-fork-1")
      await child.close(opened.id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a fork is refused without a store, an SDK that can fork, or a shared config directory; an unstarted one forks to a new conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-sdk-"))
    try {
      const store = createFileVendorSessionStore(root, "claude-code")
      const { sdk } = fakeSdk(async (_text, query) => {
        query.emit(init())
        query.emit(success())
      })
      const forking: ClaudeAgentSdk = { ...sdk, forkSession: async () => ({ sessionId: "vendor-fork-1" }) }

      const storeless = backend(forking)
      await storeless.createSession({ cwd: "/tmp", sessionId: "sdk-fork-storeless" })
      await expect(storeless.fork({ sessionId: "sdk-fork-storeless" })).rejects.toMatchObject({ code: "COMMAND_AGENT_UNSUPPORTED" })

      const unforking = backend(sdk, { vendorSessions: store })
      const started = await unforking.createSession({ cwd: "/tmp", sessionId: "sdk-fork-old-sdk" })
      await collect(unforking, started.id, "first")
      await expect(unforking.fork({ sessionId: started.id })).rejects.toMatchObject({ code: "COMMAND_AGENT_UNSUPPORTED" })
      await unforking.close(started.id)

      const elsewhere = backend(forking, { vendorSessions: store, env: { CLAUDE_CONFIG_DIR: "/tmp/other-claude" }, auth: { mode: "environment", credentialEnvironment: ["CLAUDE_CONFIG_DIR"] } })
      const moved = await elsewhere.createSession({ cwd: "/tmp", sessionId: "sdk-fork-elsewhere" })
      await collect(elsewhere, moved.id, "first")
      await expect(elsewhere.fork({ sessionId: moved.id })).rejects.toMatchObject({ code: "COMMAND_AGENT_UNSUPPORTED" })
      await elsewhere.close(moved.id)

      await store.save("sdk-fork-fresh-child", "vendor-stale")
      const fresh = backend(forking, { vendorSessions: store })
      await fresh.createSession({ cwd: "/tmp", sessionId: "sdk-fork-fresh" })
      await expect(fresh.fork({ sessionId: "sdk-fork-fresh", targetSessionId: "sdk-fork-fresh-child" })).resolves.toEqual({ sessionId: "sdk-fork-fresh-child", parentSessionId: "sdk-fork-fresh" })
      expect(await store.load("sdk-fork-fresh-child")).toBeUndefined()
      await fresh.close("sdk-fork-fresh")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a different conversation inside one process fails the turn", async () => {
    let turn = 0
    const { sdk } = fakeSdk(async (_text, query) => {
      turn += 1
      query.emit(init(turn === 1 ? "vendor-a" : "vendor-b"))
      query.emit(success(turn === 1 ? "vendor-a" : "vendor-b"))
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-identity" })
    await collect(target, session.id, "one")
    const events = await collect(target, session.id, "two")
    expect(events.at(-1)).toMatchObject({ type: "session.failed", error: { code: "COMMAND_AGENT_OUTPUT_INVALID" } })
    await target.close(session.id)
  })

  test("a signed-out Claude Code fails with the authentication code", async () => {
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", session_id: "vendor-session-1" })
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-auth" })
    const events = await collect(target, session.id, "hi")
    expect(events.at(-1)).toMatchObject({ type: "session.failed", error: { code: "HARNESS_AUTH_FAILED" } })
    await target.close(session.id)
  })

  test("a resumed conversation Claude Code no longer has is forgotten and the prompt runs once fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-sdk-"))
    try {
      const store = createFileVendorSessionStore(root, "claude-code")
      await store.save("sdk-missing", "vendor-gone")
      const prompts: string[] = []
      const { sdk, queries } = fakeSdk(
        async (value, query) => {
          prompts.push(value)
          query.emit(init("vendor-new"))
          query.emit(success("vendor-new"))
        },
        async (query, index) => {
          if (index !== 0) return
          // The real process prints this and exits; the spawn hook is what reads its stderr.
          const child = query.options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", "console.error('No conversation found with session ID: vendor-gone'); process.exit(1)"], env: query.options.env, signal: new AbortController().signal })
          await new Promise((resolve) => child.once("exit", resolve))
          await Bun.sleep(20)
          query.end(new Error("Claude Code process exited with code 1"))
        },
      )
      const target = backend(sdk, { vendorSessions: store })
      const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-missing" })
      const events = await collect(target, session.id, "hello again")
      expect(events.at(-1)?.type).toBe("session.completed")
      expect(queries).toHaveLength(2)
      expect(queries[0]!.options.resume).toBe("vendor-gone")
      expect(queries[1]!.options.resume).toBeUndefined()
      expect(prompts).toEqual(["hello again"])
      expect(await store.load("sdk-missing")).toBe("vendor-new")
      await target.close(session.id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the spawned process sees only the filtered environment", async () => {
    process.env.RUNRAIL_SDK_TEST_SECRET = "must-not-leak"
    try {
      let seen: Record<string, string> | undefined
      const { sdk } = fakeSdk(async (_text, query) => {
        const child = query.options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"], env: { ...query.options.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }, signal: new AbortController().signal })
        let output = ""
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString()
        })
        await new Promise((resolve) => child.once("exit", resolve))
        seen = JSON.parse(output) as Record<string, string>
        query.emit(init())
        query.emit(success())
      })
      const target = backend(sdk)
      const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-env" })
      await collect(target, session.id, "env")
      expect(seen?.RUNRAIL_SDK_TEST_SECRET).toBeUndefined()
      expect(seen?.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts")
      expect(seen?.HOME).toBe(process.env.HOME!)
      await target.close(session.id)
    } finally {
      delete process.env.RUNRAIL_SDK_TEST_SECRET
    }
  })

  test("a changed model goes to the running process; a changed effort starts a fresh one", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-settings" })
    await collect(target, session.id, "one")
    await target.setModel(session.id, "opus")
    expect(queries[0]!.models).toEqual(["opus"])
    await target.setThinking(session.id, "high")
    await collect(target, session.id, "two")
    expect(queries).toHaveLength(2)
    expect(queries[0]!.closed).toBe(true)
    expect(queries[1]!.options).toMatchObject({ model: "opus", effort: "high", resume: "vendor-session-1" })
    await expect(target.setModel(session.id, "-bad")).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    await target.close(session.id)
  })

  test("a model switch the running process refuses mid-turn starts the next turn on the new model", async () => {
    let release = (): void => undefined
    let turns = 0
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      turns += 1
      query.emit(init())
      if (turns === 1) {
        query.setModel = async () => { throw new Error("model switch refused") }
        await new Promise<void>((resolve) => { release = resolve })
      }
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-model-refused" })
    const first = collect(target, session.id, "one")
    for (let attempt = 0; attempt < 100 && turns === 0; attempt += 1) await Bun.sleep(5)
    await target.setModel(session.id, "opus")
    release()
    await first
    await collect(target, session.id, "two")
    expect(queries).toHaveLength(2)
    expect(queries[0]!.closed).toBe(true)
    expect(queries[1]!.options).toMatchObject({ model: "opus", resume: "vendor-session-1" })
    await target.close(session.id)
  })

  test("names Grep and Glob, kept to the working folder, so a native Claude Code keeps its search tools", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit(success())
    })
    const target = backend(sdk, { launch: { permissionMode: "accept-edits" } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-search-tools" })
    await collect(target, session.id, "find average")
    // A bare `Grep` would also let a search outside the folder run without asking.
    expect(queries[0]!.options.allowedTools).toEqual(["Grep(./**)", "Glob(./**)"])
    await target.close(session.id)
  })

  test("MCP configuration documents merge into the server map", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit(success())
    })
    const browser = JSON.stringify({ mcpServers: { browser: { type: "http", url: "http://127.0.0.1:1/mcp" } } })
    const target = backend(sdk, { launch: { mcpConfig: [browser], allowedTools: ["mcp__browser"] } })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-mcp" })
    await collect(target, session.id, "browse")
    expect(queries[0]!.options.mcpServers).toEqual({ browser: { type: "http", url: "http://127.0.0.1:1/mcp" } })
    expect(queries[0]!.options.allowedTools).toEqual(["mcp__browser", "Grep(./**)", "Glob(./**)"])
    await target.close(session.id)

    const bad = backend(sdk, { launch: { mcpConfig: [JSON.stringify({ servers: {} })] } })
    const badSession = await bad.createSession({ cwd: "/tmp", sessionId: "sdk-mcp-bad" })
    await expect(collect(bad, badSession.id, "browse")).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
  })

  test("compacts between turns with Claude Code's own /compact and reads the size back in full", async () => {
    const frames: RunrailLiveFrameInput[] = []
    const { sdk, queries } = fakeSdk(async (message, query) => {
      if (message !== "/compact") {
        query.emit(init())
        query.emit(text("ok"))
        query.emit(success())
        return
      }
      query.emit({ type: "system", subtype: "status", status: "compacting", session_id: "vendor-session-1" })
      query.emit({ type: "system", subtype: "status", status: null, compact_result: "success", session_id: "vendor-session-1" })
      query.emit(init())
      query.emit({ type: "system", subtype: "compact_boundary", session_id: "vendor-session-1", compact_metadata: { trigger: "manual", pre_tokens: 50_000, post_tokens: 1_500 } })
      query.emit({ type: "user", isSynthetic: true, session_id: "vendor-session-1", parent_tool_use_id: null, message: { role: "user", content: "summary of the conversation" } })
      query.emit({ type: "user", isReplay: true, session_id: "vendor-session-1", parent_tool_use_id: null, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } })
      query.emit({ ...success(), num_turns: 0 })
    })
    const target = backend(sdk, { onLive: (frame) => frames.push(frame) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-compact" })
    // Nothing to compact yet, and no process is started to find that out.
    await expect(target.compact(session.id)).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    expect(queries).toHaveLength(0)
    await collect(target, session.id, "one")
    queries[0]!.contextUsage = { totalTokens: 14_000, maxTokens: 200_000, rawMaxTokens: 200_000, autoCompactThreshold: 167_000, isAutoCompactEnabled: true }
    const compacted = await target.compact(session.id, "manual")
    // The fake answers the same reading before and after; Claude Code's own figures stand in when a read fails.
    expect(compacted).toMatchObject({ type: "memory.compacted", before: 14_000, after: 14_000, reason: "manual" })
    expect(queries[0]!.contextReads).toEqual([{ detail: "full" }, { detail: "full" }])
    queries[0]!.contextUsage = undefined
    expect(await target.compact(session.id)).toMatchObject({ before: 50_000, after: 1_500 })
    expect(frames.filter((frame) => frame.type === "context.usage")).toContainEqual({ type: "context.usage", usedTokens: 14_000, windowTokens: 200_000, autoCompactAt: 167_000, estimated: true })
    // The summary and the command's echo are Claude Code's bookkeeping, not a turn of the conversation.
    const next = await collect(target, session.id, "two")
    expect(types(next)).toEqual(["turn.started", "assistant.message", "session.completed"])
    expect(queries).toHaveLength(1)
    await target.close(session.id)
  })

  test("a compaction is refused mid-turn, and one Claude Code ends without a boundary fails", async () => {
    let release: (() => void) | undefined
    const { sdk, queries } = fakeSdk(async (message, query) => {
      query.emit(init())
      if (message === "hold") await new Promise<void>((resolve) => { release = resolve })
      // Too short a conversation: Claude Code answers without compacting.
      if (message !== "/compact") query.emit(text("ok"))
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-compact-refused" })
    await collect(target, session.id, "one")
    const running = collect(target, session.id, "hold")
    while (release === undefined) await Bun.sleep(1)
    await expect(target.compact(session.id)).rejects.toMatchObject({ code: "COMMAND_AGENT_INVALID" })
    release()
    expect(types(await running).at(-1)).toBe("session.completed")
    await expect(target.compact(session.id)).rejects.toMatchObject({ code: "COMMAND_AGENT_FAILED" })
    expect(queries[0]!.closed).toBe(false)
    await target.close(session.id)
  })

  test("an auto-compaction inside a turn shows as a notice with its sizes", async () => {
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "system", subtype: "compact_boundary", session_id: "vendor-session-1", compact_metadata: { trigger: "auto", pre_tokens: 168_000, post_tokens: 6_000 } })
      query.emit(text("ok"))
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-auto-compact" })
    const events = await collect(target, session.id, "long work")
    expect(events).toContainEqual(expect.objectContaining({ type: "memory.compacted", before: 168_000, after: 6_000, reason: "threshold" }))
    await target.close(session.id)
  })

  test("reads usage from the running process only: the context in full, the plan from the usage call", async () => {
    const frames: RunrailLiveFrameInput[] = []
    let share = 0.24
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "rate_limit_event", session_id: "vendor-session-1", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1_790_000_000, unifiedWindows: { five_hour: { utilization: share, resetsAt: 1_790_000_000 }, seven_day: { utilization: 0.07, resetsAt: 1_790_400_000 } } } })
      query.emit(text("ok"))
      query.emit(success())
    })
    const target = backend(sdk, { onLive: (frame) => frames.push(frame) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-usage" })
    expect(await target.readUsage(session.id)).toEqual({})
    expect(queries).toHaveLength(0)
    await collect(target, session.id, "one")
    // Every event carries both windows; older versions named one.
    expect(frames.filter((frame) => frame.type === "plan.limits")).toEqual([{ type: "plan.limits", source: "claude-code", windows: [{ id: "five-hour", usedPercent: 24, resetsAt: 1_790_000_000_000 }, { id: "weekly", usedPercent: 7, resetsAt: 1_790_400_000_000 }] }])
    queries[0]!.contextUsage = { totalTokens: 30_000, maxTokens: 1_000_000, autoCompactThreshold: 967_000, isAutoCompactEnabled: false }
    queries[0]!.planUsage = { subscription_type: "max", rate_limits: { five_hour: { utilization: 31, resets_at: "2026-10-04T15:00:00.000Z" }, seven_day: { utilization: 12.5, resets_at: "2026-10-09T00:00:00.000Z" }, internal_codename: { utilization: 99 } } }
    const usage = await target.readUsage(session.id)
    // With auto-compaction off there is no point to mark.
    expect(usage.context).toEqual({ usedTokens: 30_000, windowTokens: 1_000_000, estimated: true })
    expect(usage.plan).toEqual({ type: "plan.limits", source: "claude-code", plan: "max", windows: [{ id: "five-hour", usedPercent: 31, resetsAt: Date.parse("2026-10-04T15:00:00.000Z") }, { id: "weekly", usedPercent: 12.5, resetsAt: Date.parse("2026-10-09T00:00:00.000Z") }] })
    // The plan is asked at most once a minute; the context every time.
    queries[0]!.planUsage = { subscription_type: "max", rate_limits: { five_hour: { utilization: 90 } } }
    expect((await target.readUsage(session.id)).plan).toEqual(usage.plan)
    expect(queries[0]!.contextReads).toEqual([{ detail: "full" }, { detail: "full" }])
    // A turn's own report is newer than the last read and answers next, under the plan's name.
    share = 0.5
    await collect(target, session.id, "two")
    expect((await target.readUsage(session.id)).plan).toEqual({ type: "plan.limits", source: "claude-code", plan: "max", windows: [{ id: "five-hour", usedPercent: 50, resetsAt: 1_790_000_000_000 }, { id: "weekly", usedPercent: 7, resetsAt: 1_790_400_000_000 }] })
    await target.close(session.id)
  })

  test("usage reads fall back quietly when the experimental call is missing or fails", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit(success())
    })
    const target = backend(sdk)
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-usage-missing" })
    await collect(target, session.id, "one")
    queries[0]!.contextUsage = { totalTokens: "lots", maxTokens: -1 }
    expect(await target.readUsage(session.id)).toEqual({})
    await target.close(session.id)
  })

  test("a missing claude command fails before any process starts", async () => {
    const { sdk, queries } = fakeSdk(async () => {})
    const target = backend(sdk, { command: "runrail-no-such-claude" })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-missing-command" })
    await expect(collect(target, session.id, "hi")).rejects.toMatchObject({ code: "COMMAND_AGENT_NOT_FOUND" })
    expect(queries).toHaveLength(0)
  })

  test("rejects invalid options and an invalid SDK module", () => {
    const { sdk } = fakeSdk(async () => {})
    expect(() => new ClaudeAgentSdkBackend({ sdk: {} as never })).toThrow()
    expect(() => new ClaudeAgentSdkBackend({ sdk, command: "-claude" })).toThrow()
    expect(() => new ClaudeAgentSdkBackend({ sdk, launch: { model: "bad model" } })).toThrow()
    expect(() => parseClaudeAgentSdk({})).toThrow()
    expect(() => registerClaudeAgentSdk({ query: "nope" })).toThrow()
    const parsed = parseClaudeAgentSdk({ query: () => ({}) })
    expect(() => parsed.query({ prompt: (async function* () {})(), options: {} as never })).toThrow()
    expect(parsed.forkSession).toBeUndefined()
  })

  test("the SDK module's context and experimental usage calls are passed on when it has them", async () => {
    const calls: unknown[] = []
    const raw = (extra: Record<string, unknown>) => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }), interrupt: async () => undefined, setModel: async () => undefined, stopTask: async () => undefined, close: () => undefined, ...extra })
    const prompt = { prompt: (async function* () {})(), options: {} as never }
    const bare = parseClaudeAgentSdk({ query: () => raw({}) }).query(prompt)
    expect(bare.getContextUsage).toBeUndefined()
    expect(bare.readPlanUsage).toBeUndefined()
    const full = parseClaudeAgentSdk({ query: () => raw({
      getContextUsage: async (options: unknown) => { calls.push(["context", options]); return {} },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: unknown) => { calls.push(["usage", options]); return {} },
    }) }).query(prompt)
    await full.getContextUsage?.({ detail: "full" })
    await full.readPlanUsage?.()
    expect(calls).toEqual([["context", { detail: "full" }], ["usage", { skipBehaviors: true }]])
  })

  test("the SDK's fork is passed only the project directory and its result is checked", async () => {
    const calls: unknown[][] = []
    const parsed = parseClaudeAgentSdk({ query: () => ({}), forkSession: async (...args: unknown[]) => {
      calls.push(args)
      return args[0] === "bad" ? { sessionId: "not an id" } : { sessionId: "vendor-fork-2", extra: true }
    } })
    await expect(parsed.forkSession!("vendor-1", { dir: "/tmp", title: "x" } as never)).resolves.toEqual({ sessionId: "vendor-fork-2" })
    expect(calls).toEqual([["vendor-1", { dir: "/tmp" }]])
    await expect(parsed.forkSession!("bad", { dir: "/tmp" })).rejects.toThrow()
  })

  test("a session's allow-for-this-session answer reaches Claude Code as its suggested rule", async () => {
    const decisions: ClaudeSdkPermissionResult[] = []
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test" }], behavior: "allow", destination: "session" }
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decisions.push(await query.ask("Bash", { command: "bun test" }, { toolUseID: "toolu_session", suggestions: [suggestion] }))
      query.emit(success())
    })
    registerClaudeAgentSdk(sdk)
    const session = await createRunrailSession({ cwd: "/tmp", backend: "claude-code", loadExtensions: false, harnessCommand: process.execPath, harnessProtocol: "sdk", verifyAfterTurn: false })
    try {
      for await (const event of session.prompt("run the tests")) if (event.type === "approval.required") await session.resolveApproval(event.approvalId, true, undefined, "session")
      expect(decisions).toEqual([{ behavior: "allow", updatedInput: { command: "bun test" }, updatedPermissions: [suggestion] }])
    } finally {
      await session.close()
    }
  })

  test("through a session, Claude Code's retries are kept in the transcript after the event they followed", async () => {
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 520, error_status: 529, error: "overloaded", session_id: "vendor-session-1", uuid: "u1" })
      query.emit(text("done"))
      query.emit(success())
    })
    registerClaudeAgentSdk(sdk)
    const root = await mkdtemp(join(tmpdir(), "runrail-retry-transcript-"))
    const transcripts = new FileTranscriptStore({ root })
    const session = await createRunrailSession({ cwd: "/tmp", backend: "claude-code", loadExtensions: false, harnessCommand: process.execPath, harnessProtocol: "sdk", verifyAfterTurn: false, transcriptStore: transcripts })
    try {
      for await (const _event of session.prompt("go")) {}
      const records = await transcripts.read(session.snapshot.id)
      const retry = records.find((record) => record.kind === "api.retry")
      expect(retry?.payload).toEqual({ type: "api.retry", turnId: expect.any(String), source: "claude-code", attempt: 1, maxRetries: 10, delayMs: 520, status: 529, error: "overloaded", afterSeq: expect.any(Number) })
      expect(records.findIndex((record) => record.kind === "api.retry")).toBeLessThan(records.findIndex((record) => record.kind === "assistant.message"))
    } finally {
      await session.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("through a session, a question approved without answers is refused and can still be answered", async () => {
    const decisions: ClaudeSdkPermissionResult[] = []
    const input = { questions: [{ question: "Which library?", header: "Library", options: [{ label: "Luxon", description: "" }, { label: "date-fns", description: "" }], multiSelect: false }] }
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      decisions.push(await query.ask("AskUserQuestion", input, { toolUseID: "toolu_q" }))
      query.emit(success())
    })
    registerClaudeAgentSdk(sdk)
    const session = await createRunrailSession({ cwd: "/tmp", backend: "claude-code", loadExtensions: false, harnessCommand: process.execPath, harnessProtocol: "sdk", verifyAfterTurn: false })
    try {
      for await (const event of session.prompt("ask")) {
        if (event.type !== "approval.required") continue
        // Nifra's host settles an approval before the backend sees it; refused first, the question stays open.
        expect(() => session.resolveApproval(event.approvalId, true)).toThrow("needs the person's answers")
        const [pending] = session.pendingApprovals
        expect(pending).toMatchObject({ id: event.approvalId })
        // The host would otherwise deny it in Claude Code after five minutes.
        expect(pending!.expiresAt).toBe(APPROVAL_NEVER_EXPIRES_AT)
        await session.resolveApproval(event.approvalId, true, undefined, undefined, { q1: ["Luxon"] })
      }
      expect(decisions).toEqual([{ behavior: "allow", updatedInput: { ...input, answers: { "Which library?": "Luxon" } } }])
    } finally {
      await session.close()
    }
  })

  test("a registered loader runs only when the SDK is first needed, once for callers waiting together, again after it failed", async () => {
    const { sdk } = fakeSdk(async () => {})
    const answers: (() => Promise<unknown>)[] = [async () => { throw new Error("offline") }, async () => ({ notQuery: true }), async () => sdk]
    let calls = 0
    registerClaudeAgentSdkLoader(() => {
      calls += 1
      return answers[calls - 1]!()
    })
    expect(calls).toBe(0)
    expect(await Promise.all([loadClaudeAgentSdk(), loadClaudeAgentSdk()])).toEqual([undefined, undefined])
    expect(calls).toBe(1)
    expect(await loadClaudeAgentSdk()).toBeUndefined()
    expect(calls).toBe(2)
    const loaded = await loadClaudeAgentSdk()
    expect(typeof loaded?.query).toBe("function")
    expect(await loadClaudeAgentSdk()).toBe(loaded)
    expect(calls).toBe(3)
  })

  test("the Claude Code route picks the SDK when one is registered and refuses sdk without it", async () => {
    const registry = createDefaultBackendRegistry()
    const adapter = registry.select({ preferred: "claude-code", requiredCapabilities: [] })
    expect(await loadClaudeAgentSdk()).toBeUndefined()
    await expect(Promise.resolve(adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessProtocol: "sdk" } }))).rejects.toThrow("HARNESS_SDK_MISSING")
    const printRoute = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: {} })
    expect(printRoute).not.toBeInstanceOf(ClaudeAgentSdkBackend)

    const { sdk } = fakeSdk(async () => {})
    registerClaudeAgentSdk(sdk)
    const sdkRoute = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: {} })
    expect(sdkRoute).toBeInstanceOf(ClaudeAgentSdkBackend)
    // The route compacts with Claude Code's own /compact; print mode has no way to.
    expect(sdkRoute.info.capabilities).toContain("compact")
    const forcedPrint = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessProtocol: "print" } })
    expect(forcedPrint).not.toBeInstanceOf(ClaudeAgentSdkBackend)
    expect(forcedPrint.info.capabilities).not.toContain("compact")
    await expect(Promise.resolve(adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessProtocol: "sdk", harnessPersistent: true } }))).rejects.toThrow("HARNESS_PROTOCOL_SDK_UNSHAPED")
  })
})

describe("a connection's own account on the SDK route", () => {
  test.each([
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_790_400_000 } },
    { type: "system", subtype: "api_retry", error_status: 429, error: "rate_limit", attempt: 1, max_retries: 10 },
    { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your weekly limit" }] } },
  ])("an exhausted subscription ends at the first rejection: %j", async (frame) => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ session_id: "vendor-session-1", ...frame })
      // The vendor would keep retrying. No result follows this rejection.
    })
    const route = backend(sdk, { turnTimeoutMs: 300 })
    const session = await route.createSession({ cwd: "/tmp", sessionId: "claude-quota" })
    try {
      const events = await collect(route, session.id, "hello")
      const failure = events.at(-1)
      expect(failure).toMatchObject({ type: "session.failed", recoverable: false, error: { code: "COMMAND_AGENT_RATE_LIMITED" } })
      if (failure?.type !== "session.failed") throw new Error("expected a quota failure")
      expect(failure.error.message).toContain("limit reached")
      if (frame.type !== "system") expect(failure.error.message).toContain("weekly")
      if (frame.type === "rate_limit_event") expect(failure.error.message).toContain(new Date(1_790_400_000_000).toISOString())
      expect(queries[0]!.closed).toBe(true)
    } finally {
      await route.close(session.id)
    }
  })

  test("the folder and the key reach claude as its two variables, and the key only as that one", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit(text("done"))
      query.emit(success())
    })
    registerClaudeAgentSdk(sdk)
    const adapter = createDefaultBackendRegistry().select({ preferred: "claude-code", requiredCapabilities: [] })
    const account = { configDir: "/tmp/runrail-claude-home", apiKey: async () => "sk-ant-fixture-key" }
    const route = await adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessCommand: process.execPath, harnessProtocol: "sdk", harnessAccount: account } }) as ClaudeAgentSdkBackend
    const session = await route.createSession({ cwd: "/tmp", sessionId: "claude-account" })
    expect(types(await collect(route, session.id, "hello"))).toContain("session.completed")
    const env = queries[0]!.options.env as Record<string, string>
    expect([env.CLAUDE_CONFIG_DIR, env.ANTHROPIC_API_KEY, Object.keys(env).filter((name) => /KEY|TOKEN/.test(name))]).toEqual(["/tmp/runrail-claude-home", "sk-ant-fixture-key", ["ANTHROPIC_API_KEY"]])
    await route.close?.(session.id)

    await expect(Promise.resolve(adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessProtocol: "sdk", harnessAccount: account, harnessAuth: { mode: "environment", credentialEnvironment: ["ANTHROPIC_API_KEY"] } } }))).rejects.toThrow("HARNESS_ACCOUNT_CONFLICT")
    await expect(Promise.resolve(adapter.create({ cwd: "/tmp", requestedCapabilities: [], options: { harnessPersistent: true, harnessAccount: account } }))).rejects.toThrow("HARNESS_ACCOUNT_UNSUPPORTED")
  })

  test("Claude Code's retries show on the turn as counts, and the turn goes on", async () => {
    const { sdk } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 520, error_status: 529, error: "overloaded", session_id: "vendor-session-1", uuid: "u1" })
      query.emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 1, retry_delay_ms: 0, error_status: null, error: "unknown", no_response: { waited_ms: 30_000, retry_wait_ms: 60_000 }, session_id: "vendor-session-1", uuid: "u2" })
      query.emit(text("done"))
      query.emit(success())
    })
    const frames: unknown[] = []
    const target = backend(sdk, { onLive: (frame) => frames.push(frame) })
    const session = await target.createSession({ cwd: "/tmp", sessionId: "sdk-retries" })
    const events = await collect(target, session.id, "go")
    expect(events.at(-1)?.type).toBe("session.completed")
    expect(live(frames, "api.retry")).toEqual([
      { type: "api.retry", turnId: "turn-1", source: "claude-code", attempt: 1, maxRetries: 10, delayMs: 520, status: 529, error: "overloaded" },
      { type: "api.retry", turnId: "turn-1", source: "claude-code", attempt: 1, maxRetries: 1, delayMs: 0, error: "unknown", waitedMs: 30_000 },
    ])
    await target.close(session.id)
  })

  test("a refused key ends the turn at Claude Code's first retry instead of after all ten", async () => {
    const { sdk, queries } = fakeSdk(async (_text, query) => {
      query.emit(init())
      query.emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 600, error_status: 401, error: "authentication_failed", session_id: "vendor-session-1" })
      // Claude Code would keep retrying; nothing else arrives.
    })
    const route = backend(sdk)
    const session = await route.createSession({ cwd: "/tmp", sessionId: "claude-refused" })
    const started = Date.now()
    const events = await collect(route, session.id, "hello")
    expect([events.at(-1), Date.now() - started < 5_000, queries[0]!.closed]).toEqual([expect.objectContaining({ type: "session.failed", error: expect.objectContaining({ code: "COMMAND_AGENT_AUTH_FAILED" }) }), true, true])
  })
})
