# Security policy

Runrail is a local coding-agent harness. It is not a hostile-code sandbox,
and local tools execute with the permissions of the invoking operating-system
user.

## Reporting a vulnerability

Please do not report a suspected vulnerability in a public issue. Report it
privately through GitHub's
[private vulnerability reporting](https://github.com/TechDev009/runrail/security/advisories/new).
A problem in the desktop app goes to
[its own advisories](https://github.com/TechDev009/runrail-desktop/security/advisories/new).

Include:

- the affected version or commit;
- a concise reproduction;
- impact and required permissions;
- any suggested mitigation.

You can expect an acknowledgement within a week. Please allow reasonable time to
investigate and release a fix before public disclosure; reporters are credited in
the advisory unless they ask not to be.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Scope notes

The project treats the following as security-sensitive:

- workspace escape and symlink traversal;
- capability or approval bypass;
- credential or secret propagation;
- unbounded subprocess, output, or evidence behavior;
- protocol events that widen authority or expose private payloads.

The absence of a sandbox is documented behavior, not a vulnerability in itself.

## Operational boundaries

- `runrail pi` is a transparent Pi process. Pi's own provider credentials,
  extensions, tools, and subprocess behavior remain in force; Runrail's native
  workspace policy does not wrap that process.
- Native OpenAI, Anthropic, compatible, and xAI/Grok adapters use only an
  ephemeral credential resolver or named environment reference. Raw API keys
  are rejected from CLI arguments, RPC parameters, and persisted evidence.
- Provider endpoints are loopback-safe by default. Non-loopback endpoints need
  explicit remote opt-in and HTTPS unless an explicit insecure exception is
  supplied. Request, response, stream, retry, and cancellation bounds apply.
- Sign-ins send Runrail's own name and never another product's editor or CLI
  headers. The three plan sign-ins that borrow a vendor tool's public client
  id (xAI, Kimi, Meta) live behind the opt-in `runrail/auth-vendors` entry,
  are marked unofficial, and are refused by `runrail login` until the person
  accepts that. GitHub Copilot is reached only through GitHub's own CLI.
- A session on a provider sends that provider more than the prompt. The
  default coding prompt names the working folder's full path (which usually
  contains the account's user name), the git branch, how many files have
  uncommitted changes, the OS, and the date; `--no-default-prompt` leaves it
  out. Project instruction files are sent as they are. Earlier tool calls and
  their results in the thread are sent on every later request, and after a
  model switch they go to the newly chosen provider too, rebuilt from the
  local transcript. Pick a provider for a thread knowing it receives the
  thread's history.
- Sealed reasoning from a Responses endpoint is held in process memory only
  and is sent back only to the endpoint that produced it.
- The `serve` command binds to loopback by default and requires a bearer token.
  Embedders must explicitly opt into remote binding and provide their own
  network, identity, and tenancy controls.
- Project extensions are executable code. Load them only from repositories the
  invoking user trusts; the extension loader is not a hostile-code sandbox.


## Native parity boundaries

- Local plugins are admitted only after manifest, API version, capability,
  permission, approval, configuration, and SHA-256 integrity checks. Trusted
  plugins run in-process only after explicit admission. Isolated plugins use a
  bounded public worker, but neither mode is a hostile-code sandbox.
- Plugin package sources are explicit local directories or bounded `.tar`/`.tgz`
  archives with traversal and tar-checksum validation. Runrail does not contact
  a package registry or persist provider credentials. A caller-owned
  configuration store may persist plugin settings outside Runrail evidence.
- Command-backed models receive a filtered environment containing only the
  approved process variables. Requests and responses are transient; Runrail
  does not write them to session evidence or logs. Model processes still run
  with the invoking user's operating-system permissions.
- The native control RPC binds to loopback by default, bounds request bodies,
  compares bearer tokens in constant time, and returns stable error codes. A
  caller that enables remote binding must supply the surrounding network,
  identity, authorization, and tenancy controls.
- Session export/import contains event identity and pin metadata only. Prompts,
  tool inputs and outputs, model text, credentials, and raw diagnostics are
  deliberately excluded.
- MCP stdio servers are explicitly spawned caller-owned processes with filtered
  environments. MCP HTTP endpoints require loopback by default or explicit
  remote opt-in; authentication headers remain caller-owned and in memory.
- Codex-compatible and Claude Code-compatible adapters accept only bounded,
  machine-readable JSONL events. Unknown events, sequence gaps, terminal events
  after completion, and capability mismatches fail closed; human-readable output
  is never interpreted as a tool request.
- External MCP, skill, plugin, connector, and caller-tool integrations require
  an advertised capability and explicit adapter integration hook. Native policy
  is not silently claimed to govern an external process.
- MCP, connector, and agent results are transient. Control RPC connector and
  agent methods require authenticated access; connector capabilities and write
  actions fail closed without authorization and approval.
- Agent worktree leases are bounded and path-checked. Local processes and
  worktrees are not hostile-code sandboxes; use an OS or container boundary for
  stronger isolation.
- Background work (`background.*`) is reported by id only. Stop reaches a
  process only through its source: the process group Runrail itself spawned for
  a `run_command {background: true}`, or the coding tool's own API. The list of
  listening servers comes from the engine's own descendants and is never
  signalled. Command labels and details are redacted and kept in memory, never
  in the task journal, transcripts, evidence, or logs. A Claude Code task's
  output is read only from the file that tool announced for that task, after
  its real path resolves to a regular file under the system temp directory.
- Browser use (`--browser-tools`) is off unless the control process is started
  with it, and reaches pages on this computer only unless `--browser-any-site`
  is also given. The engine never touches a page itself: a `browser.request`
  live frame carries only an id and an action, the desktop claims it once with
  `browser.take`, checks the address against its own copy of the switch, and
  asks the person before every `browser_eval`. Page text reaches the model
  marked as untrusted. Answers are bounded (64 KiB of text; an image only for a
  screenshot, at most 900 KiB of base64). Claude Code's MCP server calls
  `POST /browser` with a separate random token that opens no other route; that
  token and the engine's address sit in a `0600` file inside a `0700` temp
  folder removed when the engine stops, never on a command line. Requests and
  answers are kept in memory only, never in the task journal, transcripts,
  evidence, or logs.
- The PTY backend suppresses input echo so JSONL prompt bytes are not parsed as
  events, but a PTY is still an invoking-user process boundary, not isolation.
- GitHub, Linear, Jira, and Slack factories use transient resolver credentials;
  read retries are restricted to idempotent requests and all writes require
  capability admission plus approval.
- `SandboxRegistry` refuses isolation-required requests unless a caller-supplied
  executor advertises `isolated: true`. `createHostingProfile` refuses remote
  profiles without TLS and authentication.
