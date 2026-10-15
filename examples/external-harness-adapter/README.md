# External harness adapter

This example is intentionally outside `src/`. It uses only the public
`runrail` package exports and demonstrates the third-party adapter seam:

```ts
import { createExternalHarnessAdapter } from "./index.ts"

const adapter = createExternalHarnessAdapter("my-agent", ["--jsonl"])
console.log(adapter.descriptor)
```

The caller supplies the executable, credential boundary, process policy, and
isolation. Runrail validates the manifest and exposes only the declared
normalized JSONL contract.
