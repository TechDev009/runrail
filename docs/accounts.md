# Native Runrail accounts

Native Runrail uses provider-neutral account references. Accounts are metadata;
secret values live only in a credential vault (OS keychain or a private file),
an ephemeral caller broker, or a named environment resolved at execution time.

## Account reference

An account reference contains an account ID, provider ID, auth mode, scopes,
optional environment name, and bounded timestamps. It may also carry non-secret
endpoint settings: `preset`, `baseUrl` (https, or plain http only for this
machine and the local network), and extra `headers` (credential-carrying header
names are refused, and so are `user-agent` and `originator`). It never
contains a raw key, OAuth token, refresh token, cookie, or provider response.

Supported auth modes are:

- `environment` - resolve a named environment variable at run time;
- `api-key` - a pasted key kept in the credential vault under the account ID;
- `api-key-reference` - resolve through a caller broker using an account ID;
- `oauth` and `device` - sign-in tokens kept in the credential vault and
  refreshed before they expire;
- `service-account` - caller or Host owns the service identity;
- `caller` - a library caller supplies the `CredentialBroker`.

## Credential broker rules

- Resolve secrets only immediately before the provider request.
- Return an ephemeral lease; release or revoke when the run ends.
- Fail closed on missing account, revoked/expired state, scope mismatch, or
  cancellation.
- Never serialize the lease into CLI arguments, RPC parameters, events,
  evidence, transcripts, package metadata, or logs.
- Account status is safe metadata: `unconfigured`, `ready`, `expired`,
  `refreshing`, `error`, or `revoked`.

`createAccountCredentialResolver` adapts native account references to the
provider credential resolver.

## Credential vault

The vault is opt-in for library users and on by default for the
`runrail control` sidecar.

- `KeychainCredentialVault` - OS credential store, service
  `dev.runrail.credentials`, item name = account ID. Calls are bounded and fail
  with `VAULT_TIMEOUT` instead of waiting on a system prompt.
- `FileCredentialVault` - one file per account, mode 0600 in a 0700 directory,
  refused when other users can read it. Permissions only, no encryption.
- `MemoryCredentialVault` - tests.

`VaultCredentialBroker` resolves `api-key`, `oauth`, and `device` accounts
from the vault and passes every other mode to a fallback broker (environment
by default). It refreshes an expiring sign-in through the `CredentialRefresher`
registered for the account's preset or provider. Vendors rotate refresh tokens,
so a refresh is single flight per account inside a process and guarded by a
lock file across processes; a waiter re-reads the vault instead of refreshing
again.

For vault-backed accounts the broker owns the status: `unconfigured`
(`CREDENTIAL_MISSING`), `ready`, or `expired` (`SIGN_IN_EXPIRED`,
`SIGN_IN_REJECTED`). A vendor outage keeps a still-valid token and changes
nothing; a vault failure raises `CredentialStoreError` with the vault code and
changes nothing.

## Sign-in

`SignInManager` runs vendor sign-ins and stores the result through the vault
broker. A `SignInFlow` fixes its own addresses when it is built; nothing a
client sends can change them.

- `createPkceSignIn(descriptor)` - browser sign-in with PKCE and a callback on
  `127.0.0.1`. When the port cannot be opened the user pastes the address they
  landed on.
- `createDeviceCodeSignIn(descriptor)` - device-code sign-in (RFC 8628
  polling, including `slow_down`). The page to open must be on one of the
  descriptor's `verificationHosts`.
- `createRefreshTokenRefresher(options)` - the matching `CredentialRefresher`.
- `defaultSignInFlows()` - `createChatGptSignIn()` and
  `createOpenRouterSignIn()`. `credentialRefreshersFor(flows)` gives the
  refreshers to hand to `VaultCredentialBroker`, so a token a sign-in stored
  can be renewed by any process that reads the same vault.

The manager keeps at most four sign-ins running (starting a flow again
cancels its earlier sign-in), each with a
bounded event list and a deadline of ten minutes or less. A finished sign-in
writes the credential first and the account second; when either write fails
the credential is removed again and the account is left as it was
(`AUTH_STORE_FAILED`). `installationId(root)` is a random id kept in
`<root>/installation-id` for vendors that register a client per installation;
it names no user, host, or hardware.

Sign-in requests send `User-Agent: runrail/<version>` and
`originator: runrail`. Runrail ships no sign-in that presents another
product's client identity from its default entry.

### Unofficial plan sign-ins (`runrail/auth-vendors`)

`vendorSignInFlows()` from the opt-in entry `runrail/auth-vendors` adds three
device-code sign-ins. The default `runrail` entry neither exports nor
registers them; an embedder must import the entry and pass the flows to
`SignInManager` and `credentialRefreshersFor`. The `runrail` CLI does.

| Id | Preset | What it signs in to | Stored |
| --- | --- | --- | --- |
| `xai` | `xai-grok` | A SuperGrok or X Premium plan | Access and refresh token |
| `kimi` | `kimi-code` | A Kimi Code plan | Access and refresh token |
| `meta` | `meta` | A Meta AI plan | A key minted from the identity token, renewed with it |

All three are marked `unofficial: true`. Each vendor runs the sign-in for its
own command-line tool and issues no client id to other apps, so the flow
presents that tool's public client id. Every request still names Runrail, and
no other product's headers are sent. The vendor may refuse the sign-in, or act
on the account, at any time; an API key is the documented way in for each of
them. None of the three has been run against the real vendor by this project.

`xai-grok` and `kimi-code` are sign-in-only presets: `resolveConnection`
refuses an account on them that is not an `oauth` or `device` account.

