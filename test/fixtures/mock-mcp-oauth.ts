import { createHash, randomUUID } from "node:crypto"

/**
 * A remote MCP server that wants a sign-in, and the authorization server it names, both on this
 * machine. The MCP server answers only a token the authorization server issued for it; the
 * authorization server registers clients, signs in with PKCE, and checks the `resource` each step
 * names. Every token contains `MCP_CANARY`, so a test can search any output for a leak.
 */
export const MCP_CANARY = "mcp-canary-4f1a9c3e7d"

export interface MockMcpOAuthPlan {
  /** What the MCP server publishes about itself. `other-resource`: metadata naming another server. */
  resourceMetadata: "published" | "missing" | "other-resource"
  /** What the authorization server publishes. */
  serverMetadata: "full" | "no-pkce" | "no-registration"
  /** Seconds an access token lives. */
  expiresIn: number
}

/** An app registered by hand: any loopback callback port, and the secret its token calls must carry. */
export const PRESET_APP = { id: "preset-app", secret: `app-secret-${MCP_CANARY}` }

export interface MockMcpOAuth {
  readonly mcpUrl: string
  readonly authOrigin: string
  readonly plan: MockMcpOAuthPlan
  /** Each MCP request's `Authorization` header, and each sign-in call by path. */
  readonly seen: { readonly mcp: (string | null)[]; readonly register: Record<string, unknown>[]; readonly authorize: Record<string, string>[]; readonly token: Record<string, string>[] }
  readonly issued: string[]
  /** Plays the browser: opens the sign-in page and follows the redirect back to Runrail. */
  visit(page: string): Promise<Response>
  stop(): void
}

export function startMockMcpOAuth(): MockMcpOAuth {
  const plan: MockMcpOAuthPlan = { resourceMetadata: "published", serverMetadata: "full", expiresIn: 3_600 }
  const seen: MockMcpOAuth["seen"] = { mcp: [], register: [], authorize: [], token: [] }
  const issued: string[] = []
  const clients = new Map<string, readonly string[]>()
  const codes = new Map<string, { readonly challenge: string; readonly clientId: string; readonly redirectUri: string; readonly resource: string; used: boolean }>()
  const access = new Set<string>()
  const refresh = new Map<string, string>()
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
  const mint = (kind: string): string => {
    const value = `${kind}-${MCP_CANARY}-${randomUUID()}`
    issued.push(value)
    return value
  }
  const tokens = (clientId: string): Response => {
    const accessToken = mint("access")
    const refreshToken = mint("refresh")
    access.add(accessToken)
    refresh.set(refreshToken, clientId)
    return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: plan.expiresIn })
  }

  const auth = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: authOrigin,
          authorization_endpoint: `${authOrigin}/authorize`,
          token_endpoint: `${authOrigin}/token`,
          ...(plan.serverMetadata === "no-registration" ? {} : { registration_endpoint: `${authOrigin}/register` }),
          response_types_supported: ["code"],
          ...(plan.serverMetadata === "no-pkce" ? {} : { code_challenge_methods_supported: ["S256"] }),
        })
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>
        seen.register.push(body)
        const clientId = `client-${randomUUID()}`
        clients.set(clientId, body.redirect_uris as string[])
        return json({ client_id: clientId, client_name: body.client_name, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" }, 201)
      }
      if (url.pathname === "/authorize") {
        const fields = Object.fromEntries(url.searchParams)
        seen.authorize.push(fields)
        const redirectUri = fields.redirect_uri ?? ""
        const preset = fields.client_id === PRESET_APP.id && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)
        if ((!preset && !(clients.get(fields.client_id ?? "") ?? []).includes(redirectUri)) || fields.code_challenge_method !== "S256" || fields.resource !== mcpUrl) return new Response("bad request", { status: 400 })
        const code = `code-${randomUUID()}`
        codes.set(code, { challenge: fields.code_challenge ?? "", clientId: fields.client_id ?? "", redirectUri, resource: fields.resource, used: false })
        const back = new URL(redirectUri)
        back.searchParams.set("code", code)
        if (fields.state !== undefined) back.searchParams.set("state", fields.state)
        return new Response(null, { status: 302, headers: { location: back.toString() } })
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const fields = Object.fromEntries(new URLSearchParams(await request.text()))
        seen.token.push(fields)
        if (fields.resource !== mcpUrl) return json({ error: "invalid_target" }, 400)
        if (fields.client_id === PRESET_APP.id && fields.client_secret !== PRESET_APP.secret) return json({ error: "invalid_client" }, 401)
        if (fields.client_id !== PRESET_APP.id && fields.client_secret !== undefined) return json({ error: "invalid_client" }, 401)
        if (fields.grant_type === "authorization_code") {
          const entry = codes.get(fields.code ?? "")
          const challenge = createHash("sha256").update(fields.code_verifier ?? "").digest("base64url")
          if (entry === undefined || entry.used || entry.challenge !== challenge || entry.clientId !== fields.client_id || entry.redirectUri !== fields.redirect_uri) return json({ error: "invalid_grant" }, 400)
          entry.used = true
          return tokens(entry.clientId)
        }
        if (fields.grant_type === "refresh_token") {
          const clientId = refresh.get(fields.refresh_token ?? "")
          if (clientId === undefined || clientId !== fields.client_id) return json({ error: "invalid_grant" }, 400)
          refresh.delete(fields.refresh_token ?? "")
          return tokens(clientId)
        }
        return json({ error: "unsupported_grant_type" }, 400)
      }
      return new Response("not found", { status: 404 })
    },
  })
  const authOrigin = `http://127.0.0.1:${String(auth.port)}`

  const mcp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        if (plan.resourceMetadata === "missing") return new Response("not found", { status: 404 })
        return json({ resource: plan.resourceMetadata === "other-resource" ? "http://127.0.0.1:1/elsewhere" : mcpUrl, authorization_servers: [authOrigin], scopes_supported: ["tools.read"] })
      }
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
      const header = request.headers.get("authorization")
      seen.mcp.push(header)
      if (header === null || !access.has(header.replace(/^Bearer /, ""))) {
        await request.body?.cancel()
        const challenge = plan.resourceMetadata === "missing" ? "Bearer" : `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp", scope="tools.read"`
        return new Response("unauthorized", { status: 401, headers: { "www-authenticate": challenge } })
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      const message = (await request.json()) as { id?: number; method: string }
      if (message.id === undefined) return new Response(null, { status: 202 })
      if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "remote-docs", version: "1.0.0" }, capabilities: { tools: {} } } })
      if (message.method === "tools/list") return json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search", description: "Searches the docs.", inputSchema: { type: "object" } }] } })
      return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } })
    },
  })
  const mcpOrigin = `http://127.0.0.1:${String(mcp.port)}`
  const mcpUrl = `${mcpOrigin}/mcp`

  return {
    mcpUrl,
    authOrigin,
    plan,
    seen,
    issued,
    async visit(page) {
      const answer = await fetch(page, { redirect: "manual" })
      const location = answer.headers.get("location")
      if (location === null) throw new Error(`the sign-in page answered ${String(answer.status)}`)
      return fetch(location)
    },
    stop() {
      void auth.stop(true)
      void mcp.stop(true)
    },
  }
}
