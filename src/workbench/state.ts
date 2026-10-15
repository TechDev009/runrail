import type { AgentEvent } from "@nifrajs/agent-protocol"
import type { RunrailSessionController } from "../control.ts"
import { mayContinue } from "../harness/event-text.ts"
import type { MultiAgentCoordinator, RunrailAgentProfile, RunrailAgentRunSnapshot } from "../agents/runner.ts"
import type { SessionTreeSnapshot } from "../session.ts"
import type { ModelDescriptor } from "../model/catalog.ts"
import { type BoundedDiff, type WorkspaceDiffReview } from "./diff.ts"
import { type WorkbenchAction, type WorkbenchKey } from "./input.ts"
import type { WorkbenchResourceEntry, WorkbenchResourcePicker, WorkbenchResourceSelection } from "./resources.ts"
import { themeColor, type WorkbenchTheme } from "./theme.ts"
import type { ProviderCatalog } from "../providers/catalog.ts"
import { createDefaultProviderCatalog } from "../providers/catalog.ts"
import type { ProviderDescriptor } from "../providers/types.ts"
import type { HarnessDescriptor } from "../harness/types.ts"
import { HarnessRegistry } from "../harness/registry.ts"
import { createDefaultHarnessAdapters } from "../harness/defaults.ts"
import { HotkeyRegistry, WorkbenchCommandRegistry } from "./commands.ts"
import type { TranscriptCompactionOptions, TranscriptReadOptions } from "../transcript/index.ts"
import { terminalText } from "./terminal-text.ts"

export type WorkbenchStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "stopped"

export interface WorkbenchTeamView {
  readonly profiles: readonly RunrailAgentProfile[]
  readonly runs: readonly RunrailAgentRunSnapshot[]
  readonly queued: number
  readonly running: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
}

export interface WorkbenchView {
  readonly input: string
  readonly cursor: number
  readonly historyIndex: number
  readonly scrollOffset: number
  readonly width: number
  readonly height: number
  readonly status: WorkbenchStatus
  readonly sessionId: string
  readonly sessionTree: SessionTreeSnapshot
  readonly pendingApprovals: readonly string[]
  readonly agents: readonly string[]
  readonly team: WorkbenchTeamView
  readonly backend: string
  readonly model?: ModelDescriptor
  readonly providers: readonly ProviderDescriptor[]
  readonly harnesses: readonly HarnessDescriptor[]
  readonly queued: number
  readonly scrollback: readonly string[]
  readonly resources: readonly WorkbenchResourceEntry[]
  readonly selectedResource?: WorkbenchResourceSelection
  readonly diff?: BoundedDiff
  readonly theme?: WorkbenchTheme
  readonly error?: string
  readonly lastAction?: string
}

export interface WorkbenchOptions {
  readonly width?: number
  readonly height?: number
  readonly maxHistory?: number
  readonly maxScrollback?: number
  readonly theme?: WorkbenchTheme
  readonly resources?: WorkbenchResourcePicker
  readonly diffReview?: WorkspaceDiffReview
  readonly agentCoordinator?: MultiAgentCoordinator
  readonly providerCatalog?: ProviderCatalog
  readonly harnessRegistry?: HarnessRegistry
  readonly commandRegistry?: WorkbenchCommandRegistry
  readonly hotkeyRegistry?: HotkeyRegistry
}

export type WorkbenchErrorCode = "WORKBENCH_INVALID" | "WORKBENCH_LIMIT" | "WORKBENCH_BUSY"

export class WorkbenchError extends Error {
  constructor(readonly code: WorkbenchErrorCode, reason: string) {
    super(`workbench: ${reason}`)
    this.name = "WorkbenchError"
  }
}

