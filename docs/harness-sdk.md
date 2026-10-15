# Third-party harness SDK

Runrail adapters can be built outside the repository using the public harness
SDK. The SDK validates a versioned manifest before the adapter is registered.
It does not install dependencies, fetch code, resolve credentials, or grant
permissions implicitly.

## Manifest

```ts
import { createHarnessAdapterModule } from "runrail"

const adapter = createHarnessAdapterModule({
  manifestVersion: 1,
  id: "my-agent",
  name: "My agent",
  apiVersion: "1.0",
  adapterVersion: "1.0.0",
  runtimeVersion: "caller-installed",
  protocolVersion: "my-agent.jsonl/1",
  kind: "custom",
  classification: "adapter",
  features: ["sessions", "streaming"],
  capabilities: ["sessions", "streaming"],
  controls: ["follow-up", "cancel", "inspect", "close"],
  events: ["lifecycle", "assistant", "failure"],
  authModes: ["caller"],
  security: ["caller-process", "bounded-jsonl"],
}, ({ cwd }) => createBackendForCaller(cwd))
```

The adapter must expose only capabilities that are actually implemented.
Runrail checks this when it creates the backend: a backend that advertises a
capability the manifest does not declare is refused, and so is a request for an
undeclared feature. The `security` list is labels for readers; Runrail does not
interpret it. The registry rejects invalid identifiers, unsupported API major versions, unknown
features, unknown controls, unknown event families, malformed auth metadata,
and invalid capability names.

## Extension rules

Persistent adapters must declare control authority explicitly. A long-lived
process alone does not grant resume, fork, compaction, model, sandbox, MCP, or
approval controls. The public persistent backend accepts caller-owned control
handlers for those operations, and the caller must advertise only the handlers
that are proven by its selected protocol.

- Use explicit argv and bounded output.
- Keep credentials as references and resolve them transiently.
- Map vendor events to the Runrail event protocol without returning raw vendor
  diagnostics in evidence or stable errors.
- Implement cancellation and terminal events before advertising streaming.
- Add deterministic fixtures for normal, malformed, oversized, cancelled, and
  failed streams.
- Ship a matrix row with runtime version, protocol version, fixture, security
  notes, status, and fallback.

The normalized JSONL prompt envelope carries a unique `requestId` and `turnId`
for every turn. A persistent wrapper may echo `requestId` on each output
record; a mismatch is rejected before event mapping. Event-count and output-byte
limits bound the in-memory queue, and a second active turn is refused.

## Packed public-artifact check

The maintained external example is in
`examples/external-harness-adapter/`. It imports only `runrail`, uses the
`my-agent.jsonl/1` protocol namespace, and supplies its own command and process
authority. `bun run test:packed` packs Runrail, installs that artifact beside
the pinned published `@nifrajs/*` tarballs, registers the example through
`HarnessRegistry`, and runs one normalized JSONL turn. The check does not use a
sibling Nifra checkout.

Run `bun run source:check` before publishing. It fails on workspace or link
aliases, private package imports, and direct Nifra checkout/source imports.

Remote sources, signing, dependency resolution, registries, and marketplace
behavior are caller-owned integrations. A manifest is not a sandbox: trusted
in-process code and isolated workers require an operator-supplied execution
boundary and explicit capability admission.
