import { createInterface } from "node:readline"

// A stand-in for a coding tool in Agent Client Protocol mode (`copilot --acp`). The first argument
// picks a behaviour; the rest is what Runrail put on the command line, where `--fixture-fork` makes
// it offer `session/fork`. `--version` answers like the real binary so the same file stands in for
// detection.
const [mode = "normal", ...argv] = process.argv.slice(2)
if (argv.includes("--version") || mode === "--version") {
  process.stdout.write("GitHub Copilot CLI 1.0.62\n")
  process.exit(0)
}

const input = createInterface({ input: process.stdin })
let sessionId = "fixture-acp-session"
let turnCount = 0
let nextRequestId = 900
let sessionRequest: unknown
const setModel: string[] = []
const setConfig: string[] = []
const setMode: string[] = []
const forked: string[] = []
// What the route put in the environment; nothing else from it is reported.
const env = {
  OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION ?? null,
  GOOSE_MODE: process.env.GOOSE_MODE ?? null,
  // Reported only when started as a Gemini connection, so the other routes' echoes stay as they were.
  ...(process.env.GEMINI_CLI_HOME === undefined ? {} : { GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null }),
}
// The sign-in Runrail sent with `authenticate`, key included, so a test can see it arrived on stdin.
let authenticated: unknown = null
let pendingPrompt: { readonly id: unknown; readonly kind: "permission" | "refused" | "hang" } | undefined
let pendingRequestId: number | undefined