/** Deterministic editor/workbench state machine over the Runrail session controller. */
export class RunrailWorkbench {
  private input = ""
  private cursor = 0
  private historyIndex = -1
  private width: number
  private height: number
  private status: WorkbenchStatus = "idle"
  private scrollOffset = 0
  private error: string | undefined
  private readonly history: string[] = []
  private readonly scrollback: string[] = []
  private streaming = false
  /** A reply past one event's text arrives as consecutive messages: whether the next one continues one that streamed or one that was shown. */
  private replyContinues: "streamed" | "shown" | undefined
  private readonly maxHistory: number
  private readonly maxScrollback: number
  private readonly listeners = new Set<(view: WorkbenchView) => void>()
  private readonly pendingTurns = new Set<Promise<readonly AgentEvent[]>>()
  private readonly unsubscribeController: () => void
  private readonly resourcePicker?: WorkbenchResourcePicker
  private readonly diffReview?: WorkspaceDiffReview
  private selectedResource: WorkbenchResourceSelection | undefined
  private diff: BoundedDiff | undefined
  private theme: WorkbenchTheme | undefined
  private lastAction: string | undefined
  private readonly agentCoordinator?: MultiAgentCoordinator
  private readonly providerCatalog: ProviderCatalog
  private readonly harnessRegistry: HarnessRegistry
  private readonly commandRegistry?: WorkbenchCommandRegistry
  private readonly hotkeyRegistry?: HotkeyRegistry

  constructor(private readonly controller: RunrailSessionController, options: WorkbenchOptions = {}) {
    this.width = options.width ?? 100
    this.height = options.height ?? 30
    this.maxHistory = options.maxHistory ?? 256
    this.maxScrollback = options.maxScrollback ?? 2_048
    if (!Number.isSafeInteger(this.width) || this.width < 20 || this.width > 4_096 || !Number.isSafeInteger(this.height) || this.height < 5 || this.height > 4_096)
      throw new WorkbenchError("WORKBENCH_LIMIT", "terminal dimensions are invalid")
    if (!Number.isSafeInteger(this.maxHistory) || this.maxHistory < 0 || this.maxHistory > 4_096 || !Number.isSafeInteger(this.maxScrollback) || this.maxScrollback < 1 || this.maxScrollback > 32_768)
      throw new WorkbenchError("WORKBENCH_LIMIT", "workbench limits are invalid")
    this.resourcePicker = options.resources
    this.diffReview = options.diffReview
    this.theme = options.theme
    this.agentCoordinator = options.agentCoordinator
    this.providerCatalog = options.providerCatalog ?? createDefaultProviderCatalog()
    this.harnessRegistry = options.harnessRegistry ?? new HarnessRegistry(createDefaultHarnessAdapters())
    this.commandRegistry = options.commandRegistry
    this.hotkeyRegistry = options.hotkeyRegistry
    this.unsubscribeController = controller.subscribe((event) => this.acceptEvent(event))
  }

