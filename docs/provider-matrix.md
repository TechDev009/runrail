# Provider compatibility matrix

This is the provider ownership contract for the Pi `0.84.1` target. Native
adapter means Runrail owns a provider-neutral protocol adapter and has a
deterministic fixture. Caller-owned means Runrail exposes a bounded seam but
does not own credentials, cloud identity, subscriptions, tenancy, or the live
provider operation. Pass-through means the user can use Pi's provider
ecosystem unchanged with `runrail pi`.

The machine-readable source is
`createDefaultProviderCompatibilityMatrix()` from the public providers API.

| Provider | Protocol | Classification | Credentials | Fixture | Status |
| --- | --- | --- | --- | --- | --- |
| OpenAI | Responses and Chat | native-adapter | environment-reference | `provider-openai` | verified |
| Anthropic | Messages | native-adapter | environment-reference | `provider-anthropic` | verified |
| OpenAI-compatible | Chat or Responses | native-adapter | environment-reference | `provider-openai-compatible` | verified |
| xAI / Grok | OpenAI-compatible | native-adapter | environment-reference | `provider-xai` | verified |
| Google | provider-specific | caller-owned | caller-owned | `provider-google` | verified |
| Vertex AI | provider-specific | caller-owned | caller-owned | `provider-vertex` | verified |
| Amazon Bedrock | provider-specific | caller-owned | caller-owned | `provider-bedrock` | verified |
| llama.cpp | local HTTP or process | caller-owned | caller-owned | `provider-llama.cpp` | verified |
| Pi provider registry | Pi native ecosystem | pass-through | Pi-owned | `provider-pi-pass-through` | verified |

The matrix names protocol families. The providers Runrail knows by name, with
each one's address, protocol, and request differences, are the preset table in
[`COMPATIBILITY.md`](COMPATIBILITY.md#provider-presets). A connection on a
preset takes its credential from a named environment variable, a key in the
credential vault, or a sign-in ([`accounts.md`](accounts.md#sign-in)). Two
presets, `xai-grok` and `kimi-code`, are reached through an unofficial plan
sign-in only and are not part of this matrix: no live run has verified them.

## What a provider session sends

A session on a native adapter sends, on every request:

- **Instructions** in the protocol's own field (Chat: a `system` message;
  Responses: `instructions`; Messages: `system`). By default this is Runrail's
  coding prompt (`defaultCodingPrompt`), then the project context under
  `# Project context`. The prompt has rules only for the tools that request
  offers, a plan-mode section when the thread is in plan mode, a line for the
  model family (`promptFamily`: `anthropic`, `openai`, `generic`), and the
  environment read once when the session starts. `--no-default-prompt` sends
  the project context alone.
- **The conversation**, with every earlier tool call and its result in the
  protocol's own shape. Calls this process made are replayed as they came
  back, Anthropic thinking signatures included. Calls from before a restart,
  a model switch, or an import are rebuilt from the local transcript. A tool
  result whose call is unknown is sent as `[result of tool <name>]` text.
- **Only what fits.** The conversation gets about two characters per token of
  the model's window (at least 24,000, at most 1,500,000). Past that, the
  oldest messages are shortened (`SHORTENED_TOOL_RESULT`), never the six
  newest.

Messages requests carry `cache_control` marks; Responses requests with
thinking on carry `include: ["reasoning.encrypted_content"]` and `store:
false`. Each is dropped for the rest of the adapter's life after the endpoint
answers 400 to it (Responses: 400 or 422).

## Transport limits and retries

A model stream is bounded by bytes (`maxStreamBytes`, 16 MiB by default, at
most 64 MiB). Its event count (`maxEvents`, about one event per token)
defaults to 1,048,576 and is at most 4,194,304, so a long reply or a large
file write ends at the byte limit, not the event count.

A model request or model list refused with 408, 425, 429, 500, 502, 503, 504,
or 529 before any of its body was read is sent again, up to `maxRetries`
(default 2, at most 5; a model list tries at most once more).
The wait doubles from `retryDelayMs` (default 500 ms) and never exceeds 10
seconds; a `retry-after-ms` or `Retry-After` header sets it instead. A 429
whose body names a used-up quota or billing, or a Retry-After past 10 seconds,
is not sent again. A cancelled turn stops waiting at once. A model stream is
never sent again once its body started, nor after a dropped connection or a
timeout.

## Credentials and ownership

Runrail accepts credential references, never raw API keys in persisted CLI or
RPC state. Resolvers return secrets transiently and adapters reduce failures to
stable payload-free provider error codes. Model discovery is opt-in and
bounded; offline catalog listing does not contact a network.

The default catalog exposes the caller-owned families as explicit descriptors.
Use `createCallerOwnedProviderModelAdapter` to register a model port supplied by
the embedding application; Runrail does not resolve that provider's credentials,
choose its endpoint, or claim protocol ownership. This makes the seam verified
without mislabeling it as a native adapter.

Adding a native provider requires a protocol fixture for text, tools,
multimodal input when supported, streaming, usage, cancellation, malformed
events, authentication failures, rate limits, and response bounds. Until that
fixture exists the provider remains caller-owned or pass-through.
