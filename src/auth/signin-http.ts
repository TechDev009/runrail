import { RUNRAIL_USER_AGENT } from "../providers/http.ts"
import { SignInError } from "./signin-types.ts"

const MAX_SIGN_IN_RESPONSE_BYTES = 256 * 1024
const DEFAULT_SIGN_IN_REQUEST_MS = 30_000

export interface SignInResponse {
  readonly status: number
  /** The parsed JSON object, or `undefined` when the answer is not one. */
  readonly body: Record<string, unknown> | undefined
}

export type SignInRequestBody = { readonly form: Readonly<Record<string, string>> } | { readonly json: Readonly<Record<string, unknown>> }

/** `https`, or plain `http` to this machine only (a test server). Anything else is refused when a flow is built. */
export function signInEndpoint(value: string, what: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SignInError("AUTH_INVALID", `${what} is not a URL`)
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0 || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new SignInError("AUTH_INVALID", `${what} must be an https address`)
  return url
}

const SIGN_IN_HEADER_NAME = /^[a-z][a-z0-9-]{0,63}$/
const FIXED_SIGN_IN_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "user-agent", "originator", "host", "cookie"])

/**
 * One POST to a vendor's sign-in endpoint. Runrail names itself, follows no redirect, and reads a
 * bounded answer. A failure says what kind it was and never repeats what the vendor sent.
 *
 * `headers` are the few a vendor's exchange step needs (a bearer token, an API version). They can
 * add to the request; they cannot replace how Runrail names itself.
 */
export async function signInPost(endpoint: URL, body: SignInRequestBody, signal: AbortSignal, timeoutMs: number = DEFAULT_SIGN_IN_REQUEST_MS, headers: Readonly<Record<string, string>> = {}): Promise<SignInResponse> {
  for (const [name, value] of Object.entries(headers)) {
    if (!SIGN_IN_HEADER_NAME.test(name) || FIXED_SIGN_IN_HEADERS.has(name) || typeof value !== "string" || value.length === 0 || value.length > 17 * 1024 || /[\0-\x1f\x7f]/.test(value)) throw new SignInError("AUTH_INVALID", "sign-in request header is invalid")
  }
  if (signal.aborted) throw new SignInError("AUTH_CANCELLED", "sign-in was cancelled")
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
  let bytes: Uint8Array
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.any([signal, timeout]),
      headers: {
        ...headers,
        accept: "application/json",
        "content-type": "form" in body ? "application/x-www-form-urlencoded" : "application/json",
        "user-agent": RUNRAIL_USER_AGENT,
        originator: "runrail",
      },
      body: "form" in body ? new URLSearchParams(body.form).toString() : JSON.stringify(body.json),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      throw new SignInError("AUTH_RESPONSE_INVALID", "sign-in endpoint answered with a redirect")
    }
    bytes = await readBounded(response)
  } catch (error) {
    if (error instanceof SignInError) throw error
    if (signal.aborted) throw new SignInError("AUTH_CANCELLED", "sign-in was cancelled")
    throw new SignInError("AUTH_NETWORK", timeout.aborted ? "sign-in endpoint did not answer in time" : "sign-in endpoint cannot be reached")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    parsed = undefined
  }
  return { status: response.status, body: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined }
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_SIGN_IN_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new SignInError("AUTH_RESPONSE_INVALID", "sign-in endpoint answer is too large")
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** A token, code, or key from a vendor answer: one line of printable text within the vault's size limit. */
export function secretField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 16 * 1024 && !/[\0-\x1f\x7f]/.test(value) ? value : undefined
}

/** The vendor's `error` word from a failed token call, when it is a plain short token. Never the description. */
export function oauthErrorWord(body: Record<string, unknown> | undefined): string | undefined {
  const word = body?.error
  return typeof word === "string" && /^[a-z_]{1,64}$/.test(word) ? word : undefined
}
