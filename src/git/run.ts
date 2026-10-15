import { filteredEnvironment } from "../workspace/policy.ts"
import { GitError } from "./errors.ts"
import { repositoryProgramOverrides } from "./repo-config.ts"

export const GIT_DEFAULT_TIMEOUT_MS = 30_000
export const GIT_DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const SIGNING_ENVIRONMENT = ["SSH_AUTH_SOCK", "GNUPGHOME", "GPG_TTY"] as const
/** Transport variables a push or fetch needs to reach a remote; credentials stay in the user's helpers. */
const NETWORK_ENVIRONMENT = [
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY",
  "https_proxy", "http_proxy", "no_proxy", "all_proxy",
] as const

/**
 * Repository-configured program execution is disabled for every call: fsmonitor, pagers, the ext
 * transport, (unless `runHooks`) hooks, and every program the repository's own config names (see
 * repo-config.ts). Diff callers must also pass `--no-ext-diff --no-textconv`.
 * Pathspecs are always literal, so user paths never carry glob or magic syntax.
 */
const SAFE_CONFIG = Object.freeze([
  "--no-pager",
  "--literal-pathspecs",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "color.ui=false",
  "-c", "core.quotepath=false",
  "-c", "advice.detachedHead=false",
  "-c", "protocol.ext.allow=never",
])

export interface GitRunOptions {
  readonly cwd: string
  readonly args: readonly string[]
  readonly gitCommand?: string
  readonly maxOutputBytes?: number
  readonly timeoutMs?: number
  readonly okExitCodes?: readonly number[]
  /** `error` (default) rejects with GIT_LIMIT; `truncate` stops reading and returns a partial result. */
  readonly overflow?: "error" | "truncate"
  readonly stdin?: Uint8Array
  readonly runHooks?: boolean
  /** Forward commit-signing agent sockets. Only commit sets this. */
  readonly signing?: boolean
  /** Forward SSH agent and proxy variables. Only push and fetch set this. */
  readonly network?: boolean
  /** Absolute path of a scratch index, so snapshots never touch the work tree's own index. */
  readonly indexFile?: string
  readonly signal?: AbortSignal
}

export interface GitRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

export async function runGit(options: GitRunOptions): Promise<GitRunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? GIT_DEFAULT_MAX_OUTPUT_BYTES
  const timeoutMs = options.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS
  const okExitCodes = options.okExitCodes ?? [0]
  if (options.signal?.aborted) throw new GitError("GIT_CANCELLED", "git command was cancelled")
  const gitCommand = options.gitCommand ?? "git"
  const env = gitEnvironment(options.signing === true, options.network === true, options.indexFile)
  const argv = [
    gitCommand,
    ...SAFE_CONFIG,
    ...(options.runHooks === true ? [] : ["-c", "core.hooksPath=/dev/null"]),
    ...await repositoryProgramOverrides(gitCommand, options.cwd, env),
    ...options.args,
  ]
  let child: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">
  try {
    child = Bun.spawn(argv, {
      cwd: options.cwd,
      env,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    throw new GitError("GIT_UNAVAILABLE", "git is not available")
  }
  let timedOut = false
  const kill = (): void => {
    try { child.kill() } catch { /* already exited */ }
  }
  const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
  options.signal?.addEventListener("abort", kill, { once: true })
  try {
    // Output is drained while stdin is written: git can fill its output pipe before it reads all of its input.
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout, maxOutputBytes, kill),
      collect(child.stderr, MAX_STDERR_BYTES, () => {}),
      child.exited,
      writeChildInput(child.stdin, options.stdin),
    ])
    if (options.signal?.aborted) throw new GitError("GIT_CANCELLED", "git command was cancelled")
    if (timedOut) throw new GitError("GIT_TIMEOUT", "git command timed out")
    if (stdout.overflow && options.overflow !== "truncate") throw new GitError("GIT_LIMIT", "git output exceeds its byte limit")
    if (!stdout.overflow && !okExitCodes.includes(exitCode)) throw new GitError("GIT_FAILED", "git command failed")
    return Object.freeze({ exitCode, stdout: decode(stdout.bytes), stderr: decode(stderr.bytes), truncated: stdout.overflow })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", kill)
  }
}

function gitEnvironment(signing: boolean, network: boolean, indexFile: string | undefined): Record<string, string> {
  const env = filteredEnvironment()
  const forwarded = [...(signing ? SIGNING_ENVIRONMENT : []), ...(network ? NETWORK_ENVIRONMENT : [])]
  for (const name of forwarded) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  if (indexFile !== undefined) env.GIT_INDEX_FILE = indexFile
  env.GIT_OPTIONAL_LOCKS = "0"
  env.GIT_TERMINAL_PROMPT = "0"
  return env
}

/** Writes a child's whole stdin; callers drain its output alongside so neither side blocks. */
export async function writeChildInput(stdin: Bun.FileSink | undefined | null | number, input: string | Uint8Array | undefined): Promise<void> {
  if (input === undefined || typeof stdin !== "object" || stdin === null) return
  try {
    stdin.write(input)
    await stdin.end()
  } catch {
    // A git that exits before reading all of its input reports that through its exit code.
  }
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<{ readonly bytes: Uint8Array; readonly overflow: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let overflow = false
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (overflow) continue
      const room = maxBytes - size
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room))
        size = maxBytes
        overflow = true
        onOverflow()
        continue
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, overflow }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes)
}
