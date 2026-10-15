import { ProviderError } from "./errors.ts"
import type { ProviderCredentialReference, ProviderCredentialResolver } from "./types.ts"

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export function parseCredentialReference(value: unknown): ProviderCredentialReference {
  if (typeof value === "string") {
    if (!ENV_NAME.test(value)) throw new ProviderError("PROVIDER_CREDENTIALS", "credential environment name is invalid")
    return Object.freeze({ kind: "environment", environment: value })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError("PROVIDER_CREDENTIALS", "credential reference is invalid")
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== "environment" && kind !== "caller")
    throw new ProviderError("PROVIDER_CREDENTIALS", "credential reference kind is invalid")
  if (kind === "environment") {
    if (typeof record.environment !== "string" || !ENV_NAME.test(record.environment))
      throw new ProviderError("PROVIDER_CREDENTIALS", "credential environment name is invalid")
    return Object.freeze({
      kind,
      environment: record.environment,
      ...(record.account === undefined ? {} : { account: boundedAccount(record.account) }),
    })
  }
  if (typeof record.account !== "string" || record.account.length === 0 || record.account.length > 128)
    throw new ProviderError("PROVIDER_CREDENTIALS", "caller credential account is invalid")
  return Object.freeze({ kind, account: record.account })
}

export function createEnvironmentCredentialResolver(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProviderCredentialResolver {
  return Object.freeze({
    resolve(reference: ProviderCredentialReference): string {
      const parsed = parseCredentialReference(reference)
      if (parsed.kind !== "environment")
        throw new ProviderError("PROVIDER_CREDENTIALS", "caller credential resolver is required")
      const value = environment[parsed.environment]
      if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024)
        throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential is unavailable")
      return value
    },
  })
}

export function createCallerCredentialResolver(
  resolve: (reference: Extract<ProviderCredentialReference, { readonly kind: "caller" }>) => string | PromiseLike<string>,
): ProviderCredentialResolver {
  if (typeof resolve !== "function") throw new ProviderError("PROVIDER_CREDENTIALS", "credential resolver is invalid")
  return Object.freeze({
    async resolve(reference: ProviderCredentialReference): Promise<string> {
      const parsed = parseCredentialReference(reference)
      if (parsed.kind !== "caller")
        throw new ProviderError("PROVIDER_CREDENTIALS", "caller credential reference is required")
      let secret: string
      try {
        secret = await resolve(parsed)
      } catch {
        throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential resolver failed")
      }
      if (typeof secret !== "string" || secret.length === 0 || secret.length > 16 * 1024)
        throw new ProviderError("PROVIDER_CREDENTIALS", "provider credential is invalid")
      return secret
    },
  })
}

export function validateCredentialEnvironmentName(value: unknown): string {
  if (typeof value !== "string" || !ENV_NAME.test(value))
    throw new ProviderError("PROVIDER_CREDENTIALS", "credential environment name is invalid")
  return value
}

export function redactCredential(value: string): string {
  if (typeof value !== "string" || value.length === 0) return "[redacted]"
  return "[redacted]"
}

function boundedAccount(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw new ProviderError("PROVIDER_CREDENTIALS", "credential account is invalid")
  return value
}
