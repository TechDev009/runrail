# Native Runrail sharing and collaboration

Sharing is a native Runrail protocol, not a Pi feature clone. Local coding
works without a Host service; hosted collaboration is an optional first-party
deployable that does not exist yet.

## Available today

Only local, content-free share references work. The control server's
`sharing` capability means exactly this:

- `share.create` makes a reference to a task: its id, owner, mode, cursor,
  revision, and expiry, plus a bundle of the task digest and the artifact
  references the caller names (path, digest, size). No transcript, prompt, or
  file content goes into either.
- A payload other than `none` is refused with `SHARE_CRYPTO_REQUIRED` (409).
  No encryption, key reference, or retention is implemented, so neither
  `encrypted-invite` payloads nor `artifact-only` encrypted artifacts can be
  shared. The `mode` is stored on the reference and changes nothing else.
- `share.advance`, `share.revoke`, `share.bundle`, and `share.events` work
  for the owner on this machine. The control token is the only identity, and
  it acts as the owner.
- `share.grant` stores a grant (subject, role, expiry) and `share.grants`
  lists them, for the future Host service. Nothing reads them: no check
  admits or refuses anyone by a grant, so a grant gives no one access.

Everything else below describes the protocol's target, not shipped behavior.

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
protocol will add identity, durable storage, enforced access grants,
encrypted payloads, retention, quotas, and audit without changing local task
semantics.
