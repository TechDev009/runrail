import { existsSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"

// A stand-in for the `claude`, `codex`, `pi`, `opencode`, `gemini` and `goose` binaries. A turn answers with the argument list and the
// prompt it was given, so a test sees exactly what Runrail forwarded. The account fields below are
// bait: a probe that reads them would surface them, and the tests assert that none appear.
const [kind = "", mode = "normal", ...argv] = process.argv.slice(2)
const BAIT_EMAIL = "never-read@example.invalid"

if (kind === "claude") await claude()
else if (kind === "codex") await codex()
else if (kind === "pi") pi()
else if (kind === "opencode") opencode()
else if (kind === "gemini" || kind === "goose") {
  if (argv[0] === "--version") process.stdout.write(kind === "gemini" ? "0.62.0\n" : "goose 1.53.0\n")
  else process.exitCode = 64
} else process.exitCode = 64

/** OpenCode answers its version and the models of every provider it can reach, one id a line. */
function opencode(): void {
  if (argv[0] === "--version") process.stdout.write("1.2.26\n")
  else if (argv[0] === "models") process.stdout.write(mode === "no-models" ? "" : `fixture/large\nfixture/small\nfixture/large\nnot a model id\n${BAIT_EMAIL}\n`)
  else process.exitCode = 64
}

/** Pi answers two questions here: its version, and the table of models it can run. */
function pi(): void {
  if (argv[0] === "--version") {
    process.stdout.write("0.84.1\n")
    return
  }
  if (argv[0] !== "--list-models" || mode === "old") {
    process.stderr.write("error: unknown option\n")
    process.exitCode = 1
    return
  }
  if (mode === "no-models") {
    process.stdout.write("No models available. Use /login or set an API key.\n")
    return
  }
  const rows = [
    ["provider", "model", "context", "max-out", "thinking", "images"],
    ["fixture-hub", "fixture-large", "200K", "64K", "yes", "yes"],
    ["fixture-hub", "fixture-small", "128K", "16K", "no", "no"],
    ["other", "fixture-large", "1M", "32K", "yes", "no"],
    // A row that cannot be a model id, a repeat, and half a row are all passed over.
    ["-bad", "fixture", "1K", "1K", "no", "no"],
    ["fixture-hub", "fixture-small", "128K", "16K", "no", "no"],
    ["lonely"],
  ]
  process.stdout.write(`${rows.map((row) => row.map((cell) => cell.padEnd(14)).join("  ")).join("\n")}\n`)
}

async function claude(): Promise<void> {
  if (argv[0] === "--version") {
    process.stdout.write("2.1.227 (Claude Code)\n")
    return
  }
  // In "account" mode a folder is signed in while it holds this marker, and `auth logout` removes it.
  const marker = process.env.CLAUDE_CONFIG_DIR === undefined ? undefined : `${process.env.CLAUDE_CONFIG_DIR}/fixture-signed-in`
  // A person's sign-in: where to go, then the code typed back, which signs the folder in.
  if (argv[0] === "auth" && argv[1] === "login") {
    process.stdout.write(`argv ${argv.join(" ")}\nOpen https://claude.example.invalid/oauth/authorize\nPaste code here if prompted > `)
    const reader = createInterface({ input: process.stdin })
    const line = await new Promise<string>((resolve) => reader.once("line", resolve))
    reader.close()
    if (line.trim() === "fixture-code" && marker !== undefined) {
      await writeFile(marker, "")
      process.stdout.write("Login successful.\n")
      return
    }
    process.stdout.write("Invalid code\n")
    process.exitCode = 1
    return
  }
  if (argv[0] === "auth" && argv[1] === "logout") {
    if (marker !== undefined) await rm(marker, { force: true })
    process.stdout.write("Successfully logged out from your Anthropic account.\n")
    return
  }
  if (argv[0] === "auth" && argv[1] === "status" && mode === "account") {
    emit({ loggedIn: marker !== undefined && existsSync(marker), authMethod: "fixture", email: BAIT_EMAIL })
    return
  }
  if (argv[0] === "auth" && argv[1] === "status") {
    if (mode === "status-unreadable") {
      process.stdout.write("Logged in\n")
      return
    }
    const signedOut = mode === "signed-out"
    emit({ loggedIn: !signedOut, authMethod: "fixture", email: BAIT_EMAIL, orgName: "Bait Org" })
    process.exitCode = signedOut ? 1 : 0
    return
  }
  // The model probe: one `initialize` on the control channel, answered with the model rows and,
  // as Claude Code does, the account, which Runrail must never read.
  if (argv.includes("--setting-sources") && argv.includes("--input-format")) {
    const reader = createInterface({ input: process.stdin })
    const line = await new Promise<string>((resolve) => reader.once("line", resolve))
    reader.close()
    const request = JSON.parse(line) as { request_id?: string }
    if (mode === "models-silent") {
      await Bun.sleep(60_000)
      return
    }
    emit({ type: "system", subtype: "hook_started" })
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.request_id,
        response: {
          account: { email: BAIT_EMAIL },
          models: [
            { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
            { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high"] },
            { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
          ],
        },
      },
    })
    await Bun.sleep(60_000)
    return
  }
  const prompt = await readPrompt()
  const at = argv.indexOf("--resume")
  const resume = at < 0 ? undefined : argv[at + 1]
  if (mode === "resume-missing" && resume !== undefined) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`)
    process.exitCode = 1
    return
  }
  if (mode === "signed-out") {
    process.stderr.write("Not logged in. Please run /login\n")
    process.exitCode = 1
    return
  }
  const session = resume ?? "fixture-claude-session"
  emit({ type: "system", subtype: "init", session_id: session })
  if (mode === "weekly-quota") {
    emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_790_000_000 }, session_id: session })
    await Bun.sleep(60_000)
    return
  }
  if (mode === "key-refused") {
    // Claude Code's answer to a refused key: retries, ten of them over more than a minute.
    emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 600, error_status: 401, error: "authentication_failed", session_id: session })
    await Bun.sleep(60_000)
    return
  }
  if (mode === "account") {
    const account = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null }
    emit({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: JSON.stringify({ argv, prompt, account }) }] } })
    emit({ type: "result", subtype: "success", session_id: session, is_error: false })
    return
  }
  if (mode === "unknown-event") emit({ type: "fixture_future_event", session_id: session })
  emit({ type: "stream_event", session_id: session, event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } })
  // Claude Code 2.1.287 and later name the API request on each assistant message.
  emit({ type: "assistant", session_id: session, request_id: "req_fixture0123456789", message: { content: [{ type: "text", text: JSON.stringify({ argv, prompt }) }] } })
  emit({ type: "result", subtype: "success", session_id: session, is_error: false })
}

async function codex(): Promise<void> {
  if (argv[0] === "--version") {
    process.stdout.write("codex-cli 0.155.1\n")
    return
  }
  if (argv[0] === "login" && argv[1] === "status") {
    process.stdout.write(`Logged in as ${BAIT_EMAIL}\n`)
    process.exitCode = mode.endsWith("signed-out") ? 1 : 0
    return
  }
  if (argv[0] === "app-server") {
    await appServer()
    return
  }
  const prompt = await readPrompt()
  const resume = argv[0] === "exec" && argv[1] === "resume" ? argv[argv.length - 2] : undefined
  if (mode === "resume-missing" && resume !== undefined) {
    process.stderr.write(`Error: no rollout found for thread id ${resume}\n`)
    process.exitCode = 1
    return
  }
  const thread = resume ?? "fixture-codex-thread"
  emit({ type: "thread.started", thread_id: thread })
  emit({ type: "turn.started" })
  if (mode === "weekly-quota") {
    emit({ type: "turn.failed", error: { message: "Weekly usage limit reached. sk-fixture-must-not-leak", codexErrorInfo: "usageLimitExceeded" } })
    await Bun.sleep(60_000)
    return
  }
  if (mode === "unknown-event") emit({ type: "fixture.future_event" })
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify({ argv, prompt }) } })
  emit({ type: "turn.completed" })
}

/** Only what a probe asks: the handshake, the model list, and whether an account is present. */
async function appServer(): Promise<void> {
  if (mode.startsWith("no-server")) {
    process.exitCode = 2
    return
  }
  for await (const line of createInterface({ input: process.stdin })) {
    let message: unknown
    try {
      message = JSON.parse(line) as unknown
    } catch {
      continue
    }
    if (message === null || typeof message !== "object") continue
    const { id, method } = message as { id?: unknown; method?: unknown }
    if (method === "initialize") emit({ id, result: { userAgent: "runrail-fixture" } })
    if (method === "model/list") {
      emit({
        id,
        result: {
          data: [
            { id: "fixture-large", model: "fixture-large", displayName: "Fixture Large", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }] },
            { id: "fixture-hidden", model: "fixture-hidden", displayName: "Fixture Hidden", hidden: true, supportedReasoningEfforts: [] },
            { id: "fixture-small", model: "fixture-small", displayName: "Fixture Small", hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }, { reasoningEffort: "Not An Effort", description: "" }] },
            { id: "bad id", model: "bad model id", displayName: "Unusable", hidden: false },
            { id: "fixture-large", model: "fixture-large", displayName: "Duplicate", hidden: false },
          ],
          nextCursor: null,
        },
      })
    }
    if (method === "account/read") {
      emit({ id, result: mode === "signed-out" ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: BAIT_EMAIL, planType: "bait-plan" }, requiresOpenaiAuth: true } })
    }
  }
}

async function readPrompt(): Promise<string> {
  return new Response(Bun.stdin.stream()).text()
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
