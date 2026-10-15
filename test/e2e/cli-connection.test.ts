import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { FileCredentialVault } from "../../src/auth/index.ts"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"
import { RUNRAIL_USER_AGENT } from "../../src/index.ts"

// Distinct from every other string in the test so a leak is unambiguous.
const CANARY = "sk-canary-b07e31a94d5c4862f1a3"

async function runCli(args: readonly string[]): Promise<{ readonly status: number; readonly output: string }> {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args], { cwd: resolve(import.meta.dir, "../.."), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { status, output: `${stdout}\n${stderr}` }
}

test("the CLI runs a task on a connection saved through the control server", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-cli-connection-cwd-"))
  const accountsDir = await mkdtemp(join("/tmp", "runrail-cli-connection-accounts-"))
  const seen: { path: string; authorization: string | null; userAgent: string | null; model?: unknown }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const body = incoming.method === "POST" ? await incoming.json() as { model?: unknown } : undefined
      seen.push({ path: new URL(incoming.url).pathname, authorization: incoming.headers.get("authorization"), userAgent: incoming.headers.get("user-agent"), ...(body === undefined ? {} : { model: body.model }) })
      return new Response('data: {"choices":[{"delta":{"content":"answer from the saved connection"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    // Saved the way the desktop saves it: account through the RPC, key through the write-only path.
    const running = await startRunrailControlRpcServer({
      cwd,
      backend: "native",
      loadExtensions: false,
      model: { complete: () => ({ type: "text" as const, text: "unused" }) },
      nativeAccountsDir: accountsDir,
      nativeCredentialVault: new FileCredentialVault({ root: join(accountsDir, "vault") }),
    })
    try {
      const post = (path: string, payload: unknown) => fetch(`${running.handle.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${running.handle.token}`, "content-type": "application/json" }, body: JSON.stringify(payload) })
      expect((await post("/rpc", { method: "account.create", params: { accountId: "conn-local", provider: "custom-openai-chat", label: "Local relay", authMode: "api-key", baseUrl: `http://127.0.0.1:${server.port}/v1` } })).status).toBe(200)
      expect((await post("/secret", { accountId: "conn-local", secret: CANARY })).status).toBe(200)
    } finally {
      await running.handle.stop()
    }

    const stored = ["--accounts-dir", accountsDir, "--credential-vault", "file"]
    const ran = await runCli(["run", "--cwd", cwd, "--connection", "conn-local", "--model", "chat-model", ...stored, "say something"])
    expect(ran.output).toContain("answer from the saved connection")
    expect(ran.status).toBe(0)
    expect(ran.output).not.toContain(CANARY)
    expect(seen).toEqual([{ path: "/v1/chat/completions", authorization: `Bearer ${CANARY}`, userAgent: RUNRAIL_USER_AGENT, model: "chat-model" }])

    seen.length = 0
    const unknown = await runCli(["run", "--cwd", cwd, "--connection", "conn-nobody", "--model", "chat-model", ...stored, "say something"])
    expect(unknown.status).not.toBe(0)
    // The code ends the message, where the desktop host looks for it.
    expect(unknown.output.trim().endsWith("connection was not found (CONNECTION_NOT_FOUND)")).toBe(true)
    // Without the vault the account is still found, but there is no key to send.
    const keyless = await runCli(["run", "--cwd", cwd, "--connection", "conn-local", "--model", "chat-model", "--accounts-dir", accountsDir, "--credential-vault", "none", "say something"])
    expect(keyless.status).not.toBe(0)
    expect(keyless.output).not.toContain(CANARY)
    expect(seen).toEqual([])
  } finally {
    await server.stop(true)
    await rm(cwd, { recursive: true, force: true })
    await rm(accountsDir, { recursive: true, force: true })
  }
}, 60_000)
