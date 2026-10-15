import { spawn, type ChildProcess } from "node:child_process"
import { loadClaudeAgentSdk, type ClaudeAgentSdk, type ClaudeSdkQuery, type ClaudeSdkUserMessage } from "../backend/claude-agent-sdk.ts"
import { terminateProcessTree } from "../backend/process-tree.ts"
import type { RunrailPlanLimitsFrame } from "../live/types.ts"
import { RUNRAIL_VERSION } from "../version.ts"
import { filteredEnvironment } from "../workspace/policy.ts"
import { resolveCodexCommand } from "./detect.ts"
import { claudeUsageLimits, codexPlanLimits } from "./plan-limits.ts"

/**
 * A coding tool's plan usage for one account, read with no thread running: the tool is started
 * for that account the way a thread on it would be, asked, and closed. Nothing of the person's own
 * setup runs for it. Claude Code loads no settings, hooks, MCP servers, or plugins and writes no
 * conversation; Codex is asked only for its account and limits.
 */

export type UsageTool = "claude-code" | "codex"

export interface UsageAccount {
  /** The account's own config folder; absent for the tool's usual login. */
  readonly configDir?: string
  /** An empty folder the tool runs in. */
  readonly cwd: string
}

export type UsageReadErrorCode = "USAGE_UNAVAILABLE" | "TOOL_UNAVAILABLE"

export class UsageReadError extends Error {
  constructor(readonly code: UsageReadErrorCode, message: string) {
    super(message)
    this.name = "UsageReadError"
  }
}

export interface UsageAccountIdentity {
  readonly label: string
}
export type ToolUsageReading = RunrailPlanLimitsFrame & { readonly account?: UsageAccountIdentity }
export type ToolUsageRead = (account: UsageAccount) => Promise<ToolUsageReading | undefined>

const READ_TIMEOUT_MS = 20_000
const REUSE_MS = 60_000
const MAX_CODEX_OUTPUT_BYTES = 1024 * 1024

export interface ClaudeUsageReadOptions {
  readonly sdk?: ClaudeAgentSdk
  /** The installed `claude`, found on the filtered PATH unless a path is given. */
  readonly command?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}

/** Claude Code: an idle session that is asked the question behind `/usage`, then closed. */
export function claudeUsageReader(options: ClaudeUsageReadOptions = {}): ToolUsageRead {
  return async (account) => {
    const env: Record<string, string> = { ...filteredEnvironment(options.env), CLAUDE_AGENT_SDK_CLIENT_APP: `runrail/${RUNRAIL_VERSION}` }
    if (account.configDir !== undefined) env.CLAUDE_CONFIG_DIR = account.configDir
    const executable = Bun.which(options.command ?? "claude", { PATH: env.PATH ?? "" })
    if (executable === null) throw new UsageReadError("TOOL_UNAVAILABLE", "Claude Code is not installed")
    // Checked after Claude Code, since a desktop build downloads the SDK the first time it loads.
    const sdk = options.sdk ?? (await loadClaudeAgentSdk())
    if (sdk === undefined) throw new UsageReadError("TOOL_UNAVAILABLE", "the Claude Agent SDK is not available")
    const idle = idlePrompt()
    const abort = new AbortController()
    let child: ChildProcess | undefined
    let query: ClaudeSdkQuery
    try {
      query = sdk.query({
        prompt: idle.prompt,
        options: {
          cwd: account.cwd,
          pathToClaudeCodeExecutable: executable,
          env,
          permissionMode: "default",
          systemPrompt: { type: "preset", preset: "claude_code" },
          includePartialMessages: true,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          persistSession: false,
          canUseTool: async () => ({ behavior: "deny", message: "this session only reads usage" }),
          abortController: abort,
          spawnClaudeCodeProcess: (spawnOptions) => {
            const childEnv: Record<string, string> = {}
            for (const [name, value] of Object.entries(spawnOptions.env)) if (typeof value === "string") childEnv[name] = value
            // Its stderr is not read: the vendor's text is never passed on.
            child = spawn(spawnOptions.command, [...spawnOptions.args], { cwd: account.cwd, env: childEnv, stdio: ["pipe", "pipe", "ignore"], detached: true })
            return child
          },
        },
      })
    } catch {
      throw new UsageReadError("TOOL_UNAVAILABLE", "Claude Code could not start")
    }
    try {
      if (query.readPlanUsage === undefined) throw new UsageReadError("USAGE_UNAVAILABLE", "this Claude Code does not report usage")
      void drain(query)
      const limits = claudeUsageLimits(await withTimeout(query.readPlanUsage(), options.timeoutMs ?? READ_TIMEOUT_MS))
      if (limits === undefined) throw new UsageReadError("USAGE_UNAVAILABLE", "this account has no plan usage to report")
      return limits
    } catch (error) {
      if (error instanceof UsageReadError) throw error
      throw new UsageReadError("USAGE_UNAVAILABLE", "Claude Code did not report usage")
    } finally {
      idle.close()
      try {
        query.close()
      } catch {
        // Closing an exited session has nothing left to do.
      }
      abort.abort()
      await stopChild(child)
    }
  }
}

export interface CodexUsageReadOptions {
  /** Defaults to the newest installed Codex, as threads pick it. */
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}

