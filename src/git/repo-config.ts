import { GitError } from "./errors.ts"

/**
 * Settings that make git run a program. A repository's own config (`.git/config`, its includes,
 * a worktree's config) can be written by an agent or arrive with a downloaded folder, so for each
 * one it sets, Runrail's git calls take the person's own value instead, or a value that runs
 * nothing new. The person's global and system settings (Git LFS, credential helpers) still apply.
 */
const PROGRAM_KEYS = "^(filter\\..+\\.(clean|smudge|process|required)|diff\\..+\\.(textconv|command)|merge\\..+\\.driver|core\\.(sshcommand|askpass|gitproxy)|credential(\\..+)?\\.helper|gpg(\\..+)?\\.program|diff\\.external|remote\\..+\\.(uploadpack|receivepack))$"
const PROGRAM_KEY = new RegExp(PROGRAM_KEYS, "i")
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"])
const MAX_CONFIG_BYTES = 256 * 1024
const CONFIG_TIMEOUT_MS = 5_000

interface ConfigEntry {
  readonly scope: string
  readonly key: string
  readonly value: string
}

/** `-c` arguments that replace every program a repository's own config names. */
export async function repositoryProgramOverrides(gitCommand: string, cwd: string, env: Record<string, string>): Promise<readonly string[]> {
  const entries = await readProgramSettings(gitCommand, cwd, env)
  const repositoryKeys = new Set(entries.filter((entry) => REPOSITORY_SCOPES.has(entry.scope)).map((entry) => entry.key))
  const overrides: string[] = []
  for (const key of repositoryKeys) {
    const own = entries.filter((entry) => entry.key === key && !REPOSITORY_SCOPES.has(entry.scope) && entry.scope !== "command").map((entry) => entry.value)
    if (/\.helper$/i.test(key)) {
      // An empty helper clears the list; the person's own helpers are then added back in order.
      overrides.push("-c", `${key}=`, ...own.flatMap((value) => ["-c", `${key}=${value}`]))
    } else {
      overrides.push("-c", `${key}=${own.at(-1) ?? neutralValue(key)}`)
    }
  }
  return overrides
}

function neutralValue(key: string): string {
  const name = key.toLowerCase()
  if (/^filter\..+\.required$/.test(name) || /^merge\..+\.driver$/.test(name)) return "false"
  if (name === "core.sshcommand") return "ssh"
  if (name === "gpg.ssh.program") return "ssh-keygen"
  if (name === "gpg.x509.program") return "gpgsm"
  if (/^gpg\.(openpgp\.)?program$/.test(name)) return "gpg"
  if (name.endsWith(".uploadpack")) return "git-upload-pack"
  if (name.endsWith(".receivepack")) return "git-receive-pack"
  return ""
}

async function readProgramSettings(gitCommand: string, cwd: string, env: Record<string, string>): Promise<readonly ConfigEntry[]> {
  const scoped = await runConfig(gitCommand, cwd, env, ["--show-scope", "--includes", "--null", "--get-regexp", PROGRAM_KEYS])
  if (scoped.exitCode === 0) return parseScoped(scoped.text)
  if (scoped.exitCode === 1) return []
  // Git older than 2.26 has no --show-scope: only the repository's own file is read, and every
  // program it names is replaced with a value that runs nothing new.
  if (scoped.exitCode === 129) {
    const local = await runConfig(gitCommand, cwd, env, ["--local", "--includes", "--null", "--get-regexp", PROGRAM_KEYS])
    if (local.exitCode === 0) return parseUnscoped(local.text)
    if (local.exitCode === 1 || local.exitCode === 128) return []
  }
  throw new GitError("GIT_FAILED", "the repository's git configuration could not be read")
}

async function runConfig(gitCommand: string, cwd: string, env: Record<string, string>, args: readonly string[]): Promise<{ readonly exitCode: number; readonly text: string }> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    child = Bun.spawn([gitCommand, "--no-pager", "-c", "core.fsmonitor=false", "config", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  } catch {
    throw new GitError("GIT_UNAVAILABLE", "git is not available")
  }
  const timer = setTimeout(() => child.kill(), CONFIG_TIMEOUT_MS)
  try {
    const [text, exitCode] = await Promise.all([boundedText(child), child.exited])
    return { exitCode, text }
  } finally {
    clearTimeout(timer)
  }
}

async function boundedText(child: Bun.Subprocess<"ignore", "pipe", "ignore">): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of child.stdout) {
    total += chunk.byteLength
    if (total > MAX_CONFIG_BYTES) {
      child.kill()
      throw new GitError("GIT_LIMIT", "the repository's git configuration is too large")
    }
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function parseScoped(text: string): readonly ConfigEntry[] {
  const fields = text.split("\0")
  const entries: ConfigEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const entry = keyValue(fields[index + 1] ?? "")
    if (entry !== undefined) entries.push({ scope: fields[index] ?? "", ...entry })
  }
  return entries
}

function parseUnscoped(text: string): readonly ConfigEntry[] {
  return text.split("\0").flatMap((field) => {
    const entry = keyValue(field)
    return entry === undefined ? [] : [{ scope: "local", ...entry }]
  })
}

function keyValue(field: string): { readonly key: string; readonly value: string } | undefined {
  const newline = field.indexOf("\n")
  const key = newline < 0 ? field : field.slice(0, newline)
  if (!PROGRAM_KEY.test(key)) return undefined
  return { key, value: newline < 0 ? "" : field.slice(newline + 1) }
}
