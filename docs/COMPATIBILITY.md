# Runrail compatibility matrix

Runrail is the independent harness. Pi is a supported compatibility backend, not a required runtime for native Runrail features.

## Protocol families

| Family | Runrail support | Ownership | Notes |
| --- | --- | --- | --- |
| Native Runrail | First-party | Runrail | Bounded tools, approvals, sessions, verification, repair, MCP, skills, plugins, connectors, worktrees, budgets, metrics, and handoffs. |
| Pi JSONL/RPC | First-party adapter | Pi process | `runrail pi` preserves Pi arguments and UX. `run --backend pi` normalizes the public Pi backend contract. |
| OpenAI Responses | First-party model adapter | Runrail transport, caller account | Streaming text, tool calls, images/files, reasoning options, usage, cancellation, and bounded errors. |
| OpenAI Chat Completions | First-party model adapter | Runrail transport, caller account | Streaming text, tool calls, images, tool results, usage, cancellation, and bounded errors. |
| Anthropic Messages / Claude | First-party model adapter | Runrail transport, caller account | Streaming text, tool use/results, images, reasoning options, usage, cancellation, and bounded errors. |
| OpenAI-compatible | First-party configurable adapter | Caller endpoint/account | Supports local endpoints and compatible services. Endpoint policy is explicit. |
| xAI / Grok-compatible | First-party helper | Caller account | Uses the compatible Chat protocol; no xAI credential or catalog is bundled. |
| Codex | First-party harness adapter | Caller-installed runtime | By default Runrail drives `codex app-server` over stdio. `--harness-protocol jsonl` runs `codex exec --json <prompt>` and maps its events; a custom command, argument list, or persistent mode uses the normalized JSONL bridge. |
| Claude Code | First-party harness adapter | Caller-installed runtime | By default Runrail drives Claude Code through the Claude Agent SDK, fetched from npm the first time it is needed; when it cannot be loaded it falls back to print/stream JSON. `--harness-protocol print` asks for print mode by name; a custom command, argument list, or persistent mode uses the normalized JSONL bridge. |
| PTY JSONL | First-party harness adapter | Caller-installed runtime | Uses Bun's PTY transport, suppresses input echo, supports resize/cancellation, subscription auth by default, and requires normalized machine-readable events. |
| Generic JSONL agent | Public adapter | Caller runtime | Use `CommandAgentBackend` or `createCommandAgentAdapter`. |
| HTTP/A2A agent | Public adapter | Caller service | Use `HttpAgentBackend` or `createHttpAgentAdapter`; remote access requires explicit policy. |
| MCP | First-party client/server bridge | Caller servers | Tools, resources, prompts, cancellation, authorization, approvals, and bounds are supported. |

## Feature negotiation

Adapters advertise capabilities and optional integration hooks. Runrail does not silently downgrade a requested capability.

- Unsupported backend capabilities fail before session execution.
- MCP, skills, plugins, connectors, and caller tools supplied to an external
  backend require that backend to advertise the capability and provide an
  integration hook.
- Native Runrail owns the bounded workspace tool loop and can consume the full
  native integration bundle directly.
- Pi and external runtimes retain their own process authority. Runrail does not
  claim that native workspace policy sandboxes an unrestricted external process.
- Provider-specific features use explicit model capabilities or namespaced
  adapter controls. Unknown provider or harness events fail closed.

### Background work by tool

| Tool | Background subagents | Background commands | Stop | Output |
| --- | --- | --- | --- | --- |
| Native Runrail | Not yet | `run_command {background: true}` | Process group SIGTERM, then SIGKILL | 256 KiB ring |
| Codex app-server (0.160) | `subAgentActivity` items, child turns on the same connection | `unifiedExecStartup` commands still running when their turn ends | `thread/backgroundTerminals/terminate`; subagents `turn/interrupt` then `clean` | 64 KiB ring of `outputDelta` |
| Claude Code (2.1.227, print mode) | `task_*` messages | `local_bash` tasks once backgrounded | Ends with its turn (`stopHint: "turn"`) | The announced output file, under the temp directory |
| Claude Code (2.1.287, Agent SDK) | `task_*` messages | `local_bash` tasks once backgrounded; they outlive their turn | `stopTask`; an interrupted or cancelled turn stops the tasks it started | The announced output file, under the temp directory |

