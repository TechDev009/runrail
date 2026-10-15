import type { AgentEvent } from "@nifrajs/agent-protocol"
import { isSensitiveWorkspacePath } from "../workspace/policy.ts"
import { commandIntent, wrappedScript, type CommandIntent } from "./command-intent.ts"

/**
 * Provider-neutral description of a tool call for a coding UI. It is derived from the tool name
 * and input at the moment an event is sent to a client, is bounded, and is never persisted.
 */
export type ToolPresentationKind =
  | "read" | "write" | "edit" | "patch" | "shell" | "search" | "list" | "web" | "agent" | "plan" | "verify" | "mcp" | "other"

export interface ToolPresentationEdit {
  readonly oldText: string
  readonly newText: string
}

/** What a shell or verification call is for, when its command says so plainly. */
export type ToolPresentationIntent = CommandIntent

export interface ToolPresentationPlanItem {
  readonly text: string
  readonly status: "pending" | "in_progress" | "completed"
}

export interface ToolPresentation {
  readonly kind: ToolPresentationKind
  readonly title: string
  readonly path?: string
  readonly paths?: readonly string[]
  /** A command that only wraps a script, as Codex runs every one (`/bin/zsh -lc '<script>'`), is its script. */
  readonly command?: string
  /** Set only when the call's exit status is that work's status: no chains, pipes, or background runs. */
  readonly intent?: ToolPresentationIntent
  readonly query?: string
  readonly url?: string
  readonly server?: string
  readonly tool?: string
  readonly edits?: readonly ToolPresentationEdit[]
  readonly content?: string
  readonly plan?: readonly ToolPresentationPlanItem[]
  /** Lines a patch adds and removes, when the call says (a coding tool's file changes). */
  readonly additions?: number
  readonly deletions?: number
  /** A preview field (`edits`, `content`, `plan`, `paths`, `command`) was shortened. */
  readonly truncated: boolean
}

