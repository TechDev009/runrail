import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { FileCredentialVault, MemoryCredentialVault, createChatGptSignIn, createOpenRouterSignIn, type CredentialVault, type SignInFlow } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { CANARY, freePort, startMockOAuthServer, type MockOAuthServer } from "../fixtures/mock-oauth-server.ts"

type Running = Awaited<ReturnType<typeof startRunrailControlRpcServer>>
interface Snapshot {
  readonly loginId: string
  readonly state: string
  readonly code?: string
  readonly acceptsInput: boolean
  readonly lastSeq: number
  readonly events: readonly { readonly type: string; readonly seq: number; readonly url?: string; readonly redirect?: string; readonly notice?: string }[]
}
interface Reply {
  readonly status: number
  readonly code: string | null
  readonly text: string
  readonly body: { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message?: string } | string }
}

async function send(running: Running, path: "/rpc" | "/login-input", payload: unknown, init: { readonly token?: string | null; readonly method?: string } = {}): Promise<Reply> {
  const token = init.token === undefined ? running.handle.token : init.token
  const method = init.method ?? "POST"
  const response = await fetch(`${running.handle.url}${path}`, {
    method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
  })
  const text = await response.text()
  return { status: response.status, code: response.headers.get("x-runrail-error-code"), text, body: JSON.parse(text) as Reply["body"] }
}

const rpc = (running: Running, method: string, params: Record<string, unknown> = {}): Promise<Reply> => send(running, "/rpc", { method, params })
const paste = (running: Running, payload: unknown): Promise<Reply> => send(running, "/login-input", payload)
const snap = (reply: Reply): Snapshot => reply.body.result as Snapshot
const record = (reply: Reply): Record<string, unknown> => reply.body.result as Record<string, unknown>

function pageUrl(snapshot: Snapshot): string {
  const url = snapshot.events.find((event) => event.type === "open-url")?.url
  if (url === undefined) throw new Error(`no page to open; state ${snapshot.state}`)
  return url
}

/** Follows a sign-in through the long-poll a client uses; returns every reply it read. */
async function settle(running: Running, loginId: string, replies: Reply[] = []): Promise<Snapshot> {
  const deadline = Date.now() + 10_000
  let afterSeq = 0
  for (;;) {
    const reply = await rpc(running, "auth.login.status", { loginId, afterSeq, waitMs: 1_000 })
    replies.push(reply)
    const snapshot = snap(reply)
    if (!["starting", "waiting", "finishing"].includes(snapshot.state) || Date.now() > deadline) break
    afterSeq = snapshot.lastSeq
  }
  const last = await rpc(running, "auth.login.status", { loginId })
  replies.push(last)
  return snap(last)
}

async function eventStreamText(running: Running): Promise<string> {
  const abort = new AbortController()
  const response = await fetch(`${running.handle.url}/events?afterSeq=-1`, { headers: { authorization: `Bearer ${running.handle.token}` }, signal: abort.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const timer = setTimeout(() => abort.abort(), 250)
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    // Aborted after the window.
  } finally {
    clearTimeout(timer)
  }
  return text
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if ((await readFile(path)).includes(needle)) found.push(path)
  }
  return found.sort()
}

/** Everything written to the console while `run` executes. */
async function capturingConsole<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly output: string }> {
  const names = ["log", "info", "warn", "error", "debug"] as const
  const originals = names.map((name) => console[name])
  let output = ""
  for (const name of names) console[name] = (...parts: unknown[]) => void (output += `${parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")}\n`)
  try {
    return { value: await run(), output }
  } finally {
    names.forEach((name, index) => (console[name] = originals[index]!))
  }
}

async function portClosed(port: number): Promise<boolean> {
  try {
    await (await fetch(`http://127.0.0.1:${port}/auth/callback`)).body?.cancel()
    return false
  } catch {
    return true
  }
}

const model = { complete: () => ({ type: "text" as const, text: "ok" }) }

interface Fixture {
  readonly running: Running
  readonly mock: MockOAuthServer
  readonly port: number
  readonly cwd: string
  readonly sessionDir: string
  readonly accountsDir: string
  readonly vaultDir: string
  readonly close: () => Promise<void>
}

