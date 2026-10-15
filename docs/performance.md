# Performance and cost methodology

Runrail makes performance claims only from a reproducible comparison. The
comparison contract is implemented by `PiBenchmarkReport` and
`comparePiBenchmarkReports`.

## Required identity

Pi and native Runrail reports must share:

- case identifier and workspace digest;
- runtime, operating system, and architecture;
- provider and model;
- tool and approval policy digest.

Reports that differ in any identity field are refused as a mismatch. This
prevents a faster model, smaller workspace, or weaker policy from being
reported as a harness improvement.

## Measurements

The report may contain startup latency, time to first token, time to first tool
call, time to useful change, wall time, input/output tokens, cache reads and
writes, tool calls, repair attempts, and provider-reported cost. Missing values
remain missing. Runrail never estimates or fabricates provider cost.

Compatibility probes and benchmark reports retain only bounded metadata. They
do not retain prompts, model output, tool arguments, source files, credentials,
or transcripts.

`runPiBenchmarkCases` runs a matched caller-owned Pi function followed by a
Runrail function for each case, measures wall time at the harness boundary,
and refuses mismatched identities. A caller can use the same API around a
fixture executable or live adapter without giving Runrail ownership of the
task payload. Thrown runner errors and cancellation become stable codes.

## Deterministic and live tracks

The deterministic track uses replay fixtures and is required for CI. It checks
schema, bounds, mismatch refusal, cancellation, and stable terminal outcomes.

The live track is caller-owned. It may invoke a Pi executable and a native
provider adapter with the same explicit workspace, model, provider, and policy.
Live credentials and provider accounts never belong in CI or checked-in
fixtures. A live result is useful only when its environment metadata and
fixture identity are recorded alongside the report.

## Release policy

Regression thresholds are introduced only after the baseline corpus is stable.
A threshold can block a release only for the same case and environment. A
successful run with a lower success or verification rate is not an improvement
even when it is faster or cheaper.
