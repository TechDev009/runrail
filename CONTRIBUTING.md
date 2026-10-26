# Contributing to Runrail

Thanks for helping improve Runrail. The project is local-first and adapter-
oriented, so changes should preserve clear boundaries and reproducible
verification.

## Development setup

Requirements:

- Bun 1.3 or newer.
- A checkout of Runrail.
- Published Nifra `5.8.0` packages, installed by `bun install`.

```sh
bun install
bun run typecheck
bun test
```

For packed-consumer work, provide the eight Nifra `5.8.0` tarballs outside the
repository and run:

```sh
NIFRA_PACK_DIR=/tmp/nifra-runrail-pack bun run test:packed
```

## Change guidelines

- Keep the public seam provider-neutral.
- Import Nifra only through published `@nifrajs/*` package exports.
- Do not import Nifra source files or unpublished packages.
- Fail closed on path, capability, approval, and environment-policy failures.
- Parse untrusted inputs instead of casting them.
- Keep prompts, tool inputs, credentials, and raw payloads out of persisted
  evidence and logs.
- Keep local processes clearly documented as non-sandboxed.
- Add or update tests with behavior changes.
- Keep adapter metadata deterministic and handoff packets content-free.

Runrail runs on the user's machine and has no hosted service: no server-side
accounts, queues, tenancy, or billing, and a change should not add one.
Credentials are referenced or kept in the system keychain, never stored in
evidence. Pi-specific UX stays in the Pi compatibility path.

Use plain ASCII hyphens in code, comments, and documentation, and add a code
comment only where the code cannot say why on its own.

## Pull requests

Pull requests should explain:

1. the user-facing behavior;
2. the security and authority boundaries involved;
3. the tests or verification commands run; and
4. any compatibility or migration impact.

Before opening a pull request, run:

```sh
bun run typecheck
bun test
```

Check [docs/feature-status.md](docs/feature-status.md) before changing what a
feature does, and keep it current when a change adds or removes one. A
user-facing change also gets a line under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md), and a new command or option belongs in
[docs/cli.md](docs/cli.md).

If the change touches package boundaries or published imports, also run the
packed-consumer check.

## Releases

A maintainer tags a version that matches `package.json` and has a CHANGELOG.md
section (`git tag -a v0.1.2 -m "Runrail 0.1.2"`), and pushes the tag. CI builds
the `runrail` executables on each platform they are for and runs each one,
then collects them with the package, `install.sh`, and `SHA256SUMS.txt` into a
draft release. Publishing the draft runs
[publish.yml](.github/workflows/publish.yml), in the `publish` environment: it
puts the release's package on npm through Trusted Publishing, with provenance
(a prerelease under the `next` tag), and writes the Homebrew formula to
`TechDev009/homebrew-runrail` with the `HOMEBREW_TAP_TOKEN` secret (not for a
prerelease). `bun scripts/build-binaries.ts --smoke` builds and checks the
executables locally.

## Nifra changes

Nifra is a separate repository. A Runrail change must not modify Nifra. If a
missing public Nifra seam is discovered, document the request and coordinate
the change in the Nifra repository first.
