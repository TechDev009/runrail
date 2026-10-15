import type { NativeModelChunk, NativeModelPort, NativeModelRequest, NativeModelResponse } from "@nifrajs/coding-agent"
import type { ModelAdapter, ModelCapability, ModelDescriptor, ThinkingLevel } from "../model/catalog.ts"
import type { RunrailContentModelPort, RunrailContentModelRequest } from "../model/content.ts"

export type ProviderProtocol =
  | "openai-responses"
  | "openai-chat"
  | "anthropic-messages"
  | "openai-compatible"
  | "google-generative-ai"
  | "vertex-ai"
  | "aws-bedrock"
  | "llama.cpp"

export type ProviderOwnership = "native-adapter" | "caller-owned"

export type ProviderCredentialReference =
  | {
      readonly kind: "environment"
      readonly environment: string
      readonly account?: string
    }
  | {
      readonly kind: "caller"
      readonly account: string
    }

export interface ProviderCredentialResolver {
  /** Returns a secret transiently. Callers must not serialize or persist the returned value. */
  resolve(reference: ProviderCredentialReference): string | PromiseLike<string>
}

export interface ProviderEndpointPolicy {
  readonly baseUrl: string
  readonly allowRemote?: boolean
  readonly allowInsecureRemote?: boolean
  readonly allowedHosts?: readonly string[]
  readonly timeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxStreamBytes?: number
  readonly maxEvents?: number
  readonly maxRetries?: number
  readonly retryDelayMs?: number
}

export interface ProviderLimits {
  readonly timeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxStreamBytes: number
  readonly maxEvents: number
  readonly maxRetries: number
  readonly retryDelayMs: number
}

/** Header that carries the key: `authorization: Bearer <key>` or `x-api-key: <key>`. */
export type ProviderAuthStyle = "bearer" | "x-api-key"

/**
 * How an OpenAI Chat endpoint spells the thinking switch.
 *
 * - `effort`: `reasoning_effort: "<level>"`
 * - `reasoning-object`: `reasoning: { effort: "<level>" }`
 * - `thinking-type`: `thinking: { type: "enabled" | "disabled" }`
 * - `zhipu`: `thinking: { type: "enabled", clear_thinking: false } | { type: "disabled" }`
 * - `together`: `reasoning: { enabled: boolean }`
 * - `qwen`: `enable_thinking: boolean`
 * - `none`: the endpoint has no switch; nothing is sent
 */
export type ProviderThinkingShape = "effort" | "reasoning-object" | "thinking-type" | "zhipu" | "together" | "qwen" | "none"

/** Places where an endpoint departs from the protocol it otherwise follows. */
export interface ProviderQuirks {
  /** Chat field that caps the answer length. */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens"
  readonly thinking?: ProviderThinkingShape
  /** Replayed assistant messages must carry `reasoning_content` while thinking is on. */
  readonly reasoningReplay?: boolean
  /** `false`: the endpoint refuses `stream_options` and reports usage on its own. */
  readonly streamOptions?: boolean
  /** `false`: a Messages endpoint that refuses `cache_control` markers. */
  readonly promptCaching?: boolean
}

/** Provider families with built-in defaults. Any other id needs a preset row or an explicit endpoint. */
export type ProviderFamilyId = "openai" | "anthropic" | "openai-compatible" | "xai"

/** A reasoning level the model refused; the turn went out without one. */
export interface ProviderNotice {
  readonly code: "THINKING_REFUSED"
  readonly thinking: ThinkingLevel
}

export interface ProviderModelOptions {
  /** A provider family, a preset id from `PROVIDER_PRESETS`, or a caller-chosen id with an explicit endpoint. */
  readonly provider: ProviderFamilyId | (string & {})
  /** Name shown to people. Defaults to the preset's name. */
  readonly displayName?: string
  readonly model: string
  readonly credential: ProviderCredentialReference
  readonly credentialResolver?: ProviderCredentialResolver
  readonly endpoint?: string
  readonly allowRemote?: boolean
  readonly allowInsecureRemote?: boolean
  readonly allowedHosts?: readonly string[]
  readonly protocol?: "responses" | "chat" | "messages"
  /** Defaults to the protocol's own header: Bearer for OpenAI protocols, `x-api-key` for Anthropic Messages. */
  readonly authStyle?: ProviderAuthStyle
  readonly quirks?: ProviderQuirks
  readonly thinking?: ThinkingLevel
  /**
   * Caller-owned transient sink for streamed reasoning text (Anthropic thinking, OpenAI
   * reasoning summaries). It is never persisted and never enters the model transcript.
   */
  readonly onReasoning?: (text: string) => void
  /**
   * Caller-owned transient sink for what a provider changed so a turn could go through, such as a
   * reasoning level the model refused. It carries stable codes only and is never persisted.
   */
  readonly onNotice?: (notice: ProviderNotice) => void
  readonly maxOutputTokens?: number
  readonly timeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxStreamBytes?: number
  readonly maxEvents?: number
  readonly maxRetries?: number
  readonly retryDelayMs?: number
  readonly descriptor?: {
    readonly tier?: "cheap" | "fast" | "strong"
    readonly version?: string
    readonly capabilities?: readonly ModelCapability[]
    readonly contextTokens?: number
    readonly pricing?: ModelDescriptor["pricing"]
  }
  /** Non-authentication headers. Authentication headers are added by the credential resolver. */
  readonly headers?: Readonly<Record<string, string>>
}

export interface ProviderDescriptor {
  readonly id: string
  readonly name: string
  readonly protocols: readonly ProviderProtocol[]
  readonly capabilities: readonly ModelCapability[]
  readonly ownership?: ProviderOwnership
  readonly configured: boolean
  readonly credentialEnvironment?: string
}

export interface ProviderModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly costUsd?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly elapsedMs?: number
}

export interface ProviderUsageAware {
  readonly takeUsage?: () => ProviderModelUsage | undefined
  readonly lastUsage?: ProviderModelUsage
}

export type ProviderModelPort = NativeModelPort & ProviderUsageAware
export type ProviderContentModelPort = RunrailContentModelPort & ProviderUsageAware

export interface ProviderModelAdapter extends ModelAdapter {
  readonly provider: ProviderDescriptor
}

export interface ProviderModelRequest extends NativeModelRequest {
  readonly parts?: RunrailContentModelRequest["parts"]
}

export type ProviderModelChunk = NativeModelChunk
export type ProviderDiscoveryOptions = Omit<ProviderModelOptions, "model">
export type ProviderModelResult = NativeModelResponse

export interface ProviderFactoryOptions {
  readonly credentialResolver?: ProviderCredentialResolver
}
