# Library API

Runrail's package entry point exports the pieces the CLI and the desktop app are
built from:

```ts
import { createRunrailSession, RunrailSessionController, startRunrailControlRpcServer } from "runrail"
```

## Exports

- `createRunrailSession` / `RunrailSession` for prompts, reload, checkpoint,
  compaction, fork/branch/clone, history, approvals, content-free transfer,
  model switching, and close;
- Native Runrail contracts (`src/native`) define versioned task events, idempotent commands, extension/package manifests, account references, share bundles, and the native capability matrix. These are Runrail-owned contracts, not Pi API clones.
- `createNativeTaskKernel`, native task stores, and replay journals provide restart-safe metadata, bounded event cursors, and command idempotency. `createNativeLockfile` and `resolveNativePackageGraph` provide reproducible package graphs; account brokers and local share bundles keep secrets and payloads outside metadata evidence.
- `RunrailSessionController` and `startRunrailControlRpcServer` for queued and
  steered turns, cancellation, backend/model switching, live events, metrics,
  and plugin controls;
- `createBackendRegistry` / `createDefaultBackendRegistry` and `routeBackend`
  for deterministic adapter selection and fail-closed capability admission;
- `createModelCatalog`, `ProviderCatalog`, and the first-party OpenAI,
  Anthropic, OpenAI-compatible, and xAI/Grok adapters provide native model
  execution. Credential resolvers keep account secrets transient and caller-owned;
- `HarnessRegistry` and the Pi, Codex-compatible, and Claude Code-compatible
  adapters provide explicit runtime selection and strict machine-readable event
  mapping; candidate adapters and `createHarnessAdapterModule` extend the same
  public boundary without private Nifra imports;
- `RunrailPlanRunner` for declarative sequence, parallel, retry, branch,
  approval, verification, checkpoint, handoff, and bounded-subagent plans;
- `createPortableHandoff` / `parsePortableHandoff` for content-free progress
  packets between runtimes;
- `McpClient`, `McpStdioTransport`, and `McpHttpTransport` for explicit
  caller-owned MCP servers; tools, resources, and prompts bridge into native
  Runrail contracts with bounds, cancellation, and approval metadata;
  Remote `readOnlyHint` annotations never grant approval-free authority. Supply
  caller-owned `readOnlyTools: ["inspect"]` in the MCP bridge or each configured
  server to admit named tools under a Read integration grant. Other tools ask
  for approval; destructive/open-world hints still require it by default.
- `MultiAgentCoordinator` and `AgentProfileRegistry` for bounded parallel
  delegation, retries, per-agent capabilities, session-backed executors, and
  content-free handoffs;
  `maxChildren` admission is coordinator-wide, including overlapping batches.
  Session-backed children enforce admitted native tool capabilities independently
  of parent approval, intersecting any parent `allowedToolCapabilities` ceiling.
  `read`, `write`, and `exec` map to filesystem read, filesystem write, and
  process execution; unclassified tools are omitted. Unsupported external or
  caller-owned backends fail with `TOOL_CAPABILITIES_UNSUPPORTED_BACKEND`.
- `SkillRegistry` / `createDefaultSkillRegistry` for local `.agents/skills`,
  `.claude/skills`, `.codex/skills`, `.pi/skills`, and explicit sources with
  deterministic precedence and transactional reload. The conventional folders
  are shared with other tools, so a folder with a `SKILL.md` is one skill,
  frontmatter fields other than `id`, `name`, and `description` are ignored,
  and a file that is not a valid skill is left out (`skipped()` names it by
  path and code) instead of failing the session. Explicit sources stay strict.
  The model sees a bounded catalog of ids and descriptions and loads a body
  with the `skill_read` tool or a leading `/skill:<id>` in the prompt;
  `userSkills` (or `skills.userRoots` in the behavior file) also reads the
  user-wide skill folders in place;
- `ConnectorRegistry` and bounded HTTP factories for GitHub, Linear, Jira, and
  Slack expose caller-owned reads, searches, notifications, and approval-gated
  writes without embedding credentials;
- `PtyAgentBackend` / `createPtyHarness` provide explicit Bun PTY transport,
  resize, cancellation, echo suppression, and strict normalized JSONL handling;
- `SandboxRegistry` and `negotiateSandbox` require an explicitly supplied
  isolated OS, container, VM, or caller executor when a task needs isolation;
- `createHostingProfile` validates loopback and remote TLS/auth deployment
  profiles for embedding applications;
- `CommandAgentBackend` and `HttpAgentBackend` for generic caller-owned local
  JSONL and remote/A2A-compatible event transports;
- `LocalGitWorktreeManager` for bounded local leases that can back subagents;
  pull requests and hosted Git services remain caller-owned;
- `RunrailIntegrationBundle`, `integrationRequirements`, and adapter integration
  hooks make MCP, skills, plugins, connectors, and caller tools capability-aware
  across native and external runtimes;
- `startRunrailRpcServer` for the authenticated local RPC surface.

Handoff packets contain digests, progress IDs, a caller-owned opaque workspace
reference, safe relative paths, artifact references, and verification status.
They do not retain objectives,
acceptance text, prompts, transcripts, model output, tool payloads, credentials,
or raw diagnostics.

## Architecture

