# Release certification

Runrail exposes `certifyRelease` as a metadata-only release gate. It always
checks the pinned Pi compatibility matrix, then runs caller-supplied checks for
the packed consumer, credential-free suite, providers, plugins, harnesses,
connectors, or deployment profile.

```ts
import {
  certifyRelease,
  createDefaultHarnessCompatibilityMatrix,
  createDefaultPiCompatibilityMatrix,
} from "runrail"

const result = await certifyRelease({
  id: "runrail-release",
  version: "0.1.0",
  matrix: createDefaultPiCompatibilityMatrix(),
  harnessMatrix: createDefaultHarnessCompatibilityMatrix(),
  harnessValidation: {
    fixtureExists: () => true,
    verifyRow: () => true,
    verifyCapability: () => true,
  },
  checks: [
    { id: "packed-consumer", run: () => ({ status: "pass" }) },
    {
      id: "live-provider",
      required: false,
      run: () => ({ status: "unavailable", code: "CALLER_OWNED_PROVIDER" }),
    },
  ],
})
```

Results contain the release identity, check status, stable bounded codes,
elapsed time, and a digest bound to the validated compatibility matrix and
check outcomes. Probe errors, timeouts, prompts, model output,
tool payloads, credentials, and deployment diagnostics are not returned. A
required failed or unavailable check fails the result. An optional unavailable
check remains visible and is not counted as a successful check, but does not
block the overall result.

The certification contract does not run the repository's package manager,
deploy a service, or provision isolation. The embedding operator supplies
checks appropriate to its environment, for example `bun test`,
`bun run test:packed`, live subscription probes, or a caller-owned sandbox
probe. Planned or active harness rows fail the harness gate; caller-owned,
pass-through, and unavailable rows require a reason and fallback.

When `harnessMatrix` is supplied, `certifyRelease` also requires
`harnessValidation` with caller-owned `fixtureExists`, `verifyRow`, and
`verifyCapability` callbacks. The validator checks evidence without opening
fixture paths itself. This keeps release certification fail-closed while
leaving filesystem ownership and live vendor checks with the operator.

The default packed track runs `bun run test:packed`. It creates a temporary
Runrail tarball, installs it with the eight pinned Nifra 5.8.0 artifacts, and
executes the external adapter example through packed public exports.
