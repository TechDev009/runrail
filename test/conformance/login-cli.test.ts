import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { InMemoryAccountStore, parseAccountRecord, type AccountStore } from "../../src/accounts/index.ts"
import { MemoryCredentialVault, createChatGptSignIn, type CredentialVault, type SignInFlow } from "../../src/auth/index.ts"
import { createXaiSignIn } from "../../src/auth-vendors.ts"
import { runSignInCli, type SignInCliHost, type SignInCliOptions } from "../../src/login-cli.ts"
import { CANARY, freePort, startMockOAuthServer, type MockOAuthServer } from "../fixtures/mock-oauth-server.ts"

interface Desk {
  readonly mock: MockOAuthServer
  readonly port: number
  readonly accounts: AccountStore
  readonly vault: CredentialVault
  readonly out: string[]
  readonly notes: string[]
  readonly opened: string[]
  run(options: SignInCliOptions, extra?: Partial<SignInCliHost>): Promise<number>
  close(): Promise<void>
}

async function desk(): Promise<Desk> {
  const root = await mkdtemp(join("/tmp", "runrail-login-cli-"))
  const mock = startMockOAuthServer()
  const port = freePort()
  const flows: readonly SignInFlow[] = [
    createChatGptSignIn({ authorizeUrl: mock.authorizeUrl, tokenUrl: mock.tokenUrl, callbackPort: port }),
    createXaiSignIn({ deviceUrl: mock.deviceUrl, tokenUrl: mock.tokenUrl, verificationHosts: ["127.0.0.1"], timing: { minIntervalMs: 20, defaultIntervalMs: 40, slowDownMs: 60 } }),
  ]
  const accounts = new InMemoryAccountStore()
  const vault = new MemoryCredentialVault()
  const out: string[] = []
  const notes: string[] = []
  const opened: string[] = []
  return {
    mock,
    port,
    accounts,
    vault,
    out,
    notes,
    opened,
    run: (options, extra = {}) => runSignInCli(options, { flows, accounts, vault, accountsDir: root, out: (line) => out.push(line), note: (line) => notes.push(line), ...extra }),
    close: async () => {
      await mock.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const everything = (d: Desk): string => [...d.out, ...d.notes, ...d.opened].join("\n")

describe("runrail login and logout", () => {
  test("lists the sign-ins and says which the provider documents", async () => {
    const d = await desk()
    try {
      expect(await d.run({ action: "list", json: false })).toBe(0)
      expect(d.out).toEqual(["chatgpt\tChatGPT\tbrowser\tdocumented", "xai\txAI (Grok plan)\tcode\tunofficial"])
      d.out.length = 0
      expect(await d.run({ action: "list", json: true })).toBe(0)
      expect(JSON.parse(d.out[0]!)).toEqual([
        { id: "chatgpt", label: "ChatGPT", preset: "openai", kind: "browser", unofficial: false },
        { id: "xai", label: "xAI (Grok plan)", preset: "xai-grok", kind: "device-code", unofficial: true },
      ])
      expect(d.mock.requests).toHaveLength(0)
    } finally {
      await d.close()
    }
  })

  test("an unofficial sign-in starts only after a yes, or the flag that says yes", async () => {
    const d = await desk()
    try {
      // Nobody to ask and no flag: refused before anything reaches the provider.
      expect(await d.run({ action: "login", target: "xai", acceptUnofficial: false, json: false })).toBe(2)
      expect(d.notes.join("\n")).toContain("not documented by the provider")
      expect(d.notes.join("\n")).toContain("--accept-unofficial")
      const asked: string[] = []
      expect(await d.run({ action: "login", target: "xai", acceptUnofficial: false, json: true }, { confirm: async (question) => (asked.push(question), false) })).toBe(2)
      expect(asked).toEqual(["Continue?"])
      expect(JSON.parse(d.out.at(-1)!)).toEqual({ type: "failed", code: "AUTH_UNOFFICIAL_NOT_ACCEPTED" })
      expect(d.mock.requests).toHaveLength(0)
      expect(await d.accounts.get("signin-xai")).toBeUndefined()

      d.notes.length = 0
      expect(await d.run({ action: "login", target: "xai", acceptUnofficial: false, json: false }, { confirm: async () => true })).toBe(0)
      expect(d.notes.slice(0, 4)).toEqual([
        "xAI (Grok plan)",
        "This sign-in is not documented by the provider for other tools.",
        "Runrail signs in with the client id of the provider's own command-line tool and names itself as Runrail.",
        "The provider may refuse it, or act on the account, at any time.",
      ])
      expect(await d.accounts.get("signin-xai")).toMatchObject({ status: "ready" })
    } finally {
      await d.close()
    }
  })

  test("a code sign-in prints the page and the code, stores the tokens, and prints none of them", async () => {
    const d = await desk()
    try {
      d.mock.plan.device = ["authorization_pending"]
      // The preset id leads to the same sign-in.
      expect(await d.run({ action: "login", target: "xai-grok", acceptUnofficial: true, connectionId: "grok-work", label: "Grok (work)", json: false }, { openUrl: (url) => d.opened.push(url) })).toBe(0)
      expect(d.notes).toContain(`Open ${d.mock.origin}/activate?user_code=WDJB-MJHT`)
      expect(d.notes).toContain("and enter the code WDJB-MJHT")
      expect(d.opened).toEqual([`${d.mock.origin}/activate?user_code=WDJB-MJHT`])
      expect(d.out).toEqual(["Signed in to xAI (Grok plan). Connection: grok-work"])
      expect(await d.accounts.get("grok-work")).toMatchObject({ status: "ready", reference: { provider: "xai-grok", label: "Grok (work)", authMode: "device" } })
      expect(await d.vault.get("grok-work")).toMatchObject({ kind: "oauth" })
      expect(everything(d)).not.toContain(CANARY)

      // The machine-readable form carries the same steps and no more.
      d.out.length = 0
      expect(await d.run({ action: "login", target: "xai", acceptUnofficial: true, json: true })).toBe(0)
      const events = d.out.map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(events.map((event) => event.type)).toEqual(["device-code", "finishing", "done"])
      expect(events[0]).toEqual({ type: "device-code", userCode: "WDJB-MJHT", verificationUrl: `${d.mock.origin}/activate?user_code=WDJB-MJHT`, expiresAt: expect.any(Number) })
      expect(events[2]).toEqual({ type: "done", connectionId: "signin-xai" })
      expect(everything(d)).not.toContain(CANARY)
    } finally {
      await d.close()
    }
  })

  test("a browser sign-in opens the provider's page and finishes when the browser comes back", async () => {
    const d = await desk()
    try {
      const visits: Promise<unknown>[] = []
      expect(await d.run({ action: "login", target: "chatgpt", acceptUnofficial: false, json: false }, { openUrl: (url) => (d.opened.push(url), void visits.push(d.mock.visit(url))) })).toBe(0)
      await Promise.all(visits)
      expect(d.opened).toHaveLength(1)
      expect(d.opened[0]).toStartWith(`${d.mock.authorizeUrl}?`)
      expect(d.notes).toContain("Open this page to sign in to ChatGPT:")
      expect(d.out).toEqual(["Signed in to ChatGPT. Connection: signin-chatgpt"])
      expect(await d.vault.get("signin-chatgpt")).toMatchObject({ kind: "oauth" })
      expect(everything(d).replace(d.opened[0]!, "")).not.toContain(CANARY)
    } finally {
      await d.close()
    }
  })

  test("with the callback port taken, the pasted address finishes the sign-in and a wrong paste is asked for again", async () => {
    const d = await desk()
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: d.port, fetch: () => new Response("someone else") })
    try {
      let pasted = 0
      const readLine = async (): Promise<string | undefined> => {
        pasted += 1
        if (pasted === 1) return "this is not an address"
        if (pasted > 2) return undefined
        const page = d.notes.find((line) => line.startsWith(`${d.mock.authorizeUrl}?`))
        if (page === undefined) throw new Error("the page was not printed")
        return d.mock.approve(page)
      }
      expect(await d.run({ action: "login", target: "chatgpt", acceptUnofficial: false, json: false }, { readLine })).toBe(0)
      expect(d.notes).toContain("When the browser ends on an address that does not load, paste that whole address here and press Enter.")
      expect(d.notes).toContain("That is not the address the sign-in ended on. Copy the whole address from the browser and paste it again.")
      expect(d.out).toEqual(["Signed in to ChatGPT. Connection: signin-chatgpt"])
      // The pasted address held the code; nothing printed repeats it.
      expect(d.out.join("\n")).not.toContain(CANARY)
    } finally {
      await squatter.stop(true)
      await d.close()
    }
  })

  test("a declined sign-in, an unknown one, and Ctrl-C each end with their own exit code and store nothing", async () => {
    const d = await desk()
    try {
      d.mock.plan.device = ["access_denied"]
      expect(await d.run({ action: "login", target: "xai", acceptUnofficial: true, json: false })).toBe(1)
      expect(d.notes.at(-1)).toBe("The sign-in was declined on the provider's page. (AUTH_DENIED) Nothing was stored.")

      expect(await d.run({ action: "login", target: "nobody", acceptUnofficial: true, json: false })).toBe(2)
      expect(d.notes.at(-1)).toBe("no such sign-in; choose one of chatgpt, xai (AUTH_FLOW_UNKNOWN)")

      // A connection that belongs to another provider is not written over.
      await d.accounts.put(parseAccountRecord({ reference: { accountId: "other", provider: "openrouter", label: "Other", authMode: "api-key", scopes: [], createdAt: 1, updatedAt: 1 }, status: "ready" }))
      expect(await d.run({ action: "login", target: "xai", acceptUnofficial: true, connectionId: "other", json: true })).toBe(2)
      expect(JSON.parse(d.out.at(-1)!)).toEqual({ type: "failed", code: "AUTH_ACCOUNT_MISMATCH" })

      d.mock.plan.device = Array.from({ length: 500 }, () => "authorization_pending" as const)
      const interrupt = new AbortController()
      const run = d.run({ action: "login", target: "xai", acceptUnofficial: true, json: false }, { signal: interrupt.signal })
      await Bun.sleep(150)
      interrupt.abort()
      expect(await run).toBe(130)
      expect(d.notes.at(-1)).toBe("Sign-in cancelled. Nothing was stored.")
      const polls = d.mock.requests.length
      await Bun.sleep(120)
      expect(d.mock.requests.length).toBe(polls)

      expect(await d.vault.get("signin-xai")).toBeUndefined()
      expect(await d.accounts.get("signin-xai")).toBeUndefined()
      expect(everything(d)).not.toContain(CANARY)
    } finally {
      await d.close()
    }
  })

  test("logout removes the stored sign-in and leaves the connection", async () => {
    const d = await desk()
    try {
      expect(await d.run({ action: "login", target: "xai", acceptUnofficial: true, json: false })).toBe(0)
      d.out.length = 0
      expect(await d.run({ action: "logout", connectionId: "signin-xai", json: false })).toBe(0)
      expect(d.out).toEqual(["Signed out of xAI (Grok plan). The connection stays; sign in or add a key to use it again."])
      expect(await d.vault.get("signin-xai")).toBeUndefined()
      expect(await d.accounts.get("signin-xai")).toMatchObject({ status: "unconfigured", statusCode: "SIGNED_OUT" })

      expect(await d.run({ action: "logout", connectionId: "nobody", json: true })).toBe(1)
      expect(JSON.parse(d.out.at(-1)!)).toEqual({ type: "failed", code: "CONNECTION_NOT_FOUND" })
      await d.accounts.put(parseAccountRecord({ reference: { accountId: "shell", provider: "openai", label: "Shell key", authMode: "environment", environmentName: "OPENAI_API_KEY", scopes: [], createdAt: 1, updatedAt: 1 }, status: "ready" }))
      expect(await d.run({ action: "logout", connectionId: "shell", json: true })).toBe(2)
      expect(JSON.parse(d.out.at(-1)!)).toEqual({ type: "failed", code: "CONNECTION_KEEPS_NO_CREDENTIAL" })
      expect(await d.accounts.get("shell")).toMatchObject({ status: "ready" })
    } finally {
      await d.close()
    }
  })
})
