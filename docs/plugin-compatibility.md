# Plugin and Pi package compatibility

Runrail has three related but deliberately separate extension paths:

1. A Runrail plugin declares `runrail.plugin.json`, an API version, an entry
   module, integrity, capabilities, permissions, approval requirements, and a
   trusted or isolated execution mode.
2. A Pi package can be inspected through `PiResourceAdapter`. Its declared
   `extensions`, `skills`, `prompts`, and `themes` are discovered without
   importing or executing Pi extension code.
3. An explicitly approved local Pi extension can run through the versioned
   `PiExtensionHost` adapter. Its compatible tools, commands, shortcuts,
   lifecycle hooks, flags, providers, and data-only UI state become native
   Runrail contributions.

The second path is an adapter boundary. Discovering a Pi package does not
silently turn arbitrary Pi JavaScript into a trusted Runrail plugin.

## Compatibility matrix

| Pi package surface | Runrail behavior | Classification | Activation owner |
| --- | --- | --- | --- |
| `skills` | Discover declared files and expose them as bounded context resources. | adapter | Runrail policy and caller workspace |
| `prompts` | Discover declared files; callers may map them to prompt templates. | adapter | Caller session |
| `themes` | Discover declared files; a caller-owned UI may validate and load them. | adapter | Caller UI |
| `extensions` | Inspect without execution by default; explicit compatible files may activate through `PiExtensionHost`. | adapter | Explicit caller approval and trusted capability policy |
| Pi package registry/fetch | No implicit network access. | caller-owned | Caller source resolver |
| Pi provider/account packages | Use `runrail pi` for Pi-owned behavior or provide a Runrail provider adapter. | pass-through or adapter | Pi or caller provider pack |
| Pi RPC/JSONL package behavior | Use the strict harness/provider contracts when the package emits a supported machine protocol. | adapter | Runrail protocol boundary |

The compatibility target is Pi `0.84.1`. A Pi release change requires a new
compatibility matrix revision and fixture corpus; it cannot silently broaden
the adapter.

## Safe inspection

The public API is intentionally read-only at the Pi boundary:

```ts
import { PiResourceAdapter } from "runrail"

const bundle = await new PiResourceAdapter().discover("./local-package")
for (const entry of bundle.entries) {
  console.log(entry.kind, entry.path, entry.activation)
}
```

The same inspection is available locally without activating the package:

```sh
runrail plugins inspect-pi /path/to/pi-package --json
runrail plugins migrate-pi /path/to/pi-package --json
```

`migrate-pi` is read-only and adds an actionable migration plan. Skills,
prompts, and themes are reported as ready native resource actions. Extensions
are reported as `manual-review` with the next action to author a
`runrail.plugin.json` and entry module, or to keep using `runrail pi`. The
plan never includes resource contents or extension source.

Attempting `runrail plugins install` on a discoverable Pi package fails before
staging with `PLUGIN_PI_PACKAGE_REQUIRES_MIGRATION` and points to
`migrate-pi`. A Pi package cannot become an executable Runrail plugin merely
because its directory or archive was supplied.

This command reports the bounded manifest and resource metadata. It does not
install, fetch, import, or execute the package.

Inspection enforces bounded manifests, safe relative paths, package-contained
symlinks, regular files, deterministic ordering, and declared-resource
existence. It refuses malformed manifests, unsupported adapter versions,
traversal, escaping symlinks, missing resources, and excessive entry counts.

No prompt, source file, tool payload, credential, or extension output is
returned as compatibility evidence. The caller can read an admitted resource
through its own workspace policy and decide how it becomes transient context.

## Converting a package

To make a Pi extension available as a native Runrail plugin, a caller must
perform an explicit migration:

1. Copy or author a Runrail plugin manifest with a supported API version.
2. Declare the exact Runrail contributions, capabilities, permissions, and
   approval requirements.
3. Pin and verify the resulting package integrity.
4. Run the plugin test harness with fake model, tool, approval, and UI ports.
5. Admit trusted execution only when the caller accepts the requested policy;
   otherwise use isolated execution plus an explicitly supplied OS/container/VM
   boundary.

The migration must not broaden a Pi extension's authority. A plugin failure
cannot bypass native approvals, widen workspace access, or expose credentials.
Runrail's isolated worker is a process boundary, not a hostile-code sandbox.

## Installation and lifecycle

The local plugin manager supports explicitly supplied directories and local
tar/tgz/tar.gz archives. Installs are staged, integrity checked, and rolled
back on failure. Enable, disable, activate, deactivate, configure, test,
update, rollback, and remove are exposed through the local manager and the
authenticated control RPC.

A plugin's folder sits in the workspace, where a checkout can rewrite both its
files and the digest in its manifest. With `trustDir` (the CLI and control use
`~/.runrail/plugin-trust`), the manager records the digest of each plugin it
installs, updates, or rolls back, per workspace, and refuses to activate or
test a plugin whose digest is not the recorded one
(`PLUGIN_INTEGRITY_MISMATCH`). A plugin folder that arrived with the workspace
is listed but not activated until it is installed again.

Remote registry, Git, URL, package dependency resolution, signing-key
management, and credential storage remain caller-owned. They must enter
through a source resolver and must not be added to Runrail's default path.

## Verification

The checked-in tests cover:

- Pi resource discovery and deterministic ordering;
- malformed, unsupported, missing, traversal, and symlink-escape packages;
- Runrail manifest and integrity validation;
- trusted and isolated plugin activation;
- plugin resource projection into transient context;
- archive traversal and checksum rejection;
- lifecycle rollback and configuration validation.

The package adapter intentionally reports a refusal or caller-owned path when
it cannot prove compatibility. It never guesses an extension API mapping.
