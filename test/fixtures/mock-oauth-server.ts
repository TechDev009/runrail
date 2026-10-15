import { createHash, randomUUID } from "node:crypto"

/**
 * A stand-in for a vendor's sign-in service, on this machine only.
 *
 * It speaks four dialects: the authorization-code flow with PKCE (`/authorize`, `/token`), the
 * device-code flow (`/device`, `/token`), the OpenRouter-style key exchange (`/auth`,
 * `/api/v1/auth/keys`), and the exchange of an identity token for a short-lived key
 * (`/muse-code/key`). Every token it hands out contains `CANARY`, so a test can search any output
 * for a leak. Tests steer it through `plan` and read what it saw from `requests`.
 */
export const CANARY = "canary-9d41c7e2b6a0"

export interface MockOAuthRequest {
  readonly method: string
  readonly path: string
  readonly userAgent: string | null
  readonly originator: string | null
  /** The `Authorization` header, for the one call that carries a token there. */
  readonly authorization: string | null
  readonly apiVersion: string | null
  readonly at: number
  /** Form or JSON fields of a POST; query fields of a GET. */
  readonly fields: Readonly<Record<string, string>>
}

export interface MockOAuthPlan {
  /** What `/authorize` sends the browser back with. */
  authorize: "grant" | "denied" | "wrong-state" | "no-client-id"
  /** How `/token` answers an authorization code. */
  token: "grant" | "expired-code" | "missing-scope" | "missing-id-token" | "server-error"
  /** What the id token of a granted code says wrongly, if anything. */
  idToken: "valid" | "other-issuer" | "other-audience" | "expired" | "other-nonce" | "not-a-jwt"
  /**
   * How `/token` answers a refresh. `no-rotation`: a new access token only, no refresh token and
   * no lifetime, and the old refresh token keeps working. `unauthorized`: 401 with no error word.
   */
  refresh: "grant" | "server-error" | "no-rotation" | "unauthorized"
  /** Answers to device polls, first to last. When empty the poll is granted. */
  device: ("authorization_pending" | "slow_down" | "slow_down-named" | "access_denied" | "authorization_denied" | "expired_token")[]
  /** Seconds the device code lives (`undefined`: the service names none) and the wait it names. */
  deviceExpiresIn: number | undefined
  deviceInterval: number | undefined
  /** What a granted device poll carries. `identity`: one token and nothing else. `no-refresh`: no refresh token. */
  deviceGrant: "tokens" | "identity" | "no-refresh"
  /** How `/muse-code/key` answers an identity token. */
  mint: "grant" | "unauthorized" | "no-key" | "server-error"
  /** How `/api/v1/auth/keys` answers. */
  key: "grant" | "rejected" | "no-key"
}

export interface MockOAuthServer {
  readonly origin: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly deviceUrl: string
  readonly keyAuthorizeUrl: string
  readonly keyUrl: string
  readonly mintUrl: string
  readonly plan: MockOAuthPlan
  readonly requests: MockOAuthRequest[]
  /** Every access token, refresh token and key handed out so far. */
  readonly issued: string[]
  /** Plays the browser: opens the sign-in page and returns the address the vendor sends it back to. */
  approve(url: string): Promise<string>
  /** `approve`, then follows the redirect the way a browser would. */
  visit(url: string): Promise<Response>
  stop(): Promise<void>
}

const FULL_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"

