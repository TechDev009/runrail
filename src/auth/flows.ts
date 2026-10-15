import { randomUUID, timingSafeEqual } from "node:crypto"
import { CredentialRefreshError, type CredentialRefresher } from "./broker.ts"
import { openLoopbackListener, type LoopbackListener, type RedirectVerdict } from "./loopback.ts"
import { createPkcePair, randomUrlToken } from "./pkce.ts"
import { oauthErrorWord, secretField, signInEndpoint, signInPost } from "./signin-http.ts"
import { SignInError, type SignInErrorCode, type SignInFlow, type SignInNotice, type SignInSession } from "./signin-types.ts"
import type { OAuthCredential, StoredCredential } from "./vault.ts"

const FLOW_ID = /^[a-z][a-z0-9-]{0,63}$/
const MAX_MANUAL_INPUT_BYTES = 8 * 1024
const MAX_REDIRECT_PARAM_BYTES = 512

export interface AuthorizeInput {
  readonly redirectUri: string
  readonly challenge: string
  /** Present when the vendor returns `state`. */
  readonly state?: string
  readonly nonce: string
  readonly installationId: string
}

export interface ExchangeInput {
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
  /** The redirect parameters named in `redirectParams`. */
  readonly redirect: Readonly<Record<string, string>>
  /** The nonce the authorize request carried, for an id token to echo. */
  readonly nonce: string
  readonly signal: AbortSignal
  readonly now: number
}

/** A sign-in where the user approves in a browser and the vendor sends the browser back with a code (PKCE). */
export interface BrowserSignInDescriptor {
  readonly id: string
  readonly label: string
  readonly preset: string
  readonly authMode: "oauth" | "api-key"
  readonly unofficial?: boolean
  readonly timeoutMs?: number
  readonly authorizeUrl: string
  readonly callback: {
    /** The port the vendor has registered for this client, or `0` when any port is accepted. */
    readonly port: number
    readonly path: string
  }
  /**
   * Whether the vendor returns `state`. When it does not, each sign-in listens on its own random
   * path, which does the same job: a request that did not come from this sign-in cannot find it.
   */
  readonly state: boolean
  /** Redirect parameters besides `code` that the exchange needs. */
  readonly redirectParams?: readonly string[]
  authorizeParams(input: AuthorizeInput): Readonly<Record<string, string>>
  exchange(input: ExchangeInput): Promise<StoredCredential>
  readonly refresher?: CredentialRefresher
}

interface Redirect {
  readonly code: string
  readonly redirect: Readonly<Record<string, string>>
}

