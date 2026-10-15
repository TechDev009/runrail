import { ProviderError } from "./errors.ts"
import type { ProviderAuthStyle, ProviderFamilyId, ProviderQuirks } from "./types.ts"

/** Wire protocol a preset speaks. Every preset row picks exactly one. */
export type ProviderPresetProtocol = "openai-responses" | "openai-chat" | "anthropic-messages"

export interface ProviderPreset {
  readonly id: string
  readonly name: string
  /** Fixed in data. A stored credential for this preset is only ever sent to this host. */
  readonly baseUrl: string
  readonly protocol: ProviderPresetProtocol
  readonly authStyle: ProviderAuthStyle
  /** Conventional variable a shell key lives in; used for detection only. */
  readonly environment?: string
  /** `list`: the endpoint answers `GET /models`. `none`: model ids are typed by hand. */
  readonly models: "list" | "none"
  readonly quirks: ProviderQuirks
  /**
   * True for an address that takes the token of a plan sign-in rather than a pasted key. It is
   * reached through a sign-in only; the same vendor's key, when it has one, has its own row.
   */
  readonly signInOnly?: true
}

/** Presets whose endpoint the user supplies. The id carries the protocol and the auth header. */
export interface CustomProviderPreset {
  readonly id: string
  readonly name: string
  readonly protocol: ProviderPresetProtocol
  readonly authStyle: ProviderAuthStyle
  readonly quirks: ProviderQuirks
}

type Row = readonly [id: string, name: string, baseUrl: string, environment: string | undefined, quirks?: ProviderQuirks, models?: "none"]

const MAX_TOKENS: ProviderQuirks = { maxTokensField: "max_tokens" }
const ZHIPU: ProviderQuirks = { maxTokensField: "max_tokens", thinking: "zhipu" }
const QWEN: ProviderQuirks = { thinking: "qwen" }

const RESPONSES: readonly Row[] = [
  ["openai", "OpenAI", "https://api.openai.com/v1", "OPENAI_API_KEY"],
  ["meta", "Meta AI", "https://api.meta.ai/v1", "META_API_KEY"],
]

const MESSAGES: readonly Row[] = [
  ["anthropic", "Anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"],
  ["minimax", "MiniMax (International)", "https://api.minimax.io/anthropic/v1", "MINIMAX_API_KEY", {}, "none"],
  ["minimax-cn", "MiniMax", "https://api.minimaxi.com/anthropic/v1", "MINIMAX_CN_API_KEY", {}, "none"],
  ["kimi-for-coding", "Kimi for Coding", "https://api.kimi.com/coding/v1", "KIMI_API_KEY"],
  ["stepfun-plan", "StepFun Step Plan", "https://api.stepfun.com/step_plan/v1", "STEPFUN_API_KEY"],
]