async function fixture(options: { readonly vault?: CredentialVault | "none"; readonly flows?: readonly SignInFlow[] } = {}): Promise<Fixture> {
  const cwd = await mkdtemp(join("/tmp", "runrail-signin-cwd-"))
  const sessionDir = await mkdtemp(join("/tmp", "runrail-signin-state-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-signin-accounts-"))
  const vaultDir = join(accountsDir, "vault")
  const mock = startMockOAuthServer()
  const port = freePort()
  const flows = options.flows ?? [createChatGptSignIn({ authorizeUrl: mock.authorizeUrl, tokenUrl: mock.tokenUrl, callbackPort: port }), createOpenRouterSignIn({ authorizeUrl: mock.keyAuthorizeUrl, keyUrl: mock.keyUrl })]
  const vault = options.vault === "none" ? undefined : options.vault ?? new FileCredentialVault({ root: vaultDir })
  const running = await startRunrailControlRpcServer({
    cwd,
    backend: "native",
    sessionDir,
    sessionId: "signin-session",
    loadExtensions: false,
    model,
    nativeAccountsDir: accountsDir,
    nativeSignInFlows: flows,
    ...(vault === undefined ? {} : { nativeCredentialVault: vault }),
  })
  return {
    running,
    mock,
    port,
    cwd,
    sessionDir,
    accountsDir,
    vaultDir,
    close: async () => {
      await running.handle.stop()
      await mock.stop()
      for (const dir of [cwd, sessionDir, accountsDir]) await rm(dir, { recursive: true, force: true })
    },
  }
}

