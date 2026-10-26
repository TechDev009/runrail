import { AccountError, resolveConnection, type AccountRecord, type AccountStore, type ResolvedConnection } from "./accounts/index.ts"
import { CredentialStoreError } from "./auth/broker.ts"
import { ProviderError } from "./providers/errors.ts"
import { parseImageModels, type ImageModel } from "./images/models.ts"
import { parseEmbeddingModels, type EmbeddingModel } from "./memory/embeddings.ts"
import { fetchModelListAnswer, parseModelList, type ListedModel } from "./providers/model-list.ts"
import type { ProviderCredentialResolver } from "./providers/types.ts"

/** What one model-list call against a connection found. Stable: clients and scripts match on it. */
export type ConnectionCheckCode =
  | "OK"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNREACHABLE"
  | "SERVER_ERROR"
  | "REJECTED"
  | "ENDPOINT_DENIED"
  | "CREDENTIAL_MISSING"
  | "SIGN_IN_EXPIRED"
  | "SIGN_IN_FAILED"
  | "NO_MODEL_LIST"
  | "INVALID_RESPONSE"

/** `unverified`: a credential is there, but this call could not show that it works. */
export type ConnectionCheckStatus = "ok" | "unverified" | "failed"

export interface ConnectionCheck {
  readonly connection: ResolvedConnection
  readonly models?: readonly ListedModel[]
  /** The image generators the same list names. */
  readonly images?: readonly ImageModel[]
  /** The embedding models the same list names. */
  readonly embeddings?: readonly EmbeddingModel[]
  readonly code: ConnectionCheckCode
  /** The provider's HTTP status, when it answered with one that was not a success. */
  readonly httpStatus?: number
}

export interface ConnectionCheckOptions {
  /** How a record becomes a connection; a caller with its own error shapes wraps `resolveConnection`. */
  readonly resolve?: (record: AccountRecord, resolver: ProviderCredentialResolver) => ResolvedConnection
  /** Retries of the list call after a transient failure. Default: the list call's own (one). */
  readonly maxRetries?: number
}

/**
 * One model-list call against a connection. Answers both "which models" and "does this key work"
 * without spending tokens, and changes nothing on the account. A credential store that fails is
 * thrown as it is; every other outcome is a code.
 */
export async function checkConnection(record: AccountRecord, credentialResolver: ProviderCredentialResolver, options: ConnectionCheckOptions = {}): Promise<ConnectionCheck> {
  let credentialFailure: unknown
  const resolver: ProviderCredentialResolver = {
    resolve: async (reference) => {
      try {
        return await credentialResolver.resolve(reference)
      } catch (error) {
        credentialFailure = error
        throw error
      }
    },
  }
  const connection = (options.resolve ?? resolveConnection)(record, resolver)
  try {
    if (connection.modelList === "none") {
      // No list to ask for; still say whether a credential is there at all.
      await resolver.resolve(connection.options.credential)
      return { connection, code: "NO_MODEL_LIST" }
    }
    const answer = await fetchModelListAnswer(options.maxRetries === undefined ? connection.options : { ...connection.options, maxRetries: options.maxRetries })
    const models = parseModelList(answer)
    return { connection, models, images: parseImageModels(answer, connection), embeddings: parseEmbeddingModels(answer, connection), code: "OK" }
  } catch (error) {
    if (credentialFailure instanceof CredentialStoreError) throw credentialFailure
    if (credentialFailure !== undefined) return { connection, code: credentialCheckCode(credentialFailure) }
    const httpStatus = error instanceof ProviderError ? error.status : undefined
    return { connection, code: providerCheckCode(error), ...(httpStatus === undefined ? {} : { httpStatus }) }
  }
}

export function connectionCheckStatus(code: ConnectionCheckCode): ConnectionCheckStatus {
  if (code === "OK") return "ok"
  return code === "RATE_LIMITED" || code === "NO_MODEL_LIST" || code === "INVALID_RESPONSE" ? "unverified" : "failed"
}

function credentialCheckCode(error: unknown): ConnectionCheckCode {
  if (!(error instanceof AccountError)) return "CREDENTIAL_MISSING"
  if (error.code === "ACCOUNT_EXPIRED") return "SIGN_IN_EXPIRED"
  if (error.code === "ACCOUNT_AUTH_FAILED") return "SIGN_IN_FAILED"
  return "CREDENTIAL_MISSING"
}

