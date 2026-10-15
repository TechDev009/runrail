# Runrail agent instructions

Runrail is a standalone consumer of public `@nifrajs/*` packages. Nifra is a
separate repository and must not be modified from this repository. Runrail must
never import Nifra source files or unpublished packages.

## Commands

- `bun install` installs the pinned public package versions.
- `bun run typecheck` runs the TypeScript check.
- `bun test` runs unit, conformance, and E2E tests.
- `bun run test:packed` verifies imports from packed Nifra artifacts.
- `bun run src/cli.ts pi ...` preserves Pi's native interactive command.
- `bun run src/cli.ts backends --json` lists native, Pi, Codex, Claude Code,
  replay, and caller-supplied backend capabilities.
- `bun run src/cli.ts providers --json` lists first-party provider protocols
  without network access.
- `bun run src/cli.ts harnesses --json` lists first-party harness descriptors.
- `bun run src/cli.ts models --json` lists the deterministic native model.
- `bun run src/cli.ts models --discover --provider openai ...` explicitly
  discovers bounded provider model descriptors.
- `bun run src/cli.ts plugins --cwd <path> list` manages local plugins.
- `bun run src/cli.ts control --backend native --cwd <path>` starts the native control RPC.
- `bun run src/cli.ts serve --backend native --cwd <path>` starts the
  authenticated loopback RPC surface.
- `bun run src/cli.ts run --backend replay --cwd <path>` runs deterministic replay.
- `bun run src/cli.ts run --backend native --cwd <path>` runs the deterministic
  model by default; use `--provider` and `--provider-model` for first-party
  OpenAI, Anthropic, compatible, or xAI/Grok execution.
- `bun run src/cli.ts run --backend pi --cwd <path>` starts the public Pi adapter.
- `bun run src/cli.ts run --backend codex|claude-code --cwd <path>` starts a
  strict machine-readable harness adapter.
- `bun run src/cli.ts benchmark --repeats 2 --concurrency 2 --json` runs deterministic replay benchmarks.
- `bun run src/cli.ts mcp --cwd <path>` serves the bounded native tool catalog over MCP stdio.
- Library-only PTY support is available through `createPtyAgentAdapter` and
  `createPtyHarness`; no PTY executable is assumed by CLI defaults.
- Caller-owned service connectors are available through the public GitHub,
  Linear, Jira, and Slack factories with explicit remote opt-in.
- `SandboxRegistry` and `createHostingProfile` validate supplied isolation and
  hosting boundaries; they do not provision containers or remote services.

During development against an unpublished Nifra checkout, pack Nifra packages
to a directory outside both repositories and install those tarballs into a
temporary consumer. Do not add workspace aliases or direct imports to Nifra
`src/` files. Release tests must be runnable without the Nifra checkout.

The packed-consumer runner expects `NIFRA_PACK_DIR` (default:
`/tmp/nifra-runrail-pack`) containing the pinned Nifra tarballs.

## Boundaries

- Keep public seams provider-neutral and authority-bounded.
- Fail closed on path, capability, approval, and environment-policy failures.
- Parse untrusted inputs instead of casting them.
- Do not persist prompts, tool inputs, credentials, or raw payloads as evidence.
- Local processes are not hostile-code sandboxes.

Runrail is an independent universal harness. Pi owns its provider, interactive,
and package UX through the transparent pass-through, but native Runrail also
ships first-party OpenAI, Anthropic, OpenAI-compatible, xAI/Grok, Codex-compatible,
and Claude Code-compatible adapters. Provider accounts and credentials remain
caller- or desktop-owned; they are referenced ephemerally and never persisted.
Runrail exposes MCP client/server bridges, bounded multi-agent coordination,
local skill discovery, caller-owned connector actions, provider/harness registries,
generic command/HTTP adapters, and optional local git worktree leases.


## Inherited engineering rules

These rules are the applicable subset of the local Claude and Codex defaults for
this repository:

- Build production-grade, secure-by-default code from the first line.
- Parse every untrusted CLI, RPC, plugin, package, model, filesystem, and
  environment value at the boundary. Do not rely on unchecked casts.
- Compare bearer tokens, signatures, and other secrets with constant-time
  comparison. Never log credentials, prompts, raw tool payloads, or PII.
- Authorization, capability, ownership, path, environment, approval, and other
  security gates fail closed. Use stable error codes and bounded results.
- Keep TypeScript strict, avoid swallowed errors and floating promises, and add
  regression tests for fixes plus rejection tests for security guards.
- Keep command output bounded.
- Do not deploy, migrate, publish, or push without explicit authorization in
  the same turn.
- Public additions must remain provider-neutral. Do not import unpublished
  packages or copy details of other products or infrastructure.
- Use plain ASCII hyphens in code, comments, documentation, artifacts, and user
  facing text.
