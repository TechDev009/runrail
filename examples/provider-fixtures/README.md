# Provider fixtures

These fixtures document the wire shapes used by Runrail's first-party provider adapters. They are deterministic and contain no credentials.

The test suite uses local `Bun.serve` handlers for:

- OpenAI Responses and Chat Completions;
- Anthropic Messages;
- OpenAI-compatible and xAI/Grok-compatible endpoints; and
- malformed, oversized, cancelled, and rate-limited responses.

Start the local wire server with:

```sh
bun run examples/provider-fixtures/server.ts
```

It binds only to loopback and serves `/chat/completions`, `/responses`,
`/messages`, and `/models`. Pass the printed URL as the adapter `endpoint` and
keep `allowRemote: false`.

Use a caller-owned credential resolver in tests:

```ts
const resolver = createCallerCredentialResolver(() => "fixture-secret")
const adapter = createOpenAIModelAdapter({
  provider: "openai",
  model: "fixture-model",
  endpoint: localServerUrl,
  credential: { kind: "caller", account: "fixture" },
  credentialResolver: resolver,
})
```

Never place a real API key in a fixture, source file, CLI argument, RPC
parameter, session export, benchmark result, or test output.