export interface ToolPresentationOptions {
  /** The workspace: paths inside it are shown relative to it, as the workspace's own tools name them. */
  readonly root?: string
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const MAX_TITLE = 160
const MAX_PATH = 1_024
const MAX_PATHS = 32
const MAX_COMMAND = 2_048
const MAX_QUERY = 512
const MAX_URL = 2_048
const MAX_NAME = 128
const MAX_PREVIEW_BYTES = 16 * 1024
const MAX_EDITS = 16
const MAX_PLAN_ITEMS = 64
const MAX_PLAN_TEXT = 256

const KIND_BY_NAME: Readonly<Record<string, ToolPresentationKind>> = Object.freeze({
  read: "read", read_file: "read", view: "read", cat: "read",
  write: "write", write_file: "write", create_file: "write",
  edit: "edit", edit_file: "edit", multiedit: "edit", str_replace: "edit", str_replace_editor: "edit", notebookedit: "edit",
  apply_patch: "patch", file_change: "patch", patch: "patch",
  bash: "shell", shell: "shell", command: "shell", run_command: "shell", command_output: "shell", command_stop: "shell", exec_command: "shell", command_execution: "shell", local_shell: "shell", bashoutput: "shell", killshell: "shell",
  grep: "search", search_files: "search", glob: "search", find: "search", find_files: "search",
  ls: "list", list: "list", list_files: "list", list_dir: "list",
  webfetch: "web", web_fetch: "web", websearch: "web", web_search: "web", fetch: "web",
  task: "agent", agent: "agent", spawn_agent: "agent", collabagenttoolcall: "agent",
  todowrite: "plan", todo_list: "plan", update_plan: "plan", exitplanmode: "plan", switch_mode: "plan",
  run_verification: "verify", verify: "verify",
  mcp_tool_call: "mcp", mcptoolcall: "mcp",
})

/** The browser tools, under their own names or as Claude Code calls them through MCP. Typed text never shows. */
const BROWSER_TITLES: Readonly<Record<string, (value: Record<string, unknown>) => string>> = Object.freeze({
  browser_open: (value) => `Open ${urlOf(value.url) ?? "a page"}`,
  browser_snapshot: () => "Read the page",
  browser_screenshot: (value) => (value.width === "phone" || value.width === "tablet" || value.width === "desktop" ? `Look at the page on a ${value.width}` : "Look at the page"),
  browser_click: (value) => `Click ${text(value.ref, 16) ?? "an element"}`,
  browser_type: (value) => `Type into ${text(value.ref, 16) ?? "a field"}`,
  browser_press: (value) => `Press ${text(value.key, 16) ?? "a key"}`,
  browser_console: () => "Read the console",
  browser_network: () => "Read network requests",
  browser_eval: () => "Run script in the page",
})

/** The computer tools, named for the app they act on. Typed text never shows. */
const COMPUTER_TITLES: Readonly<Record<string, (value: Record<string, unknown>) => string>> = Object.freeze({
  computer_apps: () => "List the apps it may use",
  computer_screenshot: (value) => `Look at ${text(value.app, 60) ?? "an app"}`,
  computer_click: (value) => `Click in ${text(value.app, 60) ?? "an app"}`,
  computer_type: (value) => `Type in ${text(value.app, 60) ?? "an app"}`,
  computer_key: (value) => `Press ${text(value.key, 16) ?? "a key"} in ${text(value.app, 60) ?? "an app"}`,
  computer_scroll: (value) => `Scroll in ${text(value.app, 60) ?? "an app"}`,
})

/** The image tool, named for the file it saves. */
const IMAGE_TOOLS: ReadonlySet<string> = new Set(["image_generate", "mcp__runrail_images__image_generate"])

/** A tool may be named `constructor` or `toString`; only the table's own entries count. */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

export function describeToolCall(name: string, input: unknown, options: ToolPresentationOptions = {}): ToolPresentation {
  const value = isRecord(input) ? input : {}
  const browser = ownEntry(BROWSER_TITLES, name.trim().replace(/^mcp__runrail_browser__/, ""))
  if (browser !== undefined) {
    const url = name.endsWith("browser_open") ? urlOf(value.url) : undefined
    return Object.freeze({ kind: "web", ...(url === undefined ? {} : { url }), title: browser(value).replace(/\s+/g, " ").slice(0, MAX_TITLE), truncated: false })
  }
  const computer = ownEntry(COMPUTER_TITLES, name.trim().replace(/^mcp__runrail_computer__/, ""))
  if (computer !== undefined) return Object.freeze({ kind: "other", title: computer(value).replace(/\s+/g, " ").slice(0, MAX_TITLE), truncated: false })
  if (IMAGE_TOOLS.has(name.trim())) {
    const path = inside(options.root, pathOf(value))
    const verb = typeof value.from === "string" ? "Change a picture" : "Make a picture"
    return Object.freeze({ kind: "other", ...(path === undefined ? {} : { path }), title: (path === undefined ? verb : `${verb}: ${path}`).replace(/\s+/g, " ").slice(0, MAX_TITLE), truncated: false })
  }
  const mcp = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/.exec(name)
  const normalized = name.trim().toLowerCase()
  const typeHint = typeof value.type === "string" ? value.type.toLowerCase() : undefined
  const coordination = normalized === "collabagenttoolcall" || typeHint === "collabagenttoolcall"
  if ((coordination && value.tool === "sendInput") || ["send_message", "sendmessage", "collaboration.send_message"].includes(normalized)) {
    const state = { truncated: false }
    const recipient = text(value.recipient ?? value.target ?? (Array.isArray(value.receiverThreadIds) ? value.receiverThreadIds[0] : undefined), 160)
    const content = preview(value.message ?? value.content ?? value.prompt, state)
    return Object.freeze({ kind: "other", title: recipient === undefined ? "Message agent" : `Message agent: ${recipient}`, ...(content === undefined ? {} : { content }), truncated: state.truncated })
  }
  if (coordination && value.tool !== "spawnAgent") {
    const title = value.tool === "wait" ? "Wait for agents" : value.tool === "sendInput" ? "Message agent" : value.tool === "resumeAgent" ? "Resume agent" : value.tool === "closeAgent" ? "Close agent" : "Coordinate agents"
    return Object.freeze({ kind: "other", title, truncated: false })
  }
  const kind: ToolPresentationKind = mcp !== null
    ? "mcp"
    : ownEntry(KIND_BY_NAME, normalized) ?? (typeHint === undefined ? undefined : ownEntry(KIND_BY_NAME, typeHint)) ?? "other"
  const state = { truncated: false }
  const fields: Mutable<Omit<ToolPresentation, "title" | "truncated">> = { kind }
  const path = inside(options.root, pathOf(value))
  if (path !== undefined) fields.path = path
  const listed = pathsOf(value, state)
  const paths = listed === undefined ? undefined : Object.freeze(listed.map((item) => inside(options.root, item) ?? item))
  if (paths !== undefined) fields.paths = paths
  if (kind === "shell" || kind === "verify") {
    const command = commandOf(value, state)
    if (command !== undefined) fields.command = command
    // A verification gate is named, not written as a command: `{ name: "test" }`.
    const intent = kind === "verify" && value.name === "test" ? "test" : commandIntent(value)
    if (intent !== undefined) fields.intent = intent
  }
  if (kind === "search" || kind === "web") {
    const query = text(value.query ?? value.pattern ?? value.q, MAX_QUERY)
    if (query !== undefined) fields.query = query
  }
  if (kind === "web") {
    const url = urlOf(value.url)
    if (url !== undefined) fields.url = url
  }
  if (kind === "mcp") {
    const server = mcp?.[1] ?? text(value.server, MAX_NAME)
    const tool = mcp?.[2] ?? text(value.tool, MAX_NAME)
    if (server !== undefined) fields.server = server.slice(0, MAX_NAME)
    if (tool !== undefined) fields.tool = tool.slice(0, MAX_NAME)
  }
  const sensitive = [path, ...(paths ?? [])].some((item) => item !== undefined && isSensitiveWorkspacePath(item))
  if (kind === "edit" && !sensitive) {
    const edits = editsOf(value, state)
    if (edits !== undefined) fields.edits = edits
  }
  if (kind === "write" && !sensitive) {
    const content = preview(value.content ?? value.file_text, state)
    if (content !== undefined) fields.content = content
  }
  if (kind === "plan") {
    const plan = planOf(value, state)
    if (plan !== undefined) fields.plan = plan
    // Claude Code's ExitPlanMode, and an ACP agent's request to leave plan mode, carry the plan as markdown.
    else if (typeof value.plan === "string") {
      const content = preview(value.plan, state)
      if (content !== undefined) fields.content = content
    }
  }
  if (kind === "patch" && Array.isArray(value.changes)) {
    const changes = value.changes.filter(isRecord).slice(0, MAX_PATHS)
    const counts = changes.map(changeCounts)
    if (counts.length > 0 && counts.every((count) => count !== undefined)) {
      fields.additions = counts.reduce((sum, count) => sum + count!.additions, 0)
      fields.deletions = counts.reduce((sum, count) => sum + count!.deletions, 0)
    }
    // One file: its diff, for the row to show as it would show an edit.
    if (changes.length === 1 && !sensitive) {
      const content = preview(changePatch(changes[0]!), state)
      if (content !== undefined) fields.content = content
    }
  }
  return Object.freeze({ ...fields, title: titleFor(name, fields, value), truncated: state.truncated })
}

/** A path inside the workspace, relative to it; other paths as they are. */
function inside(root: string | undefined, path: string | undefined): string | undefined {
  if (path === undefined || root === undefined || root.length === 0 || !path.startsWith("/")) return path
  const base = root.endsWith("/") ? root.slice(0, -1) : root
  if (path === base) return "."
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

type ChangeKind = "add" | "delete" | "update"

/** A coding tool's file change: `{ path, kind: { type } | type, diff }`. */
function changeKind(change: Record<string, unknown>): ChangeKind | undefined {
  const raw = isRecord(change.kind) ? change.kind.type : change.kind ?? change.type
  return raw === "add" || raw === "delete" || raw === "update" ? raw : undefined
}

function changeLines(diff: string): readonly string[] {
  const lines = diff.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Lines one change adds and removes: a new file's lines, a removed file's lines, or an update's diff lines. */
function changeCounts(change: Record<string, unknown>): { readonly additions: number; readonly deletions: number } | undefined {
  const kind = changeKind(change)
  if (kind === undefined || typeof change.diff !== "string" || change.diff.length > 4 * 1024 * 1024) return undefined
  const lines = changeLines(change.diff)
  if (kind === "add") return { additions: lines.length, deletions: 0 }
  if (kind === "delete") return { additions: 0, deletions: lines.length }
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions += 1
    else if (line.startsWith("-")) deletions += 1
  }
  return { additions, deletions }
}

/** One change as a unified diff hunk, or nothing when its diff is not one. */
function changePatch(change: Record<string, unknown>): string | undefined {
  const kind = changeKind(change)
  if (kind === undefined || typeof change.diff !== "string") return undefined
  if (kind === "update") return /^@@ -\d+/m.test(change.diff) ? change.diff : undefined
  const lines = changeLines(change.diff)
  if (lines.length === 0) return undefined
  return kind === "add"
    ? `@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`
    : `@@ -1,${String(lines.length)} +0,0 @@\n${lines.map((line) => `-${line}`).join("\n")}\n`
}

/**
 * Adds `presentation` to tool-start events for a control client. Other events pass through
 * untouched. The result is a new object; the recorded event is not modified.
 */
export function presentControlEvent(event: AgentEvent, options: ToolPresentationOptions = {}): AgentEvent | (AgentEvent & { readonly presentation: ToolPresentation }) {
  if (event.type !== "tool.started") return event
  return { ...event, presentation: describeToolCall(event.name, event.input, options) }
}

function titleFor(name: string, value: Omit<ToolPresentation, "title" | "truncated">, input: Record<string, unknown>): string {
  const target = value.path ?? (value.paths === undefined ? undefined : value.paths.length === 1 ? value.paths[0] : `${value.paths.length} files`)
  // The workspace root says nothing in a title: "List files", not "List .".
  const where = target === "." ? undefined : target
  const label = (() => {
    switch (value.kind) {
      case "read": return target === undefined ? "Read" : `Read ${target}`
      case "write": return target === undefined ? "Write" : `Write ${target}`
      case "edit": return target === undefined ? "Edit" : `Edit ${target}`
      case "patch": return target === undefined ? "Apply patch" : `Patch ${target}`
      case "shell": return value.command === undefined ? "Run command" : `Run ${value.command}`
      case "verify": return value.command === undefined ? "Verify" : `Verify ${value.command}`
      case "search": return value.query === undefined ? "Search" : `Search ${value.query}${where === undefined ? "" : ` in ${where}`}`
      case "list": return where === undefined ? "List files" : `List ${where}`
      case "web": return value.url === undefined ? value.query === undefined ? "Web" : `Search web ${value.query}` : `Fetch ${value.url}`
      case "agent": return "Run agent"
      case "plan": return value.content === undefined ? "Update plan" : "Proposed plan"
      case "mcp": return `${value.server ?? "mcp"}.${value.tool ?? "tool"}`
      default: return name.trim().toLowerCase() === "askuserquestion" ? askedTitle(input) : name.trim().length === 0 ? "Tool" : name.trim()
    }
  })()
  const oneLine = label.replace(/\s+/g, " ")
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 3)}...` : oneLine
}

/** Claude Code asking the person: its first question, not the tool's name. */
function askedTitle(input: Record<string, unknown>): string {
  const first = Array.isArray(input.questions) && isRecord(input.questions[0]) ? text(input.questions[0].question, MAX_QUERY) : undefined
  return first === undefined ? "Ask a question" : `Ask: ${first}`
}

function pathOf(value: Record<string, unknown>): string | undefined {
  return text(value.path ?? value.file_path ?? value.filePath ?? value.notebook_path ?? value.filename, MAX_PATH, true)
}

function pathsOf(value: Record<string, unknown>, state: { truncated: boolean }): readonly string[] | undefined {
  const source = Array.isArray(value.changes) ? value.changes : Array.isArray(value.paths) ? value.paths : undefined
  if (source === undefined) return undefined
  const result: string[] = []
  for (const item of source) {
    const path = typeof item === "string" ? text(item, MAX_PATH, true) : isRecord(item) ? text(item.path, MAX_PATH, true) : undefined
    if (path === undefined || result.includes(path)) continue
    if (result.length >= MAX_PATHS) {
      state.truncated = true
      break
    }
    result.push(path)
  }
  return result.length === 0 ? undefined : Object.freeze(result)
}

function commandOf(value: Record<string, unknown>, state: { truncated: boolean }): string | undefined {
  let command: string | undefined
  if (typeof value.command === "string") command = value.command
  else if (Array.isArray(value.command)) command = argvText(value.command)
  else if (typeof value.cmd === "string") command = value.cmd
  else if (typeof value.program === "string") command = argvText([value.program, ...(Array.isArray(value.args) ? value.args : [])])
  if (command === undefined) return undefined
  const oneLine = (wrappedScript(command) ?? command).replace(/[\r\n]+/g, " ").trim()
  if (oneLine.length === 0) return undefined
  if (oneLine.length > MAX_COMMAND) state.truncated = true
  return oneLine.slice(0, MAX_COMMAND)
}

function argvText(argv: readonly unknown[]): string | undefined {
  const parts = argv.filter((part): part is string => typeof part === "string")
  if (parts.length === 0) return undefined
  return parts.map((part) => /^[A-Za-z0-9_./:=@%+,-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(" ")
}

function urlOf(value: unknown): string | undefined {
  const raw = text(value, MAX_URL)
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    url.username = ""
    url.password = ""
    return url.toString().slice(0, MAX_URL)
  } catch {
    return undefined
  }
}

function editsOf(value: Record<string, unknown>, state: { truncated: boolean }): readonly ToolPresentationEdit[] | undefined {
  const source = Array.isArray(value.edits) ? value.edits : [value]
  const edits: ToolPresentationEdit[] = []
  let budget = MAX_PREVIEW_BYTES
  for (const item of source) {
    if (!isRecord(item)) continue
    const oldText = item.oldText ?? item.old_string ?? item.old_str
    const newText = item.newText ?? item.new_string ?? item.new_str
    if (typeof oldText !== "string" || typeof newText !== "string") continue
    if (edits.length >= MAX_EDITS || budget <= 0) {
      state.truncated = true
      break
    }
    const before = clip(oldText, Math.ceil(budget / 2), state)
    const after = clip(newText, budget - Buffer.byteLength(before, "utf8"), state)
    budget -= Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8")
    edits.push(Object.freeze({ oldText: before, newText: after }))
  }
  return edits.length === 0 ? undefined : Object.freeze(edits)
}

function planOf(value: Record<string, unknown>, state: { truncated: boolean }): readonly ToolPresentationPlanItem[] | undefined {
  const source = Array.isArray(value.todos) ? value.todos : Array.isArray(value.items) ? value.items : Array.isArray(value.plan) ? value.plan : undefined
  if (source === undefined) return undefined
  const plan: ToolPresentationPlanItem[] = []
  for (const item of source) {
    if (!isRecord(item)) continue
    const label = text(item.content ?? item.text ?? item.step, MAX_PLAN_TEXT)
    if (label === undefined) continue
    if (plan.length >= MAX_PLAN_ITEMS) {
      state.truncated = true
      break
    }
    plan.push(Object.freeze({ text: label, status: planStatus(item) }))
  }
  return plan.length === 0 ? undefined : Object.freeze(plan)
}

function planStatus(item: Record<string, unknown>): ToolPresentationPlanItem["status"] {
  if (item.completed === true || item.status === "completed" || item.status === "done") return "completed"
  if (item.status === "in_progress" || item.status === "active" || item.status === "running") return "in_progress"
  return "pending"
}

function preview(value: unknown, state: { truncated: boolean }): string | undefined {
  return typeof value === "string" ? clip(value, MAX_PREVIEW_BYTES, state) : undefined
}

function clip(value: string, maxBytes: number, state: { truncated: boolean }): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  state.truncated = true
  let end = Math.min(value.length, Math.max(0, maxBytes))
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end = Math.floor(end * 0.9)
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function text(value: unknown, max: number, singleLine = false): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max || trimmed.includes("\0")) return undefined
  if (singleLine && /[\r\n]/.test(trimmed)) return undefined
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