Codex's background terminals and subagent items come from its experimental
API; the adapter sends `capabilities.experimentalApi: true` at `initialize`
and parses known fields only.

## Provider configuration

Credentials are referenced by environment name or a caller-owned resolver. Raw API keys are rejected from CLI arguments, RPC parameters, and persisted configuration.

Command-backed Codex and Claude Code adapters default to subscription mode:
they retain only the vendor CLI's ordinary process context, including HOME,
so an existing vendor login can be reused without an OpenAI or Anthropic API
key. Environment mode forwards only names supplied through
`--harness-credential-env`; caller mode is a library-only resolver boundary.
Runrail does not inspect private auth files, copy OAuth tokens, or treat a
ChatGPT subscription as an API credential.

Example native run:

```sh
runrail run --backend native --cwd /workspace \
  --provider openai \
  --provider-model gpt-4.1 \
  --provider-credential-env OPENAI_API_KEY \
  --provider-allow-remote \
  "inspect the task"
```

Use `models --json` for the offline deterministic catalog. Use `models --discover --provider ...` only when live model discovery is explicitly requested. Discovery returns validated descriptors only and never stores the raw provider response.

Supported environment defaults are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, and `OPENAI_COMPATIBLE_API_KEY`; callers may always select another environment name.

## Provider presets

`PROVIDER_PRESETS` is the table of providers Runrail knows by name. Each row
fixes the address, the protocol, the auth header, and the request differences
that provider needs, so a connection needs only a key. `--provider` accepts
any id below, and `connection.presets` returns the same table to a client.

