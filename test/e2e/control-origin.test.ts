import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { startRunrailControlRpcServer } from "../../src/control-server.ts"

test("a browser page or a DNS-rebound name never reaches the control plane, health included", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-origin-"))
  const token = "control-origin-token-1234567890abcdef"
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", loadExtensions: false, authToken: token, nativeAccountsDir: join(cwd, "accounts"), model: { complete: () => ({ type: "text", text: "done" }) } })
  try {
    const url = running.handle.url
    expect((await fetch(`${url}/health`)).status).toBe(200)
    const fromPage = await fetch(`${url}/health`, { headers: { origin: "https://evil.example" } })
    expect([fromPage.status, ((await fromPage.json()) as { error: string }).error]).toEqual([403, "CONTROL_ORIGIN_REFUSED"])
    const rebound = await fetch(`${url}/rpc`, { method: "POST", headers: { host: "evil.example:80", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "session.snapshot" }) })
    expect([rebound.status, ((await rebound.json()) as { error: string }).error]).toEqual([403, "CONTROL_HOST_REFUSED"])
    expect((await fetch(`${url}/health`, { headers: { host: `localhost:${new URL(url).port}` } })).status).toBe(200)
  } finally {
    await running.handle.stop()
    await rm(cwd, { recursive: true, force: true })
  }
})

test("binding beyond this machine needs TLS", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-tls-"))
  try {
    await expect(startRunrailControlRpcServer({ cwd, backend: "native", loadExtensions: false, hostname: "0.0.0.0", allowRemote: true, authToken: "control-origin-token-1234567890abcdef", model: { complete: () => ({ type: "text", text: "done" }) } })).rejects.toThrow("remote binding requires TLS")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("the connector route opens only to its own token, never to the control token", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-control-connectors-"))
  const token = "control-origin-token-1234567890abcdef"
  const connectorsFile = join(cwd, "connectors.json")
  await Bun.write(connectorsFile, JSON.stringify({ linear: { on: true, updatedAt: 1 } }))
  const running = await startRunrailControlRpcServer({ cwd, backend: "native", loadExtensions: false, authToken: token, githubCli: false, connectorsFile, nativeAccountsDir: join(cwd, "accounts"), model: { complete: () => ({ type: "text", text: "done" }) } })
  try {
    const post = (authorization?: string) => fetch(`${running.handle.url}/connectors`, { method: "POST", headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) }, body: JSON.stringify({ op: "list" }) })
    for (const authorization of [`Bearer ${token}`, "Bearer not-the-connectors-token-0000000000", undefined]) {
      const answer = await post(authorization)
      expect([answer.status, ((await answer.json()) as { error: string }).error]).toEqual([401, "CONTROL_UNAUTHORIZED"])
    }
  } finally {
    await running.handle.stop()
    await rm(cwd, { recursive: true, force: true })
  }
})
