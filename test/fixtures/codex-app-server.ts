import { createInterface } from "node:readline"
import { writeFileSync } from "node:fs"

const mode = process.argv[2] ?? "normal"
// Stands in for `codex` on PATH too, where Runrail first asks its version.
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.0\n")
  process.exit(0)
}
const input = createInterface({ input: process.stdin })
let threadId = "fixture-codex-thread"
let turnCount = 0
let resumeCount = 0
let pendingApprovalId: number | string | undefined
let pendingApprovalTurn: string | undefined
let pendingRefusalId: string | undefined
let pendingToolId: string | undefined
let pendingToolName = "browser_screenshot"
let pendingQuestionId: string | undefined
let pendingElicitationId: string | undefined
/** Server requests sent for their answers alone, and those answers by request id. */
const awaitingAnswers = new Set<string>()
const serverAnswers: Record<string, unknown> = {}
const subAgentThread = "fixture-sub-thread"
/** An MCP server's form, as Codex passes one on, for each "elicitation" mode. */
const deployForm = { type: "object", properties: { target: { type: "string", title: "Target", oneOf: [{ const: "stg", title: "Staging" }, { const: "prd", title: "Production" }] }, notes: { type: "string", title: "Release notes", description: "One line", minLength: 3 }, notify: { type: "boolean", title: "Notify the team" } }, required: ["target"] }
const elicitations: Record<string, Record<string, unknown>> = {
  elicitation: { mode: "form", _meta: null, message: "Where should the release go?", requestedSchema: deployForm },
  "elicitation-withdrawn": { mode: "form", _meta: null, message: "Where should the release go?", requestedSchema: deployForm },
  "elicitation-unsupported": { mode: "form", _meta: null, message: "How many replicas?", requestedSchema: { type: "object", properties: { replicas: { type: "object", title: "Replicas" } } } },
  // How Codex asks before an MCP tool runs: a form with no fields.
  "elicitation-confirm": { mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" }, message: "Allow deploys to run ship?", requestedSchema: { type: "object", properties: {} } },
}
/** The turn waiting for guidance in "steer" mode. */
let steering: string | undefined
let answer = ""
// What the client asked for, echoed back as the answer in "echo" mode.
let threadRequest: unknown
// The key login and what the process was started with, echoed in "echo" mode.
let login: unknown = null
const started = { args: process.argv.slice(3), CODEX_HOME: process.env.CODEX_HOME ?? null, CODEX_API_KEY: process.env.CODEX_API_KEY ?? null }

for await (const line of input) {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    continue
  }
  if (!isRecord(value)) continue
  const method = typeof value.method === "string" ? value.method : undefined
  if (method === "initialize") {
    if (mode === "stderr") process.stderr.write("x".repeat(512 * 1024))
    emit({ id: value.id, result: { userAgent: "runrail-fixture", codexHome: "/tmp/codex-fixture", platformFamily: "unix", platformOs: "test" } })
    continue
  }
  if (method === "initialized") {
    if (mode === "early-requests") {
      // Before any turn: an approval, the time, and a token refresh 0.160.0 sends to a client that signed it in with tokens.
      ask("early-approval", "item/commandExecution/requestApproval", { threadId, turnId: "fixture-turn-0", itemId: "early-command", startedAtMs: Date.now(), reason: "early" })
      ask("early-time", "currentTime/read", { threadId })
      ask("early-refresh", "account/chatgptAuthTokens/refresh", { reason: "unauthorized", previousAccountId: null })
    }
    if (mode === "elicitation-early") ask("early-elicitation", "mcpServer/elicitation/request", { threadId, turnId: null, serverName: "deploys", ...elicitations.elicitation })
    continue
  }
  if (method === "account/login/start") {
    login = value.params
    emit({ id: value.id, result: { type: "apiKey" } })
    continue
  }
  if (method === "account/read" && mode === "limits") {
    emit({ id: value.id, result: { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" } } })
    continue
  }
  if (method === "account/rateLimits/read" && mode === "limits") {
    const rateLimits = { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_790_000_000 }, secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_790_400_000 }, credits: { hasCredits: true, unlimited: false, balance: "12.50" }, individualLimit: null, spendControlReached: null, planType: "pro", rateLimitReachedType: null }
    emit({ id: value.id, result: { ordinaryUsageAllowed: true, rateLimits, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: "fixture-account", rateLimitUpsell: null } })
    continue
  }
  if (method === "config/read" && mode === "limits") {
    emit({ id: value.id, result: { config: { model_auto_compact_token_limit: 800 }, origins: {} } })
    continue
  }
  if (method === "thread/compact/start") {
    // Codex's own compaction, in the order 0.160.0 sends it: a turn of its own, a report for the
    // summarizing request, then the compacted history with every count zero but the total.
    const turnId = `fixture-compact-${++turnCount}`
    emit({ id: value.id, result: {} })
    emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } })
    emit({ method: "item/started", params: { threadId, turnId, item: { type: "contextCompaction", id: `compaction-${turnCount}` } } })
    emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { inputTokens: 210, outputTokens: 20, totalTokens: 245 }, last: { inputTokens: 200, outputTokens: 20, totalTokens: 220 }, modelContextWindow: 1000 } } })
    emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { inputTokens: 210, outputTokens: 20, totalTokens: 245 }, last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 9 }, modelContextWindow: 1000 } } })
    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "contextCompaction", id: `compaction-${turnCount}` }, completedAtMs: Date.now() } })
    emit({ method: "warning", params: { threadId, message: "Long threads and multiple compactions can cause the model to be less accurate." } })
    emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } })
    continue
  }
  if (method === "thread/start") {
    threadRequest = { method, params: value.params }
    if (mode === "resume-missing") threadId = "fixture-codex-thread-new"
    // "auto-review": a Codex that runs its own reviewer, as 0.160 answers when asked for it.
    emit({ id: value.id, result: { thread: { id: threadId }, ...(mode === "auto-review" ? { approvalsReviewer: "auto_review" } : {}) } })
    emit({ method: "thread/started", params: { thread: { id: threadId } } })
    continue
  }
  if (method === "thread/resume") {
    resumeCount += 1
    if (mode === "strict-resume" && resumeCount > 1) {
      emit({ id: value.id, error: { code: -32002, message: "duplicate resume" } })
      continue
    }
    if (mode === "resume-missing") {
      emit({ id: value.id, error: { code: -32600, message: "no rollout found for thread" } })
      continue
    }
    threadRequest = { method, params: value.params }
    if (isRecord(value.params) && typeof value.params.threadId === "string") threadId = value.params.threadId
    emit({ id: value.id, result: { thread: { id: threadId } } })
    continue
  }
  if (method === "thread/fork") {
    const from = isRecord(value.params) && typeof value.params.threadId === "string" ? value.params.threadId : threadId
    // A thread from Codex's own history becomes the one this client continues.
    if (from !== threadId) {
      threadRequest = { method, params: value.params }
      threadId = `${from}-fork`
    }
    emit({ id: value.id, result: { thread: { id: `${from}-fork` } } })
    continue
  }
  if (method === "thread/revert") {
    // Codex 0.160 drops the named turn and every later one from the thread's history.
    if (mode === "revert-refused") {
      emit({ id: value.id, error: { code: -32600, message: "turn not found" } })
      continue
    }
    threadRequest = { method, params: value.params }
    emit({ id: value.id, result: { thread: { id: threadId } } })
    continue
  }
  if (method === "turn/steer") {
    // "steer-stale": Codex has moved on to a turn of its own, so the turn named is not running.
    const running = mode === "steer-stale" ? `${pendingApprovalTurn ?? ""}-next` : steering
    const params = isRecord(value.params) ? value.params : {}
    const words = Array.isArray(params.input) && isRecord(params.input[0]) && typeof params.input[0].text === "string" ? params.input[0].text : ""
    if (running === undefined || params.expectedTurnId !== running || params.threadId !== threadId) {
      emit({ id: value.id, error: { code: -32600, message: "expected turn does not match the active turn" } })
      continue
    }
    emit({ id: value.id, result: { turnId: running } })
    // The guidance is read after the running command's result.
    emit({ method: "item/completed", params: { threadId, turnId: running, item: { type: "commandExecution", id: `command-${turnCount}`, command: "sleep 1", status: "completed", exitCode: 0 }, completedAtMs: Date.now() } })
    steering = undefined
    answer = `steered: ${words}`
    finishTurn(running)
    continue
  }
  if (method === "turn/interrupt") {
    if (mode === "quota-stubborn" || mode === "silent") continue
    steering = undefined
    emit({ id: value.id, result: {} })
    emit({ method: "turn/completed", params: { threadId, turn: { id: pendingApprovalTurn ?? "fixture-turn", status: "interrupted", items: [] } } })
    continue
  }
  if (method === "turn/start" && mode === "turn-refused") {
    emit({ id: value.id, error: { code: -32600, message: "thread not loaded\nstart a new one" } })
    continue
  }
  if (method === "turn/start") {
    const turnId = `fixture-turn-${++turnCount}`
    pendingApprovalTurn = turnId
    emit({ id: value.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } })
    emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } })
    if (mode === "subagent-output") {
      spawnSubAgent(turnId)
      const child = { threadId: subAgentThread, turnId: "child-turn" }
      emit({ method: "turn/started", params: { threadId: subAgentThread, turn: { id: "child-turn", status: "inProgress" } } })
      emit({ method: "item/agentMessage/delta", params: { ...child, itemId: "child-message", delta: "Inspecting files" } })
      emit({ method: "item/reasoning/textDelta", params: { ...child, itemId: "child-reasoning", delta: "Checking the parser" } })
      emit({ method: "item/started", params: { ...child, item: { type: "commandExecution", id: "child-command", command: "rg parser", status: "inProgress" } } })
      emit({ method: "item/commandExecution/outputDelta", params: { ...child, itemId: "child-command", delta: "parser.ts" } })
      emit({ method: "item/completed", params: { ...child, item: { type: "commandExecution", id: "child-command", command: "rg parser", status: "completed", exitCode: 0, aggregatedOutput: "parser.ts" } } })
      emit({ method: "item/completed", params: { ...child, item: { type: "agentMessage", id: "child-message", text: "Found the parser" } } })
      emit({ method: "item/agentMessage/delta", params: { threadId: "unrelated-thread", turnId: "other-turn", itemId: "other-message", delta: "Unrelated output" } })
      emit({ method: "turn/completed", params: { threadId: subAgentThread, turn: { id: "child-turn", status: "completed" } } })
      answer = "Parent summary"
      finishTurn(turnId)
      continue
    }
    if (mode === "silent") {
      if (process.argv[3] !== undefined) writeFileSync(process.argv[3], JSON.stringify(process.pid))
      continue
    }
    if (mode === "quota-retry" || mode === "quota-terminal" || mode === "quota-stubborn") {
      if (mode === "quota-stubborn" && process.argv[3] !== undefined) writeFileSync(process.argv[3], JSON.stringify(process.pid))
      const error = { message: "Weekly usage limit reached. sk-fixture-must-not-leak", codexErrorInfo: "usageLimitExceeded" }
      if (mode !== "quota-terminal") emit({ method: "error", params: { threadId, turnId, willRetry: true, error } })
      else emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error } } })
      continue
    }
    if (mode === "key-refused") {
      // Codex's answer to a refused key: a retry, then more, until the turn is interrupted.
      emit({ method: "error", params: { threadId, turnId, willRetry: true, error: { message: "Reconnecting... 1/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: "unexpected status 401 Unauthorized: Incorrect API key provided: sk-fixture-echoed" } } })
      continue
    }
    if (mode === "limits") emit({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: null }, secondary: null, planType: null } } })
    if (mode === "reasoning") {
      emit({ method: "turn/plan/updated", params: { threadId, turnId, explanation: "fixture plan", plan: [{ step: "inspect", status: "completed" }, { step: "edit", status: "inProgress" }, "bad-entry", { step: "verify", status: "pending" }] } })
      emit({ method: "item/reasoning/summaryPartAdded", params: { threadId, turnId, itemId: "reasoning-1", summaryIndex: 0 } })
      emit({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "reasoning-1", delta: "thinking " } })
      emit({ method: "item/reasoning/textDelta", params: { threadId, turnId, itemId: "reasoning-1", delta: "hard" } })
      emit({ method: "item/plan/delta", params: { threadId, turnId, itemId: "plan-1", delta: "ignored" } })
      emit({ method: "item/completed", params: { threadId, turnId, item: { type: "reasoning", id: "reasoning-1", summary: ["thinking hard"], content: [] }, completedAtMs: Date.now() } })
    }
    if (mode === "steer" || mode === "steer-stale") {
      // A command runs until guidance arrives or the turn is interrupted.
      steering = turnId
      emit({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: `command-${turnCount}`, command: "sleep 1", status: "inProgress" } } })
      continue
    }
    if (mode === "vendor-failure") {
      emit({ method: "item/completed", params: { threadId, turnId, item: { type: "mcpToolCall", id: `mcp-${turnCount}`, server: "docs", tool: "search", status: "failed", error: { message: "docs server said\tno" } }, completedAtMs: Date.now() } })
      emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", items: [], error: { message: "model overloaded\nretry later", codexErrorInfo: null } } } })
      continue
    }
    if (mode === "failed-command") {
      // Codex's lifecycle status is "completed" for a command that ran and exited 1.
      emit({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: `command-${turnCount}`, command: "false", status: "inProgress" } } })
      emit({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: `command-${turnCount}`, command: "false", status: "completed", exitCode: 1 }, completedAtMs: Date.now() } })
    }
    if (mode === "browser" || mode === "connector" || mode === "browser-foreign" || mode === "threads" || mode === "computer" || mode === "images") {
      // The model calls a tool Runrail gave the thread: a browser screenshot, a connector read, a
      // message to another thread, a click in an app, or a picture. In browser-foreign the call names another thread, as a misrouted frame would.
      const [tool, args] = mode === "connector" ? ["slack_listChannels", { limit: 1 }] : mode === "threads" ? ["send_to_thread", { thread: "Tests", message: "run them", wait: true }] : mode === "computer" ? ["computer_click", { app: "Notes", x: 10, y: 20 }] : mode === "images" ? ["image_generate", { prompt: "a fox", path: "fox.png" }] : ["browser_screenshot", {}]
      pendingToolId = `tool-${turnCount}`
      pendingToolName = tool
      emit({ method: "item/started", params: { threadId, turnId, item: { type: "dynamicToolCall", id: `call-${turnCount}`, tool, arguments: args, status: "inProgress" } } })
      emit({ id: pendingToolId, method: "item/tool/call", params: { threadId: mode === "browser-foreign" ? "another-thread" : threadId, turnId, callId: `call-${turnCount}`, tool, arguments: args } })
      continue
    }
    if (mode === "auto-review" || mode === "auto-review-refused") {
      // Codex's reviewer approves a command and denies a patch; neither reaches the person.
      const command = { type: "command", source: "shell", command: "/bin/zsh -lc 'curl -sSI https://example.com'", cwd: "/workspace" }
      const patch = { type: "applyPatch", cwd: "/workspace", files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }
      const review = (status: string, riskLevel: string | null, rationale: string | null) => ({ status, riskLevel, userAuthorization: status === "inProgress" ? null : "unknown", rationale })
      emit({ method: "item/autoApprovalReview/started", params: { threadId, turnId, startedAtMs: 1, reviewId: "review-1", targetItemId: `command-${turnCount}`, review: review("inProgress", null, null), action: command } })
      // 0.160 restates each decision as a warning, in this form; other warnings are its own.
      emit({ method: "guardianWarning", params: { threadId, message: "Automatic approval review approved (risk: low, authorization: high): Reads a public page." } })
      emit({ method: "guardianWarning", params: { threadId, message: "Automatic approval review failed:\nreviewer unavailable" } })
      emit({ method: "item/autoApprovalReview/completed", params: { threadId, turnId, startedAtMs: 1, completedAtMs: 2, reviewId: "review-1", targetItemId: `command-${turnCount}`, decisionSource: "agent", review: review("approved", "low", "Reads a public page."), action: command } })
      emit({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: `patch-${turnCount}`, changes: [], status: "inProgress" } } })
      emit({ method: "item/autoApprovalReview/completed", params: { threadId, turnId, startedAtMs: 3, completedAtMs: 4, reviewId: "review-2", targetItemId: `patch-${turnCount}`, decisionSource: "agent", review: review("denied", "high", "Rewrites files outside the task."), action: patch } })
      emit({ method: "item/completed", params: { threadId, turnId, item: { type: "fileChange", id: `patch-${turnCount}`, changes: [], status: "declined" }, completedAtMs: Date.now() } })
      emit({ method: "item/autoApprovalReview/completed", params: { threadId: "another-thread", turnId, startedAtMs: 5, completedAtMs: 6, reviewId: "review-3", targetItemId: null, decisionSource: "agent", review: review("approved", "low", "leaked"), action: command } })
      emit({ method: "item/autoApprovalReview/completed", params: { threadId, turnId, startedAtMs: 7, completedAtMs: 8, reviewId: "bad id!", targetItemId: null, decisionSource: "agent", review: review("approved", "low", "malformed"), action: command } })
    }
    if (mode === "foreign-approval") {
      // None is this turn's to ask: a thread that is no sub-agent of this one, and a turn that has ended.
      emit({ method: "thread/started", params: { thread: { id: "another-thread", parentThreadId: "someone-elses-thread", agentNickname: "Stranger" } } })
      ask(`foreign-command-${turnCount}`, "item/commandExecution/requestApproval", { threadId: "another-thread", turnId: "another-turn", itemId: "other-command", startedAtMs: Date.now() })
      ask(`foreign-permissions-${turnCount}`, "item/permissions/requestApproval", { threadId: "another-thread", turnId: "another-turn", itemId: "other-permissions", environmentId: null, startedAtMs: Date.now(), cwd: "/", reason: null, permissions: {} })
      ask(`stale-patch-${turnCount}`, "item/fileChange/requestApproval", { threadId, turnId: "stale-turn", itemId: "stale-patch", startedAtMs: Date.now() })
      ask(`stale-question-${turnCount}`, "item/tool/requestUserInput", { threadId, turnId: "stale-turn", itemId: "stale-ask", isBlocking: true, questions: [{ id: "env", header: "Target", question: "Deploy where?", options: null }] })
      ask(`turn-time-${turnCount}`, "currentTime/read", { threadId })
      continue
    }
    if (mode === "subagent-approval" || mode === "subagent-withdrawn") spawnSubAgent(turnId)
    if (mode === "subagent-withdrawn") {
      // Codex settles the sub-agent's request itself before anyone answers.
      emit({ id: `sub-patch-${turnCount}`, method: "item/fileChange/requestApproval", params: { threadId: subAgentThread, turnId: "fixture-sub-turn", itemId: "sub-patch", startedAtMs: Date.now() } })
      emit({ method: "serverRequest/resolved", params: { threadId: subAgentThread, requestId: `sub-patch-${turnCount}` } })
      finishTurn(turnId)
      continue
    }
    if (mode === "echo") {
      const { input: _input, ...turn } = isRecord(value.params) ? value.params : {}
      answer = JSON.stringify({ thread: threadRequest, turn, login, started })
    } else if (mode === "early-requests" || mode === "elicitation-early") {
      answer = JSON.stringify(serverAnswers)
    } else if (mode === "long-reply") {
      // Past one event's text, with a NUL the protocol refuses.
      answer = `${"r".repeat(300_000)}\0end`
    } else {
      answer = `fixture answer ${turnCount}`
    }
    if (mode === "empty-delta") emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: `message-${turnCount}`, delta: "" } })
    emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: `message-${turnCount}`, delta: answer } })
    if ((mode === "approval" || mode === "file-approval" || mode === "legacy-approval") && pendingApprovalId === undefined) {
      pendingApprovalId = `approval-${turnCount}`
      if (mode === "legacy-approval") emit({ id: pendingApprovalId, method: "execCommandApproval", params: { conversationId: threadId, callId: `command-${turnCount}`, approvalId: "fixture-approval", command: ["true"], cwd: "/", reason: "fixture command", parsedCmd: [] } })
      else emit({ id: pendingApprovalId, method: mode === "file-approval" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: `command-${turnCount}`, startedAtMs: Date.now(), approvalId: "fixture-approval", reason: "fixture command" } })
      continue
    }
    if (mode === "subagent-approval" && pendingApprovalId === undefined) {
      // The sub-agent asks from its own thread and turn, which are not the running turn's.
      pendingApprovalId = `approval-${turnCount}`
      emit({ id: pendingApprovalId, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: subAgentThread, turnId: "fixture-sub-turn", itemId: "sub-command", startedAtMs: Date.now(), environmentId: null, command: "ls", cwd: "/workspace", reason: "fixture command" } })
      continue
    }
    if ((mode === "question" || mode === "question-withdrawn") && pendingQuestionId === undefined) {
      pendingQuestionId = `question-${turnCount}`
      emit({ id: pendingQuestionId, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: `ask-${turnCount}`, isBlocking: true, questions: [{ id: "env", header: "Target", question: "Deploy where?", options: [{ label: "staging", description: "Safe" }, { label: "prod", description: "Live" }] }, { id: "token", header: "Token", question: "Paste the token", isSecret: true, options: null }] } })
      if (mode === "question-withdrawn") {
        emit({ method: "serverRequest/resolved", params: { threadId, requestId: pendingQuestionId } })
        pendingQuestionId = undefined
        finishTurn(turnId)
      }
      continue
    }
    const elicitation = elicitations[mode]
    if (elicitation !== undefined && pendingElicitationId === undefined) {
      pendingElicitationId = `elicitation-${turnCount}`
      emit({ id: pendingElicitationId, method: "mcpServer/elicitation/request", params: { threadId, turnId, serverName: "deploys", ...elicitation } })
      if (mode === "elicitation-withdrawn") {
        emit({ method: "serverRequest/resolved", params: { threadId, requestId: pendingElicitationId } })
        pendingElicitationId = undefined
        finishTurn(turnId)
      }
      continue
    }
    if (mode === "noise") {
      // Everything a real server may say that is not part of this turn.
      emit({ method: "account/updated", params: { authMode: "chatgpt" } })
      emit({ method: "fixture/futureNotification", params: { threadId, turnId, anything: true } })
      emit({ method: "thread/status/changed" })
      emit({ method: "item/agentMessage/delta", params: { threadId: "another-thread", turnId: "another-turn", itemId: "other", delta: "leaked" } })
      emit({ method: "thread/started", params: { thread: { id: "another-thread" } } })
      emit({ method: "item/agentMessage/delta", params: { threadId, turnId: "stale-turn", itemId: "stale", delta: "leaked" } })
      emit({ method: "error", params: { threadId, turnId, willRetry: true, error: { message: "stream dropped" } } })
      emit({ id: "fixture-late-response", result: {} })
      pendingRefusalId = `refusal-${turnCount}`
      emit({ id: pendingRefusalId, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: "question-1", questions: [] } })
      continue
    }
    finishTurn(turnId)
    continue
  }
  if (value.method === undefined && typeof value.id === "string" && awaitingAnswers.delete(value.id)) {
    serverAnswers[value.id] = value.result ?? value.error
    if (awaitingAnswers.size === 0 && mode === "foreign-approval") {
      answer = JSON.stringify(serverAnswers)
      finishTurn(pendingApprovalTurn ?? "fixture-turn")
    }
    continue
  }
  if (value.id !== undefined && pendingToolId !== undefined && value.id === pendingToolId) {
    pendingToolId = undefined
    const params = isRecord(threadRequest) && isRecord(threadRequest.params) ? threadRequest.params : {}
    const tools = Array.isArray(params.dynamicTools) ? params.dynamicTools.map((tool) => (isRecord(tool) ? tool.name : undefined)) : []
    const result = isRecord(value.result) ? value.result : {}
    answer = JSON.stringify({ method: isRecord(threadRequest) ? threadRequest.method : undefined, tools, result })
    emit({ method: "item/completed", params: { threadId, turnId: pendingApprovalTurn, item: { type: "dynamicToolCall", id: `call-${turnCount}`, tool: pendingToolName, arguments: {}, status: result.success === true ? "completed" : "failed", success: result.success === true, contentItems: null } } })
    finishTurn(pendingApprovalTurn ?? "fixture-turn")
    continue
  }
  if (value.id !== undefined && pendingElicitationId !== undefined && value.id === pendingElicitationId) {
    pendingElicitationId = undefined
    answer = `elicited ${JSON.stringify(value.result ?? value.error)}`
    finishTurn(pendingApprovalTurn ?? "fixture-turn")
    continue
  }
  if (value.id !== undefined && pendingQuestionId !== undefined && value.id === pendingQuestionId) {
    pendingQuestionId = undefined
    answer = `answers ${JSON.stringify(value.result ?? value.error)}`
    finishTurn(pendingApprovalTurn ?? "fixture-turn")
    continue
  }
  if (value.id !== undefined && pendingRefusalId !== undefined && value.id === pendingRefusalId) {
    pendingRefusalId = undefined
    const refused = isRecord(value.error) && value.error.code === -32601
    if (refused) finishTurn(pendingApprovalTurn ?? "fixture-turn")
    else emit({ method: "turn/completed", params: { threadId, turn: { id: pendingApprovalTurn ?? "fixture-turn", status: "failed", items: [] } } })
    continue
  }
  if (value.id !== undefined && pendingApprovalId !== undefined && value.id === pendingApprovalId) {
    const decision = isRecord(value.result) ? value.result.decision : undefined
    // Each request family has its own answer shape; the other family's is an error.
    const valid = mode === "legacy-approval"
      ? decision === "approved" || (isRecord(decision) && isRecord(decision.denied))
      : decision === "accept" || decision === "decline"
    if (!valid) {
      emit({ id: value.id, error: { code: -32003, message: "invalid approval decision" } })
      emit({ method: "turn/completed", params: { threadId, turn: { id: pendingApprovalTurn ?? "fixture-turn", status: "failed", items: [] } } })
      continue
    }
    pendingApprovalId = undefined
    // The command the approval was for ends as Codex reports it: run, or declined.
    if (mode === "approval") emit({ method: "item/completed", params: { threadId, turnId: pendingApprovalTurn ?? "fixture-turn", item: { type: "commandExecution", id: `command-${turnCount}`, command: "true", status: decision === "accept" ? "completed" : "declined", ...(decision === "accept" ? { exitCode: 0 } : {}) }, completedAtMs: Date.now() } })
    // A legacy refusal carries words for the model; the fixture repeats them so a test can read them.
    answer = `decision ${typeof decision === "string" ? decision : `denied: ${String((decision as { denied: { rejection?: unknown } }).denied.rejection)}`}`
    finishTurn(pendingApprovalTurn ?? "fixture-turn")
    continue
  }
  if (value.id !== undefined) emit({ id: value.id, error: { code: -32601, message: "fixture method unavailable" } })
}

