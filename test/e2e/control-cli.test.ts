import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

interface ReadyMessage {
  readonly type: "control.ready"
  readonly url: string
  readonly token: string
  readonly protocol: number
  readonly apiVersion: string
  readonly sessionId: string
}

interface RunningControl {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">
  readonly ready: ReadyMessage
  readonly stderr: Promise<string>
}

interface RpcResult {
  readonly response: Response
  readonly text: string
  readonly body: unknown
}

const repositoryRoot = resolve(import.meta.dir, "../..")
const cliPath = resolve(repositoryRoot, "src/cli.ts")

test("black-box control CLI supports readiness, health, events, cancellation, and restart", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-cli-cwd-"))
  const sessionDir = await mkdtemp(join("/tmp", "runrail-control-cli-state-"))
  let first: RunningControl | undefined
  let second: RunningControl | undefined
  let cancellation: RunningControl | undefined
  let stopAnswering: (() => void) | undefined
  try {
    const args = [
      "--backend", "native",
      "--cwd", cwd,
      "--session-dir", sessionDir,
      "--session-id", "desktop-cli-session",
      "--port", "0",
      "--json",
    ]
    first = await spawnControl(args)
    expect(first.ready).toMatchObject({ type: "control.ready", protocol: 1, apiVersion: "1.0" })
    expect(first.ready.token).not.toHaveLength(0)

    const health = await fetch(`${first.ready.url}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, protocol: 1, sessionId: "desktop-cli-session", scope: "single-session" })

    // The scripted turn asks before it writes; a client answers over the wire.
    stopAnswering = answerApprovals(first, false)
    const turn = rpc(first, "turn.enqueue", { message: "black-box turn" })
    const eventResponse = await fetch(`${first.ready.url}/events?afterSeq=-1`, {
      headers: { authorization: `Bearer ${first.ready.token}` },
    })
    expect(eventResponse.status).toBe(200)
    const events = readSseUntil(eventResponse, ["turn.started", "session.completed"])
    const [eventText, turnResult] = await Promise.all([events, turn])
    expect(eventText).toContain('"type":"turn.started"')
    expect(eventText).toContain('"type":"session.completed"')
    expect(turnResult.response.status).toBe(200)

    const created = await rpc(first, "task.create", { taskId: "cli-task", title: "CLI task" })
    expect(created.response.status).toBe(200)
    const completed = await rpc(first, "task.enqueue", { taskId: "cli-task", message: "durable turn", idempotencyKey: "cli-command-1" })
    expect(completed.response.status).toBe(200)
    expect(completed.body).toMatchObject({ ok: true, result: { status: "completed", task: { status: "completed" } } })
    expect(completed.text).not.toContain("durable turn")

    const rawCredential = await rpc(first, "provider.discover", { provider: "openai", apiKey: "black-box-secret" })
    expect(rawCredential.response.status).toBe(400)
    expect(rawCredential.body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
    expect(rawCredential.text).not.toContain("black-box-secret")

    const badScope = await rpc(first, "approval.resolve", { approvalId: "approval-1", approved: true, scope: "forever" })
    expect(badScope.response.status).toBe(400)
    expect(badScope.body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
    for (const answers of [["Luxon"], { q1: "Luxon" }, { q1: [] }, { "bad id!": ["x"] }, { q1: ["x".repeat(2_001)] }]) {
      const badAnswers = await rpc(first, "approval.resolve", { approvalId: "approval-1", approved: true, answers })
      expect(badAnswers.response.status).toBe(400)
      expect(badAnswers.body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
    }
    for (const followUp of [{ followUp: "yes" }, { note: "a note alone" }, { followUp: true, note: 7 }, { followUp: true, approved: false }]) {
      const badFollowUp = await rpc(first, "approval.resolve", { approvalId: "approval-1", approved: true, ...followUp })
      expect(badFollowUp.response.status).toBe(400)
      expect(badFollowUp.body).toMatchObject({ ok: false, error: { code: "CONTROL_INVALID_INPUT" } })
    }
    const described = await rpc(first, "control.describe", {})
    expect(described.text).toContain('"approval.scope"')
    expect(described.text).toContain('"approval.questions"')
    expect(described.text).toContain('"approval.followUp"')

    await stopControl(first)
    first = undefined
    second = await spawnControl(args)
    const listed = await rpc(second, "task.list", {})
    expect(listed.response.status).toBe(200)
    expect(listed.body).toMatchObject({ ok: true, result: [{ taskId: "cli-task", status: "completed" }] })
    const replay = await rpc(second, "task.enqueue", { taskId: "cli-task", message: "durable turn", idempotencyKey: "cli-command-1" })
    expect(replay.response.status).toBe(200)
    expect(replay.body).toMatchObject({ ok: true, result: { status: "replayed" } })
    // The same key with another message is another command, refused rather than answered with the first result.
    expect((await rpc(second, "task.enqueue", { taskId: "cli-task", message: "must not run again", idempotencyKey: "cli-command-1" })).body).toMatchObject({ ok: false, error: { code: "NATIVE_IDEMPOTENCY_CONFLICT" } })

    const fixture = resolve(import.meta.dir, "../fixtures/persistent-agent-jsonl.ts")
    cancellation = await spawnControl([
      "--backend", "codex",
      "--cwd", cwd,
      "--session-dir", sessionDir,
      "--session-id", "desktop-cancel-session",
      "--harness-persistent",
      "--harness-auth", "subscription",
      "--harness-command", process.execPath,
      "--harness-arg", fixture,
      "--harness-arg", "hold-on-second",
      "--port", "0",
      "--json",
    ])
    const firstTurn = await rpc(cancellation, "turn.enqueue", { message: "first" })
    expect(firstTurn.response.status).toBe(200)
    const heldTurn = rpc(cancellation, "turn.enqueue", { message: "second" })
    await delay(30)
    const cancelled = await rpc(cancellation, "turn.cancel", { reason: "desktop-cancel", clearQueued: true })
    expect(cancelled.response.status).toBe(200)
    const heldResult = await withTimeout(heldTurn, 5_000, "cancelled turn")
    expect(heldResult.body).toMatchObject({ ok: true, result: { events: [expect.objectContaining({ type: "session.stopped" })] } })
  } finally {
    stopAnswering?.()
    await stopControl(cancellation)
    await stopControl(second)
    await stopControl(first)
    await rm(cwd, { recursive: true, force: true })
    await rm(sessionDir, { recursive: true, force: true })
  }
}, { timeout: 30_000 })

test("black-box control CLI keeps diagnostics off JSON stdout and fails malformed startup", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-cli-invalid-"))
  try {
    const processHandle = Bun.spawn([process.execPath, cliPath, "control", "--backend", "native", "--cwd", cwd, "--port", "70000", "--json"], {
      cwd: repositoryRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, status] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ])
    expect(status).not.toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toContain("port")
    expect(stderr).not.toContain("Bearer")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
test("black-box control CLI reports configurable and enabled desktop capabilities", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-cli-capabilities-"))
  const transcriptDir = await mkdtemp(join("/tmp", "runrail-control-cli-transcript-"))
  let control: RunningControl | undefined
  try {
    control = await spawnControl([
      "--backend", "native",
      "--cwd", cwd,
      "--transcript-dir", transcriptDir,
      "--port", "0",
      "--json",
    ])
    const health = await fetch(`${control.ready.url}/health`)
    const healthBody = await health.json()
    expect(healthBody).toMatchObject({
      capabilityStatus: {
        "session.transcript": "available",
        // The CLI builds its own registry from the connectors the person turned on.
        connectors: "available",
        agents: "configurable",
        "workspace.read": "available",
        "terminal.create": "unavailable",
      },
    })
    const status = await rpc(control, "session.transcript.status", {})
    expect(status.response.status).toBe(200)
    expect(status.body).toMatchObject({ ok: true, result: { configured: true, contentFreeEvidence: true } })
    const terminal = await rpc(control, "terminal.describe", {})
    expect(terminal.response.status).toBe(501)
    expect(terminal.body).toMatchObject({ ok: false, error: { code: "CONTROL_TERMINAL_UNAVAILABLE" } })
  } finally {
    await stopControl(control)
    await rm(cwd, { recursive: true, force: true })
    await rm(transcriptDir, { recursive: true, force: true })
  }
})

test("control CLI stops when the stdin its host holds open closes", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-cli-cwd-"))
  const child = Bun.spawn([process.execPath, cliPath, "control", "--backend", "native", "--cwd", cwd, "--port", "0", "--json", "--exit-on-stdin-close"], {
    cwd: repositoryRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  try {
    const ready = parseReady(JSON.parse(await withTimeout(readFirstLine(child.stdout), 5_000, "control readiness")) as unknown)
    expect((await fetch(`${ready.url}/health`)).status).toBe(200)
    // Ignored input does not stop it; only the end of the stream does.
    child.stdin.write("ignored\n")
    await child.stdin.flush()
    expect((await fetch(`${ready.url}/health`)).status).toBe(200)
    await child.stdin.end()
    expect(await withTimeout(child.exited, 5_000, "control exit")).toBe(0)
  } finally {
    child.kill("SIGKILL")
    await child.exited
    await stderr
    await rm(cwd, { recursive: true, force: true })
  }
})

test("the command line's engine offers the opt-in plan sign-ins and marks each one", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-cli-signin-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-control-cli-signin-accounts-"))
  let control: RunningControl | undefined
  try {
    control = await spawnControl(["--backend", "native", "--cwd", cwd, "--accounts-dir", accountsDir, "--credential-vault", "memory", "--port", "0", "--json"])
    const flows = await rpc(control, "auth.flows", {})
    expect(flows.response.status).toBe(200)
    const listed = (flows.body as { readonly result: readonly { readonly id: string; readonly preset: string; readonly kind: string; readonly unofficial: boolean; readonly browserHosts: readonly string[] }[] }).result
    expect(listed.map((flow) => [flow.id, flow.preset, flow.kind, flow.unofficial, flow.browserHosts])).toEqual([
      ["chatgpt", "openai", "browser", false, ["auth.openai.com"]],
      ["openrouter", "openrouter", "browser", false, ["openrouter.ai"]],
      ["xai", "xai-grok", "device-code", true, ["accounts.x.ai"]],
      ["kimi", "kimi-code", "device-code", true, ["www.kimi.com"]],
      ["meta", "meta", "device-code", true, ["auth.meta.com"]],
    ])
    const presets = await rpc(control, "connection.presets", {})
    const rows = (presets.body as { readonly result: { readonly presets: readonly { readonly id: string; readonly signInOnly?: boolean }[] } }).result.presets
    expect(rows.filter((row) => row.signInOnly === true).map((row) => row.id)).toEqual(["xai-grok", "kimi-code"])
  } finally {
    await stopControl(control)
    await rm(cwd, { recursive: true, force: true })
    await rm(accountsDir, { recursive: true, force: true })
  }
})

async function spawnControl(args: readonly string[]): Promise<RunningControl> {
  const child = Bun.spawn([process.execPath, cliPath, "control", ...args], {
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  try {
    const line = await withTimeout(readFirstLine(child.stdout), 5_000, "control readiness")
    const ready = parseReady(JSON.parse(line) as unknown)
    return { child, ready, stderr }
  } catch (error) {
    child.kill("SIGTERM")
    await child.exited
    await stderr
    throw error
  }
}

async function stopControl(control: RunningControl | undefined): Promise<void> {
  if (control === undefined) return
  control.child.kill("SIGTERM")
  await control.child.exited
  await control.stderr
}

async function rpc(control: RunningControl, method: string, params: Readonly<Record<string, unknown>>): Promise<RpcResult> {
  const response = await fetch(`${control.ready.url}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${control.ready.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = undefined
  }
  return { response, text, body }
}

/** Answers every approval the control asks for, as a desktop client would, until stopped. */
function answerApprovals(control: RunningControl, approved: boolean): () => void {
  const abort = new AbortController()
  const answered = new Set<string>()
  void (async () => {
    const response = await fetch(`${control.ready.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${control.ready.token}` }, signal: abort.signal })
    const reader = response.body?.getReader()
    if (reader === undefined) return
    const decoder = new TextDecoder()
    let text = ""
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      text += decoder.decode(next.value, { stream: true })
      for (const match of text.matchAll(/"approvalId":"([^"]+)"/g)) {
        const id = match[1]
        if (id === undefined || answered.has(id)) continue
        answered.add(id)
        void rpc(control, "approval.resolve", { approvalId: id, approved }).catch(() => undefined)
      }
    }
  })().catch(() => undefined)
  return () => abort.abort()
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) throw new Error("control exited before readiness")
      buffer += decoder.decode(next.value, { stream: true })
      const newline = buffer.indexOf("\n")
      if (newline >= 0) return buffer.slice(0, newline).replace(/\r$/, "")
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024) throw new Error("control readiness exceeded its limit")
    }
  } finally {
    reader.releaseLock()
  }
}

async function readSseUntil(response: Response, required: readonly string[]): Promise<string> {
  const body = response.body
  if (body === null) throw new Error("control event stream has no body")
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    for (;;) {
      const next = await withTimeout(reader.read(), 5_000, "control event stream")
      if (next.done) throw new Error("control event stream closed before terminal event")
      text += decoder.decode(next.value, { stream: true })
      if (required.every((value) => text.includes(value))) return text
      if (Buffer.byteLength(text, "utf8") > 8 * 1024 * 1024) throw new Error("control event stream exceeded its test limit")
    }
  } finally {
    await reader.cancel()
  }
}

function parseReady(value: unknown): ReadyMessage {
  if (!isRecord(value) || value.type !== "control.ready" || typeof value.url !== "string" || typeof value.token !== "string" || typeof value.protocol !== "number" || typeof value.apiVersion !== "string" || typeof value.sessionId !== "string")
    throw new Error("control readiness is invalid")
  return {
    type: "control.ready",
    url: value.url,
    token: value.token,
    protocol: value.protocol,
    apiVersion: value.apiVersion,
    sessionId: value.sessionId,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
