# Claude Code adapter boundary

Runrail drives Claude Code two ways. Both run the caller-installed, unmodified
`claude` with the login it already has.

| Route | Selected by | Process | Approvals |
|---|---|---|---|
| Agent SDK | `--harness-protocol sdk`, or the default when the SDK is available | One long-lived process per session | Each permission prompt becomes a Runrail approval |
| Print | `--harness-protocol print`, or the default without the SDK | One `claude --print` run per turn | Observed only; a prompt is refused |

## Current certification

2026-10-03, Claude Code `2.1.287`, Agent SDK `0.3.288`, Bun `1.4.2`, signed in
with a Claude subscription. Two bounded turns through the SDK route showed:

- `canUseTool` fired for a file write and for a command under `default`
  (Runrail's "Ask"). Approving applied the edit.
- `interrupt()` ended the turn at once. The same process answered a follow-up.
- `interrupt()` left a command that Claude Code had moved to the background
  running. The adapter therefore stops every background task the turn started
  when the turn is interrupted or cancelled.
- The login was found with only Runrail's filtered environment.

A later check through a Runrail session (Haiku, `permissionMode: "ask"`):

- A denied write left the file unwritten and the turn completed.
- A session-scoped answer let the same command run unasked in the next turn.
  The first run found that Claude Code's suggested rule targeted
  `.claude/settings.local.json` in the working directory, so the answer wrote
  a lasting rule. The adapter now keeps every such rule to the session; the
  rerun wrote no settings file.
- A cancel while an approval waited stopped the session in about 3 seconds and
  the tool did not run.
- A model switch reached the running process.
- A `priority: "next"` message sent during a running command joined the same
  turn: one result, two model steps. No process was left behind.
- A fork after one turn, opened as a second session, recalled the first
  session's conversation; the two kept separate Claude Code ids.

No prompt, response, credential, or vendor diagnostic was retained.

## Agent SDK route

`ClaudeAgentSdkBackend` hands turns to the SDK's streaming input and reads its
messages through the same mapper as print mode. The SDK is Anthropic's,
under its Commercial Terms. It is an optional peer dependency: Runrail never
ships it or imports its types, and every message it yields is parsed as
untrusted input. A compiled build that bundles it registers it with
`registerClaudeAgentSdk`, because a compiled binary cannot import a package it
did not bundle.

- Process: Runrail spawns it through `spawnClaudeCodeProcess`, detached, so a
  stop ends `claude` and its helpers as one group. `pathToClaudeCodeExecutable`
  is the `claude` found on the filtered `PATH`, never the SDK's bundled binary.
- Environment: the SDK's `env` replaces the child environment, so the child
  gets Runrail's filtered environment, any explicitly named credential
  variables, and `CLAUDE_AGENT_SDK_CLIENT_APP=runrail/<version>`. Without
  `env`, the SDK would pass all of `process.env`.
- Prompt: Claude Code's own system prompt (`preset: "claude_code"`) with the
  thread's instructions appended. User, project, and local settings load as
  they do for the CLI.
- Permission mode: `plan`, `default` (Ask), `acceptEdits`, `auto`, or
  `bypassPermissions`. An unset mode is sent as `default`, so the user's own
  Claude Code default can never be wider than what Runrail shows.
- Approvals: one `approval.required` per prompt, with the tool and its command,
  file, or address as the reason. An answer can cover the rest of the session
  (`scope: "session"`); Runrail then hands back the rule Claude Code itself
  suggested, kept to the session. Claude Code may suggest saving the rule to a
  settings file; Runrail never lets an answer write one. A cancel, a withdrawn prompt, or the turn timeout denies what is
  still waiting, so no tool waits forever.
- Leaving plan mode (`ExitPlanMode`) is an approval. A question
  (`AskUserQuestion`) is an approval too, carrying `questions` (ids `q1`,
  `q2`, ..., each with its choices; a written answer is always allowed). The
  answers sent with `approval.resolve` go back in the call's input, keyed by
  question text as Claude Code reads them. Declined, Claude Code is told the
  person chose not to answer. Approved without answers (a client that shows no
  questions), or a question too malformed to show, is sent back to be asked in
  the reply, and the call ends as `QUESTION_IN_REPLY`. A session rule never
  answers a question.
- MCP elicitation: an MCP server's form that no hook answered reaches Runrail
  through the SDK's `onElicitation` and is asked as questions (see the control
  protocol). The server hears `accept` with the answers, `decline`, or
  `cancel`; between turns it is cancelled.
