# Pi compatibility policy

This document is the versioned compatibility contract for the native Runrail
surface and the `runrail pi` escape hatch. The locked target is Pi `0.84.1`
against Runrail `0.2.0`. A Pi upgrade creates a new matrix revision; it does
not silently expand this one.

The machine-readable matrix is available from the public
`createDefaultPiCompatibilityMatrix` API and from:

```sh
bun run src/cli.ts compatibility --json
```

## Classifications

Every feature has exactly one classification:

| Classification | Meaning |
| --- | --- |
| `native` | Runrail implements the behavior without invoking Pi. |
| `pass-through` | `runrail pi` preserves the behavior and Pi remains the owner. |
| `adapter` | Runrail maps the behavior through a provider, harness, or plugin seam. |
| `caller-owned` | Runrail exposes a bounded seam; credentials, hosting, or operation live outside. |
| `not-applicable` | The behavior is intentionally excluded with a recorded reason. |

`pass-through` is a supported product path, not a native parity claim. A
native row is not complete until its implementation, fixture, refusal behavior,
and documentation are verified.

## Native Runrail is the primary product

Pi compatibility is a behavioral benchmark and an explicit adapter boundary;
it is not the native Runrail extension contract. Native Runrail owns the
provider-neutral session, approval, verification, repair, budget, metrics,
MCP, connector, multi-agent, worktree, plan, handoff, sandbox, and plugin
surfaces. The Runrail plugin SDK may expose capabilities that do not exist in
Pi, and native shells must not be forced to reproduce Pi's private API or UI
internals.

`PiExtensionHost` exists for migration and interop with an explicitly approved
subset of Pi extensions. `runrail pi` remains the full-fidelity path for Pi
packages, provider accounts, interactive behavior, and undocumented Pi
internals. A green row in this document proves the user-visible behavior or
fallback is honest; it does not require the native engine to clone Pi's
implementation or package API.

## Matrix: Pi 0.84.1

| ID | Surface | Feature | Classification | Capability | Fixture | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.options` | CLI | CLI options | pass-through | `pi.cli` | `pi-cli-help` | verified |
| `interactive.editor` | interactive | Interactive editor | native | `pi.editor` | `pi-interactive-editor` | verified |
| `interactive.commands` | interactive | Interactive commands | native | `pi.commands` | `pi-interactive-commands` | verified |
| `interactive.hotkeys` | interactive | Interactive hotkeys | native | `pi.hotkeys` | `pi-interactive-hotkeys` | verified |
| `interactive.message-queue` | interactive | Message queue and steering | native | `pi.message-queue` | `pi-message-queue` | verified |
| `session.lifecycle` | SDK | Sessions and recovery | native | `pi.sessions` | `pi-session-lifecycle` | verified |
| `session.compaction` | SDK | Compaction | native | `pi.compaction` | `pi-session-compaction` | verified |
| `resource.context` | resource | Context files | native | `pi.context` | `pi-context-files` | verified |
| `resource.templates` | resource | Prompt templates | native | `pi.templates` | `pi-prompt-templates` | verified |
| `resource.skills` | resource | Skills | native | `pi.skills` | `pi-skills` | verified |
| `resource.extensions` | package | Extensions | adapter | `pi.extensions` | `pi-extension-adapter` | verified (compatible subset; arbitrary Pi internals remain pass-through/caller-owned) |
| `resource.themes` | resource | Themes | native | `pi.themes` | `pi-themes` | verified |
| `package.install` | package | Packages | adapter | `pi.packages` | `pi-package-adapter` | unavailable |
| `provider.protocols` | provider | Providers | adapter | `pi.providers` | `pi-provider-protocols` | verified |
| `provider.auth` | provider | Authentication | caller-owned | `pi.auth` | `pi-auth` | verified |
| `sdk.session` | SDK | SDK session API | native | `pi.sdk` | `pi-sdk-session` | verified |
| `rpc.events` | RPC | RPC and JSONL events | adapter | `pi.rpc` | `pi-rpc-events` | verified |
| `rpc.refusal` | RPC | Unsupported RPC refusal | adapter | `pi.rpc.refusal` | `pi-rpc-refusal` | verified |
| `session.import-export` | SDK | Import and export | native | `pi.transfer` | `pi-session-transfer` | verified |
| `sharing.remote` | SDK | Sharing | caller-owned | `pi.sharing` | `pi-sharing` | unavailable |
| `resource.discovery` | resource | Resource discovery | adapter | `pi.resources` | `pi-resource-discovery` | verified |

The fixture corpus is checked in at
`test/fixtures/pi-compatibility/0.84.1.json`. It contains only bounded argv,
event names, exit codes, refusal codes, and optional observation digests. It
does not contain prompts, model output, tool inputs, source files, credentials,
or transcripts.

## Black-box probe rules

Compatibility probes invoke a public executable or adapter boundary and return
only `pass`, `refused`, `failed`, or `cancelled` plus a bounded code and
duration. A thrown adapter error becomes `PROBE_THROWN`; its message is never
copied into evidence. Unknown protocol versions and unsupported capabilities
must refuse before activation.

The checked-in tests cover:

- successful CLI, RPC, SDK, resource, and package-shaped fixtures;
- explicit caller-owned and unsupported refusals;
- duplicate matrix and fixture identifiers;
- unsafe relative paths and unknown fields;
- malformed JSON, invalid observations, thrown probes, and cancellation.

`runPiExecutableProbes` additionally runs caller-supplied fixture executables
through an explicit argv boundary. It drains stdout and stderr under a byte
limit, optionally parses JSONL into event type names only, and reports stable
pass, refusal, failure, timeout, and cancellation outcomes. It never returns
child output, arguments containing payloads, or error messages.

## Benchmark contract

`PiBenchmarkReport` compares Pi and native Runrail on the same case, provider,
model, workspace digest, policy digest, and runtime environment. The contract
records startup, time to first token, time to first tool call, time to useful
change, wall time, token/cache counters, tool calls, repairs, and provider-
reported cost when available. Missing cost stays missing.

Reports contain metadata and measurements only. A prompt, tool payload,
transcript, source file, credential, or raw diagnostic is not a valid benchmark
field. A comparison refuses when the case or environment differs, preventing
unfair performance claims.

## Ownership and fallback

Pi owns its complete interactive UX, provider accounts, subscriptions, package
registry, and hosted sharing when the user chooses `runrail pi`. Runrail owns
neutral contracts and native local behavior. Provider credentials, durable
transcripts, retention, tenancy, billing, and hosted operations remain caller-
owned.
