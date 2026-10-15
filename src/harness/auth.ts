import type { HarnessAuthMode, HarnessAuthOptions, HarnessCredentialResolver } from "./types.ts"
import { filteredEnvironment } from "../workspace/policy.ts"

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export class HarnessAuthError extends Error {
  constructor() {
    super("harness credentials are unavailable")
    this.name = "HarnessAuthError"
  }
}

/** Normalize the credential boundary for a command-backed harness. */
export function parseHarnessAuthOptions(value: unknown): HarnessAuthOptions {
  if (value === undefined) return Object.freeze({ mode: "subscription", credentialEnvironment: Object.freeze([]) })
  if (!isRecord(value)) throw new TypeError("harness authentication options are invalid")
  const mode = parseMode(value.mode)
  const names = parseEnvironmentNames(value.credentialEnvironment)
  const resolver = value.credentialResolver
  if (mode === "subscription") {
    if (names.length > 0 || resolver !== undefined) throw new TypeError("subscription harness authentication cannot include credentials")
    return Object.freeze({ mode, credentialEnvironment: Object.freeze([]) })
  }
  if (names.length === 0) throw new TypeError("harness credential environment is required")
  if (mode === "environment") {
    if (resolver !== undefined) throw new TypeError("environment harness authentication cannot include a resolver")
    return Object.freeze({ mode, credentialEnvironment: Object.freeze([...names]) })
  }
  if (!isCredentialResolver(resolver)) throw new TypeError("caller harness authentication requires a resolver")
  return Object.freeze({ mode, credentialEnvironment: Object.freeze([...names]), credentialResolver: resolver })
}

export function isHarnessAuthMode(value: unknown): value is HarnessAuthMode {
  return value === "subscription" || value === "environment" || value === "caller"
}

/** Resolve a command environment without reading or persisting vendor auth files. */
export async function resolveHarnessEnvironment(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
  auth: HarnessAuthOptions,
): Promise<Record<string, string>> {
  const environment = filteredEnvironment(overrides)
  const names = auth.credentialEnvironment ?? []
  if (names.length === 0) return environment

  let values: Readonly<Record<string, string | undefined>>
  if (auth.mode === "environment") {
    values = Object.freeze(Object.fromEntries(names.map((name) => [name, overrides?.[name] ?? process.env[name]])))
  } else if (auth.mode === "caller") {
    const resolver = auth.credentialResolver
    if (resolver === undefined) throw new HarnessAuthError()
    try {
      const resolved = await resolver(names)
      if (!isRecord(resolved) || Object.keys(resolved).some((name) => !names.includes(name))) throw new Error("unexpected credential")
      values = resolved
    } catch {
      throw new HarnessAuthError()
    }
  } else {
    return environment
  }

  for (const name of names) {
    const value = values[name]
    if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024) throw new HarnessAuthError()
    environment[name] = value
  }
  return environment
}

function parseMode(value: unknown): HarnessAuthMode {
  if (value === undefined) return "subscription"
  if (!isHarnessAuthMode(value)) throw new TypeError("harness authentication mode is invalid")
  return value
}

function parseEnvironmentNames(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 16) throw new TypeError("harness credential environment is invalid")
  const names = value.map((name) => {
    if (typeof name !== "string" || !ENVIRONMENT_NAME.test(name)) throw new TypeError("harness credential environment is invalid")
    return name
  })
  if (new Set(names).size !== names.length) throw new TypeError("harness credential environment contains duplicates")
  return Object.freeze(names)
}

/**
 * Variables a route sets on its tool, such as the tool's config folder. They are never credentials,
 * so a name that reads like one is refused; a key travels only through `HarnessAuthOptions`.
 */
export function isRouteEnvironment(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 16 && entries.every(([name, entry]) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/.test(name) && typeof entry === "string" && entry.length <= 4_096 && !entry.includes("\0"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isCredentialResolver(value: unknown): value is HarnessCredentialResolver {
  return typeof value === "function"
}
