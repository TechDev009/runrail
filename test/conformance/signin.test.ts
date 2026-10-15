import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { InMemoryAccountStore, parseAccountRecord, type AccountStore } from "../../src/accounts/index.ts"
import {
  MemoryCredentialVault,
  SignInError,
  SignInManager,
  VaultCredentialBroker,
  VaultError,
  createBrowserSignIn,
  createChatGptSignIn,
  createDeviceCodeSignIn,
  createOpenRouterSignIn,
  createRefreshTokenRefresher,
  credentialRefreshersFor,
  defaultSignInFlows,
  type CredentialVault,
  type OAuthCredential,
  type SignInFlow,
  type SignInSnapshot,
} from "../../src/auth/index.ts"
import { RUNRAIL_USER_AGENT } from "../../src/providers/http.ts"
import { CANARY, freePort, startMockOAuthServer, type MockOAuthServer } from "../fixtures/mock-oauth-server.ts"

interface Harness {
  readonly mock: MockOAuthServer
  readonly manager: SignInManager
  readonly broker: VaultCredentialBroker
  readonly vault: CredentialVault
  readonly accounts: AccountStore
  readonly port: number
  readonly close: () => Promise<void>
}

async function harness(options: { readonly flows?: (mock: MockOAuthServer, port: number) => SignInFlow[]; readonly vault?: CredentialVault; readonly timeoutMs?: number } = {}): Promise<Harness> {
  const root = await mkdtemp(join("/tmp", "runrail-signin-"))
  const mock = startMockOAuthServer()
  const port = freePort()
  const flows = options.flows?.(mock, port) ?? [
    createChatGptSignIn({ authorizeUrl: mock.authorizeUrl, tokenUrl: mock.tokenUrl, callbackPort: port }),
    createOpenRouterSignIn({ authorizeUrl: mock.keyAuthorizeUrl, keyUrl: mock.keyUrl }),
  ]
  const vault = options.vault ?? new MemoryCredentialVault()
  const accounts = new InMemoryAccountStore()
  const broker = new VaultCredentialBroker({ vault, accounts, lockRoot: join(root, "locks"), refreshers: credentialRefreshersFor(flows) })
  const manager = new SignInManager({ flows, accounts, broker, stateRoot: root, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
  return {
    mock,
    manager,
    broker,
    vault,
    accounts,
    port,
    close: async () => {
      await manager.close()
      await mock.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const running = (snapshot: SignInSnapshot): boolean => snapshot.state === "starting" || snapshot.state === "waiting" || snapshot.state === "finishing"

/** Follows a sign-in to its end through the same long-poll a client uses. */
async function settle(manager: SignInManager, loginId: string): Promise<SignInSnapshot> {
  const deadline = Date.now() + 10_000
  let snapshot = await manager.status(loginId)
  while (running(snapshot) && Date.now() < deadline) snapshot = await manager.status(loginId, snapshot.lastSeq, 1_000)
  return manager.status(loginId)
}

async function signInCode(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof SignInError ? error.code : `unexpected:${String(error)}`
  }
  return "no error"
}

function pageUrl(snapshot: SignInSnapshot): string {
  const event = snapshot.events.find((entry) => entry.type === "open-url")
  if (event === undefined || event.type !== "open-url") throw new Error(`no page to open; state ${snapshot.state} ${snapshot.code ?? ""}`)
  return event.url
}

const types = (snapshot: SignInSnapshot): string[] => snapshot.events.map((event) => event.type)

async function portClosed(port: number): Promise<boolean> {
  try {
    await (await fetch(`http://127.0.0.1:${port}/auth/callback`)).body?.cancel()
    return false
  } catch {
    return true
  }
}

describe("sign-in engine", () => {
  test("only the documented sign-ins are on offer by default, at the vendors' own addresses", () => {
    const flows = defaultSignInFlows()
    expect(flows.map((flow) => [flow.id, flow.preset, flow.kind, flow.authMode, flow.unofficial, flow.browserHosts])).toEqual([
      ["chatgpt", "openai", "browser", "oauth", false, ["auth.openai.com"]],
      ["openrouter", "openrouter", "browser", "api-key", false, ["openrouter.ai"]],
    ])
    expect(Object.keys(credentialRefreshersFor(flows))).toEqual(["openai"])
  })

  test("ChatGPT: the browser comes back by itself and the tokens go to the vault only", async () => {
    const h = await harness()
    try {
      expect(h.manager.list()).toMatchObject([{ id: "chatgpt", preset: "openai", browserHosts: ["127.0.0.1"] }, { id: "openrouter" }])
      const started = await h.manager.start("chatgpt")
      expect(started).toMatchObject({ flow: "chatgpt", preset: "openai", accountId: "signin-chatgpt", state: "waiting", acceptsInput: true })
      expect(started.loginId).toMatch(/^login-[0-9a-f-]{36}$/)
      expect(types(started)).toEqual(["open-url", "waiting"])
      expect(started.events[0]).toMatchObject({ type: "open-url", redirect: "loopback" })
      expect(started.expiresAt - started.startedAt).toBe(600_000)

      const url = new URL(pageUrl(started))
      expect(`${url.origin}${url.pathname}`).toBe(h.mock.authorizeUrl)
      const query = Object.fromEntries(url.searchParams)
      expect(query).toMatchObject({
        client_id: "dynamic_agent_client",
        agent_name_hint: "Runrail",
        response_type: "code",
        redirect_uri: `http://127.0.0.1:${h.port}/auth/callback`,
        resource: "https://api.openai.com/v1",
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        code_challenge_method: "S256",
      })
      expect(query.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(query.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(query.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(query.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
      // Nothing exists until the vendor has answered.
      expect(await h.accounts.get("signin-chatgpt")).toBeUndefined()

      const page = await h.mock.visit(url.toString())
      expect(page.status).toBe(200)
      expect(await page.text()).toContain("Sign-in received")

      const done = await settle(h.manager, started.loginId)
      expect(done).toMatchObject({ state: "done", acceptsInput: false })
      expect(done.code).toBeUndefined()
      expect(types(done)).toEqual(["open-url", "waiting", "finishing", "done"])
      expect(done.events[3]).toMatchObject({ type: "done", accountId: "signin-chatgpt" })
      // What a client can read never holds a token or the one-time code.
      expect(JSON.stringify([started, done])).not.toContain(CANARY)

      const stored = (await h.vault.get("signin-chatgpt")) as OAuthCredential
      expect(stored.kind).toBe("oauth")
      expect(stored.access).toContain(`access-${CANARY}`)
      expect(stored.refresh).toContain(`refresh-${CANARY}`)
      expect(stored.clientId).toMatch(/^issued-/)
      expect(stored.scopes).toContain("chatgpt.tokens.use.direct")
      expect(stored.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)

      const account = (await h.accounts.get("signin-chatgpt"))!
      expect(account).toMatchObject({ status: "ready", reference: { provider: "openai", label: "ChatGPT", authMode: "oauth" } })
      // The account must not carry an expiry: the broker renews the token, the account stays usable.
      expect(account.expiresAt).toBeUndefined()
      expect(JSON.stringify(account)).not.toContain(CANARY)
      expect((await h.broker.resolve(account.reference)).secret).toBe(stored.access)

      // The exchange carried the verifier and the issued client id, under Runrail's own name.
      const exchange = h.mock.requests.find((request) => request.path === "/token")!
      expect(exchange.fields).toMatchObject({ grant_type: "authorization_code", client_id: stored.clientId!, redirect_uri: `http://127.0.0.1:${h.port}/auth/callback`, resource: "https://api.openai.com/v1" })
      expect(exchange.fields.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      for (const request of h.mock.requests.filter((entry) => entry.method === "POST")) {
        expect(request.userAgent).toBe(RUNRAIL_USER_AGENT)
        expect(request.originator).toBe("runrail")
      }
      expect(await portClosed(h.port)).toBe(true)
    } finally {
      await h.close()
    }
  })

  test("a stored sign-in is renewed with the issued client id; a spent refresh token means sign in again", async () => {
    const h = await harness()
    try {
      const started = await h.manager.start("chatgpt")
      await h.mock.visit(pageUrl(started))
      expect((await settle(h.manager, started.loginId)).state).toBe("done")
      const reference = (await h.accounts.get("signin-chatgpt"))!.reference
      const first = (await h.vault.get("signin-chatgpt")) as OAuthCredential
      const lapse = async (credential: OAuthCredential, expiresAt: number): Promise<void> => h.vault.set("signin-chatgpt", { ...credential, expiresAt })

      // The service is down: the token in hand still works, so it is kept and nothing is marked.
      h.mock.plan.refresh = "server-error"
      await lapse(first, Date.now() + 60_000)
      expect((await h.broker.resolve(reference)).secret).toBe(first.access)
      expect((await h.accounts.get("signin-chatgpt"))!.status).toBe("ready")

      h.mock.plan.refresh = "grant"
      const renewed = await h.broker.resolve(reference)
      expect(renewed.secret).not.toBe(first.access)
      const second = (await h.vault.get("signin-chatgpt")) as OAuthCredential
      expect(second.access).toBe(renewed.secret)
      expect(second.refresh).not.toBe(first.refresh)
      expect(second.clientId).toBe(first.clientId)
      const refresh = h.mock.requests.filter((request) => request.fields.grant_type === "refresh_token").at(-1)!
      expect(refresh.fields).toMatchObject({ client_id: first.clientId!, refresh_token: first.refresh!, resource: "https://api.openai.com/v1" })
      expect(refresh.userAgent).toBe(RUNRAIL_USER_AGENT)
      expect(refresh.originator).toBe("runrail")

      // The first refresh token is spent. Presenting it again is refused for good.
      await lapse(first, Date.now() - 1)
      await expect(h.broker.resolve(reference)).rejects.toMatchObject({ code: "ACCOUNT_EXPIRED" })
      expect(await h.accounts.get("signin-chatgpt")).toMatchObject({ status: "expired", statusCode: "SIGN_IN_REJECTED" })

      // Signing in again puts the same account back to work.
      const again = await h.manager.start("chatgpt")
      await h.mock.visit(pageUrl(again))
      expect((await settle(h.manager, again.loginId)).state).toBe("done")
      expect((await h.accounts.get("signin-chatgpt"))!.status).toBe("ready")
      const third = (await h.vault.get("signin-chatgpt")) as OAuthCredential
      expect((await h.broker.resolve(reference)).secret).toBe(third.access)
    } finally {
      await h.close()
    }
  })

  test("a redirect with the wrong state is refused and the sign-in keeps waiting for the right one", async () => {
    const h = await harness()
    try {
      const started = await h.manager.start("chatgpt")
      h.mock.plan.authorize = "wrong-state"
      const refused = await h.mock.visit(pageUrl(started))
      expect(refused.status).toBe(400)
      expect(await refused.text()).toContain("Sign-in not recognised")
      // Not even an error from someone else's page can end it.
      const forged = await fetch(`http://127.0.0.1:${h.port}/auth/callback?error=access_denied&state=guess`)
      expect(forged.status).toBe(400)
      await forged.body?.cancel()
      expect(await h.manager.status(started.loginId)).toMatchObject({ state: "waiting", acceptsInput: true })
      expect(h.mock.requests.some((request) => request.path === "/token")).toBe(false)

      // No client id in the redirect: nothing to exchange with.
      h.mock.plan.authorize = "no-client-id"
      expect((await h.mock.visit(pageUrl(started))).status).toBe(400)
      expect((await h.manager.status(started.loginId)).state).toBe("waiting")

      h.mock.plan.authorize = "grant"
      expect((await h.mock.visit(pageUrl(started))).status).toBe(200)
      expect((await settle(h.manager, started.loginId)).state).toBe("done")
    } finally {
      await h.close()
    }
  })

  test("a sign-in the vendor does not grant or complete stores nothing and creates no account", async () => {
    const cases = [
      ["denied", "grant", "AUTH_DENIED", 400],
      ["grant", "expired-code", "AUTH_CODE_REJECTED", 200],
      ["grant", "missing-scope", "AUTH_SCOPE_MISSING", 200],
      ["grant", "missing-id-token", "AUTH_RESPONSE_INVALID", 200],
      ["grant", "server-error", "AUTH_NETWORK", 200],
    ] as const
    for (const [authorize, token, code, pageStatus] of cases) {
      const h = await harness()
      try {
        h.mock.plan.authorize = authorize
        h.mock.plan.token = token
        const started = await h.manager.start("chatgpt")
        expect((await h.mock.visit(pageUrl(started))).status).toBe(pageStatus)
        const ended = await settle(h.manager, started.loginId)
        expect(ended).toMatchObject({ state: "failed", code, acceptsInput: false })
        expect(ended.events.at(-1)).toMatchObject({ type: "failed", code })
        expect(JSON.stringify(ended)).not.toContain(CANARY)
        expect(await h.vault.get("signin-chatgpt")).toBeUndefined()
        expect(await h.accounts.get("signin-chatgpt")).toBeUndefined()
        expect(await portClosed(h.port)).toBe(true)
      } finally {
        await h.close()
      }
    }
  })

  test("an id token another service issued, for another client or sign-in, or expired, stores nothing", async () => {
    for (const idToken of ["other-issuer", "other-audience", "expired", "other-nonce", "not-a-jwt"] as const) {
      const h = await harness()
      try {
        h.mock.plan.idToken = idToken
        const started = await h.manager.start("chatgpt")
        expect((await h.mock.visit(pageUrl(started))).status).toBe(200)
        const ended = await settle(h.manager, started.loginId)
        expect(ended).toMatchObject({ state: "failed", code: "AUTH_RESPONSE_INVALID" })
        expect(JSON.stringify(ended)).not.toContain(CANARY)
        expect(await h.vault.get("signin-chatgpt")).toBeUndefined()
        expect(await h.accounts.get("signin-chatgpt")).toBeUndefined()
      } finally {
        await h.close()
      }
    }
    // The nonce the browser was sent with is the one the token must echo.
    const h = await harness()
    try {
      const started = await h.manager.start("chatgpt")
      expect(new URL(pageUrl(started)).searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    } finally {
      await h.close()
    }
  })

  test("with the callback port taken, the user pastes the address they landed on", async () => {
    const h = await harness()
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: h.port, fetch: () => new Response("someone else") })
    try {
      const started = await h.manager.start("chatgpt")
      expect(started).toMatchObject({ state: "waiting", acceptsInput: true })
      expect(started.events[0]).toMatchObject({ type: "open-url", redirect: "manual", notice: "AUTH_PORT_BUSY" })
      const landed = await h.mock.approve(pageUrl(started))
      const query = new URL(landed).search

      const refusals: readonly (readonly [string, string])[] = [
        ["", "AUTH_INPUT_INVALID"],
        ["just some text", "AUTH_INPUT_INVALID"],
        [`https://127.0.0.1:${h.port}/auth/callback${query}`, "AUTH_INPUT_INVALID"],
        [`http://evil.example.test/auth/callback${query}`, "AUTH_INPUT_INVALID"],
        [`http://127.0.0.1:${h.port + 1}/auth/callback${query}`, "AUTH_INPUT_INVALID"],
        [`http://127.0.0.1:${h.port}/other${query}`, "AUTH_INPUT_INVALID"],
        [landed.replace(/state=[^&]+/, "state=guess"), "AUTH_STATE_MISMATCH"],
        [landed.replace(/&client_id=[^&]+/, ""), "AUTH_INPUT_INVALID"],
        // A bare code is not enough for a sign-in that checks state.
        [new URL(landed).searchParams.get("code")!, "AUTH_INPUT_INVALID"],
        ["x".repeat(9 * 1024), "AUTH_INPUT_INVALID"],
      ]
      for (const [input, code] of refusals) expect([input.slice(0, 40), await signInCode(() => h.manager.submit(started.loginId, input))]).toEqual([input.slice(0, 40), code])
      expect(await h.manager.status(started.loginId)).toMatchObject({ state: "waiting", acceptsInput: true })

      const taken = h.manager.submit(started.loginId, `  ${landed}\n`)
      expect(JSON.stringify(taken)).not.toContain(CANARY)
      expect(await signInCode(() => h.manager.submit(started.loginId, landed))).toBe("AUTH_LOGIN_FINISHED")
      const done = await settle(h.manager, started.loginId)
      expect(done.state).toBe("done")
      expect(JSON.stringify(done)).not.toContain(CANARY)
      expect(((await h.vault.get("signin-chatgpt")) as OAuthCredential).access).toContain(CANARY)
      expect(await signInCode(() => h.manager.submit(started.loginId, landed))).toBe("AUTH_LOGIN_FINISHED")
    } finally {
      await squatter.stop(true)
      await h.close()
    }
  })

  test("the pasted query string alone is accepted", async () => {
    const h = await harness()
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: h.port, fetch: () => new Response("someone else") })
    try {
      const started = await h.manager.start("chatgpt")
      h.manager.submit(started.loginId, new URL(await h.mock.approve(pageUrl(started))).search)
      expect((await settle(h.manager, started.loginId)).state).toBe("done")
    } finally {
      await squatter.stop(true)
      await h.close()
    }
  })

  test("cancel, a second start, and shutdown each close the listener and store nothing", async () => {
    const h = await harness()
    try {
      const first = await h.manager.start("chatgpt")
      expect(await portClosed(h.port)).toBe(false)
      const cancelled = await h.manager.cancel(first.loginId)
      expect(cancelled).toMatchObject({ state: "cancelled", code: "AUTH_CANCELLED", acceptsInput: false })
      expect(cancelled.events.at(-1)).toMatchObject({ type: "failed", code: "AUTH_CANCELLED" })
      expect(await portClosed(h.port)).toBe(true)
      // Cancelling what is already over changes nothing.
      expect((await h.manager.cancel(first.loginId)).lastSeq).toBe(cancelled.lastSeq)
      expect(await signInCode(() => h.manager.submit(first.loginId, "code=x"))).toBe("AUTH_LOGIN_FINISHED")
      expect(await signInCode(() => h.manager.status("login-00000000-0000-0000-0000-000000000000"))).toBe("AUTH_LOGIN_NOT_FOUND")
      expect(await signInCode(() => h.manager.cancel("login-00000000-0000-0000-0000-000000000000"))).toBe("AUTH_LOGIN_NOT_FOUND")

      // A late redirect for the cancelled sign-in finds nobody.
      const second = await h.manager.start("chatgpt")
      const third = await h.manager.start("chatgpt")
      expect((await h.manager.status(second.loginId)).state).toBe("cancelled")
      // The newer sign-in got the port the older one held.
      expect(third.events[0]).toMatchObject({ type: "open-url", redirect: "loopback" })
      expect((await h.mock.visit(pageUrl(second))).status).toBe(400)
      expect((await h.manager.status(third.loginId)).state).toBe("waiting")

      await h.manager.close()
      expect((await h.manager.status(third.loginId)).state).toBe("cancelled")
      expect(await portClosed(h.port)).toBe(true)
      expect(await signInCode(() => h.manager.start("chatgpt"))).toBe("AUTH_UNAVAILABLE")
      expect(await h.vault.get("signin-chatgpt")).toBeUndefined()
      expect(await h.accounts.get("signin-chatgpt")).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  test("a sign-in nobody finishes times out and frees its port", async () => {
    const h = await harness({ timeoutMs: 150 })
    try {
      const started = await h.manager.start("chatgpt")
      expect(started.expiresAt - started.startedAt).toBe(150)
      const ended = await settle(h.manager, started.loginId)
      expect(ended).toMatchObject({ state: "failed", code: "AUTH_TIMEOUT" })
      expect(await portClosed(h.port)).toBe(true)
    } finally {
      await h.close()
    }
  })

  test("OpenRouter: a private callback path stands in for state, and the key is stored like a pasted key", async () => {
    const h = await harness()
    try {
      const started = await h.manager.start("openrouter", { accountId: "or-work", label: "OpenRouter (work)" })
      expect(started).toMatchObject({ flow: "openrouter", preset: "openrouter", accountId: "or-work", state: "waiting" })
      expect(started.expiresAt - started.startedAt).toBe(300_000)
      const url = new URL(pageUrl(started))
      const callback = new URL(url.searchParams.get("callback_url")!)
      expect(callback.hostname).toBe("127.0.0.1")
      expect(callback.pathname).toMatch(/^\/oauth\/callback\/[0-9a-f-]{36}$/)
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.has("state")).toBe(false)

      // A page that does not know the path cannot reach the sign-in.
      const guess = await fetch(`${callback.origin}/oauth/callback?code=guess`)
      expect(guess.status).toBe(404)
      await guess.body?.cancel()
      const other = await fetch(`${callback.origin}/oauth/callback/00000000-0000-0000-0000-000000000000?error=denied`)
      expect(other.status).toBe(404)
      await other.body?.cancel()
      expect((await h.manager.status(started.loginId)).state).toBe("waiting")

      expect((await h.mock.visit(url.toString())).status).toBe(200)
      const done = await settle(h.manager, started.loginId)
      expect(done.state).toBe("done")
      expect(JSON.stringify(done)).not.toContain(CANARY)
      const stored = await h.vault.get("or-work")
      expect(stored).toMatchObject({ kind: "api-key" })
      expect(stored?.kind === "api-key" ? stored.secret : "").toContain(`sk-or-${CANARY}`)
      expect(await h.accounts.get("or-work")).toMatchObject({ status: "ready", reference: { provider: "openrouter", label: "OpenRouter (work)", authMode: "api-key" } })
      const exchange = h.mock.requests.find((request) => request.path === "/api/v1/auth/keys")!
      expect(exchange.fields).toMatchObject({ code_challenge_method: "S256" })
      expect(exchange.userAgent).toBe(RUNRAIL_USER_AGENT)
      expect(exchange.originator).toBe("runrail")

      for (const [plan, code] of [["rejected", "AUTH_CODE_REJECTED"], ["no-key", "AUTH_RESPONSE_INVALID"]] as const) {
        h.mock.plan.key = plan
        const next = await h.manager.start("openrouter", { accountId: `or-${plan}` })
        await h.mock.visit(pageUrl(next))
        const ended = await settle(h.manager, next.loginId)
        expect(ended).toMatchObject({ state: "failed", code })
        expect(JSON.stringify(ended)).not.toContain(CANARY)
        expect(await h.accounts.get(`or-${plan}`)).toBeUndefined()
      }
    } finally {
      await h.close()
    }
  })

  test("a bare code can be pasted only where no state and no extra field is expected", async () => {
    const h = await harness()
    try {
      const started = await h.manager.start("openrouter")
      const landed = new URL(await h.mock.approve(pageUrl(started)))
      h.manager.submit(started.loginId, landed.searchParams.get("code")!)
      expect((await settle(h.manager, started.loginId)).state).toBe("done")
      expect(await h.vault.get("signin-openrouter")).toMatchObject({ kind: "api-key" })
    } finally {
      await h.close()
    }
  })

  const deviceFlow = (mock: MockOAuthServer, hosts: readonly string[] = ["127.0.0.1"]): SignInFlow =>
    createDeviceCodeSignIn(
      {
        id: "mock-device",
        label: "Mock device sign-in",
        preset: "xai",
        authMode: "device",
        unofficial: true,
        deviceUrl: mock.deviceUrl,
        tokenUrl: mock.tokenUrl,
        clientId: "mock-device-client",
        scope: "api",
        verificationHosts: hosts,
        refresher: createRefreshTokenRefresher({ tokenUrl: mock.tokenUrl, clientId: "mock-device-client" }),
      },
      { minIntervalMs: 20, defaultIntervalMs: 40, slowDownMs: 160 },
    )

  test("a sign-in with many updates keeps the newest of them and still reaches its outcome", async () => {
    const chatty: SignInFlow = {
      id: "chatty",
      label: "Chatty",
      preset: "openrouter",
      authMode: "api-key",
      kind: "device-code",
      browserHosts: ["127.0.0.1"],
      unofficial: true,
      run: async (session) => {
        for (let index = 0; index < 40; index += 1) session.emit({ type: "device-code", userCode: `CODE-${String(index)}`, verificationUrl: "http://127.0.0.1/activate", expiresAt: session.now() + 60_000 })
        session.emit({ type: "finishing" })
        return { kind: "api-key", secret: "sk-or-fixture-key" }
      },
    }
    const h = await harness({ flows: () => [chatty] })
    try {
      const started = await h.manager.start("chatty")
      const done = await settle(h.manager, started.loginId)
      expect(done.state).toBe("done")
      expect(done.events.length).toBeLessThanOrEqual(32)
      expect(types(done).slice(-2)).toEqual(["finishing", "done"])
      expect(done.events.some((event) => (event as { userCode?: string }).userCode === "CODE-39")).toBe(true)
    } finally {
      await h.close()
    }
  })

  test("device code: shows the code, waits between polls, and slows down when told to", async () => {
    const h = await harness({ flows: (mock) => [deviceFlow(mock)] })
    try {
      h.mock.plan.device = ["authorization_pending", "slow_down", "slow_down-named"]
      const started = await h.manager.start("mock-device")
      expect(h.manager.list()).toMatchObject([{ id: "mock-device", kind: "device-code", authMode: "device", unofficial: true, browserHosts: ["127.0.0.1"] }])
      expect(started).toMatchObject({ state: "waiting", acceptsInput: false })
      expect(started.events[0]).toMatchObject({ type: "device-code", userCode: "WDJB-MJHT", verificationUrl: `${h.mock.origin}/activate?user_code=WDJB-MJHT` })
      expect(JSON.stringify(started)).not.toContain(CANARY)
      expect(await signInCode(() => h.manager.submit(started.loginId, "code=x"))).toBe("AUTH_INPUT_INVALID")

      const done = await settle(h.manager, started.loginId)
      expect(done.state).toBe("done")
      expect(types(done)).toEqual(["device-code", "waiting", "finishing", "done"])
      expect(JSON.stringify(done)).not.toContain(CANARY)

      const device = h.mock.requests.find((request) => request.path === "/device")!
      expect(device.fields).toEqual({ client_id: "mock-device-client", scope: "api" })
      const polls = h.mock.requests.filter((request) => request.path === "/token")
      expect(polls).toHaveLength(4)
      expect(polls[0]!.fields).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "mock-device-client" })
      // It waits before the first poll, adds to the wait on `slow_down`, and takes the wait the service names.
      expect(polls[0]!.at - device.at).toBeGreaterThanOrEqual(35)
      expect(polls[1]!.at - polls[0]!.at).toBeLessThan(150)
      expect(polls[2]!.at - polls[1]!.at).toBeGreaterThanOrEqual(190)
      expect(polls[3]!.at - polls[2]!.at).toBeGreaterThanOrEqual(190)
      for (const request of h.mock.requests) {
        expect(request.userAgent).toBe(RUNRAIL_USER_AGENT)
        expect(request.originator).toBe("runrail")
      }

      expect(await h.accounts.get("signin-mock-device")).toMatchObject({ status: "ready", reference: { provider: "xai", authMode: "device" } })
      const stored = (await h.vault.get("signin-mock-device")) as OAuthCredential
      expect(stored.access).toContain(CANARY)
      // Its refresher is wired by preset: a lapsed token is renewed without the user.
      await h.vault.set("signin-mock-device", { ...stored, expiresAt: Date.now() - 1 })
      const renewed = await h.broker.resolve((await h.accounts.get("signin-mock-device"))!.reference)
      expect(renewed.secret).not.toBe(stored.access)
    } finally {
      await h.close()
    }
  })

  test("device code: denied, expired, lapsed, and cancelled sign-ins end with their own code", async () => {
    const cases: readonly (readonly [string, (mock: MockOAuthServer) => void, string, "failed" | "cancelled"])[] = [
      ["denied", (mock) => void (mock.plan.device = ["authorization_pending", "access_denied"]), "AUTH_DENIED", "failed"],
      ["expired", (mock) => void (mock.plan.device = ["expired_token"]), "AUTH_EXPIRED", "failed"],
      ["lapsed", (mock) => void ((mock.plan.deviceExpiresIn = 0.1), (mock.plan.device = Array.from({ length: 50 }, () => "authorization_pending" as const))), "AUTH_EXPIRED", "failed"],
      ["cancelled", (mock) => void (mock.plan.device = Array.from({ length: 500 }, () => "authorization_pending" as const)), "AUTH_CANCELLED", "cancelled"],
    ]
    for (const [name, plan, code, state] of cases) {
      const h = await harness({ flows: (mock) => [deviceFlow(mock)] })
      try {
        plan(h.mock)
        const started = await h.manager.start("mock-device")
        expect(started.state).toBe("waiting")
        if (name === "cancelled") {
          const polledBefore = h.mock.requests.length
          await h.manager.cancel(started.loginId)
          await Bun.sleep(120)
          // Polling stopped with the cancel.
          expect(h.mock.requests.length).toBeLessThanOrEqual(polledBefore + 1)
        }
        const ended = await settle(h.manager, started.loginId)
        expect([name, ended.state, ended.code]).toEqual([name, state, code])
        expect(await h.vault.get("signin-mock-device")).toBeUndefined()
        expect(await h.accounts.get("signin-mock-device")).toBeUndefined()
      } finally {
        await h.close()
      }
    }
  })

  test("device code: a page on an unexpected host is never shown", async () => {
    const h = await harness({ flows: (mock) => [deviceFlow(mock, ["login.example.test"])] })
    try {
      const started = await h.manager.start("mock-device")
      expect(started).toMatchObject({ state: "failed", code: "AUTH_RESPONSE_INVALID" })
      expect(types(started)).toEqual(["failed"])
    } finally {
      await h.close()
    }
  })

  test("a sign-in writes only to an account of the same provider and kind", async () => {
    const h = await harness()
    try {
      const account = (reference: Record<string, unknown>, status = "ready") => parseAccountRecord({ reference: { accountId: "signin-chatgpt", provider: "openai", label: "Mine", authMode: "oauth", scopes: [], createdAt: 1, updatedAt: 1, ...reference }, status })
      expect(await signInCode(() => h.manager.start("nope"))).toBe("AUTH_FLOW_UNKNOWN")
      expect(await signInCode(() => h.manager.start("chatgpt", { accountId: "bad id" }))).toBe("AUTH_INVALID")
      expect(await signInCode(() => h.manager.start("chatgpt", { label: "" }))).toBe("AUTH_INVALID")

      // A pasted-key account for the same provider must not silently become a sign-in.
      await h.accounts.put(account({ authMode: "api-key" }))
      expect(await signInCode(() => h.manager.start("chatgpt"))).toBe("AUTH_ACCOUNT_MISMATCH")
      // Another provider's account would send the token somewhere else.
      await h.accounts.put(account({ provider: "deepseek" }))
      expect(await signInCode(() => h.manager.start("chatgpt"))).toBe("AUTH_ACCOUNT_MISMATCH")
      await h.accounts.put(account({ provider: "openai-compatible", preset: "custom-openai-chat", baseUrl: "https://relay.example.test/v1" }))
      expect(await signInCode(() => h.manager.start("chatgpt"))).toBe("AUTH_ACCOUNT_MISMATCH")
      expect(h.mock.requests).toHaveLength(0)
      expect(await portClosed(h.port)).toBe(true)

      // A matching account keeps its label; a revoked one is replaced.
      await h.accounts.put(account({ label: "My ChatGPT" }, "unconfigured"))
      const reuse = await h.manager.start("chatgpt", { label: "ignored" })
      await h.mock.visit(pageUrl(reuse))
      expect((await settle(h.manager, reuse.loginId)).state).toBe("done")
      expect(await h.accounts.get("signin-chatgpt")).toMatchObject({ status: "ready", reference: { label: "My ChatGPT", createdAt: 1 } })

      await h.accounts.put(account({ provider: "deepseek", authMode: "api-key" }, "revoked"))
      const replace = await h.manager.start("chatgpt")
      await h.mock.visit(pageUrl(replace))
      expect((await settle(h.manager, replace.loginId)).state).toBe("done")
      expect(await h.accounts.get("signin-chatgpt")).toMatchObject({ status: "ready", reference: { provider: "openai", authMode: "oauth", label: "ChatGPT" } })
    } finally {
      await h.close()
    }
  })

  test("when the vault cannot keep the result, no half-made account is left behind", async () => {
    const inner = new MemoryCredentialVault()
    const failing: CredentialVault = {
      kind: "memory",
      get: (id) => inner.get(id),
      set: async () => {
        throw new VaultError("VAULT_UNAVAILABLE", "vault is locked")
      },
      delete: (id) => inner.delete(id),
    }
    const h = await harness({ vault: failing })
    try {
      const started = await h.manager.start("chatgpt")
      await h.mock.visit(pageUrl(started))
      const ended = await settle(h.manager, started.loginId)
      expect(ended).toMatchObject({ state: "failed", code: "AUTH_STORE_FAILED" })
      expect(JSON.stringify(ended)).not.toContain(CANARY)
      expect(await h.accounts.get("signin-chatgpt")).toBeUndefined()

      // A revoked account that was in the way is put back as it was.
      const revoked = parseAccountRecord({ reference: { accountId: "signin-chatgpt", provider: "deepseek", label: "Old", authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1 }, status: "revoked" })
      await h.accounts.put(revoked)
      const again = await h.manager.start("chatgpt")
      await h.mock.visit(pageUrl(again))
      expect((await settle(h.manager, again.loginId)).code).toBe("AUTH_STORE_FAILED")
      expect(await h.accounts.get("signin-chatgpt")).toMatchObject({ status: "revoked", reference: { provider: "deepseek", label: "Old" } })
    } finally {
      await h.close()
    }
  })

  test("signing out removes the stored tokens, stops a sign-in in progress, and leaves the account", async () => {
    const h = await harness()
    try {
      const started = await h.manager.start("chatgpt")
      await h.mock.visit(pageUrl(started))
      expect((await settle(h.manager, started.loginId)).state).toBe("done")
      const again = await h.manager.start("chatgpt")
      await h.manager.logout((await h.accounts.get("signin-chatgpt"))!)
      expect((await h.manager.status(again.loginId)).state).toBe("cancelled")
      expect(await h.vault.get("signin-chatgpt")).toBeUndefined()
      expect(await h.accounts.get("signin-chatgpt")).toMatchObject({ status: "unconfigured", statusCode: "SIGNED_OUT" })
      await expect(h.broker.resolve((await h.accounts.get("signin-chatgpt"))!.reference)).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIALS_UNAVAILABLE" })
    } finally {
      await h.close()
    }
  })

  test("only a few sign-ins run at once, and a sign-in id is registered once", async () => {
    const make = (mock: MockOAuthServer, id: string): SignInFlow =>
      createBrowserSignIn({ id, label: id, preset: "openrouter", authMode: "api-key", authorizeUrl: mock.keyAuthorizeUrl, callback: { port: 0, path: "/cb" }, state: false, authorizeParams: (input) => ({ callback_url: input.redirectUri, code_challenge: input.challenge }), exchange: async () => ({ kind: "api-key", secret: "unused" }) })
    const h = await harness({ flows: (mock) => ["a", "b", "c", "d", "e"].map((id) => make(mock, `flow-${id}`)) })
    try {
      for (const id of ["a", "b", "c", "d"]) expect((await h.manager.start(`flow-${id}`)).state).toBe("waiting")
      expect(await signInCode(() => h.manager.start("flow-e"))).toBe("AUTH_LIMIT")
      expect(await signInCode(() => new SignInManager({ flows: [make(h.mock, "same"), make(h.mock, "same")], accounts: h.accounts, broker: h.broker, stateRoot: "/tmp" }))).toBe("AUTH_INVALID")
      expect(await signInCode(() => new SignInManager({ flows: [], accounts: h.accounts, broker: h.broker, stateRoot: "relative" }))).toBe("AUTH_INVALID")
      expect(await signInCode(() => new SignInManager({ flows: [], accounts: h.accounts, broker: h.broker, stateRoot: "/tmp", timeoutMs: 11 * 60_000 }))).toBe("AUTH_INVALID")
      expect(await signInCode(() => createBrowserSignIn({ id: "Bad Id", label: "x", preset: "openrouter", authMode: "api-key", authorizeUrl: h.mock.keyAuthorizeUrl, callback: { port: 0, path: "/cb" }, state: false, authorizeParams: () => ({}), exchange: async () => ({ kind: "api-key", secret: "unused" }) }))).toBe("AUTH_INVALID")
      expect(await signInCode(() => createChatGptSignIn({ tokenUrl: "http://auth.example.test/token" }))).toBe("AUTH_INVALID")
      expect(await signInCode(() => createOpenRouterSignIn({ authorizeUrl: "http://openrouter.example.test/auth" }))).toBe("AUTH_INVALID")
    } finally {
      await h.close()
    }
  })
})