```text
Runrail CLI / API
       |
       +-- BackendRegistry -> native | Pi | Codex | Claude Code | replay | caller adapters
       |
       +-- RunrailSession -> Nifra host -> backend-neutral AgentBackend
       |                         |
       |                         +-- sessions, compaction, extensions, RPC
       |                         +-- approvals, verification, repair
       |
       +-- RunrailPlanRunner -> Nifra bounded orchestration host
       +-- content-free routing, evidence, and portable handoff contracts
```

An adapter only needs to implement the published Nifra `AgentBackend` contract
and declare its capabilities. The Codex, Claude Code, Copilot, and other
coding-tool adapters use this seam, and a remote or A2A adapter would too.
Vendor credentials and SDKs stay outside Runrail core: the Claude Agent SDK is
an optional peer that is fetched on first use, never shipped.

## More native surfaces

- `ProviderCatalog` and `RoutedModelPort` provide first-party OpenAI,
  Anthropic/Claude, OpenAI-compatible, and xAI/Grok-compatible model adapters.
  `createCallerOwnedProviderModelAdapter` wraps a caller-supplied Google,
  Vertex, Bedrock, llama.cpp, or other provider-neutral model port without
  moving its transport or credentials into Runrail. `runrail models --json` is
  offline; `--discover` is explicit and bounded. Provider credentials are
  resolved transiently from an environment reference or caller resolver and
  are never stored by Runrail.
- `runrail run` accepts bounded token, dollar, tool-call, and duration budgets.
  `RunrailMetrics` reports aggregate usage, latency, repairs, and cache hits.
  `ModelCache` is an optional caller-owned, non-evidence cache hook.
- `runrail console` provides a native raw-terminal workbench with multiline
  editing, history, cursor movement, scrollback, live streamed rendering,
  resize, interrupt/cancellation, queued turns, approvals, backend/model
  switching, bounded resources, themes, and diff review. Non-TTY callers use
  the readline fallback; deterministic embedded callers can inject terminal
  keys.
- Explicit context resources load selected instruction files, system prompts,
  templates, skills, and themes. Prompts can expand bounded `@file` references
  and image references; image input is rejected unless the selected model
  declares `multimodal` support. Context reload remains in memory, outside evidence.
- `createPluginManager` manages explicitly supplied local plugin directories.
  `runrail.plugin.json` declares compatibility, capabilities, permissions,
  approval, contributions, configuration shape, execution mode, and SHA-256
  integrity. Install, update, rollback, remove, enable, disable, activate,
  deactivate, reload, configure, and test are available without contacting a
  package registry. A caller-owned configuration store can preserve settings
  across manager reloads without putting them in Runrail evidence.
- `runrail plugins migrate-pi /path/to/pi-package --json` produces a read-only
  migration plan. Skills, prompts, and themes get native actions; extensions
  remain manual-review/caller-owned. Installing a discoverable Pi package
  fails closed with `PLUGIN_PI_PACKAGE_REQUIRES_MIGRATION` until the caller
  authors an explicit Runrail plugin or uses `runrail pi`.
- Trusted plugins activate through the public SDK only after capability and
  permission admission. Isolated plugin entries use the public Nifra extension
  worker's default-factory module shape and expose bounded tool invocation.
  Neither mode is a hostile-code sandbox; use an OS or container boundary when
  stronger isolation is required.
- Session evidence can be exported and imported as content-free identity
  packets. Branch and clone aliases use the existing bounded fork contract.
- Caller-owned transcript stores recover an interrupted final JSONL append
  before a session resumes; complete malformed records still fail closed, and
  recovery reports only bounded counts and byte totals.
  File stores reject linked roots/files and non-regular files, make appended
  files private (`0600`), and check file size before allocation. Total transcript
  bytes are capped at the lesser of configured entry/count limits and 128 MiB.
  These local filesystem checks are not a hostile concurrent-filesystem sandbox.
- `createCommandModelPort` supports a caller-owned local JSONL model process
  with filtered environment, cancellation, timeout, output bounds, and typed
  response parsing. Use `--require-capability` for fail-closed backend
  admission and `--model-capability` when declaring a command model's support.
- `runrail benchmark --repeats N [--json]` runs bounded deterministic replay
  cases. Its schema reports useful results, success, duration, steps, repairs,
  cache counters, usage counters, and only adapter-reported cost; unknown cost
  is omitted rather than fabricated.
- The certification harness validates first-party OpenAI, Anthropic,
  compatible/Grok, Pi, Codex-compatible, Claude Code-compatible, remote, and
  A2A-compatible fixtures without provider access. Results are metadata-only and
  never retain prompts or raw payloads.
- `certifyRelease` combines the locked Pi matrix with caller-supplied packed,
  credential-free, provider, plugin, and deployment checks. It returns only
  bounded statuses, stable codes, and a digest; unavailable optional checks
  stay explicitly unavailable rather than becoming unsupported claims.
- Plugin sources accept explicit directories and bounded `.tar`, `.tgz`, and
  `.tar.gz` archives with path, size, file-count, checksum, and integrity
  validation. Remote/package fetching remains caller-owned.

These surfaces are independent of Pi but composable with it. `runrail pi ...`
still owns Pi's full interactive TUI, provider credentials, subscriptions,
package ecosystem, and themes. Native Runrail independently supplies the common
coding loop, provider adapters, approvals, verification, repair, orchestration,
routing, integrations, and content-free evidence without importing Pi internals.