const CHAT: readonly Row[] = [
  ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", { thinking: "reasoning-object" }],
  ["google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"],
  ["groq", "Groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY"],
  ["xai", "xAI", "https://api.x.ai/v1", "XAI_API_KEY", { thinking: "none" }],
  ["mistral", "Mistral", "https://api.mistral.ai/v1", "MISTRAL_API_KEY", { maxTokensField: "max_tokens", thinking: "none", streamOptions: false }],
  ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", { maxTokensField: "max_tokens", thinking: "thinking-type", reasoningReplay: true }],
  ["togetherai", "Together AI", "https://api.together.xyz/v1", "TOGETHER_API_KEY", { maxTokensField: "max_tokens", thinking: "together" }],
  ["fireworks-ai", "Fireworks AI", "https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY"],
  ["cerebras", "Cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY"],
  ["huggingface", "Hugging Face", "https://router.huggingface.co/v1", "HF_TOKEN"],
  ["nvidia", "NVIDIA", "https://integrate.api.nvidia.com/v1", "NVIDIA_API_KEY", { maxTokensField: "max_tokens", thinking: "none" }],
  ["baseten", "Baseten", "https://inference.baseten.co/v1", "BASETEN_API_KEY"],
  ["vercel", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1", "AI_GATEWAY_API_KEY"],
  ["opencode", "OpenCode Zen", "https://opencode.ai/zen/v1", "OPENCODE_API_KEY"],
  ["opencode-go", "OpenCode Go", "https://opencode.ai/zen/go/v1", "OPENCODE_API_KEY"],
  ["zai", "Z.AI", "https://api.z.ai/api/paas/v4", "ZAI_API_KEY", ZHIPU],
  ["zai-coding-plan", "Z.AI Coding Plan", "https://api.z.ai/api/coding/paas/v4", "ZAI_API_KEY", ZHIPU],
  ["zhipuai", "Zhipu AI", "https://open.bigmodel.cn/api/paas/v4", "ZHIPUAI_API_KEY", ZHIPU],
  ["zhipuai-coding-plan", "Zhipu AI Coding Plan", "https://open.bigmodel.cn/api/coding/paas/v4", "ZAI_CODING_CN_API_KEY", ZHIPU],
  ["moonshotai", "Moonshot AI", "https://api.moonshot.ai/v1", "MOONSHOT_API_KEY", { maxTokensField: "max_tokens", thinking: "none" }],
  ["moonshotai-cn", "Moonshot AI (China)", "https://api.moonshot.cn/v1", "MOONSHOT_API_KEY", { maxTokensField: "max_tokens", thinking: "none" }],
  ["alibaba-cn", "Qwen (DashScope)", "https://dashscope.aliyuncs.com/compatible-mode/v1", "DASHSCOPE_API_KEY", QWEN],
  ["alibaba-token-plan", "Qwen Token Plan", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "QWEN_TOKEN_PLAN_API_KEY", QWEN],
  ["alibaba-token-plan-cn", "Qwen Token Plan (China)", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "QWEN_TOKEN_PLAN_CN_API_KEY", QWEN],
  ["siliconflow-cn", "SiliconFlow", "https://api.siliconflow.cn/v1", "SILICONFLOW_API_KEY"],
  ["volcengine", "Volcengine Ark", "https://ark.cn-beijing.volces.com/api/v3", "ARK_API_KEY", { thinking: "thinking-type" }],
  ["minimax-cn-openai", "MiniMax (OpenAI-compatible)", "https://api.minimaxi.com/v1", "MINIMAX_CN_API_KEY", { thinking: "none" }],
  ["xiaomi", "Xiaomi MiMo", "https://api.xiaomimimo.com/v1", "XIAOMI_API_KEY"],
  ["xiaomi-token-plan-cn", "Xiaomi Token Plan (China)", "https://token-plan-cn.xiaomimimo.com/v1", "XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  ["xiaomi-token-plan-ams", "Xiaomi Token Plan (Europe)", "https://token-plan-ams.xiaomimimo.com/v1", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  ["xiaomi-token-plan-sgp", "Xiaomi Token Plan (Singapore)", "https://token-plan-sgp.xiaomimimo.com/v1", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  ["ant-ling", "Ant Ling", "https://api.ant-ling.com/v1", "ANT_LING_API_KEY", { maxTokensField: "max_tokens", thinking: "reasoning-object" }],
]

/**
 * Where a plan sign-in's token goes when that differs from the vendor's key row: xAI's plan token
 * is used over Responses, and Kimi's is sent as a Bearer token where its key goes in `x-api-key`.
 */
const SIGN_IN_RESPONSES: readonly Row[] = [
  ["xai-grok", "xAI (Grok plan)", "https://api.x.ai/v1", undefined],
]

const SIGN_IN_MESSAGES: readonly Row[] = [
  ["kimi-code", "Kimi Code", "https://api.kimi.com/coding/v1", undefined],
]

function rows(protocol: ProviderPresetProtocol, authStyle: ProviderAuthStyle, source: readonly Row[], signInOnly = false): ProviderPreset[] {
  return source.map(([id, name, baseUrl, environment, quirks, models]) => Object.freeze({
    id,
    name,
    baseUrl,
    protocol,
    authStyle,
    ...(environment === undefined ? {} : { environment }),
    ...(signInOnly ? { signInOnly: true as const } : {}),
    models: models ?? "list",
    // Hosted chat endpoints take the newer field unless their row says otherwise; reasoning models
    // behind routers refuse the old one.
    quirks: Object.freeze({ ...(protocol === "openai-chat" ? { maxTokensField: "max_completion_tokens" as const } : {}), ...(quirks ?? {}) }),
  }))
}

/** Every endpoint Runrail connects to with a pasted key or a sign-in. One table, no code per vendor. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  ...rows("openai-responses", "bearer", RESPONSES),
  ...rows("anthropic-messages", "x-api-key", MESSAGES),
  ...rows("openai-chat", "bearer", CHAT),
  ...rows("openai-responses", "bearer", SIGN_IN_RESPONSES, true),
  ...rows("anthropic-messages", "bearer", SIGN_IN_MESSAGES, true),
])

/**
 * Endpoints the user brings: a local server, a gateway, a relay. Local servers mostly know only
 * `max_tokens`, so that is the chat default here.
 */
export const CUSTOM_PROVIDER_PRESETS: readonly CustomProviderPreset[] = Object.freeze([
  Object.freeze({ id: "custom-openai-chat", name: "Custom (OpenAI Chat)", protocol: "openai-chat" as const, authStyle: "bearer" as const, quirks: Object.freeze({ maxTokensField: "max_tokens" as const }) }),
  Object.freeze({ id: "custom-openai-responses", name: "Custom (OpenAI Responses)", protocol: "openai-responses" as const, authStyle: "bearer" as const, quirks: Object.freeze({}) }),
  Object.freeze({ id: "custom-anthropic", name: "Custom (Anthropic Messages)", protocol: "anthropic-messages" as const, authStyle: "x-api-key" as const, quirks: Object.freeze({}) }),
  Object.freeze({ id: "custom-anthropic-bearer", name: "Custom (Anthropic Messages, Bearer)", protocol: "anthropic-messages" as const, authStyle: "bearer" as const, quirks: Object.freeze({}) }),
])

const BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]))
const CUSTOM_BY_ID = new Map(CUSTOM_PROVIDER_PRESETS.map((preset) => [preset.id, preset]))

