# Runrail control protocol

This document is the public contract for a desktop client embedding the
Runrail-native control CLI. It describes only the public HTTP and process
boundary. A client must not depend on private Runrail or Nifra TypeScript
implementation details.

## Version and scope

The current native control protocol is protocol `1`, API version `1.0`. New
fields are additive. A client that sends no protocol field is treated as a
protocol-1 client for backward compatibility. A request with an unsupported
protocol is rejected with `CONTROL_UNSUPPORTED_VERSION` and HTTP 400.

One control process owns one Runrail session and one project scope. It is not a
multi-workspace daemon. The desktop should provide a stable `--session-id` and
`--session-dir` when it needs task or session state to survive a process
restart. The process reports the effective `sessionId` and `projectId` in its
handshake and health response.

Optional desktop capability states, workspace controls, caller-owned
transcripts, and terminal bridge methods are defined in
[`control-desktop-capabilities.md`](control-desktop-capabilities.md). Clients
must use `capabilityStatus` from the handshake, health response, or
`control.describe` before calling optional methods.

By default the `src/cli.ts control` sidecar reports `terminal.*` as
`unavailable`. `--terminal` opts in to the built-in local PTY bridge
(`runrail.pty`, see the terminal section of the capabilities document);
`--terminal-shell <path>` picks its shell from those listed in `/etc/shells`.
`--transcript-dir <path>` opts in to caller-owned transcripts; connectors and
agents require an embedding process to supply their implementation.
`--worktree-root <path>` moves thread worktrees away from the default
`~/.runrail/worktrees`.
`--threads-dir <path>` names a client's thread folders and turns on
`conversation.peek`.
`--accounts-dir <path>` sets the directory that holds the account list shared
by every engine on the machine (default `RUNRAIL_ACCOUNTS_DIR`, then
`~/.runrail/accounts`). `--credential-vault keychain|file|memory|none` picks
where keys and sign-in tokens are kept (default `RUNRAIL_CREDENTIAL_VAULT`,
then `keychain`); see [Credentials and network policy](#credentials-and-network-policy).
Programmatic `createNativeControlRuntime` uses the same shared account default;
`accountsRoot` explicitly overrides it. Thread state remains in `stateRoot`.
`--exit-on-stdin-close` stops the sidecar when its stdin reaches end of file.
A host that starts the sidecar with a piped stdin and keeps the write end open
gets a sidecar that cannot outlive it, even when the host is killed before its
own cleanup runs. Input on stdin is ignored.

## Starting the process

Use JSON mode for a machine client:

```sh
bun run src/cli.ts control \
  --backend native \
  --cwd /path/to/workspace \
  --session-dir /path/to/session-state \
  --session-id desktop-session-1 \
  --port 0 \
  --json
```

The first JSON line on stdout is the `control.ready` handshake. Diagnostics
belong on stderr. The bearer token appears only in the handshake; do not log or
persist it. Non-JSON mode intentionally does not print the token.

The handshake contains:

- `type`: `control.ready`
- `protocol`: `1`
- `apiVersion`: `1.0`
- `supportedProtocols`: `[1]`
- `runrailVersion`
- `url` and `token`
- `sessionId`, `projectId`, and `scope: "single-session"`
- `capabilities`
- bounded `limits` for requests, events, and replay
- `eventRecovery`, which identifies `/events`, `task.events`, and `afterSeq`

The desktop owns the startup timeout. A five-second timeout is a reasonable
default for a local deterministic start, with a longer caller-configured
timeout for first-party provider or harness startup. If the first line is not
valid JSON with `type: "control.ready"`, terminate the child and report a
bounded startup error. Never treat human stderr as a readiness signal.

`control` does not check the workspace after a turn unless asked:
`--verify-after-turn` (or an explicit `--verification-command`) runs the check
after each turn and, when it fails, sends the agent a repair prompt, up to
`--max-repair-attempts`. Off by default, because a check that does not fit the
project fails after any message, and the repair prompt then has the agent edit
code nobody asked it to touch.

`serve` is a separate, published Nifra-compatible RPC surface. Its JSON
handshake is `rpc.ready`; it now includes `runrailVersion`, but its methods and
event contract are not the native control contract. Do not mix the two
surfaces.

## HTTP endpoints

### `GET /health`

`/health` is an unauthenticated liveness and contract-discovery endpoint. It
returns `ok: true` plus the same protocol, version, scope, capabilities, and
bounded limits advertised by `control.ready`. It does not return the bearer
token or workspace paths.

### `POST /rpc`

Send:

```json
{
  "protocol": 1,
  "method": "control.describe",
  "params": {}
}
```

The `protocol` field is optional for protocol-1 clients. Every request needs an
`Authorization: Bearer <token>` header and a JSON object body. Successful
responses have the shape `{ "ok": true, "result": ... }`. Failures have the
shape `{ "ok": false, "error": { "code": "...", "message": "..." } }` and
also carry the bounded `x-runrail-error-code` response header.

`control.describe` returns the public contract and is safe to call after every
connect or reconnect. The request body is bounded to 1 MiB by default. Invalid
UTF-8, invalid JSON, unknown protocol versions, unknown methods, and malformed
parameters fail closed with stable error codes. The server does not echo raw
request bodies in errors.

Important control method families include:

- `task.create`, `task.list`, `task.snapshot`, `task.events`, `task.start`,
  `task.enqueue`, `task.steer`, `task.cancel`, `task.approve`,
  `task.reject`, `task.rename`, and `task.remove`
- `turn.enqueue`, `turn.steer`, and `turn.cancel` for the process-local
  session facade. A message's text is at most 256 KiB characters. A reply
  longer than one event's text arrives as consecutive `assistant.message`
  events; each one but the last is longer than three quarters of that, which
  is how `session.conversation.read` joins them. `turn.steer` with text only
  joins the running turn where the turn can take it: on a connected model, at
  the model's next step after the latest tool results; on Claude Code, while
  one of its tools runs; on
  Codex (app-server route), through Codex's own `turn/steer`, which checks the
  turn it names is still the one running. The call then returns at once with
  no events. The transcript records it after the running tool's result as a
  user message with `steer: true`, and `session.conversation.read` marks it
  the same way. Text the turn cannot take (during a connected model's last
  step, on Claude Code between tools, refused by Codex), text with
  attachments, another coding tool, or no running turn go to the front of the
  queue and run as the next turn. With `liveOnly: true` (capability
  `turn.steer.live`, which follows `backend.switch` and says `unavailable` on
  routes that never take guidance mid-turn) nothing is queued: it answers
  `{ steered, events: [], live }` at once, and `steered: false` leaves the
  message with the caller. A `liveOnly` that is not a boolean answers
  `CONTROL_INVALID_INPUT`. Both take an optional `idempotencyKey` (a native
  id, at most 256 characters): a call that repeats a key the session saw
  among its last 256 gets the first call's answer and starts nothing; a key
  whose first call failed may be used again.
- `approval.resolve` with `approvalId`, `approved`, optional `reason`, and
  optional `scope` (`once`, the default, or `session`; capability
  `approval.scope`). `session` also covers the rest of the session on a route
  that can remember an answer: Claude Code's Agent SDK route hands back the
  rule Claude Code suggested. Other routes treat it as `once`. Any other value
  fails with `CONTROL_INVALID_INPUT`. An approval or question waits up to 24
  hours, the longest Nifra's host holds one; past that it is declined, in the
  coding tool too, and a later answer finds nothing waiting. A coding tool's question (Claude Code's
  `AskUserQuestion`, Codex's `request_user_input`) arrives as an
  `approval.required` with `action: "question"`, `capability: "user.input"`,
  and `questions`: each has an `id`, `question`, optional `header` and
  `description` (one helper line), optional `kind` (`text` for a written
  answer only, `number` for a quantity; a choice when absent), `options`
  (`label`, optional `description`, `recommended` when the tool's label ends
  in "(Recommended)", and on a single-choice question an optional markdown
  `preview`), and optional `multiSelect`, `other` (a written answer is taken),
  `secret`, `placeholder` (text), and `min`, `max`, `step`, `defaultValue`,
  `unit` (number; `min` and `max` always). Claude Code and Codex questions
  always take a written answer. The `reason` is the title Claude Code gave the
  questions, if any. With capability `approval.questions`,
  `approval.resolve` takes `answers`, an object from question id to a
  non-empty array of answers (one unless `multiSelect`). An answer must be a
  choice's label unless `other` is set, and a number question's a number in
  its range and on its step. Answers that are not that shape fail with
  `CONTROL_INVALID_INPUT`; answers that do not fit the questions fail with
  `SESSION_ANSWERS_INVALID` and leave the question waiting. The
  `approval.resolved` that follows carries the recorded `answers`, never a
  `secret` one. With capability `approval.followUp`, a question set marked
  `takesFollowUp: true` (Claude Code with extended questions; never Codex or an
  MCP form) may instead be approved with `followUp: true`, the answers given so
  far (any, or none), and an optional `note` (at most 2,000 characters): the
  coding tool asks more questions before going on. `followUp` on a set without
  the mark fails with `SESSION_ANSWERS_INVALID`; `note` without `followUp`, or
  `followUp` with `approved: false`, fails with `CONTROL_INVALID_INPUT`. Its
  `approval.resolved` carries `followUp: true` and the `note`. A question is
  settled only by answers, a request for more, or a refusal, in every
  permission mode: approving one without answers fails and leaves it waiting,
  and Claude Code never goes on without an answer on its own timer. An MCP
  server's form (an elicitation Claude Code or Codex passes on) arrives the
  same way, with the reason `<server>: <message>` and one question per field
  (`q1`, `q2`, ...): a text field takes a written answer, a list its choices
  (several for an array of them), a number with a range a `number` question
  and one without a written number, and a boolean `Yes` or `No`. Every field is
  asked. A form with no fields is a plain approval with `capability:
  "user.input"`. The server hears `accept` with the answers, `decline` when
  declined, and `cancel` when approved without answers or withdrawn. Any other
  form, or a request to open a web page, is declined without asking: its
  `approval.required` is followed at once by an `approval.resolved` with
  `approved: false` and the reason. An `approval.resolved` with
  `withdrawn: true` means the coding tool took the request back before anyone
  answered it, or that nothing can carry an answer back to it (a print-mode
  route, or a persistent one without an approval handler); its `reason` says
  which.
- `session.snapshot`, `session.history`, `session.context`, and
  `session.tree`. `session.snapshot` carries `historyUnavailable: true` when
  the thread's transcript could not be read as the engine started: the
  session runs, but the model has none of the earlier messages.
- `session.checkpoints.list` and `session.checkpoint.changes { userSeq | turnId }` when
  `checkpoints` is available (`control --checkpoints`). Before each turn the
  engine snapshots the workspace, untracked files included, into a shadow
  repository in the session folder whose work tree is the workspace. Nothing
  is written into the workspace or its repository. In a git repository the
  shadow borrows its objects, its excludes and, once, its index, so only
  changed files are hashed. Ignored files, Runrail's runtime folders,
  regenerated folders (`node_modules`, virtual environments) and likely
  secrets (`.env`, keys) are left out. The last 50 snapshots are kept. The
  list gives each turn's `n`, `at`, `turnId`, `userSeq` (its user message in
  the transcript) and either `tree` or `skipped` (`too-large`, `failed`).
  `changes` lists the files that differ now from before that turn, each
  `modified`, `added` or `deleted`. A turn is named by `userSeq`, the `seq` of
  its user message in `session.conversation.read`, or by `turnId`, which names
  only a turn this engine ran: a coding tool numbers its turns again after a
  restart. A turn with no checkpoint answers `CONTROL_GIT_NOT_FOUND`
