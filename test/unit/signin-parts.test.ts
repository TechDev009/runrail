import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { connect } from "node:net"
import { join } from "node:path"
import { createAccountCredentialResolver, InMemoryAccountStore, parseAccountRecord, resolveConnection } from "../../src/accounts/index.ts"
import { SignInError, VaultCredentialBroker, MemoryCredentialVault, tokenCredential } from "../../src/auth/index.ts"
import { installationId } from "../../src/auth/installation.ts"
import { openLoopbackListener, type RedirectVerdict } from "../../src/auth/loopback.ts"
import { createPkcePair, pkceChallenge } from "../../src/auth/pkce.ts"
import { oauthErrorWord, secretField, signInEndpoint } from "../../src/auth/signin-http.ts"

function code(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof SignInError ? error.code : `unexpected:${String(error)}`
  }
  return undefined
}

/** One raw request, so the test controls the Host header exactly. Returns the status code. */
function rawStatus(port: number, requestLine: string, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`${requestLine} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`))
    let text = ""
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8")
    })
    socket.on("error", reject)
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)))
  })
}

describe("sign-in building blocks", () => {
  test("PKCE matches the RFC 7636 example and never repeats a verifier", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    const first = createPkcePair()
    const second = createPkcePair()
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.challenge).toBe(pkceChallenge(first.verifier))
    expect(second.verifier).not.toBe(first.verifier)
  })

  test("a sign-in address must be https, or plain http to this machine only", () => {
    expect(signInEndpoint("https://auth.example.test/token", "token address").hostname).toBe("auth.example.test")
    expect(signInEndpoint("http://127.0.0.1:9000/token", "token address").port).toBe("9000")
    expect(signInEndpoint("http://localhost:9000/token", "token address").hostname).toBe("localhost")
    for (const bad of ["http://auth.example.test/token", "http://127.0.0.1.example.test/token", "https://user:pass@auth.example.test/token", "https://auth.example.test/token#frag", "ftp://127.0.0.1/token", "file:///etc/passwd", "not a url"]) expect(code(() => signInEndpoint(bad, "token address"))).toBe("AUTH_INVALID")
  })

  test("a vendor answer is read field by field and nothing unusable is kept", () => {
    expect(tokenCredential({ access_token: "a", refresh_token: "r", expires_in: 60, scope: "one  two\tthree" }, 1_000)).toEqual({ kind: "oauth", access: "a", refresh: "r", expiresAt: 61_000, scopes: ["one", "two", "three"] })
    expect(tokenCredential({ access_token: "a", expires_in: -5, scope: "", refresh_token: 7 }, 1_000)).toEqual({ kind: "oauth", access: "a" })
    expect(code(() => tokenCredential({ refresh_token: "r" }, 1_000))).toBe("AUTH_RESPONSE_INVALID")
    expect(code(() => tokenCredential({ access_token: "line\nbreak" }, 1_000))).toBe("AUTH_RESPONSE_INVALID")
    expect(secretField("x".repeat(16 * 1024))).toHaveLength(16 * 1024)
    expect(secretField("x".repeat(16 * 1024 + 1))).toBeUndefined()
    expect(secretField("")).toBeUndefined()
    expect(oauthErrorWord({ error: "invalid_grant" })).toBe("invalid_grant")
    // Only a plain word passes; a vendor's free text is never repeated.
    expect(oauthErrorWord({ error: "Invalid grant: token sk-123" })).toBeUndefined()
    expect(oauthErrorWord({ error: { message: "x" } })).toBeUndefined()
  })

  test("the installation id is made once, kept private, and replaced when the file is unusable", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-install-"))
    try {
      const dir = join(root, "accounts")
      const first = await installationId(dir)
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(await installationId(dir)).toBe(first)
      expect((await stat(join(dir, "installation-id"))).mode & 0o777).toBe(0o600)
      await writeFile(join(dir, "installation-id"), "not-an-id\n")
      const replaced = await installationId(dir)
      expect(replaced).toMatch(/^[0-9a-f-]{36}$/)
      expect(replaced).not.toBe("not-an-id")
      expect((await readFile(join(dir, "installation-id"), "utf8")).trim()).toBe(replaced)
      // Callers racing on a fresh directory agree on one id, and it is the one left on disk.
      for (let round = 0; round < 40; round += 1) {
        const fresh = join(root, `fresh-${round}`)
        const raced = await Promise.all(Array.from({ length: 8 }, () => installationId(fresh)))
        expect(new Set(raced).size).toBe(1)
        expect((await readFile(join(fresh, "installation-id"), "utf8")).trim()).toBe(raced[0]!)
        expect(await readdir(fresh)).toEqual(["installation-id"])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the callback listener answers only its own address, path and method, and is gone after close", async () => {
    const seen: string[] = []
    let verdict: RedirectVerdict = "accepted"
    const opened = openLoopbackListener({
      port: 0,
      path: "/auth/callback",
      onRedirect: (params) => {
        seen.push(params.toString())
        return verdict
      },
    })
    if (!("listener" in opened)) throw new Error("listener did not open")
    const { port } = opened.listener
    try {
      // A page on another site can reach this port, but only under its own name.
      expect(await rawStatus(port, "GET /auth/callback?code=x", "attacker.example.test")).toBe(400)
      expect(await rawStatus(port, "GET /auth/callback?code=x", `127.0.0.1:${port + 1}`)).toBe(400)
      expect(await rawStatus(port, "GET /auth/other?code=x", `127.0.0.1:${port}`)).toBe(404)
      expect(await rawStatus(port, "GET /auth/callback/extra?code=x", `127.0.0.1:${port}`)).toBe(404)
      expect(await rawStatus(port, "POST /auth/callback?code=x", `127.0.0.1:${port}`)).toBe(405)
      expect(seen).toEqual([])

      const accepted = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=s`)
      expect(accepted.status).toBe(200)
      expect(accepted.headers.get("cache-control")).toBe("no-store")
      expect(accepted.headers.get("content-security-policy")).toBe("default-src 'none'")
      const text = await accepted.text()
      expect(text).toContain("Sign-in received")
      // Nothing from the request is echoed back.
      expect(text).not.toContain("abc")
      expect(await rawStatus(port, "GET /auth/callback?code=abc", `localhost:${port}`)).toBe(200)
      expect(seen).toEqual(["code=abc&state=s", "code=abc"])

      for (const [next, status] of [["refused", 400], ["ended", 400], ["duplicate", 409]] as const) {
        verdict = next
        expect(await rawStatus(port, "GET /auth/callback?code=abc", `127.0.0.1:${port}`)).toBe(status)
      }
    } finally {
      await opened.listener.close()
    }
    await opened.listener.close()
    await expect(fetch(`http://127.0.0.1:${port}/auth/callback?code=abc`)).rejects.toThrow()

    // The port is free again at once: a second sign-in can take it.
    const again = openLoopbackListener({ port, path: "/auth/callback", onRedirect: () => "accepted" })
    if (!("listener" in again)) throw new Error("port was not released")
    expect(openLoopbackListener({ port, path: "/auth/callback", onRedirect: () => "accepted" })).toEqual({ notice: "AUTH_PORT_BUSY" })
    await again.listener.close()
  })

  test("close lets the answer to the accepted request leave before it cuts the connection", async () => {
    let close: (() => Promise<void>) | undefined
    const opened = openLoopbackListener({
      port: 0,
      path: "/cb",
      onRedirect: () => {
        // The sign-in closes its listener as soon as the redirect is in hand.
        queueMicrotask(() => void close?.())
        return "accepted"
      },
    })
    if (!("listener" in opened)) throw new Error("listener did not open")
    close = () => opened.listener.close()
    const response = await fetch(`http://127.0.0.1:${opened.listener.port}/cb?code=abc`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Sign-in received")
    await opened.listener.close()
  })

  test("a ChatGPT sign-in account resolves to OpenAI's own address with the signed-in token", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-signin-conn-"))
    try {
      const accounts = new InMemoryAccountStore()
      const broker = new VaultCredentialBroker({ vault: new MemoryCredentialVault(), accounts, lockRoot: join(root, "locks") })
      const record = parseAccountRecord({ reference: { accountId: "signin-chatgpt", provider: "openai", label: "ChatGPT", authMode: "oauth", scopes: [], createdAt: 1, updatedAt: 1 }, status: "unconfigured" })
      accounts.put(record)
      await broker.store(record.reference, { kind: "oauth", access: "access-fixture", refresh: "refresh-fixture", expiresAt: Date.now() + 3_600_000, clientId: "issued-1" })
      const ready = accounts.get("signin-chatgpt")!
      expect(ready.status).toBe("ready")
      const connection = resolveConnection(ready, createAccountCredentialResolver(accounts, broker))
      expect(connection).toMatchObject({ presetId: "openai", endpoint: "https://api.openai.com/v1", options: { protocol: "responses", authStyle: "bearer", allowedHosts: ["api.openai.com"] } })
      const lease = await broker.resolve(ready.reference)
      expect(lease.secret).toBe("access-fixture")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