  view(): WorkbenchView {
    const snapshot = this.controller.snapshot()
    const agentProfiles = this.agentCoordinator?.listProfiles() ?? Object.freeze([])
    const agentRuns = this.agentCoordinator?.listRuns() ?? Object.freeze([])
    const team = teamSnapshot(agentProfiles, agentRuns)
    return Object.freeze({
      input: this.input,
      cursor: this.cursor,
      historyIndex: this.historyIndex,
      scrollOffset: this.scrollOffset,
      width: this.width,
      height: this.height,
      status: this.status,
      sessionId: snapshot.sessionId,
      sessionTree: this.controller.session.tree(),
      pendingApprovals: Object.freeze(this.controller.session.pendingApprovals.map((approval) => approval.id).sort()),
      agents: Object.freeze(this.agentCoordinator?.listProfiles().map((profile) => profile.id) ?? []),
      team,
      providers: this.providerCatalog.list(),
      harnesses: this.harnessRegistry.list(),
      backend: snapshot.backend,
      ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
      queued: snapshot.queued,
      scrollback: Object.freeze([...this.scrollback]),
      resources: this.resourcePicker?.entriesSnapshot() ?? Object.freeze([]),
      ...(this.selectedResource === undefined ? {} : { selectedResource: this.selectedResource }),
      ...(this.diff === undefined ? {} : { diff: this.diff }),
      ...(this.theme === undefined ? {} : { theme: this.theme }),
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.lastAction === undefined ? {} : { lastAction: this.lastAction }),
    })
  }

  subscribe(listener: (view: WorkbenchView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispatch(key: WorkbenchKey): Promise<WorkbenchView> {
    this.error = undefined
    if (await this.dispatchHotkey(key)) {
      this.publish()
      return this.view()
    }
    switch (key.type) {
      case "text":
        this.insert(key.text)
        break
      case "newline":
        this.insert("\n")
        break
      case "submit":
        await this.submit()
        break
      case "backspace":
        this.backspace()
        break
      case "delete":
        this.delete()
        break
      case "left":
        this.cursor = Math.max(0, this.cursor - 1)
        break
      case "right":
        this.cursor = Math.min(this.input.length, this.cursor + 1)
        break
      case "home":
        this.cursor = lineStart(this.input, this.cursor)
        break
      case "end":
        this.cursor = lineEnd(this.input, this.cursor)
        break
      case "up":
        this.historyPrevious()
        break
      case "down":
        this.historyNext()
        break
      case "pageUp":
        this.scrollOffset = Math.min(this.scrollback.length, this.scrollOffset + Math.max(1, this.height - 3))
        break
      case "pageDown":
        this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.height - 3))
        break
      case "interrupt":
        this.controller.cancel("terminal interrupt")
        this.status = "stopped"
        break
      case "clear":
        this.scrollback.splice(0)
        this.scrollOffset = 0
        break
      case "resize":
        this.resize(key.width, key.height)
        break
      case "escape":
        this.selectedResource = undefined
        this.diff = undefined
        break
      case "action":
        await this.applyAction(key.action)
        break
    }
    this.publish()
    return this.view()
  }

  private async dispatchHotkey(key: WorkbenchKey): Promise<boolean> {
    const binding = this.hotkeyRegistry?.resolve(hotkeyName(key))
    if (binding === undefined) return false
    if (this.commandRegistry === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "hotkey command registry is unavailable")
    const value = await this.commandRegistry.dispatch(binding.command, binding.args ?? [])
    if (typeof value === "string" && value.length > 0) this.appendScrollback(value.slice(0, this.width * 8))
    this.lastAction = `hotkey:${binding.key}`
    return true
  }

  async dispatchAction(action: WorkbenchAction): Promise<WorkbenchView> {
    this.error = undefined
    await this.applyAction(action)
    this.publish()
    return this.view()
  }

  sessionTree(): SessionTreeSnapshot {
    return this.controller.session.tree()
  }

  sessionHistory(limit?: number) {
    return this.controller.session.history(limit)
  }

  exportEvidence(maxEntries?: number): Promise<string> {
    return this.controller.session.exportEvidence(maxEntries)
  }

  importEvidence(source: string, targetSessionId?: string): Promise<{ readonly sessionId: string; readonly imported: number }> {
    return this.controller.session.importEvidence(source, targetSessionId)
  }

  exportTranscript(options?: TranscriptReadOptions): Promise<string> {
    return this.controller.session.exportTranscript(options)
  }

  importTranscript(source: string, targetSessionId?: string): Promise<{ readonly sessionId: string; readonly imported: number }> {
    return this.controller.session.importTranscript(source, targetSessionId)
  }

  branchTranscript(targetSessionId?: string): Promise<string> {
    return this.controller.session.branchTranscript(targetSessionId)
  }

  compactTranscript(options: TranscriptCompactionOptions) {
    return this.controller.session.compactTranscript(options)
  }

  private async applyAction(action: WorkbenchAction): Promise<void> {
    switch (action.type) {
      case "session.tree": {
        const tree = this.controller.session.tree()
        this.lastAction = "session.tree"
        this.appendScrollback(`[session tree children=${tree.children.length}]`)
        break
      }
      case "session.history": {
        const history = await this.controller.session.history(action.limit)
        this.lastAction = "session.history"
        this.appendScrollback(`[session history entries=${history.length}]`)
        break
      }
      case "session.fork":
      case "session.branch":
      case "session.clone": {
        const result = action.type === "session.fork"
          ? await this.controller.session.fork(action.targetSessionId)
          : action.type === "session.branch"
            ? await this.controller.session.branch(action.targetSessionId)
            : await this.controller.session.clone(action.targetSessionId)
        this.lastAction = action.type
        this.appendScrollback(`[${action.type} session=${result.sessionId}]`)
        break
      }
      case "session.export": {
        const evidence = await this.exportEvidence(action.maxEntries)
        this.lastAction = "session.export"
        this.appendScrollback(`[session evidence exported bytes=${Buffer.byteLength(evidence, "utf8")}]`)
        break
      }
      case "session.import": {
        if (typeof action.evidence !== "string" || action.evidence.length === 0 || action.evidence.length > 4 * 1024 * 1024)
          throw new WorkbenchError("WORKBENCH_LIMIT", "session evidence is invalid")
        const result = await this.importEvidence(action.evidence, action.targetSessionId)
        this.lastAction = "session.import"
        this.appendScrollback(`[session evidence imported=${result.imported}]`)
        break
      }
      case "session.transcript.export": {
        const transcript = await this.exportTranscript(action.options)
        this.lastAction = "session.transcript.export"
        this.appendScrollback(`[session transcript exported bytes=${Buffer.byteLength(transcript, "utf8")}]`)
        break
      }
      case "session.transcript.import": {
        if (typeof action.transcript !== "string" || action.transcript.length === 0 || action.transcript.length > 64 * 1024 * 1024)
          throw new WorkbenchError("WORKBENCH_LIMIT", "session transcript is invalid")
        const result = await this.importTranscript(action.transcript, action.targetSessionId)
        this.lastAction = "session.transcript.import"
        this.appendScrollback(`[session transcript imported=${result.imported}]`)
        break
      }
      case "session.transcript.branch": {
        const sessionId = await this.branchTranscript(action.targetSessionId)
        this.lastAction = "session.transcript.branch"
        this.appendScrollback(`[session transcript branch=${sessionId}]`)
        break
      }
      case "session.transcript.compact": {
        const result = await this.compactTranscript(action.options)
        this.lastAction = "session.transcript.compact"
        this.appendScrollback(`[session transcript compacted=${result.compacted} retained=${result.retained}]`)
        break
      }
      case "approval.resolve": {
        const decision = await this.controller.resolveApproval(action.approvalId, action.approved, action.reason)
        if (decision === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "approval is unavailable")
        this.lastAction = "approval.resolve"
        this.appendScrollback(`[approval ${action.approved ? "approved" : "denied"}]`)
        break
      }
      case "backend.switch": {
        const backend = await this.controller.switchBackend(action.backend)
        this.lastAction = "backend.switch"
        this.appendScrollback(`[backend ${backend.name}]`)
        break
      }
      case "provider.switch": {
        const snapshot = await this.controller.switchProvider(action.provider)
        this.lastAction = "provider.switch"
        this.appendScrollback(`[provider ${snapshot.model?.provider ?? action.provider.provider} model=${snapshot.model?.id ?? action.provider.model}]`)
        break
      }
      case "model.switch": {
        const model = await this.controller.switchModel(action.selection)
        this.lastAction = "model.switch"
        this.appendScrollback(`[model ${model.id}]`)
        break
      }
      case "resources.refresh": {
        const entries = await this.resourcePicker?.refresh()
        if (this.resourcePicker !== undefined) this.resourcePicker.list(action.query ?? "")
        this.lastAction = "resources.refresh"
        this.appendScrollback(`[resources refreshed=${entries?.length ?? 0}]`)
        break
      }
      case "resource.select": {
        if (this.resourcePicker === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "resource picker is unavailable")
        this.selectedResource = this.resourcePicker.select(action.id)
        this.lastAction = "resource.select"
        this.appendScrollback(`[resource selected]`)
        break
      }
      case "diff.refresh": {
        if (this.diffReview === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "diff review is unavailable")
        const entries = await this.diffReview.inspect(action.paths)
        this.diff = entries.length === 0 ? undefined : mergeDiffs(entries.map((entry) => entry.diff))
        this.lastAction = "diff.refresh"
        this.appendScrollback(`[diff entries=${entries.length}]`)
        break
      }
      case "context.reload": {
        const result = await this.controller.session.reload()
        this.lastAction = "context.reload"
        this.appendScrollback(`[context reload=${result.rolledBack ? "rolled-back" : "ok"}]`)
        break
      }
      case "agent.status": {
        if (this.agentCoordinator === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "agent coordinator is unavailable")
        const runs = this.agentCoordinator.listRuns()
        this.lastAction = "agent.status"
        this.appendScrollback(`[agents runs=${runs.length} queued=${runs.filter((run) => run.status === "queued").length} running=${runs.filter((run) => run.status === "running").length} completed=${runs.filter((run) => run.status === "completed").length} failed=${runs.filter((run) => run.status === "failed").length}]`)
        break
      }
      case "agent.list": {
        if (this.agentCoordinator === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "agent coordinator is unavailable")
        const profiles = this.agentCoordinator.listProfiles()
        this.lastAction = "agent.list"
        this.appendScrollback(`[agents profiles=${profiles.length}]`)
        break
      }
      case "agent.run": {
        if (this.agentCoordinator === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "agent coordinator is unavailable")
        const result = await this.agentCoordinator.run(action.task)
        this.lastAction = "agent.run"
        this.appendScrollback(`[agent ${result.ok ? "completed" : "failed"} attempts=${result.attempts}]`)
        break
      }
      case "agent.runMany": {
        if (this.agentCoordinator === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "agent coordinator is unavailable")
        const results = await this.agentCoordinator.runMany(action.tasks, { maxConcurrency: action.maxConcurrency })
        this.lastAction = "agent.runMany"
        this.appendScrollback(`[agents completed=${results.filter((result) => result.ok).length} failed=${results.filter((result) => !result.ok).length}]`)
        break
      }
    }
  }

  async refreshResources(query = ""): Promise<readonly WorkbenchResourceEntry[]> {
    if (this.resourcePicker === undefined) return Object.freeze([])
    await this.resourcePicker.refresh()
    const entries = this.resourcePicker.list(query)
    this.publish()
    return entries
  }

  selectResource(id: string): WorkbenchView {
    if (this.resourcePicker === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "resource picker is unavailable")
    this.selectedResource = this.resourcePicker.select(id)
    this.publish()
    return this.view()
  }

  async captureDiff(paths: readonly string[]): Promise<WorkbenchView> {
    if (this.diffReview === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "diff review is unavailable")
    await this.diffReview.capture(paths)
    this.diff = undefined
    this.publish()
    return this.view()
  }

  async refreshDiff(paths?: readonly string[]): Promise<WorkbenchView> {
    if (this.diffReview === undefined) throw new WorkbenchError("WORKBENCH_INVALID", "diff review is unavailable")
    const entries = await this.diffReview.inspect(paths)
    this.diff = entries.length === 0 ? undefined : mergeDiffs(entries.map((entry) => entry.diff))
    this.publish()
    return this.view()
  }

  setTheme(theme: WorkbenchTheme): WorkbenchView {
    this.theme = theme
    this.publish()
    return this.view()
  }
  async waitForIdle(): Promise<void> {
    while (this.pendingTurns.size > 0) await Promise.allSettled([...this.pendingTurns])
    await this.controller.whenIdle()
  }

  async close(reason = "workbench closed"): Promise<void> {
    this.unsubscribeController()
    await this.controller.close(reason)
  }

  private insert(text: string): void {
    if (typeof text !== "string" || text.length === 0 || text.length > 64 * 1024 || this.input.length + text.length > 128 * 1024)
      throw new WorkbenchError("WORKBENCH_LIMIT", "input is too large")
    this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor)
    this.cursor += text.length
    this.historyIndex = -1
  }

  private backspace(): void {
    if (this.cursor === 0) return
    this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor)
    this.cursor -= 1
  }

  private delete(): void {
    if (this.cursor >= this.input.length) return
    this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1)
  }

  private historyPrevious(): void {
    if (this.history.length === 0) return
    if (this.historyIndex < 0) this.historyIndex = this.history.length
    this.historyIndex = Math.max(0, this.historyIndex - 1)
    this.input = this.history[this.historyIndex] ?? ""
    this.cursor = this.input.length
  }

  private historyNext(): void {
    if (this.historyIndex < 0) return
    this.historyIndex = Math.min(this.history.length, this.historyIndex + 1)
    this.input = this.history[this.historyIndex] ?? ""
    this.cursor = this.input.length
    if (this.historyIndex === this.history.length) this.historyIndex = -1
  }

  private async submit(): Promise<void> {
    const message = this.input
    if (message.trim().length === 0) return
    if (this.history[this.history.length - 1] !== message) {
      this.history.push(message)
      if (this.history.length > this.maxHistory) this.history.shift()
    }
    this.input = ""
    this.cursor = 0
    this.historyIndex = -1
    // A line such as `:approve <id>` is for the workbench, as in the line console; it never reaches the model.
    if (/^:[A-Za-z]/.test(message.trim())) {
      await this.runCommand(message.trim().slice(1))
      return
    }
    this.status = "running"
    const attachment = this.selectedResource?.attachment
    const turn = this.controller.enqueue(attachment === undefined ? message : { text: message, attachments: [attachment] })
    // A picked file goes with the next prompt only.
    if (attachment !== undefined) this.selectedResource = undefined
    this.pendingTurns.add(turn)
    void turn.then(
      () => {
        this.pendingTurns.delete(turn)
      },
      (error: unknown) => {
        this.pendingTurns.delete(turn)
        this.error = error instanceof Error ? error.message.slice(0, 512) : "turn failed"
        this.status = "failed"
        this.publish()
      },
    )
  }

  private async runCommand(line: string): Promise<void> {
    const [name = "", ...args] = line.split(/\s+/)
    try {
      switch (name) {
        case "approve":
        case "deny": {
          const pending = this.controller.session.pendingApprovals.map((approval) => approval.id)
          // With one request waiting, its id may be left out.
          const approvalId = args[0] ?? (pending.length === 1 ? pending[0] : undefined)
          if (approvalId === undefined) throw new WorkbenchError("WORKBENCH_INVALID", pending.length === 0 ? "nothing is waiting for approval" : "name the approval: :approve <id> [yes|no]")
          const approved = name === "approve" && args[1] !== "no" && args[1] !== "false"
          await this.applyAction({ type: "approval.resolve", approvalId, approved, reason: "terminal decision" })
          return
        }
        case "cancel":
          this.controller.cancel("terminal cancelled")
          this.status = "stopped"
          return
        case "model": {
          const id = args.join(" ")
          if (id.length === 0 || id.length > 128) throw new WorkbenchError("WORKBENCH_INVALID", "usage: :model <id>")
          await this.applyAction({ type: "model.switch", selection: { id } })
          return
        }
        case "backend": {
          const backend = args.join(" ")
          if (backend.length === 0) throw new WorkbenchError("WORKBENCH_INVALID", "usage: :backend <name>")
          await this.applyAction({ type: "backend.switch", backend })
          return
        }
        case "help":
          this.appendScrollback(["Commands: :approve [id] [yes|no], :deny [id], :cancel, :model <id>, :backend <name>, :help", ...(this.commandRegistry?.list() ?? []).map((command) => `:${command.id}  ${command.description}`)].join("\n"))
          return
      }
      if (this.commandRegistry?.get(name) === undefined) throw new WorkbenchError("WORKBENCH_INVALID", `unknown command :${name}; :help lists them`)
      const value = await this.commandRegistry.dispatch(name, args)
      if (typeof value === "string" && value.length > 0) this.appendScrollback(value.slice(0, this.width * 8))
      this.lastAction = `command:${name}`
    } catch (error) {
      this.error = error instanceof Error ? error.message.slice(0, 512) : "command failed"
    }
  }

  private resize(width: number, height: number): void {
    if (!Number.isSafeInteger(width) || width < 20 || width > 4_096 || !Number.isSafeInteger(height) || height < 5 || height > 4_096)
      throw new WorkbenchError("WORKBENCH_LIMIT", "terminal dimensions are invalid")
    this.width = width
    this.height = height
  }

  private acceptEvent(event: AgentEvent): void {
    if (event.type === "turn.started") this.status = "running"
    if (event.type === "approval.required") this.status = "waiting"
    if (event.type === "session.completed") this.status = "completed"
    if (event.type === "session.failed") this.status = "failed"
    if (event.type === "session.stopped") this.status = "stopped"
    const continues = this.replyContinues
    this.replyContinues = undefined
    // Deltas build one reply in place; the final message repeats them, so it is shown only when nothing streamed.
    if (event.type === "assistant.delta") this.appendStreamed(event.text)
    else if (event.type === "assistant.message") {
      const streamed = continues === "streamed" || (continues === undefined && this.streaming)
      if (continues === "shown") {
        this.streaming = true
        this.appendStreamed(event.text)
      } else if (!streamed) this.appendScrollback(event.text)
      if (mayContinue(event.text)) this.replyContinues = streamed ? "streamed" : "shown"
    }
    if (event.type !== "assistant.delta") this.streaming = false
    if (event.type === "tool.started") this.appendScrollback(`[tool ${event.name}]`)
    if (event.type === "approval.required") this.appendScrollback(`[approval ${event.approvalId}] :approve or :deny`)
    if (event.type === "verification.completed") this.appendScrollback(`[verification ${event.name}: ${event.ok ? "passed" : "failed"}]`)
    if (event.type === "session.failed") this.appendScrollback(`[failed: ${event.error.code}]`)
    this.publish()
  }

  private appendStreamed(text: string): void {
    const safe = terminalText(text)
    if (safe.length === 0) return
    if (!this.streaming || this.scrollback.length === 0) {
      this.streaming = true
      this.appendScrollback(safe)
      return
    }
    const [first = "", ...rest] = safe.split("\n")
    const last = this.scrollback.length - 1
    this.scrollback[last] = `${this.scrollback[last] ?? ""}${first}`.slice(0, this.width * 8)
    if (rest.length > 0) this.appendScrollback(rest.join("\n"))
    this.scrollOffset = 0
  }

  /** A line for the person, such as what Nifra adds to this session. */
  note(text: string): void {
    this.appendScrollback(text)
    this.publish()
  }

  private appendScrollback(text: string): void {
    if (text.length === 0) return
    for (const line of terminalText(text).split("\n")) this.scrollback.push(line.slice(0, this.width * 8))
    while (this.scrollback.length > this.maxScrollback) this.scrollback.shift()
    this.scrollOffset = 0
  }

  private publish(): void {
    const view = this.view()
    for (const listener of this.listeners) {
      try {
        listener(view)
      } catch {
        // UI observers are isolated from the authoritative session controller.
      }
    }
  }
}

