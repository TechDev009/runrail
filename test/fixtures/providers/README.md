# Provider fixture policy

Provider fixtures are local and deterministic. They may exercise protocol
mapping, usage, malformed events, cancellation, auth failure, and rate limits,
but must not contain live credentials or raw provider payloads in reports.