export function startMockOAuthServer(): MockOAuthServer {
  const plan: MockOAuthPlan = { authorize: "grant", token: "grant", idToken: "valid", refresh: "grant", device: [], deviceExpiresIn: 600, deviceInterval: undefined, deviceGrant: "tokens", mint: "grant", key: "grant" }
  const requests: MockOAuthRequest[] = []
  const issued: string[] = []
  const codes = new Map<string, { readonly challenge: string; readonly redirectUri: string; readonly clientId?: string; readonly nonce?: string; used: boolean }>()
  const refreshTokens = new Map<string, { readonly clientId: string; used: boolean }>()
  const deviceCodes = new Set<string>()
  const identities = new Set<string>()
  let counter = 0

  const mint = (kind: string): string => {
    counter += 1
    const value = `${kind}-${CANARY}-${counter}-${randomUUID()}`
    issued.push(value)
    return value
  }
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  // Unsigned: the client checks the claims of a token it took straight from `/token`, not a signature.
  const idTokenFor = (clientId: string, nonce: string | undefined): string => {
    if (plan.idToken === "not-a-jwt") return `id-${CANARY}-${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: plan.idToken === "other-issuer" ? "https://issuer.example.invalid" : origin,
      aud: [plan.idToken === "other-audience" ? "someone-else" : clientId],
      sub: "user-1",
      iat: now,
      exp: plan.idToken === "expired" ? now - 3_600 : now + 3_600,
      ...(nonce === undefined ? {} : { nonce: plan.idToken === "other-nonce" ? "another-sign-in" : nonce }),
    }
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url")
    return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.sig-${CANARY}`
  }
  const tokens = (clientId: string, scope: string = FULL_SCOPE, idToken = true, nonce?: string): Response => {
    const refresh = mint("refresh")
    refreshTokens.set(refresh, { clientId, used: false })
    return json({ access_token: mint("access"), refresh_token: refresh, token_type: "Bearer", expires_in: 3_600, scope, ...(idToken ? { id_token: idTokenFor(clientId, nonce) } : {}) })
  }

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      let fields: Record<string, string> = Object.fromEntries(url.searchParams)
      if (request.method === "POST") {
        const text = await request.text()
        if ((request.headers.get("content-type") ?? "").includes("json")) {
          const parsed = JSON.parse(text) as Record<string, unknown>
          fields = Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)]))
        } else fields = Object.fromEntries(new URLSearchParams(text))
      }
      requests.push({ method: request.method, path: url.pathname, userAgent: request.headers.get("user-agent"), originator: request.headers.get("originator"), authorization: request.headers.get("authorization"), apiVersion: request.headers.get("x-api-version"), at: Date.now(), fields })

      if (request.method === "GET" && url.pathname === "/authorize") {
        const back = new URL(fields.redirect_uri ?? "")
        const state = fields.state ?? ""
        if (plan.authorize === "denied") {
          back.searchParams.set("error", "access_denied")
          back.searchParams.set("state", state)
          return Response.redirect(back.toString(), 302)
        }
        const clientId = `issued-${randomUUID()}`
        const code = `code-${CANARY}-${randomUUID()}`
        codes.set(code, { challenge: fields.code_challenge ?? "", redirectUri: fields.redirect_uri ?? "", clientId, ...(fields.nonce === undefined ? {} : { nonce: fields.nonce }), used: false })
        back.searchParams.set("code", code)
        back.searchParams.set("state", plan.authorize === "wrong-state" ? "someone-elses-state" : state)
        if (plan.authorize !== "no-client-id") back.searchParams.set("client_id", clientId)
        return Response.redirect(back.toString(), 302)
      }

      if (request.method === "POST" && url.pathname === "/token") {
        if (fields.grant_type === "authorization_code") {
          if (plan.token === "server-error") return json({ error: "server_error" }, 503)
          const entry = codes.get(fields.code ?? "")
          const verified = entry !== undefined && createHash("sha256").update(fields.code_verifier ?? "").digest("base64url") === entry.challenge
          if (plan.token === "expired-code" || entry === undefined || entry.used || !verified || entry.redirectUri !== fields.redirect_uri || entry.clientId !== fields.client_id) return json({ error: "invalid_grant", error_description: `secret detail ${CANARY}` }, 400)
          entry.used = true
          return tokens(entry.clientId ?? "", plan.token === "missing-scope" ? "openid profile email offline_access" : FULL_SCOPE, plan.token !== "missing-id-token", entry.nonce)
        }
        if (fields.grant_type === "refresh_token") {
          if (plan.refresh === "server-error") return json({ error: "server_error" }, 503)
          if (plan.refresh === "unauthorized") return json({ message: `secret detail ${CANARY}` }, 401)
          const entry = refreshTokens.get(fields.refresh_token ?? "")
          // A refresh token works once; a second use is what a stolen copy would look like.
          if (entry === undefined || entry.used || entry.clientId !== fields.client_id) return json({ error: "invalid_grant" }, 400)
          if (plan.refresh === "no-rotation") return json({ access_token: mint("access"), token_type: "Bearer" })
          entry.used = true
          return tokens(entry.clientId)
        }
        if (fields.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
          if (!deviceCodes.has(fields.device_code ?? "")) return json({ error: "invalid_grant" }, 400)
          const next = plan.device.shift()
          if (next === undefined) {
            deviceCodes.delete(fields.device_code ?? "")
            if (plan.deviceGrant === "identity") {
              const identity = mint("identity")
              identities.add(identity)
              return json({ access_token: identity, token_type: "Bearer" })
            }
            if (plan.deviceGrant === "no-refresh") return json({ access_token: mint("access"), token_type: "Bearer", expires_in: 3_600 })
            return tokens(fields.client_id ?? "")
          }
          if (next === "slow_down-named") return json({ error: "slow_down", interval: 0.2 }, 400)
          return json({ error: next }, 400)
        }
        return json({ error: "unsupported_grant_type" }, 400)
      }

      if (request.method === "POST" && url.pathname === "/device") {
        const deviceCode = `device-${CANARY}-${randomUUID()}`
        deviceCodes.add(deviceCode)
        return json({ device_code: deviceCode, user_code: "WDJB-MJHT", verification_uri: `${origin}/activate`, verification_uri_complete: `${origin}/activate?user_code=WDJB-MJHT`, ...(plan.deviceExpiresIn === undefined ? {} : { expires_in: plan.deviceExpiresIn }), ...(plan.deviceInterval === undefined ? {} : { interval: plan.deviceInterval }) })
      }

      if (request.method === "POST" && url.pathname === "/muse-code/key") {
        const identity = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
        if (plan.mint === "server-error") return json({ error: "server_error" }, 503)
        if (plan.mint === "unauthorized" || !identities.has(identity)) return json({ detail: `secret detail ${CANARY}` }, 401)
        if (request.headers.get("x-api-version") !== "1.0.0") return json({ error: "unsupported_version" }, 400)
        if (plan.mint === "no-key") return json({ require_payment: true, action_url: `${origin}/billing?${CANARY}` })
        return json({ api_key: mint("minted-key") })
      }

      if (request.method === "GET" && url.pathname === "/auth") {
        const back = new URL(fields.callback_url ?? "")
        const code = `code-${CANARY}-${randomUUID()}`
        codes.set(code, { challenge: fields.code_challenge ?? "", redirectUri: fields.callback_url ?? "", used: false })
        back.searchParams.set("code", code)
        return Response.redirect(back.toString(), 302)
      }

      if (request.method === "POST" && url.pathname === "/api/v1/auth/keys") {
        const entry = codes.get(fields.code ?? "")
        const verified = entry !== undefined && createHash("sha256").update(fields.code_verifier ?? "").digest("base64url") === entry.challenge
        if (plan.key === "rejected" || entry === undefined || entry.used || !verified || fields.code_challenge_method !== "S256") return json({ error: { message: `secret detail ${CANARY}` } }, 403)
        entry.used = true
        return json(plan.key === "no-key" ? { user_id: "user" } : { key: mint("sk-or") })
      }

      return json({ error: "not_found" }, 404)
    },
  })
  const origin: string = `http://127.0.0.1:${server.port}`

  const approve = async (address: string): Promise<string> => {
    const response = await fetch(address, { redirect: "manual" })
    await response.body?.cancel()
    const location = response.headers.get("location")
    if (response.status !== 302 || location === null) throw new Error(`mock sign-in page answered ${response.status}`)
    return location
  }

  return {
    origin,
    authorizeUrl: `${origin}/authorize`,
    tokenUrl: `${origin}/token`,
    deviceUrl: `${origin}/device`,
    keyAuthorizeUrl: `${origin}/auth`,
    keyUrl: `${origin}/api/v1/auth/keys`,
    mintUrl: `${origin}/muse-code/key`,
    plan,
    requests,
    issued,
    approve,
    visit: async (address) => fetch(await approve(address), { redirect: "manual" }),
    stop: async () => {
      await server.stop(true)
    },
  }
}

/** A port nothing is listening on right now. */
export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port
  void probe.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}