export function renderWorkbench(view: WorkbenchView): string {
  const start = Math.max(0, view.scrollback.length - Math.max(1, view.height - 3) - view.scrollOffset)
  const end = Math.min(view.scrollback.length, start + Math.max(1, view.height - 3))
  const lines = view.scrollback.slice(start, end)
  const status = `${view.backend}${view.model === undefined ? "" : `/${view.model.id}`} ${view.status} q=${view.queued} team=${view.team.running}r/${view.team.queued}q approvals=${view.pendingApprovals.length} children=${view.sessionTree.children.length} sid=${view.sessionId.slice(0, 64)}${view.lastAction === undefined ? "" : ` action=${view.lastAction}`}`
  const input = view.input.slice(Math.max(0, view.cursor - view.width + 2), view.cursor + view.width - 2)
  const cursor = Math.min(input.length, view.cursor - Math.max(0, view.cursor - view.width + 2))
  const withCursor = `${input.slice(0, cursor)}|${input.slice(cursor)}`
  const tokens = view.theme?.tokens
  if (tokens === undefined) return [...lines, status, `> ${withCursor}`].join("\n")
  const statusColor = view.status === "failed" ? tokens.danger : view.pendingApprovals.length > 0 ? tokens.warning : tokens.muted
  return [...lines, themeColor(statusColor, status), `${themeColor(tokens.accent, ">")} ${withCursor}`].join("\n")
}

