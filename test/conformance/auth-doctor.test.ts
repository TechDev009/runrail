import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryAccountStore, createAccountCredentialResolver, type AccountAuthMode, type AccountRecord } from "../../src/accounts/index.ts"
import { MemoryCredentialVault, VaultCredentialBroker } from "../../src/auth/index.ts"
import { checkConnection, connectionCheckStatus, runAuthDoctor } from "../../src/connection-check.ts"

// Distinct from every other string here, so a leak is unambiguous.
const CANARY = "sk-doctor-canary-7e2b91c4"

type Plan = "ok" | "refused" | "down" | "busy" | "no-list" | "garbage"

interface Desk {
  readonly url: string
  readonly accounts: InMemoryAccountStore
  readonly broker: VaultCredentialBroker
  readonly requests: { readonly path: string; readonly authorization: string | null; readonly userAgent: string | null }[]
  readonly out: string[]
  readonly notes: string[]
  plan: Plan
  add(id: string, mode?: AccountAuthMode, extra?: Partial<AccountRecord["reference"]>): Promise<AccountRecord>
  doctor(connectionId: string, json?: boolean): Promise<number>
}

const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function desk(): Promise<Desk> {
  const root = await mkdtemp(join(tmpdir(), "runrail-doctor-"))
  const requests: Desk["requests"] = []
  const state: { plan: Plan } = { plan: "ok" }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, authorization: request.headers.get("authorization"), userAgent: request.headers.get("user-agent") })
      if (state.plan === "refused") return Response.json({ error: { message: `no such key ${CANARY}` } }, { status: 401 })
      if (state.plan === "down") return new Response("upstream is down", { status: 503 })
      if (state.plan === "busy") return new Response("slow down", { status: 429 })
      if (state.plan === "no-list") return new Response("not here", { status: 404 })
      if (state.plan === "garbage") return Response.json({ hello: "there" })
      return Response.json({ data: [{ id: "fixture-model-a" }, { id: "fixture-model-b" }] })
    },
  })
  cleanup.push(() => server.stop(true), () => rm(root, { recursive: true, force: true }))
  const accounts = new InMemoryAccountStore()
  const vault = new MemoryCredentialVault()
  const broker = new VaultCredentialBroker({ vault, accounts, lockRoot: join(root, "locks"), refreshers: {}, fallback: { resolve: async () => { throw new Error("no shell variable in this test") } } })
  const out: string[] = []
  const notes: string[] = []
  const url = `http://127.0.0.1:${server.port}/v1`
  return {
    url,
    accounts,
    broker,
    requests,
    out,
    notes,
    get plan() { return state.plan },
    set plan(value: Plan) { state.plan = value },
    async add(id, mode = "api-key", extra = {}) {
      const record: AccountRecord = { reference: { accountId: id, provider: "custom-openai-chat", preset: "custom-openai-chat", label: "Doctor fixture", authMode: mode, scopes: [], baseUrl: url, createdAt: 1, updatedAt: 1, ...extra }, status: "unconfigured" }
      accounts.put(record)
      return record
    },
    doctor: (connectionId, json = false) => runAuthDoctor({ connectionId, json }, { accounts, credentialResolver: createAccountCredentialResolver(accounts, broker), out: (line) => out.push(line), note: (line) => notes.push(line) }),
  }
}

