# Codex adapter boundary

## Current certification

The installed Codex CLI was `0.155.1` on 2026-09-26. Runrail completed a
bounded subscription-mode `codex.app-server.v2` turn through the native
adapter and passed the workspace verification command. The result is recorded
as metadata only; prompts, model output, tool payloads, credentials, and vendor
diagnostics are not retained.

## Approval and persistent-control boundary

The adapter normalizes Codex approval requests for observation, but the default
`exec --json` adapter does not resolve approvals. Approval resolution is
caller-owned and is recorded separately in the compatibility matrix. A
caller-supplied persistent protocol may provide explicit control handlers for
resume, fork, compaction, model/thinking changes, MCP, and approval resolution;
Runrail never infers those controls from a long-lived process.

Runrail's Codex adapter invokes the caller-installed CLI using a documented
machine-readable path and maps lifecycle, turn, assistant, tool, approval,
cancellation, failure, and terminal events into the public agent protocol.

By default Runrail starts Codex's app server and talks JSON-RPC over stdio:

```sh
codex app-server --listen stdio://
```

`--harness-protocol jsonl` uses the one-shot execution path instead:

```sh
codex exec --json <prompt>
```

A custom command, an explicit argument list, or persistent mode keeps the
caller's shape and uses the normalized JSONL bridge.

Subscription mode reuses the caller's existing Codex login. Environment mode
requires explicitly named credential variables. Runrail never reads Codex auth
files, persists credentials, or claims Codex's process is a hostile-code
sandbox.

## Persistent app-server mode

Runrail also exposes the explicitly selected, bidirectional app-server path:

```sh
bun run src/cli.ts run --backend codex --cwd /path/to/workspace \
  --harness-protocol app-server --harness-auth subscription --json \
  "complete the bounded task"
```

The certified protocol is `codex.app-server.v2`. The adapter validates the
initialize handshake, vendor thread identity, turn correlation, streaming
assistant and tool events, command/file approval requests, permission-profile
approval requests, and explicit decisions. Permission profiles are bounded
before an approved turn-scoped grant is sent back to Codex. A question Codex
asks (`item/tool/requestUserInput`) is an approval carrying `questions` under
Codex's own ids; its answers go back by id, and declined it gets no answers. A
secret question's answer is sent to Codex and never recorded. When Codex
settles a request itself (`serverRequest/resolved`), the waiting approval is
withdrawn. An MCP server's form (`mcpServer/elicitation/request`, including the
field-less form Codex sends before an MCP tool runs) is asked the same way and
answered in MCP's terms (`action`, `content`, `_meta`); with no turn running,
or from a thread that is neither this session's nor one of its sub-agents', it
is cancelled. It also covers
token/rate metadata, cancellation, restart resume, fork, model, reasoning,
sandbox, and close/reload behavior. `codex exec --json` remains the default;
app-server mode is never inferred from a long-lived process.

MCP reconfiguration, an explicit compaction request, network-policy mutation,
skills management, and vendor-specific UI controls are not advertised by this
adapter. Unsupported requests fail closed. The Codex process and its
subscription remain caller-owned; app-server mode is not a hostile-code
sandbox. Supply an OS, container, VM, or remote executor when isolation is
required.

Codex-specific controls such as persistent app-server sessions, model,
reasoning, sandbox, network, resume, fork, compaction, MCP, and skills are
advertised only after the installed CLI version exposes a corresponding
capability. Otherwise the caller may use pass-through or the generic command
adapter.

## Accounts and keys

A tool connection can give Codex a home of its own (`CODEX_HOME`), signed in
with `codex login --device-auth`, which needs no local port. That login is the
home's own `auth.json`; `codex logout` there removes only that file (checked
2026-10-03, Codex 0.160.0). A key connection runs in such a home and sends the
key with app-server's `account/login/start { type: "apiKey" }` on stdin, with
`cli_auth_credentials_store="ephemeral"` so Codex keeps it in memory. App-server
does not read `CODEX_API_KEY`; `codex exec` does, and the exec route gets the
key that way. The home keeps the user's `config.toml` (its model provider,
proxy, and MCP servers) away from the key. A refused key (a 401 in
`codexErrorInfo`) fails the turn at Codex's first retry and interrupts the
vendor turn. See
[`control-protocol.md`](../control-protocol.md#coding-tool-sign-in).

Quota failures (`usageLimitExceeded`, HTTP 429, or a structured quota error)
end either route with `COMMAND_AGENT_RATE_LIMITED` and a safe usage-limit
message. App-server's retry notifications are terminal for Runrail even when
`willRetry` is true: its process is stopped, and a later turn starts a new
process and resumes the saved thread. Usage-limit readings by themselves do
not end a turn.
