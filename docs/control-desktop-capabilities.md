# Desktop control capabilities

The native control contract is intentionally one session and one project per
process. `/health`, `control.ready`, and `control.describe` expose both the
stable capability names and `capabilityStatus`.

Capability states are:

- `available`: the operation is configured and can be called now.
- `configurable`: the public server accepts a caller-owned implementation at
  startup, but this process was not given one.
- `unavailable`: the implementation is not present and cannot be enabled by
  this server instance.

Clients must check `capabilityStatus` before using optional operations. A
configured-but-empty caller registry is still `available`; its own registry
responses remain authoritative.

## Caller-owned integrations

Embedding code may pass these options to
`startRunrailControlRpcServer`:

- `connectorRegistry` enables `connector.list`, `connector.actions`, and
  `connector.invoke`.
- `agentCoordinator` enables `agent.list`, `agent.run`, and `agent.runMany`.
- `transcriptStore` enables the opt-in transcript controls.
- `terminalBridge` enables the bounded terminal controls described below.

- `nativeCredentialVault` (with `nativeAccountsDir`) enables `POST /secret`
  and engine-owned credentials, reported as the `account.secrets` capability.
  See the credentials section of
  [`control-protocol.md`](control-protocol.md#credentials-and-network-policy).
- `nativeSignInFlows` replaces the sign-ins on offer (`auth.flows`,
  `auth.login.*`, `auth.logout`, and `POST /login-input`), reported as the
  `auth.signin` capability. The default is the set vendors document for
  third-party tools. It needs `nativeCredentialVault`; without one the
  capability is `configurable` and the methods answer
  `CONTROL_CAPABILITY_UNAVAILABLE`. A host opens the `open-url` address only
  after checking its host against the flow's `browserHosts`, and sends what
  the user pastes to `POST /login-input`, never through `/rpc`. See
  [`control-protocol.md`](control-protocol.md#sign-in).
- `modelMetadata` replaces the bundled model facts used by
  `connection.models` and `provider.select`; `connectionEnvironment` replaces
  the environment `connection.detect` looks at (names only).

The `connections` capability is `available` on every native control server.
It covers `connection.presets`, `connection.detect`, `connection.models`,
`connection.test`, and `provider.select` by `connectionId`. A model picker
should be built on these: list accounts, ask each for its models, and select
with `{ connectionId, model, thinking }`. The client never supplies an
address, a protocol, or a key. Shapes, result codes, and the rules for where
a credential may go are in
[`control-protocol.md`](control-protocol.md#connections).

The `connection.settings` and `connection.tools` capabilities are `available`
on every native control server. They hold what the person added: provider
and coding-tool connections, each on or off with a chosen model list, and one
default model the engine keeps. A picker lists `connection.list
{ enabledOnly: true }` and offers each connection's `models` when it has
them. `harness.status` only suggests tools to add; it never adds one. See
[`control-protocol.md`](control-protocol.md#connection-settings).

The `connection.signin` capability is `available` on every native control
server. A host signs a separate account in by showing the sign-in terminal
(`connection.loginStart`, capability `connection.login`), or by running
`connection.loginCommand`'s command in a terminal of its own, then asks
`connection.status`; it sends a key connection's key to `POST /secret` with
`connectionId`; and it runs a picked route with
`backend.switch { backend, connectionId }`. Signing out is
`connection.vendorSignOut` with `confirm: true`, never part of removing a
connection. See
[`control-protocol.md`](control-protocol.md#coding-tool-sign-in).

Runrail never discovers credentials or executable commands from these
descriptors. Connector transports, agent executors, transcript retention, and
terminal process ownership remain with the caller.

The CLI sidecar supports opt-in file transcripts with
`--transcript-dir <path>`. It configures a credential vault by default
(`--credential-vault`, `--accounts-dir`), so `account.secrets` is `available`
unless it is started with `--credential-vault none`. Agent and terminal bridges
must be supplied by an embedding process. The CLI sidecar builds its own
connector registry from the built-in connectors the person turned on (see
Connectors) and reports agent capabilities as `configurable`, but its terminal capabilities are
explicitly `unavailable`: the CLI has no terminal command or PTY flags and
does not spawn a shell. `terminal.*` therefore returns
`CONTROL_TERMINAL_UNAVAILABLE` (HTTP 501) from the CLI launch path. Only an
embedding that supplies `terminalBridge` can advertise terminal capabilities
as `available`.

## Workspace controls

`workspace.list` accepts a workspace-relative `path`, `maxDepth` (0-16), and
`maxEntries` (1-2048). `workspace.read` accepts a workspace-relative `path`
and `maxBytes` (1-262144). Results contain relative paths only. The existing
workspace policy rejects path escapes, symlinks, credential files such as
`.env`, private keys, directories passed to `workspace.read`, binary text, and
over-limit reads.

Workspace failures use bounded codes such as
`CONTROL_WORKSPACE_FORBIDDEN`, `CONTROL_WORKSPACE_NOT_FOUND`,
`CONTROL_WORKSPACE_INVALID`, and `CONTROL_WORKSPACE_LIMIT`.

## Transcript controls

`session.transcript.status` is metadata-only. It reports that the caller-owned
store is configured, its session id, and the control bounds. The following
operations are available when the status is `available`:

- `session.transcript.read` returns payload-bearing records only because the
  caller explicitly supplied the store.
- `session.transcript.export` returns a bounded versioned bundle.
- `session.transcript.import`, `session.transcript.branch`, and
  `session.transcript.compact` perform the corresponding bounded store action.

Reads and exports are limited to 16384 records and 8 MiB at the control
boundary. `maxBytes` can request a smaller limit. Transcript payloads are not
copied into `session.export` evidence, task journals, SSE recovery events, or
error messages. A missing store returns `CONTROL_TRANSCRIPT_UNAVAILABLE`
(HTTP 501), not an empty success response.

## Terminal controls

An injected `terminalBridge` may advertise `create`, `write`, `read`, `resize`,
and `close`. The RPC names are `terminal.describe`, `terminal.create`,
`terminal.write`, `terminal.read`, `terminal.resize`, and `terminal.close`.
Terminal input is limited to 64 KiB per write; output is limited to 1 MiB per
read and uses a bounded sequence cursor. The server validates workspace-relative
terminal working directories and returns no absolute path in terminal results.

The control server does not spawn a shell, inherit credentials, persist PTY
bytes, or write terminal output to evidence. The caller-owned bridge must own
those responsibilities and must enforce its own process isolation. Missing or
unsupported terminal capabilities fail closed with
`CONTROL_TERMINAL_UNAVAILABLE` or
`CONTROL_TERMINAL_CAPABILITY_UNAVAILABLE` (HTTP 501).

### Built-in PTY bridge

`runrail control --terminal` (or `createPtyTerminalBridge()` in an embedding
process) supplies the `runrail.pty` bridge with all five capabilities. Each
session is a real login shell (`$SHELL -l`, falling back to `/bin/sh`) started
in the validated workspace directory through `Bun.spawn({ terminal })`. It is
a convenience for the local user, not a sandbox: the shell runs with the
user's own permissions and reads the user's shell profile.
`--terminal-shell <path>` (with `--terminal`) picks another shell; it must be
one of the login shells listed in `/etc/shells`.

- The shell environment is the filtered base set plus `SHELL`, `USER`,
  `LOGNAME`, `TMPDIR`, `SSH_AUTH_SOCK`, `LC_CTYPE`, `EDITOR`, and `VISUAL`.
  Provider keys and other tokens in the sidecar environment are not
  forwarded. `TERM=xterm-256color`, `COLORTERM=truecolor`, and
  `RUNRAIL_TERMINAL=1` are set, and `LANG` defaults to a UTF-8 locale when no
  locale variable is present.
- Output is decoded as a UTF-8 stream and stored as chunks of at most 4 KiB
  (`PTY_TERMINAL_CHUNK_BYTES`) that never split a code point. Read with a
  `maxBytes` of at least 4096; a smaller limit can return no chunks.
- Each session keeps up to 2 MiB of output in memory for replay from
  `afterSeq: -1`; the oldest chunks are dropped first. Nothing is written to
  disk, transcripts, or evidence.
- At most 8 sessions run at once. `terminal.create` with the id of a running
  session reattaches (resizing if needed) instead of starting another shell.
- `terminal.close` sends `SIGHUP`, then `SIGKILL` after 2 seconds. The
  sidecar closes every shell on shutdown. Windows is not supported.

## Git review controls

`git.read` covers `git.status`, `git.diff`, and `git.log`; `git.write` covers
`git.stage`, `git.unstage`, `git.discard`, and `git.commit`. Both are
`available` when the workspace is inside a git work tree and `git` is on
`PATH`, and `unavailable` otherwise (calls then fail with
`CONTROL_GIT_UNAVAILABLE`, HTTP 501). Paths are workspace-relative; a workspace
below the repository root only sees and changes paths under itself.

Git runs with an explicit argv and no shell, a filtered environment,
`--literal-pathspecs`, no pager, no fsmonitor, no external diff or textconv
drivers, and repository hooks disabled unless `git.commit` is called with
`runHooks: true`. Signing agent variables are forwarded to `git commit` only.
Every call has a timeout and an output cap. Error messages are fixed strings
and never include git's stderr. Clean and smudge filters configured by the
user still run, because git applies them to work-tree files.

- Paths are rejected when absolute, option-like (`-x`), outside the workspace,
  or inside `.git` (`CONTROL_GIT_INVALID` 400 or `CONTROL_GIT_FORBIDDEN` 403).
- Credential files (`.env`, `.env.*`, `*.pem`, `*.key`) are listed with
  `sensitive: true` and never diffed. A new credential file is staged only
  when it is named exactly, never through a directory or `.`.
- Runrail runtime state (`.runrail/native`, `.runrail/worktrees`) is hidden
  from status and diff and skipped by bulk stage, unstage, and commit unless a
  path points inside it.
- `git.discard` never deletes untracked files unless `includeUntracked: true`
  and never touches conflicted paths. `scope: "all"` also resets the index to
  `HEAD`.
- `git.commit` fails with `CONTROL_GIT_IDENTITY_REQUIRED`,
  `CONTROL_GIT_NOTHING_TO_COMMIT`, or `CONTROL_GIT_CONFLICT` (HTTP 409). With
  `paths`, only the changes under those paths are committed.
- Diffs are bounded by `maxFiles`, `maxBytes`, and `maxFileBytes`. A file whose
  patch is not returned has `omitted` set to `sensitive`, `binary`, `limit`,
  `unreadable`, or `submodule`; a cut result has `truncated: true`.
- `git.diff { statsOnly: true }` (capability `git.diff.stats`) returns the same
  `files` and `totals` without building any patch. Untracked files are still
  counted by reading them within `maxBytes` and `maxFileBytes`; credential
  files, binaries, and Runrail's state are skipped as above, and a hit cap sets
  `truncated: true`.

## Remote git and pull requests

`git.remote` covers `git.remote.list`, `git.push.preview`, and `git.push`;
`git.pull` covers `git.pull`. Both are `available` whenever git review is.
`git.pr` covers `git.pr.create` and `git.pr.status`, and is `available`
whenever git review is: whether GitHub is connected is answered per call (see
[Code hosts](#code-hosts)). Before P6 it was `configurable` without a
registered `github` connector.

- `git.remote.list` returns `{ remotes: [{ name, url, host?, owner?, repo?,
  path?, service?, serviceFrom? }] }`. User info, ports, query strings, and
  fragments are stripped from URLs; local paths are reported as `local`.
  Credentials are never returned. `path` is the repository path
  (`group/sub/repo` on GitLab); `owner` and `repo` are set only for a
  two-part path. `service` is `github`, `gitlab`, `bitbucket`, or `unknown`,
  from disk only, never the network; `serviceFrom` says how it is known:
  `user` (the person's answer for the host, from `codehost.set`), `host`
  (github.com, gitlab.com, bitbucket.org), `path` (`/scm/PROJECT/repo` or SSH
  port 7999 is Bitbucket Data Center; three or more path parts is GitLab),
  `name` (the host name contains github, gitlab, or bitbucket), or `ci` (the
  only CI file kind present: `.github/workflows`, `.gitlab-ci.yml`,
  `bitbucket-pipelines.yml`). `user` and `host` are certain; the rest are
  guesses.
- `git.pull { runHooks? }` brings the checked-out branch up to its upstream,
  fast-forward only. It fetches only the upstream's ref (a `.` upstream skips
  the fetch), then counts: nothing behind is `up-to-date`; ahead and behind
  fails with `CONTROL_GIT_DIVERGED` (409) and nothing is merged or rebased.
  No branch, no upstream, an upstream that is not a remote-tracking branch,
  local changes in the way, or an unfinished merge or rebase fail with
  `CONTROL_GIT_CONFLICT` (409) and a fixed message. Hooks run only with
  `runHooks: true`. The result is `{ remote, branch, upstream, from, to,
  pulled, outcome: fast-forwarded | up-to-date, status }`; network variables
  as push.
- `git.push.preview { remote?, branch? }` resolves the remote (param, the
  branch upstream, `origin`, or the only remote) and target branch (param,
  upstream branch, or the current branch) and lists up to 50 commits that
  would leave the machine, compared with the local tracking ref. It never
  fetches. The result carries `head`, `remoteHead?`, `newBranch`,
  `setUpstream`, `ahead`, `commits`, and an opaque `confirmation`.
- `git.push { remote?, branch?, confirmation, runHooks? }` recomputes the
  preview and fails with `CONTROL_GIT_CONFLICT` (409) when the confirmation no
  longer matches, so the user always confirms the exact commits pushed. It
  pushes `refs/heads/<current>:refs/heads/<branch>` with `--porcelain`, never
  forces, and maps a non-fast-forward rejection to `CONTROL_GIT_CONFLICT`.
  The result is `{ remote, branch, commit, outcome: pushed | created |
  up-to-date, upstreamSet, status }`. Pushes forward the SSH agent and proxy
  variables only; credentials stay in the user's git credential helpers, and
  `GIT_TERMINAL_PROMPT=0` makes a missing credential fail instead of hanging.
- Pull request calls (`git.pr.create`, `git.pr.status`, `git.pr.list`) go to
  a registered `github` connector first (the embedder's choice), else to the
  person's own `gh` when they connected the remote's host with
  `codehost.connect`, else fail with `CONTROL_PR_NOT_CONNECTED` (501, "GitHub
  is not connected for github.com"). `gh` is never used just because it is
  installed. A remote whose service is certainly GitLab or Bitbucket fails
  with `CONTROL_PR_UNAVAILABLE` (501) naming the service; a guessed service is
  never refused.
- The repository is the `remote` param, else the branch's upstream remote,
  else `origin`, else the only remote. When that remote is a fork (a remote
  named `upstream` on the same host has another owner), pull requests live on
  `upstream` and the head is `<fork owner>:<branch>`.
- `git.pr.create { base, title, body?, draft?, head?, remote?, owner?, repo?,
  confirm: true }` requires `confirm: true` (else `CONTROL_CONFIRMATION_REQUIRED`,
  HTTP 428) and a head branch that already has a tracking ref on the remote it
  is pushed to (else `CONTROL_GIT_CONFLICT`). Owner and repo come from the
  remote URL unless passed. Through `gh` it runs `gh pr create --repo R --head
  <owner>:<branch> --base B --title T --body-file - [--draft]` with the body
  on stdin, never in argv, then reads the new pull request back. It returns a
  pull request entry (below) with `owner, repo, remote, pushedCommit`.
- `git.pr.status { head?, remote?, owner?, repo?, state? }` (`state` `open`,
  `closed`, or `all`, default `all`; it was `open` before P6) lists up to 10
  pull requests whose head is the branch, newest first, as `{ owner, repo,
  remote, head, source: connector | gh, pullRequests }`. Through `gh` it runs
  `gh pr list --repo R --head <branch> --state S --limit 10 --json ...` and
  drops entries whose head belongs to another owner.
- A pull request entry is `{ number, url?, state: open | closed | merged,
  draft, merged, title?, head?, base?, author?, updatedAt?, mergedAt?,
  closedAt? }`; times are milliseconds. Through `gh`, `git.pr.status` also
  gives `review` (`approved`, `changes-requested`, `required`, `none`),
  `mergeable` (`yes`, `conflicts`, `unknown`), and `checks: { passed, failed,
  pending, skipped, items: [{ name, state, url? }] }`, items at most 20,
  failing first, names at most 120 characters, `https` links only. Both check
  shapes GitHub mixes are read: success is passed; skipped and neutral are
  skipped; failure, error, timed out, cancelled, action required, and startup
  failure are failed; anything else, or not completed, is pending.
- GitHub failures map to `CONTROL_PR_CREDENTIALS` (501), `CONTROL_PR_AUTH_FAILED`
  (502), `CONTROL_PR_RATE_LIMITED` (429), `CONTROL_PR_TIMEOUT` (504), or
  `CONTROL_PR_FAILED` (502). `gh` runs with a 30 second timeout, stdout capped
  at 1 MiB, the filtered environment plus proxy and config-folder variables,
  and no token variables, so it uses its own stored sign-in and Runrail never
  sees a token. GitHub's and gh's text is never returned.

## Code hosts

`codehosts` covers `codehost.list`, `codehost.set`, `codehost.connect`,
`codehost.disconnect`, and `codehost.status`, and is always `available`. The
answers live in `codehosts.json` in the accounts folder (`nativeAccountsDir`,
else the session's own state), so every engine sharing that folder sees them.
The file holds no secret: `{ version: 1, hosts: [{ host, service?,
connection?: { via: "gh", enabled, addedAt } }] }`, at most 64 hosts, written
to a temporary file (mode 0600) and renamed. `host` is a lowercase host name
with an optional port; anything else fails with `CONTROL_INVALID_INPUT` (400).

- `codehost.list` returns `{ hosts, problem? }`; an unreadable or malformed
  file reads as empty with `problem: "CODEHOST_STORE_INVALID"`, and the next
  write replaces it.
- `codehost.set { host, service }` records the person's answer
  (`github`, `gitlab`, `bitbucket`, or `unknown`) and returns the host's
  record; it wins over every guess in `git.remote.list`. A 65th host fails
  with `CONTROL_CODEHOST_LIMIT` (409).
- `codehost.connect { host, via: "gh" }` records that the person's own `gh`
  sign-in may be used for that host's pull requests. It runs no `gh` command.
  A host that is certainly GitLab or Bitbucket fails with
  `CONTROL_PR_UNAVAILABLE`, as does a missing `gh` ("install the GitHub CLI
  (gh) first").
- `codehost.disconnect { host }` removes the connection. It never signs `gh`
  out.
- `codehost.status { host }` answers `{ state: "ready", login }`, `{ state:
  "signed-out" }`, or `{ state: "missing" }` (no `gh`), from `gh api
  --hostname <host> user`, stdout capped at 64 KiB, the `login` field only. It
  works with or without a record, so a client can offer "Use GitHub CLI
  (signed in as octocat)" before connecting. Other gh failures map to the
  GitHub codes above.
- `codehost.remotes { path }`, capability `codehost.remotes` (always
  `available`), lists the remotes of any project folder, so a client can say
  what a project is connected to before a thread runs there. `path` is an
  absolute path to an existing folder, at most 4096 characters, without NUL;
  anything else fails with `CONTROL_INVALID_INPUT` (400). A folder outside a
  git work tree answers `{ git: false }`; else `{ git: true, remotes, branch?,
  detached, initial, head? }`: the same entries as `git.remote.list` (user info
  removed from URLs, the person's answers applied), at most 64, and the checked
  out branch (absent when HEAD is detached), whether no commit exists yet, and
  HEAD's commit. It reads the repository's config and HEAD only, not the work
  tree, with hooks and fsmonitor off, and never touches the network.

## Worktree sources

These pick where a new thread worktree starts. `git.branches`, `git.fetch`,
and `git.pr.list` are `available` whenever git review is. Embedders can pass
`githubCli` (a path, or `false`) to `startRunrailControlRpcServer`; it names
the program used for a connected host and no longer turns `gh` on by itself.

- `git.branches { maxBranches? }` (1 to 500, default 200) reads refs on disk,
  never the network, and returns `{ current?, local: [{ name, commit,
  updatedAt, upstream? }], remote: [{ remote, name, commit, updatedAt }],
  truncated }`. Each list is newest first by its tip's committer time and
  holds up to `maxBranches`; a remote's `HEAD` is left out.
- `git.fetch { remote?, branch? | pullRequest? }` takes exactly one of a
  branch name or a pull request number (1 to 1,000,000,000). The remote is the
  param, else `origin`, else the only remote. Only that ref is fetched, with
  no tags, no submodules, and no `FETCH_HEAD`: a branch updates
  `refs/remotes/<remote>/<branch>`, and a pull request's head lands at
  `refs/runrail/pull/<remote>/<n>`, so no branch is moved. The head ref
  follows the remote's service: GitHub's `refs/pull/<n>/head`, GitLab's
  `refs/merge-requests/<n>/head`, both in turn for an unknown host; Bitbucket
  has no such ref and is refused with `CONTROL_GIT_INVALID` (start from the
  pull request's source branch). It returns `{ remote, revision, commit, branch? |
  pullRequest? }`; pass `revision` to `worktree.create`. Like push, it
  forwards only SSH agent and proxy variables, never prompts, and maps a
  missing ref to `CONTROL_GIT_NOT_FOUND`, a refused sign-in to
  `CONTROL_GIT_FORBIDDEN`, and anything else to `CONTROL_GIT_FAILED`; git's
  own text is never returned.
- `git.pr.list { remote?, owner?, repo?, limit? }` (limit 1 to 100, default
  30) lists open pull requests as `{ owner, repo, remote, source: connector |
  gh, pullRequests: [{ number, url?, state, draft, merged, title?, head?,
  base?, author?, updatedAt? }] }`, routed as the other pull request calls:
  the connector, else a connected `gh` (`gh pr list`; a GitHub Enterprise
  remote passes its host), else `CONTROL_PR_NOT_CONNECTED` (501). A gh that is
  not signed in gives `CONTROL_PR_CREDENTIALS` (501), and other gh failures
  the GitHub codes above.

## Reviews inbox

`git.pr.reviews` covers `git.pr.search`, `git.pr.teams`, `git.pr.view`, and
`git.pr.diff`: the person's pull requests in every repository, read through
their own `gh`. No project is needed, so the app-wide engine answers them. It
is `available` when `gh` was found and `unavailable` otherwise. Each call takes
an optional `host` (default `github.com`), which must be connected through
`codehost.connect`, else `CONTROL_PR_NOT_CONNECTED` (501). Inputs are checked
before `gh` runs. All four are read only.

- `git.pr.search { group, team?, query?, limit?, host? }`: `group` is
  `review-requested` (asked of the person directly,
  `user-review-requested:@me`), `authored` (`author:@me`), or `team` (asked of
  a team they are on, `review-requested:@me -user-review-requested:@me`; with
  `team: "org/slug"`, `team-review-requested:org/slug`). Open, unarchived,
  newest update first. `query` (one line, up to 200 characters) narrows it with
  the person's words; `limit` is 1 to 50, default 20. One GraphQL search, 1
  rate-limit point. Returns `{ host, group, total, pullRequests: [{ owner,
  repo, number, url?, title?, author?, updatedAt?, draft, review: approved |
  changes-requested | required | none, checks: passed | failed | pending | none
  }] }`.
- `git.pr.teams { host? }` lists `{ host, teams: [{ org, slug, name? }] }`, up
  to 100. A sign-in without the `read:org` scope gives
  `CONTROL_PR_SCOPE_MISSING` (403); the fix is `gh auth refresh -s read:org`.
- `git.pr.view { owner, repo, number, host? }` returns the body (up to 20,000
  characters, with `bodyTruncated`), state, draft, author, times, base, head,
  `headCommit`, `headRepository` for a fork, `mergeable`, `mergeState`,
  `review`, counts, up to 100 `files` (`filesTruncated`), the latest
  `reviews`, the open review `requested` of users and teams, `checks` (counts
  and up to 20 items, failing first) with `checksState`, the `mergeMethods`
  the repository allows, and the person's `permission` there.
- `git.pr.diff { owner, repo, number, path?, host? }` returns `{ diff,
  truncated }`, cut at 2 MiB rather than failing. With `path` it returns that
  file's part and `found`.
- A missing repository or pull request, or one this sign-in cannot see, gives
  `CONTROL_PR_NOT_FOUND` (404); other failures use the GitHub codes above.

Two writes sit behind capabilities of their own, `git.pr.review.post` and
`git.pr.merge` (each `available` with `gh`). Both need `confirm: true` (else
`CONTROL_CONFIRMATION_REQUIRED`, 428); the desktop asks the person each time
and shows exactly what goes to GitHub.

- `git.pr.review.post { owner, repo, number, commit, body, comments?, confirm,
  host? }` posts one review of the comment kind (it neither approves nor
  blocks) at `commit`, the 40-character head the person reviewed. `comments`
  (up to 50) are `{ path, line, side?: RIGHT | LEFT, body }`; a line outside
  the diff is refused by GitHub and answered `CONTROL_PR_FAILED`. The payload
  goes to `gh` on stdin. Returns `{ host, id, url?, comments }`.
- `git.pr.merge { owner, repo, number, method: merge | squash | rebase,
  headCommit, subject?, body?, deleteBranch?, confirm, host? }` reads the pull
  request first and refuses with `CONTROL_PR_MERGE_REFUSED` (409) when it is
  not open, is a draft, or the repository does not allow `method`, and with
  `CONTROL_PR_HEAD_MOVED` (409) when its head is not `headCommit`. It then runs
  `gh pr merge --match-head-commit`, so a push in between also stops it. The
  commit body goes on stdin. Returns `{ host, merged: true, method, url? }`.

## Checks

`checks` covers `check.run` and `check.stop`, on a project's engine. It is
`available` when the project is a git repository.

- `check.run { id, worktree, command, timeoutMs? }` runs `command` with
  `/bin/sh -c` (`cmd /c` on Windows) in the thread worktree `worktree` of this
  project, else `CONTROL_CHECK_NOT_A_WORKTREE` (404). The person typed the
  command, so it runs without an approval. The environment is the agent's
  command environment (`PATH`, `HOME`, locale, `TMPDIR`, `NO_COLOR=1`; no
  credentials). `id` is the caller's (same pattern as a worktree id); a second
  run with an `id` still running is `CONTROL_CHECK_RUNNING` (409), and at most
  8 run at once (`CONTROL_CHECK_LIMIT`, 429). `timeoutMs` is 1,000 to
  3,600,000, default 600,000; on timeout the process group is killed. The call
  answers when the command ends: `{ id, exitCode?, passed, timedOut, stopped,
  durationMs, tail, truncated, counts? }`. `tail` is the last 200 lines of
  stdout and stderr as they arrived, without color codes. `counts` is `{
  runner: bun | vitest | jest | pytest | cargo, passed, failed, skipped, total
  }` when that runner's summary is in the output.
- `check.stop { id }` kills a running check's process group; its `check.run`
  answers with `stopped: true`. Returns `{ stopped }`, false when nothing with
  that id runs.

## Setups

`setups` covers `setup.list`, `setup.save`, `setup.delete`, `setup.trust`, and
`setup.run.*`,
on a project's engine. A setup names a `planner`, an `executor`, and a
`reviewer` (each `{ route, model?, connectionId?, effort?, access? }`) and its
`rules`: `approvePlan`, `reviewRounds` (0 to 5; above 0 needs a reviewer),
`check` (a command for `check.run`), and `budget { maxTurns, maxMinutes }`
(defaults 40 and 120).

- The person's setups are in `~/.runrail/setups.json` (embedders pass
  `setupsPath`); the person's entries win by id over a project's in
  `<project>/.runrail/setups.json`. Project entries are read only here
  (`CONTROL_SETUP_READ_ONLY`, 409). Writers share a file lock across engines.
  `setup.list` returns `{
  setups: [... source: user | project], skipped }`; an entry that does not
  parse is counted in `skipped`, never guessed at.
- A project's setup that runs a `check` or gives a role `access: "full"` also
  carries `trust: { digest, trusted }`. It does not run, from a run, a
  workflow, or an eval, until the person trusts that version
  (`CONTROL_SETUP_UNTRUSTED`, 409). `setup.trust { id, digest }` trusts it,
  where `digest` is the one the person was shown; a changed setup answers
  `CONTROL_SETUP_INVALID`. Trust is kept per project in `setup-trust.json`
  beside the person's setups, and any change to the setup in the repository
  takes it away.
- `setup.run.start { setupId | setup, task, checkout? }` starts a run and
  returns its status. With `checkout: true` its turns and checks work in the
  project's own folder instead of a new worktree, and the status says
  `checkout: true`. The engine decides each next step: the planner's turn (read only,
  ending with a D9 plan block, asked once more if it is missing), the person's
  approval when `approvePlan`, one executor turn per plan step with the check
  after each and one fix turn when it fails, then review rounds (read only,
  ending with a findings block); high and medium findings go back to the
  executor.
- A turn waits in `setup.run.status { runId }` as `waiting: { kind: "turn",
  stepId, role, thread, runsOn, mode: plan | agent, access, title, prompt }`.
  The desktop runs it as a thread (`thread` is the same for every turn of a
  role) and answers `setup.run.answer { runId, stepId, ok, text?, worktree?,
  error? }`; the first answer names the worktree the run checks. An approval
  waits as `waiting: { kind: "approve", stepId, plan }` and is answered with `{
  approved, plan?, feedback? }`; feedback sends the plan back to the planner, up
  to three times.
- `setup.run.list` and `setup.run.stop { runId }`. A run's status has `state`
  (`running`, `waiting`, `succeeded`, `failed`, `stopped`), `turns`, `plan`,
  `steps` (kind, title, status, role, and a short note such as a check's
  counts; never an answer's text), and `error { code, message }`: for example
  `SETUP_BUDGET`, `SETUP_PLAN_FORMAT`, `SETUP_PLAN_DECLINED`,
  `SETUP_TURN_FAILED`. Runs live in the engine's memory and end with it.
- A run an eval started carries `worktree { id, path, cwd, branch? }` on each
  waiting turn: every role's thread runs in that worktree.

## Evals

`evals` covers `eval.*` on a project's engine: cases mined from the project's
history, suites of them, and runs that score setups against a suite.

- `eval.mine { limit?, scan?, since? }` returns `{ candidates: [{ id, base,
  fix, tests, sources }] }`: commits, newest first, with one parent that change
  source and add or change tests. Only ids and paths; messages and diffs stay
  in git.
- `eval.validate { case, check }` checks one candidate in a throwaway worktree
  and returns `{ id, verdict }`: `valid` when the case's tests fail at `base`
  and pass at `fix`, else `passes-before`, `fails-after`, or `error`. In
  `check`, `{tests}` stands for the case's test paths, shell-quoted.
- Suites are `<project>/.runrail/evals/<name>.yaml` (`{ version: 1, check,
  cases: [{ id, base, fix, tests }] }`, up to 200 cases). `eval.suites` returns
  `{ suites: [{ name, cases, check }], skipped }`; `eval.suite.get { name }`
  and `eval.suite.save { suite: { name, check, cases } }`.
- `eval.run { suite, setupIds, cases?, repeats?, parallel?, maxMinutes? }`
  runs every case with every setup (1 to 4) `repeats` times (1 to 5), up to
  `parallel` at once (1 to 4), and stops at `maxMinutes` (default 120). One
  eval runs at a time in a project (`CONTROL_EVAL_LIMIT`, 429). Each case gets
  a worktree at `base` with its tests removed; the task is the fix commit's
  message. The setup run waits on the desktop as usual; when it ends, the tests
  come back from `fix` and the suite's check scores it.
- `eval.status { runId }`, `eval.list`, and `eval.stop { runId }`. A status
  has `state` (`running`, `succeeded`, `stopped`, `failed`), the setups and
  cases, and `jobs: [{ caseId, setupId, repeat, state, setupRunId?,
  setupState?, worktree?, turns?, durationMs?, check?: { exitCode?, timedOut,
  counts? }, error? }]`, a job's `state` one of `queued`, `running`,
  `checking`, `passed`, `failed`, `skipped`, `error`; `error` is a code.
  Results are in `~/.runrail/evals/<project>/<runId>/` (`run.json` and
  `results.jsonl`; embedders pass `evalsDir`) and keep ids, states, counts, and
  durations only: never a task, a prompt, an answer, or a log.

## Memory

`memory` covers `memory.*` on any engine. Memories are kept for the project
(`scope: "project"`, this engine's project) or for the person (`"person"`, every
project), in one SQLite file shared by every engine, `~/.runrail/memory/`
(embedders pass `memoryDir`). An engine never lists another project's memories.

- `memory.status` returns `{ provider: { kind: local | mcp, name? }, health: {
  ok, detail? }, counts: { project, person }, semantic? }`. `semantic` is
  present once an embedding model is picked: `{ connectionId, model, floor?,
  indexed, pending, indexing, problem? }`, where `problem` is the last reason a call to
  the model failed, in Runrail's words.
- `memory.recall { query, scopes?, limit? }` returns `{ hits: [{ id, scope,
  text, source, score, from: local | mcp, match? }], fellBack? }`: memories
  sharing at least a third of the query's words (three letters or more, common
  words left out, stems matched), counted out of at most four of them so a long
  message needs two in common, best first, at most `limit` (default 3, up to
  10). `fellBack` names why the external server did not answer and local memory
  did.
- Recall by meaning is off until `memory.settings.set { embeddings: {
  connectionId, model } }` picks an embedding model on one of the person's
  connections (`connection.models` lists them as `embeddings`). The engine
  checks it with one call first and refuses a model that does not embed
  (`CONTROL_MEMORY_UNAVAILABLE`, 503). That call embeds twelve unrelated
  sentences, and the model's similarity floor is their mean similarity plus
  2.75 standard deviations, between 0.2 and 0.9; it is saved with the
  settings as `floor` and returned with them. Local memories are then embedded in the
  background, 64 at a time, through the connection's OpenAI-style
  `embeddings` endpoint with its own key; the vectors stay in the memory
  file, never the key. Recall embeds the query (waiting at most 2.5 s) and
  joins the closest memories (cosine similarity at or above the model's floor,
  0.5 for settings saved without one) with the keyword hits by reciprocal
  rank fusion; `match` says which found it: `keyword`,
  `meaning`, or `both`. A model that fails, or a connection turned off, leaves
  recall to keywords and sets `semantic.problem`. `{ embeddings: null }` turns
  it off and drops the vectors; a new model drops the old model's.
- `turn.enqueue { message, recall: true }` appends what the message recalls
  (up to 3, waiting at most 4 s for an external server) as a block after the
  message, so every route reads it and the timeline can show it:
  `[Runrail recalled memories: …]`, one `[m1] <where from>: <text>` line per
  memory, a `[note] …` line when local memory answered instead, and `[End
  recalled memories]`. A failing recall never stops the message. Memories
  from a GitHub or feed source are left out of this block, since anyone can
  write that text; `memory.recall` still returns them.
- A thread's worktree belongs to the project it came from: the project is the
  main checkout, at the same place inside it, so its threads recall the same
  memories.
- `memory.add { scope, text, source?: manual | suggested }`, `memory.update {
  id, text }`, `memory.forget { id }`, and `memory.list { scope?, query?,
  sourceId?, limit?, before? }` (newest first).
- `memory.settings.get` and `memory.settings.set { provider?, embeddings? }`
  (either or both). `provider`: `local`,
  `server-memory` (the official `@modelcontextprotocol/server-memory` through
  `npx`), or `{ name, command, args?, inherit?, mapping }` or `{ name, url,
  mapping }`. A mapping names the server's tools for `recall`, `add`, `forget`
  and `list` as `{ tool, args }`; `{query}`, `{text}`, `{id}`, `{scope}` and
  `{limit}` in `args` are filled in. Only variables named in `inherit` reach a
  local server; a URL is https, or http on this machine. When the server's
  recall finds nothing, its list is scored instead (servers that search for the
  whole query as one phrase). Sources and older memories stay local and are
  recalled with the server's.
- Sources index into local memory: `memory.source.add { kind: folder | github |
  feed, scope, target, name? }` (an absolute folder, `owner/repo`, or a feed
  URL), `memory.source.sync { id }`, `memory.source.list` (each with `entries`
  and `lastSync { at, ok, error?, added, removed, kept }`), and
  `memory.source.remove { id }`, which forgets its entries. A folder sync reads
  note files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, `.org`, up to 512 KiB, 2000
  files), never dot entries, `node_modules` or build folders, or credential
  files, and keeps, replaces, or forgets by file hash. Issues come through `gh`,
  then only those updated since the last sync; feeds are asked with
  `If-None-Match` and `If-Modified-Since`.

## Workflows

`workflows` covers `workflow.*` on any engine. Every project's workflows live in
one file, `~/.runrail/workflows.json` (embedders pass `workflowsPath`), keyed by
the project (a worktree's engine finds its checkout's). A workflow is a trigger
and a list of steps; the engine runs it and each agent or setup step is a
setup run whose turns the desktop runs as threads.

- Triggers: `manual`; `schedule` with `{ kind: interval, minutes }`, `daily`,
  `weekdays` or `weekly` (`day` 0 to 6) at `hour` and `minute`, in this
  machine's time; `pr-review-requested` (the person's own review, through `gh`);
  `pr-opened`; `webhook` (a call to the workflow's own link,
  which the desktop serves on the person's tailnet; it counts as armed but is
  never due, since the desktop starts each run).
- Steps: `agent { prompt, runsOn }` (one turn on a route, as a setup role);
  `setup { setupId, task }`; `check { command, repeat, timeoutMinutes, retry?: {
  step, times } }` (a failing check sends its log to that earlier agent or setup
  step, then runs again); `decision { question, stopWhen }` after an agent step,
  which is asked to end with `{"answer": "yes" | "no"}` (one more ask if it does
  not); `approval { detail? }`; `action` `open-pr { draft }` (after an approval,
  in a worktree: commits, pushes the run's branch, opens the pull request),
  `notify { text }`, `slack { channel, text }` (asks first). `{pr}`, `{pr_url}`
  and `{opened_pr}` are filled in.
- `workflow.list { all? }` returns `{ workflows }` with their last 20 runs (ids,
  states, step notes, error codes; never prompts or answers). `all` lists every
  project's, each with its `root`. `workflow.get { id }`, `workflow.save {
  workflow }`, `workflow.delete { id }`, `workflow.enable { id, on }`.
- `workflow.propose { workflow | message, thread?, runsOn }` stores an agent's
  proposal (the last json block of `message` with a `workflow` object) as
  `proposed`; it never runs, by trigger or by hand, until `workflow.approve {
  id }` turns it on.
- `workflow.due` returns `{ due: [{ workflowId, name, root, trigger, pr? }] }`
  and marks each started, so the app's scheduler calls it on a timer: a
  schedule missed while the app was closed is due once; a PR trigger asks
  GitHub at most every 5 minutes, and its first look only learns what is open.
- `workflow.upcoming` returns `{ armed, next? }` without changing anything:
  how many workflows are on with a schedule or a PR trigger, and the soonest
  scheduled start (`{ workflowId, name, root, at }`, never earlier than now).
  The app keeps running in the menu bar while any is armed.
- `workflow.run.start { id, trigger?, pr?, input? }` (on the project's engine), `.status
  { runId }`, `.list`, `.answer { runId, stepId, approved }` (an approval, or a
  Slack message to send), `.stop { runId }`. A run's status has `steps` (each
  with `status`, `note` and the `setupRuns` it started), `waiting`, `notices`
  (what notify actions said), `openedPr`, and `error { code, message }`. A setup
  run a workflow started carries `owner { kind: workflow, runId, name }`, and a
  run in the checkout asks for its turns with `checkout: true`. `input` (only
  with `trigger: webhook`, up to 16,384 characters) is what the webhook sent:
  each agent and setup step's prompt starts with it in a code fence no backtick
  run inside can close, labelled as outside data and not instructions from the
  person. Notices and Slack text never see it, and it is kept in memory only,
  never in the run's record or status.
- After Quit, `runrail service --app <Runrail.app>`, kept
  running by a launchd agent the person turns on, opens the app hidden (`open
  -g -j`, `--background`) when it is not running and a schedule is due, a PR
  trigger sees a new pull request (asked at most every 5 minutes), or a memory
  source has not synced for an hour (at most hourly). It marks nothing and
  starts nothing; the app's own `workflow.due` does. The app is running while
  `~/.runrail/service/app.json` (`{ pid, at }`, written about every 30 seconds
  by the desktop, `pid` null after it quits) is under 90 seconds old and its
  process lives. After opening the app it waits 5 minutes before opening it
  again, 30 after a failed open.

## Thread worktrees

`worktrees` covers `worktree.list`, `worktree.create`, `worktree.remove`, and
`worktree.apply`.
Each thread worktree is a git linked worktree stored outside the repository,
under `<worktreeRoot>/<repo>-<hash>/<id>`. The default root is
`~/.runrail/worktrees`; embedders can pass `worktreeRoot` to
`startRunrailControlRpcServer`. Each result includes `cwd`, the workspace path
to pass to a second `runrail control --cwd` process for that thread.

- `id` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- `revision` defaults to `HEAD`; `branch` is optional and must be a new valid
  branch name. Without a branch the worktree is detached.
- `worktree.remove` refuses a worktree with uncommitted changes
  (`CONTROL_GIT_CONFLICT`) unless `force: true`. The branch is kept unless
  `deleteBranch: true`, which deletes it only when git considers it merged
  into the project; a branch with commits of its own stays. The result then
  carries `branchDeleted`.
- `worktree.apply { id }` applies everything the worktree changed since it
  forked from the project (commits, uncommitted edits, and new files) to the
  project checkout as a three-way merge and returns `{ id, base, files,
  conflicts }`. Results are staged for review; `conflicts` lists paths left
  with conflict markers. It refuses (`CONTROL_GIT_CONFLICT`) when the project
  has unresolved conflicts, has no commit, shares no history with the
  worktree, or has local changes in files the worktree changed. Only the
  workspace scope is applied, never Runrail runtime state; limits are 10,000
  files and a 64 MiB patch (`CONTROL_GIT_LIMIT`). The worktree is not changed.

## Tool presentation

`tool.presentation` adds a `presentation` object to `tool.started` events sent
over `GET /events` and returned by `turn.enqueue` and `turn.steer`. It is
derived from the tool name and input at send time, is bounded, and is not
stored in the event log or transcript. It works for native tools and for
Claude Code, Codex, pi, and MCP tool names.

`presentation` has a `kind` (`read`, `write`, `edit`, `patch`, `shell`,
`search`, `list`, `web`, `agent`, `plan`, `verify`, `mcp`, or `other`), a
one-line `title`, and, where the input provides them, `path`, `paths` (at most
32), `command`, `query`, `url` (http or https, credentials removed), `server`
and `tool` for MCP calls, `edits` and `content` previews (16 KiB), and `plan`
items (at most 64). Edit and write previews are omitted for credential files.
`truncated: true` means a preview or list was shortened.

A `command` that is only `sh -c '<script>'` or `/bin/zsh -lc '<script>'`, the
way Codex runs every command, is its script with the quoting undone, and the
title names the script. Anything more on the line (another argument, a
redirection, a chain) keeps the command as written.

Shell and verify presentations add `intent` (`test`, `build`, `lint`,
`typecheck`, `commit`, `push`, or `pr`) only when the call's exit status is
that work's status: one command, optionally after `cd <dir> &&`, read through
`sh -c` and `zsh -lc` wrappers, package runners (`npx`, `uv run`), and
redirections. A chain, pipe, substitution, heredoc, watch mode, or background
run has no intent; a missing `intent` means unknown, not other work.
`run_verification` with `name: "test"` is `test`. A native `run_command` or
`run_verification` whose command failed (a non-zero exit, a timeout, a
cancellation, or a background command that did not start) completes with
`ok: false` and `COMMAND_FAILED` or `VERIFICATION_FAILED`, and keeps its
output.

## Live frames

`live.frames` adds Runrail-owned frames for content a coding UI renders live
but the `AgentEvent` union cannot carry. Every frame has `version: 1`,
`sessionId`, a monotonic `liveSeq`, `at`, `afterSeq` (the highest event `seq`
seen when the frame was produced, for timeline placement), and optional
`turnId`.

| `type` | Fields | Sources |
| --- | --- | --- |
| `reasoning.delta` | `itemId?`, `parentCallId?`, `text` (append) | native Anthropic thinking and OpenAI reasoning streams, Claude Code `thinking_delta`, Codex app-server reasoning deltas |
| `reasoning.completed` | `itemId?`, `parentCallId?`, `text?` (replaces accumulated deltas) | Claude Code `thinking` blocks, Codex `reasoning` items |
| `plan.updated` | `callId?`, `explanation?`, `steps[{ text, status }]` | native `update_plan`, Claude Code `TodoWrite`, Codex `update_plan` and `turn/plan/updated`, pi plan tools |
| `agent.spawned` | `callId`, `parentCallId?`, `title`, `agentType?` | agent tool calls (`Task`, `spawn_agent`, ...) |
| `agent.completed` | `callId`, `ok` | completion of a tracked agent call |
| `lineage` | `parentCallId`, `callId?` or `eventSeq?` | Claude Code `parent_tool_use_id` |
| `model.notice` | `code: "THINKING_REFUSED"`, `thinking` | a connected model that refused the reasoning level; the turn went out without one. Sent once per model port; the engine remembers the refusal for that level only |
| `context.usage` | `usedTokens`, `windowTokens?`, `estimated` | the native loop after each model request (input plus output, against the routed model's listed window), Codex app-server token usage (`modelContextWindow` when it reports one). Token counts are 0 to 20M; a window of 0 is dropped |
| `plan.limits` | `source` (`codex` or `claude-code`), `plan?`, `windows[{ id, model?, usedPercent, resetsAt?, windowMinutes? }]` (at most 12) | the subscription a coding tool runs on: Codex `account/rateLimits/read` when its server starts and `account/rateLimits/updated`, Claude Code `rate_limit_event`. `id` is `five-hour`, `weekly`, `weekly-opus`, `weekly-sonnet`, `weekly-model` (a weekly window of one model's own, named by `model` as Anthropic's server spells it, 1 to 40 characters, at most 8, from the usage call only), or `primary`/`secondary` for a window Codex did not name by length. `usedPercent` is 0 to 100, `resetsAt` is milliseconds. Account-wide, so it carries no `turnId` and may arrive between turns; an update can name only some windows, so merge by `id` and `model`. Account ids, balances, and credit details are dropped |
| `approval.reviewed` | `reviewId`, `reviewer` (`codex` or `claude-code`), `decision` (`reviewing`, `approved`, `denied`, `timed-out`, `aborted`), `action`, `capability`, `risk?`, `source?` (`reviewer`, `rule`, `mode`), `detail?` (one line, at most 512 characters), `rationale?` | a coding tool deciding a call for the person: Codex's own reviewer (Approve for me), Claude Code's auto mode, its deny rules and modes. A start and its decision share `reviewId` |
| `reviewer.notice` | `reviewer`, `notice` (`unavailable` or `warning`), `message?` | Auto asked for while the coding tool runs without its reviewer (once a session), or the reviewer's own warning |

Merge reasoning by `(turnId, itemId ?? "")`: a delta appends, a completed
frame replaces the text when it has one and closes the block, and a later
delta opens a new block. Plan status is `pending`, `in_progress`, or
`completed`. Build the subagent tree from `agent.spawned.parentCallId` and
attach nested tool calls with `lineage`.
`lineage.eventSeq` attaches a child assistant message to its agent; reasoning
frames use `parentCallId` directly. Codex spawn calls return before the child
finishes, so their return does not complete the agent. Agent completion also
settles the matching background entry, keeping `background.list` consistent.

Delivery:

- `GET /events` emits `event: runrail.live` frames with `id: live-<liveSeq>`
  and accepts `afterLiveSeq`.
- `turn.enqueue` and `turn.steer` return `live` (frames produced during the
  turn, at most 1024) next to `events`.
- `live.frames { afterLiveSeq?, maxFrames? }` returns `{ frames, lastLiveSeq }`
  for reconnects. `maxFrames` is 1 to 4096; an expired cursor fails with
  `CONTROL_LIVE_CURSOR_EXPIRED` (409).

Bounds: reasoning text 16 KiB per frame, explanation 2 KiB, 64 plan steps of
at most 1024 characters, identifiers 256 characters without control
characters, titles 160 characters. The ring keeps 4096 frames or 8 MiB. Frames
are in-memory only, never written to the event log, transcript, task journal,
or share bundles. Pi reasoning is not available because the Pi adapter does not
expose it; Pi plan and agent frames are derived from tool calls.

## Conversation replay and titles

`session.conversation.read { sessionId?, source?, maxItems?, maxBytes? }`
rebuilds a thread for a coding UI and returns `{ sessionId, source, items,
truncated, lastSeq }`. Resume the event stream with `afterSeq=lastSeq`.

- `source: "auto"` (default) reads the caller-owned transcript store when one
  is configured and the in-process live view otherwise. `"transcript"` without
  a store fails with `CONTROL_TRANSCRIPT_UNAVAILABLE` (501). `"live"` only
  serves the current session.
- `sessionId` selects another session in the same transcript store, so a
  restarted sidecar started with `--session-id` can reopen its thread.
- `maxItems` is 1 to 4096 (default 512) and keeps the newest items.
  `maxBytes` is 1 KiB to 8 MiB (default 4 MiB) and drops the oldest items until
  the list fits. `truncated: true` means older items were dropped.

| `kind` | Fields |
| --- | --- |
| `user` | `text`, `attachments?` (count), `truncated?` |
| `assistant` | `text`, `partial` (only deltas seen), `truncated?` |
| `tool` | `callId`, `name`, `presentation`, `status` (`running`, `ok`, `failed`), `errorCode?`, `output?` |
| `approval` | `approvalId`, `action`, `capability`, `reason?`, `status` (`pending`, `approved`, `rejected`), `questions?` and `answers?` for a coding tool's question (a `secret` question's answer is never kept), `withdrawn?`, and `denial?` (why a rejected one was denied, when the denial said) |
| `notice` | `level` (`info`, `error`), `code`, `name?` |

Every item has `id` (stable for one rebuild), `seq`, `at`, and `turnId?`.
Text is capped at 64 KiB per item (32 KiB in the live view), and a reply that
arrived as consecutive messages is one item; `output` is kept
only for shell and verification tools as an 8 KiB tail. Error messages, tool
inputs beyond the bounded presentation, and non-shell tool output are not
included. The live view keeps 2048 items in memory, spans backend and provider
switches in the same process, and is never persisted. Items contain user and
assistant text and stay on the authenticated loopback channel.

`conversation.peek { threadId, workspace, maxItems? }` (capability
`conversation.peek`) reads another thread's conversation from its transcript,
so a client can show it before that thread's own engine is ready. It is
`available` when the engine was started with `--threads-dir <path>` and
`configurable` otherwise, where the call fails with
`CONTROL_CAPABILITY_UNAVAILABLE` (501). It returns `{ threadId, items,
truncated, lastSeq }`, the same items `session.conversation.read` gives for
that transcript.

- The file read is `<threads dir>/<threadId>/transcript/<threadId>.jsonl`.
  The read never recovers, writes, or locks it, so the thread's own engine is
  never kept waiting. A last line still being written is left out. No file
  yet answers `{ items: [], truncated: false, lastSeq: -1 }`.
- `threadId` follows the session id rules. `workspace` is the thread's folder,
  an absolute path to an existing folder, used only to show paths. `maxItems`
  is 1 to 2048 (default 512). The answer is capped at 4 MiB, dropping the
  oldest items. Anything else fails with `CONTROL_INVALID_INPUT` (400); a
  malformed transcript with `CONTROL_TRANSCRIPT_INVALID` (400).

`task.rename { taskId, title }` replaces a task title (1 to 256 characters),
bumps `revision`, and returns the task. Renaming to the same title is a no-op.
Titles are labels, so no task journal event is written.

## Installed coding tools

`harness.status { refresh? }` (capability `harness.status`) answers
`harness.list` with what each installed coding CLI said about itself. Each
entry is `{ descriptor, available, reason?, version?, signedIn?, models?,
efforts?, freeTextModel?, proxy? }`:

- `available: false` with `reason: "not-installed"` means the command could
  not be started. Claude Code, Codex, GitHub Copilot, and Pi are asked; every
  other adapter is listed as `available: true` without a check.
- `signedIn` is present only when the tool answered the question. `false` adds
  `reason: "signed-out"` and leaves `available: true`: it is the tool's own
  word, not proof, so a caller should warn rather than refuse.
- `proxy: { address, name? }` says the tool's own settings send its model
  requests somewhere other than its vendor, such as a local Headroom proxy:
  Claude Code's `env.ANTHROPIC_BASE_URL` in `settings.json`, or Codex's chosen
  `model_provider` (with its `name`) or `openai_base_url` in `config.toml`.
  Only that field is read, the files are found through the run's `HOME`,
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and `address` is the host and port
  alone, since a path or query can carry a key.
- Copilot has no command that says whether someone is signed in or which
  models it offers, so its entry never has `signedIn` or `models`; its model
  is typed. Pi's `signedIn` is whether `pi --list-models` listed anything.
- `models` is `[{ id, name?, default?, efforts?, reasoning?, resolved?, catalog? }]`:
  Codex's own list from its app-server, Claude Code's own list, and Pi's table
  of models it can run (`provider/model`, at most 256). `freeTextModel: true`
  means an id outside the list is accepted.
- Claude Code's list is asked of the installed `claude` itself, on the same
  stream-json control channel the Agent SDK uses (`initialize`), so it needs no
  SDK. It runs with `--setting-sources ""`: no settings load, so no hook runs;
  no prompt is sent and no conversation is saved. Only the answer's `models`
  is read; the rest of it names the account and is ignored. Each alias is
  named by the version it runs (`Opus 5.5`), `resolved` is the exact model
  (`claude-opus-5-5`), `default: true` marks what its `default` row resolves
  to, and a model with no effort levels has `reasoning: false`. When Claude
  Code does not answer within the probe's time, its rows are the fixed
  aliases `fable`, `opus`, `sonnet`, `haiku`.
- Claude Code lists only its current aliases but runs any model id. After its
  own rows come the other Claude models in Runrail's model catalog (Opus 5,
  Opus 4.8, ...), newest first per family, each with `catalog: true`: run by
  its full id, and only the first message says whether the account may use
  it. `connection.status` never starts Claude Code for this.

Runrail runs the CLIs' own commands (`--version`, `claude auth status --json`,
a short-lived `codex app-server`, `pi --list-models`) with the same filtered environment a turn
gets, and never opens their credential or session files. It reads whether an
account is present and nothing about it: no name, address, organization, or
plan is returned or logged. Each command is bounded (5 seconds, 64 KiB), the
answer is cached for 10 seconds, and `refresh: true` asks again. A `refresh`
that is not a boolean is refused with `CONTROL_INVALID_INPUT`.

### Which Codex CLI runs

The Codex desktop app ships its own copy of the CLI
(`<app>/Contents/Resources/codex-cli/bin/codex`, for `ChatGPT.app` or
`Codex.app` in `/Applications` or `~/Applications`) and updates it with the
app, so it can be newer than `codex` on PATH. On macOS, when no command is
named, Runrail compares `--version` of the PATH copy and the app copies and
runs a strictly newer app copy; otherwise it runs `codex` from PATH. The
status check and every Codex thread use the same pick, so the models listed
are the ones the running CLI offers. `resolveCodexCommand()` returns it.

- A PATH copy whose version cannot be read is kept. An app copy is used only
  if it is a regular file that only its owner (the user or root) can write
  and that answers `codex-cli X.Y.Z`. A pre-release sorts below its release.
- Versions are remembered per file until the file changes.
- `RUNRAIL_CODEX_APP_SEARCH=off` keeps to PATH. A named command
  (`harnessCommand`) is always run as given.

## Sessions from other harnesses

`session.external.list { limit?, scope? }` lists Claude Code, Codex, Pi,
OpenCode, Gemini CLI, Goose, and Copilot CLI sessions recorded in this workspace
or a folder below it, newest first, and returns `{ sessions, truncated? }`. Each
summary has `source` (`claude-code`, `codex`, `pi`, `opencode`, `gemini`,
`goose`, `copilot`), `id`, `title?` (one line, 120 characters), `updatedAt`,
`bytes?` (a session file's size) or `messages?` (a session kept in a database),
`branch?`, and `cwd?`, the folder the tool recorded it in. `limit` is 1 to 1000
(default 200). Only the first 128 KiB and last 64 KiB of each file are read for
a summary, at most 1500 files per tool and call; a database is queried for at
most `limit` sessions.

`scope: "all"` lists every folder's sessions instead (`"project"` is the
default), and marks one whose folder no longer exists `missing: true`. It only
lists: `session.external.import` still finds a session only in this workspace,
so a host that offers one from another folder first opens a thread in a
workspace that holds it, after the person approves that folder as a project.

`session.external.import { source, id, continueIn? }` copies one session into
the current session's transcript and returns `{ sessionId, source, title?,
imported, historyMessages, truncated?, inTool?, historyUnavailable? }`
(`historyUnavailable`: the import was written, but the model could not be given
it). The thread must be new: a
transcript that already has records fails with `CONTROL_TRANSCRIPT_CONFLICT`
(409), a running session with `CONTROL_SESSION_BUSY` (409). The import appends a
`session.imported` notice (`name` is the harness label), then loads the
conversation as model history so the next turn continues it.

`continueIn: "tool"` continues the session in its own tool instead: the thread
must run on that tool (`claude-code`, `codex`, or `opencode`) with its own
command and its default config folder, else the call fails with
`CONTROL_CAPABILITY_UNAVAILABLE` (409). The session id is kept for the thread's
first turn, which forks it (Claude Code `--fork-session`, Codex `thread/fork`,
OpenCode ACP `session/fork`) and continues the fork, so the tool's own history
is never written; the fork's id replaces it. Gemini CLI, Goose, and Copilot CLI
offer only `session/load`, which would continue the original and write into
their history, so their sessions continue on Runrail; an ACP agent that cannot
fork fails the turn with `COMMAND_AGENT_UNSUPPORTED` rather than load one. The
transcript still gets the copy and a `session.imported` notice with
`inTool: true`, and no recap of it goes to the tool, which already has the
conversation. `continueIn: "runrail"` is the default.

`session.external.refresh { dryRun? }` brings in what an imported session
gained in its tool since the import and returns `{ sessionId, source, turns,
imported, truncated?, historyMessages?, historyUnavailable? }`; `dryRun: true`
only counts. The
`session.imported` record keeps the session's id, how many records it had, and
a digest of its last eight; the session is read again and only the records
after that point are appended, each under an id that cannot be appended twice,
followed by another `session.imported` record (`refreshed: true`, `turns`) that
the conversation shows as a `session.refreshed` notice. New records without a
new prompt count as one turn. A thread with no import fails with
`CONTROL_NOT_FOUND` (404), an import from before this method with
`CONTROL_CAPABILITY_UNAVAILABLE` (409), a thread that has run a turn since with
`CONTROL_TRANSCRIPT_CONFLICT` (409), and a session whose earlier records changed
(rewritten, compacted, another branch) with `CONTROL_EXTERNAL_CHANGED` (409).

- Folders come from `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and
  `PI_CODING_AGENT_DIR` when absolute, else `~/.claude/projects`,
  `~/.codex/sessions`, and `~/.pi/agent/sessions`; OpenCode's
  `opencode.db` and Goose's `sessions.db` are in `$XDG_DATA_HOME` (default
  `~/.local/share`) under `opencode` and `goose/sessions`; Gemini CLI's chats
  are under `~/.gemini/tmp/<project>/chats`, with the project's folder in
  `.project_root`; Copilot CLI's are `~/.copilot/session-state/<id>/`
  (`workspace.yaml` and `events.jsonl`). Hosts can pass `externalSessionRoots`
  instead; a host that leaves out `opencode`, `gemini`, `goose`, or `copilot`
  skips that tool.
- Only session files and session tables are read. A tool's sign-in
  (`auth.json`, `oauth_creds.json`, its account and credential tables, its
  config) is never opened. OpenCode's and Goose's stores are opened read-only;
  when the tool holds one locked, a copy in a temporary folder is read and
  deleted at once (up to 256 MiB). A store that cannot be read lists nothing
  and does not fail the other tools' lists.
- A session is found only when its recorded working directory is this
  workspace or below it; any other id, a symlinked file, or a subagent's
  session (Codex, OpenCode, Goose) fails with `CONTROL_NOT_FOUND` (404). Ids are 1 to 128 characters of
  letters, digits, `_`, and `-`. Files over 256 MiB fail with
  `CONTROL_BODY_LIMIT` (413).
- Converted records keep user and assistant text (32 KiB each), tool names,
  inputs up to 16 KiB, and an 8 KiB output tail, for the newest 4000 records.
  Side chains, meta and compaction entries, injected context (environment,
  instruction, and command blocks, and text a tool added to a prompt itself),
  reasoning, Pi branches other than the active one, and messages Goose hid from
  the person are dropped.
- Without a transcript store the capability is `configurable` and import fails
  with `CONTROL_TRANSCRIPT_UNAVAILABLE` (501); listing still works.

Model history: the native model keeps its conversation in memory, so a sidecar
that starts on an existing transcript (restart, backend switch, import) rebuilds
the earlier turns from it before the first new turn. History is the newest 80
user and assistant messages, 60,000 characters in total and 8,000 per message,
with tool calls reduced to one line each; tool inputs and outputs are not
replayed. It is held in memory and never written.

## Connectors

GitHub, Linear, Slack, and Jira are built in. Which are on lives in
`~/.runrail/connectors.json` (0600), which the CLI passes as `connectorsFile`;
an embedder that passes none builds no connectors. The file holds no secret: GitHub answers with the person's own `gh` sign-in
(`gh auth token`, read per call), and the other services' keys sit in the
credential vault under `connector:<kind>`, read only when a call is made. A
connector that is on but has no key fails each call with
`CONNECTOR_CREDENTIALS`; the session still starts. Each service is reached at
its own host only (`api.github.com`, `api.linear.app`, `slack.com`, and the
Jira site). An engine reads the file when it starts, so a change reaches the
threads started after it.

| Method | Params | Result |
| --- | --- | --- |
| `connector.setup.list` | none | `{ connectors: [{ id, name, on, connected, signIn: "gh" \| "key", site?, email? }] }`; `connected` is a working `gh` sign-in for GitHub (the account `gh config get -h github.com user` names, so listing reads no token and makes no network call), a key in the vault for the others |
| `connector.setup.save` | `{ id, on, site?, email? }` | the setting. Jira needs its `site` (as `your-team.atlassian.net`) and the API token's `email` while it is on |
| `connector.setup.remove` | `{ id }` | `{ id, removed: true }`; the key is deleted from the vault too |

A key goes through `POST /secret` with `{ connectorId, secret }` (not
`/rpc`), like an account's key; GitHub takes none. `connector.list`,
`connector.actions`, and `connector.invoke` answer from this registry when the
embedder supplied none.

Who may use what. The behavior file's `integrations` maps a connector
id, or `mcp:<server>` for a behavior-file MCP server, to `off`, `read`, `ask`,
or `write`; one left out is `write`:

```json
{"integrations":{"github":"read","slack":"off","mcp:docs":"ask"}}
```

Off hides it (an MCP server is not started). Read offers a connector's read
and search actions, or MCP tools named in the caller's `readOnlyTools` allowlist.
Server-controlled read-only hints never grant authority. Ask offers everything
and every use waits for the person. Write offers everything, and tools not
explicitly admitted as read-only still ask first. Each route takes the same
grants: Runrail's own loop gets native tools named `connector.<id>.<action>`;
Claude Code gets an MCP server, `runrail connectors-mcp`, started from a
private endpoint file like the browser tools, whose list and calls come from
`POST /connectors` with its own token (tools named `<id>_<action>`; the server
is in `--allowedTools`, and each tool whose grant needs approval is in the
launch's `askTools`, which the PreToolUse gate asks about in every permission
mode, Full access included); Codex gets the tools that need no approval as dynamic
tools when a thread starts, since it cannot ask before one runs. ACP tools and
Pi get none yet.

## MCP servers from the behavior file

The behavior file (`--config`) may list MCP servers, either local programs
(stdio) or addresses (streamable HTTP):

```json
{"mcp":{"servers":[
  {"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":["GITHUB_PERSONAL_ACCESS_TOKEN"],"enabled":true},
  {"name":"docs","url":"https://mcp.example.com/mcp","bearerEnv":"DOCS_MCP_TOKEN","readOnlyTools":["search"]}
]}}
```

At most 16 servers. `name` matches `^[a-z][a-z0-9_-]{0,31}$` and is unique;
`enabled` defaults to `true`. A server has either `command` or `url`, not
both. Anything else refuses the whole file.
`readOnlyTools` is optional and lists at most 256 unqualified tool names the
caller admits without approval. A destructive/open-world annotation still asks;
with a Read grant that tool is omitted. An omitted list admits no approval-free
tools, regardless of `readOnlyHint`.

- Program: `command` is one program name or path (no whitespace, at most 256
  characters, not starting with `-`); at most 32 `args`; `env` lists at most
  16 variable names, never values.
- Address: `url` is at most 2,048 characters, `https`, or `http` only on
  `localhost`, `127.0.0.1`, or `[::1]`, with no user name or password.
  `bearerEnv` optionally names the variable that holds the access token; the
  engine reads it when it connects and sends `authorization: Bearer <value>`
  to that address only. An unset or empty variable fails that server with
  `MCP_TOKEN_MISSING`. `bearerEnv` without `url` is refused.

Only the native backend connects to them, in the session's workspace, when
the session starts. Each server's tools are named `<name>.<tool>`. A server
gets `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `CI`, and the variables its
`env` names from the engine's own environment, and nothing else. A server
that fails to start, answer, or list usable tools is reported with a stable
`MCP_*` code and the session runs without it. The servers stop with the
session.

| Method | Params | Result |
| --- | --- | --- |
| `mcp.status` | none | `{ servers: [{ name, state: "ready" \| "failed" \| "off", tools, code? }] }` for this session's connections; empty on other backends |
| `mcp.check` | `{ name }` | one status, from starting that server alone, listing its tools, and stopping it. Works on any backend. An invalid or unlisted name is `CONTROL_INVALID_INPUT` (400) |
| `nifra.status` | none | `{ mcp, pi, check }`: whether Nifra's MCP tools, Pi's Nifra setup, and the default `nifra` check are on for this session. All false outside a Nifra project or with `--no-nifra` |

The `mcp` capability is `available` when the engine has both methods.

## Providers from other tools

`connection.importable` (no params) reads the providers that Codex
(`~/.codex/config.toml`, `model_providers`), Pi (`~/.pi/agent/models.json`),
and opencode (`~/.config/opencode/opencode.json`) are set up with, and returns
`{ candidates: [{ source, id, name, baseUrl, kind, presetId?, environmentName?, environmentSet?, models }] }`.
It writes nothing; adding a candidate goes through the usual connection
methods.

- `kind` is `preset` when the address's host is a built-in preset's (then
  `presetId` names it), `local` for `localhost`, `127.0.0.1`, or `[::1]`, and
  `remote` for any other `https` address. Plain `http` to another host, and
  any address with a user name or password, is left out.
- No key is ever returned. `environmentName` is returned only when the source
  names the preset's own variable (for example `OPENAI_API_KEY`), and
  `environmentSet` says whether the engine's environment holds it. A key
  written literally in a source file is ignored.
- Files over 1 MiB or that do not parse are skipped. At most 64 candidates,
  each with at most 64 chat model ids.

The `connection.import` capability is `available` when the engine has the
method.

## RPC shapes

All methods use the normal authenticated `{ ok, result }` or `{ ok: false,
error }` envelope.

```json
{"method":"workspace.list","params":{"path":"src","maxDepth":2,"maxEntries":256}}
{"method":"workspace.read","params":{"path":"README.md","maxBytes":262144}}
{"method":"session.transcript.status","params":{}}
{"method":"session.transcript.read","params":{"afterSeq":-1,"maxRecords":256,"maxBytes":4194304}}
{"method":"session.transcript.export","params":{"afterSeq":-1,"maxRecords":256,"maxBytes":4194304}}
{"method":"session.transcript.import","params":{"transcript":"<versioned bundle>","targetSessionId":"optional-target"}}
{"method":"session.transcript.branch","params":{"targetSessionId":"optional-target"}}
{"method":"session.transcript.compact","params":{"throughSeq":12,"replacement":{"kind":"summary","payload":{}}}}
{"method":"terminal.describe","params":{}}
{"method":"terminal.create","params":{"sessionId":"terminal-1","cwd":"","cols":120,"rows":40}}
{"method":"terminal.write","params":{"sessionId":"terminal-1","data":"pwd\n"}}
{"method":"terminal.read","params":{"sessionId":"terminal-1","afterSeq":-1,"maxBytes":65536,"maxChunks":256}}
{"method":"terminal.resize","params":{"sessionId":"terminal-1","cols":120,"rows":40}}
{"method":"terminal.close","params":{"sessionId":"terminal-1"}}
{"method":"git.status","params":{"maxEntries":1000}}
{"method":"git.diff","params":{"scope":"unstaged","paths":["src"],"maxFiles":300,"maxBytes":4194304,"maxFileBytes":524288,"contextLines":3,"includeUntracked":true}}
{"method":"git.stage","params":{"paths":["src/a.ts"]}}
{"method":"git.unstage","params":{"paths":["."]}}
{"method":"git.discard","params":{"paths":["src/a.ts"],"scope":"unstaged","includeUntracked":false}}
{"method":"git.commit","params":{"message":"fix: handle empty input","paths":["src"],"runHooks":false}}
{"method":"git.log","params":{"limit":50,"skip":0,"paths":["src"]}}
{"method":"worktree.list","params":{}}
{"method":"worktree.create","params":{"id":"thread-1","revision":"HEAD","branch":"runrail/thread-1"}}
{"method":"worktree.remove","params":{"id":"thread-1","force":false}}
{"method":"worktree.apply","params":{"id":"thread-1"}}
{"method":"session.external.list","params":{"limit":200}}
{"method":"session.external.import","params":{"source":"codex","id":"0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"}}
{"method":"connection.presets","params":{}}
{"method":"connection.detect","params":{}}
{"method":"account.create","params":{"accountId":"conn-openrouter","provider":"openrouter","label":"Work","authMode":"api-key"}}
{"method":"account.create","params":{"accountId":"conn-local","provider":"custom-openai-chat","label":"Local relay","authMode":"api-key","baseUrl":"http://127.0.0.1:11434/v1"}}
{"method":"account.create","params":{"accountId":"conn-shell","provider":"deepseek","label":"DeepSeek (shell key)","authMode":"environment","environmentName":"DEEPSEEK_API_KEY"}}
{"method":"connection.models","params":{"connectionId":"conn-openrouter"}}
{"method":"connection.test","params":{"connectionId":"conn-openrouter"}}
{"method":"provider.select","params":{"connectionId":"conn-openrouter","model":"vendor/model-id","thinking":"medium"}}
```

`workspace.list` returns `{ path, entries }`, where each entry has a relative
`path`, `type`, and optional file `bytes`. `workspace.read` returns `{ path,
bytes, content }`. Transcript reads return `{ sessionId, records }`; export
returns `{ transcript }` containing the versioned bundle. Transcript status is
metadata-only. Terminal create, resize, and close return a normalized session
`{ sessionId, cols, rows, status }`; write returns `{ acceptedBytes }`; read
returns `{ session, chunks, nextSeq, closed }`.

`git.status` returns `{ branch?, detached, initial, head?, upstream?, ahead,
behind, entries, counts, truncated }`; each entry has a workspace-relative
`path`, optional `originalPath`, `index` and `worktree` change kinds, and
`staged`, `unstaged`, `untracked`, `conflicted`, `submodule`, and `sensitive`
flags. `git.diff` returns `{ scope, files, totals, truncated }`. `git.stage` and
`git.unstage` return `{ paths, status }`; `git.discard` returns `{ restored,
removed, skippedUntracked, skippedConflicted, status }`; `git.commit` returns
`{ commit, shortCommit, summary, status }`; `git.log` returns `{ commits }`.
`worktree.list` returns `{ worktrees }`; each worktree has `id`, `path`, `cwd`,
optional `head` and `branch`, and `detached`, `locked`, and `prunable` flags.
`worktree.remove` returns `{ id, removed }`, plus `branchDeleted` when
`deleteBranch` was passed.

`connection.presets` returns `{ presets, custom }`. A preset with
`signInOnly: true` is reached through its sign-in only and takes no key. `connection.detect` returns
`{ detected }`, each entry `{ presetId, name, environmentName }`.
`connection.models` returns `{ connectionId, presetId, models, live: { ok,
code }, manualEntry }`; each model has `id`, `source` (`live` or `snapshot`),
and optional `name`, `contextTokens`, `maxOutputTokens`, `reasoning`, and
`images`. `connection.test` returns `{ connectionId, status, code,
modelCount?, checkedAt }` with `status` one of `ok`, `unverified`, or
`failed`. A pasted key for an `api-key` account goes through `POST /secret`,
never through these methods.