export function createBrowserSignIn(descriptor: BrowserSignInDescriptor): SignInFlow {
  if (!FLOW_ID.test(descriptor.id)) throw new SignInError("AUTH_INVALID", "sign-in id is invalid")
  const authorize = signInEndpoint(descriptor.authorizeUrl, "authorize address")
  const { port: fixedPort, path: basePath } = descriptor.callback
  if (!Number.isSafeInteger(fixedPort) || fixedPort < 0 || fixedPort > 65_535 || !/^\/[A-Za-z0-9/_-]{1,128}$/.test(basePath)) throw new SignInError("AUTH_INVALID", "callback address is invalid")
  const wanted = descriptor.redirectParams ?? []

  return Object.freeze({
    id: descriptor.id,
    label: descriptor.label,
    preset: descriptor.preset,
    authMode: descriptor.authMode,
    kind: "browser" as const,
    browserHosts: Object.freeze([authorize.hostname]),
    unofficial: descriptor.unofficial === true,
    ...(descriptor.timeoutMs === undefined ? {} : { timeoutMs: descriptor.timeoutMs }),
    ...(descriptor.refresher === undefined ? {} : { refresher: descriptor.refresher }),

    async run(session: SignInSession): Promise<StoredCredential> {
      const pkce = createPkcePair()
      const state = descriptor.state ? randomUrlToken(32) : undefined
      const path = descriptor.state ? basePath : `${basePath}/${randomUUID()}`
      const claim = deferred<Redirect>()
      let claimed = false

      const read = (params: URLSearchParams): { readonly verdict: RedirectVerdict; readonly code?: SignInErrorCode } => {
        if (claimed) return { verdict: "duplicate", code: "AUTH_LOGIN_FINISHED" }
        // State first: a request that did not come from this sign-in must not be able to end it.
        if (state !== undefined && !sameText(params.get("state"), state)) return { verdict: "refused", code: "AUTH_STATE_MISMATCH" }
        if (params.has("error")) {
          claimed = true
          claim.reject(new SignInError("AUTH_DENIED", "the sign-in was not granted"))
          return { verdict: "ended" }
        }
        const code = secretField(params.get("code"))
        const redirect: Record<string, string> = {}
        for (const name of wanted) {
          const value = params.get(name)
          if (value === null || value.length === 0 || value.length > MAX_REDIRECT_PARAM_BYTES || /[\0-\x20\x7f]/.test(value)) return { verdict: "refused", code: "AUTH_INPUT_INVALID" }
          redirect[name] = value
        }
        if (code === undefined) return { verdict: "refused", code: "AUTH_INPUT_INVALID" }
        claimed = true
        claim.resolve({ code, redirect })
        return { verdict: "accepted" }
      }

      let listener: LoopbackListener | undefined
      let notice: SignInNotice | undefined
      const opened = openLoopbackListener({ port: fixedPort, path, onRedirect: (params) => read(params).verdict })
      if ("listener" in opened) listener = opened.listener
      else notice = opened.notice
      try {
        const port = listener?.port ?? fixedPort
        // Without a listener and without a registered port there is no address to send the browser to.
        if (port === 0) throw new SignInError("AUTH_UNAVAILABLE", "no local port could be opened for the sign-in")
        const redirectUri = `http://127.0.0.1:${port}${path}`

        session.acceptManualInput((input) => {
          const outcome = read(manualParams(input, redirectUri, state === undefined && wanted.length === 0))
          if (outcome.verdict === "refused" || outcome.verdict === "duplicate") throw new SignInError(outcome.code ?? "AUTH_INPUT_INVALID", "the pasted address cannot be used for this sign-in")
        })

        const url = new URL(authorize)
        const nonce = randomUrlToken(32)
        const params = descriptor.authorizeParams({ redirectUri, challenge: pkce.challenge, ...(state === undefined ? {} : { state }), nonce, installationId: await session.installationId() })
        for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
        session.emit({ type: "open-url", url: url.toString(), redirect: listener === undefined ? "manual" : "loopback", ...(notice === undefined ? {} : { notice }) })

        const received = await untilAborted(claim.promise, session.signal)
        session.emit({ type: "finishing" })
        return await descriptor.exchange({ code: received.code, verifier: pkce.verifier, redirectUri, redirect: received.redirect, nonce, signal: session.signal, now: session.now() })
      } finally {
        claimed = true
        // A rejection nobody is waiting for any more (cancel raced with a denied redirect) is not an error.
        claim.promise.catch(() => {})
        await listener?.close()
      }
    },
  })
}

