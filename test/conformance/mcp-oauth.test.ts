import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { InMemoryAccountStore } from "../../src/accounts/types.ts"
import { MemoryCredentialVault, SignInManager, VaultCredentialBroker, type SignInSnapshot } from "../../src/auth/index.ts"
import { connectConfiguredMcp } from "../../src/mcp/configured.ts"
import { McpOAuth, discoverMcpOAuth, mcpCredentialId } from "../../src/mcp/oauth.ts"
import { MCP_CANARY, PRESET_APP, startMockMcpOAuth, type MockMcpOAuth } from "../fixtures/mock-mcp-oauth.ts"

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function setup(now: () => number = Date.now) {
  const root = await mkdtemp(join("/tmp", "runrail-mcp-oauth-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const mock = startMockMcpOAuth()
  cleanup.push(() => mock.stop())
  const vault = new MemoryCredentialVault()
  const accounts = new InMemoryAccountStore()
  const broker = new VaultCredentialBroker({ vault, accounts, lockRoot: join(root, "locks") })
  const signIn = new SignInManager({ flows: [], accounts, broker, stateRoot: root })
  cleanup.push(() => signIn.close())
  const oauth = new McpOAuth({ vault, root, now })
  return { root, mock, vault, accounts, signIn, oauth }
}

async function signInTo(signIn: SignInManager, oauth: McpOAuth, mock: MockMcpOAuth): Promise<SignInSnapshot> {
  const { flow, reference } = await oauth.signIn(mock.mcpUrl, "Remote docs", AbortSignal.timeout(10_000))
  const started = await signIn.startFor(flow, reference)
  const page = started.events.find((event) => event.type === "open-url")
  if (page === undefined || page.type !== "open-url") throw new Error(`no page; state ${started.state}`)
  expect(signIn.list().find((entry) => entry.id === flow.id)?.browserHosts).toEqual([new URL(mock.authOrigin).hostname])
  await (await mock.visit(page.url)).text()
  let snapshot = await signIn.status(started.loginId)
  for (let tries = 0; tries < 50 && ["starting", "waiting", "finishing"].includes(snapshot.state); tries += 1) snapshot = await signIn.status(started.loginId, snapshot.lastSeq, 200)
  return snapshot
}

const server = (url: string, extra: Record<string, unknown> = {}) => ({ transport: "http" as const, name: "docs", url, enabled: true, ...extra })

describe("MCP server sign-in", () => {
  test("finds the authorization server the MCP server names, and what it signs in with", async () => {
    const { mock } = await setup()
    const found = await discoverMcpOAuth(`${mock.mcpUrl}#ignored`, AbortSignal.timeout(5_000))
    expect(found).toEqual({
      url: mock.mcpUrl,
      resource: mock.mcpUrl,
      authorizeUrl: `${mock.authOrigin}/authorize`,
      tokenUrl: `${mock.authOrigin}/token`,
      registrationUrl: `${mock.authOrigin}/register`,
      scope: "tools.read",
    })
  })

  test("refuses a server whose sign-in Runrail cannot take part in, or whose metadata names another server", async () => {
    const { mock, oauth } = await setup()
    const codeOf = (work: Promise<unknown>) => work.then(() => "none", (error: { code?: string }) => error.code)
    mock.plan.serverMetadata = "no-pkce"
    expect(await codeOf(discoverMcpOAuth(mock.mcpUrl, AbortSignal.timeout(5_000)))).toBe("AUTH_UNSUPPORTED")
    mock.plan.serverMetadata = "no-registration"
    expect((await discoverMcpOAuth(mock.mcpUrl, AbortSignal.timeout(5_000))).registrationUrl).toBeUndefined()
    expect(await codeOf(oauth.signIn(mock.mcpUrl, "docs", AbortSignal.timeout(5_000)))).toBe("AUTH_CLIENT_REQUIRED")
    mock.plan.serverMetadata = "full"
    mock.plan.resourceMetadata = "other-resource"
    expect(await codeOf(discoverMcpOAuth(mock.mcpUrl, AbortSignal.timeout(5_000)))).toBe("AUTH_RESPONSE_INVALID")
    mock.plan.resourceMetadata = "missing"
    expect(await codeOf(discoverMcpOAuth(mock.mcpUrl, AbortSignal.timeout(5_000)))).toBe("AUTH_UNSUPPORTED")
    expect(await codeOf(discoverMcpOAuth("http://mcp.example.com/mcp", AbortSignal.timeout(5_000)))).toBe("AUTH_INVALID")
  })

  test("signs in, keeps the tokens in the vault only, and connects with them", async () => {
    const { root, mock, vault, oauth, signIn, accounts } = await setup()
    const before = await connectConfiguredMcp([server(mock.mcpUrl)], root, undefined, undefined, {}, oauth)
    expect(before.status).toEqual([{ name: "docs", state: "failed", tools: 0, code: "MCP_SIGN_IN_REQUIRED" }])

    const done = await signInTo(signIn, oauth, mock)
    expect(done).toMatchObject({ state: "done", accountId: mcpCredentialId(mock.mcpUrl), preset: "mcp-oauth" })
    expect(signIn.list()).toEqual([])
    expect(accounts.list()).toEqual([])
    expect(mock.seen.register).toEqual([expect.objectContaining({ client_name: "Runrail", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], scope: "tools.read" })])
    expect(mock.seen.authorize[0]).toMatchObject({ response_type: "code", code_challenge_method: "S256", resource: mock.mcpUrl, scope: "tools.read" })
    expect(mock.seen.token[0]).toMatchObject({ grant_type: "authorization_code", resource: mock.mcpUrl })
    const stored = await vault.get(mcpCredentialId(mock.mcpUrl))
    expect(stored).toMatchObject({ kind: "oauth", clientId: mock.seen.token[0]!.client_id })
    expect(await oauth.list()).toEqual([{ url: mock.mcpUrl, signedIn: true, updatedAt: expect.any(Number) }])
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) expect((await readFile(join(entry.parentPath, entry.name))).includes(MCP_CANARY)).toBe(false)
    }

    const after = await connectConfiguredMcp([server(mock.mcpUrl)], root, undefined, undefined, {}, oauth)
    cleanup.push(() => after.close())
    expect(after.status).toEqual([{ name: "docs", state: "ready", tools: 1 }])
    expect(after.tools.map((tool) => tool.name)).toEqual(["docs.search"])
    expect(mock.seen.mcp.at(-1)).toBe(`Bearer ${(stored as { access: string }).access}`)
  })

  test("a token named in the environment wins over a sign-in, and a refused one says so", async () => {
    const { root, mock, oauth, signIn } = await setup()
    await signInTo(signIn, oauth, mock)
    const configured = await connectConfiguredMcp([server(mock.mcpUrl, { bearerEnv: "DOCS_TOKEN" })], root, undefined, undefined, { DOCS_TOKEN: "not-a-token" }, oauth)
    expect(configured.status).toEqual([{ name: "docs", state: "failed", tools: 0, code: "MCP_TOKEN_REJECTED" }])
    expect(mock.seen.mcp.at(-1)).toBe("Bearer not-a-token")
  })

  test("renews a token about to run out, bound to the same server, and signs out", async () => {
    let clock = Date.now()
    const { mock, oauth, signIn, vault } = await setup(() => clock)
    mock.plan.expiresIn = 600
    await signInTo(signIn, oauth, mock)
    const first = await oauth.token(mock.mcpUrl, AbortSignal.timeout(5_000))
    expect(await oauth.token(mock.mcpUrl, AbortSignal.timeout(5_000))).toBe(first)
    clock += 590_000
    const renewed = await oauth.token(mock.mcpUrl, AbortSignal.timeout(5_000))
    expect(renewed).not.toBe(first)
    expect(mock.seen.token.at(-1)).toMatchObject({ grant_type: "refresh_token", resource: mock.mcpUrl, client_id: mock.seen.token[0]!.client_id })

    expect(await oauth.signOut(mock.mcpUrl)).toBe(true)
    expect(await vault.get(mcpCredentialId(mock.mcpUrl))).toBeUndefined()
    expect(await oauth.stored(mock.mcpUrl)).toBe(false)
    expect(await oauth.list()).toEqual([])
  })

  test("an authorization server that registers no apps signs in with one the person registered, its secret kept in the vault", async () => {
    const { root, mock, oauth, signIn, vault } = await setup()
    mock.plan.serverMetadata = "no-registration"
    const named = await oauth.setClient(mock.mcpUrl, PRESET_APP.id)
    expect(named).toEqual({ id: mcpCredentialId(mock.mcpUrl), url: mock.mcpUrl, client: { id: PRESET_APP.id, secret: false } })
    // Without its secret the token call is refused.
    expect((await signInTo(signIn, oauth, mock)).code).toBe("AUTH_CODE_REJECTED")

    await oauth.setClientSecret(named.id, PRESET_APP.secret)
    expect(await signInTo(signIn, oauth, mock)).toMatchObject({ state: "done" })
    expect(mock.seen.register).toEqual([])
    expect(mock.seen.token.at(-1)).toMatchObject({ grant_type: "authorization_code", client_id: PRESET_APP.id, client_secret: PRESET_APP.secret })
    expect(await oauth.list()).toEqual([{ url: mock.mcpUrl, signedIn: true, updatedAt: expect.any(Number), client: { id: PRESET_APP.id, secret: true } }])
    expect(await readFile(join(root, "mcp-oauth.json"), "utf8")).not.toContain(MCP_CANARY)

    // Signing out keeps the app for the next sign-in; forgetting the app drops its secret too.
    await oauth.signOut(mock.mcpUrl)
    expect(await oauth.list()).toEqual([{ url: mock.mcpUrl, signedIn: false, updatedAt: expect.any(Number), client: { id: PRESET_APP.id, secret: true } }])
    expect(await oauth.clearClient(mock.mcpUrl)).toBe(true)
    expect(await oauth.list()).toEqual([])
    expect(await vault.get(`${named.id}:client`)).toBeUndefined()
    // A different app id never inherits the old app's secret.
    await oauth.setClient(mock.mcpUrl, PRESET_APP.id, 41_234)
    await oauth.setClientSecret(named.id, PRESET_APP.secret)
    expect((await oauth.setClient(mock.mcpUrl, "another-app")).client).toEqual({ id: "another-app", secret: false })
    expect(await vault.get(`${named.id}:client`)).toBeUndefined()
  })

  test("a renewal carries the app's secret when one is kept", async () => {
    let clock = Date.now()
    const { mock, oauth, signIn } = await setup(() => clock)
    mock.plan.serverMetadata = "no-registration"
    mock.plan.expiresIn = 600
    const named = await oauth.setClient(mock.mcpUrl, PRESET_APP.id)
    await oauth.setClientSecret(named.id, PRESET_APP.secret)
    await signInTo(signIn, oauth, mock)
    const first = await oauth.token(mock.mcpUrl, AbortSignal.timeout(5_000))
    clock += 590_000
    expect(await oauth.token(mock.mcpUrl, AbortSignal.timeout(5_000))).not.toBe(first)
    expect(mock.seen.token.at(-1)).toMatchObject({ grant_type: "refresh_token", client_id: PRESET_APP.id, client_secret: PRESET_APP.secret })
  })
})
