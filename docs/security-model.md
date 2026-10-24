# Runrail security model

Runrail is a local-first harness with bounded policy surfaces. It is not an
automatic hostile-code sandbox, hosted tenancy system, credential vault, or
durable work tracker.

## Trust boundaries

- The selected workspace is resolved and checked for traversal, sensitive
  files, and escaping symlinks before native tools read or write.
- Native commands use explicit argv, filtered environment values, bounded
  output, timeout, cancellation, and approval policy.
- Provider credentials are references resolved ephemerally by the caller. Raw
  keys are rejected from CLI and RPC input and are not persisted in evidence.
- Command-backed harnesses default to vendor subscription/session auth. Only
  HOME, PATH, locale, terminal, and CI context are inherited by default;
  credential environment names must be explicitly allowlisted. Caller-owned
  resolvers are transient and their values are never included in stable errors,
  events, evidence, or certification output.
- The Codex app-server adapter uses bidirectional JSON-RPC with bounded request
  correlation, thread/turn identity checks, event and output limits, drained
  stderr, explicit approval responses, and fail-closed unsupported requests.
  Restart resume is explicit and vendor thread IDs never replace Runrail session
  IDs. The adapter does not treat the Codex process as a sandbox.
- Plugin manifests are parsed, integrity checked, capability admitted, and
  staged before activation. Isolated workers still require a supplied OS,
  container, or VM boundary for hostile code.
- MCP, connector, harness, and remote-agent actions are caller-owned and must
  declare capabilities, approval, endpoint, and result bounds.
- In a Nifra project, Runrail starts the `nifra mcp` found on PATH, never a
  binary inside the workspace, and fetches nothing. Only the tools Nifra marks
  read-only run without approval. `--no-nifra` or `RUNRAIL_NIFRA=off` turns it off.
- `runrail new` fetches the chosen creator from npm at a pinned version and runs
  it, then installs the app's packages: the same trust as running that creator
  yourself. It runs with the filtered environment plus proxy settings.
- The folder Runrail starts in does not configure it: its `.env` files and
  `bunfig.toml` (whose `preload` would run that folder's code inside Runrail)
  never load, in the release executables, in the npm or Bun install, in the
  copies Claude Code starts as MCP servers, or in the creator `runrail new`
  runs from the parent folder. A checkout run as `bun src/cli.ts` is a plain
  Bun script and does load them; run `src/cli.ts` itself, or run it from the
  checkout with `--cwd`. On Windows, the Bun processes Runrail starts skip only
  the `.env` files.
- Control RPC binds to loopback by default and requires a bearer token. Remote
  operation requires an embedding application to opt into a separate TLS and
  authentication deployment profile.
- Public evidence is metadata-only. Payload-bearing transcripts are available
  only through an explicitly supplied caller-owned `TranscriptStore`.
- The `run` and `console` commands supply one: each session's conversation is
  kept under `~/.runrail/sessions/<id>` (`RUNRAIL_SESSIONS_DIR`), in folders
  and files only the user can read (0700 and 0600). `--no-session` keeps
  nothing. A saved session records its routing flags, which name connections
  and environment variables but never hold a key.
- Transcript restart recovery validates the intact JSONL prefix and discards
  only a non-newline-terminated final record; malformed complete records remain
  fail-closed. Session startup and the explicit recovery control return counts
  and byte totals, never payloads.
- Release certification returns only bounded statuses, stable codes, and a
  digest. Thrown probe errors, timeouts, prompts, tool payloads, credentials,
  and deployment diagnostics are not copied into certification evidence.

## Fail-closed rules

Malformed manifests, events, paths, capabilities, credentials, endpoints,
approvals, and protocol versions are refused before activation or side
effects. Unknown versions do not silently downgrade. Cancellation and timeout
produce terminal states and do not revive a completed parent or replay a
non-idempotent action.

## Operator responsibilities

The caller owns provider accounts, secret injection, retention, durable queues,
identity, tenancy, external service permissions, archive signing keys, and
real process isolation. The caller must review plugin code and connector
actions before granting permissions. Runrail provides contracts, policy gates,
fixtures, and evidence boundaries; it does not claim to provision these
operator systems.

The caller-owned sandbox seam was certified with Docker 29.6.1 and the local
`alpine:3` image using a read-only root, a writable workspace bind, no network,
capability dropping, and bounded resources. The probe confirmed workspace
write, blocked root escape, blocked network access, and cleanup. This validates
the supplied executor contract only; Runrail does not bundle or operate Docker.
