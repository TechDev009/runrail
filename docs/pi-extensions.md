# Pi extensions in Runrail

Runrail supports a native, versioned subset of Pi's `ExtensionAPI`. This is
separate from `runrail pi`, which remains the exact Pi escape hatch.

## Activation model

An extension is executable code. Runrail never scans a package or activates an
extension implicitly. A caller must:

1. resolve a local extension path inside the workspace;
2. construct `PiExtensionHost` with the capabilities it trusts; and
3. activate the file with `approvalGranted: true`.

`discoverPiExtensions(cwd)` can list candidate files under the conventional
`.pi/agent/extensions` and `.pi/extensions` directories. Discovery is
metadata-only; it never imports a file.

```ts
import { createPiExtensionHost, createRunrailSession } from "runrail"

const extensions = createPiExtensionHost({
  cwd: process.cwd(),
  trustedCapabilities: ["filesystem.read"],
})
await extensions.activate(".pi/agent/extensions/review.ts", { approvalGranted: true })

const session = await createRunrailSession({
  cwd: process.cwd(),
  backend: "native",
  piExtensions: extensions,
})
```

The host rejects paths outside the workspace, unsupported file types, missing
default factories, capability escalation, duplicate contributions, and
unapproved activation. Trusted in-process activation has the same operating
system permissions as the Runrail process; it is not a hostile-code sandbox.
Use an OS or container boundary when the extension source is not trusted.

## Supported Pi-style surface

The adapter currently supports:

- lifecycle and tool hooks: `input`, `before_agent_start`, `agent_start`,
  `agent_end`, `turn_start`, `turn_end`, `tool_call`, `tool_result`, session
  start/shutdown, reload, and compaction;
- `registerTool`, including capability declarations, approval requirements,
  cancellation signals, fail-closed tool-call blocking, and both the native
  `(input, context)` and Pi-compatible `(toolCallId, input, signal)` callback
  shapes;
- `registerCommand` with aliases and `registerShortcut` with Workbench command
  and hotkey registries;
- `registerFlag` and bounded flag values;
- `registerProvider` for Runrail-native model adapters or caller-owned provider
  descriptors;
- message, entry, and Markdown renderer registrations exposed to the shell;
- `registerUI` plus status, widget, header, footer, title, editor, theme,
  notification, select, confirm, and input state exposed through
  `uiSnapshot()` for the CLI and desktop shell;
- `sendMessage`, `sendUserMessage`, `appendEntry`, session naming, active-tool
  selection, and caller-supplied process execution callbacks;
- explicit host reload and deterministic activation/deactivation. A running
  native session captures its tool list at construction, so callers should use
  the session/controller refresh operation after a reload for newly registered
  tools to take effect.

The host snapshot is compatible with Runrail's existing plugin seam, so Pi
tools participate in native model calls, Pi commands participate in the
console, Pi shortcuts participate in the Workbench, and native provider
adapters participate in model selection. The same explicit extension host can
be attached to headless runs, the native console, and both authenticated RPC
servers with `--pi-extension`. Reload is staged before the active graph is
changed; if activation fails, the previous graph remains active. Controller
refresh then rebuilds the native model host so changed tools become visible to
the next turn.

## Extension shape

Pi's normal default-factory shape works without a package rewrite:

```ts
export const id = "review-tools"
export const capabilities = ["filesystem.read"] as const

export default function (pi) {
  pi.registerCommand("review", {
    description: "Run the review workflow",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Review started", "info")
    },
  })

  pi.registerTool({
    name: "review_note",
    description: "Record a bounded review note",
    capabilities: ["filesystem.read"],
    execute: async (input, ctx) => ({ cwd: ctx.cwd, input }),
  })
}
```

The adapter intentionally does not execute Pi terminal component factories,
raw provider stream handlers, OAuth implementations, or arbitrary package
dependency installers. Those are either represented by Runrail's data-only
desktop UI/provider seams, remain caller-owned, or continue to run through
`runrail pi` until a separately versioned compatibility contract is added.

## Parity statement

This provides native Pi-level extension points for the coding loop without
claiming arbitrary Pi package equivalence. The compatibility matrix therefore
classifies extensions as `adapter` and keeps package fetching, credentials,
hosted sharing, and unsupported Pi runtime internals outside Runrail's trust
boundary.