/**
 * A variable a model key lives in. A caller naming the variable to send can never pick a cloud,
 * git, or shell secret of the engine's environment this way.
 */
export function isModelKeyVariable(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,120}_API_KEY$/.test(name) || PROVIDER_PRESETS.some((preset) => preset.environment === name)
}

/** A vendor's own key variable goes only to that vendor's address: the one a request finally reaches, defaults resolved. */
export function keyVariableAllowedAt(name: string, endpoint: string): boolean {
  const owners = PROVIDER_PRESETS.filter((preset) => preset.environment === name)
  if (owners.length === 0) return true
  let host: string
  try { host = new URL(endpoint).host } catch { return false }
  return owners.some((preset) => new URL(preset.baseUrl).host === host)
}

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return BY_ID.get(id)
}

export function getCustomProviderPreset(id: string): CustomProviderPreset | undefined {
  return CUSTOM_BY_ID.get(id)
}

const QUIRK_KEYS = new Set(["maxTokensField", "thinking", "reasoningReplay", "streamOptions", "promptCaching"])
const THINKING_SHAPES = new Set<unknown>(["effort", "reasoning-object", "thinking-type", "zhipu", "together", "qwen", "none"])

/** Accepts caller-supplied quirks; refuses anything the adapters do not understand. */
export function parseProviderQuirks(value: unknown): ProviderQuirks {
  if (value === undefined) return Object.freeze({})
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProviderError("PROVIDER_INVALID", "provider quirks are invalid")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !QUIRK_KEYS.has(key))) throw new ProviderError("PROVIDER_INVALID", "provider quirks contain an unknown field")
  if (record.maxTokensField !== undefined && record.maxTokensField !== "max_tokens" && record.maxTokensField !== "max_completion_tokens") throw new ProviderError("PROVIDER_INVALID", "provider max tokens field is invalid")
  if (record.thinking !== undefined && !THINKING_SHAPES.has(record.thinking)) throw new ProviderError("PROVIDER_INVALID", "provider thinking shape is invalid")
  if (record.reasoningReplay !== undefined && typeof record.reasoningReplay !== "boolean") throw new ProviderError("PROVIDER_INVALID", "provider reasoning replay flag is invalid")
  if (record.streamOptions !== undefined && typeof record.streamOptions !== "boolean") throw new ProviderError("PROVIDER_INVALID", "provider stream options flag is invalid")
  if (record.promptCaching !== undefined && typeof record.promptCaching !== "boolean") throw new ProviderError("PROVIDER_INVALID", "provider prompt caching flag is invalid")
  return Object.freeze({ ...record }) as ProviderQuirks
}

export function parseProviderAuthStyle(value: unknown): ProviderAuthStyle | undefined {
  if (value === undefined) return undefined
  if (value !== "bearer" && value !== "x-api-key") throw new ProviderError("PROVIDER_INVALID", "provider auth style is invalid")
  return value
}

const FAMILY_IDS: ReadonlySet<string> = new Set<ProviderFamilyId>(["openai", "anthropic", "openai-compatible", "xai"])
const PROVIDER_ID = /^[a-z][a-z0-9._:-]{0,63}$/

export function isProviderFamilyId(id: unknown): id is ProviderFamilyId {
  return typeof id === "string" && FAMILY_IDS.has(id)
}

/** What a request needs to know about where it goes: address, protocol, key header, quirks. */
export interface ProviderTarget {
  readonly endpoint: string
  readonly protocol: ProviderPresetProtocol
  readonly authStyle: ProviderAuthStyle
  readonly quirks: ProviderQuirks
  readonly name: string
}

export interface ProviderTargetInput {
  readonly provider: string
  readonly endpoint?: string
  readonly protocol?: "responses" | "chat" | "messages" | ProviderPresetProtocol
  readonly authStyle?: ProviderAuthStyle
  readonly quirks?: ProviderQuirks
  readonly displayName?: string
}

/**
 * Fills in what the caller left out. The four provider families keep their own defaults; any other
 * id takes them from its preset row. An id with no row must name its endpoint and protocol, so a key
 * is never sent to an address nobody chose.
 */
