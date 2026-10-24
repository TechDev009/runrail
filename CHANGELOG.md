# Changelog

All notable changes to Runrail will be documented here.

## [Unreleased]

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

### Security

- The executables never load a `.env` or `bunfig.toml` from the folder they
  start in: a project's `bunfig.toml` can name a `preload` script, which would
  run inside Runrail.

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
