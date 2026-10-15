import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { InMemoryAccountStore, createAccountCredentialResolver, parseAccountRecord, resolveConnection, type AccountStore } from "../../src/accounts/index.ts"
import {
  MemoryCredentialVault,
  SignInError,
  SignInManager,
  VaultCredentialBroker,
  createDeviceCodeSignIn,
  createRefreshTokenRefresher,
  credentialRefreshersFor,
  defaultSignInFlows,
  type CredentialVault,
  type OAuthCredential,
  type SignInFlow,
  type SignInSnapshot,
} from "../../src/auth/index.ts"
import { signInPost } from "../../src/auth/signin-http.ts"
import { createKimiSignIn, createMetaSignIn, createXaiSignIn, vendorSignInFlows } from "../../src/auth-vendors.ts"
import { createNativeControlRuntime } from "../../src/control-native.ts"
import * as runrail from "../../src/index.ts"
import { RUNRAIL_USER_AGENT } from "../../src/providers/http.ts"
import { CANARY, startMockOAuthServer, type MockOAuthServer } from "../fixtures/mock-oauth-server.ts"

const FAST = { minIntervalMs: 20, defaultIntervalMs: 40, slowDownMs: 60 }
const HOSTS = ["127.0.0.1"]

interface Harness {
  readonly mock: MockOAuthServer
  readonly manager: SignInManager
  readonly broker: VaultCredentialBroker
  readonly vault: CredentialVault
  readonly accounts: AccountStore
  readonly close: () => Promise<void>
}