/** Turns what the user pasted into redirect parameters: the full address, its query string, or (when allowed) the bare code. */
function manualParams(input: string, redirectUri: string, bareCode: boolean): URLSearchParams {
  const text = input.trim()
  const invalid = (): SignInError => new SignInError("AUTH_INPUT_INVALID", "the pasted text is not the address the sign-in ended on")
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_MANUAL_INPUT_BYTES || /[\0-\x1f\x7f]/.test(text)) throw invalid()
  if (/^https?:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw invalid()
    }
    const expected = new URL(redirectUri)
    const sameHost = url.host === expected.host || url.host === `localhost:${expected.port}`
    if (url.protocol !== "http:" || !sameHost || url.pathname !== expected.pathname) throw invalid()
    return url.searchParams
  }
  if (/(^|[?&])code=/.test(text)) return new URLSearchParams(text.replace(/^\?/, ""))
  if (!bareCode || /[\s&=?#]/.test(text)) throw invalid()
  return new URLSearchParams({ code: text })
}

/** A sign-in where the user types a short code on the vendor's page while Runrail polls for the result (RFC 8628). */
export interface DeviceCodeSignInDescriptor {
  readonly id: string
  readonly label: string
  readonly preset: string
  readonly authMode: "oauth" | "device"
  readonly unofficial?: boolean
  readonly timeoutMs?: number
  readonly deviceUrl: string
  readonly tokenUrl: string
  readonly clientId: string
  readonly scope?: string
  /** Extra fields of the device request. */
  readonly deviceParams?: Readonly<Record<string, string>>
  /** Hosts the page where the user types the code may be on. */
  readonly verificationHosts: readonly string[]
  /** Seconds the code lives when the vendor names no lifetime. Without it such an answer is refused. */
  readonly defaultExpiresIn?: number
  /** Words besides `access_denied` with which this vendor says the user declined. */
  readonly deniedWords?: readonly string[]
  /**
   * Builds what is stored from the granted answer. Default: the standard token fields. A vendor
   * whose granted answer is only a step on the way may make its one further call here.
   */
  credential?(body: Readonly<Record<string, unknown>>, now: number, signal: AbortSignal): StoredCredential | Promise<StoredCredential>
  readonly refresher?: CredentialRefresher
}

export interface DeviceCodeTiming {
  /** Shortest wait between two polls. Default one second. */
  readonly minIntervalMs?: number
  /** Wait used when the vendor names none. Default five seconds. */
  readonly defaultIntervalMs?: number
  /** Added to the wait when the vendor says `slow_down` without naming a new one. Default five seconds. */
  readonly slowDownMs?: number
}

export function createDeviceCodeSignIn(descriptor: DeviceCodeSignInDescriptor, timing: DeviceCodeTiming = {}): SignInFlow {
  if (!FLOW_ID.test(descriptor.id)) throw new SignInError("AUTH_INVALID", "sign-in id is invalid")
  const deviceUrl = signInEndpoint(descriptor.deviceUrl, "device address")
  const tokenUrl = signInEndpoint(descriptor.tokenUrl, "token address")
  const hosts = Object.freeze([...descriptor.verificationHosts])
  if (hosts.length === 0 || hosts.length > 8) throw new SignInError("AUTH_INVALID", "verification hosts are invalid")
  const defaultExpiresIn = descriptor.defaultExpiresIn
  if (defaultExpiresIn !== undefined && seconds(defaultExpiresIn) === undefined) throw new SignInError("AUTH_INVALID", "default code lifetime is invalid")
  const denied = new Set(["access_denied", ...(descriptor.deniedWords ?? [])])
  if (denied.size > 8 || [...denied].some((word) => !/^[a-z_]{1,64}$/.test(word))) throw new SignInError("AUTH_INVALID", "denied words are invalid")
  const minIntervalMs = timing.minIntervalMs ?? 1_000
  const defaultIntervalMs = timing.defaultIntervalMs ?? 5_000
  const slowDownMs = timing.slowDownMs ?? 5_000

  return Object.freeze({
    id: descriptor.id,
    label: descriptor.label,
    preset: descriptor.preset,
    authMode: descriptor.authMode,
    kind: "device-code" as const,
    browserHosts: hosts,
    unofficial: descriptor.unofficial === true,
    ...(descriptor.timeoutMs === undefined ? {} : { timeoutMs: descriptor.timeoutMs }),
    ...(descriptor.refresher === undefined ? {} : { refresher: descriptor.refresher }),

    async run(session: SignInSession): Promise<StoredCredential> {
      const started = await signInPost(deviceUrl, { form: { client_id: descriptor.clientId, ...(descriptor.scope === undefined ? {} : { scope: descriptor.scope }), ...descriptor.deviceParams } }, session.signal)
      const device = started.body
      const deviceCode = secretField(device?.device_code)
      const userCode = typeof device?.user_code === "string" && /^[A-Za-z0-9 -]{1,32}$/.test(device.user_code) ? device.user_code : undefined
      const expiresIn = seconds(device?.expires_in) ?? (device?.expires_in === undefined ? defaultExpiresIn : undefined)
      if (started.status < 200 || started.status >= 300 || deviceCode === undefined || userCode === undefined || expiresIn === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the device sign-in could not be started")
      const verificationUrl = verificationAddress(device?.verification_uri_complete, hosts) ?? verificationAddress(device?.verification_uri, hosts)
      if (verificationUrl === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the device sign-in page is not on an expected host")
      const deadline = session.now() + expiresIn * 1_000
      session.emit({ type: "device-code", userCode, verificationUrl, expiresAt: deadline })

      let intervalMs = Math.max(minIntervalMs, (seconds(device?.interval) ?? defaultIntervalMs / 1_000) * 1_000)
      for (;;) {
        await sleep(intervalMs, session.signal)
        if (session.now() >= deadline) throw new SignInError("AUTH_EXPIRED", "the code was not entered in time")
        const polled = await signInPost(tokenUrl, { form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: descriptor.clientId } }, session.signal)
        if (polled.status >= 200 && polled.status < 300 && polled.body !== undefined && oauthErrorWord(polled.body) === undefined) {
          session.emit({ type: "finishing" })
          return descriptor.credential === undefined ? tokenCredential(polled.body, session.now()) : await descriptor.credential(polled.body, session.now(), session.signal)
        }
        const word = oauthErrorWord(polled.body)
        if (word === "authorization_pending") continue
        if (word === "slow_down") {
          const named = seconds(polled.body?.interval)
          intervalMs = Math.max(minIntervalMs, named === undefined ? intervalMs + slowDownMs : named * 1_000)
          continue
        }
        if (word !== undefined && denied.has(word)) throw new SignInError("AUTH_DENIED", "the sign-in was not granted")
        if (word === "expired_token") throw new SignInError("AUTH_EXPIRED", "the code was not entered in time")
        if (polled.status >= 500) throw new SignInError("AUTH_NETWORK", "the sign-in service failed")
        throw new SignInError("AUTH_CODE_REJECTED", "the sign-in was rejected")
      }
    },
  })
}

/**
 * Reads the standard token answer (`access_token`, `refresh_token`, `expires_in`, `scope`).
 * `defaultExpiresIn` is the lifetime in seconds to assume when the vendor names none.
 */
export function tokenCredential(body: Readonly<Record<string, unknown>>, now: number, defaultExpiresIn?: number): OAuthCredential {
  const access = secretField(body.access_token)
  if (access === undefined) throw new SignInError("AUTH_RESPONSE_INVALID", "the sign-in answer carries no token")
  const refresh = secretField(body.refresh_token)
  const expiresIn = seconds(body.expires_in) ?? (body.expires_in === undefined ? defaultExpiresIn : undefined)
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter((scope) => /^[\x21-\x7e]{1,128}$/.test(scope)).slice(0, 64) : undefined
  return Object.freeze({
    kind: "oauth" as const,
    access,
    ...(refresh === undefined ? {} : { refresh }),
    ...(expiresIn === undefined ? {} : { expiresAt: now + expiresIn * 1_000 }),
    ...(scopes === undefined || scopes.length === 0 ? {} : { scopes: Object.freeze(scopes) }),
  })
}

export interface RefreshTokenOptions {
  readonly tokenUrl: string
  /** Fixed client id. Without one, the id issued at sign-in and stored with the tokens is used. */
  readonly clientId?: string
  /** Extra fields of the refresh request. */
  readonly params?: Readonly<Record<string, string>>
  /** Seconds a renewed token lives when the vendor names no lifetime. */
  readonly defaultExpiresIn?: number
  /** HTTP statuses with which this vendor says the sign-in is over, besides the `invalid_grant` word. */
  readonly rejectedStatuses?: readonly number[]
  readonly now?: () => number
}

/**
 * The standard `refresh_token` grant. The vendor's `invalid_grant` (or one of `rejectedStatuses`)
 * means "sign in again"; anything else keeps the old tokens.
 */
export function createRefreshTokenRefresher(options: RefreshTokenOptions): CredentialRefresher {
  const tokenUrl = signInEndpoint(options.tokenUrl, "token address")
  const now = options.now ?? Date.now
  const defaultExpiresIn = options.defaultExpiresIn
  if (defaultExpiresIn !== undefined && seconds(defaultExpiresIn) === undefined) throw new SignInError("AUTH_INVALID", "default token lifetime is invalid")
  const rejected = new Set(options.rejectedStatuses ?? [])
  if (rejected.size > 8 || [...rejected].some((status) => !Number.isInteger(status) || status < 400 || status > 499)) throw new SignInError("AUTH_INVALID", "rejected statuses are invalid")
  return Object.freeze({
    async refresh(credential: OAuthCredential, _reference: unknown, signal: AbortSignal): Promise<OAuthCredential> {
      const clientId = options.clientId ?? credential.clientId
      if (credential.refresh === undefined || clientId === undefined) throw new CredentialRefreshError("invalid_grant", "the stored sign-in cannot be renewed")
      let answer: Awaited<ReturnType<typeof signInPost>>
      try {
        answer = await signInPost(tokenUrl, { form: { grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh, ...options.params } }, signal)
      } catch {
        throw new CredentialRefreshError("transient", "the sign-in service cannot be reached")
      }
      if (answer.status < 200 || answer.status >= 300 || answer.body === undefined) {
        if (oauthErrorWord(answer.body) === "invalid_grant" || rejected.has(answer.status)) throw new CredentialRefreshError("invalid_grant", "the sign-in is no longer accepted")
        throw new CredentialRefreshError("transient", `the sign-in service answered ${answer.status}`)
      }
      try {
        return tokenCredential(answer.body, now(), defaultExpiresIn)
      } catch {
        throw new CredentialRefreshError("transient", "the sign-in service sent an unusable answer")
      }
    },
  })
}

function verificationAddress(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined
  try {
    const url = signInEndpoint(value, "verification address")
    return hosts.includes(url.hostname) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 366 * 24 * 3_600 ? value : undefined
}

function sameText(left: string | null, right: string): boolean {
  if (left === null) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new SignInError("AUTH_CANCELLED", "sign-in was cancelled"))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new SignInError("AUTH_CANCELLED", "sign-in was cancelled"))
    const abort = (): void => {
      clearTimeout(timer)
      reject(new SignInError("AUTH_CANCELLED", "sign-in was cancelled"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