function finishTurn(turnId: string): void {
  emit({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: `message-${turnCount}`, text: answer, phase: null, memoryCitation: null, delivery: null, questions: null }, completedAtMs: Date.now() } })
  emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, last: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, modelContextWindow: 1000 } } })
  emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } })
}

/** A spawned agent: the call starts, the agent's thread starts, and the call ends naming that thread. */
function spawnSubAgent(turnId: string): void {
  const item = { type: "collabAgentToolCall", id: `spawn-${turnCount}`, tool: "spawnAgent", senderThreadId: threadId, prompt: "look around", model: null, reasoningEffort: null, agentsStates: {} }
  emit({ method: "item/started", params: { threadId, turnId, item: { ...item, status: "inProgress", receiverThreadIds: [] } } })
  emit({ method: "thread/started", params: { thread: { id: subAgentThread, parentThreadId: threadId, agentNickname: "Euclid", agentRole: "explorer" } } })
  emit({ method: "item/completed", params: { threadId, turnId, item: { ...item, status: "completed", receiverThreadIds: [subAgentThread] }, completedAtMs: Date.now() } })
}

/** A server request whose answer is kept, to come back in the turn's reply. */
function ask(id: string, method: string, params: unknown): void {
  awaitingAnswers.add(id)
  emit({ id, method, params })
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