const MODELS = { currentModelId: "fixture-large", availableModels: [{ modelId: "fixture-large", name: "Fixture Large" }, { modelId: "fixture-small", name: "Fixture Small" }] }
const MODES = { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] }
// As Goose 1.53 sends them: the model is a select config option, and any id is taken.
let configModel = "fixture-configured"
const configOptions = (): unknown[] => [
  { id: "provider", name: "Provider", type: "select", currentValue: "fixture", options: [{ value: "fixture", name: "Fixture" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: configModel, options: [{ value: "fixture-configured", name: "Configured" }, { value: "fixture-listed", name: "Listed" }] },
]

for await (const line of input) {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    continue
  }
  if (!isRecord(value)) continue
  const method = typeof value.method === "string" ? value.method : undefined
  const params = isRecord(value.params) ? value.params : {}

  // An answer to a request this agent made.
  if (method === undefined && value.id === pendingRequestId && pendingPrompt !== undefined) {
    const prompt = pendingPrompt
    pendingPrompt = undefined
    pendingRequestId = undefined
    if (prompt.kind === "permission") {
      const outcome = isRecord(value.result) && isRecord(value.result.outcome) ? value.result.outcome : {}
      // Gemini CLI leaves its plan mode once its plan is approved, and says so.
      if (mode === "plan-other" && outcome.optionId === "allow-once" && turnCount === 1) update({ sessionUpdate: "current_mode_update", currentModeId: "agent" })
      say(`decision ${outcome.outcome === "selected" ? String(outcome.optionId) : String(outcome.outcome)}`)
    } else say(isRecord(value.error) ? `refused ${String(value.error.code)}` : "granted")
    emit({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } })
    continue
  }

  if (method === "initialize") {
    emit({ jsonrpc: "2.0", id: value.id, result: { protocolVersion: mode === "old-protocol" ? 0 : 1, agentCapabilities: { loadSession: mode !== "no-load", promptCapabilities: { image: true }, ...(argv.includes("--fixture-fork") ? { sessionCapabilities: { fork: {} } } : {}) }, agentInfo: { name: "Fixture", version: "1.0.62" }, authMethods: [{ id: "fixture-login", name: "Log in" }, { id: "gemini-api-key", name: "Gemini API key" }] } })
    continue
  }
  if (method === "authenticate") {
    const request = isRecord(value.params) ? value.params : {}
    authenticated = { methodId: request.methodId, meta: request._meta ?? null }
    if (mode === "auth-refused") emit({ jsonrpc: "2.0", id: value.id, error: { code: -32000, message: "API key not valid: sk-fixture-echoed" } })
    else emit({ jsonrpc: "2.0", id: value.id, result: {} })
    continue
  }
  if (method === "session/new") {
    if (mode === "auth") {
      emit({ jsonrpc: "2.0", id: value.id, error: { code: -32000, message: "Authentication required for never-read@example.invalid" } })
      continue
    }
    sessionRequest = { method, params }
    if (mode === "load-missing") sessionId = "fixture-acp-session-new"
    emit({ jsonrpc: "2.0", id: value.id, result: { sessionId, ...(mode === "models" ? { models: MODELS } : {}), ...(mode === "modes" || mode.startsWith("plan-") ? { modes: MODES } : {}), ...(mode === "config-models" || mode === "config-stubborn" ? { configOptions: configOptions() } : {}) } })
    continue
  }
  if (method === "session/load") {
    if (mode === "load-missing") {
      emit({ jsonrpc: "2.0", id: value.id, error: { code: -32002, message: "session not found" } })
      continue
    }
    sessionRequest = { method, params }
    sessionId = String(params.sessionId)
    // The old conversation is replayed before the answer; none of it belongs to a new turn.
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed question" } })
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed answer" } })
    emit({ jsonrpc: "2.0", id: value.id, result: mode === "models" ? { models: MODELS } : null })
    continue
  }
  if (method === "session/fork") {
    forked.push(String(params.sessionId))
    // A copy made before any conversation is open becomes the one this process answers on.
    if (sessionRequest === undefined) sessionId = `${String(params.sessionId)}-fork`
    emit({ jsonrpc: "2.0", id: value.id, result: { sessionId: `${String(params.sessionId)}-fork` } })
    continue
  }
  if (method === "session/set_model") {
    setModel.push(String(params.modelId))
    emit({ jsonrpc: "2.0", id: value.id, result: {} })
    continue
  }
  if (method === "session/set_config_option" && (mode === "config-models" || mode === "config-stubborn")) {
    setConfig.push(`${String(params.configId)}=${String(params.value)}`)
    // A stubborn agent answers but keeps its own model.
    if (mode === "config-models" && params.configId === "model") configModel = String(params.value)
    emit({ jsonrpc: "2.0", id: value.id, result: { configOptions: configOptions() } })
    continue
  }
  if (method === "session/set_mode") {
    setMode.push(String(params.modeId))
    emit({ jsonrpc: "2.0", id: value.id, result: {} })
    continue
  }
  if (method === "session/cancel") {
    if (mode === "deaf" || pendingPrompt === undefined) continue
    const prompt = pendingPrompt
    pendingPrompt = undefined
    emit({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } })
    continue
  }
  if (method !== "session/prompt") {
    if (value.id !== undefined) emit({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "method not found" } })
    continue
  }

  turnCount += 1
  if (mode === "prompt-quota") {
    emit({ jsonrpc: "2.0", id: value.id, error: { code: -32603, message: "Model request failed", data: { type: "RESOURCE_EXHAUSTED", details: "Weekly quota exceeded: sk-fixture-must-not-leak" } } })
    continue
  }
  if (mode === "prompt-key-refused") {
    emit({ jsonrpc: "2.0", id: value.id, error: { code: 400, message: "API key not valid. Please pass a valid API key." } })
    continue
  }
  if (mode === "long-reply") {
    // Past one event's text, with a NUL the protocol refuses.
    say(`${"r".repeat(300_000)}\0end`)
    emit({ jsonrpc: "2.0", id: value.id, result: { stopReason: "end_turn" } })
    continue
  }
  if (mode === "echo" || mode === "models" || mode === "modes" || mode === "config-models") {
    say(JSON.stringify({ argv, session: sessionRequest, prompt: params.prompt, setModel, setMode, setConfig, forked, env, authenticated }))
    emit({ jsonrpc: "2.0", id: value.id, result: { stopReason: "end_turn" } })
    continue
  }
  if (mode === "plan-switch" || mode === "plan-other") {
    // First the agent asks to leave plan mode with its plan, then (next turn) to edit a file.
    const leaving = turnCount === 1
    const toolCall = !leaving
      ? { toolCallId: "edit-call", title: "Edit src/total.ts", kind: "edit", status: "pending", locations: [{ path: "src/total.ts" }] }
      : mode === "plan-switch"
        ? { toolCallId: "plan-call", title: "Ready to code?", kind: "switch_mode", status: "pending", rawInput: { plan: "1. Fix the total\n2. Add a test" } }
        : { toolCallId: "plan-call", title: "Requesting plan approval for: /plans/fix.md", kind: "other", status: "pending", locations: [{ path: "/plans/fix.md" }] }
    // Gemini CLI shows the call before it asks; the ACP Claude adapter asks first.
    if (mode === "plan-other" || !leaving) update({ sessionUpdate: "tool_call", ...toolCall })
    pendingPrompt = { id: value.id, kind: "permission" }
    pendingRequestId = ++nextRequestId
    emit({ jsonrpc: "2.0", id: pendingRequestId, method: "session/request_permission", params: { sessionId, toolCall, options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }, { optionId: "allow-always", name: "Yes, and allow edits", kind: "allow_always" }, { optionId: "reject-once", name: "No, keep planning", kind: "reject_once" }] } })
    continue
  }
  if (mode === "bad-permission") {
    pendingPrompt = { id: value.id, kind: "refused" }
    pendingRequestId = ++nextRequestId
    emit({ jsonrpc: "2.0", id: pendingRequestId, method: "session/request_permission" })
    continue
  }
  if (mode.startsWith("approval")) {
    const late = mode === "approval-late"
    const goose = mode === "approval-goose"
    const bare = mode === "approval-bare" || late
    // An agent that offers only a standing allow, or only a standing reject, never a one-time one.
    const alwaysOnly = mode === "approval-always-only"
    const rejectAlwaysOnly = mode === "approval-reject-always-only"
    const kind = mode === "approval" || bare || alwaysOnly || rejectAlwaysOnly ? "execute" : goose ? "other" : mode.slice("approval-".length)
    // OpenCode's order: the tool appears empty, its input follows, then a request that repeats none of it.
    if (late) {
      update({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "bash", kind, status: "pending", rawInput: {} })
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress", rawInput: { command: "make build" } })
    }
    pendingPrompt = { id: value.id, kind: "permission" }
    pendingRequestId = ++nextRequestId
    emit({
      jsonrpc: "2.0",
      id: pendingRequestId,
      method: "session/request_permission",
      params: {
        sessionId,
        // Some agents title a request with the bare tool name and put the command in its input.
        toolCall: goose
          ? { toolCallId: "call-1", title: "write · /work/a/very/long/project/pa...", kind, status: "pending", rawInput: { path: "/work/a/very/long/project/path/notes.txt", content: "hi" } }
          : bare
            ? { toolCallId: "call-1", title: "bash", kind, status: "pending", rawInput: late ? {} : { command: "make build" } }
            : { toolCallId: "call-1", title: "Run `make build`", kind, status: "pending" },
        options: [...(alwaysOnly ? [] : [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]), { optionId: "allow-always", name: "Always allow", kind: "allow_always" }, rejectAlwaysOnly ? { optionId: "reject-always", name: "Never allow", kind: "reject_always" } : { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
      },
    })
    continue
  }
  if (mode === "hang" || mode === "deaf") {
    say("working")
    pendingPrompt = { id: value.id, kind: "hang" }
    continue
  }
  if (mode === "crash") {
    say("about to fall over")
    process.stderr.write("loading settings\nfatal: upstream refused key sk-ant-fixturekey0123456789\n    at connect (fixture.ts:1:1)\n")
    process.exit(3)
  }
  if (mode === "prompt-error") {
    emit({ jsonrpc: "2.0", id: value.id, error: { code: -32603, message: "Model fixture-9 is not available\nPick another model" } })
    continue
  }
  if (mode === "tool-failed") {
    update({ sessionUpdate: "tool_call", toolCallId: "build-call", title: "Run npm run build", kind: "execute", status: "in_progress" })
    update({ sessionUpdate: "tool_call_update", toolCallId: "build-call", status: "failed", content: [{ type: "content", content: { type: "text", text: "> build\nerror: Missing script: build" } }] })
    emit({ jsonrpc: "2.0", id: value.id, result: { stopReason: "end_turn" } })
    continue
  }
  if (mode === "late-text") {
    // OpenCode's order: the answer to the prompt, then the end of the reply.
    say("the start")
    emit({ jsonrpc: "2.0", id: value.id, result: { stopReason: "end_turn" } })
    await Bun.sleep(100)
    say(" and the end")
    continue
  }
  if (mode === "silent-failure") {
    // How OpenCode ends a turn whose model call failed: no output, no tokens, a normal ending.
    emit({ jsonrpc: "2.0", id: value.id, result: { stopReason: "end_turn", usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } } })
    continue
  }
  if (mode === "refusal" || mode === "odd-stop") {
    emit({ jsonrpc: "2.0", id: value.id, result: { stopReason: mode === "refusal" ? "refusal" : "fixture_future_reason" } })
    continue
  }
  if (mode === "noise") {
    process.stdout.write("a stray log line, not a message\n")
    emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "someone-elses-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "leaked" } } } })
    emit({ jsonrpc: "2.0", method: "fixture/future_notification", params: { text: "leaked" } })
    update({ sessionUpdate: "fixture_future_update", content: { type: "text", text: "leaked" } })
    update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "leaked" } })
    update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "leaked" }] })
    // A request for something Runrail never offered; the answer decides what the agent says.
    pendingPrompt = { id: value.id, kind: "refused" }
    pendingRequestId = ++nextRequestId
    emit({ jsonrpc: "2.0", id: pendingRequestId, method: "fs/read_text_file", params: { sessionId, path: "/etc/hosts" } })
    continue
  }

  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking it over" } })
  say("Looking. ")
  update({ sessionUpdate: "tool_call", toolCallId: `call-${turnCount}`, title: "Read package.json", kind: "read", status: "pending", rawInput: { path: "package.json" }, locations: [{ path: "package.json" }] })
  update({ sessionUpdate: "tool_call_update", toolCallId: `call-${turnCount}`, status: "in_progress" })
  update({ sessionUpdate: "tool_call_update", toolCallId: `call-${turnCount}`, status: "completed", content: [{ type: "content", content: { type: "text", text: "file text" } }] })
  update({ sessionUpdate: "tool_call_update", toolCallId: `late-${turnCount}`, title: "Run tests", kind: "execute", status: "failed" })
  update({ sessionUpdate: "plan", entries: [{ content: "Read the file", priority: "high", status: "completed" }, { content: "Answer", priority: "medium", status: "in_progress" }] })
  say(`fixture answer ${turnCount}`)
  emit({ jsonrpc: "2.0", id: value.id, result: { stopReason: mode === "max-tokens" ? "max_tokens" : "end_turn" } })
}

function say(text: string): void {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
}

function update(value: Record<string, unknown>): void {
  emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } })
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