export function resolveProviderTarget(input: ProviderTargetInput): ProviderTarget {
  if (input === null || typeof input !== "object" || typeof input.provider !== "string" || !PROVIDER_ID.test(input.provider)) throw new ProviderError("PROVIDER_INVALID", "provider id is invalid")
  if (input.endpoint !== undefined && (typeof input.endpoint !== "string" || input.endpoint.length === 0)) throw new ProviderError("PROVIDER_INVALID", "provider endpoint is invalid")
  if (input.displayName !== undefined && (typeof input.displayName !== "string" || input.displayName.length === 0 || input.displayName.length > 128 || /[\r\n\0]/.test(input.displayName))) throw new ProviderError("PROVIDER_INVALID", "provider name is invalid")
  const requested = protocolOf(input.protocol)
  const authStyle = parseProviderAuthStyle(input.authStyle)
  const quirks = parseProviderQuirks(input.quirks)
  const base = baseTarget(input.provider, input.endpoint, requested)
  const protocol = requested ?? base.protocol
  const target: ProviderTarget = {
    // The `anthropic` family keeps the address exactly as its caller wrote it, as it always has.
    endpoint: protocol === "anthropic-messages" && input.provider !== "anthropic" ? messagesBase(base.endpoint) : base.endpoint,
    protocol,
    authStyle: authStyle ?? (requested === undefined || requested === base.protocol ? base.authStyle : protocol === "anthropic-messages" ? "x-api-key" : "bearer"),
    quirks: Object.freeze({ ...base.quirks, ...quirks }),
    name: input.displayName ?? base.name,
  }
  if (target.protocol !== "anthropic-messages" && target.authStyle !== "bearer") throw new ProviderError("PROVIDER_INVALID", "OpenAI protocols send the key as a Bearer token")
  return Object.freeze(target)
}

function baseTarget(provider: string, endpoint: string | undefined, requested: ProviderPresetProtocol | undefined): ProviderTarget {
  if (provider === "anthropic") return { endpoint: endpoint ?? "https://api.anthropic.com/v1", protocol: "anthropic-messages", authStyle: "x-api-key", quirks: {}, name: "Anthropic" }
  if (provider === "openai" || provider === "openai-compatible" || provider === "xai") {
    const address = endpoint ?? (provider === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1")
    // Only OpenAI's own API is known to want the newer field; a relay or a local server reached
    // through these ids keeps the one every compatible server understands.
    const quirks: ProviderQuirks = { maxTokensField: hostOf(address) === "api.openai.com" ? "max_completion_tokens" : "max_tokens", thinking: "effort" }
    return { endpoint: address, protocol: "openai-chat", authStyle: "bearer", quirks, name: provider === "xai" ? "xAI / Grok" : provider === "openai-compatible" ? "OpenAI-compatible" : "OpenAI" }
  }
  const preset = BY_ID.get(provider)
  if (preset !== undefined) return { endpoint: endpoint ?? preset.baseUrl, protocol: preset.protocol, authStyle: preset.authStyle, quirks: preset.quirks, name: preset.name }
  if (endpoint === undefined) throw new ProviderError("PROVIDER_INVALID", "provider endpoint is required")
  const custom = CUSTOM_BY_ID.get(provider)
  if (custom !== undefined) return { endpoint, protocol: custom.protocol, authStyle: custom.authStyle, quirks: custom.quirks, name: custom.name }
  if (requested === undefined) throw new ProviderError("PROVIDER_INVALID", "provider protocol is required")
  return { endpoint, protocol: requested, authStyle: requested === "anthropic-messages" ? "x-api-key" : "bearer", quirks: requested === "openai-chat" ? { maxTokensField: "max_tokens" } : {}, name: provider }
}

function protocolOf(value: unknown): ProviderPresetProtocol | undefined {
  if (value === undefined) return undefined
  if (value === "responses" || value === "openai-responses") return "openai-responses"
  if (value === "chat" || value === "openai-chat") return "openai-chat"
  if (value === "messages" || value === "anthropic-messages") return "anthropic-messages"
  throw new ProviderError("PROVIDER_INVALID", "provider protocol is invalid")
}

/**
 * Anthropic's own client takes a base URL without the version and adds `/v1` itself, so the
 * addresses vendors publish come in both forms. A base that does not end in a version gets one.
 */
function messagesBase(endpoint: string): string {
  let url: URL
  try { url = new URL(endpoint) } catch { return endpoint }
  const last = url.pathname.split("/").filter((segment) => segment.length > 0).at(-1)
  if (last !== undefined && /^v\d+$/.test(last)) return endpoint
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1`
  return url.toString()
}

function hostOf(address: string): string | undefined {
  try { return new URL(address).hostname.toLowerCase() } catch { return undefined }
}
