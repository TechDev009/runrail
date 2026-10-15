import { createDeviceCodeSignIn, createRefreshTokenRefresher, tokenCredential, type DeviceCodeTiming } from "../flows.ts"
import { SignInError, type SignInFlow } from "../signin-types.ts"
import type { StoredCredential } from "../vault.ts"

/**
 * Sign in with an xAI plan (SuperGrok or X Premium).
 *
 * Unofficial. xAI runs this device sign-in for its own command-line tool and does not document it
 * for other tools. Runrail presents that tool's public client id, because xAI issues no other, and
 * names itself everywhere a name is asked for: `referrer`, `User-Agent`, and `originator`. xAI can
 * refuse the sign-in or the token at any time. The token is used against `api.x.ai` over the
 * Responses protocol (preset `xai-grok`); a pasted xAI API key keeps its own `xai` row.
 */
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"
const VERIFICATION_HOSTS = ["accounts.x.ai"]
/** xAI may leave the lifetime out; its tokens last an hour. */
const TOKEN_LIFETIME_SECONDS = 3_600

export interface XaiSignInOverrides {
  readonly deviceUrl?: string
  readonly tokenUrl?: string
  readonly verificationHosts?: readonly string[]
  readonly timing?: DeviceCodeTiming
}

/** `overrides` point the flow at a test server. They are fixed when the engine starts; no control method can set them. */
export function createXaiSignIn(overrides: XaiSignInOverrides = {}): SignInFlow {
  const tokenUrl = overrides.tokenUrl ?? TOKEN_URL
  return createDeviceCodeSignIn({
    id: "xai",
    label: "xAI (Grok plan)",
    preset: "xai-grok",
    authMode: "device",
    unofficial: true,
    deviceUrl: overrides.deviceUrl ?? DEVICE_URL,
    tokenUrl,
    clientId: CLIENT_ID,
    scope: SCOPE,
    deviceParams: { referrer: "runrail" },
    verificationHosts: overrides.verificationHosts ?? VERIFICATION_HOSTS,
    deniedWords: ["authorization_denied"],
    credential(body, now): StoredCredential {
      const credential = tokenCredential(body, now, TOKEN_LIFETIME_SECONDS)
      // Without a refresh token the sign-in would end within the hour.
      if (credential.refresh === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the sign-in answer is incomplete")
      return credential
    },
    // xAI does not always rotate the refresh token; the credential broker keeps the one in hand.
    refresher: createRefreshTokenRefresher({ tokenUrl, clientId: CLIENT_ID, defaultExpiresIn: TOKEN_LIFETIME_SECONDS }),
  }, overrides.timing)
}