### `runrail login` and `runrail logout`

```sh
runrail login --list
runrail login chatgpt
runrail login xai --accept-unofficial
runrail logout signin-xai
```

`runrail login <sign-in>` takes a sign-in id, or a preset id exactly one
sign-in leads to. It writes to the connection `signin-<id>` unless
`--connection <id>` names another, opens the sign-in page only when a person
is at a terminal (`--no-browser` prints it instead), and stores nothing when
the sign-in does not finish. An unofficial sign-in is refused before any
network request unless `--accept-unofficial` is passed or the prompt is
answered yes. Exit codes: 0 done, 1 not done, 2 refused, 130 cancelled.
`--json` prints one event per line; none holds a token or a code exchanged
for one. `runrail logout <connection>` removes the stored key or sign-in and
keeps the connection.

## Connections

A connection is an account used as a model source. `resolveConnection(record,
resolver)` turns an account record into provider options: it looks up the
preset (`reference.preset`, else `reference.provider`; the legacy
`openai-compatible` provider means `custom-openai-chat`), and returns the
endpoint, protocol, auth header style, quirks, headers, and the single host
the credential may be sent to.

- A known preset (`PROVIDER_PRESETS`) has a fixed address. `baseUrl` may
  change the path, but must stay on the preset's host and port over `https`.
- A custom preset (`CUSTOM_PROVIDER_PRESETS`) needs a `baseUrl`. Plain `http`
  is allowed only for this machine and the local network.
- An environment variable that a preset names is sent only to that preset. A
  variable no preset names goes wherever its account points.
- `user-agent` is always Runrail's own; a client identity in stored headers is
  dropped.
- A revoked account and an unknown preset are refused.

`connectionDestination(reference)` is the preset plus host and port. The
control server uses it to refuse an update that would move a stored credential
to another destination. `detectShellConnections(environment)` lists presets
whose conventional key variable is set, by name only; nothing is copied into
the vault.

The provider table, with each provider's protocol and request quirks, is in
[`COMPATIBILITY.md`](COMPATIBILITY.md#provider-presets).

### Connection settings

CLI commands and `createNativeControlRuntime` use the same user account
directory: `RUNRAIL_ACCOUNTS_DIR`, then `~/.runrail/accounts`. Account metadata,
connection settings, the default model, and separate tool homes are shared
across threads, projects, and restarts. A caller can retain an isolated store
by setting `accountsRoot` or `--accounts-dir` explicitly. An old store under a
thread's state directory is not moved automatically.

`ConnectionDirectory(accounts, settings)` lists stored accounts and coding-tool
connections as one set of connections the person added. Each has `enabled`
and an optional chosen `models` list whose first entry is its default; there
is one default model for the whole set (`setDefault`), never taken by adding
a connection. `addTool` and `removeTool` add and forget a coding tool;
removing one never signs the tool out. Tool connections and the on/off and
model settings are kept by a `ConnectionSettingsStore`:
`FileConnectionSettingsStore` writes `connections.json` beside
`accounts.json`, which keeps its old shape, and `InMemoryConnectionSettingsStore`
is for tests and embedders. The control methods and error codes are in
[`control-protocol.md`](control-protocol.md#connection-settings).

A tool connection with `separateAccount`, and every key connection, has a
`homeId`: its tool runs from `<accounts>/tool-homes/<homeId>`.
`toolConnectionAccount(connection, { accountsRoot, vault })` gives the folder
and, for a key connection, a reader for the key stored under the connection's
id; it refuses a key connection with no key (`CONNECTION_KEY_MISSING`). How
each tool takes the folder and the key is in
[`control-protocol.md`](control-protocol.md#coding-tool-sign-in).

### Checking a connection

`checkConnection(record, resolver)` makes one model-list call and returns a
stable code; `connectionCheckStatus(code)` turns it into `ok`, `unverified`
(a credential is there, but the call could not show that it works:
`RATE_LIMITED`, `NO_MODEL_LIST`, `INVALID_RESPONSE`), or `failed`. It spends
no tokens and changes nothing on the account. `connection.test` and the
command line share it:

```sh
runrail auth doctor conn-openrouter
runrail auth doctor signin-xai --json
```

The command makes one request with no retry (a sign-in that is due is renewed
first) and prints one line: the connection, the status, the code, the
provider's HTTP status when it refused, and how many models were listed. It
never prints a key, a token, a model name, or the provider's answer. Exit
codes: 0 works, 1 does not, 2 the request was refused (`CONNECTION_NOT_FOUND`,
`CONNECTION_INVALID`, `ENDPOINT_DENIED`), 3 could not tell.

| Code | Meaning |
| --- | --- |
| `OK` | The provider accepted the key or sign-in |
| `AUTH_FAILED` | The provider refused the key or sign-in |
| `CREDENTIAL_MISSING` | Nothing is stored for this connection |
| `SIGN_IN_EXPIRED`, `SIGN_IN_FAILED` | The sign-in ran out, or could not be renewed |
| `RATE_LIMITED` | The provider is rate limiting; nothing was checked |
| `NO_MODEL_LIST` | The provider has no model list to check against |
| `INVALID_RESPONSE` | The answer could not be read |
| `TIMEOUT`, `UNREACHABLE`, `SERVER_ERROR` | The provider did not answer, could not be reached, or failed |
| `REJECTED`, `ENDPOINT_DENIED` | The request was refused, or the address is not allowed |

`FileAccountStore` is one file that several engines may share. Every change
reloads the file under a lock, so concurrent engines do not lose each other's
writes, and readers pick up changes made elsewhere.
