import type { ModelAdapter } from "../model/catalog.ts"
import { ProviderError } from "./errors.ts"
import type { ProviderModelOptions } from "./types.ts"
import { createOpenAIModelAdapter } from "./openai.ts"

export interface OpenAICompatibleOptions extends ProviderModelOptions {
  readonly providerName?: string
}

/** OpenAI-compatible adapter for xAI/Grok and caller-selected compatible endpoints. */
export function createOpenAICompatibleModelAdapter(options: OpenAICompatibleOptions): import("./types.ts").ProviderModelAdapter {
  if (options.provider !== "openai-compatible" && options.provider !== "xai") throw new ProviderError("PROVIDER_INVALID", "compatible provider kind is invalid")
  const provider = options.providerName ?? (options.provider === "xai" ? "xai" : "openai-compatible")
  return createOpenAIModelAdapter({
    ...options,
    providerLabel: provider,
    endpoint: options.endpoint ?? (options.provider === "xai" ? "https://api.x.ai/v1" : undefined),
    protocol: options.protocol ?? "chat",
  })
}

export function createXaiGrokModelAdapter(options: Omit<OpenAICompatibleOptions, "provider">): ModelAdapter {
  return createOpenAICompatibleModelAdapter({ ...options, provider: "xai", providerName: "xai" })
}
