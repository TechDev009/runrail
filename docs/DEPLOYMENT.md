# Runrail deployment and isolation

Runrail ships local control RPC and embedding contracts. This repository does
not deploy services, provision cloud accounts, or operate a hosted control
plane.

## Local control server

The safe default binds an authenticated control RPC server to loopback:

```sh
bun run src/cli.ts control --backend native --cwd /workspace --port 0
```

Use `LOOPBACK_HOSTING_PROFILE` or `createHostingProfile` to describe the
embedding deployment. Loopback HTTP is acceptable when the listener is not
exposed beyond the host, but the bearer-authenticated control surface remains
required.

For the desktop process contract, readiness parsing, durable event recovery,
scope rules, credential handling, and the current Bun packaging limitation,
see [`control-protocol.md`](control-protocol.md) and
[`control-desktop-capabilities.md`](control-desktop-capabilities.md).

## Remote or hosted control

An embedding application placing Runrail behind a reverse proxy or container
ingress must validate an explicit profile before starting the server:

```ts
const profile = createHostingProfile({
  id: "production-edge",
  version: "1.0.0",
  kind: "reverse-proxy",
  hostname: "runrail.example",
  port: 443,
  allowRemote: true,
  tls: "terminated-proxy",
  auth: "caller",
  durableState: true,
  sandboxId: "caller-container",
})
```

Non-loopback profiles require explicit remote opt-in, TLS, and authentication.
The surrounding proxy owns identity, authorization, tenancy, rate limits,
request logging policy, and certificate management. Runrail request bounds do
not replace proxy authorization.

## Strong isolation

Local processes, plugins, PTYs, worktrees, and command agents run with the
invoking user's authority unless the caller supplies a real OS, container, VM,
or remote executor. Register the executor and require isolation at admission:

```ts
const executor = createCallerSandboxExecutor(containerDescriptor, runInContainer)
const sandbox = createSandboxRegistry([executor]).select({ requireIsolation: true })
```

`SandboxExecutor` is the integration point for Docker, Podman, Firecracker,
macOS sandboxing, a platform sandbox, or an enterprise runner. The executor
owns filesystem mounts, network policy, resource limits, cleanup, and hostile
code isolation. Runrail only validates the descriptor, request, result, and
fail-closed requirements. Credentials, billing, retention, and tenancy remain
deployment-owned; secret values must not appear in hosting profiles, RPC
requests, session exports, evidence, benchmarks, or logs.

The caller-owned seam was exercised on 2026-09-26 with Docker 29.6.1 and the
local `alpine:3` image. The bounded probe used a read-only root, writable
workspace bind, no network, dropped capabilities, and resource limits; it
confirmed workspace writes, blocked a root escape, blocked network access, and
cleaned up. This certifies the supplied executor, not a Runrail-provided
sandbox.

## Verification

Before embedding a release, run:

```sh
bun install --frozen
bun run typecheck
bun test
bun run test:packed
```

Deployment, migration, publication, and external-service activation are
separate operator actions and are intentionally not performed by this project.
