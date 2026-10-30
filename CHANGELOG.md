# Changelog

All notable changes to Runrail will be documented here.

## [Unreleased]

## [0.2.0] - 2026-10-30

Recall by meaning, sign-in to remote MCP servers, connectors on more routes,
setup runs that resume, and fixes from a security and robustness audit. Runrail
0.1.1 and 0.1.2 were never released, so this release also brings their changes,
listed below.

- Built on the public Nifra 5.8.0 packages (was 5.3.0), and `runrail new`
  starters scaffold with `create-nifra@5.8.0`.
- Recall by meaning. Pick an embedding model on one of your connections and
  memories are embedded in the background with that connection's own key;
  recall then finds a memory that says the same thing in other words, joined
  with the keyword matches. How close counts as the same thing is measured for
  each model when you pick it. Every memory is searched: a one-bit-per-dimension
  code of each is scanned and only the closest thousand are compared in full,
  so at the 50,000-memory limit recall holds about 11 MB. Off until you pick a
  model, and it falls back to keywords when the model does not answer.
- Connectors on Pi and the ACP routes. Copilot, OpenCode, Gemini, and Goose
  start Runrail's connectors MCP server for each session, and Pi loads an
  extension that declares the connector tools with `registerTool`, so it works
  whatever MCP extension Pi has. Like Codex, these routes cannot ask before a
  tool runs, so they get only the tools whose grant needs no approval.
- Sign in to a remote MCP server in the browser. A server that answers 401
  now reports `MCP_SIGN_IN_REQUIRED` instead of a transport failure, and
  `auth.mcp.start` signs in the way the MCP authorization spec describes:
  Runrail registers itself with the server's authorization server, signs in
  with PKCE, and keeps the tokens, bound to that server, in the credential
  vault, renewing them before they run out. A token from `bearerEnv` that the
  server refuses now reports `MCP_TOKEN_REJECTED`.
- An MCP server whose authorization server does not let apps register
  themselves, such as GitHub's, signs in with an app you registered:
  `auth.mcp.client.set` names its app ID and callback port, and its secret goes
  only through `POST /secret` (`mcpClientId`) into the credential vault. Such
  a server with no app named reports `AUTH_CLIENT_REQUIRED`.
- Setup runs pick up where they stopped. An engine started with a setup-runs
  folder saves each run a person started as it goes, and Desktop asks the
  project's engine to take it back after a restart: done steps stay done, the
  step that was mid-turn is marked interrupted, and the next turn is told to
  check where things stand (`setup.run.saved`, `setup.run.restore`).
- A setup's budget can cap tokens (`budget.maxTokens`). Each answered turn
  reports its thread's input and output so far, and a run's status and each
  eval case show the total.
- `runrail eval run` runs a saved eval suite with no desktop, each case's
  turns in this process on the role's own route, model, and access, into the
  same results Desktop lists; `runrail eval list` shows them. Up to four evals
  now run at once in a project (was one).

### Security

- File tools refuse paths that run programs on their own: `.husky`,
  `.githooks`, `.codex`, `.mcp.json`, `.claude/settings*`, `.claude/hooks`, and
  `.vscode/tasks.json`. They no longer follow a link swapped in after the check.
- Sign-in to a remote MCP server no longer follows the server to a private
  address, and a damaged OAuth file is set aside instead of overwritten. One
  shared private-address check now serves every fetch that needs it.
- Tool descriptions from an MCP server are capped in length.
- `run_command` rejects input fields it does not read and drops relative
  `PATH` entries. The approval card shows the folder the command runs in.
- A Codex tool call must name the turn that is running. The Claude Code route
  reads user settings only. `install.sh` requires https.

### Fixes

- The Linear connector sends your personal API key the way Linear's API
  asks, with no `Bearer` prefix.
- An MCP server's failed HTTP request fails only itself, and a server that
  forgot your session starts a new one and the call is retried. Tool calls get
  their own 120-second timeout. A reply with audio or resource blocks is noted
  instead of failing, and a tool with a badly formed name is skipped instead of
  failing the whole server.
- `runGit` returns once git exits, even if a helper holds its pipes open, and
  git in a worktree has a timeout and ends its whole process group.
- `search_files`, `find_files` and `list_files` say when a result is partial
  (`truncated`, `skippedFiles`), and search now reaches 8,192 files.
- `.env.example` is readable, and a project under a `.ssh` folder is no longer
  refused.
- One plugin or package folder that fails verification no longer stops startup;
  it is listed as unavailable, and `plugins reload` still reports it.
- The share, push (VAPID), connector and checkpoint stores hold up under
  concurrent writes and damaged files. Device sign-in survives a network blip.
  Live frames, terminal output and transcript reads are faster.

## [0.1.2] - 2026-10-25

New ways to install Runrail, and the Claude Agent SDK downloaded from the
command line.

- Standalone `runrail` executables, which need no Bun: macOS (Apple silicon
  and Intel), Linux (arm64 and x64, glibc), and Windows (x64, experimental).
  Each release carries them with `install.sh`, which puts one in
  `~/.local/bin` after checking it against the release's `SHA256SUMS.txt`,
  without sudo: `curl -fsSL https://github.com/TechDev009/runrail/releases/latest/download/install.sh | sh`.
- `runrail sdk install` downloads Anthropic's Claude Agent SDK from npm after
  you agree, into `~/.runrail/agent-sdk` (or `RUNRAIL_AGENT_SDK_DIR`). The
  download must match a pinned SHA-512, and every load checks its files
  against it. `runrail sdk status` says where the SDK comes from. A Claude Code
  run or console without it asks whether to download it when you are at the
  terminal; otherwise it, `runrail doctor`, and `HARNESS_SDK_MISSING` name the
  command.