| Id | Provider | Protocol | Key variable | Request differences |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI | Responses | `OPENAI_API_KEY` |  |
| `meta` | Meta AI | Responses | `META_API_KEY` |  |
| `anthropic` | Anthropic | Messages | `ANTHROPIC_API_KEY` | `x-api-key` auth |
| `minimax` | MiniMax (International) | Messages | `MINIMAX_API_KEY` | `x-api-key` auth; no model list |
| `minimax-cn` | MiniMax | Messages | `MINIMAX_CN_API_KEY` | `x-api-key` auth; no model list |
| `kimi-for-coding` | Kimi for Coding | Messages | `KIMI_API_KEY` | `x-api-key` auth |
| `stepfun-plan` | StepFun Step Plan | Messages | `STEPFUN_API_KEY` | `x-api-key` auth |
| `openrouter` | OpenRouter | Chat Completions | `OPENROUTER_API_KEY` | `max_completion_tokens`; `reasoning: { effort }` |
| `google` | Google Gemini | Chat Completions | `GEMINI_API_KEY` | `max_completion_tokens` |
| `groq` | Groq | Chat Completions | `GROQ_API_KEY` | `max_completion_tokens` |
| `xai` | xAI | Chat Completions | `XAI_API_KEY` | `max_completion_tokens`; no reasoning field |
| `mistral` | Mistral | Chat Completions | `MISTRAL_API_KEY` | `max_tokens`; no reasoning field; no `stream_options` |
| `deepseek` | DeepSeek | Chat Completions | `DEEPSEEK_API_KEY` | `max_tokens`; `thinking: { type }`; replays `reasoning_content` |
| `togetherai` | Together AI | Chat Completions | `TOGETHER_API_KEY` | `max_tokens`; `reasoning: { enabled }` |
| `fireworks-ai` | Fireworks AI | Chat Completions | `FIREWORKS_API_KEY` | `max_completion_tokens` |
| `cerebras` | Cerebras | Chat Completions | `CEREBRAS_API_KEY` | `max_completion_tokens` |
| `huggingface` | Hugging Face | Chat Completions | `HF_TOKEN` | `max_completion_tokens` |
| `nvidia` | NVIDIA | Chat Completions | `NVIDIA_API_KEY` | `max_tokens`; no reasoning field |
| `baseten` | Baseten | Chat Completions | `BASETEN_API_KEY` | `max_completion_tokens` |
| `vercel` | Vercel AI Gateway | Chat Completions | `AI_GATEWAY_API_KEY` | `max_completion_tokens` |
| `opencode` | OpenCode Zen | Chat Completions | `OPENCODE_API_KEY` | `max_completion_tokens` |
| `opencode-go` | OpenCode Go | Chat Completions | `OPENCODE_API_KEY` | `max_completion_tokens` |
| `zai` | Z.AI | Chat Completions | `ZAI_API_KEY` | `max_tokens`; `thinking: { type }` (Zhipu form) |
| `zai-coding-plan` | Z.AI Coding Plan | Chat Completions | `ZAI_API_KEY` | `max_tokens`; `thinking: { type }` (Zhipu form) |
| `zhipuai` | Zhipu AI | Chat Completions | `ZHIPUAI_API_KEY` | `max_tokens`; `thinking: { type }` (Zhipu form) |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | Chat Completions | `ZAI_CODING_CN_API_KEY` | `max_tokens`; `thinking: { type }` (Zhipu form) |
| `moonshotai` | Moonshot AI | Chat Completions | `MOONSHOT_API_KEY` | `max_tokens`; no reasoning field |
| `moonshotai-cn` | Moonshot AI (China) | Chat Completions | `MOONSHOT_API_KEY` | `max_tokens`; no reasoning field |
| `alibaba-cn` | Qwen (DashScope) | Chat Completions | `DASHSCOPE_API_KEY` | `max_completion_tokens`; `enable_thinking` |
| `alibaba-token-plan` | Qwen Token Plan | Chat Completions | `QWEN_TOKEN_PLAN_API_KEY` | `max_completion_tokens`; `enable_thinking` |
| `alibaba-token-plan-cn` | Qwen Token Plan (China) | Chat Completions | `QWEN_TOKEN_PLAN_CN_API_KEY` | `max_completion_tokens`; `enable_thinking` |
| `siliconflow-cn` | SiliconFlow | Chat Completions | `SILICONFLOW_API_KEY` | `max_completion_tokens` |
| `volcengine` | Volcengine Ark | Chat Completions | `ARK_API_KEY` | `max_completion_tokens`; `thinking: { type }` |
| `minimax-cn-openai` | MiniMax (OpenAI-compatible) | Chat Completions | `MINIMAX_CN_API_KEY` | `max_completion_tokens`; no reasoning field |
| `xiaomi` | Xiaomi MiMo | Chat Completions | `XIAOMI_API_KEY` | `max_completion_tokens` |
| `xiaomi-token-plan-cn` | Xiaomi Token Plan (China) | Chat Completions | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `max_completion_tokens` |
| `xiaomi-token-plan-ams` | Xiaomi Token Plan (Europe) | Chat Completions | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `max_completion_tokens` |
| `xiaomi-token-plan-sgp` | Xiaomi Token Plan (Singapore) | Chat Completions | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `max_completion_tokens` |
| `ant-ling` | Ant Ling | Chat Completions | `ANT_LING_API_KEY` | `max_tokens`; `reasoning: { effort }` |

