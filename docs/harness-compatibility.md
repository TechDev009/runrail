# Runrail harness compatibility

Runrail exposes one bounded lifecycle contract across native, Pi, command,
PTY, HTTP, and vendor-specific harnesses. The contract does not erase vendor
differences. Each capability is classified as native, pass-through, adapter,
caller-owned, or unavailable and is checked before execution.

## Current advertised rows

The machine-readable baseline is `createDefaultHarnessCompatibilityMatrix()`.
The current rows are:

| Harness | Current boundary | Runtime | Protocol | Status |
| --- | --- | --- | --- | --- |
| Native Runrail | Native | Runrail 0.5.x | `native.sessions` | Verified |
| Pi | Pass-through | Pi 0.84.1 target | `pi.cli` | Verified |
| Codex | Adapter | Caller-installed | `codex.exec.json` | Verified for bounded events |
| Codex app-server | Adapter | Codex 0.155.1 | `codex.app-server.v2` | Live-verified for the certified lifecycle |
| Claude Code | Adapter | Caller-installed | `claude.stream-json` | Verified for bounded events |
| GitHub Copilot CLI | Adapter | Copilot CLI 1.0.62 target | `acp.v1` | Verified against a stand-in; no live turn run |
| PTY | Caller-owned | Caller-installed | `runrail.pty.jsonl` | Caller-owned |
| OpenCode | Adapter | OpenCode 1.2.26 | `acp.v1` | Live-verified with a local model |
| Gemini CLI | Adapter | Gemini CLI 0.33 and later | `acp.v1` | Caller-owned; handshake checked with 0.62.0, no turn |
| Goose | Adapter | Goose 1.53.0 | `acp.v1` | Live-verified with a local model |
| Aider | Caller-owned candidate seam | Caller-installed | `runrail.jsonl` | Vendor protocol not claimed |
| Remote hosting | Caller-owned | Caller service | `runrail.http/1` | No hosted service bundled |

Candidate adapters are intentionally conservative. They run a caller-supplied
normalized JSONL wrapper and do not pretend that a vendor's human-oriented CLI
or editor extension has native machine-protocol parity.

The matrix also records `codex.approval` and `claude-code.approval` as
caller-owned: the default adapters normalize approval requests, but do not
resolve them. A caller-supplied persistent protocol must provide explicit
control handlers before approval resolution or stronger session controls are
advertised.

Codex app-server mode is the exception with a proven bidirectional control
protocol. The CLI and control routes use it for `--backend codex` when no
command, argument list, or protocol is given; `--harness-protocol app-server`
selects it explicitly and `--harness-protocol jsonl` keeps the exec path. The
library default stays `codex.exec.json`. The adapter is pinned to the versioned
`codex.app-server.v2` contract. The deterministic fixture and the installed
Codex 0.155.1 subscription probe cover handshake, streaming, approval
resolution, restart resume, fork, model/thinking/sandbox settings, and bounded
terminal behavior. The vendor process is still caller-owned and is not an
isolation boundary.

Claude Code's Agent SDK route (`claude-code.sdk`, `claude.agent-sdk`) is the
second bidirectional route. With the optional SDK available (`runrail sdk
install` downloads it) it is the default
for `--backend claude-code`; `--harness-protocol print` keeps print mode and
`--harness-protocol sdk` fails with `HARNESS_SDK_MISSING` without it. It
resolves approvals (once or for the session), interrupts, stops the background
tasks a cancelled turn started, takes guidance while a tool runs, switches the
model in place, and resumes the conversation. Fixtures cover it, and one live turn with Claude Code 2.1.287
covered approval and interrupt. The vendor process is caller-owned and is not
an isolation boundary. See `docs/vendor/claude-code.md`.