function lineStart(value: string, cursor: number): number {
  const index = value.lastIndexOf("\n", cursor - 1)
  return index < 0 ? 0 : index + 1
}

function lineEnd(value: string, cursor: number): number {
  const index = value.indexOf("\n", cursor)
  return index < 0 ? value.length : index
}

function teamSnapshot(profiles: readonly RunrailAgentProfile[], runs: readonly RunrailAgentRunSnapshot[]): WorkbenchTeamView {
  return Object.freeze({
    profiles: Object.freeze([...profiles]),
    runs: Object.freeze([...runs]),
    queued: runs.filter((run) => run.status === "queued").length,
    running: runs.filter((run) => run.status === "running").length,
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
    cancelled: runs.filter((run) => run.status === "cancelled").length,
  })
}

function mergeDiffs(diffs: readonly BoundedDiff[]): BoundedDiff {
  return Object.freeze({
    lines: Object.freeze(diffs.flatMap((diff) => diff.lines)),
    added: diffs.reduce((sum, diff) => sum + diff.added, 0),
    removed: diffs.reduce((sum, diff) => sum + diff.removed, 0),
    truncated: diffs.some((diff) => diff.truncated),
  })
}
function hotkeyName(key: WorkbenchKey): string {
  switch (key.type) {
    case "interrupt": return "ctrl-c"
    case "clear": return "ctrl-l"
    case "escape": return "escape"
    case "submit": return "enter"
    case "newline": return "shift-enter"
    case "backspace": return "backspace"
    case "delete": return "delete"
    case "left": return "left"
    case "right": return "right"
    case "up": return "up"
    case "down": return "down"
    case "home": return "home"
    case "end": return "end"
    case "pageUp": return "page-up"
    case "pageDown": return "page-down"
    case "resize": return "resize"
    case "action": return "action"
    case "text": return "text"
  }
}