- Publishing a release puts it on npm (`npm install -g runrail`, through
  Trusted Publishing with provenance) and in the Homebrew tap
  (`brew install TechDev009/runrail/runrail`).

### Security

- The executables never load a `.env` or `bunfig.toml` from the folder they
  start in: a project's `bunfig.toml` can name a `preload` script, which would
  run inside Runrail.
- Neither does `runrail` installed with npm or Bun: its command starts Bun
  through `/bin/sh` with `--env-file=/dev/null --config=/dev/null`.
  The Runrail that Claude Code starts again as an MCP server, and the creator
  `runrail new` runs, get the same flags. That command needs a POSIX `sh`, so on
  Windows install from the release's zip.

### Fixes

- Workspace reads refuse a path inside `.GIT`, in any case, on a case-sensitive
  disk too, as writes did.

## [0.1.1] - 2026-10-24

Security fixes from a review of 0.1.0, and fixes for long model replies.

- A Claude Code run without the Claude Agent SDK now says so: `run` and
  `console` print that Claude Code cannot ask before tools, with the command
  that installs the SDK beside Runrail and its npm page, and `doctor` and
  `HARNESS_SDK_MISSING` name the same command.
- `claude.sdk.status` and `claude.sdk.install` control methods, and
  `registerClaudeAgentSdkInstaller`, let a build download the SDK only after
  the person says yes.

### Security

- A repository's own git config no longer runs programs that Runrail's git
  calls missed: a signing-key command on commit, an alternate-refs command on
  a pull request fetch, and the hooks of a repository on this computer that a
  push goes to. Pushes no longer recurse into submodules.
- Workspace tools no longer read, list, find, or search `.git`, `.hg`, or
  `.svn`; agents use git commands instead. Agents' file tools never write
  `.nifra/extensions`, and Claude Code asks before editing it in every mode.
- Checkpoints leave out every file the workspace tools treat as a
  credential. `.env.example` and `.env.sample` are no longer snapshotted.
- A key variable no provider owns (for example `STRIPE_API_KEY`), named by a
  control caller, is sent only to a server on this machine.
- `runrail serve` refuses requests from a browser page and from DNS-rebound
  host names, as `runrail control` does.
- A plugin's state file is read without following links and within a size
  limit, and written by rename.
- The connector list reads the GitHub account from `gh config get`: no token
  is read and nothing goes over the network.

### Fixes

- Model streams no longer fail after 8,192 events. A long reply now ends at
  the stream's byte limit (16 MiB by default).
- A model request refused with 408, 425, 429, 5xx, or 529 before its reply
  starts is sent again, with backoff and `Retry-After`. A 429 for a used-up
  quota or billing is not.
- `/events` replays every retained event after the cursor before it turns
  live; events past the first `maxEvents` were skipped.
- Find and search walk breadth first and skip generated folders
  (`node_modules`, `dist`, and others) unless the walk starts in one or the
  pattern names it, so the project's own files are reached.
- `turn.enqueue` and `turn.steer` answers hold at most the turn's newest 4096
  events within 4 MiB, counting what was left out in `omittedEvents` and
  `omittedLive`; a repeated idempotency key keeps at most 16 KiB.
- A control server that fails to start releases what it started, and `stop`
  closes every part even when one fails.
- An instruction file linked to the workspace itself (`AGENTS.md -> .`) is no
  longer a failed session.
- Workflow calls find their project with a bounded asynchronous git call
  instead of a blocking one.
- The check for programs a repository's git config names is reused for up to
  5 seconds per folder, and checked again against the files git reads.
- The control contract advertises `sharing`: local, content-free share
  references. The sharing docs say what is built and what is not.

## [0.1.0] - 2026-10-16

First public release.

- A local-first native task engine with workspace policy, approvals, budgets,
  verification and repair, sessions, checkpoints, forks, and handoffs.
- `run` checks each turn with a command you name, or an installed `nifra check`
  in a Nifra project; `console`, `serve`, and `control` check only when asked.
- In a Nifra project, Runrail's own loop gets the `nifra mcp` tools, and Pi gets
  Nifra's instructions and tools; other projects get neither. `run` and
  `console` say so, `nifra.status` reports it, and `--no-nifra` or
  `RUNRAIL_NIFRA=off` turns it all off.
- `run` and `console` save each session (`--no-session` to skip): `--continue`,
  `--resume <id>`, and `--fork <id>` pick one up on its saved backend and
  model; `runrail sessions` lists them and `runrail export` prints one as
  JSON or Markdown.
- `runrail doctor` checks Bun, git, the coding tools and their sign-ins, the
  key store, and the folders Runrail writes, with no network call.
- `runrail new` starts an app from a starter: Nifra (the default), Vite, Next.js,
  or an empty folder.
- One capability-routed boundary for native Runrail, Codex, Claude Code (the
  Agent SDK is fetched on first use, never shipped), Pi, ACP agents such as
  Copilot, and a PTY JSONL harness.
- First-party OpenAI, Anthropic, OpenAI-compatible, and xAI/Grok providers,
  with caller-owned slots for Google, Vertex AI, Bedrock, and llama.cpp.
- Bounded native tools, an MCP server, skills, integrity-checked plugins,
  workflows, and caller-owned GitHub, Linear, Jira, and Slack connectors.
- An authenticated loopback control RPC that the Runrail desktop app drives.
- Built on the public Nifra 5.3.0 packages. Licensed AGPL-3.0-only with a
  section 7 permission for Anthropic's Claude Agent SDK (see NOTICE).
