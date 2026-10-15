import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { FileAccountStore, parseAccountRecord } from "../../src/accounts/index.ts"
import { FileCredentialVault } from "../../src/auth/index.ts"

// Distinct from every other string in the test so a leak is unambiguous.
const CANARY = "rt-canary-51c0e7a2d9b84f63"

// The real `runrail` entry point. No test here lets a sign-in start: a started sign-in would call
// the provider. What starts one is covered in-process against the mock sign-in service.
async function runCli(args: readonly string[]): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args], { cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { status, stdout, stderr }
}

test("runrail login lists every sign-in, and refuses one it may not start without contacting anyone", async () => {
  const accountsDir = await mkdtemp(join("/tmp", "runrail-cli-login-"))
  try {
    const store = ["--accounts-dir", accountsDir, "--credential-vault", "file"]
    const listed = await runCli(["login", "--list", "--json", ...store])
    expect(listed.status).toBe(0)
    expect((JSON.parse(listed.stdout) as { id: string; unofficial: boolean }[]).map((flow) => [flow.id, flow.unofficial])).toEqual([["chatgpt", false], ["openrouter", false], ["xai", true], ["kimi", true], ["meta", true]])
    expect((await runCli(["login", "--list", ...store])).stdout.trim().split("\n")).toHaveLength(5)

    // No terminal and no flag: an unofficial sign-in is described and not started.
    for (const name of ["xai", "kimi", "meta", "kimi-code"]) {
      const refused = await runCli(["login", name, ...store])
      expect(refused.status).toBe(2)
      expect(refused.stderr).toContain("unofficial sign-in")
      expect(refused.stderr).toContain("--accept-unofficial")
      expect(refused.stdout).toBe("")
    }
    const machine = await runCli(["login", "meta", "--json", ...store])
    expect(machine.status).toBe(2)
    expect(JSON.parse(machine.stdout)).toEqual({ type: "failed", code: "AUTH_UNOFFICIAL_NOT_ACCEPTED" })

    const unknown = await runCli(["login", "nobody", ...store])
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain("AUTH_FLOW_UNKNOWN")
    // `meta` is both a sign-in id and a preset; `openai` is the preset ChatGPT leads to.
    const noVault = await runCli(["login", "openai", "--accounts-dir", accountsDir, "--credential-vault", "none"])
    expect(noVault.status).toBe(2)
    expect(noVault.stderr).toContain("credential vault is required")
    const misuse = await runCli(["login", "chatgpt", "--token", "abc", ...store])
    expect(misuse.status).toBe(2)
    expect(misuse.stderr).toContain("usage: runrail login")

    // Nothing above created an account or stored anything.
    expect(await new FileAccountStore({ root: accountsDir }).list()).toEqual([])
  } finally {
    await rm(accountsDir, { recursive: true, force: true })
  }
}, 60_000)

test("runrail auth doctor checks a stored connection with one request and prints only codes", async () => {
  const accountsDir = await mkdtemp(join("/tmp", "runrail-cli-doctor-"))
  const seen: (string | null)[] = []
  let refuse = false
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push(request.headers.get("authorization"))
      return refuse ? Response.json({ error: `bad key ${CANARY}` }, { status: 401 }) : Response.json({ data: [{ id: "fixture-model" }] })
    },
  })
  try {
    const accounts = new FileAccountStore({ root: accountsDir })
    const vault = new FileCredentialVault({ root: join(accountsDir, "vault") })
    await accounts.put(parseAccountRecord({ reference: { accountId: "conn-local", provider: "custom-openai-chat", preset: "custom-openai-chat", label: "Local", authMode: "api-key", scopes: [], baseUrl: `http://127.0.0.1:${server.port}/v1`, createdAt: 1, updatedAt: 1 }, status: "ready" }))
    await vault.set("conn-local", { kind: "api-key", secret: `key-${CANARY}` })
    const store = ["--accounts-dir", accountsDir, "--credential-vault", "file"]

    const ok = await runCli(["auth", "doctor", "conn-local", ...store])
    expect(ok.status).toBe(0)
    expect(ok.stdout.trim()).toBe("conn-local\tok\tOK\t-\t1 models")
    expect(ok.stderr).toContain("Keys are read from Runrail's file vault")
    expect(seen).toEqual([`Bearer key-${CANARY}`])

    refuse = true
    const failed = await runCli(["auth", "doctor", "conn-local", "--json", ...store])
    expect(failed.status).toBe(1)
    expect(JSON.parse(failed.stdout)).toEqual({ connectionId: "conn-local", status: "failed", code: "AUTH_FAILED", httpStatus: 401 })
    expect(seen).toHaveLength(2)
    for (const run of [ok, failed]) expect(`${run.stdout}${run.stderr}`).not.toContain(CANARY)

    const missing = await runCli(["auth", "doctor", "nobody", "--json", ...store])
    expect(missing.status).toBe(2)
    expect(JSON.parse(missing.stdout)).toEqual({ connectionId: "nobody", status: "failed", code: "CONNECTION_NOT_FOUND" })
    const misuse = await runCli(["auth", "doctor", ...store])
    expect(misuse.status).toBe(2)
    expect(misuse.stderr).toContain("usage: runrail auth doctor")
    expect(seen).toHaveLength(2)
  } finally {
    await server.stop(true)
    await rm(accountsDir, { recursive: true, force: true })
  }
}, 60_000)

test("runrail logout removes a stored sign-in from the vault the engine uses", async () => {
  const accountsDir = await mkdtemp(join("/tmp", "runrail-cli-logout-"))
  try {
    const accounts = new FileAccountStore({ root: accountsDir })
    const vault = new FileCredentialVault({ root: join(accountsDir, "vault") })
    await accounts.put(parseAccountRecord({ reference: { accountId: "signin-xai", provider: "xai-grok", label: "xAI plan", authMode: "device", scopes: [], createdAt: 1, updatedAt: 1 }, status: "ready" }))
    await vault.set("signin-xai", { kind: "oauth", access: `access-${CANARY}`, refresh: `refresh-${CANARY}`, expiresAt: Date.now() + 3_600_000 })

    const store = ["--accounts-dir", accountsDir, "--credential-vault", "file"]
    const out = await runCli(["logout", "signin-xai", ...store])
    expect(out.status).toBe(0)
    expect(out.stdout).toContain("Signed out of xAI plan.")
    expect(`${out.stdout}${out.stderr}`).not.toContain(CANARY)
    expect(await vault.get("signin-xai")).toBeUndefined()
    expect(await accounts.get("signin-xai")).toMatchObject({ status: "unconfigured", statusCode: "SIGNED_OUT" })

    const missing = await runCli(["logout", "nobody", "--json", ...store])
    expect(missing.status).toBe(1)
    expect(JSON.parse(missing.stdout)).toEqual({ type: "failed", code: "CONNECTION_NOT_FOUND" })
    expect((await runCli(["logout", ...store])).status).toBe(2)
  } finally {
    await rm(accountsDir, { recursive: true, force: true })
  }
}, 60_000)
