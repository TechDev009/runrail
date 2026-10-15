# Native Runrail packages

Native packages are Runrail packages, not Pi packages. A package is activated
only after its native manifest, dependency graph, integrity, lockfile,
capabilities, permissions, platform constraints, and approval policy pass.

## What the native manager does today

1. Install from a local directory inside the workspace, without executing code.
   Archives are not read by the native manager; the separate plugin source
   resolver handles plugin archives.
2. Parse `NativePackageManifest` and reject unknown fields, unsafe entries, and
   unsupported API versions.
3. Stage the package, verify its digest over every file, and keep the previous
   verified copy for rollback.
4. Resolve the package's dependencies against the packages already installed
   and any candidates the caller passes (`resolveNativePackageGraph`), and
   write the deterministic lockfile (`runrail.lock.json`) beside the packages. A dependency that no
   installed package or candidate satisfies fails the install; nothing is
   fetched to satisfy it.
5. Record activation: it checks approval, the trust mode the caller allows, and
   that the package is enabled, then marks the package active. Activation does
   not load or run the package's code.

## Planned

- Running an activated package's code, behind a bounded admission probe and only
  while the task is idle.
- Opt-in remote registry, npm, Git, and URL sources, with registry metadata
  immutable by digest and mutable tags resolved into a lockfile before
  activation. Today the path is offline and local only.

## Trust rules

- A package cannot request undeclared capabilities or permissions.
- A dependency cannot widen authority without a new admission decision.
- A package cannot write outside its admitted workspace or access credentials
  without an explicit account/broker reference.
- A worker process is not a hostile-code sandbox. Strong isolation requires a
  supplied OS, container, VM, or remote executor.
- Package telemetry contains metadata only; no prompts, source payloads,
  credentials, or model output are sent to a registry by default.
