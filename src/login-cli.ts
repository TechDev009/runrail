import { EnvironmentCredentialBroker, type AccountStore } from "./accounts/index.ts"
import { SignInError, SignInManager, VaultCredentialBroker, credentialRefreshersFor, type CredentialVault, type SignInEvent, type SignInFlow, type SignInSnapshot } from "./auth/index.ts"

/** What `runrail login` and `runrail logout` were asked to do. */
export type SignInCliOptions =
  | { readonly action: "list"; readonly json: boolean }
  | {
      readonly action: "login"
      /** A sign-in id (`chatgpt`), or the id of a preset exactly one sign-in leads to. */
      readonly target: string
      /** The connection to write to. Default: one connection per sign-in, `signin-<id>`. */
      readonly connectionId?: string
      readonly label?: string
      readonly acceptUnofficial: boolean
      readonly json: boolean
    }
  | { readonly action: "logout"; readonly connectionId: string; readonly json: boolean }

export interface SignInCliHost {
  readonly flows: readonly SignInFlow[]
  readonly accounts: AccountStore
  readonly vault: CredentialVault
  /** Directory of the accounts; refresh locks and the installation id live under it. */
  readonly accountsDir: string
  /** Results: one line each. In `--json` mode every line is one JSON object. */
  out(line: string): void
  /** What the person reads while the sign-in runs. */
  note(line: string): void
  /** Asks a yes/no question. Absent when nobody is there to answer. */
  confirm?(question: string): Promise<boolean>
  /** Opens a page in the person's browser. Absent when the page should only be printed. */
  openUrl?(url: string): void
  /** The next line the person types, or `undefined` when input has ended. Absent when nobody is there to type. */
  readLine?(): Promise<string | undefined>
  /** Aborts on Ctrl-C. */
  readonly signal?: AbortSignal
}

export const SIGN_IN_CLI_USAGE = "usage: runrail login <sign-in> [--connection <id>] [--label <text>] [--accept-unofficial] [--no-browser] [--json] | runrail login --list [--json] | runrail logout <connection> [--json]"

const UNOFFICIAL_NOTICE = [
  "This sign-in is not documented by the provider for other tools.",
  "Runrail signs in with the client id of the provider's own command-line tool and names itself as Runrail.",
  "The provider may refuse it, or act on the account, at any time.",
] as const

/** Exit codes: 0 done, 1 the sign-in or sign-out did not happen, 2 the request itself was refused, 130 cancelled. */
export async function runSignInCli(options: SignInCliOptions, host: SignInCliHost): Promise<number> {
  if (options.action === "list") {
    if (options.json) host.out(JSON.stringify(host.flows.map((flow) => ({ id: flow.id, label: flow.label, preset: flow.preset, kind: flow.kind, unofficial: flow.unofficial }))))
    else for (const flow of host.flows) host.out(`${flow.id}\t${flow.label}\t${flow.kind === "device-code" ? "code" : "browser"}\t${flow.unofficial ? "unofficial" : "documented"}`)
    return 0
  }
  const broker = new VaultCredentialBroker({ vault: host.vault, accounts: host.accounts, lockRoot: `${host.accountsDir}/locks`, fallback: new EnvironmentCredentialBroker(), refreshers: credentialRefreshersFor(host.flows) })
  const manager = new SignInManager({ flows: host.flows, accounts: host.accounts, broker, stateRoot: host.accountsDir })
  try {
    return options.action === "logout" ? await signOut(options, host, manager) : await signIn(options, host, manager)
  } finally {
    await manager.close()
  }
}

async function signOut(options: Extract<SignInCliOptions, { action: "logout" }>, host: SignInCliHost, manager: SignInManager): Promise<number> {
  const record = await host.accounts.get(options.connectionId)
  if (record === undefined || record.status === "revoked") return refuse(host, options.json, 1, "CONNECTION_NOT_FOUND", "connection was not found")
  const mode = record.reference.authMode
  if (mode !== "api-key" && mode !== "oauth" && mode !== "device") return refuse(host, options.json, 2, "CONNECTION_KEEPS_NO_CREDENTIAL", "this connection keeps no stored key or sign-in")
  try {
    await manager.logout(record)
  } catch {
    return refuse(host, options.json, 1, "SIGN_OUT_FAILED", "the stored key or sign-in could not be removed")
  }
  if (options.json) host.out(JSON.stringify({ type: "signed-out", connectionId: record.reference.accountId }))
  else host.out(`Signed out of ${record.reference.label}. The connection stays; sign in or add a key to use it again.`)
  return 0
}