async function harness(flows: (mock: MockOAuthServer) => SignInFlow[]): Promise<Harness> {
  const root = await mkdtemp(join("/tmp", "runrail-signin-vendors-"))
  const mock = startMockOAuthServer()
  const registered = flows(mock)
  const vault = new MemoryCredentialVault()
  const accounts = new InMemoryAccountStore()
  const broker = new VaultCredentialBroker({ vault, accounts, lockRoot: join(root, "locks"), refreshers: credentialRefreshersFor(registered) })
  const manager = new SignInManager({ flows: registered, accounts, broker, stateRoot: root })
  return {
    mock,
    manager,
    broker,
    vault,
    accounts,
    close: async () => {
      await manager.close()
      await mock.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const xai = (mock: MockOAuthServer): SignInFlow => createXaiSignIn({ deviceUrl: mock.deviceUrl, tokenUrl: mock.tokenUrl, verificationHosts: HOSTS, timing: FAST })
const kimi = (mock: MockOAuthServer): SignInFlow => createKimiSignIn({ deviceUrl: mock.deviceUrl, tokenUrl: mock.tokenUrl, verificationHosts: HOSTS, timing: FAST })
const meta = (mock: MockOAuthServer): SignInFlow => createMetaSignIn({ deviceUrl: mock.deviceUrl, tokenUrl: mock.tokenUrl, keyUrl: mock.mintUrl, verificationHosts: HOSTS, timing: FAST })

const running = (snapshot: SignInSnapshot): boolean => snapshot.state === "starting" || snapshot.state === "waiting" || snapshot.state === "finishing"

async function settle(manager: SignInManager, loginId: string): Promise<SignInSnapshot> {
  const deadline = Date.now() + 10_000
  let snapshot = await manager.status(loginId)
  while (running(snapshot) && Date.now() < deadline) snapshot = await manager.status(loginId, snapshot.lastSeq, 1_000)
  return manager.status(loginId)
}

async function signIn(h: Harness, flow: string): Promise<SignInSnapshot> {
  const started = await h.manager.start(flow)
  return settle(h.manager, started.loginId)
}

async function stored(h: Harness, accountId: string): Promise<OAuthCredential> {
  const credential = await h.vault.get(accountId)
  if (credential === undefined || credential.kind !== "oauth") throw new Error(`no sign-in stored for ${accountId}`)
  return credential
}

async function failure(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SignInError) return error.code
    return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : `unexpected:${String(error)}`
  }
  return "no error"
}

function expectRunrailNamed(mock: MockOAuthServer): void {
  expect(mock.requests.length).toBeGreaterThan(0)
  for (const request of mock.requests) {
    expect(request.userAgent).toBe(RUNRAIL_USER_AGENT)
    expect(request.originator).toBe("runrail")
  }
}

describe("opt-in sign-ins stay opt-in", () => {
  test("the main entry exports and registers none of them", async () => {
    for (const flow of defaultSignInFlows()) expect(flow.unofficial).toBe(false)
    const optIn = new Set(vendorSignInFlows().map((flow) => flow.id))
    expect(defaultSignInFlows().some((flow) => optIn.has(flow.id))).toBe(false)
    for (const name of ["vendorSignInFlows", "createXaiSignIn", "createKimiSignIn", "createMetaSignIn"]) expect(name in runrail).toBe(false)

    // An engine that is given a vault and no list of sign-ins offers the documented ones only.
    const root = await mkdtemp(join("/tmp", "runrail-signin-default-"))
    try {
      const runtime = createNativeControlRuntime({ stateRoot: root, workspaceRoot: root, projectId: "project", ownerId: "owner", credentialVault: new MemoryCredentialVault() })
      expect(runtime.signInFlows.map((flow) => flow.id)).toEqual(["chatgpt", "openrouter"])
      expect(runtime.signIn?.list().some((flow) => flow.unofficial)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const manifest = await Bun.file(new URL("../../package.json", import.meta.url)).json() as { exports: Record<string, string> }
    expect(manifest.exports["./auth-vendors"]).toBe("./src/auth-vendors.ts")
  })

  test("each is marked unofficial, at the vendor's own addresses, with a preset of its own to renew by", () => {
    const flows = vendorSignInFlows()
    expect(flows.map((flow) => [flow.id, flow.preset, flow.kind, flow.authMode, flow.unofficial, flow.browserHosts])).toEqual([
      ["xai", "xai-grok", "device-code", "device", true, ["accounts.x.ai"]],
      ["kimi", "kimi-code", "device-code", "device", true, ["www.kimi.com"]],
      ["meta", "meta", "device-code", "device", true, ["auth.meta.com"]],
    ])
    expect(Object.isFrozen(flows)).toBe(true)
    // Refreshers are looked up by preset, so no two sign-ins may share one.
    const all = [...defaultSignInFlows(), ...flows]
    const renewing = all.filter((flow) => flow.refresher !== undefined).map((flow) => flow.preset)
    expect(new Set(renewing).size).toBe(renewing.length)
    expect(Object.keys(credentialRefreshersFor(all)).sort()).toEqual(["kimi-code", "meta", "openai", "xai-grok"])

    expect(runrail.getProviderPreset("xai-grok")).toMatchObject({ baseUrl: "https://api.x.ai/v1", protocol: "openai-responses", authStyle: "bearer", signInOnly: true })
    expect(runrail.getProviderPreset("kimi-code")).toMatchObject({ baseUrl: "https://api.kimi.com/coding/v1", protocol: "anthropic-messages", authStyle: "bearer", signInOnly: true })
    expect(runrail.PROVIDER_PRESETS.filter((preset) => preset.signInOnly === true).map((preset) => preset.id)).toEqual(["xai-grok", "kimi-code"])
    // Nothing in the shell is mistaken for a plan sign-in.
    for (const preset of runrail.PROVIDER_PRESETS) if (preset.signInOnly === true) expect(preset.environment).toBeUndefined()
  })
})

describe("xAI plan sign-in", () => {
  test("names Runrail, stores the tokens, and sends them to xAI's own address", async () => {
    const h = await harness((mock) => [xai(mock)])
    try {
      h.mock.plan.device = ["authorization_pending"]
      const done = await signIn(h, "xai")
      expect(done.state).toBe("done")
      expect(done.events.map((event) => event.type)).toEqual(["device-code", "waiting", "finishing", "done"])
      expect(JSON.stringify(done)).not.toContain(CANARY)

      const device = h.mock.requests.find((request) => request.path === "/device")!
      expect(device.fields).toEqual({ client_id: "b1a00492-073a-47ea-816f-4c329264a828", scope: "openid profile email offline_access grok-cli:access api:access", referrer: "runrail" })
      expectRunrailNamed(h.mock)

      const record = (await h.accounts.get("signin-xai"))!
      expect(record).toMatchObject({ status: "ready", reference: { provider: "xai-grok", authMode: "device", label: "xAI (Grok plan)" } })
      const credential = await stored(h, "signin-xai")
      expect(credential.refresh).toContain(CANARY)
      const connection = resolveConnection(record, createAccountCredentialResolver(h.accounts, h.broker))
      expect(connection).toMatchObject({ presetId: "xai-grok", endpoint: "https://api.x.ai/v1", options: { protocol: "responses", authStyle: "bearer", allowedHosts: ["api.x.ai"] } })
      expect((await h.broker.resolve(record.reference)).secret).toBe(credential.access)
    } finally {
      await h.close()
    }
  })

  test("a renewal that rotates nothing keeps the refresh token and assumes an hour", async () => {
    const h = await harness((mock) => [xai(mock)])
    try {
      expect((await signIn(h, "xai")).state).toBe("done")
      const first = await stored(h, "signin-xai")
      await h.vault.set("signin-xai", { ...first, expiresAt: Date.now() - 1 })
      h.mock.plan.refresh = "no-rotation"
      const before = Date.now()
      const lease = await h.broker.resolve((await h.accounts.get("signin-xai"))!.reference)
      const renewed = await stored(h, "signin-xai")
      expect(lease.secret).toBe(renewed.access)
      expect(renewed.access).not.toBe(first.access)
      expect(renewed.refresh).toBe(first.refresh!)
      expect(renewed.expiresAt! - before).toBeGreaterThanOrEqual(3_599_000)
      expect(renewed.expiresAt! - before).toBeLessThanOrEqual(3_605_000)
      expect(h.mock.requests.at(-1)!.fields).toMatchObject({ grant_type: "refresh_token", client_id: "b1a00492-073a-47ea-816f-4c329264a828" })
    } finally {
      await h.close()
    }
  })

  test("xAI's own word for a declined sign-in, and an answer with no refresh token, store nothing", async () => {
    const cases: readonly (readonly [string, (mock: MockOAuthServer) => void, string])[] = [
      ["declined", (mock) => void (mock.plan.device = ["authorization_denied"]), "AUTH_DENIED"],
      ["no refresh token", (mock) => void (mock.plan.deviceGrant = "no-refresh"), "AUTH_RESPONSE_INVALID"],
      ["no lifetime for the code", (mock) => void (mock.plan.deviceExpiresIn = undefined), "AUTH_RESPONSE_INVALID"],
    ]
    for (const [name, plan, code] of cases) {
      const h = await harness((mock) => [xai(mock)])
      try {
        plan(h.mock)
        const ended = await signIn(h, "xai")
        expect([name, ended.state, ended.code]).toEqual([name, "failed", code])
        expect(JSON.stringify(ended)).not.toContain(CANARY)
        expect(await h.vault.get("signin-xai")).toBeUndefined()
        expect(await h.accounts.get("signin-xai")).toBeUndefined()
      } finally {
        await h.close()
      }
    }
  })
})

describe("Kimi Code plan sign-in", () => {
  test("accepts a code with no stated lifetime and sends the token as a Bearer token", async () => {
    const h = await harness((mock) => [kimi(mock)])
    try {
      h.mock.plan.deviceExpiresIn = undefined
      const started = await h.manager.start("kimi")
      const shown = started.events.find((event) => event.type === "device-code")
      if (shown?.type !== "device-code") throw new Error("no code was shown")
      // Fifteen minutes when Kimi names none.
      expect(shown.expiresAt - started.startedAt).toBeGreaterThanOrEqual(899_000)
      expect(shown.expiresAt - started.startedAt).toBeLessThanOrEqual(905_000)
      expect((await settle(h.manager, started.loginId)).state).toBe("done")

      expect(h.mock.requests.find((request) => request.path === "/device")!.fields).toEqual({ client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" })
      expectRunrailNamed(h.mock)
      const record = (await h.accounts.get("signin-kimi"))!
      expect(record).toMatchObject({ status: "ready", reference: { provider: "kimi-code", authMode: "device" } })
      const connection = resolveConnection(record, createAccountCredentialResolver(h.accounts, h.broker))
      expect(connection).toMatchObject({ presetId: "kimi-code", endpoint: "https://api.kimi.com/coding/v1", options: { protocol: "messages", authStyle: "bearer", allowedHosts: ["api.kimi.com"] } })
    } finally {
      await h.close()
    }
  })

  test("a refusal at renewal, by word or by status, means sign in again; trouble on Kimi's side does not", async () => {
    const h = await harness((mock) => [kimi(mock)])
    try {
      expect((await signIn(h, "kimi")).state).toBe("done")
      const reference = (await h.accounts.get("signin-kimi"))!.reference
      const first = await stored(h, "signin-kimi")

      await h.vault.set("signin-kimi", { ...first, expiresAt: Date.now() - 1 })
      h.mock.plan.refresh = "server-error"
      expect(await failure(() => h.broker.resolve(reference))).toBe("ACCOUNT_AUTH_FAILED")
      expect((await h.accounts.get("signin-kimi"))!.status).toBe("ready")

      h.mock.plan.refresh = "unauthorized"
      expect(await failure(() => h.broker.resolve(reference))).toBe("ACCOUNT_EXPIRED")
      expect(await h.accounts.get("signin-kimi")).toMatchObject({ status: "expired", statusCode: "SIGN_IN_REJECTED" })
      expect(JSON.stringify(await h.accounts.get("signin-kimi"))).not.toContain(CANARY)
    } finally {
      await h.close()
    }
  })

  test("the plan address takes its sign-in only; a pasted key belongs on the key row", async () => {
    const accounts = new InMemoryAccountStore()
    const resolver = createAccountCredentialResolver(accounts, { resolve: async () => { throw new Error("not reached") } })
    for (const authMode of ["api-key", "environment"] as const) {
      const record = parseAccountRecord({ reference: { accountId: `kimi-${authMode}`, provider: "kimi-code", label: "Kimi", authMode, scopes: [], ...(authMode === "environment" ? { environmentName: "KIMI_API_KEY" } : {}), createdAt: 1, updatedAt: 1 }, status: "ready" })
      // A shell key is turned away even earlier: `KIMI_API_KEY` belongs to the key row.
      expect(await failure(() => resolveConnection(record, resolver))).toBe(authMode === "api-key" ? "PROVIDER_INVALID" : "PROVIDER_ENDPOINT_DENIED")
    }
    const keyRow = parseAccountRecord({ reference: { accountId: "kimi-key", provider: "kimi-for-coding", label: "Kimi", authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1 }, status: "ready" })
    expect(resolveConnection(keyRow, resolver).options).toMatchObject({ authStyle: "x-api-key" })
  })
})

describe("Meta AI plan sign-in", () => {
  test("trades the identity token for a day-long key and keeps both where they belong", async () => {
    const h = await harness((mock) => [meta(mock)])
    try {
      h.mock.plan.deviceGrant = "identity"
      h.mock.plan.deviceExpiresIn = undefined
      const before = Date.now()
      const done = await signIn(h, "meta")
      expect(done.state).toBe("done")
      expect(JSON.stringify(done)).not.toContain(CANARY)

      expect(h.mock.requests.find((request) => request.path === "/device")!.fields).toEqual({ client_id: "1031625952748946" })
      const mint = h.mock.requests.find((request) => request.path === "/muse-code/key")!
      expect(mint.authorization).toMatch(/^Bearer identity-/)
      expect(mint.apiVersion).toBe("1.0.0")
      expect(mint.fields).toEqual({})
      expectRunrailNamed(h.mock)

      const credential = await stored(h, "signin-meta")
      expect(credential.access).toMatch(/^minted-key-/)
      expect(credential.refresh).toMatch(/^identity-/)
      expect(credential.expiresAt! - before).toBeGreaterThanOrEqual(24 * 3_600_000 - 1_000)
      expect(credential.expiresAt! - before).toBeLessThanOrEqual(24 * 3_600_000 + 10_000)

      const record = (await h.accounts.get("signin-meta"))!
      const connection = resolveConnection(record, createAccountCredentialResolver(h.accounts, h.broker))
      expect(connection).toMatchObject({ presetId: "meta", endpoint: "https://api.meta.ai/v1", options: { protocol: "responses", authStyle: "bearer", allowedHosts: ["api.meta.ai"] } })
      // A request carries the key, never the identity token.
      expect((await h.broker.resolve(record.reference)).secret).toBe(credential.access)
    } finally {
      await h.close()
    }
  })

  test("a lapsed key is minted again from the stored identity token", async () => {
    const h = await harness((mock) => [meta(mock)])
    try {
      h.mock.plan.deviceGrant = "identity"
      expect((await signIn(h, "meta")).state).toBe("done")
      const reference = (await h.accounts.get("signin-meta"))!.reference
      const first = await stored(h, "signin-meta")
      const lapse = async (): Promise<void> => h.vault.set("signin-meta", { ...(await stored(h, "signin-meta")), expiresAt: Date.now() - 1 })

      await lapse()
      const lease = await h.broker.resolve(reference)
      const renewed = await stored(h, "signin-meta")
      expect(lease.secret).toBe(renewed.access)
      expect(renewed.access).not.toBe(first.access)
      expect(renewed.refresh).toBe(first.refresh!)
      expect(h.mock.requests.filter((request) => request.path === "/muse-code/key")).toHaveLength(2)

      // Trouble on Meta's side keeps the sign-in; a refused identity token ends it.
      await lapse()
      h.mock.plan.mint = "server-error"
      expect(await failure(() => h.broker.resolve(reference))).toBe("ACCOUNT_AUTH_FAILED")
      expect((await h.accounts.get("signin-meta"))!.status).toBe("ready")
      h.mock.plan.mint = "unauthorized"
      expect(await failure(() => h.broker.resolve(reference))).toBe("ACCOUNT_EXPIRED")
      expect(await h.accounts.get("signin-meta")).toMatchObject({ status: "expired", statusCode: "SIGN_IN_REJECTED" })
    } finally {
      await h.close()
    }
  })

  test("no key, a refused identity token, and a failing exchange each end with their own code", async () => {
    const cases: readonly (readonly ["no-key" | "unauthorized" | "server-error", string])[] = [
      ["no-key", "AUTH_SCOPE_MISSING"],
      ["unauthorized", "AUTH_CODE_REJECTED"],
      ["server-error", "AUTH_NETWORK"],
    ]
    for (const [mint, code] of cases) {
      const h = await harness((mock) => [meta(mock)])
      try {
        h.mock.plan.deviceGrant = "identity"
        h.mock.plan.mint = mint
        const ended = await signIn(h, "meta")
        expect<unknown[]>([mint, ended.state, ended.code]).toEqual([mint, "failed", code])
        // Neither the identity token nor the page Meta points to reaches a client.
        expect(JSON.stringify(ended)).not.toContain(CANARY)
        expect(JSON.stringify(ended)).not.toContain("billing")
        expect(await h.vault.get("signin-meta")).toBeUndefined()
        expect(await h.accounts.get("signin-meta")).toBeUndefined()
      } finally {
        await h.close()
      }
    }
  })
})

describe("what the opt-in sign-ins added to the building blocks", () => {
  test("an exchange step can add a header but cannot rename Runrail", async () => {
    const mock = startMockOAuthServer()
    try {
      const signal = new AbortController().signal
      await signInPost(new URL(mock.mintUrl), { json: {} }, signal, undefined, { authorization: "Bearer not-a-known-token", "x-api-version": "1.0.0" })
      expect(mock.requests[0]).toMatchObject({ userAgent: RUNRAIL_USER_AGENT, originator: "runrail", authorization: "Bearer not-a-known-token", apiVersion: "1.0.0" })
      const refused: readonly Record<string, string>[] = [{ "user-agent": "SomethingElse/1.0" }, { originator: "another-cli" }, { "User-Agent": "SomethingElse/1.0" }, { cookie: "a=b" }, { "x-note": "line\nbreak" }, { "x-note": "" }]
      for (const headers of refused) expect(await failure(() => signInPost(new URL(mock.mintUrl), { json: {} }, signal, undefined, headers))).toBe("AUTH_INVALID")
      expect(mock.requests).toHaveLength(1)
    } finally {
      await mock.stop()
    }
  })

  test("a descriptor with an unusable lifetime, denial word, or status is refused when it is built", async () => {
    const base = { id: "mock-device", label: "Mock", preset: "xai-grok", authMode: "device" as const, deviceUrl: "https://login.example.test/device", tokenUrl: "https://login.example.test/token", clientId: "client", verificationHosts: ["login.example.test"] }
    expect(await failure(() => createDeviceCodeSignIn({ ...base, defaultExpiresIn: 0 }))).toBe("AUTH_INVALID")
    expect(await failure(() => createDeviceCodeSignIn({ ...base, defaultExpiresIn: Number.NaN }))).toBe("AUTH_INVALID")
    expect(await failure(() => createDeviceCodeSignIn({ ...base, deniedWords: ["Access Denied"] }))).toBe("AUTH_INVALID")
    expect(await failure(() => createDeviceCodeSignIn({ ...base, deniedWords: Array.from({ length: 9 }, (_, index) => `word_${"abcdefghi"[index]}`) }))).toBe("AUTH_INVALID")
    expect(await failure(() => createRefreshTokenRefresher({ tokenUrl: base.tokenUrl, clientId: "client", rejectedStatuses: [500] }))).toBe("AUTH_INVALID")
    expect(await failure(() => createRefreshTokenRefresher({ tokenUrl: base.tokenUrl, clientId: "client", defaultExpiresIn: -1 }))).toBe("AUTH_INVALID")
    expect(createDeviceCodeSignIn({ ...base, defaultExpiresIn: 900, deniedWords: ["authorization_denied"] }).id).toBe("mock-device")
  })
})
