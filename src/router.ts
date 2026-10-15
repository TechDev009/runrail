import {
  type BackendRegistry,
  type BackendSelection,
  type RunrailBackendAdapter,
} from "./backend/registry.ts"

export interface RouteRequest extends BackendSelection {}

export interface RouteDecision {
  readonly backend: string
  readonly version: string
  readonly capabilities: readonly string[]
  readonly requiredCapabilities: readonly string[]
}

export function routeBackend(registry: BackendRegistry, request: RouteRequest = {}): RouteDecision {
  const adapter: RunrailBackendAdapter = registry.select(request)
  const requiredCapabilities = Object.freeze(
    [...new Set(request.requiredCapabilities ?? [])].sort(),
  )
  return Object.freeze({
    backend: adapter.name,
    version: adapter.version,
    capabilities: adapter.capabilities,
    requiredCapabilities,
  })
}