- `session.rewind { userSeq | turnId, files? }` when `session.rewind` is available: takes
  the thread back to before that turn's message, between turns only
  (`CONTROL_SESSION_BUSY` otherwise). The listed `files` (paths from
  `session.checkpoint.changes`) go back to the turn's checkpoint first; then
  the transcript loses the message and everything after it, a
  `session.rewound` record marks the cut (a notice in
  `session.conversation.read`), and the session starts again from what is
  left. Runrail's own loop reads the remaining messages. Where the coding
  tool can cut its own conversation, it does, and keeps its earlier tool
  results: Codex reverts its thread to before that turn (`thread/revert`),
  and Claude Code's next turn continues a copy of its conversation from the
  last message of the turn before (`--resume-session-at`, with
  `--fork-session`, so the original is left as it was). Neither happens until
  the transcript is cut, so a rewind that fails part way never leaves the
  tool's conversation shorter than the thread's. The record then carries
  `inTool: true` and the next turn gets no recap. Otherwise (a turn
  from before the engine kept these marks, an interrupted turn, a tool that
  cannot) its conversation is forgotten and the tool starts afresh with a
  recap. Answers
  `{ removed, restored, failed }`, where
  each failed file has a `reason`. A turn without a checkpoint answers
  `CONTROL_REWIND_UNAVAILABLE`. User messages in `session.conversation.read`
  carry the `turnId` of the turn that answered them.
- `thread.copy { from, to, beforeSeq? }` on an engine started with
  `--threads-dir` (capability `thread.copy`): copies a thread's conversation
  to a new thread with an empty transcript, marked as continued, as a
  rewind's kept copy. With `beforeSeq`, the seq of a user message that
  started a turn, only the records before it are copied: a fork from earlier
  in the conversation. A `beforeSeq` that names anything else answers
  `CONTROL_TRANSCRIPT_INVALID`. Answers `{ copied }`, which is `false` when
  there is nothing to copy. A `to` that already has a conversation answers
  `CONTROL_TRANSCRIPT_CONFLICT`
- `backend.list`, `backend.current`, `backend.switch`, `model.list`, and
  `model.switch`
- `workspace.list { path?, maxDepth?, maxEntries? }` and `workspace.read {
  path, maxBytes? }`, relative to the workspace and under the agent's file
  rules (no credential files, nothing outside, no symlink out). A read answers
  `{ path, bytes, content, hash }`, `hash` being the text's SHA-256.
  `workspace.write { path, content, baseHash }` saves the person's edit to an
  existing file only when its text still hashes to `baseHash`; otherwise it
  answers `CONTROL_WORKSPACE_CONFLICT` (409) and leaves the file alone. It also
  refuses git's and Runrail's own files, and a file that is not UTF-8 text
  (`CONTROL_WORKSPACE_BINARY`, 415). The file's mode is kept and it is replaced
  in one step. Answers `{ path, bytes, hash }`
