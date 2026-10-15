import { CredentialRefreshError, type CredentialRefresher } from "../broker.ts"
import { createDeviceCodeSignIn, type DeviceCodeTiming } from "../flows.ts"
import { secretField, signInEndpoint, signInPost } from "../signin-http.ts"
import { SignInError, type SignInFlow } from "../signin-types.ts"
import type { OAuthCredential } from "../vault.ts"

/**
 * Sign in with a Meta AI plan.
 *
 * Unofficial. Meta runs this device sign-in for its own command-line tool and does not document it
 * for other tools. Runrail presents that tool's public client id, because Meta issues no other, and
 * names itself in `User-Agent` and `originator`. Meta can refuse the sign-in or the key at any
 * time. The documented way in is a Meta API key (preset `meta`, shell variable `META_API_KEY`).
 *
 * Meta keeps identity and API access apart. The device sign-in ends in an identity token that no
 * model call accepts; it is exchanged for a Model API key that lasts about a day. The key is stored
 * as the access token and the identity token as the refresh token, so renewing is the same
 * exchange again. The identity token itself cannot be renewed: once Meta refuses it, the user
 * signs in again.
 */
const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/"
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/"
const KEY_URL = "https://api.meta.ai/muse-code/key"
const CLIENT_ID = "1031625952748946"
const VERIFICATION_HOSTS = ["auth.meta.com"]
const CODE_LIFETIME_SECONDS = 15 * 60
const KEY_LIFETIME_MS = 24 * 3_600_000
const KEY_API_VERSION = "1.0.0"

export interface MetaSignInOverrides {
  readonly deviceUrl?: string
  readonly tokenUrl?: string
  readonly keyUrl?: string
  readonly verificationHosts?: readonly string[]
  readonly timing?: DeviceCodeTiming
  readonly now?: () => number
}

type KeyAnswer = { readonly key: string } | { readonly failure: "rejected" | "no-key" | "unavailable" }

/** `overrides` point the flow at a test server. They are fixed when the engine starts; no control method can set them. */
export function createMetaSignIn(overrides: MetaSignInOverrides = {}): SignInFlow {
  const keyUrl = signInEndpoint(overrides.keyUrl ?? KEY_URL, "key address")
  const clock = overrides.now ?? Date.now

  async function exchange(identity: string, signal: AbortSignal): Promise<KeyAnswer> {
    const answer = await signInPost(keyUrl, { json: {} }, signal, undefined, { authorization: `Bearer ${identity}`, "x-api-version": KEY_API_VERSION })
    if (answer.status === 401 || answer.status === 403) return { failure: "rejected" }
    if (answer.status < 200 || answer.status >= 300) return { failure: "unavailable" }
    const key = secretField(answer.body?.api_key)
    // Signed in, but the account has no Model API access yet (Meta asks for a setup step on its side).
    return key === undefined ? { failure: "no-key" } : { key }
  }

  const refresher: CredentialRefresher = Object.freeze({
    async refresh(credential: OAuthCredential, _reference: unknown, signal: AbortSignal): Promise<OAuthCredential> {
      if (credential.refresh === undefined) throw new CredentialRefreshError("invalid_grant", "the stored sign-in cannot be renewed")
      let answer: KeyAnswer
      try {
        answer = await exchange(credential.refresh, signal)
      } catch {
        throw new CredentialRefreshError("transient", "the sign-in service cannot be reached")
      }
      if ("key" in answer) return Object.freeze({ kind: "oauth" as const, access: answer.key, expiresAt: clock() + KEY_LIFETIME_MS })
      // No key for a signed-in account is not something waiting fixes; signing in again says why.
      if (answer.failure === "unavailable") throw new CredentialRefreshError("transient", "the sign-in service failed")
      throw new CredentialRefreshError("invalid_grant", "the sign-in is no longer accepted")
    },
  })

  return createDeviceCodeSignIn({
    id: "meta",
    label: "Meta AI (plan)",
    preset: "meta",
    authMode: "device",
    unofficial: true,
    deviceUrl: overrides.deviceUrl ?? DEVICE_URL,
    tokenUrl: overrides.tokenUrl ?? TOKEN_URL,
    clientId: CLIENT_ID,
    verificationHosts: overrides.verificationHosts ?? VERIFICATION_HOSTS,
    defaultExpiresIn: CODE_LIFETIME_SECONDS,
    async credential(body, now, signal): Promise<OAuthCredential> {
      const identity = secretField(body.access_token)
      if (identity === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the sign-in answer carries no token")
      const answer = await exchange(identity, signal)
      if ("key" in answer) return Object.freeze({ kind: "oauth" as const, access: answer.key, refresh: identity, expiresAt: now + KEY_LIFETIME_MS })
      if (answer.failure === "no-key") throw new SignInError("AUTH_SCOPE_MISSING", "this Meta account has no Model API access")
      if (answer.failure === "rejected") throw new SignInError("AUTH_CODE_REJECTED", "the sign-in was rejected")
      throw new SignInError("AUTH_NETWORK", "the sign-in service failed")
    },
    refresher,
  }, overrides.timing)
}
