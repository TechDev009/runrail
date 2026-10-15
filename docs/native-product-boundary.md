# Native Runrail product boundary

Runrail is a standalone coding-agent product. Pi compatibility is an optional
adapter and migration path, not a prerequisite for native feature completion.

## Engine

The engine owns:

- task/session/turn state and replayable control events;
- native tools, approvals, policy modes, verification, repair, budgets, and metrics;
- plans, goals, bounded agents, worktrees, handoffs, and recovery;
- native extensions, package manifests, lockfiles, integrity, and activation;
- provider-neutral account references and credential-broker contracts;
- local share bundles and the hosted-task protocol;
- CLI, control RPC, MCP bridges, and bounded local reference implementations.

Prompts, model output, tool payloads, credentials, and PII remain out of
metadata-only evidence. Payload-bearing transcripts and artifacts require an
explicit caller or product store.

## Desktop

Runrail Desktop owns the human product layer:

- project and thread navigation;
- task timeline, composer, plans, approvals, tools, diffs, terminal, and proof of work;
- Keychain-backed account setup and OAuth/browser handoff;
- native package discovery, install, update, rollback, and trust review;
- local share, hosted collaboration, revoke, reconnect, and offline fallback;
- accessibility, keyboard navigation, crash recovery, and visual quality.

Desktop consumes the authenticated native control protocol. It does not import
engine source or private Nifra packages.

## Runrail Host

Runrail Host is a separate deployable service for features that need durable
operation across machines:

- package registry metadata and immutable package blobs;
- identity, access grants, task ownership, collaboration, and audit;
- encrypted transcript/artifact storage with retention and deletion;
- event cursors, reconnect, quotas, rate limits, and key rotation;
- provider/account references and billing integration hooks.

The host is optional for local coding. Local tasks must continue to work when it
is unavailable. The host never receives raw secrets or unredacted telemetry by
default.

## Pi boundary

`runrail pi` remains a transparent escape hatch for users who want Pi's own
interactive process, providers, account behavior, packages, and undocumented
internals. `PiExtensionHost` and the Pi resource adapter translate only a
bounded compatibility subset. They must not define native Runrail concepts or
block native package, account, UI, sharing, or collaboration work.

## Security invariants

- Every capability has an owner and an explicit admission check.
- Remote access requires explicit opt-in, TLS, authentication, authorization,
  and bounded bodies.
- Package code is never executed before integrity, dependency, capability, and
  approval checks pass.
- Local processes and trusted workers are not hostile-code sandboxes.
- Strong isolation requires a supplied OS, container, VM, or remote executor.
- Secret values never enter arguments, event journals, evidence, transcripts,
  package metadata, logs, or share metadata.
