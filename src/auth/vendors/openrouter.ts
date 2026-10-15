import { createBrowserSignIn, type ExchangeInput } from "../flows.ts"
import { secretField, signInEndpoint, signInPost } from "../signin-http.ts"
import { SignInError, type SignInFlow } from "../signin-types.ts"
import type { StoredCredential } from "../vault.ts"

/**
 * Sign in with OpenRouter.
 *
 * OpenRouter's documented PKCE flow hands back an ordinary API key the user can see and revoke in
 * their OpenRouter settings. It does not expire and there is nothing to refresh, so the result is
 * stored exactly like a pasted key. OpenRouter returns no `state`; the callback path is random.
 */
const AUTHORIZE_URL = "https://openrouter.ai/auth"
const KEY_URL = "https://openrouter.ai/api/v1/auth/keys"

export interface OpenRouterSignInOverrides {
  readonly authorizeUrl?: string
  readonly keyUrl?: string
}

/** `overrides` point the flow at a test server. They are fixed when the engine starts; no control method can set them. */
export function createOpenRouterSignIn(overrides: OpenRouterSignInOverrides = {}): SignInFlow {
  const keyUrl = signInEndpoint(overrides.keyUrl ?? KEY_URL, "key address")

  async function exchange(input: ExchangeInput): Promise<StoredCredential> {
    const answer = await signInPost(keyUrl, { json: { code: input.code, code_verifier: input.verifier, code_challenge_method: "S256" } }, input.signal)
    if (answer.status >= 500) throw new SignInError("AUTH_NETWORK", "the sign-in service failed")
    if (answer.status < 200 || answer.status >= 300) throw new SignInError("AUTH_CODE_REJECTED", "the sign-in code was rejected")
    const key = secretField(answer.body?.key)
    if (key === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the sign-in answer carries no key")
    return Object.freeze({ kind: "api-key" as const, secret: key })
  }

  return createBrowserSignIn({
    id: "openrouter",
    label: "OpenRouter",
    preset: "openrouter",
    authMode: "api-key",
    timeoutMs: 5 * 60_000,
    authorizeUrl: overrides.authorizeUrl ?? AUTHORIZE_URL,
    callback: { port: 0, path: "/oauth/callback" },
    state: false,
    authorizeParams: (input) => ({ callback_url: input.redirectUri, code_challenge: input.challenge, code_challenge_method: "S256" }),
    exchange,
  })
}
