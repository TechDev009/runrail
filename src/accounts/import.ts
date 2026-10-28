import { lstat, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { isChatModelId } from "../providers/model-list.ts"
import { PROVIDER_PRESETS } from "../providers/presets.ts"

/**
 * Providers other coding tools are set up with (Codex's `config.toml`, Pi's `models.json`,
 * opencode's `opencode.json`), offered as connections to add. Only addresses, model ids, and the
 * name of a variable that holds a key are read; a key written into one of these files is never
 * returned, logged, or copied.
 */

export type ImportSource = "codex" | "pi" | "opencode"

/**
 * `preset`: the address belongs to a provider Runrail knows, so it is added as that provider.
 * `local`: an endpoint on this machine. `remote`: any other address; the person adds it with a key.
 */
export type ImportKind = "preset" | "local" | "remote"

export interface ImportableConnection {
  readonly source: ImportSource
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly kind: ImportKind
  readonly presetId?: string
  /** The preset's own key variable, when the source names it. Never a key. */
  readonly environmentName?: string
  /** Whether the engine's environment holds that variable. */
  readonly environmentSet?: boolean
  readonly models: readonly string[]
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_CANDIDATES = 64
const MAX_MODELS = 64
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

interface RawProvider {
  readonly id: string
  readonly name?: unknown
  readonly baseUrl?: unknown
  readonly environmentName?: string
  readonly models: readonly unknown[]
}

export async function findImportableConnections(home: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<readonly ImportableConnection[]> {
  const sources: readonly [ImportSource, string, (text: string) => readonly RawProvider[]][] = [
    ["codex", join(home, ".codex", "config.toml"), codexProviders],
    ["pi", join(home, ".pi", "agent", "models.json"), piProviders],
    ["opencode", join(home, ".config", "opencode", "opencode.json"), opencodeProviders],
  ]
  const found: ImportableConnection[] = []
  const seen = new Set<string>()
  for (const [source, path, parse] of sources) {
    const text = await readBounded(path)
    if (text === undefined) continue
    let providers: readonly RawProvider[]
    try {
      providers = parse(text)
    } catch {
      continue
    }
    for (const provider of providers) {
      const candidate = classify(source, provider, environment)
      if (candidate === undefined) continue
      const key = `${candidate.presetId ?? ""} ${candidate.baseUrl}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push(candidate)
      if (found.length >= MAX_CANDIDATES) return Object.freeze(found)
    }
  }
  return Object.freeze(found)
}

function classify(source: ImportSource, provider: RawProvider, environment: Readonly<Record<string, string | undefined>>): ImportableConnection | undefined {
  if (!ID.test(provider.id) || typeof provider.baseUrl !== "string" || provider.baseUrl.length > 2_048) return undefined
  let url: URL
  try {
    url = new URL(provider.baseUrl)
  } catch {
    return undefined
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username.length > 0 || url.password.length > 0) return undefined
  // The scheme must match too: `http://api.openai.com` is not the provider's own address.
  const preset = PROVIDER_PRESETS.find((entry) => entry.signInOnly !== true && new URL(entry.baseUrl).host === url.host && new URL(entry.baseUrl).protocol === url.protocol)
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (preset === undefined && !loopback && url.protocol !== "https:") return undefined
  const name = typeof provider.name === "string" && provider.name.length > 0 && provider.name.length <= 80 && !/[\0-\x1f\x7f]/.test(provider.name) ? provider.name : provider.id
  const models = [...new Set(provider.models.filter((model): model is string => typeof model === "string" && model.length > 0 && model.length <= 256 && !/[\0-\x1f\x7f]/.test(model) && isChatModelId(model)))].slice(0, MAX_MODELS)
  // A shell variable is only ever sent to the provider that conventionally owns it.
  const environmentName = preset !== undefined && provider.environmentName !== undefined && provider.environmentName === preset.environment ? provider.environmentName : undefined
  const value = environmentName === undefined ? undefined : environment[environmentName]
  return Object.freeze({
    source,
    id: provider.id,
    name,
    baseUrl: url.href.replace(/\/$/, ""),
    kind: preset !== undefined ? "preset" : loopback ? "local" : "remote",
    ...(preset === undefined ? {} : { presetId: preset.id }),
    ...(environmentName === undefined ? {} : { environmentName, environmentSet: typeof value === "string" && value.length > 0 }),
    models: Object.freeze(models),
  })
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

/** `[model_providers.<id>]` with `name`, `base_url`, and `env_key`. */
function codexProviders(text: string): readonly RawProvider[] {
  const parsed: unknown = Bun.TOML.parse(text)
  const table = isRecord(parsed) && isRecord(parsed.model_providers) ? parsed.model_providers : {}
  const model = isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : undefined
  const chosen = isRecord(parsed) && typeof parsed.model_provider === "string" ? parsed.model_provider : undefined
  return Object.entries(table).flatMap(([id, value]) => {
    if (!isRecord(value)) return []
    const environmentName = typeof value.env_key === "string" && ENVIRONMENT_NAME.test(value.env_key) ? value.env_key : undefined
    return [{ id, name: value.name, baseUrl: value.base_url, ...(environmentName === undefined ? {} : { environmentName }), models: model !== undefined && chosen === id ? [model] : [] }]
  })
}

/** `providers.<id>` with `baseUrl`, `apiKey` (a variable name or a key), and `models[].id`. */
function piProviders(text: string): readonly RawProvider[] {
  const parsed: unknown = JSON.parse(text)
  const table = isRecord(parsed) && isRecord(parsed.providers) ? parsed.providers : {}
  return Object.entries(table).flatMap(([id, value]) => {
    if (!isRecord(value)) return []
    // Only an upper-case variable name is taken; anything else may be the key itself and is dropped.
    const environmentName = typeof value.apiKey === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.apiKey) ? value.apiKey : undefined
    const models = Array.isArray(value.models) ? value.models.map((model) => (isRecord(model) ? model.id : undefined)) : []
    return [{ id, name: value.name, baseUrl: value.baseUrl, ...(environmentName === undefined ? {} : { environmentName }), models }]
  })
}

/** `provider.<id>` with `options.baseURL`, `options.apiKey` as `{env:NAME}`, and `models` keyed by id. */
function opencodeProviders(text: string): readonly RawProvider[] {
  const parsed: unknown = JSON.parse(text)
  const table = isRecord(parsed) && isRecord(parsed.provider) ? parsed.provider : {}
  return Object.entries(table).flatMap(([id, value]) => {
    if (!isRecord(value)) return []
    const options = isRecord(value.options) ? value.options : {}
    const reference = typeof options.apiKey === "string" ? /^\{env:([A-Za-z_][A-Za-z0-9_]{0,63})\}$/.exec(options.apiKey)?.[1] : undefined
    return [{ id, name: value.name, baseUrl: options.baseURL, ...(reference === undefined ? {} : { environmentName: reference }), models: isRecord(value.models) ? Object.keys(value.models) : [] }]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