- `workspace.*` and `git.*` take `folder`, one of the related folders given
  with `control --add-dir` (as given, or its real path), when
  `workspace.folders` is available; paths are then relative to that folder,
  and git runs there. Any other folder is `CONTROL_INVALID_INPUT` (400). See
  [Related folders](#related-folders)
- `git.status`, `git.diff`, `git.log`, `git.stage`, `git.unstage`,
  `git.discard`, and `git.commit` when `git.read` or `git.write` is available
- `git.remote.list`, `git.push.preview`, and `git.push` when `git.remote` is
  available; `git.pr.create` and `git.pr.status` when `git.pr` is available
- `git.branches` when `git.branches` is available, `git.fetch` when
  `git.fetch` is, and `git.pr.list` when `git.pr.list` is
- `git.pr.search`, `git.pr.teams`, `git.pr.view`, and `git.pr.diff` when
  `git.pr.reviews` is available (see the desktop capabilities' Reviews inbox)
- `git.pr.review.post` and `git.pr.merge` when their capabilities of the same
  names are available; both need `confirm: true`. `git.pr.merge { auto: true }`
  turns on GitHub's auto-merge, so the pull request merges once its required
  checks pass, and answers `{ merged: false, auto: true }`
- `git.pr.checks.logs { owner, repo, number, host? }` when `git.pr.checks` is
  available: the failing checks on the pull request's head,
  `{ number, headCommit, failed, checks: [{ name, url?, log?, cut? }] }`. The
  first four are listed; a GitHub Actions job's `log` is the end (12,000
  characters at most, `cut` when longer) of what its failed steps printed,
  without colors or times. Other checks are named with their link only
- `git.pull` when `git.pull` is available; `git.diff { statsOnly: true }`
  when `git.diff.stats` is
- `codehost.list`, `codehost.set`, `codehost.connect`, `codehost.disconnect`,
  and `codehost.status` when `codehosts` is available; `codehost.remotes`
  when `codehost.remotes` is
- `worktree.list`, `worktree.create`, `worktree.remove`, and `worktree.apply`
  when `worktrees` is available
- `check.run` and `check.stop` when `checks` is available
- `setup.list`, `setup.save`, `setup.delete`, `setup.trust`, `setup.run.start`,
  `setup.run.status`, `setup.run.list`, `setup.run.answer`, and
  `setup.run.stop` when `setups` is available
- `eval.mine`, `eval.validate`, `eval.suites`, `eval.suite.get`,
  `eval.suite.save`, `eval.run`, `eval.status`, `eval.list`, and `eval.stop`
  when `evals` is available
- `memory.status`, `memory.recall`, `memory.add`, `memory.update`,
  `memory.forget`, `memory.list`, `memory.settings.get`, `memory.settings.set`,
  and `memory.source.list`, `.add`, `.remove`, `.sync` when `memory` is
  available
- `live.frames` when `live.frames` is available
- `background.list`, `background.output`, and `background.stop` when
  `background` is available (see [Background work](#background-work))
- `browser.take` and `browser.respond` when `browser` is available (see
  [Browser use](#browser-use))
- `threads.take` and `threads.respond` when `threads.tools` is available (see
  [Thread tools](#thread-tools))
- `computer.take` and `computer.respond` when `computer.tools` is available
  (see [Computer use](#computer-use))
- `connection.setImageModel`, which the agent's image tool reads when
  `image.tools` is available (see [Image tools](#image-tools))
- `session.conversation.read` when `session.conversation` is available;
  `conversation.peek` when `conversation.peek` is
- `session.compact` when `session.compact` is available, and
  `session.usage.read` when `session.usage` is; `usage.read` when
  `usage.read` is
- `claude.sdk.status` and `claude.sdk.install` when `claude.sdk` is available
- provider, harness, plugin, connector, account, package, share, skill, and
  metrics methods when their capability is advertised

Notes on some of these:

- `skills.setEnabled` changes the running session: the model's next request
  leaves the skill out of its skill catalog or has it back, and `skill_read`
  refuses a switched-off skill. A failed context rebuild undoes the switch and
  answers `CONTROL_INVALID_INPUT`.
- With `skills.invoke`, a `turn.enqueue` or `turn.steer` message object may
  carry `skills`: up to 8 skill ids whose bodies go with that turn. A
  malformed list answers `CONTROL_INVALID_INPUT`; an unknown or switched-off
  skill fails the turn with `CONTEXT_REFERENCE_NOT_FOUND`. A message that
  invokes a skill, by `skills` or a leading `/skill:<id>`, always runs as its
  own turn instead of steering the running one.
- `session.transcript.branch` copies the transcript and ends the copy with a
  `session.continued` record. `session.conversation.read` shows that record as
  a notice with code `session.continued`.
- A `write_file` tool item in `session.conversation.read` may carry
  `additions`, `deletions`, and `created`: the lines the write changed against
  the old file, and whether it made a new file.
- `metrics.snapshot` includes totals recorded before an engine restart for the
  same session.
- `session.compact` takes an optional `reason` (`manual`, the default,
  `threshold`, `overflow`, or `workflow`) and compacts the conversation the
  model reads. On Claude Code (Agent SDK route) it sends Claude Code's own
  `/compact`; on Codex (app-server route) it runs `thread/compact/start`; on
  Runrail's own loop it compacts Runrail's prompt window. Other routes answer
  `CONTROL_CAPABILITY_UNAVAILABLE`, and `capabilityStatus["session.compact"]`
  says `unavailable` for them; it follows `backend.switch`. It runs between
  turns only: during a turn, or with one queued, it answers
  `CONTROL_SESSION_BUSY`. While it runs the session reads as active, and a
  `turn.enqueue` meanwhile waits and runs after it. It answers
  `{ before, after, reason }` (plus `removed` on Runrail's loop). A coding
  tool's compaction also publishes a `memory.compacted` event; its `after` is
  the tool's own reading where it has one (Claude Code), else an estimate
  (Codex), and a `context.usage` live frame marked `estimated` follows. The
  tool's own failures answer `SESSION_COMPACT_FAILED` with a message worded by
  Runrail (for example "the conversation has nothing to compact yet").
- `session.usage.read` answers `{ context?, plan? }`: the context reading
  (`usedTokens`, `windowTokens`, `autoCompactAt`, `estimated`) and the
  subscription's `plan.limits` frame. It never starts a coding tool: before its
  process runs the answer is `{}`. Claude Code is asked for its context in
  full and, at most once a minute, for its plan usage; Codex answers its last
  reading and its rate limits. Whatever is read is also sent as live frames.
- `claude.sdk.status` (capability `claude.sdk`) answers whether Claude Code
  can use the Claude Agent SDK: `{ ready, source, package, version, npmUrl,
  termsUrl, installCommand }`. `source` is `registered`, `installed`, or
  `downloaded` when it is ready, `installable` when this engine can download
  it, and `missing` otherwise; without it Claude Code runs in print mode and
  cannot ask before tools. `claude.sdk.install { confirm: true }` downloads it
  through the installer a build registered (`registerClaudeAgentSdkInstaller`)
  and answers the new status; only the person's own yes should send it, since
  the SDK is Anthropic's, under its terms. With no installer it fails with
  `CONTROL_CAPABILITY_UNAVAILABLE` naming `installCommand`, and a failed
  download fails with `CONTROL_CLAUDE_SDK_INSTALL_FAILED` and its reason. A
  thread engine started before the download keeps print mode until it is
  started again.
- `usage.read { tool, connectionId?, refresh? }` (capability `usage.read`) reads a
  coding tool's plan usage with no thread running, so a client can show it at
  start. `tool` is `claude-code` or `codex`; without `connectionId` it reads
  the tool's usual login, with one it reads that connection's own folder. The
  tool is started for that account the way a thread on it would be, in an
  empty `usage` folder under the session folder, asked, and stopped. Claude
  Code runs with no settings sources, only an empty MCP list, and
  `persistSession: false`, so no hook, MCP server, plugin, or conversation
  file comes of it; Codex is sent `initialize` and `account/rateLimits/read`
  only. One tool process runs at a time, each account has one read in flight,
  and an answer under a minute old is given again unless a reported window
  has reset. `refresh: true` bypasses that cache while sharing any read already
  in flight; non-boolean values are refused. It answers `{ plan }`, a
  `plan.limits` frame: shares and reset times only, and for Claude Code
  `extraUsage` when it says whether extra usage can serve requests past a
  used-up window (left out when it does not say). Claude's structured
  `session` and `weekly_all` rows take precedence over legacy fields. Its
  session window keeps the normalized `five-hour` id for compatibility;
  clients label it "Session limit" for Claude and retain duration labels
  for Codex. A key connection, a
  signed-out tool, or one with no plan fails with `USAGE_UNAVAILABLE` (409),
  a missing tool with `TOOL_UNAVAILABLE` (501), an unknown connection with
  `CONNECTION_NOT_FOUND` (404), and another tool's connection with
  `CONNECTION_INVALID` (400).
- `push.vapid` and `push.send` (capability `push`) are Web Push for a
  client's paired phones. `push.vapid` answers
  `{ publicKey }`, this computer's VAPID key (an uncompressed P-256 point,
  base64url) that a phone subscribes with; the key pair is made on first use
  and kept owner-only in `~/.runrail/push/vapid.json` (`pushDir`).
  `push.send { subscription, contact, message }` takes the phone's
  `PushSubscription.toJSON()`, the phone page's https origin as the VAPID
  `sub`, and `{ title, body, url?, tag?, urgency? }` (title up to 120
  characters, body 300, `url` a path on the phone page). The message is
  encrypted for that phone (RFC 8291, aes128gcm), so its push service cannot
  read it, and posted with a 12-hour VAPID token (RFC 8292) and a one-day TTL.
  Only Apple's, Google's, Mozilla's and Microsoft's push services are posted
  to; any other endpoint fails with `CONTROL_INVALID_INPUT` (400). It answers
  `{ delivered: true }`, or `{ delivered: false, gone: true }` when the service
  says the subscription is gone (404 or 410) and the client should forget it;
  an unreachable service or another answer fails with `CONTROL_PUSH_FAILED`
  (502). Nothing about a message is logged.
- Claude Code's own auto-compaction inside a turn becomes a `memory.compacted`
  event with `reason: "threshold"`.

Clients should gate optional methods on `capabilities` and handle a stable
unavailable error instead of probing private method names.

#### Background work

Work an agent leaves running after its tool call returns: a subagent, or a
shell command. Entries come from three places: Claude Code's `task_*`
messages, Codex's subagent items and background terminals (Runrail opts in to
Codex's experimental API for these), and Runrail's own `run_command` with
`background: true`. Each change is a `background.state` live frame carrying
the whole entry:

```json
{
  "id": "native:cmd-1",
  "kind": "command",
  "status": "running",
  "label": "bun run dev --port 5173",
  "startedAt": 1790000000000,
  "stoppable": true,
  "hasOutput": true
}
```

`kind` is `agent` or `command`. `status` is `running`, `completed`, `failed`,
`stopped`, or `unknown`. Optional fields: `detail` (latest summary or step),
`agentType`, `callId` (the tool call that started it, so its steps can be
found by lineage), `foreground` (still tied to its turn), `startedAt`,
`endedAt`, `exitCode`, `tokens`, `toolUses`, `durationMs`, and
`stopHint: "turn"` (only stopping the turn ends it). Labels (at most 200
characters) and details (500) pass a redactor that removes URL user info,
authorization headers, bearer tokens, `--token=`-style flags, secret-named
`NAME=value` pairs, and common key shapes. Entries live in memory only, at
most 32 finished ones per session, and end with the engine.

- `background.list {servers?: boolean}` returns `{entries, lastLiveSeq}`.
  With `servers: true` it also returns `servers` (`{port, host, process}`:
  TCP ports the engine's own descendant processes listen on, with the
  executable's name only) and `serversAvailable` (false off macOS and Linux).
  The scan reads `ps` and `lsof`, at most every 2 seconds, and never signals
  what it finds.
- `background.output {id, maxBytes?}` returns `{id, text, truncated}`: the
  latest output, at most `maxBytes` (default 64 KiB, at most 256 KiB).
  Runrail's own commands and Codex's keep a bounded ring; Claude Code's come
  from the output file it announced for that task, read only when that path
  resolves to a regular file under the system temp directory.
- `background.stop {id}` stops one entry through its source: Runrail's own
  command gets SIGTERM to its process group, then SIGKILL after 3 seconds;
  Codex commands go through `thread/backgroundTerminals/terminate`; a Codex
  subagent gets `turn/interrupt` and then `thread/backgroundTerminals/clean`
  on its thread. Stopping what already ended answers its status.

Errors: `BACKGROUND_NOT_FOUND` (404), `BACKGROUND_OUTPUT_UNAVAILABLE` (409),
`BACKGROUND_STOP_UNSUPPORTED` (409, also for work that ends with its turn),
`BACKGROUND_STOP_FAILED` (502, also after 10 seconds without an answer), and
`CONTROL_INVALID_INPUT` (400).

Runrail's own `run_command {background: true}` still needs approval. It
returns an id at once; the agent reads output with `command_output {id,
afterSeq?}` and stops it with `command_stop {id}`. At most 4 run at once per
session, each with a 256 KiB output ring. They stop when the session or the
engine stops; an engine killed with SIGKILL cannot stop them.

#### Browser use

With `control --browser-tools`, the agent may use the browser preview the
desktop shows for the thread. It is off unless the flag is given; the desktop
restarts the engine to turn it on or off. Pages on this computer only
(`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) unless
`--browser-any-site` is also given; addresses are http or https without user
info. `browser` reads `available` when the switch is on and `configurable`
otherwise.

The tools: `browser_open {url}`, `browser_snapshot` (address, title, visible
text, and refs such as `e12` for links, buttons, and fields),
`browser_screenshot {width?}` (`width` one of `phone`, `tablet`, `desktop`:
the page as it lays out 390, 820, or 1280 px wide, from the artboards the
desktop shows side by side; without it, the page as the tab shows it),
`browser_click {ref}`, `browser_type {ref, text,
submit?}`, `browser_press {key}`, `browser_console`, `browser_network`
(recent requests: method, address without its query, status, type, time; no
headers or bodies), and `browser_eval {expression}`. Snapshot, console,
network, and eval text reaches the model wrapped as untrusted page content. Each route gets them its own way:

- Runrail's own loop: native tools, without `browser_screenshot` (tool results
  there are text only).
- Codex: `dynamicTools` on `thread/start`, answered through `item/tool/call`; a
  screenshot comes back as an `inputImage` data URL. Codex keeps a thread's
  tools with the thread and takes none on `thread/resume`, so a conversation
  that started with browser use off cannot gain the tools later. When the
  switch is on for such a conversation, its first turn sends a
  `browser.notice` live frame with `code: "BROWSER_TOOLS_UNAVAILABLE"`.
- Claude Code: an MCP server named `runrail_browser`, passed with
  `--mcp-config` and allowed with `--allowedTools mcp__runrail_browser`.
  Claude Code starts it as `runrail browser-mcp --endpoint-file <path>`; each
  call goes to `POST /browser`.

A call is announced as a `browser.request` live frame carrying only
`{requestId, action}`. The desktop claims it, acts, and answers:

- `browser.take {requestId}` returns `{requestId, action, params, expiresAt,
  anySite}` once; a replayed frame finds nothing (`BROWSER_REQUEST_NOT_FOUND`).
- `browser.respond {requestId, answer}`: `answer` is `{ok: true, result:
  {text?, image?}}` or `{ok: false, code, message}`. `text` keeps at most
  64 KiB. `image` (`{mediaType: "image/jpeg" | "image/png", dataBase64}`, at
  most 900 KiB of base64) is accepted for a screenshot only. A refusal's
  `code` is one of `BROWSER_DENIED`, `BROWSER_FAILED`, `BROWSER_SITE_REFUSED`,
  `BROWSER_OFF`, or `BROWSER_TIMEOUT`; anything else reads as
  `BROWSER_FAILED`. A malformed answer fails the call and answers
  `BROWSER_RESULT_INVALID` (400). An `eval` answer with `ok: true` must also
  carry `approved: true`: the client asked the person and they allowed that
  exact script. Without it the call fails as `BROWSER_RESULT_INVALID`.

The desktop checks the address against its own copy of the thread's switch
before it opens anything, and asks the person before every `browser_eval` in a
native dialog the page cannot answer. Click, type, and press need no approval:
they stay on the sites the thread allows (this computer unless the person
turned on any site). At
most 4 calls wait at once (`BROWSER_BUSY`, 429). A call waits 30 seconds for
its answer, an eval 120 seconds (`BROWSER_TIMEOUT`, 504). Stopping the engine
fails the calls still waiting (`BROWSER_CLOSED`).

Errors: `BROWSER_INVALID_INPUT` and `BROWSER_RESULT_INVALID` (400),
`BROWSER_SITE_REFUSED` and `BROWSER_DENIED` (403), `BROWSER_REQUEST_NOT_FOUND`
(404), `BROWSER_OFF` and `BROWSER_CLOSED` (409), `BROWSER_BUSY` (429),
`BROWSER_FAILED` (502), `BROWSER_TIMEOUT` (504), and
`CONTROL_CAPABILITY_UNAVAILABLE` (501) when the switch is off.

#### Related folders

`control --add-dir <path>` (up to eight, each an existing folder outside the
working folder and the others) names the project's related folders. The agent
may read and edit them beside the working folder: Runrail's own loop reaches a
file in one by its absolute path and `run_command` takes `cwd` there; Claude
Code gets `--add-dir` (`additionalDirectories` on the SDK route); Codex gets
them as writable roots. Other routes refuse them
(`FOLDERS_UNSUPPORTED_BACKEND`), as does a coding tool whose command line the
caller shapes by hand. The agent's file rules hold in each folder.

#### Thread tools

With `control --thread-tools`, the agent may reach the person's other threads
through the desktop, which knows them; the engine knows only its own.
`threads.tools` reads `available` when the switch is on and `configurable`
otherwise. The tools:

- `list_threads`: the threads the agent may reach, as the desktop lists them.
- `read_thread {thread}`: what the person asked there and its latest reply.
- `send_to_thread {thread, message, wait?}`: queues `message` (at most 8000
  characters) as that thread's next turn. It runs with that thread's own
  access settings, so anything it needs approved asks the person there. With
  `wait`, the call returns that thread's reply when its turn ends.

`thread` is an id from `list_threads` or an exact title (at most 256
characters). None of the tools asks before it runs. What `read_thread`
returns, and a reply `send_to_thread` waited for, reaches the model wrapped as
untrusted content from another thread. Runrail's own loop gets native tools
(`list_threads` and `read_thread` keep plan mode's read-only set); Codex gets
`dynamicTools` on `thread/start`, kept with the thread as the browser's are;
Claude Code gets an MCP server named `runrail_threads`, allowed with
`--allowedTools mcp__runrail_threads` and started as `runrail threads-mcp
--endpoint-file <path>`, whose calls go to `POST /threads`.

A call is announced as a `threads.request` live frame carrying only
`{requestId, action}`, `action` one of `list`, `read`, `send`. The desktop
claims it, applies its own rules (which threads, how many messages a turn may
send, how long a chain of threads messaging threads may grow), and answers:

- `threads.take {requestId}` returns `{requestId, action, params, expiresAt}`
  once; a replayed frame finds nothing (`THREADS_REQUEST_NOT_FOUND`).
- `threads.respond {requestId, answer}`: `answer` is `{ok: true, result:
  {text}}` (at most 64 KiB kept) or `{ok: false, code, message}`. A refusal's
  `code` is one of `THREADS_DENIED`, `THREADS_NOT_FOUND`, `THREADS_LIMIT`,
  `THREADS_FAILED`, `THREADS_OFF`, or `THREADS_TIMEOUT`; anything else reads
  as `THREADS_FAILED`. A malformed answer fails the call and answers
  `THREADS_RESULT_INVALID` (400).

At most 4 calls wait at once (`THREADS_BUSY`, 429). A call waits 30 seconds
for its answer, a send with `wait` 15 minutes (`THREADS_TIMEOUT`, 504).
Stopping the engine fails the calls still waiting (`THREADS_CLOSED`).

Errors: `THREADS_INVALID_INPUT` and `THREADS_RESULT_INVALID` (400),
`THREADS_DENIED` (403), `THREADS_NOT_FOUND` and `THREADS_REQUEST_NOT_FOUND`
(404), `THREADS_OFF` and `THREADS_CLOSED` (409), `THREADS_BUSY` and
`THREADS_LIMIT` (429), `THREADS_FAILED` (502), `THREADS_TIMEOUT` (504), and
`CONTROL_CAPABILITY_UNAVAILABLE` (501) when the switch is off.

#### Computer use

With `control --computer-tools`, the agent may see and use apps on the
person's Mac through the desktop, which decides which apps: only those the
person allowed. `computer.tools` reads `available` when the switch is on and
`configurable` otherwise. The tools:

- `computer_apps`: the apps the person allowed, and whether each runs.
- `computer_screenshot {app}`: the app's front window as an image.
- `computer_click {app, x, y, button?, clicks?}`, `computer_type {app, text}`
  (at most 2000 characters), `computer_key {app, key, modifiers?}` and
  `computer_scroll {app, x, y, direction, amount?}`: the app comes to the
  front first; `x` and `y` are pixels in its latest screenshot; each answers
  with a fresh screenshot.

`app` is a name or bundle id from `computer_apps` (at most 256 characters).
`key` is one printable character or a named key (`Return`, `Tab`, `Escape`,
`Backspace`, `Delete`, `Space`, the arrows, `Home`, `End`, `PageUp`,
`PageDown`, `F1` to `F12`); `modifiers` are distinct names from `command`,
`shift`, `option`, `control`. What the desktop says about the screen (app
names, window titles) reaches the model wrapped as untrusted content. Only
Codex (`dynamicTools` on `thread/start`, kept with the thread) and Claude Code
(an MCP server named `runrail_computer`, allowed with `--allowedTools
mcp__runrail_computer`, started as `runrail computer-mcp --endpoint-file
<path>`, whose calls go to `POST /computer`) get the tools: Runrail's own loop
reads tool results as text and cannot see a screenshot.

A call is announced as a `computer.request` live frame carrying only
`{requestId, action}`. The desktop claims it with `computer.take
{requestId}` (once; then `COMPUTER_REQUEST_NOT_FOUND`) and answers with
`computer.respond {requestId, answer}`: `{ok: true, result: {text, image?}}`
(text at most 32 KiB kept; an image, JPEG or PNG at most 900 KiB as base64,
after any action but `apps`) or `{ok: false, code, message}`, `code` one of
`COMPUTER_DENIED`, `COMPUTER_NOT_FOUND`, `COMPUTER_PERMISSION`,
`COMPUTER_FAILED`, `COMPUTER_OFF`, `COMPUTER_TIMEOUT` (anything else reads as
`COMPUTER_FAILED`). A malformed answer fails the call and answers
`COMPUTER_RESULT_INVALID` (400).

At most 2 calls wait at once (`COMPUTER_BUSY`, 429); each waits 30 seconds
(`COMPUTER_TIMEOUT`, 504). Stopping the engine fails the calls still waiting
(`COMPUTER_CLOSED`). Errors: `COMPUTER_INVALID_INPUT` and
`COMPUTER_RESULT_INVALID` (400), `COMPUTER_DENIED` and `COMPUTER_PERMISSION`
(403), `COMPUTER_NOT_FOUND` and `COMPUTER_REQUEST_NOT_FOUND` (404),
`COMPUTER_OFF` and `COMPUTER_CLOSED` (409), `COMPUTER_BUSY` (429),
`COMPUTER_FAILED` (502), `COMPUTER_TIMEOUT` (504), and
`CONTROL_CAPABILITY_UNAVAILABLE` (501) when the switch is off.

#### Image tools

With `control --image-tools`, the agent may make pictures with the image model
the person chose from their own connections (`connection.setImageModel`, see
[Connections](#connections)). Runrail names no provider: the image models on
offer are whichever ones the person's provider connections list. `image.tools`
reads `available` when the switch is on and `configurable` otherwise. One
tool:

- `image_generate {prompt, path, shape?, from?}`: `prompt` at most 4000
  characters; `path` a workspace path ending in `.png`, `.jpg`, `.jpeg`, or
  `.webp`; `shape` one of `square`, `landscape`, `portrait`; `from` a PNG,
  JPEG, or WebP in the workspace (at most 10 MB) to change instead of making
  a new picture.

The engine itself asks the chosen connection, with its stored credential, at
its own pinned address: OpenAI's images API (`images/generations`, or
`images/edits` as a form for `from`) for most connections, or a chat
completion with `modalities: ["image", "text"]` for a model whose listing says
it outputs images (OpenRouter). A size is sent only to the OpenAI image
families; a size or aspect the model refuses is dropped once. A picture
offered as an `https` address on the provider's file host is fetched without
the credential, never from this machine or its network. The file is saved
inside the workspace only, under the picture's real type (a JPEG asked for as
`.png` is saved as `.jpg`). The answer names the file, size, model, and
connection; Codex (`dynamicTools`) and Claude Code (an MCP server named
`runrail_images`, allowed with `--allowedTools mcp__runrail_images`, started
as `runrail images-mcp --endpoint-file <path>`, whose calls go to `POST
/images`) also get the picture when it is at most 3 MB. Runrail's own loop
gets the text. Plan mode leaves the tool out. Neither the prompt nor the
picture is logged, and a provider's refusal is reported in Runrail's words.

Errors: `IMAGE_INVALID_INPUT` (400), `IMAGE_AUTH_FAILED` (403),
`IMAGE_NO_MODEL` (409: none chosen, or its connection is off),
`IMAGE_REFUSED` (422: the provider's content rules) and `IMAGE_UNSUPPORTED`
(422), `IMAGE_RATE_LIMITED` (429), `IMAGE_FAILED` (502), `IMAGE_TIMEOUT`
(504).

### `POST /browser`

The route Claude Code's browser tools call. Body (at most 64 KiB): `{action,
input}`. It answers `{ok: true, result: {text, image?}}` or `{ok: false,
error: {code, message}}` with the statuses above. It takes only its own
token, a random 32 bytes the control token cannot stand in for and that opens
no other route. The engine writes that token and its address to
`endpoint.json` in a fresh `0700` folder under the system temp directory, as a
`0600` file, and removes the folder when it stops. `browser-mcp` reads the
file on every call and refuses one that others can read or that names
anything but a loopback address. Neither the address nor the token ever
appears on a command line.

### `POST /threads`

The route Claude Code's thread tools call, kept like `POST /browser`: body (at
most 64 KiB) `{action, input}`, answered `{ok: true, result: {text}}` or `{ok:
false, error: {code, message}}`, with its own token and endpoint file, which
`threads-mcp` reads.

### `POST /secret`

`/secret` is the only way a key enters the engine. It exists so that a raw key
never travels through `/rpc`, where params are validated, journaled, and
echoed in results. It is write-only: no endpoint or method returns a stored
key.

Send, with the same bearer token as `/rpc`:

```json
{ "accountId": "account-openrouter", "secret": "<the key>" }
```

The body must be a JSON object with exactly those two fields and at most
32 KiB. Surrounding whitespace is trimmed from `secret`; what remains must be
one line of 1 byte to 16 KiB with no control characters. The account must
exist, must not be revoked, and must have `authMode: "api-key"`. On success the
key is written to the credential vault, the account status becomes `ready`,
and the response is `{ "ok": true, "result": <account record> }`. The record
never contains the key.

A coding tool's key connection takes its key the same way, with `connectionId`
in place of `accountId` (one of the two, never both). The connection must have
`authMode: "api-key"`; the result is the connection as `connection.list` shows
it. See [Coding-tool sign-in](#coding-tool-sign-in).

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `CONTROL_INVALID_JSON`, `CONTROL_INVALID_INPUT` | body is not a JSON object, has an unknown field, or the key or account is not acceptable |
| 401 | `CONTROL_UNAUTHORIZED` | missing or wrong bearer token |
| 404 | `CONTROL_ACCOUNT_NOT_FOUND`, `CONNECTION_NOT_FOUND` | no such account or tool connection |
| 405 | `CONTROL_METHOD_NOT_ALLOWED` | any method other than `POST` |
| 409 | `CONTROL_ACCOUNT_REVOKED` | the account was revoked |
| 409 | `CONTROL_CAPABILITY_UNAVAILABLE` | the process has no credential vault (`account.secrets` is `configurable`) |
| 503 | `CONTROL_CREDENTIAL_STORE_FAILED` | the vault could not be written; `message` is `VAULT_TIMEOUT`, `VAULT_UNAVAILABLE`, `VAULT_PERMISSIONS`, or `VAULT_INVALID` |
| 413 | `CONTROL_BODY_LIMIT` | body over 32 KiB |

Errors never echo the request body. The endpoint emits no event and writes
nothing to the session journal.

### `POST /login-input`

A sign-in whose browser cannot come back to Runrail by itself (the callback
port is taken) ends with the user pasting the address they landed on. That
address carries a one-time sign-in code, so it stays off `/rpc` for the same
reason a key does. The endpoint is write-only and only moves a running
sign-in forward.

Send, with the same bearer token as `/rpc`:

```json
{ "loginId": "login-<uuid>", "input": "<the pasted address>" }
```

The body must be a JSON object with exactly those two fields and at most
16 KiB; `input` is at most 8 KiB. Accepted input is the full address on this
machine the vendor sent the browser to, its query string, or (only for a
sign-in that uses neither `state` nor extra return fields) the bare code. The
response is `{ "ok": true, "result": <sign-in snapshot> }`, the same shape
`auth.login.status` returns.

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `CONTROL_INVALID_JSON`, `CONTROL_INVALID_INPUT` | body is not a JSON object, has an unknown field, or `loginId` or `input` is malformed |
| 400 | `AUTH_INPUT_INVALID` | the text is not the address this sign-in ends on; the sign-in keeps waiting |
| 400 | `AUTH_STATE_MISMATCH` | the address belongs to another sign-in; the sign-in keeps waiting |
| 401 | `CONTROL_UNAUTHORIZED` | missing or wrong bearer token |
| 404 | `AUTH_LOGIN_NOT_FOUND` | no such sign-in |
| 405 | `CONTROL_METHOD_NOT_ALLOWED` | any method other than `POST` |
| 409 | `AUTH_LOGIN_FINISHED` | the sign-in already ended or already has what it needs |
| 409 | `CONTROL_CAPABILITY_UNAVAILABLE` | the process has no credential vault |
| 413 | `CONTROL_BODY_LIMIT` | body over 16 KiB |

Errors never echo the request body. The endpoint emits no event and writes
nothing to the session journal.

### `GET /events`

`/events` is an authenticated Server-Sent Events stream of live
`AgentEvent` values. It accepts `afterSeq` and bounded `maxEvents` query
parameters. The stream opens with a comment line even when there is nothing to
replay, and keep-alive comments are emitted periodically. It stays open until
the client disconnects or the server stops. The stream is
process-local and retained only in a bounded in-memory window. Its replay
cursor may expire with `CONTROL_CURSOR_EXPIRED`.

Live `AgentEvent` values are for UI latency and may contain prompt, tool-input,
or other payload-bearing fields supplied by the active backend. Do not persist
this stream as evidence or transcript data. The live stream is not a durable
restart log.

When `tool.presentation` is available, `tool.started` frames also carry a
bounded `presentation` object (kind, title, path, command, previews) derived
at send time. It is not part of the recorded event. Paths inside the
workspace are relative to it. A coding tool's file changes (`file_change`,
`apply_patch`) add `additions` and `deletions` when every change says its kind
and diff, and a one-file change adds its diff as a unified hunk in `content`.
Shell and verification calls add `intent` (`test`, `build`, `lint`,
`typecheck`, `commit`, `push`, or `pr`) when the call's exit status is plainly
that work's status.

When `live.frames` is available, the same stream also carries Runrail-owned
live frames as `event: runrail.live` with `id: live-<liveSeq>`. Frames carry
reasoning text, plan steps, subagent lineage, background work
(`background.state`), browser requests (`browser.request`,
`browser.notice`), the context reading (`context.usage`, with
`autoCompactAt` where the coding tool says where it compacts on its own), and
subscription usage (`plan.limits`), a coding tool's own reviews
(`approval.reviewed`, `reviewer.notice`), and its retries of a failed request
(`api.retry`: `attempt`, `maxRetries`, `delayMs`, and when known the HTTP
`status`, the tool's kind of `error`, and `waitedMs` for an API that sent
nothing) that `AgentEvent` cannot express. `afterLiveSeq` sets the live cursor; it defaults to `0` (replay the
retained window) when `afterSeq=-1` and to the current live cursor otherwise.
An expired live cursor restarts at the oldest retained frame instead of
failing the stream. Live frames are in-memory only; reviews, reviewer
notices, and retries are also kept in the session's transcript, so a
conversation read from the transcript still shows them. The conversation folds
one request's retries into one `api.retry` notice whose `retry` holds the
latest.

## Durable task recovery

Native task state and native task events are separate from the live session
event stream. `task.snapshot` is the authoritative current task state.
`task.events` returns bounded metadata-only `NativeEvent` values with a
per-task `afterSeq` cursor. The journal is persisted under the native state
directory and may expire old cursors with `NATIVE_CURSOR_EXPIRED`.

Use this reconciliation algorithm after connect, reconnect, or engine restart:

1. Call `/health`, then `control.describe`. Verify protocol, project, and
   session scope before sending commands.
2. Call `task.list` for the reported project. Do not use a caller-supplied
   project ID from another scope.
3. For each task, call `task.snapshot` and `task.events` with the last durable
   cursor. Apply metadata events in sequence order, then reconcile the UI to
   the task snapshot and its `revision`, `lastEventSeq`, `status`, and `digest`.
4. If the cursor expired, discard the local task-event cache, read the full
   bounded window with `afterSeq: -1`, and use the fresh snapshot as truth. A
   cursor gap is not permission to invent an event.
5. Treat a new process as a new live-event stream. Do not attempt to replay the
   old `/events` cursor across an engine restart. Reconcile through durable
   task state instead.
6. Retry a side-effecting task command with the same stable `idempotencyKey`.
   A `replayed` command result confirms that the previous command result was
   already committed. Do not generate a new key for an uncertain retry.

`turn.*` is a convenient session facade and is not a durable task journal. Use
`task.*` for desktop actions that must reconcile after disconnect or restart.
Payload-bearing transcript persistence remains opt-in through the caller-owned
transcript store and is independent of the metadata-only task journal.

## Scope and authorization

The control process derives one project scope from its configured native
runtime. Task creation, listing, snapshot, event reads, removal, and share
operations require both:

- the task `projectId` to match the process project; and
- the task `sessionId` to match the process session.

The server rejects a foreign scope with `NATIVE_AUTH_REQUIRED` and HTTP 403.
Changing workspace, project, or session requires starting a separately scoped
control process. Runrail does not silently become a shared multi-workspace
daemon.

## Error mapping

Clients should branch on error code first and use HTTP status as a coarse
fallback:

| HTTP | Meaning | Representative codes |
| --- | --- | --- |
| 400 | malformed request, unsupported contract, or a destination that is not allowed | `CONTROL_INVALID_JSON`, `CONTROL_INVALID_REQUEST`, `CONTROL_INVALID_INPUT`, `CONTROL_UNKNOWN_METHOD`, `CONTROL_UNSUPPORTED_VERSION`, `NATIVE_UNSUPPORTED_VERSION`, `CONTROL_CONNECTION_INVALID`, `CONTROL_CONNECTION_ENDPOINT_DENIED`, `CONTROL_ACCOUNT_SIGN_IN_ONLY`, `CONNECTION_INVALID`, `CONNECTION_MODELS_EMPTY`, `CONNECTION_MODEL_NOT_CHOSEN`, `CONNECTION_AUTH_UNSUPPORTED`, `PROVIDER_INVALID`, `PROVIDER_ENDPOINT_DENIED`, `PROVIDER_CONTENT_UNSUPPORTED` |
| 401 | missing or invalid bearer token | `CONTROL_UNAUTHORIZED` |
| 403 | authenticated caller is outside the resource scope | `NATIVE_AUTH_REQUIRED`, `SHARE_ACCESS_DENIED`, `CONTROL_GIT_FORBIDDEN` |
| 404 | resource or route does not exist | `CONTROL_NOT_FOUND`, `NATIVE_NOT_FOUND`, `CONTROL_ACCOUNT_NOT_FOUND`, `CONNECTION_NOT_FOUND`, `BACKGROUND_NOT_FOUND`, `BROWSER_REQUEST_NOT_FOUND` |
| 405 | wrong HTTP method for the route | `CONTROL_METHOD_NOT_ALLOWED` |
| 409 | state, cursor, idempotency, busy, or cancellation conflict | `CONTROL_CURSOR_EXPIRED`, `CONTROL_SESSION_BUSY`, `SESSION_BUSY`, `NATIVE_CURSOR_EXPIRED`, `NATIVE_STATE_CONFLICT`, `NATIVE_IDEMPOTENCY_CONFLICT`, `NATIVE_CANCELLED`, `CONTROL_GIT_CONFLICT`, `CONTROL_GIT_NOTHING_TO_COMMIT`, `CONTROL_GIT_IDENTITY_REQUIRED`, `CONTROL_GIT_HOOK_REJECTED`, `CONTROL_ACCOUNT_REVOKED`, `CONTROL_ACCOUNT_ENDPOINT_LOCKED`, `CONNECTION_DISABLED`, `CONNECTION_EXISTS`, `CONNECTION_STORE_BUSY`, `CONNECTION_KEY_MISSING`, `PROVIDER_CREDENTIALS`, `PROVIDER_AUTH_FAILED`, `PROVIDER_CALLER_OWNED`, `PROVIDER_CANCELLED`, `BACKGROUND_OUTPUT_UNAVAILABLE`, `BACKGROUND_STOP_UNSUPPORTED` |
| 413 | bounded request or stored result is too large | `CONTROL_BODY_LIMIT`, `NATIVE_LIMIT`, `ACCOUNT_LIMIT`, `CONNECTION_LIMIT`, `SHARE_LIMIT` |
| 429 | the provider is rate limiting the key | `PROVIDER_RATE_LIMITED` |
| 501 | optional caller-owned integration is not configured, or the backend lacks the capability | `CONTROL_CAPABILITY_UNAVAILABLE`, `SESSION_COMPACT_UNSUPPORTED`, `CONTROL_AGENT_UNAVAILABLE`, `CONTROL_CONNECTOR_UNAVAILABLE`, `CONTROL_TRANSCRIPT_UNAVAILABLE`, `CONTROL_GIT_UNAVAILABLE` |
| 502 | the provider or coding tool failed or answered with something Runrail cannot use, or a background task did not stop | `SESSION_COMPACT_FAILED`, `SESSION_COMPACT_INVALID`, `PROVIDER_FAILED`, `PROVIDER_RESPONSE_INVALID`, `PROVIDER_STREAM_FAILED`, `BACKGROUND_STOP_FAILED` |
| 503 | the credential vault failed | `CONTROL_CREDENTIAL_STORE_FAILED` |
| 504 | bounded local or provider operation timed out | `CONTROL_GIT_TIMEOUT`, `PROVIDER_TIMEOUT` |
| 500 | bounded internal operation or startup failure | `CONTROL_OPERATION_FAILED`, `CONTROL_SERVER_START_FAILED` |

Sign-in failures use their own `AUTH_*` codes, listed under
[Sign-in](#sign-in).

Error messages are diagnostic summaries, not a data channel. Clients must not
display them as evidence or assume they contain provider details.

A provider failure is never reported as HTTP 401. On this server 401 always
means the control token is missing or wrong, so a client can tell "the engine
refused me" from "the provider refused the key" (`PROVIDER_AUTH_FAILED`, 409).

## Credentials and network policy

Provider methods accept an environment variable name or an account reference,
never a raw API key, token, password, or secret. A desktop integration should
resolve secrets from its OS credential store and inject them ephemerally into a
child process or caller-owned credential broker. Secrets must not appear in
argv, JSON-RPC params, SSE events, native task events, transcripts, logs, or
error messages.

`POST /login-input` is the same kind of write-only path for the address a
user pastes to finish a sign-in.

The one exception is `POST /secret`, which hands a pasted key to the credential
vault when the `account.secrets` capability is `available`. A desktop host
should send the key from its native side (for example straight from the
clipboard or a native field), so the key never passes through the web view.

An account with `authMode: "api-key"`, `"oauth"`, or `"device"` keeps its
credential in the vault under the account id. For those accounts the engine
owns the status: `account.create` and `account.upsert` ignore a caller-sent
`status`, a new account starts `unconfigured`, and it becomes `ready` only when
a credential is stored. `statusCode` explains a non-ready account:
`CREDENTIAL_MISSING`, `SIGN_IN_EXPIRED`, or `SIGN_IN_REJECTED` (the vendor no
longer accepts the sign-in; the user must sign in again). `account.revoke`
deletes the stored credential.

Vault kinds for the CLI sidecar:

| `--credential-vault` | Storage | Use |
| --- | --- | --- |
| `keychain` (default) | OS credential store, service `dev.runrail.credentials` | signed builds |
| `file` | `<accounts-dir>/vault`, one file per account, mode 0600 in a 0700 directory | development builds, headless machines |
| `memory` | process memory | tests |
| `none` | no vault; `account.secrets` stays `configurable` | environment-variable-only setups |

The OS credential store ties an item to the signature of the program that
wrote it. A build without a stable signature (a locally compiled or ad-hoc
signed binary) can be refused or left waiting on a system prompt when it reads
an item another build wrote. Keychain calls are bounded, so that case fails
with `CONTROL_CREDENTIAL_STORE_FAILED` (HTTP 503) and the message
`VAULT_TIMEOUT` instead of hanging. `account.resolve` and `POST /secret`
report every vault failure that way. Use
`--credential-vault file` for such builds. The file vault refuses a file or
directory that other users can read (`VAULT_PERMISSIONS`). It is protected by
file permissions only, not encrypted.

Sign-in tokens are refreshed shortly before they expire. Only one engine on
the machine refreshes a given account at a time (a lock file under
`<accounts-dir>/locks`); the others wait and then read the new tokens.

Account references may also carry non-secret endpoint settings: `preset` (a
known provider id), `baseUrl` (absolute `https`, no user or password part;
plain `http` is accepted only for this machine and the local network, because
the key is sent to that address), and `headers` (up to 32 extra request
headers). Header names that carry
credentials or control the connection (`authorization`, `cookie`,
`x-api-key`, `host`, and any name containing `token`, `secret`, `key`, or
`auth`) are rejected. So are `user-agent` and `originator`: Runrail always
names itself and never sends another product's client identity.

### Connections

A connection is an account used as a model source: a preset, the account
record, and its credential. The `connections` capability covers these methods:

| Method | Params | Result |
| --- | --- | --- |
| `connection.presets` | none | `{ presets, custom }`: the known providers (`id`, `name`, `protocol`, `baseUrl`, optional `environment`, `models`) and the custom endpoint kinds (`id`, `name`, `protocol`, `authStyle`) |
| `connection.detect` | none | `{ detected }`: providers whose conventional key variable is set in the engine's environment and that have no environment-mode account yet. Names only, never values |
| `connection.models` | `connectionId` | `{ connectionId, presetId, models, images, live: { ok, code }, manualEntry }` |
| `connection.test` | `connectionId` | `{ connectionId, status, code, modelCount?, checkedAt }` |
| `connection.importable` | none | `{ candidates }`: providers set up in Codex, Pi, and opencode, with no keys (capability `connection.import`; see the capabilities document) |
| `provider.select` | `connectionId`, `model`, optional `thinking` | the session snapshot, as for the older form |

`connection.models` and `connection.test` make one bounded model-list request
(15 seconds, no tokens spent) and change nothing on the account. `models`
merges the live list with the metadata bundled in the package; each entry has
`id`, `source` (`live` or `snapshot`), and optional `name`, `contextTokens`,
`maxOutputTokens`, `reasoning`, `images`, and `pricing`
(`{ inputUsdPerMillionTokens?, outputUsdPerMillionTokens? }`, list prices). When the live request fails the
bundled list is still returned and `live.code` says why. `connection.test`
reports `status: "ok"` for `OK`, `"unverified"` for `RATE_LIMITED`,
`NO_MODEL_LIST`, and `INVALID_RESPONSE` (the key was not refused, but the
check could not prove it works), and `"failed"` otherwise. `images` lists the
image generators the same live list names, each `{ id, name?, route }` with
`route` `images` or `chat` (see [Image tools](#image-tools)); it is empty
without a live list, since nothing about image models is bundled.

| `code` | Meaning |
| --- | --- |
| `OK` | the endpoint listed its models |
| `AUTH_FAILED` | the endpoint refused the key (401 or 403) |
| `RATE_LIMITED` | 429 |
| `TIMEOUT` | no answer in time |
| `UNREACHABLE` | no connection could be made |
| `SERVER_ERROR` | 5xx |
| `REJECTED` | another 4xx |
| `ENDPOINT_DENIED` | the address is not allowed, or the endpoint answered with a redirect |
| `NO_MODEL_LIST` | the endpoint has no model list (404, 405, or a preset known to have none) |
| `INVALID_RESPONSE` | the answer was not a model list |
| `CREDENTIAL_MISSING` | no key or sign-in is stored, or the named variable is unset |
| `SIGN_IN_EXPIRED`, `SIGN_IN_FAILED` | the stored sign-in can no longer be used |

`provider.select` by `connectionId` takes the model and the reasoning level
and nothing else. The endpoint, protocol, auth header, extra headers, and
allowed host all come from the stored account and the preset table, so
`provider`, `endpoint`, `protocol`, `headers`, `accountId`,
`credentialEnvironment`, `allowRemote`, `allowInsecureRemote`, and any
credential field are refused with `CONTROL_INVALID_INPUT`.

Where a credential may go is fixed by these rules:

- A known preset sends its credential only to the preset's own host over
  `https`. An account may change the path on that host, never the host or the
  port.
- A custom connection sends its credential only to the host and port of the
  address it was created with.
- Once an account exists, `account.upsert` cannot change its preset, host,
  port, or auth mode (`CONTROL_ACCOUNT_ENDPOINT_LOCKED`, 409). Renaming it or
  changing the path is allowed. To point somewhere else, revoke the account
  and create a new one; the stored credential is deleted on revoke.
- A plan address (`signInOnly: true` in `connection.presets`) takes only
  what its sign-in stores. `account.create` or `account.upsert` with a key or
  a shell variable on one, and a key sent to `/secret` for one, are refused
  with `CONTROL_ACCOUNT_SIGN_IN_ONLY` (400); nothing is stored.
- An environment variable that a preset names (for example `OPENAI_API_KEY`)
  is only sent to that preset. Pointing it at a custom address or another
  preset is refused.
- A redirect from a provider endpoint is refused, not followed.
- The older forms of `provider.select`, `provider.discover`, and
  `model.discover`, where the caller names the endpoint, refuse an `accountId`
  whose credential is stored in the vault (`CONTROL_INVALID_INPUT`). Stored
  credentials travel only through `connectionId`.

A connection that breaks one of these rules fails with
`CONTROL_CONNECTION_ENDPOINT_DENIED` (400). An unknown preset or a custom
connection without an address fails with `CONTROL_CONNECTION_INVALID` (400).

The older caller-named form still sends an environment-mode credential to the
endpoint the caller names. A host that exposes `/rpc` to a web view should
route every provider choice through `connectionId` and not forward the older
params.

Remote provider discovery and execution require explicit endpoint and network
opt-in. The deterministic native backend and all release tests run without a
live provider network. A desktop client must keep live network access disabled
unless the user and deployment policy explicitly enable it.

### Connection settings

The person decides which connections exist; nothing is added because a key
variable is set or a coding tool is installed. Two kinds share one list:

- `provider`: a stored account (`account.create`), with its preset, auth
  mode, and status.
- `tool`: a coding tool Runrail drives through its own CLI (`claude-code`,
  `codex`, `copilot`, `opencode`, `gemini`, `goose`, `pi`), with `authMode`
  `subscription` (the tool's own sign-in) or `api-key`. Only `claude-code`,
  `codex`, and `gemini` take `api-key` (`CONNECTION_AUTH_UNSUPPORTED`
  otherwise); see [Coding-tool sign-in](#coding-tool-sign-in).

Each connection has `enabled` and an optional `models` list: the chosen
models, the first being the connection's default. Without `models` every
model the connection lists is offered. An account from before these settings
is on, with every model.

The `connection.settings` capability covers `connection.list`,
`connection.update`, and `connection.setDefault`; `connection.tools` covers
`connection.addTool` and `connection.removeTool`.

| Method | Params | Result |
| --- | --- | --- |
| `connection.list` | optional `enabledOnly` | `{ connections, default?, image? }`. `image` is `{ connectionId, model, route, usable }`, on the same terms as `default`. `enabledOnly: true` leaves out connections that are off or revoked; a picker should use it. `default` is `{ connectionId, model, usable }`, where `usable` is false while its connection is off, revoked, or gone |
| `connection.update` | `connectionId`, optional `label`, `enabled`, `models` | the connection. `models: null` goes back to every listed model. Renaming a provider renames its account |
| `connection.setDefault` | `connectionId` and `model`, or `connectionId: null` | `{ default }`, or `{ default: null }` once cleared |
| `connection.setImageModel` | `connectionId` and `model`, or `connectionId: null` | `{ image }`, or `{ image: null }` once cleared. The engine asks the connection's list again: a model it does not name as an image model is `CONNECTION_MODEL_NOT_CHOSEN` (400); a list it cannot read is `CONTROL_CONNECTION_CHECK_FAILED` (409). Only a provider connection that is on can hold it |
| `connection.addTool` | `tool`, optional `authMode` (default `subscription`), `label`, `models`, `connectionId` | the connection. Ids are `<tool>-<n>`; labels are the tool's name, then numbered |
| `connection.removeTool` | `connectionId` | `{ removed: true, connectionId }` |

- There is one default, kept by the engine. Adding a connection never sets
  it. When its model leaves the connection's list it moves to the list's
  first model; it is cleared when its connection is removed. A connection
  that is off or revoked cannot become the default. The image model follows
  the same rules, kept apart from the default.
- `provider.select` by `connectionId` refuses a connection that is off
  (`CONNECTION_DISABLED`, 409) and a model outside an explicit list
  (`CONNECTION_MODEL_NOT_CHOSEN`, 400).
- Removing a tool connection forgets it; the tool's own sign-in is left as it
  is. Removing an account also forgets its settings.
- Credential fields are refused on `connection.update` and
  `connection.addTool` (`CONTROL_INVALID_INPUT`). An account cannot take an
  id a tool connection has (`CONNECTION_EXISTS`).
- Settings are stored in `connections.json` beside `accounts.json` (mode
  0600, under a lock, re-read when another engine changes it), so an engine
  that predates them still reads its accounts. They hold no credentials.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `CONNECTION_NOT_FOUND` | 404 | no connection, or no tool connection, has this id |
| `CONNECTION_INVALID` | 400 | a malformed id, label, or model id, an unknown tool, a repeated model, or a connection for another tool |
| `CONNECTION_MODELS_EMPTY` | 400 | `models` is an empty list |
| `CONNECTION_MODEL_NOT_CHOSEN` | 400 | the model is not in the connection's list |
| `CONNECTION_AUTH_UNSUPPORTED` | 400 | `api-key` or a separate account for a tool that cannot take one |
| `CONNECTION_DISABLED` | 409 | the connection is off (or revoked, for a default) |
| `CONNECTION_EXISTS` | 409 | the id is taken |
| `CONNECTION_STORE_BUSY` | 409 | another process held the settings lock too long |
| `CONNECTION_LIMIT` | 413 | over 256 models, 256 tool connections, or 4096 provider settings |

### Coding-tool sign-in

A tool connection runs its tool in one of three ways:

| `authMode` | `separateAccount` | How the tool runs |
| --- | --- | --- |
| `subscription` | `false` | the tool's usual folder and its own sign-in, as from a terminal |
| `subscription` | `true` | a config folder of the connection's own, signed in with the tool's own login (Claude Code, Codex) |
| `api-key` | always `true` | a folder of its own, with a key Runrail keeps (Claude Code, Codex, Gemini CLI) |

The folder is `<accounts>/tool-homes/<id>`, mode 0700, so the user's own
settings, proxies, and sign-ins never apply to the connection and nothing in
the user's own folder changes. A key reaches the tool only one way, read from
the vault when the tool starts:

| Tool | Folder variable | Key |
| --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `ANTHROPIC_API_KEY`, the one credential variable it gets |
| Codex | `CODEX_HOME` | sent on stdin with app-server's `account/login/start { type: "apiKey" }`; with `cli_auth_credentials_store="ephemeral"` Codex keeps it in memory and writes no `auth.json` |
| Gemini CLI | `GEMINI_CLI_HOME` | sent on stdin with ACP `authenticate { methodId: "gemini-api-key" }` |

A refused key or sign-in ends the turn at the tool's first retry with
`COMMAND_AGENT_AUTH_FAILED` (Claude Code would retry for over a minute, Codex
for about twenty seconds), and the tool's own error text, which can repeat the
key, is not passed on.

A rejected allowance or quota ends the turn with
`COMMAND_AGENT_RATE_LIMITED` and a safe usage-limit message. Claude Code's
structured weekly window and reset timestamp are included when available.
Claude Code and Codex stop vendor retries; ACP request rejections also end the
turn. Native HTTP 429 and streamed quota errors are terminal provider failures,
with no automatic retry. Passive usage reports and allowances that permit
overage remain nonterminal. The vendor's diagnostic text is not passed on.

The `connection.signin` capability covers these methods, and the
`connectionId` forms of `/secret` and `backend.switch`:

| Method | Params | Result |
| --- | --- | --- |
| `connection.addTool` | as above, plus optional `separateAccount` | the connection, with `separateAccount` |
| `connection.status` | `connectionId` | `{ connectionId, tool, authMode, separateAccount, enabled }` plus, for a key connection, `keyStored`; otherwise `installed`, optional `version`, and `signedIn` when the tool answered |
| `connection.loginCommand` | `connectionId` | `{ connectionId, command, args, env }`: the tool's own login for a terminal the person sees (`claude auth login --claudeai`, `codex login --device-auth`), with `env` naming the connection's folder. Runrail does not run it |
| `connection.vendorSignOut` | `connectionId`, `confirm: true` | `{ connectionId, signedOut }`: runs the tool's own sign-out for the connection's folder, or for the user's usual login when the connection has none |
| `backend.switch` | `backend`, optional `connectionId` | the backend info. With `connectionId` the backend runs as that connection, which must be on and for that tool; `session.snapshot` then carries `connectionId`, and a connection with chosen models starts on the first |

- Status comes from the tool's own status command, run with the connection's
  folder; Runrail never reads the tool's credential files. The answer names
  no account.
- Codex signs in with a device code, which needs no local port: Runrail's own
  ChatGPT sign-in uses the port `codex login` would.
- `connection.loginCommand` and `connection.vendorSignOut` are for Claude Code
  and Codex subscriptions; other tools sign in from their own interface
  (`CONNECTION_AUTH_UNSUPPORTED`).
- Removing a tool connection signs nothing out and leaves its folder. A key
  connection's key, Runrail's own copy, is deleted with it.
- While a connection with chosen models is active, `model.switch` refuses a
  model outside them (`CONNECTION_MODEL_NOT_CHOSEN`).
- A fork on Claude Code's SDK route is refused for a connection with its own
  folder: the SDK copies transcripts from this process's folder.
- `backend.switch` without `connectionId` runs the tool as before, with its own
  sign-in; the CLI's `--backend` does too.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `CONNECTION_KEY_MISSING` | 409 | a key connection has no stored key yet |
| `CONNECTION_AUTH_UNSUPPORTED` | 400 | a sign-in or sign-out a connection does not have: a key connection, or a tool that signs in from its own interface |

#### Sign-in terminal

Reported as the `connection.login` capability (`unavailable` on Windows). The
tool's own login, the same one `connection.loginCommand` names, runs in a
pseudo-terminal the person sees and types into, for example to paste the code
Claude Code asks for. Runrail picks the program and its arguments from the
connection; the caller cannot name a command or a shell. It runs with the
filtered environment plus the connection's folder variable, in the user's home
folder. Output and typed input are held in memory only, at most 256 KiB of
output per sign-in, and are never logged or stored.

| Method | Params | Result |
| --- | --- | --- |
| `connection.loginStart` | `connectionId`, optional `cols` (20-400, default 80), `rows` (4-200, default 16) | `{ connectionId, loginId }`. Starting again for the same connection ends the one left open |
| `connection.loginRead` | `loginId`, optional `afterSeq`, `maxBytes` (at most 65536) | `{ chunks: { seq, data }[], nextSeq, closed }`; `closed` once the tool exited and every chunk was read |
| `connection.loginWrite` | `loginId`, `data` (at most 8 KiB) | `{ acceptedBytes }` |
| `connection.loginClose` | `loginId` | `{ loginId, closed: true }`; the tool is stopped if it still runs |

A sign-in ends by itself after 15 minutes, and at most four run at once.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `TOOL_LOGIN_NOT_FOUND` | 404 | no such sign-in, or it was closed or timed out |
| `TOOL_LOGIN_TOOL_MISSING` | 409 | the tool is not installed |
| `TOOL_LOGIN_LIMIT` | 429 | four sign-ins are already open |
| `TOOL_LOGIN_UNAVAILABLE` | 501 | this platform has no pseudo-terminals |

### Sign-in

Reported as the `auth.signin` capability: `available` when the process has a
credential vault and at least one sign-in, otherwise `configurable`. A sign-in
ends with tokens (or a lasting key) in the credential vault and a `ready`
account; the client then uses that account as a connection. No method,
snapshot, event, or error carries a token, an authorization code, or text a
vendor sent.

| Method | Params | Result |
| --- | --- | --- |
| `auth.flows` | - | the sign-ins on offer: `{ id, label, preset, kind: "browser" \| "device-code", authMode, unofficial, browserHosts }[]` |
| `auth.login.start` | `{ flow, accountId?, label? }` | a snapshot; returns once the first step is known or after 10 s |
| `auth.login.status` | `{ loginId, afterSeq?, waitMs? }` | a snapshot with the events after `afterSeq`; waits up to `waitMs` (at most 20000) for a new one |
| `auth.login.cancel` | `{ loginId }` | the snapshot, now `cancelled` |
| `auth.logout` | `{ accountId }` | the account record, now `unconfigured` / `SIGNED_OUT` |

A client names a sign-in by `flow` and nothing else. The addresses, client
registration, scopes, and callback port belong to the sign-in and cannot be
supplied or changed by a control call. `accountId` defaults to
`signin-<flow>`. An existing account is reused when it has the same auth mode
and destination (`AUTH_ACCOUNT_MISMATCH` otherwise); a revoked one is
replaced.

Snapshot:

```json
{
  "loginId": "login-<uuid>", "flow": "chatgpt", "preset": "openai",
  "accountId": "signin-chatgpt",
  "state": "starting | waiting | finishing | done | failed | cancelled",
  "code": "AUTH_DENIED", "acceptsInput": true,
  "events": [], "lastSeq": 2, "startedAt": 0, "expiresAt": 0
}
```

`code` is present only when `state` is `failed` or `cancelled`. Events carry
`seq` and `at`; a sign-in keeps at most 32.

| Event | Fields | Meaning |
| --- | --- | --- |
| `open-url` | `url`, `redirect`, `notice?` | open `url` in the user's browser. Its host is one of the flow's `browserHosts`; a host must check that before opening. `redirect: "loopback"` means the browser returns by itself; `"manual"` means the user pastes the address they land on into `POST /login-input`. `notice` says why: `AUTH_PORT_BUSY` or `AUTH_LISTENER_FAILED` |
| `device-code` | `userCode`, `verificationUrl`, `expiresAt` | show the code and open the page |
| `waiting` | - | waiting for the user |
| `finishing` | - | the user is done; Runrail is fetching the tokens |
| `done` | `accountId` | the account is ready |
| `failed` | `code` | the sign-in ended; a cancelled sign-in ends with `AUTH_CANCELLED` |

There is no live frame for sign-in. A client follows one by calling
`auth.login.status` with `afterSeq` set to the last `lastSeq` it saw and a
`waitMs`.

A browser sign-in listens on `127.0.0.1` only, answers only the exact
callback path under its own host name, checks `state` (or, for a vendor that
returns none, a random path used once), and shows a fixed page. The listener
closes when the sign-in ends, is cancelled, times out (ten minutes at most),
or the engine stops. A taken callback port is not a failure: the sign-in
continues with `redirect: "manual"`. At most four sign-ins run at once
(`AUTH_LIMIT`). Starting a flow again cancels the earlier sign-in of that
flow.

Sign-in codes: `AUTH_FLOW_UNKNOWN`, `AUTH_LOGIN_NOT_FOUND` (404);
`AUTH_INVALID`, `AUTH_INPUT_INVALID`, `AUTH_STATE_MISMATCH` (400);
`AUTH_STORE_FAILED` (503, the vault or account store could not be written and
nothing was kept); and with 409 or as an event code: `AUTH_LOGIN_FINISHED`,
`AUTH_LIMIT`, `AUTH_ACCOUNT_MISMATCH`, `AUTH_UNAVAILABLE`, `AUTH_CANCELLED`,
`AUTH_TIMEOUT`, `AUTH_DENIED`, `AUTH_EXPIRED`, `AUTH_CODE_REJECTED`,
`AUTH_SCOPE_MISSING`, `AUTH_RESPONSE_INVALID`, `AUTH_NETWORK`, `AUTH_FAILED`.
The message is always `sign-in failed`.

`auth.logout` deletes the stored credential of an `api-key`, `oauth`, or
`device` account and leaves the account in place for the next sign-in. It
refuses other auth modes (`CONTROL_INVALID_INPUT`) and revoked accounts
(`CONTROL_ACCOUNT_REVOKED`). Runrail does not call the vendor to revoke the
tokens; remove the grant in the vendor's own account settings to do that.

Built-in sign-ins:

| Flow | Result | Notes |
| --- | --- | --- |
| `chatgpt` | `openai` account, `authMode: "oauth"`, used with `api.openai.com` | Registers a client per sign-in under the name Runrail, callback `http://127.0.0.1:1455/auth/callback` (the Codex CLI uses the same port; when it is taken the sign-in goes manual). Requires the grant to include direct API use, else `AUTH_SCOPE_MISSING`. The id token must name the token address's origin as issuer, the issued client id as audience, the sign-in's nonce, and an expiry not past (five minutes' grace), else `AUTH_RESPONSE_INVALID`; it comes straight from the token address over TLS, so its signature is not checked. One real sign-in against OpenAI on 2026-10-13 passed every check: issuer `https://auth.openai.com`, audience the issued client id, and the nonce echoed |
| `openrouter` | `openrouter` account, `authMode: "api-key"` | The vendor hands back a lasting key; it is stored like a pasted key and never refreshed. Tested against a mock service only |

Every request a sign-in makes names Runrail in `User-Agent` and `originator`,
follows no redirect, and is bounded in time and size.

## Lifecycle

Send SIGINT or SIGTERM to request a clean control-process shutdown. The CLI
stops the HTTP listener, closes the Runrail session, and exits with the signal
status. Vendor command adapters use detached process groups and bounded
termination so cancellation does not intentionally leave their descendants
running.

The current CLI does not infer desktop-parent liveness and does not expose an
automatic parent-pid lease. The desktop must own the child process group and
terminate that group if its own process crashes. Treat orphan cleanup and
parent-process supervision as a release blocker for a desktop distribution
until verified on every supported platform.

## Runtime distribution status

The repository currently ships a Bun entry point (`package.json` maps the
`runrail` binary to `src/cli.ts`) and declares Bun `>=1.3.0`. A clean-machine
standalone executable is not verified by this repository, so the desktop must
not assume that a system with no Bun can launch Runrail.

Smallest actionable packaging plan:

1. Build signed, compiled sidecars with `bun build --compile` for macOS
   arm64/x64, Linux arm64/x64, and Windows x64.
2. Name artifacts `runrail-<version>-<os>-<arch>` and publish SHA-256
   checksums plus platform signatures. Report the embedded Runrail version
   from `control.ready`.
3. Let the desktop discover a configured sidecar path first, then a bundled
   versioned sidecar, and never silently fall back to an incompatible system
   Bun.
4. Upgrade by installing a new version beside the old one, verifying checksum
   and signature before an atomic switch. Keep the previous sidecar for
   rollback when readiness or health fails.
5. Add clean-machine launch, readiness, health, event, cancellation, and
   rollback checks to release certification before publishing artifacts.

No artifacts are published by this repository as part of the control
protocol work.

## Desktop integration checklist

The desktop integration thread should:

1. Spawn `control` with stable workspace, session directory, and session ID.
2. Parse only the first stdout JSON line as `control.ready`; keep token memory
   only and attach it as a bearer header.
3. Check `/health` and `control.describe` before optional feature use.
4. Use `task.*` plus durable cursors for reconciliation; use `/events` only for
   low-latency live UI updates.
5. On disconnect, stop consuming the old stream, reconnect, and run the
   durable reconciliation algorithm. On cursor expiry, reset that task cache.
6. Send SIGTERM for normal close and terminate the process group on desktop
   crash. Do not send secrets in RPC params or command arguments.
