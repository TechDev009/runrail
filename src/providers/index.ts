export { ProviderError, isProviderError, providerError } from "./errors.ts"
export type { ProviderErrorCode } from "./errors.ts"
export {
  createCallerCredentialResolver,
  createEnvironmentCredentialResolver,
  parseCredentialReference,
  redactCredential,
  validateCredentialEnvironmentName,
} from "./credentials.ts"
export {
  RUNRAIL_USER_AGENT,
  createProviderHttpClient,
  normalizeProviderEndpoint,
} from "./http.ts"
export type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderHttpStreamResponse,
} from "./http.ts"
export { collectSseJson, decodeSse } from "./sse.ts"
export type { SseDecoderOptions, SseEvent } from "./sse.ts"
export type {
  ProviderCredentialReference,
  ProviderCredentialResolver,
  ProviderDescriptor,
  ProviderAuthStyle,
  ProviderEndpointPolicy,
  ProviderFactoryOptions,
  ProviderFamilyId,
  ProviderQuirks,
  ProviderThinkingShape,
  ProviderLimits,
  ProviderModelAdapter,
  ProviderModelChunk,
  ProviderDiscoveryOptions,
  ProviderModelOptions,
  ProviderModelPort,
  ProviderNotice,
  ProviderModelRequest,
  ProviderModelResult,
  ProviderModelUsage,
  ProviderContentModelPort,
  ProviderProtocol,
  ProviderOwnership,
  ProviderUsageAware,
} from "./types.ts"
export { ProviderCatalog, createCallerOwnedProviderModelAdapter, createConfiguredProviderModelAdapter, createDefaultProviderCatalog, createProviderCatalog, providerDescriptor } from "./catalog.ts"
export type { CallerOwnedProviderModelOptions, ProviderDefinition } from "./catalog.ts"
export { createAnthropicModelAdapter, createAnthropicModelPort } from "./anthropic.ts"
export { createOpenAIModelAdapter, createOpenAIModelPort } from "./openai.ts"
export type { OpenAIModelAdapterOptions, OpenAIModelPortOptions } from "./openai.ts"
export { createOpenAICompatibleModelAdapter, createXaiGrokModelAdapter } from "./openai-compatible.ts"
export type { OpenAICompatibleOptions } from "./openai-compatible.ts"
export { discoverProviderModels } from "./catalog.ts"
export {
  CUSTOM_PROVIDER_PRESETS,
  PROVIDER_PRESETS,
  getCustomProviderPreset,
  getProviderPreset,
  isProviderFamilyId,
  parseProviderAuthStyle,
  parseProviderQuirks,
  resolveProviderTarget,
} from "./presets.ts"
export type { CustomProviderPreset, ProviderPreset, ProviderPresetProtocol, ProviderTarget, ProviderTargetInput } from "./presets.ts"
export { createModelMetadataSource, fetchModelList, isChatModelId, mergeModelList, modelDescriptorFacts, parseModelList } from "./model-list.ts"
export type { ListedModel, ModelMetadataSource } from "./model-list.ts"
export { MODELS_SNAPSHOT } from "./models-snapshot.ts"
export type { ModelListPrice, ModelMetadata, ModelsSnapshot } from "./models-snapshot.ts"
export {
  createDefaultProviderCompatibilityMatrix,
  parseProviderCompatibilityMatrix,
  summarizeProviderCompatibilityMatrix,
  ProviderCompatibilityError,
  PROVIDER_COMPATIBILITY_VERSION,
} from "./compatibility.ts"
export type {
  ProviderCompatibilityClassification,
  ProviderCompatibilityEntry,
  ProviderCompatibilityMatrix,
  ProviderCompatibilityStatus,
  ProviderCompatibilitySummary,
} from "./compatibility.ts"
