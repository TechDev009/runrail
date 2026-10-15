import { createDeviceCodeSignIn, createRefreshTokenRefresher, tokenCredential, type DeviceCodeTiming } from "../flows.ts"
import { SignInError, type SignInFlow } from "../signin-types.ts"
import type { StoredCredential } from "../vault.ts"

/**
 * Sign in with a Kimi Code plan.
 *
 * Unofficial. Kimi runs this device sign-in for its own command-line tool and does not document it
 * for other tools. Runrail presents that tool's public client id, because Kimi issues no other, and
 * names itself in `User-Agent` and `originator`. Kimi can refuse the sign-in or the token at any
 * time. The documented way in is a "Kimi for Coding" API key (preset `kimi-for-coding`).
 *
 * The token is sent as a Bearer token to `api.kimi.com/coding` over the Messages protocol, which is
 * why it has its own preset (`kimi-code`): the key row sends `x-api-key`.
 */
const DEVICE_URL = "https://auth.kimi.com/api/oauth/device_authorization"
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token"
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
const VERIFICATION_HOSTS = ["www.kimi.com"]
/** Kimi may leave the code's lifetime out; its codes last fifteen minutes. */
const CODE_LIFETIME_SECONDS = 15 * 60

export interface KimiSignInOverrides {
  readonly deviceUrl?: string
  readonly tokenUrl?: string
  readonly verificationHosts?: readonly string[]
  readonly timing?: DeviceCodeTiming
}

/** `overrides` point the flow at a test server. They are fixed when the engine starts; no control method can set them. */
export function createKimiSignIn(overrides: KimiSignInOverrides = {}): SignInFlow {
  const tokenUrl = overrides.tokenUrl ?? TOKEN_URL
  return createDeviceCodeSignIn({
    id: "kimi",
    label: "Kimi Code",
    preset: "kimi-code",
    authMode: "device",
    unofficial: true,
    deviceUrl: overrides.deviceUrl ?? DEVICE_URL,
    tokenUrl,
    clientId: CLIENT_ID,
    verificationHosts: overrides.verificationHosts ?? VERIFICATION_HOSTS,
    defaultExpiresIn: CODE_LIFETIME_SECONDS,
    credential(body, now): StoredCredential {
      const credential = tokenCredential(body, now)
      if (credential.refresh === undefined || credential.expiresAt === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the sign-in answer is incomplete")
      return credential
    },
    // Kimi answers a dead sign-in with 401 or 403 as well as with `invalid_grant`.
    refresher: createRefreshTokenRefresher({ tokenUrl, clientId: CLIENT_ID, rejectedStatuses: [401, 403] }),
  }, overrides.timing)
}