describe("runrail auth doctor", () => {
  test("a working key: one request, and a line with the status, the code, and how many models", async () => {
    const d = await desk()
    const account = await d.add("conn-works")
    await d.broker.store(account.reference, { kind: "api-key", secret: CANARY })

    expect(await d.doctor("conn-works")).toBe(0)
    expect(d.out).toEqual(["conn-works\tok\tOK\t-\t2 models"])
    expect(d.notes).toEqual(["The provider accepted the key or sign-in."])
    // The one request is the model list, with the stored key and Runrail's own name.
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0]).toMatchObject({ path: "/v1/models", authorization: `Bearer ${CANARY}` })
    expect(d.requests[0]?.userAgent).toMatch(/^runrail\//)

    d.out.length = 0
    expect(await d.doctor("conn-works", true)).toBe(0)
    expect(JSON.parse(d.out[0]!)).toEqual({ connectionId: "conn-works", status: "ok", code: "OK", modelCount: 2 })
  })

  test("prints no key, no model name, and nothing the provider sent back", async () => {
    const d = await desk()
    const account = await d.add("conn-leak")
    await d.broker.store(account.reference, { kind: "api-key", secret: CANARY })
    for (const plan of ["ok", "refused", "down", "garbage"] as const) {
      d.plan = plan
      await d.doctor("conn-leak")
      await d.doctor("conn-leak", true)
    }
    const printed = [...d.out, ...d.notes].join("\n")
    for (const secret of [CANARY, "fixture-model", "no such key", "upstream is down", "hello", d.url]) expect(printed).not.toContain(secret)
  })

  test("each way a check can end has its own code, status, and exit code, and is asked once", async () => {
    const d = await desk()
    const account = await d.add("conn-codes")
    await d.broker.store(account.reference, { kind: "api-key", secret: CANARY })
    const cases: readonly (readonly [Plan, number, Record<string, unknown>])[] = [
      ["refused", 1, { status: "failed", code: "AUTH_FAILED", httpStatus: 401 }],
      ["down", 1, { status: "failed", code: "SERVER_ERROR", httpStatus: 503 }],
      ["busy", 3, { status: "unverified", code: "RATE_LIMITED", httpStatus: 429 }],
      ["no-list", 3, { status: "unverified", code: "NO_MODEL_LIST", httpStatus: 404 }],
      ["garbage", 3, { status: "unverified", code: "INVALID_RESPONSE" }],
    ]
    for (const [plan, exit, result] of cases) {
      d.plan = plan
      d.out.length = 0
      d.requests.length = 0
      expect([plan, await d.doctor("conn-codes", true)]).toEqual([plan, exit])
      expect(JSON.parse(d.out[0]!)).toEqual({ connectionId: "conn-codes", ...result })
      // A failing provider is not asked again: the doctor makes one request.
      expect([plan, d.requests.length]).toEqual([plan, 1])
    }
    d.plan = "refused"
    d.out.length = 0
    d.notes.length = 0
    expect(await d.doctor("conn-codes")).toBe(1)
    expect(d.out).toEqual(["conn-codes\tfailed\tAUTH_FAILED\t401\t-"])
    expect(d.notes).toEqual(["The provider refused the key or sign-in."])
  })

  test("no stored key, a connection that is not there, and one that was revoked never reach the provider", async () => {
    const d = await desk()
    await d.add("conn-empty")
    expect(await d.doctor("conn-empty", true)).toBe(1)
    expect(JSON.parse(d.out.at(-1)!)).toEqual({ connectionId: "conn-empty", status: "failed", code: "CREDENTIAL_MISSING" })

    expect(await d.doctor("conn-nowhere", true)).toBe(2)
    expect(JSON.parse(d.out.at(-1)!)).toEqual({ connectionId: "conn-nowhere", status: "failed", code: "CONNECTION_NOT_FOUND" })

    const gone = await d.add("conn-gone")
    d.accounts.put({ ...gone, status: "revoked" })
    expect(await d.doctor("conn-gone")).toBe(2)
    expect(d.notes.at(-1)).toBe("connection was not found (CONNECTION_NOT_FOUND)")

    // A sign-in-only address takes no pasted key: refused before any request.
    await d.add("conn-plan", "api-key", { provider: "xai-grok", preset: "xai-grok", baseUrl: undefined })
    expect(await d.doctor("conn-plan", true)).toBe(2)
    expect(JSON.parse(d.out.at(-1)!)).toEqual({ connectionId: "conn-plan", status: "failed", code: "CONNECTION_INVALID" })
    expect(d.requests).toHaveLength(0)
  })

  test("the shared check keeps the control server's words for each code", async () => {
    const d = await desk()
    const account = await d.add("conn-shared")
    await d.broker.store(account.reference, { kind: "api-key", secret: CANARY })
    const resolver = createAccountCredentialResolver(d.accounts, d.broker)
    const ok = await checkConnection(account, resolver)
    expect(ok.code).toBe("OK")
    expect(ok.models?.map((model) => model.id)).toEqual(["fixture-model-a", "fixture-model-b"])
    expect(ok).not.toHaveProperty("httpStatus")
    expect((["OK", "AUTH_FAILED", "RATE_LIMITED", "NO_MODEL_LIST", "INVALID_RESPONSE", "SIGN_IN_EXPIRED", "UNREACHABLE"] as const).map(connectionCheckStatus)).toEqual(["ok", "failed", "unverified", "unverified", "unverified", "failed", "failed"])
  })
})