/** Account identity is returned only to the usage card, never as a live or persisted frame. */
export function codexUsageReader(options: CodexUsageReadOptions = {}): ToolUsageRead {
  return async (account) => {
    const env: Record<string, string> = filteredEnvironment(options.env)
    if (account.configDir !== undefined) env.CODEX_HOME = account.configDir
    const command = options.command ?? (await resolveCodexCommand({ env }))
    let child: Bun.Subprocess<"pipe", "pipe", "ignore">
    try {
      child = Bun.spawn([command, ...(options.args ?? ["app-server", "--listen", "stdio://"])], { cwd: account.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true, env })
    } catch {
      throw new UsageReadError("TOOL_UNAVAILABLE", "Codex is not installed")
    }
    const server = jsonLines(child, options.timeoutMs ?? READ_TIMEOUT_MS)
    try {
      await server.request("initialize", { clientInfo: { name: "runrail", title: "Runrail", version: RUNRAIL_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } })
      server.notify("initialized")
      const signIn = record(record(await server.request("account/read", { refreshToken: false })).account)
      if (signIn.type !== "chatgpt") throw new UsageReadError("USAGE_UNAVAILABLE", "Codex has no subscription account signed in")
      const label = typeof signIn.email === "string" && signIn.email.length > 0 && signIn.email.length <= 254 && !/[\u0000-\u001f\u007f]/.test(signIn.email) ? signIn.email : undefined
      const limits = codexPlanLimits(record(await server.request("account/rateLimits/read")).rateLimits)
      if (limits === undefined) throw new UsageReadError("USAGE_UNAVAILABLE", "this account has no plan usage to report")
      return { ...limits, ...(label === undefined ? {} : { account: { label } }) }
    } catch (error) {
      if (error instanceof UsageReadError) throw error
      throw new UsageReadError("USAGE_UNAVAILABLE", "Codex did not report usage")
    } finally {
      await terminateProcessTree(child)
    }
  }
}

/**
 * Reads accounts one tool process at a time. Concurrent reads share a request; Claude answers
 * are reused briefly. Codex rechecks sign-in because a profile can change accounts in place.
 */
export class UsageReader {
  private readonly answers = new Map<string, { readonly at: number; readonly limits: ToolUsageReading }>()
  private readonly running = new Map<string, Promise<ToolUsageReading>>()
  private turn: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly readers: Readonly<Record<UsageTool, ToolUsageRead>>,
    private readonly now: () => number = Date.now,
  ) {}

  read(key: string, tool: UsageTool, account: UsageAccount, refresh = false): Promise<ToolUsageReading> {
    const running = this.running.get(key)
    if (running !== undefined) return running
    const answer = this.answers.get(key)
    const now = this.now()
    if (tool !== "codex" && !refresh && answer !== undefined && now - answer.at < REUSE_MS && answer.limits.windows.every((window) => window.resetsAt === undefined || window.resetsAt > now)) return Promise.resolve(answer.limits)
    const read = this.turn.then(async () => {
      const limits = await this.readers[tool](account)
      if (limits === undefined) throw new UsageReadError("USAGE_UNAVAILABLE", "this account has no plan usage to report")
      if (tool !== "codex") this.answers.set(key, { at: this.now(), limits })
      return limits
    })
    this.turn = read.catch(() => undefined)
    const tracked = read.finally(() => this.running.delete(key))
    this.running.set(key, tracked)
    return tracked
  }
}

function idlePrompt(): { readonly prompt: AsyncIterable<ClaudeSdkUserMessage>; readonly close: () => void } {
  let close: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    close = resolve
  })
  return {
    prompt: {
      async *[Symbol.asyncIterator]() {
        await closed
      },
    },
    close: () => close(),
  }
}

/** The session's own messages are read and dropped, so it is never held up writing them. */
async function drain(query: ClaudeSdkQuery): Promise<void> {
  try {
    for await (const _message of query) {
      // Only the usage answer matters here.
    }
  } catch {
    // A closed session ends its messages.
  }
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child?.pid === undefined || child.exitCode !== null) return
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)))
  await terminateProcessTree({ pid: child.pid, exited, kill: (signal) => child.kill(signal) })
}

function jsonLines(child: Bun.Subprocess<"pipe", "pipe", "ignore">, timeoutMs: number): { readonly request: (method: string, params?: unknown) => Promise<unknown>; readonly notify: (method: string) => void } {
  let sequence = 0
  const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>()
  const write = (value: Record<string, unknown>): void => {
    try {
      void child.stdin.write(`${JSON.stringify(value)}\n`)
      void child.stdin.flush()
    } catch {
      // A server that is gone fails its pending requests below.
    }
  }
  const accept = (line: string): void => {
    let message: Record<string, unknown>
    try {
      message = record(JSON.parse(line))
    } catch {
      return
    }
    if (typeof message.id === "number" && message.method === undefined) {
      const waiting = pending.get(message.id)
      if (waiting === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) waiting.reject(new UsageReadError("USAGE_UNAVAILABLE", "Codex did not report usage"))
      else waiting.resolve(message.result)
      return
    }
    // A question from the server is not one this read can answer.
    if (message.id !== undefined && typeof message.method === "string") write({ id: message.id, error: { code: -32601, message: "not handled" } })
  }
  let stopped = false
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    let bytes = 0
    try {
      for await (const chunk of child.stdout) {
        bytes += chunk.byteLength
        if (bytes > MAX_CODEX_OUTPUT_BYTES) break
        buffer += decoder.decode(chunk, { stream: true })
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length > 0) accept(line)
        }
      }
    } catch {
      // The server stopped; its pending requests fail below.
    }
    stopped = true
    for (const waiting of pending.values()) waiting.reject(new UsageReadError("USAGE_UNAVAILABLE", "Codex stopped before it reported usage"))
    pending.clear()
  })()
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (stopped) {
          reject(new UsageReadError("USAGE_UNAVAILABLE", "Codex stopped before it reported usage"))
          return
        }
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new UsageReadError("USAGE_UNAVAILABLE", "Codex did not answer in time"))
        }, timeoutMs)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        write({ method, id, ...(params === undefined ? {} : { params }) })
      }),
    notify: (method) => write({ method }),
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UsageReadError("USAGE_UNAVAILABLE", "the tool did not answer in time")), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
