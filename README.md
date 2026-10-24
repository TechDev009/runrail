<p align="center">
  <img src=".github/assets/runrail.png" alt="Runrail" width="88">
</p>

<h1 align="center">Runrail</h1>

<p align="center"><b>Verified agent runs, on rails.</b><br>
A local-first engine for coding agents: its own agent loop, or the coding tools you already use,<br>
behind one set of approvals, workspace rules, verification, and evidence.</p>

<p align="center">
  <a href="https://github.com/TechDev009/runrail/actions/workflows/ci.yml"><img src="https://github.com/TechDev009/runrail/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/TechDev009/runrail/releases/latest"><img src="https://img.shields.io/github/v/release/TechDev009/runrail?label=release" alt="Latest release"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%3E%3D1.3-000?logo=bun" alt="Bun >= 1.3"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://github.com/TechDev009/runrail-desktop">Desktop app</a> ·
  <a href="docs/cli.md">CLI reference</a> ·
  <a href="docs/library.md">Library API</a> ·
  <a href="docs/control-protocol.md">Control protocol</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Runrail runs coding agents on your own machine. Give it a repository and a task, choose who does
the work, and every run stays inside the same rails:

- **One engine, many agents.** Runrail's native loop runs on OpenAI, Anthropic, xAI, Gemini,
  OpenRouter, DeepSeek, Groq, and over 30 more providers known by name, or any OpenAI- or
  Anthropic-compatible server. It also drives Claude Code, Codex, GitHub Copilot, Pi, OpenCode,
  Gemini CLI, and Goose through their own protocols.
- **Your accounts stay yours.** Coding tools sign in with their own logins. API keys are
  referenced by environment name or kept in the system keychain, and never reach arguments,
  events, logs, or evidence.
- **Approvals and workspace rules that fail closed.** Edits and commands ask first unless you say
  otherwise. Paths cannot leave the workspace, credential files stay unreadable, and commands run
  with explicit arguments, a filtered environment, and a timeout.
- **Verify and repair.** After a turn, run a check, the tests, or your own command, and let the
  agent fix what fails within a bounded number of attempts.
- **Evidence without content.** A run leaves a record of what happened: steps, digests, and
  verification results, without prompts, code, or keys.
