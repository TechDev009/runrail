import { existsSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { filteredEnvironment } from "../workspace/policy.ts"
import type {
  RunrailTerminalBridge,
  RunrailTerminalChunk,
  RunrailTerminalReadResult,
  RunrailTerminalSession,
} from "../control-terminal.ts"
import { terminateProcessTree } from "../backend/process-tree.ts"

/** Output is split into chunks of at most this many UTF-8 bytes; read with `maxBytes` of at least this. */
export const PTY_TERMINAL_CHUNK_BYTES = 4_096
const DEFAULT_MAX_SESSIONS = 8
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const KILL_GRACE_MS = 2_000
/** Variables a user's shell expects beyond the base filtered set. Provider keys and tokens are not forwarded. */
const SHELL_ENVIRONMENT = ["SHELL", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "LC_CTYPE", "EDITOR", "VISUAL"] as const

export interface PtyTerminalBridgeOptions {
  /** Absolute shell path. Defaults to `$SHELL`, then `/bin/sh`. */
  readonly shell?: string
  /** Defaults to `["-l"]` so the user's login profile sets PATH and prompt. */
  readonly shellArgs?: readonly string[]
  /** Extra environment for every shell. Keys must be portable names. */
  readonly env?: Readonly<Record<string, string>>
  /** Running sessions allowed at once (1..64, default 8). */
  readonly maxSessions?: number
  /** Output retained per session for replay (64 KiB..64 MiB, default 2 MiB). Oldest chunks drop first. */
  readonly maxBufferedBytes?: number
}

export interface PtyTerminalBridge extends RunrailTerminalBridge {
  /** Running and retained sessions. */
  readonly size: number
  /** Closes every session and kills its shell. */
  dispose(): Promise<void>
}

interface PtySession {
  readonly sessionId: string
  cols: number
  rows: number
  status: "running" | "closed"
  readonly process: Bun.Subprocess
  readonly terminal: Bun.Terminal
  readonly decoder: TextDecoder
  readonly chunks: { readonly seq: number; readonly data: string; readonly bytes: number }[]
  /** Chunks before this index are dropped; cut away in a batch, since `shift` on a long list is linear. */
  head: number
  bufferedBytes: number
  lastSeq: number
  closedAt?: number
}

/** The login shells this system lists in `/etc/shells`: absolute paths that exist. */
export function listLoginShells(file = "/etc/shells"): readonly string[] {
  let text: string
  try {
    text = readFileSync(file, "utf8").slice(0, 64 * 1024)
  } catch {
    return []
  }
  const shells = text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/") && line.length <= 256 && !line.includes("\0") && existsSync(line))
  return Object.freeze([...new Set(shells)])
}

/** A terminal shell must be one of the system's login shells, so a caller cannot name any program. */
export function checkTerminalShell(path: string, shells: readonly string[] = listLoginShells()): string {
  if (!shells.includes(path)) throw new TypeError("terminal shell is not one of this system's login shells")
  return path
}

/**
 * Local PTY bridge for the control `terminal.*` methods, backed by `Bun.spawn({ terminal })`.
 * Each session is a real shell in the caller's workspace. It is a convenience for the local user,
 * not a sandbox: the shell runs with the user's permissions. Output lives only in memory.
 */
export function createPtyTerminalBridge(options: PtyTerminalBridgeOptions = {}): PtyTerminalBridge {
  if (process.platform === "win32") throw new TypeError("PTY terminals are not supported on Windows")
  const shell = options.shell ?? process.env.SHELL ?? "/bin/sh"
  if (!isAbsolute(shell) || !existsSync(shell)) throw new TypeError("terminal shell must be an existing absolute path")
  const shellArgs = [...(options.shellArgs ?? ["-l"])]
  if (shellArgs.length > 16 || shellArgs.some((arg) => typeof arg !== "string" || arg.length > 256 || arg.includes("\0")))
    throw new TypeError("terminal shell arguments are invalid")
  const extraEnv = { ...(options.env ?? {}) }
  for (const [name, value] of Object.entries(extraEnv))
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof value !== "string" || value.includes("\0")) throw new TypeError("terminal environment is invalid")
  const maxSessions = bounded(options.maxSessions, 1, 64, DEFAULT_MAX_SESSIONS, "maxSessions")
  const maxBufferedBytes = bounded(options.maxBufferedBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULT_MAX_BUFFERED_BYTES, "maxBufferedBytes")
  const sessions = new Map<string, PtySession>()

  const snapshot = (session: PtySession): RunrailTerminalSession =>
    Object.freeze({ sessionId: session.sessionId, cols: session.cols, rows: session.rows, status: session.status })

  const require = (sessionId: string): PtySession => {
    const session = sessions.get(sessionId)
    if (session === undefined) throw new Error("terminal session was not found")
    return session
  }

  const append = (session: PtySession, text: string): void => {
    for (const data of splitUtf8(text, PTY_TERMINAL_CHUNK_BYTES)) {
      const bytes = Buffer.byteLength(data, "utf8")
      session.lastSeq += 1
      session.chunks.push({ seq: session.lastSeq, data, bytes })
      session.bufferedBytes += bytes
    }
    while (session.bufferedBytes > maxBufferedBytes && session.chunks.length - session.head > 1) {
      const dropped = session.chunks[session.head]
      session.head += 1
      if (dropped !== undefined) session.bufferedBytes -= dropped.bytes
    }
    if (session.head >= 512 && session.head * 2 >= session.chunks.length) {
      session.chunks.splice(0, session.head)
      session.head = 0
    }
  }

  const finish = (session: PtySession): void => {
    if (session.status === "closed") return
    append(session, session.decoder.decode())
    session.status = "closed"
    session.closedAt = Date.now()
    try { session.terminal.close() } catch { /* already closed */ }
  }

  const stop = async (session: PtySession): Promise<void> => {
    // The shell leads its own session, so its group takes the hangup too: background jobs as well as the shell.
    if (session.process.exitCode === null && session.process.signalCode === null) await terminateProcessTree(session.process, KILL_GRACE_MS, "SIGHUP")
    finish(session)
  }

  /** Keeps closed sessions readable until the running plus retained count exceeds twice the limit. */
  const prune = (): void => {
    const closed = [...sessions.values()].filter((session) => session.status === "closed").sort((left, right) => (left.closedAt ?? 0) - (right.closedAt ?? 0))
    while (sessions.size >= maxSessions * 2 && closed.length > 0) {
      const oldest = closed.shift()
      if (oldest !== undefined) sessions.delete(oldest.sessionId)
    }
  }

  return {
    descriptor: Object.freeze({ id: "runrail.pty", version: "1", capabilities: Object.freeze(["create", "write", "read", "resize", "close"] as const) }),
    get size() {
      return sessions.size
    },
    create(input) {
      const existing = sessions.get(input.sessionId)
      if (existing !== undefined && existing.status === "running") {
        if (existing.cols !== input.cols || existing.rows !== input.rows) {
          existing.terminal.resize(input.cols, input.rows)
          existing.cols = input.cols
          existing.rows = input.rows
        }
        return snapshot(existing)
      }
      if (existing !== undefined) sessions.delete(input.sessionId)
      const running = [...sessions.values()].filter((session) => session.status === "running").length
      if (running >= maxSessions) throw new Error("too many terminal sessions are running")
      prune()
      const env = filteredEnvironment()
      for (const name of SHELL_ENVIRONMENT) {
        const value = process.env[name]
        if (value !== undefined) env[name] = value
      }
      // Apps launched from a desktop session often have no locale; readline then mangles UTF-8 input.
      if (env.LANG === undefined && env.LC_ALL === undefined && env.LC_CTYPE === undefined) env.LANG = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"
      Object.assign(env, extraEnv, { TERM: "xterm-256color", COLORTERM: "truecolor", RUNRAIL_TERMINAL: "1" })
      let session: PtySession | undefined
      const decoder = new TextDecoder("utf-8")
      const child = Bun.spawn([shell, ...shellArgs], {
        cwd: input.cwd,
        env,
        terminal: {
          cols: input.cols,
          rows: input.rows,
          name: "xterm-256color",
          data(_terminal, bytes) {
            if (session !== undefined) append(session, session.decoder.decode(bytes, { stream: true }))
          },
        },
      })
      const terminal = child.terminal
      if (terminal === undefined) {
        try { child.kill("SIGKILL") } catch { /* not started */ }
        throw new Error("terminal could not be allocated")
      }
      session = { sessionId: input.sessionId, cols: input.cols, rows: input.rows, status: "running", process: child, terminal, decoder, chunks: [], head: 0, bufferedBytes: 0, lastSeq: 0 }
      sessions.set(input.sessionId, session)
      const created = session
      void child.exited.then(() => finish(created), () => finish(created))
      return snapshot(session)
    },
    write(input) {
      const session = require(input.sessionId)
      if (session.status !== "running") throw new Error("terminal session is closed")
      session.terminal.write(input.data)
      return Object.freeze({ acceptedBytes: Buffer.byteLength(input.data, "utf8") })
    },
    read(input): RunrailTerminalReadResult {
      const session = require(input.sessionId)
      const chunks: RunrailTerminalChunk[] = []
      let bytes = 0
      let nextSeq = Math.max(0, input.afterSeq)
      // Sequence numbers are consecutive, so the first chunk after the cursor is found by arithmetic.
      const firstSeq = session.chunks[session.head]?.seq
      const start = firstSeq === undefined ? session.chunks.length : session.head + Math.max(0, input.afterSeq + 1 - firstSeq)
      for (let index = start; index < session.chunks.length; index += 1) {
        const chunk = session.chunks[index]!
        if (chunk.seq <= input.afterSeq) continue
        if (chunks.length >= input.maxChunks || bytes + chunk.bytes > input.maxBytes) break
        chunks.push(Object.freeze({ seq: chunk.seq, data: chunk.data }))
        bytes += chunk.bytes
        nextSeq = chunk.seq
      }
      const oldest = session.chunks[session.head]?.seq ?? session.lastSeq + 1
      return Object.freeze({
        session: snapshot(session),
        chunks: Object.freeze(chunks),
        nextSeq,
        closed: session.status === "closed" && nextSeq >= session.lastSeq,
        ...(oldest > input.afterSeq + 1 && session.lastSeq > input.afterSeq ? { truncated: true as const } : {}),
      })
    },
    resize(input) {
      const session = require(input.sessionId)
      if (session.status === "running") session.terminal.resize(input.cols, input.rows)
      session.cols = input.cols
      session.rows = input.rows
      return snapshot(session)
    },
    async close(input) {
      const session = require(input.sessionId)
      await stop(session)
      return snapshot(session)
    },
    async dispose() {
      await Promise.all([...sessions.values()].map((session) => stop(session)))
      sessions.clear()
    },
  }
}

/** Splits text into pieces of at most `maxBytes` UTF-8 bytes without cutting a code point. */
function splitUtf8(text: string, maxBytes: number): string[] {
  if (text.length === 0) return []
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text]
  const bytes = Buffer.from(text, "utf8")
  const pieces: string[] = []
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maxBytes, bytes.length)
    // A continuation byte starts no character, so back up to where one begins.
    if (end < bytes.length) while (end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1
    if (end === start) end = Math.min(start + maxBytes, bytes.length)
    pieces.push(bytes.toString("utf8", start, end))
    start = end
  }
  return pieces
}

function bounded(value: number | undefined, min: number, max: number, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  return value
}
