# Command-line reference

`runrail <command> [options]`. From a checkout, run the same commands with
`bun run src/cli.ts <command>`, as the examples below do. `runrail --help` lists
the commands; the backends are `native`, `claude-code`, `codex`, `copilot`, `pi`,
`opencode`, `gemini`, `goose`, and `replay`.

## Pi pass-through

The pass-through command preserves Pi's arguments, stdio, providers, sessions,
extensions, skills, themes, and package ecosystem:

```sh
bun run src/cli.ts pi
bun run src/cli.ts pi --model openai/gpt-5 --session my-session
```

Set `RUNRAIL_PI_COMMAND` when the Pi-compatible executable is not on `PATH`.
This path intentionally uses Pi's own process and credential behavior; it does
not claim Runrail's native workspace policy is a sandbox around Pi.

## Pi extensions in native runs

Native Runrail can load an explicitly approved local Pi extension through
`PiExtensionHost`. Compatible tools, commands, shortcuts, lifecycle hooks,
provider adapters, flags, and data-only UI state participate in the native
session. Tools may use either the native `(input, context)` callback or the
Pi-compatible `(toolCallId, input, signal)` callback:

```ts
import { createPiExtensionHost, createRunrailSession } from "runrail"

const extensions = createPiExtensionHost({
  cwd: process.cwd(),
  trustedCapabilities: ["filesystem.read"],
})
await extensions.activate(".pi/agent/extensions/review.ts", { approvalGranted: true })
const session = await createRunrailSession({ cwd: process.cwd(), backend: "native", piExtensions: extensions })
```

Activation is never implicit and trusted in-process extensions have the same
OS permissions as Runrail. See [`docs/pi-extensions.md`](pi-extensions.md)
for the supported API and the exact boundaries where `runrail pi` remains the
full-fidelity path.

The same explicit `--pi-extension <path>` activation works in native
`run`, `console`, `control`, and `serve` modes. Reloads preserve the
last-known-good extension graph when a replacement fails.

## Run a task

Run one task without a terminal UI; `--json` prints the result as JSON:

```sh
bun run src/cli.ts run --backend native --cwd /path/to/workspace --json "fix the task"
bun run src/cli.ts run --backend pi --cwd /path/to/workspace --session-dir /tmp/runrail-sessions
bun run src/cli.ts run --backend replay --cwd /path/to/workspace
```

## Sessions

`run` and `console` save each session in its own folder under
`~/.runrail/sessions` (or `$RUNRAIL_SESSIONS_DIR`): a `session.json` with the
folder, the start time, and the routing flags, beside the conversation in
`transcript/<id>.jsonl`. The folders and files are readable by your user only.
The conversation is the prompts, replies, and tool calls in full, so treat the
folder as you would the project. `--no-session` saves nothing, and an explicit
`--session-dir` or `--session-id` leaves the session where you put it.

```sh
bun run src/cli.ts run --continue --cwd /path/to/workspace "and now the tests"
bun run src/cli.ts run --resume 3f6931c9 "carry on"
bun run src/cli.ts console --fork 3f6931c9 --cwd /path/to/other-checkout
bun run src/cli.ts sessions --cwd /path/to/workspace
bun run src/cli.ts export 3f6931c9 --format markdown --out session.md
```

- `--continue` (with `--cwd`) carries on the latest session saved for that
  folder; `--resume <id>` carries on that session, in its own folder;
  `--fork <id>` starts a new session from a copy of that one's conversation,
  in its folder or another `--cwd`. An id is the one `sessions` lists, or
  enough of its start to name one session.
- A continued session runs on the backend and model it last ran on: its
  routing flags (`--backend`, `--model`, `--provider*`, `--connection`,
  `--tool-connection`, `--thinking`, `--harness-*`, `--model-command*`) are
  saved and used again. Give any of them to choose a new route, which the
  session then keeps.
- Runrail's own loop is given the earlier messages themselves. Claude Code,
  Codex, and an ACP agent that can reload a conversation pick up their own.
  Pi, a fork, and a session resumed on another backend start the tool with a
  recap of the conversation so far.
- A saved session reads a behavior file only from `--config`, as a run with
  no saved session does.
