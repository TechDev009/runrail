import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readAnnouncedOutput } from "../../src/background/output-file.ts"
import { BackgroundCommandError, MAX_RUNNING_COMMANDS, NativeBackgroundCommands } from "../../src/background/native-commands.ts"
import { redactCommandText } from "../../src/background/redact.ts"
import { descendantsOf, parseListening, parseProcNet, parseProcStat, parseProcessTable, scanServers } from "../../src/background/servers.ts"
import { CodexBackgroundTracker, unwrapShell } from "../../src/backend/codex-background.ts"
import { mapClaudeTask } from "../../src/harness/claude-tasks.ts"
import { LiveFrameHub } from "../../src/live/hub.ts"
import type { RunrailLiveFrameInput } from "../../src/live/types.ts"

describe("redactCommandText", () => {
  test("masks credentials in the shapes commands carry them", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["curl -H 'Authorization: Bearer abcdefghijklmnop' https://x", "curl -H 'Authorization: ***' https://x"], // gitleaks:allow
      ["API_KEY=fake-value-123 npm run dev", "API_KEY=*** npm run dev"],
      ["GITHUB_TOKEN=\"x y\" gh pr list", "GITHUB_TOKEN=*** gh pr list"],
      ["tool --token=abc123 --verbose", "tool --token=*** --verbose"],
      ["tool --api-key abc123", "tool --api-key ***"],
      ["psql postgres://admin:hunter2@db:5432/app", "psql postgres://***@db:5432/app"],
      ["echo sk-ant-api03-FAKEFAKEFAKEFAKEFAKE", "echo ***"],
      ["echo ghp_FAKEFAKEFAKEFAKEFAKE1234", "echo ***"],
      ["aws AKIAFAKEFAKEFAKEFAKE s3 ls", "aws *** s3 ls"],
      ["curl -H 'X-Api-Key: fake123' x", "curl -H 'X-Api-Key: ***' x"],
    ]
    for (const [input, expected] of cases) expect(redactCommandText(input)).toBe(expected)
  })

  test("keeps ordinary commands readable and bounded", () => {
    expect(redactCommandText("git commit --author=\"Ada <a@b.c>\" -m 'fix'")).toContain("--author=")
    expect(redactCommandText("npm run dev -- --port 5173")).toBe("npm run dev -- --port 5173")
    expect(redactCommandText("a\nb\tc\u0007d")).toBe("a b c d")
    expect(redactCommandText("x".repeat(500)).length).toBe(200)
    expect(redactCommandText("x".repeat(500), 50).endsWith("...")).toBe(true)
  })
})

describe("background entries in the live hub", () => {
  test("merges changes, redacts labels, and never serializes controls", async () => {
    const hub = new LiveFrameHub({ sessionId: "s1" })
    const frames: unknown[] = []
    hub.subscribe((frame) => frames.push(frame))
    let stopped = false
    hub.sink({ type: "background.state", entry: { id: "a", kind: "command", label: "API_KEY=fake npm run dev", status: "running" }, control: { stop: async () => { stopped = true } } })
    hub.sink({ type: "background.state", entry: { id: "a", detail: "listening" } })
    expect(hub.backgroundEntry("a")).toMatchObject({ id: "a", kind: "command", label: "API_KEY=*** npm run dev", status: "running", detail: "listening", stoppable: true, hasOutput: false })
    expect(JSON.stringify(frames)).not.toContain("control")
    await hub.backgroundControl("a")?.stop?.()
    expect(stopped).toBe(true)
    hub.sink({ type: "background.state", entry: { id: "a", status: "completed" }, control: { output: async () => ({ text: "done", truncated: false }) } })
    expect(hub.backgroundEntry("a")).toMatchObject({ status: "completed", stoppable: false, hasOutput: true })
    expect(hub.backgroundControl("a")?.stop).toBeDefined()
  })

  test("drops an update for an entry it never saw start, and keeps running work when full", () => {
    const hub = new LiveFrameHub({ sessionId: "s1" })
    hub.sink({ type: "background.state", entry: { id: "ghost", status: "completed" } })
    expect(hub.backgroundEntries()).toHaveLength(0)
    for (let index = 0; index < 40; index += 1) hub.sink({ type: "background.state", entry: { id: `e${index}`, kind: "agent", label: "Agent", status: index < 5 ? "running" : "completed" } })
    const ids = hub.backgroundEntries().map((entry) => entry.id)
    expect(ids).toHaveLength(32)
    for (let index = 0; index < 5; index += 1) expect(ids).toContain(`e${index}`)
    hub.sink({ type: "background.state", entry: { id: "bad", kind: "agent", label: "x", status: "exploded" as never } })
    expect(hub.backgroundEntry("bad")).toBeUndefined()
  })

  test("a running entry without a stop offers the turn as the way to end it", () => {
    const hub = new LiveFrameHub({ sessionId: "s1" })
    hub.sink({ type: "background.state", entry: { id: "t", kind: "agent", label: "Explore", stopHint: "turn" } })
    expect(hub.backgroundEntry("t")).toMatchObject({ stoppable: false, stopHint: "turn" })
    hub.sink({ type: "background.state", entry: { id: "t", status: "completed" } })
    expect(hub.backgroundEntry("t")?.stopHint).toBeUndefined()
  })

  test("work bound to its turn ends when the turn does", () => {
    const hub = new LiveFrameHub({ sessionId: "s1" })
    hub.sink({ type: "background.state", entry: { id: "t", kind: "command", label: "sleep 9", stopHint: "turn" } })
    hub.sink({ type: "background.state", entry: { id: "k", kind: "command", label: "sleep 9" }, control: { stop: async () => undefined } })
    hub.observe({ version: 1, sessionId: "s1", seq: 1, at: Date.now(), type: "session.completed", snapshot: { id: "s1", backend: "claude-code", cwd: "/", status: "completed", lastSeq: 1, createdAt: Date.now(), capabilities: [] } } as never)
    expect(hub.backgroundEntry("t")).toMatchObject({ status: "stopped", detail: "Ended with its turn" })
    expect(hub.backgroundEntry("k")?.status).toBe("running")
  })
})

