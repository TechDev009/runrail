# Native Runrail capability matrix

This is the source of truth for the standalone Runrail product. It is separate
from the Pi compatibility matrix. Pi is an optional pass-through and migration
adapter; native rows must not depend on Pi APIs, Pi packages, or Pi UI behavior.

The machine-readable matrix is exported by
`createDefaultNativeCapabilityMatrix()` and validated by
`parseNativeCapabilityMatrix()`.

## Status meanings

- `verified`: deterministic native behavior and rejection coverage exist.
- `active`: the native contract exists and implementation work is in progress.
- `planned`: not yet started; it cannot be advertised as available.
- `caller-owned`: Runrail owns the seam and the caller owns operation or authority.
- `unavailable`: explicitly refused with a stable reason and fallback.

## Current matrix

| ID | Owner | Surface | Classification | API | Status | Fallback/authority |
| --- | --- | --- | --- | --- | --- | --- |
| `task.kernel` | engine | Task lifecycle | native | `native.task/1` | verified | Session APIs remain compatible while task projection expands. |
| `coding.loop` | engine | Coding loop | native | `native.session/1` | verified | Native bounded tools and approval policy. |
| `verification.repair` | engine | Verification and repair | native | `native.verification/1` | verified | A verifier the caller names (`verificationCommand` or `RUNRAIL_NIFRA_COMMAND`) must run, and a turn fails when it cannot. The default `nifra` gate is optional: when it is not installed, or the workspace is not a Nifra project (no `nifra` or `@nifrajs/` dependency, `nifra` setting, or Nifra config file), the check after each turn is skipped. `verifyAfterTurn: true` runs an installed `nifra` in any workspace, and `verifyAfterTurn: false` turns the check off. A spent repair budget fails the turn. |
| `orchestration.plans` | engine | Plans and goals | native | `native.plan/1` | verified | Bounded orchestration runner. |
| `orchestration.agents` | engine | Agents and handoffs | native | `native.agents/1` | verified | Child agents run on the native loop only, within the parent's capabilities, depth, and workspace; another backend is refused. |
| `integration.mcp` | engine | MCP | adapter | `native.mcp/1` | verified | Caller supplies the MCP server and transport. In a Nifra project the `nifra mcp` on PATH starts too, unless `nifra: false` (or `RUNRAIL_NIFRA=off`) or the behavior file names its own `nifra` server. `session.nifraUse()` and `nifra.status` report what Nifra adds. |
| `integration.connectors` | engine | Connectors | adapter | `native.connector/1` | verified | Caller or Host supplies accounts and service operation. |
| `extensions.native` | engine | Native extensions | native | `native.extension/1` | active | Trusted/isolated Runrail plugins; declarative UI only. |
| `packages.native` | engine | Native packages | native | `native.package/1` | active | Local install resolves dependencies into a lockfile and checks pinned signers; remote registry sources and running package code are planned. |
| `accounts.native` | engine | Accounts and auth | native | `native.account/1` | active | Desktop Keychain or caller broker; no secret persistence. |
| `providers.native` | engine | Provider protocols | adapter | `native.provider/1` | verified | Provider-specific auth enters through native account references. |
| `sharing.local` | engine | Local sharing | native | `native.share/1` | active | Local-only operation remains available if sharing fails. |
| `sharing.hosted` | Host | Hosted collaboration | native | `host.task/1` | planned | No Runrail Host service exists yet; sharing is local only. |
| `desktop.cockpit` | Desktop | Native task cockpit | native | `desktop.task/1` | active | CLI/control RPC remain usable without Desktop. |
| `hosting.operation` | Host | Hosted operation | native | `host.control/1` | planned | No first-party hosted operation exists yet; an operator runs `runrail serve` with its own TLS and hosting. |
| `sandbox.isolation` | operator | Strong isolation | caller-owned | `native.sandbox/1` | caller-owned | Caller supplies an OS/container/VM executor. |

## Native-first rule

Runrail can compare behavior against Pi and can translate a bounded Pi subset,
but native implementation is judged by the Runrail contract. A feature is not
complete because `runrail pi` supports it. It is complete when the native task
model, control surface, shell projections, and rejection behavior are verified.
