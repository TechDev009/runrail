# Native Runrail sharing and collaboration

Sharing is a native Runrail protocol, not a Pi feature clone. Local coding
works without a Host service; hosted collaboration is an optional first-party
deployable.

## Modes

- `local-export` - content-free task identity and artifact references;
- `encrypted-invite` - opt-in encrypted transcript/artifact payloads;
- `read-only-live` - bounded event replay for reviewers;
- `collaborative` - authorized steering, approvals, and task ownership;
- `artifact-only` - selected encrypted artifacts without task control.

## Invariants

- Content-free metadata is the default. Payload-bearing sharing requires an
  encryption contract, key reference, retention, and explicit scope.
- Every shared mutation has an actor, authorization, idempotency key, expected
  revision, and bounded event cursor.
- Revocation is immediate for new commands and is represented as a durable
  status transition.
- Cursor loss causes bounded re-sync; it never silently skips task events.
- Concurrent steering, approvals, branch creation, and ownership changes fail
  with a stable conflict result and cannot duplicate side effects.
- Host storage receives encrypted payloads or digests, not raw secrets. Logs and
  audit records contain metadata only.

`createShareReference`, `advanceShareCursor`, `revokeShare`, and
`createContentFreeShareBundle` are the local reference primitives. The Host
protocol will add identity, durable storage, access grants, retention, quotas,
and audit without changing local task semantics.
