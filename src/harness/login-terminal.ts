import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { createPtyTerminalBridge, PTY_TERMINAL_CHUNK_BYTES, type PtyTerminalBridge } from "../terminal/pty.ts"
import { filteredEnvironment } from "../workspace/policy.ts"

const DEFAULT_MAX_LOGINS = 4
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_OUTPUT_BYTES = 256 * 1024

export type ToolLoginErrorCode = "TOOL_LOGIN_NOT_FOUND" | "TOOL_LOGIN_LIMIT" | "TOOL_LOGIN_TOOL_MISSING" | "TOOL_LOGIN_UNAVAILABLE"

export class ToolLoginError extends Error {
  constructor(readonly code: ToolLoginErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "ToolLoginError"
  }
}

export interface ToolLoginStartInput {
  readonly connectionId: string
  /** The tool's bare name, looked up on PATH, or an absolute path (a wrapper or a test double). */
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly cols: number
  readonly rows: number
}

export interface ToolLoginRead {
  readonly chunks: readonly { readonly seq: number; readonly data: string }[]
  readonly nextSeq: number
  /** The tool exited and every chunk was read. */
  readonly closed: boolean
}

export interface ToolLogins {
  start(input: ToolLoginStartInput): { readonly loginId: string }
  read(loginId: string, afterSeq: number, maxBytes: number): Promise<ToolLoginRead>
  write(loginId: string, data: string): Promise<{ readonly acceptedBytes: number }>
  close(loginId: string): Promise<void>
  dispose(): Promise<void>
}

interface Login {
  readonly connectionId: string
  readonly bridge: PtyTerminalBridge
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * A coding tool's own sign-in, run in a terminal the person sees and types into: the tool's login
 * command as the program, never a shell, so a caller cannot run anything else. What the tool prints
 * and what the person types pass through in memory only, as in a terminal tab, and nothing is kept.
 */
export function createToolLogins(options: { readonly maxLogins?: number; readonly timeoutMs?: number } = {}): ToolLogins {
  const maxLogins = options.maxLogins ?? DEFAULT_MAX_LOGINS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const logins = new Map<string, Login>()

  const find = (loginId: string): Login => {
    const login = logins.get(loginId)
    if (login === undefined) throw new ToolLoginError("TOOL_LOGIN_NOT_FOUND", "this sign-in is not running")
    return login
  }

  const end = async (loginId: string): Promise<void> => {
    const login = logins.get(loginId)
    if (login === undefined) return
    logins.delete(loginId)
    clearTimeout(login.timer)
    await login.bridge.dispose()
  }

  return {
    start(input) {
      if (process.platform === "win32") throw new ToolLoginError("TOOL_LOGIN_UNAVAILABLE", "sign-in terminals are not supported on Windows")
      // One sign-in per connection: starting again replaces the one left open.
      for (const [loginId, login] of logins) if (login.connectionId === input.connectionId) void end(loginId)
      if (logins.size >= maxLogins) throw new ToolLoginError("TOOL_LOGIN_LIMIT", "too many sign-ins are open")
      const program = resolveCommand(input.command)
      if (program === undefined) throw new ToolLoginError("TOOL_LOGIN_TOOL_MISSING", "the tool was not found on this computer")
      const loginId = `login-${randomUUID()}`
      const bridge = createPtyTerminalBridge({ shell: program, shellArgs: input.args, env: input.env, maxSessions: 1, maxBufferedBytes: MAX_OUTPUT_BYTES })
      bridge.create({ sessionId: loginId, cols: input.cols, rows: input.rows, cwd: input.cwd ?? homedir() })
      const timer = setTimeout(() => void end(loginId), timeoutMs)
      timer.unref?.()
      logins.set(loginId, { connectionId: input.connectionId, bridge, timer })
      return { loginId }
    },
    async read(loginId, afterSeq, maxBytes) {
      const result = await find(loginId).bridge.read({ sessionId: loginId, afterSeq, maxBytes: Math.max(maxBytes, PTY_TERMINAL_CHUNK_BYTES), maxChunks: 1_024 })
      return { chunks: result.chunks, nextSeq: result.nextSeq, closed: result.closed }
    },
    async write(loginId, data) {
      const login = find(loginId)
      try {
        return await login.bridge.write({ sessionId: loginId, data })
      } catch {
        throw new ToolLoginError("TOOL_LOGIN_NOT_FOUND", "this sign-in has ended")
      }
    },
    async close(loginId) {
      find(loginId)
      await end(loginId)
    },
    async dispose() {
      await Promise.all([...logins.keys()].map((loginId) => end(loginId)))
    },
  }
}

function resolveCommand(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined
  const found = Bun.which(command, { PATH: filteredEnvironment().PATH ?? "" })
  return found === null ? undefined : found
}