- **Built to embed.** A CLI, an authenticated local control server (what the
  [desktop app](https://github.com/TechDev009/runrail-desktop) drives), an MCP server, and a
  TypeScript library.

## Quick start

Runrail needs [Bun](https://bun.sh) 1.3 or newer and git, on macOS or Linux. Windows is
experimental.

```sh
bun add -g https://github.com/TechDev009/runrail/releases/download/v0.1.1/runrail-0.1.1.tgz
runrail --version
```

Or run it from a checkout, where `bun run src/cli.ts` takes the same arguments as `runrail`:

```sh
git clone https://github.com/TechDev009/runrail.git
cd runrail
bun install
```

Run a task with Claude Code doing the work, through your own Claude Code login:

```sh
runrail run --backend claude-code --cwd ~/code/my-app "explain how this project is structured"
```

A one-shot `run` cannot stop to ask, so it declines each edit or command the tool wants; pass
`--harness-permission-mode accept-edits` to allow edits. `runrail console` and the
[desktop app](https://github.com/TechDev009/runrail-desktop) ask as they go.

Or run Runrail's own loop, with a key read from the environment:

```sh
export ANTHROPIC_API_KEY=...
runrail run --backend native --cwd ~/code/my-app \
  --provider anthropic --provider-model <model> \
  --provider-credential-env ANTHROPIC_API_KEY --provider-allow-remote \
  "add input validation to the signup form"
```

Each `run` and `console` is saved, so you can pick it up again, on the same backend and model:

```sh
runrail run --continue --cwd ~/code/my-app "now add tests for it"
runrail sessions
runrail console --resume <id>
```

`--fork <id>` starts a new session from a copy of one, and `runrail export <id> --format markdown`
prints one to read or share. `runrail doctor` checks Bun, git, your coding tools and their
sign-ins, and where keys and sessions are kept.

Start a new app from a starter (Nifra by default, or `--starter vite|next|empty`):

```sh
runrail new ~/code/my-app
```

`runrail login --list` shows the browser sign-ins (ChatGPT, OpenRouter, and others); a saved
sign-in then runs with `--connection <id> --model <model>`. The
[CLI reference](docs/cli.md) covers every command and option.

## Who does the work

| Backend | What runs | Sign-in |
|---|---|---|
| `native` | Runrail's own loop and bounded tools, on any provider in the [provider table](docs/COMPATIBILITY.md#provider-presets) | an API key by environment name, or a saved connection |
| `claude-code` | Claude Code, through Anthropic's Agent SDK when present, else `claude --print` | your Claude Code login |
| `codex` | Codex, through `codex app-server` | your Codex or ChatGPT login |
| `copilot` | GitHub Copilot's CLI, over the Agent Client Protocol | `copilot login` |
| `pi` | Pi, with its providers, extensions, and packages | Pi's own |
| `opencode`, `gemini`, `goose` | each tool's Agent Client Protocol mode | each tool's own setup |
| `replay` | a deterministic replay, for tests and benchmarks | none |

Runrail drives each installed tool unmodified and forwards the thread's model, reasoning effort,
permission mode, and instructions. It never reads a tool's credential or session files, and never
turns a subscription into an API credential. `runrail pi` passes everything through to Pi
unchanged. See [harness compatibility](docs/harness-compatibility.md) and
[Pi compatibility](docs/pi-compatibility.md).

## How a run is kept on rails

```text
task --> backend (native loop or coding tool)
            |  every edit and command
            v
       workspace policy   paths, credential files, environment, timeouts
            |
       approvals          ask, auto-edit, plan, or full access; rules per tool
            |
       verification       check, tests, or your command; bounded repair turns
            |
       evidence           steps, digests, results; no prompts, code, or keys
```

- **Native tools.** Read, list, find, and search files; approval-gated patches, writes, and exact
  edits; approval-gated commands (also in the background, for dev servers); plans; and a
  verification gate. See [native bounded tools](docs/cli.md#native-bounded-tools).
- **Budgets.** Tokens, dollars, tool calls, and wall time, each with a hard stop.
- **Sessions.** Checkpoints before each turn, rewind, fork, branch, compaction, and hand-offs
  between runtimes as content-free packets.
- **Integrations.** MCP servers in both directions (and Nifra's own, in a Nifra project), skills
  from `.agents`, `.claude`, `.codex`, and `.pi` folders, integrity-checked plugins, multi-agent
  coordination with git worktrees, and GitHub, Linear, Jira, and Slack connectors whose writes ask
  first.

Local commands run with your user's permissions. Runrail contains mistakes, not hostile code:
add a container or OS sandbox for that. The [security model](docs/security-model.md) has the
details.

## Embed it

The desktop app talks to `runrail control`: an authenticated, loopback-only JSON-RPC server
with queued and steered turns, approvals, model and backend switching, transcripts, metrics, and
plugins. It prints one `control.ready` handshake and serves `/health` and `POST /rpc`:

```sh
runrail control --backend native --cwd ~/code/my-app --port 0 --json
```

The same pieces are a TypeScript library:

```ts
import { createRunrailSession } from "runrail"

const session = await createRunrailSession({ cwd: process.cwd(), backend: "native" })
```

See the [control protocol](docs/control-protocol.md), the
[desktop capabilities](docs/control-desktop-capabilities.md), and the
[library API](docs/library.md). Runrail is built on the public
[Nifra](https://github.com/nifrajs/nifra) 5.3.0 packages.

## Nifra in Runrail

[Nifra](https://github.com/nifrajs/nifra) is a TypeScript framework made by the authors of Runrail,
and Runrail is built on its packages. Runrail promotes Nifra in the places below and nowhere else.
Each says so when it is on, and each can be turned off.

| Where | What Runrail does | When | Turn it off |
|---|---|---|---|
| `runrail new` | Nifra is the default starter, marked recommended; the command names it and its maker before it starts | no `--starter` given | `--starter vite\|next\|empty` |
| Runrail's own agent | adds the tools of the `nifra mcp` on your PATH; docs, examples, and types run without asking, everything else asks first | a Nifra project, with `nifra` installed | `--no-nifra` or `RUNRAIL_NIFRA=off` |
| Pi | adds Nifra's instructions and tools | a Nifra project | `--no-nifra`, `RUNRAIL_NIFRA=off`, or `--no-pi-nifra-tools` |
| `runrail run` | checks each turn with `nifra check` and repairs what fails | a Nifra project, with `nifra` installed | `--no-nifra`, `RUNRAIL_NIFRA=off`, or your own `--verification-command` |

`run` and `console` print one line saying what Nifra adds to the session, and apps read the same
from `nifra.status`. A Nifra project is a folder that has a Nifra config file, or whose nearest
`package.json` depends on `nifra` or a `@nifrajs/` package or has a `nifra` setting. Runrail never
starts a `nifra` from inside your workspace, never installs one, and sends nothing about it to
anyone. `RUNRAIL_NIFRA=on` turns these on in every project.

## Documentation

| Topic | Where |
|---|---|
| Every command and option | [docs/cli.md](docs/cli.md) |
| Library exports | [docs/library.md](docs/library.md) |
| Providers, presets, and request differences | [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md), [docs/provider-matrix.md](docs/provider-matrix.md) |
| Sign-ins, connections, and the key vault | [docs/accounts.md](docs/accounts.md) |
| Coding-tool adapters and the harness SDK | [docs/harness-compatibility.md](docs/harness-compatibility.md), [docs/harness-sdk.md](docs/harness-sdk.md) |
| Control protocol and desktop capabilities | [docs/control-protocol.md](docs/control-protocol.md), [docs/control-desktop-capabilities.md](docs/control-desktop-capabilities.md) |
| Plugins, packages, and Pi extensions | [docs/packages.md](docs/packages.md), [docs/plugin-compatibility.md](docs/plugin-compatibility.md), [docs/pi-extensions.md](docs/pi-extensions.md) |
| Security model | [docs/security-model.md](docs/security-model.md), [SECURITY.md](SECURITY.md) |
| What exists today, and what is missing | [docs/feature-status.md](docs/feature-status.md) |
| Performance | [docs/performance.md](docs/performance.md) |

## Status

Runrail is at 0.1.1. These features pass their tests against stand-ins (a fake `gh`, mock
services) but have never run against the real thing. Expect rough edges, and
[report what breaks](https://github.com/TechDev009/runrail/issues):

- Posting pull request reviews and merging on real GitHub (`git.pr.review.post`, `git.pr.merge`).
- Connectors with a real service key (Jira, Linear, Slack, and others).
- Compaction driven from the desktop app.
- The phone and tailnet endpoints, and computer use, which the desktop app drives.
- Linux hosts with no keyring (no Secret Service on the session bus): keys and sign-ins are kept
  in a file vault that only your user can read, but in plain text, not encrypted.
- The unofficial xAI, Kimi, and Meta plan sign-ins (`runrail login <id> --accept-unofficial`):
  each presents that vendor's own command-line client id and has never been run against the
  vendor.
- Windows: the engine compiles for Windows inside the desktop app's build, but has never been
  run there.

## Development

```sh
bun install
bun run typecheck
bun test
```

`bun run test:isolated` runs every test file in a fresh process with a watchdog, for
reproducible release checks. `bun run test:packed` installs a packed Runrail with the published
Nifra artifacts and runs the external adapter example against it; put the Nifra 5.3.0 tarballs
in `/tmp/nifra-runrail-pack` or set `NIFRA_PACK_DIR`. `bun run source:check` rejects workspace
aliases and imports of unpublished or source-only Nifra code, and `bun run package:check`
validates the package manifest. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Runrail is free software under the [GNU Affero General Public License, version 3](LICENSE)
(AGPL-3.0-only), with an additional permission to combine it with Anthropic's Claude Agent SDK
(see [NOTICE](NOTICE)). You may use, modify, and redistribute it for any purpose, including
commercial work. If you distribute a modified version, or let others use one over a network, you
must offer them its source under the same license. The Agent SDK is never shipped with Runrail:
you install it from npm yourself (Runrail says how when it is missing), or Runrail Desktop
downloads it after you allow it, under Anthropic's own terms.