- `sessions [--cwd <path>] [--limit <n>] [--json]` lists sessions newest
  first: id, last activity, backend, folder, and first message.
- `export <id> [--format json|markdown] [--out <file>]` prints the transcript
  bundle (the format `session.import` reads) or a readable copy. `--out`
  writes a new file, readable by you only, and never replaces one.

Run a deterministic local replay benchmark (reported provider cost stays unknown when no adapter reports it):

```sh
bun run src/cli.ts benchmark --repeats 3 --json
```

## Start a new app

`runrail new` creates an app from a starter, installs its packages, and makes the first commit:

```sh
runrail new ~/code/my-app
runrail new ~/code/my-app --starter vite
runrail new --list
```

| Starter | Made by | Runs |
|---|---|---|
| `nifra` (default, recommended) | the authors of Runrail | `create-nifra@5.8.0`: a full-stack site with React |
| `vite` | the Vite team | `create-vite@9.2.1 --template react-ts` |
| `next` | Vercel | `create-next-app@16.3.8` with the App Router, TypeScript, Tailwind CSS, and ESLint |
| `empty` | Runrail | nothing: an empty folder with a git repository |

Without `--starter`, the command says that it picked Nifra, who makes it, and how to pick another.
Each creator is fetched from npm at the version above and run by the Bun inside Runrail, so Bun need
not be installed. The folder name follows npm's rule for a package name (lowercase letters, digits,
`.`, `_`, and `-`). `--no-install` skips the install; `--json` prints one result object, and
`--list --json` the starters with the default. Next.js telemetry is turned off for the run.

## Providers and saved connections

Run a first-party provider through native Runrail. Credentials are referenced by environment name, never passed as raw CLI values:

```sh
bun run src/cli.ts run --backend native --cwd /path/to/workspace \
  --provider openai --provider-model gpt-4.1 \
  --provider-credential-env OPENAI_API_KEY --provider-allow-remote \
  "fix the task"
bun run src/cli.ts run --backend native --cwd /path/to/workspace \
  --provider anthropic --provider-model claude-sonnet \
  --provider-credential-env ANTHROPIC_API_KEY --provider-allow-remote \
  "review the task"
```