GitHub Copilot runs through GitHub's own CLI in its Agent Client Protocol
mode (`copilot --acp`). Runrail is the ACP client: it starts one conversation
per session, loads it again in a later process when the CLI supports that,
and answers the CLI's permission requests from the session's permission mode
(plan allows reading only; accept-edits also allows edits; ask sends an
approval to the caller; bypass allows all). A request to leave plan mode
(`switch_mode`, or what an agent's own plan mode lets through, such as Gemini
CLI's plan approval) goes to the person with the plan; after a yes, each
write is asked instead of refused. An answer goes only as a one-time option:
with none offered, the request is cancelled and the approval says why.
Runrail offers the agent no file or terminal access of its own and refuses
any other request. `--model` and
`--thinking` become the CLI's `--model` and `--effort` at process start.
Limits: ACP has no system-prompt field, so appended instructions travel as
the first block of a new conversation; no token usage is reported; and the
CLI has no command that says whether someone is signed in, so a missing login
shows as `COMMAND_AGENT_AUTH_FAILED` on the first turn.

OpenCode (`opencode acp`), Gemini CLI (`gemini --acp`, 0.33 and later), and
Goose (`goose acp`) run through the same ACP client, each with the unmodified
binary and the login or provider it already has (`--backend opencode|gemini|goose`).
Each tool decides for itself when to ask, so Runrail sets that up first:

| Tool | Default without Runrail | What Runrail sets |
|---|---|---|
| OpenCode | Every tool runs unasked | `OPENCODE_PERMISSION` asks before edits (except Auto-edit and Auto), `bash`, and the web tools; nothing under Bypass |
| Gemini CLI | Asks, unless the user's settings chose another approval mode | `--approval-mode default` |
| Goose | Every tool runs unasked (`auto`) | `GOOSE_MODE=approve` |

OpenCode and Goose apply Runrail's setting over the user's own: a rule in the
user's OpenCode config that denies one of those tools becomes a question
instead, and a Goose mode the user configured is replaced. OpenCode lists its
models for the conversation, so a model switches in place; Gemini CLI takes
`--model` at process start; Goose 1.53 takes the model as the conversation's
`model` config option (`session/set_config_option`), any id its provider
knows, and runs the one `goose configure` chose when none is named. Runrail
checks Goose's answer names the model it asked for and fails the turn
otherwise. Neither Gemini CLI nor Goose takes an effort from Runrail yet
(Goose offers a `thinking_effort` option per model). OpenCode's effort is part
of the model id (`provider/model/high`).

Goose 1.53.0 answers the handshake (protocol 1, `loadSession`, sessions it
can list, delete, and close; no fork or resume advertised, though
`session/fork` answers) with one sign-in method, `goose-provider` ("Run
`goose configure`"). With no provider set, `session/new` fails `-32603`
"Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER".
With one, it lists the modes `auto`, `approve`, `smart_approve`, and `chat`
(`GOOSE_MODE=approve` makes `approve` current) and the config options
`provider`, `mode`, `model`, and `thinking_effort`. Goose has no
`session/set_model`.

OpenCode 1.2.26 also differs from ACP in ways the route handles:

- It answers the prompt before it sends the end of its reply, so its turns
  stay open until its updates have been quiet for 300 ms (at most 2 s more).
- A failed model call ends the turn normally with nothing said and no tokens
  used; Runrail fails that turn instead of reporting an empty success.
- A permission request is titled with the bare tool name (`bash`) and no
  input; the approval reason takes the command from the tool's own updates.
- Its free OpenCode Zen tier refuses ACP clients ("can only be used from
  within OpenCode"); a provider the user set up in OpenCode works.

The OpenCode row is live-verified (2026-10-03, OpenCode 1.2.26, a local LM
Studio model, isolated OpenCode home): an approval under Ask ran the command,
and a fork continued in a second session remembered the parent's conversation.
The Goose row is live-verified too (2026-10-03, Goose 1.53.0, its `lmstudio`
provider with a local model, isolated home): Runrail's model reached Goose as
its `model` config option while the configured one was not loaded; an approval
under Ask wrote the file, a declined one left none, and a later turn
remembered the first. Goose titles a request with the tool and a target it
cuts short when long (`write · /long/pa...`); the approval reason takes the
full target from the request's input instead. The Gemini CLI row is built from
its published source and stays caller-owned until a live turn has run. Gemini CLI 0.62.0 answers the
handshake (protocol 1, `loadSession`, no fork) and opens no session until it
has a sign-in. Signed in with a personal Google account on the free "Gemini
Code Assist for individuals" tier, Google refuses the CLI itself
(`UNSUPPORTED_CLIENT`, checked 2026-10-03), so that account cannot run it
through Runrail or on its own; a Gemini API key or Vertex AI is the way in.
After `authenticate`, `session/new` lists the modes `default`, `autoEdit`,
`yolo`, and `plan` and the models Gemini CLI offers (`auto` first). Gemini
CLI does not refuse a folder it does not trust over ACP, unlike `gemini -p`:
it runs there with the project's own agents, hooks, and settings turned off.
A key connection runs in a home of its own, which trusts no folder, so every
project runs that way on one; Runrail does not mark a folder trusted for it.

Pi takes a model and a thinking level from Runrail as its own `--model` and
`--thinking` flags. The model is whatever Pi is signed in to, named
`provider/model`.

## Shared controls

Codex and Claude Code descriptors advertise approval events, not approval
resolution, in their default CLI modes. Their approval matrix rows are
caller-owned until a compatible control protocol is supplied. The checked-in
fixture catalog under `test/fixtures/harnesses/` is resolved by conformance
tests; fixture references are not decorative metadata.

Adapters may advertise `follow-up`, `cancel`, `interrupt`, `approve`, `reject`,
`resume`, `fork`, `compact`, `model`, `thinking`, `sandbox`, `mcp`, `inspect`,
and `close`. A missing control is a hard capability failure. Runrail does not
simulate resume, fork, compaction, approvals, or isolation when the backend
cannot prove the operation.

A fork on a coding-tool route asks the tool for a copy of the conversation and
keeps the copy's id for the target session, in the same store that keeps each
session's own conversation. A session later opened with the target id
continues the copy; the parent keeps its own. The routes that fork are Codex
(`thread/fork`), Claude Code over the Agent SDK (the SDK's `forkSession`), and
ACP tools that offer `session/fork` (OpenCode; not Copilot, Gemini CLI, or
Goose). A fork is refused during a turn, without a session directory to keep
the id in, and on a tool that cannot fork.

The shared control facade enforces:

- one active turn per session;
- bounded messages and event counts;
- matching session identity and monotonic event sequence;
- caller-owned metadata persistence without event payloads;
- explicit cancellation, terminal state, and close behavior;
- vendor control methods only when the adapter implements them.

## Authentication and trust

The Copilot route has one mode: the CLI's own login (`copilot login`).
Runrail does not sign in to GitHub, holds no GitHub token, and sends no other
editor's identity.

Command-backed Codex and Claude Code adapters default to subscription mode:
they reuse the vendor CLI's ordinary login under `HOME`. Runrail does not read
vendor auth files or treat a ChatGPT or Claude subscription as an API key.
Environment mode forwards only explicitly named variables. Caller mode is a
library-only resolver seam.

Native Codex `thread_id` and Claude Code `session_id` values are vendor-owned
identities. The adapters bind and validate them independently of the Runrail
session ID, then emit only normalized Runrail IDs. A later identity mismatch is
rejected. Vendor terminal authentication failures are classified as stable
`COMMAND_AGENT_AUTH_FAILED` errors before verification or repair can run.

External processes, plugins, and PTYs remain caller-owned execution. They are
not hostile-code sandboxes. Require a supplied OS, container, VM, or remote
executor when the task needs strong isolation.

Claude Code's print route stays one-shot: it observes approval requests but
cannot answer them. Persistent Claude controls come only from the Agent SDK
route; Runrail never infers them from the TUI.

## Release rule

The release certification profile may include the harness matrix. Rows marked
planned or active fail the release gate. Caller-owned, pass-through, and
unavailable rows are allowed only with a reason and an explicit fallback.