- Settings: a model change goes to the running process. An effort change
  starts a fresh process at the next turn that continues the conversation.
- Conversation: Claude Code's `session_id` is kept beside the session. Within
  one process a different id fails the turn. A resumed conversation Claude
  Code no longer has is forgotten and the prompt runs once from a clean start.
- Steering: guidance sent while a tool runs joins the running turn as a
  `priority: "next"` message, which Claude Code reads after that tool's result.
  At any other point it is refused and the follow-up queues as the next turn.
- Fork: the SDK's `forkSession` copies Claude Code's transcript under a new
  id, kept for the target session; opening that session continues the copy.
  The copy is made in Runrail's process, so a fork is refused when the spawned
  `claude` would use a different `CLAUDE_CONFIG_DIR`, and when no session
  directory keeps the id. A conversation that has not started forks to a new
  one.

## Print route

The default command is equivalent to:

```sh
claude --print --output-format stream-json --verbose <prompt>
```

The adapter maps lifecycle, assistant, tool, approval, cancellation, failure,
rate-limit, and terminal events into the public agent protocol. Approval
requests are observable, but print mode has nobody to answer them, so Claude
Code refuses what it would ask about. A caller-supplied persistent protocol
may provide explicit control handlers for resume, fork, compaction,
model/thinking changes, MCP, and approval resolution; Runrail never infers
those controls from a long-lived process.

## Both routes

Subscription mode reuses the caller's existing Claude Code login. Environment
mode requires explicitly named credential variables. Runrail never reads
Claude auth files, persists credentials, or claims the vendor process is a
hostile-code sandbox.

If Claude emits a terminal authentication result, including an expired OAuth
session, Runrail fails the turn with a stable authentication code and does not
run verification or repair against it. A refused key or sign-in that Claude
Code would retry (`system` `api_retry` with `error: "authentication_failed"`,
ten attempts over more than a minute) fails the turn at the first retry.
Any other `api_retry` keeps the turn going and is shown and recorded as an
`api.retry` live frame, so a turn waiting on Claude Code's retries says so.

A rejected `rate_limit_event`, an HTTP 429 `api_retry`, or an assistant
`rate_limit` error ends either route with `COMMAND_AGENT_RATE_LIMITED`.
Runrail stops the query or print process immediately and displays a safe
usage-limit message, including the weekly window and reset timestamp when
Claude supplies them. Allowed usage events and permitted overage do not stop
the turn.

A tool connection can give Claude Code a config folder of its own
(`CLAUDE_CONFIG_DIR`), signed in with `claude auth login --claudeai`: the
login is kept in the macOS Keychain apart from the user's usual one, and
`claude auth logout` there leaves the usual login alone (checked 2026-10-03,
Claude Code 2.1.287). A key connection runs in such a folder with the key as
`ANTHROPIC_API_KEY`, which Claude Code uses ahead of a claude.ai login and does
not write to its config. See
[`control-protocol.md`](../control-protocol.md#coding-tool-sign-in).

Claude-specific controls such as permission mode, allowed tools, model,
resume, session identity, MCP, hooks, skills, agents, and background tasks are
versioned matrix rows. Unsupported or TUI-only behavior remains pass-through,
caller-owned, or unavailable rather than being silently simulated.
