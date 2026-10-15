# Changelog

All notable changes to Runrail will be documented here.

## [Unreleased]

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
