import type { CredentialRefresher } from "./broker.ts"
import type { StoredCredential } from "./vault.ts"

/** Stable codes for a sign-in that did not finish. None carries a token, a code, or a vendor message. */
export type SignInErrorCode =
  | "AUTH_INVALID"
  | "AUTH_FLOW_UNKNOWN"
  | "AUTH_LOGIN_NOT_FOUND"
  | "AUTH_LOGIN_FINISHED"
  | "AUTH_LIMIT"
  | "AUTH_ACCOUNT_MISMATCH"
  | "AUTH_UNAVAILABLE"
  /** The server offers no sign-in Runrail can take part in (no PKCE). */
  | "AUTH_UNSUPPORTED"
  /** The authorization server registers no apps; one the person registered there must be named first. */
  | "AUTH_CLIENT_REQUIRED"
  | "AUTH_CANCELLED"
  | "AUTH_TIMEOUT"
  | "AUTH_DENIED"
  | "AUTH_EXPIRED"
  | "AUTH_STATE_MISMATCH"
  | "AUTH_INPUT_INVALID"
  | "AUTH_CODE_REJECTED"
  | "AUTH_SCOPE_MISSING"
  | "AUTH_RESPONSE_INVALID"
  | "AUTH_NETWORK"
  | "AUTH_STORE_FAILED"
  | "AUTH_FAILED"

export class SignInError extends Error {
  constructor(readonly code: SignInErrorCode, reason: string) {
    super(`${code}: ${reason.slice(0, 256).replace(/[\r\n\0]/g, " ")}`)
    this.name = "SignInError"
  }
}

/** Why the browser cannot be sent back to Runrail by itself; the user pastes the address they landed on instead. */
export type SignInNotice = "AUTH_PORT_BUSY" | "AUTH_LISTENER_FAILED"

/** What a running sign-in tells its client. No variant carries a token or an authorization code. */
export type SignInProgress =
  | {
      readonly type: "open-url"
      /** The vendor page to open. Its host is one of the flow's `browserHosts`. */
      readonly url: string
      /** `loopback`: the browser returns to Runrail by itself. `manual`: the user pastes the address they land on. */
      readonly redirect: "loopback" | "manual"
      readonly notice?: SignInNotice
    }
  | {
      readonly type: "device-code"
      readonly userCode: string
      readonly verificationUrl: string
      readonly expiresAt: number
    }
  /** The user has finished on the vendor's side; Runrail is fetching the tokens. */
  | { readonly type: "finishing" }

/** What a flow can see of the sign-in it runs in. */
export interface SignInSession {
  /** Aborts on cancel, timeout, and engine shutdown. */
  readonly signal: AbortSignal
  now(): number
  emit(progress: SignInProgress): void
  /** A random id kept for this installation. Not a secret; vendors use it to tell installations apart. */
  installationId(): Promise<string>
  /**
   * Registers the reader for what the user pastes. The reader throws a `SignInError` for input it
   * cannot use; the sign-in keeps waiting.
   */
  acceptManualInput(reader: (input: string) => void): void
}

/** One way to sign in. Addresses are fixed when the flow is built; nothing a client sends can change them. */
export interface SignInFlow {
  /** What `auth.login.start` names, e.g. `chatgpt`. */
  readonly id: string
  readonly label: string
  /** The provider preset the stored credential is used with. */
  readonly preset: string
  /** How the account that holds the result is marked. `api-key` when the vendor hands back a lasting key. */
  readonly authMode: "oauth" | "device" | "api-key"
  readonly kind: "browser" | "device-code"
  /** The only hosts a browser may be sent to for this flow. */
  readonly browserHosts: readonly string[]
  /** True when the vendor does not document this sign-in for third-party tools. */
  readonly unofficial: boolean
  /** How long the user has. Capped at ten minutes. */
  readonly timeoutMs?: number
  run(session: SignInSession): Promise<StoredCredential>
  /** Renews the stored tokens. Absent when the result never expires. */
  readonly refresher?: CredentialRefresher
}

export const MAX_SIGN_IN_MS = 10 * 60_000