describe("Claude Code task messages", () => {
  function collect() {
    const frames: RunrailLiveFrameInput[] = []
    return { frames, context: { onLive: (frame: RunrailLiveFrameInput) => frames.push(frame) } }
  }
  const entries = (frames: RunrailLiveFrameInput[]) => frames.map((frame) => (frame.type === "background.state" ? frame.entry : undefined))

  test("maps a subagent's life", () => {
    const { frames, context } = collect()
    expect(mapClaudeTask({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_1", description: "Explore the repo", subagent_type: "Explore", task_type: "local_agent" }, context)).toBe(true)
    mapClaudeTask({ type: "system", subtype: "task_progress", task_id: "t1", description: "Explore the repo", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 }, last_tool_name: "Grep" }, context)
    mapClaudeTask({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed", output_file: "/tmp/x", summary: "Found it" }, context)
    expect(entries(frames)).toEqual([
      expect.objectContaining({ id: "claude:t1", kind: "agent", label: "Explore the repo", agentType: "Explore", callId: "toolu_1", status: "running", stopHint: "turn" }),
      expect.objectContaining({ id: "claude:t1", tokens: 1200, toolUses: 3, durationMs: 4000, detail: "Grep" }),
      expect.objectContaining({ id: "claude:t1", status: "completed", detail: "Found it" }),
    ])
    expect(frames[2]?.type === "background.state" && frames[2].control?.output).toBeDefined()
  })

  test("a shell is a foreground command until Claude Code backgrounds it, and killed means stopped", () => {
    const { frames, context } = collect()
    const stops: string[] = []
    mapClaudeTask({ type: "system", subtype: "task_started", task_id: "b1", description: "npm run dev", task_type: "local_bash" }, context, async (id) => { stops.push(id) })
    mapClaudeTask({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "npm run dev" }] }, context)
    mapClaudeTask({ type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "killed", end_time: 1_790_000_000_000 } }, context)
    expect(entries(frames)).toEqual([
      expect.objectContaining({ id: "claude:b1", kind: "command", foreground: true, status: "running" }),
      { id: "claude:b1", foreground: false },
      expect.objectContaining({ id: "claude:b1", status: "stopped", endedAt: 1_790_000_000_000 }),
    ])
    expect(entries(frames)[0]?.stopHint).toBeUndefined()
  })

  test("ignores ambient, unknown, and non-task records", () => {
    const { frames, context } = collect()
    expect(mapClaudeTask({ type: "system", subtype: "init" }, context)).toBe(false)
    expect(mapClaudeTask({ type: "assistant" }, context)).toBe(false)
    mapClaudeTask({ type: "system", subtype: "task_started", task_id: "h", description: "x", task_type: "local_agent", skip_transcript: true }, context)
    mapClaudeTask({ type: "system", subtype: "task_started", task_id: "d", description: "x", task_type: "dream" }, context)
    mapClaudeTask({ type: "system", subtype: "task_started", description: "no id", task_type: "local_agent" }, context)
    expect(frames).toHaveLength(0)
  })
})

describe("Codex background work", () => {
  function tracker() {
    const frames: RunrailLiveFrameInput[] = []
    const requests: { method: string; params: unknown }[] = []
    const hub = new LiveFrameHub({ sessionId: "s1" })
    const codex = new CodexBackgroundTracker({
      emit: (frame) => { frames.push(frame); hub.sink(frame) },
      request: async (method, params) => { requests.push({ method, params }); return { terminated: true } },
    })
    return { codex, frames, requests, hub }
  }
  const command = (status: string, extra: Record<string, unknown> = {}) => ({ type: "commandExecution", id: "exec-1", command: "/bin/zsh -lc 'npm run dev'", processId: "5139", source: "unifiedExecStartup", status, ...extra })

  test("a command still running when its turn ends becomes background work Codex can stop", async () => {
    const { codex, requests, hub } = tracker()
    codex.observe("item/started", { threadId: "T", turnId: "U", item: command("inProgress") })
    codex.observe("item/commandExecution/outputDelta", { threadId: "T", turnId: "U", itemId: "exec-1", delta: "ready on 5173\n" })
    expect(hub.backgroundEntries()).toHaveLength(0)
    codex.observe("turn/completed", { threadId: "T", turn: { id: "U", status: "completed" } })
    expect(hub.backgroundEntry("codex:command:exec-1")).toMatchObject({ kind: "command", label: "npm run dev", status: "running", stoppable: true, hasOutput: true, foreground: false })
    expect(await hub.backgroundControl("codex:command:exec-1")?.output?.(1024)).toEqual({ text: "ready on 5173\n", truncated: false })
    await hub.backgroundControl("codex:command:exec-1")?.stop?.()
    expect(requests).toEqual([{ method: "thread/backgroundTerminals/terminate", params: { threadId: "T", processId: "5139" } }])
    codex.observe("item/completed", { threadId: "T", turnId: "U", item: command("failed", { exitCode: -1 }) })
    expect(hub.backgroundEntry("codex:command:exec-1")).toMatchObject({ status: "stopped", exitCode: -1, stoppable: false })
  })

  test("a background command that exits nonzero is failed, though Codex calls it completed", () => {
    const { codex, hub } = tracker()
    codex.observe("item/started", { threadId: "T", turnId: "U", item: command("inProgress") })
    codex.observe("turn/completed", { threadId: "T", turn: { id: "U", status: "completed" } })
    codex.observe("item/completed", { threadId: "T", turnId: "U", item: command("completed", { exitCode: 1 }) })
    expect(hub.backgroundEntry("codex:command:exec-1")).toMatchObject({ status: "failed", exitCode: 1 })
  })

  test("a command that finishes inside its turn never shows", () => {
    const { codex, frames } = tracker()
    codex.observe("item/started", { threadId: "T", turnId: "U", item: command("inProgress") })
    codex.observe("item/completed", { threadId: "T", turnId: "U", item: command("completed", { exitCode: 0 }) })
    codex.observe("turn/completed", { threadId: "T", turn: { id: "U", status: "completed" } })
    expect(frames).toHaveLength(0)
  })

  test("a subagent is stopped by interrupting its turn and cleaning its terminals", async () => {
    const { codex, requests, hub } = tracker()
    codex.observe("item/started", { threadId: "T", turnId: "U", item: { type: "subAgentActivity", id: "s", kind: "started", agentThreadId: "C", agentPath: "/root/worker" } })
    codex.observe("turn/started", { threadId: "C", turn: { id: "CT", status: "inProgress" } })
    expect(hub.backgroundEntry("codex:agent:C")).toMatchObject({ kind: "agent", label: "Subagent worker", status: "running", stoppable: true })
    await hub.backgroundControl("codex:agent:C")?.stop?.()
    expect(requests.map((request) => request.method)).toEqual(["turn/interrupt", "thread/backgroundTerminals/clean"])
    expect(requests[0]?.params).toEqual({ threadId: "C", turnId: "CT" })
    codex.observe("turn/completed", { threadId: "C", turn: { id: "CT", status: "interrupted" } })
    expect(hub.backgroundEntry("codex:agent:C")).toMatchObject({ status: "stopped", stoppable: false })
  })

  test("the app-server stopping ends everything it was running", () => {
    const { codex, hub } = tracker()
    codex.observe("item/started", { threadId: "T", turnId: "U", item: command("inProgress") })
    codex.observe("turn/completed", { threadId: "T", turn: { id: "U", status: "completed" } })
    codex.close()
    expect(hub.backgroundEntry("codex:command:exec-1")?.status).toBe("stopped")
  })

  test("shell wrappers are unwrapped for the label", () => {
    expect(unwrapShell("/bin/zsh -lc 'sleep 95'")).toBe("sleep 95")
    expect(unwrapShell("/bin/bash -c \"npm run dev\"")).toBe("npm run dev")
    expect(unwrapShell(`/bin/zsh -lc "node -e 'console.log(\\"up\\")'"`)).toBe(`node -e 'console.log("up")'`)
    expect(unwrapShell("npm test")).toBe("npm test")
  })
})

describe("listening servers", () => {
  test("parses the process table and lsof output", () => {
    const rows = parseProcessTable("  10     1 /usr/sbin/launchd\n  20    10 /opt/node\n  30    20 /bin/sh\n  40    30 /usr/local/bin/node\n  50     1 /other\n")
    expect(descendantsOf(rows, 10).map((row) => row.pid)).toEqual([20, 30, 40])
    expect(descendantsOf(rows, 20).map((row) => row.name)).toEqual(["sh", "node"])
    const servers = parseListening("p40\nn*:5173\nn[::1]:5173\np30\nn127.0.0.1:8080\nnbogus\n", new Map([[40, "node"], [30, "sh"]]))
    expect(servers).toEqual([{ port: 5173, host: "*", process: "node" }, { port: 8080, host: "127.0.0.1", process: "sh" }])
  })

  test("reads Linux's /proc: names with spaces and parentheses, and listening sockets only", () => {
    expect(parseProcStat("4242 (node) S 4100 4242 4100 0 -1 4194560")).toEqual({ pid: 4242, ppid: 4100, name: "node" })
    expect(parseProcStat("77 (my (dev) server) R 4242 77 4100 0")).toEqual({ pid: 77, ppid: 4242, name: "my (dev) server" })
    expect(parseProcStat("garbage")).toBeUndefined()
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31338 1 0000000000000000 100 0 0 10 0",
      "   2: 0100007F:1F90 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 31339 1 0000000000000000 20 4 30 10 -1",
    ].join("\n")
    expect([...parseProcNet(tcp)]).toEqual([["31337", { host: "127.0.0.1", port: 8080 }], ["31338", { host: "*", port: 5173 }]])
    const tcp6 = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41 1 0 100 0 0 10 0",
      "   1: 0000000000000000FFFF00000100007F:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 42 1 0 100 0 0 10 0",
      "   2: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 43 1 0 100 0 0 10 0",
    ].join("\n")
    expect([...parseProcNet(tcp6).values()]).toEqual([{ host: "::1", port: 5173 }, { host: "127.0.0.1", port: 3000 }, { host: "*", port: 80 }])
  })

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")("finds a server this process started", async () => {
    const script = "Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') }); await Bun.sleep(30000)"
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" })
    try {
      let found = false
      for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
        await Bun.sleep(100)
        const scan = await scanServers()
        if (!scan.available) return
        found = scan.servers.some((server) => server.host === "127.0.0.1")
      }
      expect(found).toBe(true)
    } finally {
      child.kill()
    }
  })
})