describe("control sign-in", () => {
  test("a sign-in through the control server leaves its tokens in the vault and nowhere a client can read", async () => {
    const f = await fixture()
    try {
      const { value: replies, output } = await capturingConsole(async () => {
        const seen: Reply[] = []
        const health = await (await fetch(`${f.running.handle.url}/health`)).json() as { capabilities: string[]; capabilityStatus: Record<string, string> }
        expect(health.capabilities).toContain("auth.signin")
        expect(health.capabilityStatus["auth.signin"]).toBe("available")

        const flows = await rpc(f.running, "auth.flows")
        seen.push(flows)
        expect(flows.status).toBe(200)
        expect(flows.body.result).toEqual([
          { id: "chatgpt", label: "ChatGPT", preset: "openai", kind: "browser", authMode: "oauth", unofficial: false, browserHosts: ["127.0.0.1"] },
          { id: "openrouter", label: "OpenRouter", preset: "openrouter", kind: "browser", authMode: "api-key", unofficial: false, browserHosts: ["127.0.0.1"] },
        ])

        const started = await rpc(f.running, "auth.login.start", { flow: "chatgpt" })
        seen.push(started)
        expect(started.status).toBe(200)
        expect(snap(started)).toMatchObject({ flow: "chatgpt", preset: "openai", accountId: "signin-chatgpt", state: "waiting", acceptsInput: true })
        expect(snap(started).events[0]).toMatchObject({ type: "open-url", redirect: "loopback" })
        const { loginId } = snap(started)

        // A long-poll with nothing new comes back empty after its wait, and at once when something happens.
        const before = Date.now()
        const idle = await rpc(f.running, "auth.login.status", { loginId, afterSeq: snap(started).lastSeq, waitMs: 300 })
        seen.push(idle)
        expect(Date.now() - before).toBeGreaterThanOrEqual(280)
        expect(snap(idle)).toMatchObject({ state: "waiting", events: [] })
        const waiting = rpc(f.running, "auth.login.status", { loginId, afterSeq: snap(started).lastSeq, waitMs: 20_000 })
        const page = await f.mock.visit(pageUrl(snap(started)))
        expect(page.status).toBe(200)
        expect(await page.text()).toContain("Sign-in received")
        const woken = await waiting
        seen.push(woken)
        expect(Date.now() - before).toBeLessThan(5_000)
        expect(snap(woken).events.length).toBeGreaterThan(0)

        const done = await settle(f.running, loginId, seen)
        expect(done).toMatchObject({ state: "done", acceptsInput: false })
        expect(done.events.map((event) => event.type)).toEqual(["open-url", "waiting", "finishing", "done"])

        const account = await rpc(f.running, "account.get", { accountId: "signin-chatgpt" })
        expect(record(account)).toMatchObject({ status: "ready", reference: { provider: "openai", authMode: "oauth", label: "ChatGPT" } })
        const resolved = await rpc(f.running, "account.resolve", { accountId: "signin-chatgpt" })
        expect(record(resolved)).toMatchObject({ resolved: true })
        seen.push(account, resolved, await rpc(f.running, "account.list"), await rpc(f.running, "connection.detect"))
        return seen
      })

      // The mock handed out real-looking tokens; none of them reached a client, a log or a journal.
      expect(f.mock.issued.length).toBeGreaterThanOrEqual(2)
      for (const reply of replies) expect(reply.text).not.toContain(CANARY)
      expect(output).not.toContain(CANARY)
      expect(await eventStreamText(f.running)).not.toContain(CANARY)
      const holders = [...(await filesContaining(f.sessionDir, CANARY)), ...(await filesContaining(f.accountsDir, CANARY)), ...(await filesContaining(f.cwd, CANARY))]
      expect(holders).toHaveLength(1)
      expect(holders[0]!.startsWith(`${f.vaultDir}/`)).toBe(true)

      // Sign out: the tokens are gone from disk, the account stays for the next sign-in.
      const out = await rpc(f.running, "auth.logout", { accountId: "signin-chatgpt" })
      expect(out.status).toBe(200)
      expect(record(out)).toMatchObject({ status: "unconfigured", statusCode: "SIGNED_OUT", reference: { accountId: "signin-chatgpt" } })
      expect(await filesContaining(f.accountsDir, CANARY)).toEqual([])
      const after = await rpc(f.running, "account.resolve", { accountId: "signin-chatgpt" })
      expect(after.status).toBe(409)
      expect(after.code).toBe("CONTROL_ACCOUNT_CREDENTIALS_UNAVAILABLE")
    } finally {
      await f.close()
    }
  })

  test("with the port taken, the pasted address goes down its own write-only path", async () => {
    const f = await fixture()
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: f.port, fetch: () => new Response("someone else") })
    try {
      const started = snap(await rpc(f.running, "auth.login.start", { flow: "chatgpt", accountId: "chatgpt-work", label: "ChatGPT (work)" }))
      expect(started).toMatchObject({ state: "waiting", acceptsInput: true })
      expect(started.events[0]).toMatchObject({ type: "open-url", redirect: "manual", notice: "AUTH_PORT_BUSY" })
      const { loginId } = started
      const landed = await f.mock.approve(pageUrl(started))
      const unknown = "login-00000000-0000-0000-0000-000000000000"

      const cases: readonly { readonly name: string; readonly reply: Promise<Reply>; readonly status: number; readonly code?: string }[] = [
        { name: "no token", reply: send(f.running, "/login-input", { loginId, input: landed }, { token: null }), status: 401 },
        { name: "wrong token", reply: send(f.running, "/login-input", { loginId, input: landed }, { token: "not-the-token" }), status: 401 },
        { name: "GET", reply: send(f.running, "/login-input", undefined, { method: "GET" }), status: 405 },
        { name: "not JSON", reply: paste(f.running, `{"loginId":"${loginId}","input":"${landed}"`), status: 400, code: "CONTROL_INVALID_JSON" },
        { name: "array body", reply: paste(f.running, [landed]), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "unknown field", reply: paste(f.running, { loginId, input: landed, accountId: "other" }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "missing input", reply: paste(f.running, { loginId }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "non-string input", reply: paste(f.running, { loginId, input: { url: landed } }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "bad login id", reply: paste(f.running, { loginId: "login-1", input: landed }), status: 400, code: "CONTROL_INVALID_INPUT" },
        { name: "unknown login", reply: paste(f.running, { loginId: unknown, input: landed }), status: 404, code: "AUTH_LOGIN_NOT_FOUND" },
        { name: "body over the limit", reply: paste(f.running, { loginId, input: `${landed}${"x".repeat(20 * 1024)}` }), status: 413, code: "CONTROL_BODY_LIMIT" },
        { name: "input over the limit", reply: paste(f.running, { loginId, input: `${landed}${"x".repeat(9 * 1024)}` }), status: 400, code: "AUTH_INPUT_INVALID" },
        { name: "another site's address", reply: paste(f.running, { loginId, input: landed.replace(`127.0.0.1:${f.port}`, "evil.example.test") }), status: 400, code: "AUTH_INPUT_INVALID" },
        { name: "wrong state", reply: paste(f.running, { loginId, input: landed.replace(/state=[^&]+/, "state=guess") }), status: 400, code: "AUTH_STATE_MISMATCH" },
      ]
      const code = new URL(landed).searchParams.get("code")!
      for (const entry of cases) {
        const reply = await entry.reply
        expect({ name: entry.name, status: reply.status }).toEqual({ name: entry.name, status: entry.status })
        if (entry.code !== undefined) expect({ name: entry.name, code: reply.code }).toEqual({ name: entry.name, code: entry.code })
        expect(reply.body.ok).toBe(false)
        // A sign-in failure is a code and one fixed sentence, never the text behind it.
        if (entry.code?.startsWith("AUTH_")) expect(reply.body.error).toEqual({ code: entry.code, message: "sign-in failed" })
        // Nothing of what was pasted comes back.
        expect(reply.text).not.toContain(code)
        expect(reply.text).not.toContain(CANARY)
      }
      // The address is never accepted on the generic path, where params may be journaled.
      const viaRpc = await rpc(f.running, "auth.login.input", { loginId, input: landed })
      expect(viaRpc.body.ok).toBe(false)
      expect(viaRpc.text).not.toContain(code)
      expect(snap(await rpc(f.running, "auth.login.status", { loginId }))).toMatchObject({ state: "waiting", acceptsInput: true })

      const taken = await paste(f.running, { loginId, input: landed })
      expect(taken.status).toBe(200)
      expect(taken.text).not.toContain(CANARY)
      const done = await settle(f.running, loginId)
      expect(done.state).toBe("done")
      const again = await paste(f.running, { loginId, input: landed })
      expect(again.status).toBe(409)
      expect(again.code).toBe("AUTH_LOGIN_FINISHED")
      expect(record(await rpc(f.running, "account.get", { accountId: "chatgpt-work" }))).toMatchObject({ status: "ready", reference: { label: "ChatGPT (work)", provider: "openai", authMode: "oauth" } })

      // The one-time code and the tokens are in the vault directory or nowhere.
      for (const needle of [CANARY, code]) {
        const holders = [...(await filesContaining(f.sessionDir, needle)), ...(await filesContaining(f.accountsDir, needle)), ...(await filesContaining(f.cwd, needle))]
        expect(holders.every((path) => path.startsWith(`${f.vaultDir}/`))).toBe(true)
      }
      expect(await eventStreamText(f.running)).not.toContain(CANARY)
    } finally {
      await squatter.stop(true)
      await f.close()
    }
  })

  test("every sign-in method refuses what it should, with a stable code", async () => {
    const f = await fixture({ vault: new MemoryCredentialVault() })
    try {
      await rpc(f.running, "account.create", { accountId: "account-env", provider: "openai", label: "Env", authMode: "environment", environmentName: "OPENAI_API_KEY", status: "ready" })
      await rpc(f.running, "account.create", { accountId: "account-gone", provider: "openrouter", label: "Gone", authMode: "api-key" })
      await rpc(f.running, "account.revoke", { accountId: "account-gone" })
      await rpc(f.running, "account.create", { accountId: "account-key", provider: "openai", label: "Key", authMode: "api-key" })
      const unknown = "login-00000000-0000-0000-0000-000000000000"
      const live = snap(await rpc(f.running, "auth.login.start", { flow: "openrouter" }))

      const cases: readonly (readonly [string, string, Record<string, unknown>, number, string])[] = [
        ["start: unknown sign-in", "auth.login.start", { flow: "nope" }, 404, "AUTH_FLOW_UNKNOWN"],
        ["start: no flow", "auth.login.start", {}, 400, "CONTROL_INVALID_INPUT"],
        ["start: malformed flow", "auth.login.start", { flow: "Chat GPT" }, 400, "CONTROL_INVALID_INPUT"],
        ["start: a token in params", "auth.login.start", { flow: "chatgpt", token: CANARY }, 400, "CONTROL_INVALID_INPUT"],
        ["start: a refresh token in params", "auth.login.start", { flow: "chatgpt", refreshToken: CANARY }, 400, "CONTROL_INVALID_INPUT"],
        ["start: bad account id", "auth.login.start", { flow: "chatgpt", accountId: "bad id!" }, 400, "CONTROL_INVALID_INPUT"],
        ["start: bad label", "auth.login.start", { flow: "chatgpt", label: 7 }, 400, "CONTROL_INVALID_INPUT"],
        ["start: a pasted-key account", "auth.login.start", { flow: "chatgpt", accountId: "account-key" }, 409, "AUTH_ACCOUNT_MISMATCH"],
        ["start: another provider's account", "auth.login.start", { flow: "chatgpt", accountId: "account-env" }, 409, "AUTH_ACCOUNT_MISMATCH"],
        ["status: malformed id", "auth.login.status", { loginId: "../etc/passwd" }, 400, "CONTROL_INVALID_INPUT"],
        ["status: no id", "auth.login.status", {}, 400, "CONTROL_INVALID_INPUT"],
        ["status: unknown id", "auth.login.status", { loginId: unknown }, 404, "AUTH_LOGIN_NOT_FOUND"],
        ["status: wait over the limit", "auth.login.status", { loginId: live.loginId, waitMs: 20_001 }, 400, "CONTROL_INVALID_INPUT"],
        ["status: negative afterSeq", "auth.login.status", { loginId: live.loginId, afterSeq: -1 }, 400, "CONTROL_INVALID_INPUT"],
        ["cancel: malformed id", "auth.login.cancel", { loginId: 5 }, 400, "CONTROL_INVALID_INPUT"],
        ["cancel: unknown id", "auth.login.cancel", { loginId: unknown }, 404, "AUTH_LOGIN_NOT_FOUND"],
        ["logout: unknown account", "auth.logout", { accountId: "account-missing" }, 404, "CONTROL_ACCOUNT_NOT_FOUND"],
        ["logout: bad account id", "auth.logout", { accountId: "bad id!" }, 400, "CONTROL_INVALID_INPUT"],
        ["logout: revoked account", "auth.logout", { accountId: "account-gone" }, 409, "CONTROL_ACCOUNT_REVOKED"],
        ["logout: environment account", "auth.logout", { accountId: "account-env" }, 400, "CONTROL_INVALID_INPUT"],
      ]
      for (const [name, method, params, status, code] of cases) {
        const reply = await rpc(f.running, method, params)
        expect({ name, status: reply.status, code: reply.code }).toEqual({ name, status, code })
        expect(reply.body.ok).toBe(false)
        if (code.startsWith("AUTH_")) expect(reply.body.error).toEqual({ code, message: "sign-in failed" })
        expect(reply.text).not.toContain(CANARY)
      }
      // No client can point a sign-in somewhere else: extra addresses are not part of the method.
      const redirected = snap(await rpc(f.running, "auth.login.start", { flow: "chatgpt", authorizeUrl: "https://evil.example.test/authorize", tokenUrl: "https://evil.example.test/token", callbackPort: 9 }))
      expect(new URL(pageUrl(redirected)).origin).toBe(f.mock.origin)
      expect(new URL(pageUrl(redirected)).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${f.port}/auth/callback`)

      // Cancel: the listener closes and the sign-in reads as cancelled from then on.
      expect(await portClosed(f.port)).toBe(false)
      const cancelled = await rpc(f.running, "auth.login.cancel", { loginId: redirected.loginId })
      expect(cancelled.status).toBe(200)
      expect(snap(cancelled)).toMatchObject({ state: "cancelled", code: "AUTH_CANCELLED", acceptsInput: false })
      expect(await portClosed(f.port)).toBe(true)
      expect(snap(await rpc(f.running, "auth.login.status", { loginId: redirected.loginId })).state).toBe("cancelled")
      expect((await rpc(f.running, "account.get", { accountId: "signin-chatgpt" })).status).toBe(404)

      // Signing out works for a pasted key too.
      const keyed = await send(f.running, "/rpc", { method: "auth.logout", params: { accountId: "account-key" } })
      expect(record(keyed)).toMatchObject({ status: "unconfigured", statusCode: "SIGNED_OUT" })
      // The sign-in that was left waiting still is.
      expect(snap(await rpc(f.running, "auth.login.status", { loginId: live.loginId })).state).toBe("waiting")
    } finally {
      await f.close()
    }
  })

  test("OpenRouter through the control server ends in a ready connection", async () => {
    const f = await fixture()
    try {
      const started = snap(await rpc(f.running, "auth.login.start", { flow: "openrouter" }))
      expect((await f.mock.visit(pageUrl(started))).status).toBe(200)
      expect((await settle(f.running, started.loginId)).state).toBe("done")
      expect(record(await rpc(f.running, "account.get", { accountId: "signin-openrouter" }))).toMatchObject({ status: "ready", reference: { provider: "openrouter", authMode: "api-key" } })
      const listed = await rpc(f.running, "account.list")
      expect(listed.status).toBe(200)
      expect(listed.text).toContain("signin-openrouter")
      expect(listed.text).not.toContain(CANARY)
      const holders = await filesContaining(f.accountsDir, CANARY)
      expect(holders).toHaveLength(1)
      expect(holders[0]!.startsWith(`${f.vaultDir}/`)).toBe(true)
    } finally {
      await f.close()
    }
  })

  test("stopping the engine closes a waiting sign-in's port", async () => {
    const f = await fixture()
    try {
      const started = snap(await rpc(f.running, "auth.login.start", { flow: "chatgpt" }))
      expect(started.state).toBe("waiting")
      expect(await portClosed(f.port)).toBe(false)
      await f.running.handle.stop()
      expect(await portClosed(f.port)).toBe(true)
    } finally {
      await f.close()
    }
  })

  test("without a vault there is no sign-in; with a vault and no sign-ins, sign-out still works", async () => {
    const bare = await fixture({ vault: "none" })
    try {
      const health = await (await fetch(`${bare.running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
      expect(health.capabilityStatus["auth.signin"]).toBe("configurable")
      for (const [method, params] of [["auth.flows", {}], ["auth.login.start", { flow: "chatgpt" }], ["auth.login.status", { loginId: "login-00000000-0000-0000-0000-000000000000" }], ["auth.login.cancel", { loginId: "login-00000000-0000-0000-0000-000000000000" }], ["auth.logout", { accountId: "any" }]] as const) {
        const reply = await rpc(bare.running, method, params)
        expect({ method, status: reply.status, code: reply.code }).toEqual({ method, status: 409, code: "CONTROL_CAPABILITY_UNAVAILABLE" })
      }
      const pasted = await paste(bare.running, { loginId: "login-00000000-0000-0000-0000-000000000000", input: "code=x" })
      expect({ status: pasted.status, code: pasted.code }).toEqual({ status: 409, code: "CONTROL_CAPABILITY_UNAVAILABLE" })
      expect(bare.mock.requests).toHaveLength(0)
    } finally {
      await bare.close()
    }

    const empty = await fixture({ vault: new MemoryCredentialVault(), flows: [] })
    try {
      const health = await (await fetch(`${empty.running.handle.url}/health`)).json() as { capabilityStatus: Record<string, string> }
      expect(health.capabilityStatus["auth.signin"]).toBe("configurable")
      expect((await rpc(empty.running, "auth.flows")).body.result).toEqual([])
      expect((await rpc(empty.running, "auth.login.start", { flow: "chatgpt" })).code).toBe("AUTH_FLOW_UNKNOWN")
      await rpc(empty.running, "account.create", { accountId: "account-key", provider: "openai", label: "Key", authMode: "api-key" })
      expect(record(await rpc(empty.running, "auth.logout", { accountId: "account-key" }))).toMatchObject({ status: "unconfigured", statusCode: "SIGNED_OUT" })
    } finally {
      await empty.close()
    }
  })
})
