import { createBrowserSignIn, createRefreshTokenRefresher, tokenCredential, type ExchangeInput } from "../flows.ts"
import { oauthErrorWord, secretField, signInEndpoint, signInPost } from "../signin-http.ts"
import { SignInError, type SignInFlow } from "../signin-types.ts"
import type { StoredCredential } from "../vault.ts"

/**
 * Sign in with a ChatGPT plan.
 *
 * OpenAI's agent sign-in: a public client with PKCE and no client secret. Runrail names itself in
 * `agent_name_hint`; OpenAI issues a client id for this installation and returns it with the code.
 * That id is needed again for every refresh, so it is stored next to the tokens. The access token
 * is then used like an API key against `api.openai.com`.
 */
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize"
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
const RESOURCE = "https://api.openai.com/v1"
const CALLBACK_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
/** Without this grant the token cannot call the API directly, so the sign-in is of no use. */
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct"

export interface ChatGptSignInOverrides {
  readonly authorizeUrl?: string
  readonly tokenUrl?: string
  readonly callbackPort?: number
}

/**
 * `overrides` point the flow at a test server. They are fixed when the engine starts; no control
 * method can set them.
 */
/** Clock difference allowed between this computer and the sign-in service. */
const CLOCK_SKEW_MS = 5 * 60_000

/**
 * The id token's claims, checked as OpenID Connect asks: this service issued it, for this client,
 * for this sign-in, and it has not expired. It came straight from the token address over TLS, which
 * OpenID Connect accepts in place of checking its signature (Core 1.0, 3.1.3.7). It is not used for identity.
 */
function checkIdToken(token: string, expected: { readonly issuer: string; readonly clientId: string; readonly nonce: string; readonly now: number }): void {
  const invalid = (what: string): never => {
    throw new SignInError("AUTH_RESPONSE_INVALID", `the sign-in's id token ${what}`)
  }
  const parts = token.split(".")
  if (parts.length !== 3) invalid("is not a JSON web token")
  let claims: Record<string, unknown>
  try {
    const value = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object")
    claims = value as Record<string, unknown>
  } catch {
    return invalid("cannot be read")
  }
  if (claims.iss !== expected.issuer) invalid("was issued by another service")
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(expected.clientId)) invalid("is for another client")
  if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS <= expected.now) invalid("has expired")
  if (claims.nonce !== expected.nonce) invalid("belongs to another sign-in")
}

export function createChatGptSignIn(overrides: ChatGptSignInOverrides = {}): SignInFlow {
  const tokenUrl = signInEndpoint(overrides.tokenUrl ?? TOKEN_URL, "token address")

  async function exchange(input: ExchangeInput): Promise<StoredCredential> {
    const clientId = input.redirect.client_id
    if (clientId === undefined || clientId.length > 256) throw new SignInError("AUTH_RESPONSE_INVALID", "the sign-in returned no usable client id")
    const answer = await signInPost(tokenUrl, { form: { grant_type: "authorization_code", client_id: clientId, code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri, resource: RESOURCE } }, input.signal)
    if (answer.status < 200 || answer.status >= 300 || answer.body === undefined) {
      if (answer.status >= 500) throw new SignInError("AUTH_NETWORK", "the sign-in service failed")
      throw new SignInError("AUTH_CODE_REJECTED", oauthErrorWord(answer.body) === "invalid_grant" ? "the sign-in code is no longer valid" : "the sign-in code was rejected")
    }
    const credential = tokenCredential(answer.body, input.now)
    const idToken = secretField(answer.body.id_token)
    if (credential.refresh === undefined || credential.expiresAt === undefined || credential.scopes === undefined || idToken === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the sign-in answer is incomplete")
    checkIdToken(idToken, { issuer: tokenUrl.origin, clientId, nonce: input.nonce, now: input.now })
    if (!credential.scopes.includes(REQUIRED_SCOPE)) throw new SignInError("AUTH_SCOPE_MISSING", "this ChatGPT account did not grant direct API use")
    return Object.freeze({ ...credential, clientId })
  }

  return createBrowserSignIn({
    id: "chatgpt",
    label: "ChatGPT",
    preset: "openai",
    authMode: "oauth",
    authorizeUrl: overrides.authorizeUrl ?? AUTHORIZE_URL,
    callback: { port: overrides.callbackPort ?? CALLBACK_PORT, path: CALLBACK_PATH },
    state: true,
    redirectParams: ["client_id"],
    authorizeParams: (input) => ({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Runrail",
      ext_agent_host_id: `urn:uuid:${input.installationId}`,
      response_type: "code",
      redirect_uri: input.redirectUri,
      resource: RESOURCE,
      scope: SCOPE,
      state: input.state ?? "",
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      nonce: input.nonce,
    }),
    exchange,
    refresher: createRefreshTokenRefresher({ tokenUrl: tokenUrl.toString(), params: { resource: RESOURCE } }),
  })
}