Two more presets are sign-in-only: `xai-grok` (xAI Grok plan, Responses,
`https://api.x.ai/v1`) and `kimi-code` (Kimi Code plan, Messages with bearer
auth, `https://api.kimi.com/coding/v1`). They name no key variable and refuse
a pasted key; see [`accounts.md`](accounts.md#unofficial-plan-sign-ins-runrailauth-vendors).

Four custom presets take a user-supplied address: `custom-openai-chat`,
`custom-openai-responses`, `custom-anthropic` (`x-api-key`), and
`custom-anthropic-bearer`. Plain `http` is accepted only for this machine
and the local network.

What the adapters do for every provider:

- Send `User-Agent: runrail/<version>`. No other product's client identity
  is sent.
- Refuse a redirect from a provider endpoint instead of following it with the
  key.
- Chat Completions: send a token cap only when the caller set one, ask for
  usage in the stream unless the row says otherwise, and on a 400 or 422 retry
  without the reasoning field, then without parallel tool calls, then without
  both. The adapter remembers the combination that worked.
- Responses: send `store: false`.
- Messages: default cap of 16384 output tokens; when the caller set no cap
  and the endpoint answers 400, retry once with 4096 and remember it. A preset
  or custom address without a version segment gets `/v1`.

The request differences were written from public provider documentation and
pi's compatibility behaviour, and are covered by mock-provider tests. They
have not been exercised against the live endpoints. The key variable names for
`alibaba-cn`, `zhipuai`, `siliconflow-cn`, `volcengine`, and
`stepfun-plan` are conventional guesses; a connection can always name
another variable.

Amazon Bedrock, Azure OpenAI, Google Vertex AI, and Cloudflare are not
presets. They need cloud credentials Runrail does not manage and stay
caller-owned.

The model list for a connection merges the endpoint's own `/models` answer
with a metadata snapshot bundled at build time
(`src/providers/models-snapshot.ts`, regenerated by
`scripts/models-snapshot.ts`). Runrail makes no runtime request to a model
catalog. The snapshot is taken from models.dev (MIT License; see NOTICE) and
carries context windows, answer caps, reasoning and image support, and list
prices. A model the snapshot does not know carries only what the endpoint
itself reports.

## Caller-owned service connectors

The public connector barrel includes bounded factories for GitHub, Linear,
Jira, and Slack. They do not bundle accounts or credentials:

```ts
const github = createGitHubConnector({
  endpoint: "https://api.github.com/",
  allowRemote: true,
  credential: {
    reference: { kind: "environment", environment: "GITHUB_TOKEN" },
    resolver: createEnvironmentConnectorCredentialResolver(),
  },
})
```

Read/search actions may retry only when explicitly marked idempotent. Writes
require both capability admission and an approval callback. Jira uses a
resolver-backed Basic credential with a caller-supplied username. Local mock
servers can replace each endpoint while keeping `allowRemote: false`.

## Safety and limits

Provider and harness transports bound request/response bytes, stream bytes, events, messages, output, timeouts, retries, and cancellation. Retries occur only before streamed output and only for explicitly retryable transport requests.

Prompts, responses, tool inputs/outputs, binary parts, credentials, and raw provider diagnostics are transient. Evidence, handoffs, benchmarks, metrics, and exported sessions contain only bounded metadata and digests.

Local processes, Pi, command agents, plugins, and worktrees are not hostile-code sandboxes. Use an OS, container, or VM boundary when hostile code must be isolated.

`SandboxRegistry` and `negotiateSandbox` let an embedding application require a
real isolated OS, container, VM, or caller executor. The default
`UNSANDBOXED_PROCESS_DESCRIPTOR` is intentionally not eligible when isolation
is required. `createHostingProfile` requires TLS and authentication for every
non-loopback profile. See `docs/DEPLOYMENT.md` for the integration contract.

## Adding an adapter

An official or caller-owned adapter should:

1. implement the public model or `AgentBackend` contract;
2. declare accurate capabilities and security requirements;
3. parse all remote/runtime values as untrusted data;
4. map events without retaining raw payloads;
5. make cancellation, timeout, bounds, approvals, and terminal states explicit;
6. add deterministic local fixtures and certification probes; and
7. keep credentials, provider account state, and external service policy outside Runrail evidence.
