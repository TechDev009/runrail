import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AccountError, InMemoryAccountStore, type AccountReference } from "../accounts/types.ts"
import { CredentialRefreshError, CredentialStoreError, VaultCredentialBroker, type CredentialRefresher } from "../auth/broker.ts"
import { createBrowserSignIn, createRefreshTokenRefresher, tokenCredential } from "../auth/flows.ts"
import { withFileLock } from "../auth/lock.ts"
import { isPrivateHost } from "../net/redirect.ts"
import { RUNRAIL_USER_AGENT } from "../providers/http.ts"
import { oauthErrorWord, signInEndpoint, signInGet, signInPost } from "../auth/signin-http.ts"
import { SignInError, type SignInFlow } from "../auth/signin-types.ts"
import type { CredentialVault, StoredCredential } from "../auth/vault.ts"
import { RUNRAIL_VERSION } from "../version.ts"

/**
 * Sign-in for a remote MCP server, the way the MCP authorization spec lays it out: the server names
 * its authorization server (RFC 9728), whose metadata (RFC 8414) gives the pages to use; Runrail
 * registers itself there as a public client (RFC 7591), signs in with PKCE, and asks for a token
 * bound to that one server (RFC 8707).
 *
 * The tokens sit in the credential vault under `mcp-oauth:<hash of the address>`. What renewing them
 * needs (the token address, the resource) sits in `mcp-oauth.json` beside the accounts; no secret.
 */

export const MCP_OAUTH_PRESET = "mcp-oauth"
const CREDENTIAL_PREFIX = "mcp-oauth:"
const DISCOVERY_MS = 10_000
// The broker renews a token this close to expiry, so a cached one is handed back only until then.
const RENEW_MARGIN_MS = 180_000
// A sign-out or a new sign-in in another engine is noticed within this long.
const MAX_CACHE_MS = 5 * 60_000
const MAX_SERVERS = 256

export type McpOAuthErrorCode = "MCP_SIGN_IN_REQUIRED" | "MCP_SIGN_IN_UNAVAILABLE"

export class McpOAuthError extends Error {
  constructor(readonly code: McpOAuthErrorCode, reason: string) {
    super(reason)
    this.name = "McpOAuthError"
  }
}

/** What a session needs to send a signed-in server its token. */
export interface McpSignIns {
  /** True when a sign-in was saved for this address. */
  stored(url: string): Promise<boolean>
  /** The current access token, renewed first when it is about to run out. */
  token(url: string, signal: AbortSignal): Promise<string>
}

/** One server's sign-in as found by discovery. Addresses are checked; nothing here is secret. */
export interface McpOAuthServer {
  /** The server address as signed in to: no fragment, no trailing slash on a bare host. */
  readonly url: string
  /** What the token is bound to: the server's own `resource`, or its address. */
  readonly resource: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  /** Absent when the authorization server does not register apps; an app registered there is needed. */
  readonly registrationUrl?: string
  readonly scope?: string
}

/** An app the person registered with the server's authorization server themselves. */
export interface McpClient {
  readonly id: string
  /** The callback port the app was registered with; any port when absent. */
  readonly callbackPort?: number
  /** True when an app secret is kept for it in the vault. */
  readonly secret: boolean
}

export interface McpSignInSummary {
  readonly url: string
  readonly signedIn: boolean
  readonly updatedAt: number
  readonly client?: McpClient
}

interface ServerEntry {
  readonly url: string
  readonly updatedAt: number
  /** Present while signed in: what renewing the tokens needs. */
  readonly session?: { readonly resource: string; readonly tokenUrl: string }
  readonly client?: McpClient
}

const CLIENT_ID = /^[\x21-\x7e]{1,512}$/

export function mcpCredentialId(url: string): string {
  return `${CREDENTIAL_PREFIX}${createHash("sha256").update(canonicalMcpUrl(url)).digest("hex").slice(0, 32)}`
}