function providerCheckCode(error: unknown): ConnectionCheckCode {
  if (!(error instanceof ProviderError)) throw error
  switch (error.code) {
    case "PROVIDER_AUTH_FAILED": return "AUTH_FAILED"
    case "PROVIDER_RATE_LIMITED": return "RATE_LIMITED"
    case "PROVIDER_TIMEOUT": return "TIMEOUT"
    case "PROVIDER_ENDPOINT_DENIED": return "ENDPOINT_DENIED"
    case "PROVIDER_RESPONSE_INVALID": return "INVALID_RESPONSE"
    case "PROVIDER_CREDENTIALS": return "CREDENTIAL_MISSING"
    case "PROVIDER_FAILED":
      if (error.status === undefined) return "UNREACHABLE"
      if (error.status === 404 || error.status === 405) return "NO_MODEL_LIST"
      return error.status >= 500 ? "SERVER_ERROR" : "REJECTED"
    default: return "REJECTED"
  }
}

// ---------------------------------------------------------------------------------------------
// runrail auth doctor

export interface AuthDoctorOptions {
  readonly connectionId: string
  readonly json: boolean
}

export interface AuthDoctorHost {
  readonly accounts: AccountStore
  readonly credentialResolver: ProviderCredentialResolver
  /** The result: one line. In `--json` mode it is one JSON object. */
  out(line: string): void
  /** What the result means, for a person. */
  note(line: string): void
}

export const AUTH_DOCTOR_USAGE = "usage: runrail auth doctor <connection> [--json] [--accounts-dir <path>] [--credential-vault keychain|file|none]"

const MEANING: Readonly<Record<ConnectionCheckCode, string>> = {
  OK: "The provider accepted the key or sign-in.",
  AUTH_FAILED: "The provider refused the key or sign-in.",
  RATE_LIMITED: "The provider is rate limiting this account; the key or sign-in was not checked.",
  TIMEOUT: "The provider did not answer in time.",
  UNREACHABLE: "The provider could not be reached.",
  SERVER_ERROR: "The provider failed on its side.",
  REJECTED: "The provider refused the request.",
  ENDPOINT_DENIED: "The connection's address is not allowed.",
  CREDENTIAL_MISSING: "No key or sign-in is stored for this connection.",
  SIGN_IN_EXPIRED: "The sign-in has run out. Sign in again.",
  SIGN_IN_FAILED: "The sign-in could not be renewed.",
  NO_MODEL_LIST: "A key or sign-in is stored, but this provider has no model list to check it against.",
  INVALID_RESPONSE: "The provider answered with something that could not be read.",
}

/**
 * Checks one connection with a single model-list request (no retry; a sign-in that is due is
 * renewed first). Prints the connection, a status, a stable code, and the provider's HTTP status
 * when it refused: never a key, a token, a model name, or anything the provider sent back.
 * Exit codes: 0 works, 1 does not, 2 the request itself was refused, 3 could not tell.
 */
export async function runAuthDoctor(options: AuthDoctorOptions, host: AuthDoctorHost): Promise<number> {
  const refuse = (code: string, message: string): number => {
    if (options.json) host.out(JSON.stringify({ connectionId: options.connectionId, status: "failed", code }))
    else host.note(`${message} (${code})`)
    return 2
  }
  const record = await host.accounts.get(options.connectionId)
  if (record === undefined || record.status === "revoked") return refuse("CONNECTION_NOT_FOUND", "connection was not found")
  let check: ConnectionCheck
  try {
    check = await checkConnection(record, host.credentialResolver, { maxRetries: 0 })
  } catch (error) {
    if (error instanceof ProviderError) return refuse(error.code === "PROVIDER_ENDPOINT_DENIED" ? "ENDPOINT_DENIED" : "CONNECTION_INVALID", "this connection cannot be used as it is stored")
    if (error instanceof CredentialStoreError) {
      if (options.json) host.out(JSON.stringify({ connectionId: options.connectionId, status: "failed", code: error.code }))
      else host.note(`The credential store could not be read. (${error.code})`)
      return 1
    }
    if (error instanceof AccountError) return refuse("CONNECTION_INVALID", "this connection cannot be used as it is stored")
    throw error
  }
  const status = connectionCheckStatus(check.code)
  const modelCount = check.models?.length
  if (options.json) {
    host.out(JSON.stringify({ connectionId: check.connection.connectionId, status, code: check.code, ...(check.httpStatus === undefined ? {} : { httpStatus: check.httpStatus }), ...(modelCount === undefined ? {} : { modelCount }) }))
  } else {
    host.out([check.connection.connectionId, status, check.code, check.httpStatus === undefined ? "-" : String(check.httpStatus), modelCount === undefined ? "-" : `${modelCount} models`].join("\t"))
    host.note(MEANING[check.code])
  }
  return status === "ok" ? 0 : status === "unverified" ? 3 : 1
}