async function signIn(options: Extract<SignInCliOptions, { action: "login" }>, host: SignInCliHost, manager: SignInManager): Promise<number> {
  const flow = findFlow(host.flows, options.target)
  if (flow === undefined) return refuse(host, options.json, 2, "AUTH_FLOW_UNKNOWN", `no such sign-in; ${host.flows.length === 0 ? "none is available" : `choose one of ${host.flows.map((entry) => entry.id).join(", ")}`}`)
  if (flow.unofficial && !options.acceptUnofficial) {
    if (host.confirm === undefined) return refuse(host, options.json, 2, "AUTH_UNOFFICIAL_NOT_ACCEPTED", `${flow.label} is an unofficial sign-in. ${UNOFFICIAL_NOTICE.join(" ")} Pass --accept-unofficial to use it.`)
    host.note(flow.label)
    for (const line of UNOFFICIAL_NOTICE) host.note(line)
    if (!(await host.confirm("Continue?"))) return refuse(host, options.json, 2, "AUTH_UNOFFICIAL_NOT_ACCEPTED", "nothing was started")
  }

  let snapshot: SignInSnapshot
  try {
    snapshot = await manager.start(flow.id, { ...(options.connectionId === undefined ? {} : { accountId: options.connectionId }), ...(options.label === undefined ? {} : { label: options.label }) })
  } catch (error) {
    return refuse(host, options.json, 2, error instanceof SignInError ? error.code : "AUTH_FAILED", "the sign-in could not be started")
  }

  const cancelled = new Promise<"cancelled">((resolve) => {
    if (host.signal?.aborted === true) resolve("cancelled")
    else host.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true })
  })
  let seen = 0
  let pasting = false
  for (;;) {
    for (const event of snapshot.events) {
      if (event.seq <= seen) continue
      seen = event.seq
      render(event, flow, options.json, host)
    }
    if (!running(snapshot)) break
    if (snapshot.acceptsInput && !pasting && host.readLine !== undefined) {
      pasting = true
      void paste(snapshot.loginId, manager, host)
    }
    const next = await Promise.race([manager.status(snapshot.loginId, seen, 20_000), cancelled])
    if (next === "cancelled") {
      await manager.cancel(snapshot.loginId)
      if (options.json) host.out(JSON.stringify({ type: "failed", code: "AUTH_CANCELLED" }))
      else host.note("Sign-in cancelled. Nothing was stored.")
      return 130
    }
    snapshot = next
  }
  return snapshot.state === "done" ? 0 : 1
}

/** Hands what the person types to the sign-in until it stops taking input. Input it cannot use is said so and asked for again. */
async function paste(loginId: string, manager: SignInManager, host: SignInCliHost): Promise<void> {
  for (;;) {
    const line = await host.readLine?.()
    if (line === undefined) return
    if (line.trim().length === 0) continue
    try {
      manager.submit(loginId, line)
    } catch (error) {
      if (error instanceof SignInError && (error.code === "AUTH_LOGIN_FINISHED" || error.code === "AUTH_LOGIN_NOT_FOUND")) return
      host.note("That is not the address the sign-in ended on. Copy the whole address from the browser and paste it again.")
    }
  }
}

function render(event: SignInEvent, flow: SignInFlow, json: boolean, host: SignInCliHost): void {
  if (event.type === "waiting") return
  if (json) {
    // The same fields a control client gets; none of them is a token or an authorization code.
    const { seq: _seq, at: _at, ...rest } = event
    host.out(JSON.stringify(event.type === "done" ? { type: "done", connectionId: event.accountId } : rest))
    return
  }
  switch (event.type) {
    case "open-url":
      host.note(`Open this page to sign in to ${flow.label}:`)
      host.note(event.url)
      if (event.redirect === "manual") host.note(host.readLine === undefined ? "The browser cannot come back to Runrail by itself here; run this command in a terminal to paste the address it ends on." : "When the browser ends on an address that does not load, paste that whole address here and press Enter.")
      openPage(event.url, flow, host)
      return
    case "device-code":
      host.note(`Open ${event.verificationUrl}`)
      host.note(`and enter the code ${event.userCode}`)
      host.note(`Waiting for you to finish there. The code works until ${new Date(event.expiresAt).toLocaleTimeString()}.`)
      openPage(event.verificationUrl, flow, host)
      return
    case "finishing":
      host.note("Finishing the sign-in.")
      return
    case "done":
      host.out(`Signed in to ${flow.label}. Connection: ${event.accountId}`)
      host.note(`Use it with: runrail run --connection ${event.accountId} --model <model> --cwd <path> <task>`)
      return
    case "failed":
      host.note(`${FAILURES[event.code] ?? "The sign-in did not finish."} (${event.code}) Nothing was stored.`)
      return
  }
}

const FAILURES: Readonly<Record<string, string>> = {
  AUTH_DENIED: "The sign-in was declined on the provider's page.",
  AUTH_EXPIRED: "The code ran out before it was entered.",
  AUTH_TIMEOUT: "Nobody finished the sign-in in time.",
  AUTH_CANCELLED: "The sign-in was cancelled.",
  AUTH_CODE_REJECTED: "The provider refused the sign-in.",
  AUTH_SCOPE_MISSING: "The account lacks the access this needs.",
  AUTH_RESPONSE_INVALID: "The provider's answer could not be used.",
  AUTH_NETWORK: "The provider's sign-in service could not be reached.",
  AUTH_STORE_FAILED: "The sign-in could not be saved to the credential store.",
  AUTH_ACCOUNT_MISMATCH: "That connection belongs to another provider or another kind of sign-in.",
  AUTH_UNAVAILABLE: "No local port could be opened for the sign-in.",
}

/** Opens only a page on one of the hosts the sign-in was built with. */
function openPage(address: string, flow: SignInFlow, host: SignInCliHost): void {
  if (host.openUrl === undefined) return
  try {
    const url = new URL(address)
    if ((url.protocol === "https:" || url.protocol === "http:") && flow.browserHosts.includes(url.hostname)) host.openUrl(url.toString())
  } catch {
    // The page stays printed; the person opens it by hand.
  }
}

function findFlow(flows: readonly SignInFlow[], target: string): SignInFlow | undefined {
  const byId = flows.find((flow) => flow.id === target)
  if (byId !== undefined) return byId
  const byPreset = flows.filter((flow) => flow.preset === target)
  return byPreset.length === 1 ? byPreset[0] : undefined
}

function running(snapshot: SignInSnapshot): boolean {
  return snapshot.state === "starting" || snapshot.state === "waiting" || snapshot.state === "finishing"
}

function refuse(host: SignInCliHost, json: boolean, exitCode: number, code: string, message: string): number {
  if (json) host.out(JSON.stringify({ type: "failed", code }))
  else host.note(`${message} (${code})`)
  return exitCode
}