/** `https`, or `http` to this machine, without credentials; a fragment is dropped. */
export function canonicalMcpUrl(value: string): string {
  const url = signInEndpoint(value.replace(/#.*$/s, ""), "MCP server address")
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}${url.search}`
}

export interface McpOAuthOptions {
  readonly vault: CredentialVault
  /** The accounts folder; `mcp-oauth.json` and the refresh locks live there. */
  readonly root: string
  readonly now?: () => number
}

export class McpOAuth implements McpSignIns {
  readonly #file: string
  readonly #lock: string
  readonly #now: () => number
  readonly #broker: VaultCredentialBroker
  readonly #cache = new Map<string, { readonly access: string; readonly until: number }>()

  /** Renews a server's tokens at the token address its sign-in used. */
  readonly refresher: CredentialRefresher = Object.freeze<CredentialRefresher>({
    refresh: async (credential, reference, signal) => {
      const entry = (await this.#read()).get(reference.accountId)
      if (entry?.session === undefined) throw new CredentialRefreshError("invalid_grant", "the server's sign-in is no longer known")
      const secret = await this.#clientSecret(reference.accountId, entry.client)
      return createRefreshTokenRefresher({ tokenUrl: entry.session.tokenUrl, params: { resource: entry.session.resource, ...(secret === undefined ? {} : { client_secret: secret }) }, now: this.#now }).refresh(credential, reference, signal)
    },
  })

  readonly #vault: CredentialVault

  constructor(options: McpOAuthOptions) {
    if (typeof options.root !== "string" || !options.root.startsWith("/")) throw new SignInError("AUTH_INVALID", "MCP sign-in root is invalid")
    this.#vault = options.vault
    this.#file = join(options.root, "mcp-oauth.json")
    this.#lock = join(options.root, "locks", "mcp-oauth.lock")
    this.#now = options.now ?? Date.now
    this.#broker = new VaultCredentialBroker({
      vault: options.vault,
      // These tokens belong to no account; the broker's status marks have nothing to mark.
      accounts: new InMemoryAccountStore(),
      lockRoot: join(options.root, "locks"),
      refreshers: { [MCP_OAUTH_PRESET]: this.refresher },
      now: this.#now,
    })
  }

  async stored(url: string): Promise<boolean> {
    let id: string
    try {
      id = mcpCredentialId(url)
    } catch {
      // A plain-http remote address can never have been signed in to.
      return false
    }
    return (await this.#read()).get(id)?.session !== undefined
  }

  async list(): Promise<readonly McpSignInSummary[]> {
    return Object.freeze([...(await this.#read()).values()]
      .map((entry) => Object.freeze({ url: entry.url, signedIn: entry.session !== undefined, updatedAt: entry.updatedAt, ...(entry.client === undefined ? {} : { client: entry.client }) }))
      .sort((left, right) => left.url.localeCompare(right.url)))
  }

  /**
   * Names the app to sign in with, for an authorization server that does not register apps, or
   * when the person prefers their own. A new app id forgets the old app's secret.
   */
  async setClient(url: string, clientId: string, callbackPort?: number): Promise<{ readonly id: string; readonly url: string; readonly client: McpClient }> {
    if (!CLIENT_ID.test(clientId)) throw new SignInError("AUTH_INVALID", "app id is invalid")
    if (callbackPort !== undefined && (!Number.isSafeInteger(callbackPort) || callbackPort < 1_024 || callbackPort > 65_535)) throw new SignInError("AUTH_INVALID", "callback port is invalid")
    const canonical = canonicalMcpUrl(url)
    const id = mcpCredentialId(canonical)
    const previous = (await this.#read()).get(id)?.client
    const keepsSecret = previous?.id === clientId && previous.secret
    if (previous !== undefined && !keepsSecret) await this.#forgetClientSecret(id)
    const client: McpClient = Object.freeze({ id: clientId, ...(callbackPort === undefined ? {} : { callbackPort }), secret: keepsSecret })
    await this.#update(id, canonical, (entry) => ({ ...entry, client }))
    return { id, url: canonical, client }
  }

  /** Keeps the named app's secret in the vault; it is sent to the token address only. */
  async setClientSecret(id: string, secret: string): Promise<{ readonly url: string; readonly client: McpClient }> {
    const entry = (await this.#read()).get(id)
    if (entry?.client === undefined) throw new SignInError("AUTH_INVALID", "name the server's app before its secret")
    if (secret.length === 0 || secret.length > 4_096 || /[\0-\x1f\x7f]/.test(secret)) throw new SignInError("AUTH_INVALID", "app secret is invalid")
    await this.#vault.set(clientSecretId(id), { kind: "api-key", secret })
    const client: McpClient = Object.freeze({ ...entry.client, secret: true })
    await this.#update(id, entry.url, (current) => ({ ...current, client }))
    return { url: entry.url, client }
  }

  /** Forgets the app named for the server, and its secret. */
  async clearClient(url: string): Promise<boolean> {
    const canonical = canonicalMcpUrl(url)
    const id = mcpCredentialId(canonical)
    const known = (await this.#read()).get(id)?.client !== undefined
    await this.#forgetClientSecret(id)
    await this.#change((entries) => {
      const entry = entries.get(id)
      if (entry === undefined) return
      const { client: _client, ...rest } = entry
      if (rest.session === undefined) entries.delete(id)
      else entries.set(id, rest)
    })
    return known
  }

  async token(url: string, signal: AbortSignal): Promise<string> {
    const id = mcpCredentialId(url)
    const now = this.#now()
    const cached = this.#cache.get(id)
    if (cached !== undefined && cached.until > now) return cached.access
    this.#cache.delete(id)
    let lease: Awaited<ReturnType<VaultCredentialBroker["resolve"]>>
    try {
      lease = await this.#broker.resolve(referenceFor(id, url, now), signal)
    } catch (error) {
      if (error instanceof CredentialStoreError) throw new McpOAuthError("MCP_SIGN_IN_UNAVAILABLE", "the credential store could not be read")
      if (error instanceof AccountError && (error.code === "ACCOUNT_EXPIRED" || error.code === "ACCOUNT_CREDENTIALS_UNAVAILABLE")) throw new McpOAuthError("MCP_SIGN_IN_REQUIRED", "sign in to this server again")
      throw new McpOAuthError("MCP_SIGN_IN_UNAVAILABLE", "the server's sign-in could not be renewed")
    }
    const until = Math.min(now + MAX_CACHE_MS, lease.expiresAt === undefined ? Number.POSITIVE_INFINITY : lease.expiresAt - RENEW_MARGIN_MS)
    if (until > now) this.#cache.set(id, Object.freeze({ access: lease.secret, until }))
    return lease.secret
  }

  /**
   * Finds how the server signs in and builds the sign-in for it. The flow registers Runrail with
   * the server's authorization server once the callback address is known, then signs in.
   */
  async signIn(url: string, label: string, signal: AbortSignal): Promise<{ readonly flow: SignInFlow; readonly reference: AccountReference }> {
    const server = await discoverMcpOAuth(url, signal)
    const id = mcpCredentialId(server.url)
    const named = (await this.#read()).get(id)?.client
    if (named === undefined && server.registrationUrl === undefined) throw new SignInError("AUTH_CLIENT_REQUIRED", "the authorization server does not register apps")
    let clientId: string | undefined
    const flow = createBrowserSignIn({
      id: `mcp-${id.slice(CREDENTIAL_PREFIX.length, CREDENTIAL_PREFIX.length + 12)}`,
      label,
      preset: MCP_OAUTH_PRESET,
      authMode: "oauth",
      authorizeUrl: server.authorizeUrl,
      callback: { port: named?.callbackPort ?? 0, path: "/callback" },
      state: true,
      authorizeParams: async ({ redirectUri, challenge, state, signal: running }) => {
        clientId = named?.id ?? (await registerClient(server.registrationUrl!, server.scope, redirectUri, running))
        return {
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          ...(state === undefined ? {} : { state }),
          resource: server.resource,
          ...(server.scope === undefined ? {} : { scope: server.scope }),
        }
      },
      exchange: async ({ code, verifier, redirectUri, signal: running, now }): Promise<StoredCredential> => {
        if (clientId === undefined) throw new SignInError("AUTH_FAILED", "the sign-in was not registered")
        const secret = await this.#clientSecret(id, named)
        const answer = await signInPost(signInEndpoint(server.tokenUrl, "token address"), { form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: server.resource, ...(secret === undefined ? {} : { client_secret: secret }) } }, running)
        if (answer.status < 200 || answer.status >= 300 || answer.body === undefined || oauthErrorWord(answer.body) !== undefined) throw new SignInError("AUTH_CODE_REJECTED", "the server did not accept the sign-in")
        const type = answer.body.token_type
        if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer")) throw new SignInError("AUTH_RESPONSE_INVALID", "the server issued a token Runrail cannot send")
        const credential = tokenCredential(answer.body, now)
        // Written before the tokens: a renewal can only find its token address here.
        await this.#update(id, server.url, (entry) => ({ ...entry, session: { resource: server.resource, tokenUrl: server.tokenUrl } }))
        this.#cache.delete(id)
        return Object.freeze({ ...credential, clientId })
      },
    })
    return { flow, reference: referenceFor(id, server.url, this.#now(), label) }
  }

  /** Forgets the server's tokens and what renewing them needed. An app named for it is kept for the next sign-in. */
  async signOut(url: string): Promise<boolean> {
    const id = mcpCredentialId(url)
    this.#cache.delete(id)
    const known = (await this.#read()).get(id)?.session !== undefined
    await this.#broker.revoke(referenceFor(id, canonicalMcpUrl(url), this.#now()))
    await this.#change((entries) => {
      const entry = entries.get(id)
      if (entry === undefined) return
      const { session: _session, ...rest } = entry
      if (rest.client === undefined) entries.delete(id)
      else entries.set(id, rest)
    })
    return known
  }

  async #clientSecret(id: string, client: McpClient | undefined): Promise<string | undefined> {
    if (client?.secret !== true) return undefined
    let stored: StoredCredential | undefined
    try {
      stored = await this.#vault.get(clientSecretId(id))
    } catch {
      throw new SignInError("AUTH_STORE_FAILED", "the app secret could not be read")
    }
    return stored?.kind === "api-key" ? stored.secret : undefined
  }

  async #forgetClientSecret(id: string): Promise<void> {
    try {
      await this.#vault.delete(clientSecretId(id))
    } catch {
      throw new SignInError("AUTH_STORE_FAILED", "the app secret could not be removed")
    }
  }

  /** With `forWrite`, a file that cannot be parsed is set aside, not overwritten by the empty list that follows it. */
  async #read(forWrite = false): Promise<Map<string, ServerEntry>> {
    let text: string
    try {
      text = await readFile(this.#file, "utf8")
    } catch (error) {
      if (forWrite && !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error
      return new Map()
    }
    try {
      return entriesOf(JSON.parse(text) as unknown)
    } catch {
      if (forWrite) await rename(this.#file, `${this.#file}.corrupt`).catch(() => undefined)
      return new Map()
    }
  }

  async #update(id: string, url: string, change: (entry: ServerEntry) => ServerEntry): Promise<void> {
    await this.#change((entries) => {
      const entry = change({ ...(entries.get(id) ?? { url }), url, updatedAt: this.#now() })
      entries.delete(id)
      entries.set(id, entry)
      // The oldest sign-in goes first; its tokens stay in the vault and are found again on the next sign-in.
      while (entries.size > MAX_SERVERS) entries.delete(entries.keys().next().value as string)
    })
  }

  async #change(apply: (entries: Map<string, ServerEntry>) => void): Promise<void> {
    await mkdir(dirname(this.#lock), { recursive: true, mode: 0o700 })
    await withFileLock(this.#lock, async () => {
      const entries = await this.#read(true)
      apply(entries)
      const temporary = `${this.#file}.${randomBytes(6).toString("hex")}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, servers: Object.fromEntries(entries) }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.#file)
    }, { timeoutMs: 5_000 })
  }
}

function referenceFor(id: string, url: string, now: number, label?: string): AccountReference {
  return Object.freeze({ accountId: id, provider: MCP_OAUTH_PRESET, preset: MCP_OAUTH_PRESET, label: label ?? new URL(url).host, authMode: "oauth" as const, scopes: Object.freeze([]), createdAt: now, updatedAt: now })
}

/** Where the app secret named for a server is kept: beside its tokens, under an id no account may take. */
function clientSecretId(id: string): string {
  return `${id}:client`
}

function entriesOf(value: unknown): Map<string, ServerEntry> {
  const entries = new Map<string, ServerEntry>()
  const servers = isRecord(value) && isRecord(value.servers) ? value.servers : {}
  for (const [id, raw] of Object.entries(servers)) {
    if (!id.startsWith(CREDENTIAL_PREFIX) || !isRecord(raw)) continue
    const { url, updatedAt } = raw
    if (typeof url !== "string" || typeof updatedAt !== "number") continue
    try {
      if (mcpCredentialId(url) !== id) continue
    } catch {
      continue
    }
    const session = sessionOf(raw.session)
    const client = clientOf(raw.client)
    if (session === undefined && client === undefined) continue
    entries.set(id, Object.freeze({ url, updatedAt, ...(session === undefined ? {} : { session }), ...(client === undefined ? {} : { client }) }))
  }
  return entries
}

function sessionOf(value: unknown): ServerEntry["session"] {
  if (!isRecord(value) || typeof value.resource !== "string" || typeof value.tokenUrl !== "string") return undefined
  try {
    signInEndpoint(value.tokenUrl, "token address")
  } catch {
    return undefined
  }
  return Object.freeze({ resource: value.resource, tokenUrl: value.tokenUrl })
}

function clientOf(value: unknown): McpClient | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !CLIENT_ID.test(value.id)) return undefined
  const port = value.callbackPort
  const callbackPort = typeof port === "number" && Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535 ? port : undefined
  return Object.freeze({ id: value.id, ...(callbackPort === undefined ? {} : { callbackPort }), secret: value.secret === true })
}

/**
 * Asks the server how it signs in. A server that answers without a challenge and publishes no
 * metadata needs no sign-in, and one without PKCE or client registration offers none Runrail can use.
 */
export async function discoverMcpOAuth(value: string, signal: AbortSignal): Promise<McpOAuthServer> {
  const url = canonicalMcpUrl(value)
  const server = new URL(url)
  const challenge = await probe(url, signal)
  // Every address the server names is reached from this machine, so a remote server may not aim it at a private one.
  const reach = (address: string, what: string): URL => {
    const endpoint = signInEndpoint(address, what)
    if (!isPrivateHost(server.hostname) && isPrivateHost(endpoint.hostname)) throw new SignInError("AUTH_INVALID", `${what} points at a private address`)
    return endpoint
  }
  const path = server.pathname === "/" ? "" : server.pathname
  const metadataAddresses = [
    ...(challenge.resourceMetadata === undefined || (!isPrivateHost(server.hostname) && isPrivateHost(new URL(challenge.resourceMetadata).hostname)) ? [] : [challenge.resourceMetadata]),
    ...(path.length === 0 ? [] : [`${server.origin}/.well-known/oauth-protected-resource${path}`]),
    `${server.origin}/.well-known/oauth-protected-resource`,
  ]
  const resourceMetadata = await firstMetadata(metadataAddresses, signal, reach, (body) => Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0)
  let resource = url
  let issuer = server.origin
  let scope = challenge.scope
  if (resourceMetadata !== undefined) {
    const named = resourceMetadata.resource
    if (named !== undefined) {
      // A token bound to another server's address would be sent here; refuse that pairing.
      if (typeof named !== "string" || !sameResource(named, server)) throw new SignInError("AUTH_RESPONSE_INVALID", "the server's metadata names another server")
      resource = named
    }
    const first = (resourceMetadata.authorization_servers as unknown[])[0]
    if (typeof first !== "string") throw new SignInError("AUTH_RESPONSE_INVALID", "the server's metadata names no authorization server")
    issuer = reach(first, "authorization server").toString().replace(/\/$/, "")
    scope ??= scopeOf(resourceMetadata.scopes_supported)
  } else if (challenge.status !== 401) {
    throw new SignInError("AUTH_UNSUPPORTED", "the server asks for no sign-in")
  }
  const issuerUrl = new URL(issuer)
  const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname
  const serverAddresses = issuerPath.length === 0
    ? [`${issuerUrl.origin}/.well-known/oauth-authorization-server`, `${issuerUrl.origin}/.well-known/openid-configuration`]
    : [`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`, `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`]
  const metadata = await firstMetadata(serverAddresses, signal, reach, (body) => typeof body.authorization_endpoint === "string" && typeof body.token_endpoint === "string")
  if (metadata === undefined) throw new SignInError("AUTH_UNSUPPORTED", "the server's authorization server publishes no metadata")
  const methods = metadata.code_challenge_methods_supported
  if (!Array.isArray(methods) || !methods.includes("S256")) throw new SignInError("AUTH_UNSUPPORTED", "the authorization server does not support PKCE")
  return Object.freeze({
    url,
    resource,
    authorizeUrl: reach(metadata.authorization_endpoint as string, "authorize address").toString(),
    tokenUrl: reach(metadata.token_endpoint as string, "token address").toString(),
    ...(typeof metadata.registration_endpoint === "string" ? { registrationUrl: reach(metadata.registration_endpoint, "registration address").toString() } : {}),
    ...(scope === undefined ? {} : { scope }),
  })
}

/** An unauthenticated `initialize`, to read the server's challenge. Nothing it sends back is kept. */
async function probe(url: string, signal: AbortSignal): Promise<{ readonly status: number; readonly resourceMetadata?: string; readonly scope?: string }> {
  const timeout = AbortSignal.timeout(DISCOVERY_MS)
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.any([signal, timeout]),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": RUNRAIL_USER_AGENT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "runrail", version: RUNRAIL_VERSION } } }),
    })
  } catch {
    if (signal.aborted) throw new SignInError("AUTH_CANCELLED", "sign-in was cancelled")
    throw new SignInError("AUTH_NETWORK", timeout.aborted ? "the server did not answer in time" : "the server cannot be reached")
  }
  await response.body?.cancel().catch(() => undefined)
  if (response.status !== 401) return { status: response.status }
  const params = challengeParams(response.headers.get("www-authenticate") ?? "")
  let resourceMetadata: string | undefined
  try {
    resourceMetadata = params.resource_metadata === undefined ? undefined : signInEndpoint(params.resource_metadata, "resource metadata address").toString()
  } catch {
    resourceMetadata = undefined
  }
  const scope = params.scope === undefined ? undefined : scopeOf(params.scope.split(/\s+/))
  return { status: 401, ...(resourceMetadata === undefined ? {} : { resourceMetadata }), ...(scope === undefined ? {} : { scope }) }
}

/** The parameters of a `Bearer` challenge, quoted or bare. */
function challengeParams(header: string): Readonly<Record<string, string>> {
  const params: Record<string, string> = {}
  if (header.length > 4_096 || !/^\s*bearer\b/i.test(header)) return params
  for (const match of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]{0,63})\s*=\s*(?:"((?:[^"\\]|\\.){0,2048})"|([^\s,"]{1,2048}))/g)) {
    const name = match[1]!.toLowerCase()
    if (!(name in params)) params[name] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1")
  }
  return params
}

async function firstMetadata(addresses: readonly string[], signal: AbortSignal, reach: (address: string, what: string) => URL, usable: (body: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
  for (const address of [...new Set(addresses)]) {
    const answer = await signInGet(reach(address, "metadata address"), signal, DISCOVERY_MS)
    if (answer.status >= 200 && answer.status < 300 && answer.body !== undefined && usable(answer.body)) return answer.body
  }
  return undefined
}

/** Registers Runrail as a public client for this one callback address. */
async function registerClient(registrationUrl: string, scope: string | undefined, redirectUri: string, signal: AbortSignal): Promise<string> {
  const answer = await signInPost(signInEndpoint(registrationUrl, "registration address"), {
    json: {
      client_name: "Runrail",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope === undefined ? {} : { scope }),
    },
  }, signal)
  const clientId = answer.body?.client_id
  if (answer.status < 200 || answer.status >= 300 || typeof clientId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(clientId)) throw new SignInError("AUTH_UNSUPPORTED", "the authorization server did not register Runrail")
  return clientId
}

function sameResource(named: string, server: URL): boolean {
  try {
    const url = new URL(named)
    const path = url.pathname.replace(/\/$/, "")
    return url.origin === server.origin && url.hash.length === 0 && (path.length === 0 || server.pathname === path || server.pathname.startsWith(`${path}/`))
  } catch {
    return false
  }
}

function scopeOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const scopes = value.filter((scope): scope is string => typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope)).slice(0, 32)
  return scopes.length === 0 ? undefined : scopes.join(" ")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