`--provider` also takes any preset id from the
[provider table](COMPATIBILITY.md#provider-presets), for example
`openrouter`, `deepseek`, or `groq`.

Run on a saved connection instead. The address, protocol, and key come from
the stored account, so nothing but the model is named on the command line:

```sh
bun run src/cli.ts run --cwd /path/to/workspace \
  --connection conn-openrouter --model vendor/model-id \
  "fix the task"
```

Connections are created through the control server (`account.create` and
`POST /secret`, or a sign-in through `auth.login.start`) and live in
`~/.runrail/accounts`. Use `--accounts-dir` and
`--credential-vault keychain|file|memory|none` to read them from somewhere
else.

`models --json` is offline. Use `models --discover --provider openai ...` only
when live model discovery is explicitly requested.

## Coding tools

Select a machine-readable Codex-compatible or Claude Code-compatible runtime:

```sh
bun run src/cli.ts run --backend codex --cwd /path/to/workspace \
  "inspect the task"
bun run src/cli.ts run --backend claude-code --cwd /path/to/workspace \
  "inspect the task"
```

With no custom command, Runrail drives Codex through its app-server protocol
(`codex app-server`) and Claude Code through Anthropic's Agent SDK when that
optional peer is installed, falling back to one
`claude --print --output-format stream-json --verbose` run per turn without it
(see `--harness-protocol` below), and translates their events. Command-backed harnesses use
subscription authentication by default: Runrail preserves the vendor CLI's
HOME-based login/session and does not require an API key. Sign in once with the
vendor CLI, then run the command through Runrail:

~~~sh
codex login
bun run src/cli.ts run --backend codex --cwd /path/to/workspace --harness-auth subscription "inspect the task"
~~~

GitHub Copilot runs the same way, through GitHub's own CLI after
`copilot login`, and Pi takes a model it is signed in to. OpenCode, Gemini CLI,
and Goose run through their own Agent Client Protocol modes with the provider
each is set up with; Runrail sets each to ask before it edits or runs a command
(see [`docs/harness-compatibility.md`](harness-compatibility.md)):

~~~sh
bun run src/cli.ts run --backend copilot --cwd /path/to/workspace --model <copilot-model> "inspect the task"
bun run src/cli.ts run --backend pi --cwd /path/to/workspace --model <provider>/<model> "inspect the task"
bun run src/cli.ts run --backend opencode --cwd /path/to/workspace --model <provider>/<model> "inspect the task"
~~~

## Sign-ins

Sign in to a provider from the command line with `runrail login <sign-in>`
(`runrail login --list` shows what is offered); `runrail logout <connection>`
removes the stored sign-in, and `runrail auth doctor <connection>` checks a
stored connection with one request and prints only a status and a stable
code. See [`docs/accounts.md`](accounts.md#sign-in).

## Coding tools with an API key

If a caller intentionally wants an API-key-backed CLI, credential forwarding is
opt-in and names are explicit. Values never appear in Runrail arguments,
events, evidence, or errors:

~~~sh
bun run src/cli.ts run --backend codex --cwd /path/to/workspace --harness-auth environment --harness-credential-env OPENAI_API_KEY "inspect the task"
~~~

Caller authentication is available through the library API with a caller-owned
resolver. Runrail never reads vendor token files or converts a ChatGPT
subscription into an OpenAI API credential. If `--harness-command` is supplied,
the custom command uses the documented Runrail JSONL stdin bridge; human
terminal output is not interpreted as agent events. Library callers can select
`promptMode: "argument"` for another vendor print/exec CLI.

The JSONL bridge includes a unique `requestId` and `turnId` on each prompt.
Persistent wrappers may echo `requestId` on output; mismatches fail closed,
while vendor-owned turn identities remain available through normalized events.

For a runtime that needs a real terminal, use the public `createPtyHarness`
factory. It accepts explicit argv, suppresses input echo, supports resize and
cancellation, and consumes only normalized JSONL events. PTY is intentionally a
library/harness option rather than a default CLI command because no runtime
executable is assumed.

The harness command must emit the documented JSONL event contract; human text
is never guessed into a tool action.

## MCP

Expose the bounded native workspace tools as an MCP stdio server:

```sh
bun run src/cli.ts mcp --cwd /path/to/workspace
```

Attach a caller-owned local MCP server to a native headless run:

```sh
bun run src/cli.ts run --backend native --cwd /path/to/workspace \
  --mcp-command /path/to/mcp-server --mcp-load-resources "inspect the task"
```

## Run options

Useful headless controls include:

- `--max-steps` (model steps per native turn, default 200), `--max-repair-attempts`, and `--verify check|assure|test`;
  `run` checks and repairs after a turn with `--verification-command`, or with an installed `nifra` when
  the workspace is a Nifra project (it names `nifra` or a `@nifrajs/` package, or has a Nifra config
  file); `console`, `serve`, and `control` do only with `--verify-after-turn` (or `--verification-command`);
- in a Nifra project, Runrail's own loop also gets the tools of the `nifra mcp` on PATH (its docs,
  examples, and types without asking; anything that runs or writes after approval), and a
  behavior-file MCP server named `nifra` replaces it. `run` and `console` print a line saying what
  Nifra adds. `--no-nifra`, or `RUNRAIL_NIFRA=off` in the environment, turns off every Nifra
  addition (the MCP tools, Pi's Nifra setup, and the default check); `RUNRAIL_NIFRA=on` turns them
  on in any project. See [Nifra in Runrail](../README.md#nifra-in-runrail);
- `control --checkpoints` snapshots the workspace before each turn into the session folder
  (`session.checkpoints.list`, `session.checkpoint.changes`), so a client can say what changed
  since a message and take the thread back to before it (`session.rewind`);
- `--session-dir` and `--session-id` for local evidence-backed sessions;
- `--pi-command`, repeated `--pi-arg`/`--pi-rpc-arg`, `--pi-system-prompt`,
  `--no-session`, `--no-pi-nifra-tools`, and `--pi-reload-command` for the Pi
  adapter. Pi gets Nifra's instructions and tools only in a Nifra project.
- `--skill-path` names skill files or folders, listed with the other skills and
  loaded on demand; `--user-skills` / `--no-user-skills` turn in-place reading
  of the user-wide skill folders on or off for that run; `--theme-path` loads
  bounded local theme sources;
- `--pi-extension <path>` explicitly activates a local Pi-compatible extension
  for a native run; repeat `--pi-extension-capability` to admit its declared
  capabilities. Activation is trusted and never implicit;
- `--mcp-command`, repeated `--mcp-arg`, and `--mcp-load-resources` attach an
  explicitly supplied MCP server to a native run;

- `--provider`, `--provider-model`, `--provider-credential-env`, and
  `--provider-allow-remote` configure first-party native providers without
  accepting raw API keys;
- `--connection <id>` with `--model` (and optional `--thinking`) runs on a
  saved connection; it cannot be combined with the `--provider*` options.
  `--accounts-dir` and `--credential-vault` say where connections are stored;
- `--tool-connection <id>` runs a coding-tool backend as a saved tool
  connection: it must be on and for that tool, a separate account or key
  connection runs in its own config folder with its stored key, and without
  `--model` its first chosen model is used;
- `--no-default-prompt` sends a provider session only the project context and
  your own instructions, without Runrail's default coding prompt (which names
  the working folder, git branch, OS, and date);
- `--approval-timeout-ms` refuses a native approval that has had no answer for
  that long (at most 86400000, one day); without it an approval waits until it
  is answered or its turn ends;
- `--max-reply-chars` caps the native model's reply in one turn (default
  1048576, from 256 to 16777216 characters); a reply longer than one event's
  text arrives as consecutive messages;
- `--continue-from-dir` with `--continue-from-session` (control only, with
  `--transcript-dir` and `--session-id`) starts a session as the continuation
  of a session kept in another transcript directory: its conversation is
  copied in the first time the session starts;
- `--harness-command` and repeated `--harness-arg` configure Codex-compatible
  and Claude Code-compatible machine-readable runtimes;
- `--harness-persistent` opts a caller-provided normalized JSONL harness into a
  long-lived process for multiple turns. It is an explicit opt-in: native
  Codex and Claude CLI defaults remain one-shot until the installed vendor
  protocol proves persistent controls;
- `--harness-protocol app-server` selects Codex's certified bidirectional
  `codex.app-server.v2` protocol: bounded persistent turns, approvals, restart
  resume, fork, model/thinking/sandbox settings, and streaming. It is the
  default for `--backend codex` when no command, argument, or protocol is
  given; `--harness-protocol jsonl` keeps one `codex exec --json` run per turn.
  The library default (`createCodexHarness()`) is still exec;
- `--harness-protocol sdk` runs Claude Code through Anthropic's Agent SDK: one
  long-lived `claude` process per session that asks before it edits or runs a
  command, so "Ask" and "Auto-edit" raise approvals instead of refusing.
  Interrupt also stops the background commands the turn started. It is the
  default for `--backend claude-code` when the SDK is there: downloaded with
  `runrail sdk install`, the optional peer `@anthropic-ai/claude-agent-sdk`
  installed beside Runrail, or registered by a build that bundles it with
  `registerClaudeAgentSdk`; `--harness-protocol print` keeps one
  `claude --print` run per turn. Asking for `sdk` without the SDK fails with
  `HARNESS_SDK_MISSING`. A Claude Code run or console on the usual route
  without it asks, on a terminal, whether to download it; otherwise, and not
  with `--json`, it prints on stderr that Claude Code cannot ask before tools,
  with `runrail sdk install` and the SDK's npm page. `runrail doctor` says the
  same. The SDK is Anthropic's, under its Commercial Terms; Runrail does not
  ship it (see [The Claude Agent SDK](#the-claude-agent-sdk));
- with `--backend codex` or `--backend claude-code` and no `--harness-command`,
  Runrail drives the installed CLI unmodified and forwards the thread's
  settings: `--model`, `--thinking`, and the behavior file's mode, permissions,
  and instructions become the CLI's model, effort, permission mode, and
  appended instructions. `--harness-effort low|medium|high|xhigh|max|ultra`,
  `--harness-permission-mode plan|ask|accept-edits|auto|bypass`,
  `--harness-append-system-prompt`, `--harness-resume <id>`, and (Claude Code
  only) repeated `--harness-mcp-config <path>` set them explicitly and win.
  With `--session-dir`, the CLI's own conversation id is kept beside the
  session, so a later engine process continues it. The CLI signs in by itself;
  Runrail never reads its credential or session files. A one-shot `run` cannot
  answer the tool's approvals, so it declines each one at once and names
  `--harness-permission-mode`; `--max-duration-ms` ends the run with
  `BUDGET_TIME_EXCEEDED` even when the tool ignores the cancel. Token, cost,
  and tool-call limits need the native backend and are refused here;
- `--harness-auth subscription|environment` selects vendor-session or explicit
  named-environment authentication; repeat `--harness-credential-env` only in
  `environment` mode;

## Inspect what is available

`doctor` checks this machine for Runrail without a network call or a key
read: the Bun version, git, whether the sign-ins and sessions folders can be
written, which key store is in use, each coding tool's version and sign-in
(from the tool's own commands), and the optional Claude Agent SDK. With
`--cwd` it also checks the project is a git repository. It exits 1 when
something must be fixed; `--json` prints the checks.

```sh
bun run src/cli.ts doctor --cwd /path/to/workspace
```

Inspect the locked native Pi compatibility matrix with no network access:

```sh
bun run src/cli.ts compatibility --json
```

See [`docs/pi-compatibility.md`](pi-compatibility.md) for the matrix,
refusal policy, benchmark contract, and native versus pass-through ownership.
See [`docs/plugin-compatibility.md`](plugin-compatibility.md) for the Pi
package adapter and explicit plugin migration rules.
`compatibility --json` also includes the generic harness matrix: the ACP
routes for Copilot, OpenCode, Gemini CLI, and Goose, and the caller-owned
candidate seams for Gemini CLI, OpenCode, Aider, and Goose.
See [`docs/release-certification.md`](release-certification.md) for the
metadata-only release gate and caller-owned certification checks.

```sh
bun run src/cli.ts providers --json
bun run src/cli.ts harnesses --json
```
List the shipped adapters and their capability manifests:

```sh
bun run src/cli.ts backends --json
```

Gemini CLI, OpenCode, Goose, and GitHub Copilot run as `--backend` routes
over their own Agent Client Protocol modes (above). Aider has no route yet: the
public harness registry keeps it, with the same four tools, as a conservative
candidate adapter that consumes a caller-supplied normalized JSONL wrapper and
does not claim to reverse-engineer a vendor's human-oriented CLI or private
protocol. Library callers can construct one with
`createCandidateHarness("gemini" | "opencode" | "aider" | "goose", options)`
or inspect all four with `createCandidateHarnessAdapters()`.

Third parties can publish an adapter without editing Runrail. Build a module
with `createHarnessAdapterModule(manifest, factory)` and register the returned
adapter with `HarnessRegistry`; manifest, capability, control, event, auth,
and security metadata are validated before admission. See
[`docs/harness-compatibility.md`](harness-compatibility.md) and
[`docs/harness-sdk.md`](harness-sdk.md) for the matrix and SDK contract.

## The Claude Agent SDK

Claude Code asks before it edits a file or runs a command only through
Anthropic's Claude Agent SDK. Runrail never ships it: its licence reserves all
rights, so you get it from npm under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).

```sh
runrail sdk install
runrail sdk status --json
```

`install` says what it downloads and where, asks first (`--yes` skips the
question, and without a terminal it downloads nothing unless given), and
downloads the version Runrail pins, refusing a download whose SHA-512 does not
match the pin. It goes in `~/.runrail/agent-sdk/<version>`, or
`$RUNRAIL_AGENT_SDK_DIR/<version>`, with the download kept beside its files.
Every load checks the kept download against the pin and each file against it,
so a file changed after the download is never loaded: `status` then reports it
not downloaded and `install` downloads it again. `status` says where the SDK
comes from (`downloaded`, `installed` beside Runrail, a build's `registered`
copy, or `installable` when it is not there yet). An SDK installed beside
Runrail (`bun add -g @anthropic-ai/claude-agent-sdk` next to a `bun add -g`
install) is used as before, without the download.

## Serve and control

Expose the authenticated, loopback-only session controls to a local UI or
client:

```sh
bun run src/cli.ts serve --backend native --cwd /path/to/workspace --port 0
```

`serve` provides the published Nifra-compatible RPC surface. For Runrail-native
queued turns, provider/harness selection, model switching, content-free transfer,
metrics, and plugin lifecycle controls, use the additional control surface:

```sh
bun run src/cli.ts control --backend native --cwd /path/to/workspace --port 0 --json
```

The control server emits one `control.ready` JSON handshake on stdout and exposes `/health` plus authenticated
`POST /rpc` methods such as `turn.enqueue`, `turn.steer`, `turn.cancel`,
`model.list`, `model.switch`, `provider.list`, `provider.discover`,
`provider.select`, `harness.list`, `harness.status`, `harness.negotiate`, `session.export`,
`session.import`, `session.transcript.export`, `session.transcript.import`,
`session.transcript.branch`, `session.transcript.compact`, `session.history`,
`session.context`, `metrics.snapshot`,
`backend.list`, `backend.switch`, `plugins.*`, `agent.list`, `agent.run`,
`agent.runMany`, `connector.list`, `connector.actions`, and `connector.invoke`.
Transcript methods are unavailable unless the caller explicitly supplies a
`TranscriptStore`; evidence remains content-free by default.
Remote binding is disabled by default and must be explicitly opted into by an
embedding application. Bearer tokens are compared in constant time and request
bodies are bounded.

The versioned desktop integration contract, event recovery algorithm, error
mapping, credential boundary, and runtime packaging status are documented in
[`docs/control-protocol.md`](control-protocol.md).
Desktop capability states, workspace controls, caller-owned transcripts, and
the optional terminal bridge are documented in
[`docs/control-desktop-capabilities.md`](control-desktop-capabilities.md).

## Evals with no desktop

Run a saved eval suite against setups from a terminal or CI. Each case's turns
run in this process, on each role's route, model, and access, and the results
land where Runrail Desktop lists them:

```sh
bun run src/cli.ts eval run --suite parser --setup solo --setup pair --cwd /path/to/project
bun run src/cli.ts eval list --cwd /path/to/project
```

`--case` (repeatable) picks cases, `--repeats` (1 to 5), `--parallel` (1 to 4),
and `--max-minutes` bound the run, and `--json` prints the final status. No one
is there to answer an approval, so a role works within its access and anything
beyond it is declined. The command exits 0 when every case ran, whatever the
score, and 1 when the eval stopped or failed; Ctrl-C stops it.

## Native bounded tools

The native backend provides a small coding loop through Nifra's public model
port:

- `read_file`, `list_files`, `find_files`, and `search_files`;
- approval-gated `apply_patch`, `write_file`, and exact `edit_file`;
- approval-gated `run_command` with explicit argv, filtered environment,
  timeout, cancellation, and bounded output; with `background: true` it
  returns an id at once (dev servers, watchers), read with `command_output`
  and stopped with `command_stop`;
- `run_verification` for a bounded Nifra gate.
- `update_plan` to publish the working plan to control clients.

Workspace paths are resolved under the selected root. Traversal, escaping
symlinks, sensitive credential files, oversized content, and unsafe process
inputs fail closed. Local processes still run with the invoking user's OS
permissions; add a container or OS sandbox for hostile code.

## Command models

A native run can use a caller-owned local model process:

```sh
runrail run --backend native --cwd /path/to/workspace \
  --model-command /path/to/model \
  --max-total-tokens 12000 "fix the task"
```

The command model receives one JSON request on stdin and emits JSONL records:
`text_delta`, `response`, `text`, or `tool`. This is a local adapter seam, not a
provider catalog or credential manager.

## Plugins

Manage local plugins:

```sh
runrail plugins --cwd /path/to/workspace list
runrail plugins --cwd /path/to/workspace install /path/to/plugin
runrail plugins inspect-pi /path/to/pi-package --json
runrail plugins migrate-pi /path/to/pi-package --json
runrail plugins --cwd /path/to/workspace test fixture-plugin \
  --capability fixture.command
runrail plugins --cwd /path/to/workspace configure fixture-plugin '{"enabled":true}'
runrail plugins --cwd /path/to/workspace rollback fixture-plugin
runrail plugins --cwd /path/to/workspace activate fixture-plugin \
  --capability fixture.command
runrail plugins --cwd /path/to/workspace deactivate fixture-plugin
```
