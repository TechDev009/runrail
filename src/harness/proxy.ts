import { lstat, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Where a coding CLI's own settings send its model requests, when that is not its vendor: a local
 * proxy such as Headroom, or a gateway. Only the address field of each settings file is read.
 */
export interface HarnessProxy {
  /** Host and port only: a path or query can carry a key. */
  readonly address: string
  /** The name the CLI's settings give it, such as a Codex provider's `name`. */
  readonly name?: string
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_NAME = 80
const VENDOR_HOSTS: ReadonlySet<string> = new Set(["api.anthropic.com", "api.openai.com", "chatgpt.com"])

type Environment = Readonly<Record<string, string | undefined>>

/** `env.ANTHROPIC_BASE_URL` in Claude Code's user settings; a turn's environment carries no such variable. */
export async function claudeCodeProxy(env: Environment): Promise<HarnessProxy | undefined> {
  const dir = configDir(env, "CLAUDE_CONFIG_DIR", ".claude")
  const text = dir === undefined ? undefined : await readBounded(join(dir, "settings.json"))
  let fromSettings: unknown
  try {
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text)
    fromSettings = isRecord(parsed) && isRecord(parsed.env) ? parsed.env.ANTHROPIC_BASE_URL : undefined
  } catch {
    fromSettings = undefined
  }
  return typeof fromSettings === "string" ? proxyOf(fromSettings) : undefined
}

/** The chosen `model_provider`'s `base_url` and `name` in Codex's config, else its `openai_base_url`. */
export async function codexProxy(env: Environment): Promise<HarnessProxy | undefined> {
  const dir = configDir(env, "CODEX_HOME", ".codex")
  const text = dir === undefined ? undefined : await readBounded(join(dir, "config.toml"))
  let parsed: unknown
  try {
    parsed = text === undefined ? undefined : Bun.TOML.parse(text)
  } catch {
    parsed = undefined
  }
  const config = isRecord(parsed) ? parsed : {}
  const chosen = typeof config.model_provider === "string" ? config.model_provider : undefined
  const providers = isRecord(config.model_providers) ? config.model_providers : {}
  const provider = chosen === undefined || chosen === "openai" ? undefined : providers[chosen]
  if (isRecord(provider) && typeof provider.base_url === "string") return proxyOf(provider.base_url, provider.name)
  return typeof config.openai_base_url === "string" ? proxyOf(config.openai_base_url) : undefined
}

export function proxyOf(value: string | undefined, name?: unknown): HarnessProxy | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return undefined
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host.length === 0 || VENDOR_HOSTS.has(url.hostname)) return undefined
  // eslint-disable-next-line no-control-regex
  const label = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_NAME) : ""
  return Object.freeze({ address: url.host, ...(label.length === 0 ? {} : { name: label }) })
}

async function readBounded(path: string): Promise<string | undefined> {
  try {
    const link = await lstat(path)
    const file = link.isSymbolicLink() ? await stat(path) : link
    if (!file.isFile() || file.size > MAX_FILE_BYTES) return undefined
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** Found through the environment the tool runs with, so a probe with no HOME reads no one's settings. */
function configDir(env: Environment, variable: string, folder: string): string | undefined {
  const own = env[variable]
  if (own !== undefined && own.length > 0) return own
  const home = env.HOME
  return home === undefined || home.length === 0 ? undefined : join(home, folder)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