describe("native background commands", () => {
  test("refuses a fifth command and stops all on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-bg-"))
    const commands = new NativeBackgroundCommands({ root })
    try {
      for (let index = 0; index < MAX_RUNNING_COMMANDS; index += 1) commands.start("sleep", ["30"], "sleep 30")
      expect(() => commands.start("sleep", ["30"], "sleep 30")).toThrow(BackgroundCommandError)
      await commands.close()
      expect(commands.running).toBe(0)
      expect(() => commands.start("sleep", ["1"], "sleep 1")).toThrow("closing")
    } finally {
      await commands.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reads output in order, after a cursor, and stops the whole process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-bg-"))
    const commands = new NativeBackgroundCommands({ root })
    try {
      const { id } = commands.start("sh", ["-c", "echo one; echo two; sleep 30 & wait"], "sh")
      let output = commands.output(id)
      for (let attempt = 0; attempt < 50 && !output.text.includes("two"); attempt += 1) {
        await Bun.sleep(20)
        output = commands.output(id)
      }
      expect(output).toMatchObject({ running: true, text: "one\ntwo\n", truncated: false })
      expect(commands.output(id, output.nextSeq).text).toBe("")
      await commands.stop(id)
      expect(commands.output(id).running).toBe(false)
      expect(() => commands.output("cmd-99")).toThrow("no background command")
    } finally {
      await commands.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("announced output files", () => {
  test("reads the end of a temporary file and refuses anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runrail-out-"))
    try {
      const file = join(dir, "task.output")
      await writeFile(file, "a".repeat(100) + "END")
      expect(await readAnnouncedOutput(file, 5)).toEqual({ text: "a" + "aEND".slice(0, 4), truncated: true })
      expect(await readAnnouncedOutput(file, 1000)).toEqual({ text: "a".repeat(100) + "END", truncated: false })
      await symlink("/etc/hosts", join(dir, "link"))
      await expect(readAnnouncedOutput(join(dir, "link"), 10)).rejects.toThrow("outside")
      await expect(readAnnouncedOutput("relative/path", 10)).rejects.toThrow("invalid")
      await expect(readAnnouncedOutput(dir, 10)).rejects.toThrow("regular file")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
