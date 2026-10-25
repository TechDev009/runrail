import { describe, expect, test } from "bun:test"
import {
  ConnectorError,
  createCallerConnectorCredentialResolver,
  createConnectorRegistry,
  createGitHubConnector,
  createHttpConnector,
  createJiraConnector,
  createLinearConnector,
  createSlackConnector,
  type ConnectorHttpCredential,
} from "../../src/index.ts"

function credential(scheme?: ConnectorHttpCredential["scheme"], username?: string): ConnectorHttpCredential {
  return {
    reference: { kind: "caller", account: "fixture" },
    resolver: createCallerConnectorCredentialResolver(() => "connector-fixture-secret"),
    ...(scheme === undefined ? {} : { scheme }),
    ...(username === undefined ? {} : { username }),
  }
}

describe("repository service connector adapters", () => {
  test("maps GitHub, Linear, Jira, and Slack actions through bounded local HTTP", async () => {
    const requests: Array<{ readonly path: string; readonly method: string; readonly authorization: string; readonly body: string }> = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        requests.push({ path: `${url.pathname}${url.search}`, method: request.method, authorization: request.headers.get("authorization") ?? "", body: await request.text() })
        if (url.pathname === "/conversations.list" || url.pathname === "/search.messages" || url.pathname === "/chat.postMessage") return Response.json({ ok: true, messages: [] })
        if (url.pathname === "/graphql") return Response.json({ data: { issueSearch: { nodes: [] } } })
        return Response.json({ ok: true, issues: [] })
      },
    })
    try {
      const endpoint = server.url.toString()
      const github = createGitHubConnector({ endpoint, credential: credential(), allowRemote: false })
      const linear = createLinearConnector({ endpoint, credential: credential(), allowRemote: false })
      const jira = createJiraConnector({ endpoint, credential: credential("basic", "fixture@example.test"), allowRemote: false })
      const slack = createSlackConnector({ endpoint, credential: credential(), allowRemote: false })
      const registry = createConnectorRegistry([github, linear, jira, slack])
      await expect(registry.invoke("github", "searchIssues", { query: "bug", owner: "example-org", repo: "runrail" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.read", "connector.search"] })).resolves.toMatchObject({ ok: true })
      await expect(registry.invoke("github", "createIssue", { owner: "example-org", repo: "runrail", title: "fixture", body: "line one\nline two" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.write"], approve: () => true })).resolves.toMatchObject({ ok: true })
      await expect(registry.invoke("linear", "searchIssues", { query: "bug" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.read", "connector.search"] })).resolves.toMatchObject({ data: { issueSearch: { nodes: [] } } })
      await expect(registry.invoke("jira", "searchIssues", { jql: "project = RUN" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.read", "connector.search"] })).resolves.toMatchObject({ ok: true })
      await expect(registry.invoke("jira", "createComment", { issueKey: "RUN-1", body: "first\r\nsecond" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.write"], approve: () => true })).resolves.toMatchObject({ ok: true })
      await expect(registry.invoke("slack", "listChannels", {}, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.read"] })).resolves.toMatchObject({ ok: true })
      await expect(registry.invoke("slack", "sendMessage", { channel: "C123", text: "hello\nworld" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.notify", "connector.write"], approve: () => true })).resolves.toMatchObject({ ok: true })
      expect(requests.map((request) => request.path)).toEqual([
        "/search/issues?q=bug+repo%3Aexample-org%2Frunrail&per_page=30",
        "/repos/example-org/runrail/issues",
        "/graphql",
        "/rest/api/3/search?jql=project+%3D+RUN&maxResults=30",
        "/rest/api/3/issue/RUN-1/comment",
        "/conversations.list?limit=100",
        "/chat.postMessage",
      ])
      expect(requests[0]?.authorization).toBe("Bearer connector-fixture-secret")
      expect(requests[2]?.authorization).toBe("connector-fixture-secret")
      expect(requests[3]?.authorization).toMatch(/^Basic /)
      expect(requests[1]?.body).toContain('"title":"fixture"')
      expect(requests[2]?.body).toContain("RunrailIssueSearch")
      expect(requests[6]?.body).toContain('"channel":"C123"')
      expect(requests[1]?.body).toContain('"body":"line one\\nline two"')
      expect(requests[6]?.body).toContain('"text":"hello\\nworld"')
      await expect(registry.invoke("slack", "sendMessage", { channel: "C123\nC456", text: "x" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.notify", "connector.write"], approve: () => true })).rejects.toMatchObject({ code: "CONNECTOR_INVALID" })
      expect(JSON.stringify(github)).not.toContain("connector-fixture-secret")
      expect(JSON.stringify(github)).not.toContain("credential")
    } finally {
      await server.stop()
    }
  })

  test("requires approval for writes and rejects remote endpoints without opt-in", () => {
    const github = createGitHubConnector({ endpoint: "http://127.0.0.1:1", credential: credential(), allowRemote: false })
    const registry = createConnectorRegistry([github])
    expect(registry.invoke("github", "createIssue", { owner: "example-org", repo: "runrail", title: "blocked" }, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.write"] })).rejects.toMatchObject({ code: "CONNECTOR_APPROVAL_DENIED" })
    expect(() => createGitHubConnector({ endpoint: "http://service.example", credential: credential(), allowRemote: false })).toThrow(ConnectorError)
  })

  test("retries idempotent reads, bounds responses, and honors cancellation", async () => {
    let attempts = 0
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/retry") {
          attempts += 1
          return attempts === 1 ? new Response("retry", { status: 503 }) : Response.json({ ok: true })
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
        return Response.json({ ok: true })
      },
    })
    try {
      const connector = createHttpConnector({
        descriptor: { id: "fixture-http", version: "1.0.0", capabilities: ["connector.read"] },
        endpoint: server.url.toString(),
        allowRemote: false,
        retryDelayMs: 1,
        actions: [
          { name: "retry", description: "retry", kind: "read", capabilities: ["connector.read"], path: "/retry", retryable: true },
          { name: "slow", description: "slow", kind: "read", capabilities: ["connector.read"], path: "/slow" },
        ],
      })
      const registry = createConnectorRegistry([connector])
      await expect(registry.invoke("fixture-http", "retry", {}, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.read"] })).resolves.toEqual({ ok: true })
      expect(attempts).toBe(2)
      const abort = new AbortController()
      const pending = registry.invoke("fixture-http", "slow", {}, { cwd: "/tmp", signal: abort.signal, allowedCapabilities: ["connector.read"] })
      abort.abort()
      await expect(pending).rejects.toMatchObject({ code: "CONNECTOR_CANCELLED" })
    } finally {
      await server.stop()
    }
  })

  test("preserves an endpoint path prefix for connector actions", async () => {
    let pathname = ""
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        pathname = new URL(request.url).pathname
        return Response.json({ ok: true })
      },
    })
    try {
      const connector = createHttpConnector({
        descriptor: { id: "prefix-http", version: "1.0.0", capabilities: ["connector.read"] },
        endpoint: `${server.url}v1`,
        allowRemote: false,
        actions: [{ name: "read", description: "read", kind: "read", capabilities: ["connector.read"], path: "/models" }],
      })
      const registry = createConnectorRegistry([connector])
      await expect(registry.invoke("prefix-http", "read", {}, { cwd: "/tmp", signal: new AbortController().signal, allowedCapabilities: ["connector.read"] })).resolves.toEqual({ ok: true })
      expect(pathname).toBe("/v1/models")
    } finally {
      await server.stop()
    }
  })
})
