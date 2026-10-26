import { randomUUID } from "node:crypto"
import { connectionDestination } from "../accounts/connections.ts"
import { parseAccountRecord, type AccountRecord, type AccountReference, type AccountStore } from "../accounts/types.ts"
import { boundedNativeId } from "../native/errors.ts"
import type { CredentialRefresher, VaultCredentialBroker } from "./broker.ts"
import { installationId } from "./installation.ts"
import { MAX_SIGN_IN_MS, SignInError, type SignInErrorCode, type SignInFlow, type SignInProgress, type SignInSession } from "./signin-types.ts"
import { createChatGptSignIn } from "./vendors/chatgpt.ts"
import { createOpenRouterSignIn } from "./vendors/openrouter.ts"
import type { StoredCredential } from "./vault.ts"

const MAX_FLOWS = 32
const MAX_ACTIVE_SIGN_INS = 4
const MAX_FINISHED_SIGN_INS = 16
const MAX_SIGN_IN_EVENTS = 32
const FINISHED_SIGN_IN_TTL_MS = 15 * 60_000
const FIRST_STEP_WAIT_MS = 10_000
export const MAX_SIGN_IN_STATUS_WAIT_MS = 20_000

export type SignInState = "starting" | "waiting" | "finishing" | "done" | "failed" | "cancelled"

/** One step of a sign-in as a client sees it. No variant carries a token or an authorization code. */
export type SignInEvent = { readonly seq: number; readonly at: number } & (
  | SignInProgress
  /** The page or code is out; Runrail waits for the user. */
  | { readonly type: "waiting" }
  | { readonly type: "done"; readonly accountId: string }
  | { readonly type: "failed"; readonly code: SignInErrorCode }
)

export interface SignInSnapshot {
  readonly loginId: string
  readonly flow: string
  readonly preset: string
  /** The account that holds the result once the sign-in is done. */
  readonly accountId: string
  readonly state: SignInState
  /** Why it stopped, when `state` is `failed` or `cancelled`. */
  readonly code?: SignInErrorCode
  /** True while the sign-in can take the address the user landed on. */
  readonly acceptsInput: boolean
  /** Events after the `afterSeq` the caller named. */
  readonly events: readonly SignInEvent[]
  readonly lastSeq: number
  readonly startedAt: number
  readonly expiresAt: number
}

export interface SignInFlowInfo {
  readonly id: string
  readonly label: string
  readonly preset: string
  readonly kind: "browser" | "device-code"
  readonly authMode: "oauth" | "device" | "api-key"
  readonly unofficial: boolean
  /** The only hosts a browser may be sent to for this sign-in. */
  readonly browserHosts: readonly string[]
}

export interface SignInManagerOptions {
  readonly flows: readonly SignInFlow[]
  readonly accounts: AccountStore
  readonly broker: VaultCredentialBroker
  /** Directory that holds the installation id. */
  readonly stateRoot: string
  readonly now?: () => number
  /** Upper bound for every sign-in, below the ten minute cap. */
  readonly timeoutMs?: number
}

interface Login {
  readonly loginId: string
  readonly flow: SignInFlow
  /** Set for a sign-in built for one target: its result goes to this vault entry, and no account is made. */
  readonly credential?: AccountReference
  readonly accountId: string
  readonly label: string
  readonly startedAt: number
  readonly expiresAt: number
  readonly abort: AbortController
  readonly events: SignInEvent[]
  readonly waiters: Set<() => void>
  state: SignInState
  seq: number
  code?: SignInErrorCode
  /** Why the manager stopped it; wins over whatever the flow reports on its way out. */
  abortCode?: SignInErrorCode
  reader?: (input: string) => void
  finishedAt?: number
  settled: Promise<void>
}

/** The sign-ins the default `runrail` entry offers: those the vendor documents for third-party tools. */
export function defaultSignInFlows(): readonly SignInFlow[] {
  return Object.freeze([createChatGptSignIn(), createOpenRouterSignIn()])
}

/** The refreshers of the given sign-ins, keyed the way the credential broker looks them up. */
export function credentialRefreshersFor(flows: readonly SignInFlow[]): Readonly<Record<string, CredentialRefresher>> {
  const refreshers: Record<string, CredentialRefresher> = {}
  for (const flow of flows) if (flow.refresher !== undefined) refreshers[flow.preset] = flow.refresher
  return Object.freeze(refreshers)
}

/**
 * Runs sign-ins and puts their result into the vault.
 *
 * A client starts a sign-in, reads its progress, and may cancel it. It never sees what the vendor
 * hands back: the tokens go from the flow straight to the credential broker.
 */
export class SignInManager {
  private readonly flows: ReadonlyMap<string, SignInFlow>
  private readonly accounts: AccountStore
  private readonly broker: VaultCredentialBroker
  private readonly stateRoot: string
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly logins = new Map<string, Login>()
  private gate: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(options: SignInManagerOptions) {
    if (options.flows.length > MAX_FLOWS) throw new SignInError("AUTH_INVALID", "too many sign-ins are registered")
    const flows = new Map<string, SignInFlow>()
    for (const flow of options.flows) {
      if (flows.has(flow.id)) throw new SignInError("AUTH_INVALID", "a sign-in id is registered twice")
      flows.set(flow.id, flow)
    }
    const timeoutMs = options.timeoutMs ?? MAX_SIGN_IN_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SIGN_IN_MS) throw new SignInError("AUTH_INVALID", "sign-in timeout is invalid")
    if (typeof options.stateRoot !== "string" || !options.stateRoot.startsWith("/") || options.stateRoot.length > 4_096) throw new SignInError("AUTH_INVALID", "sign-in state root is invalid")
    this.flows = flows
    this.accounts = options.accounts
    this.broker = options.broker
    this.stateRoot = options.stateRoot
    this.now = options.now ?? Date.now
    this.timeoutMs = timeoutMs
  }

  /** The registered sign-ins, and those built for one target while they run, so a host can check the page each opens. */
  list(): readonly SignInFlowInfo[] {
    const running = [...this.logins.values()].filter((login) => login.credential !== undefined && active(login)).map((login) => login.flow)
    return Object.freeze([...this.flows.values(), ...running].map((flow) => Object.freeze({ id: flow.id, label: flow.label, preset: flow.preset, kind: flow.kind, authMode: flow.authMode, unofficial: flow.unofficial, browserHosts: flow.browserHosts })))
  }

  /**
   * Starts a sign-in and answers once the page to open (or the code to type) is known. A running
   * sign-in of the same kind is cancelled first: it holds the callback address the new one needs.
   */
  start(flowId: string, target: { readonly accountId?: string; readonly label?: string } = {}): Promise<SignInSnapshot> {
    const started = this.gate.then(() => {
      const flow = this.flows.get(flowId)
      if (flow === undefined) throw new SignInError("AUTH_FLOW_UNKNOWN", "no such sign-in")
      return this.begin(flow, target)
    })
    this.gate = started.catch(() => {})
    return started
  }

  /**
   * Runs a sign-in built for one target, such as an MCP server, whose tokens go to the vault entry
   * `credential` names. No account is made for it; status, cancel and submit work as for any other.
   */
  startFor(flow: SignInFlow, credential: AccountReference): Promise<SignInSnapshot> {
    const started = this.gate.then(() => {
      if (this.flows.has(flow.id)) throw new SignInError("AUTH_INVALID", "a sign-in id is registered twice")
      return this.begin(flow, { accountId: credential.accountId, label: flow.label }, credential)
    })
    this.gate = started.catch(() => {})
    return started
  }

  /** The sign-in's state and its events after `afterSeq`. With `waitMs`, waits that long for a new event. */
  async status(loginId: string, afterSeq = 0, waitMs = 0): Promise<SignInSnapshot> {
    const login = this.require(loginId)
    if (waitMs > 0 && active(login) && login.seq <= afterSeq) await nextEvent(login, Math.min(waitMs, MAX_SIGN_IN_STATUS_WAIT_MS))
    return snapshot(login, afterSeq)
  }

  /** Hands the sign-in the address the user landed on. Input it cannot use is refused and the sign-in keeps waiting. */
  submit(loginId: string, input: string): SignInSnapshot {
    const login = this.require(loginId)
    if (!active(login) || login.state === "finishing") throw new SignInError("AUTH_LOGIN_FINISHED", "this sign-in no longer takes input")
    if (login.reader === undefined) throw new SignInError("AUTH_INPUT_INVALID", "this sign-in takes no pasted address")
    login.reader(input)
    return snapshot(login, login.seq)
  }

  async cancel(loginId: string): Promise<SignInSnapshot> {
    const login = this.require(loginId)
    await this.stop(login, "AUTH_CANCELLED")
    return snapshot(login, 0)
  }

  /** Forgets the stored credential of an account. A sign-in still running for it is cancelled first. */
  async logout(record: AccountRecord): Promise<void> {
    for (const login of [...this.logins.values()]) if (login.accountId === record.reference.accountId) await this.stop(login, "AUTH_CANCELLED")
    await this.broker.signOut(record.reference)
  }

  /** Cancels every running sign-in and closes their listeners. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.logins.values()].map((login) => this.stop(login, "AUTH_CANCELLED")))
  }

  private async begin(flow: SignInFlow, target: { readonly accountId?: string; readonly label?: string }, credential?: AccountReference): Promise<SignInSnapshot> {
    if (this.closed) throw new SignInError("AUTH_UNAVAILABLE", "sign-in is shutting down")
    const accountId = target.accountId ?? `signin-${flow.id}`
    const label = target.label ?? flow.label
    // Fails now rather than after the user has gone through the vendor's page.
    if (credential === undefined) await this.target(flow, accountId, label)
    for (const login of [...this.logins.values()]) if (login.flow.id === flow.id) await this.stop(login, "AUTH_CANCELLED")
    this.prune()
    if ([...this.logins.values()].filter(active).length >= MAX_ACTIVE_SIGN_INS) throw new SignInError("AUTH_LIMIT", "too many sign-ins are running")
    const startedAt = this.now()
    const login: Login = {
      loginId: `login-${randomUUID()}`,
      flow,
      ...(credential === undefined ? {} : { credential }),
      accountId,
      label,
      startedAt,
      expiresAt: startedAt + Math.min(this.timeoutMs, flow.timeoutMs ?? MAX_SIGN_IN_MS, MAX_SIGN_IN_MS),
      abort: new AbortController(),
      events: [],
      waiters: new Set(),
      state: "starting",
      seq: 0,
      settled: Promise.resolve(),
    }
    this.logins.set(login.loginId, login)
    login.settled = this.run(login)
    const deadline = Date.now() + FIRST_STEP_WAIT_MS
    while (login.state === "starting" && Date.now() < deadline) await nextEvent(login, deadline - Date.now())
    return snapshot(login, 0)
  }

  private async run(login: Login): Promise<void> {
    const timer = setTimeout(() => this.abort(login, "AUTH_TIMEOUT"), login.expiresAt - login.startedAt)
    const session: SignInSession = {
      signal: login.abort.signal,
      now: this.now,
      emit: (progress) => this.progress(login, progress),
      installationId: () => installationId(this.stateRoot),
      acceptManualInput: (reader) => {
        login.reader = reader
      },
    }
    try {
      const credential = await login.flow.run(session)
      if (login.abort.signal.aborted) throw new SignInError("AUTH_CANCELLED", "sign-in was cancelled")
      if (login.state !== "finishing") this.progress(login, { type: "finishing" })
      await this.keep(login, credential)
      this.finish(login, "done", undefined)
    } catch (error) {
      const code = login.abortCode ?? (error instanceof SignInError ? error.code : "AUTH_FAILED")
      this.finish(login, code === "AUTH_CANCELLED" ? "cancelled" : "failed", code)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Writes the result to the vault, creating the account that names it when there is none yet. */
  private async keep(login: Login, credential: StoredCredential): Promise<void> {
    if (login.credential !== undefined) {
      try {
        await this.broker.store(login.credential, credential)
      } catch {
        throw new SignInError("AUTH_STORE_FAILED", "the sign-in could not be saved")
      }
      return
    }
    const target = await this.target(login.flow, login.accountId, login.label)
    try {
      if (target.created) await this.accounts.put(target.record)
      await this.broker.store(target.record.reference, credential)
    } catch {
      if (target.created) {
        // Leave nothing half made: no credential without an account, no account that never worked.
        await this.broker.revoke(target.record.reference).catch(() => {})
        await (async () => (target.previous === undefined ? this.accounts.remove(login.accountId) : this.accounts.put(target.previous)))().catch(() => {})
      }
      throw new SignInError("AUTH_STORE_FAILED", "the sign-in could not be saved")
    }
  }

  /**
   * The account a sign-in writes to. An existing account is reused only when it already points at
   * the same provider and address with the same kind of credential; otherwise a token would end up
   * on an account that sends it somewhere else.
   */
  private async target(flow: SignInFlow, accountId: string, label: string): Promise<{ readonly record: AccountRecord; readonly created: boolean; readonly previous?: AccountRecord }> {
    let fresh: AccountRecord
    try {
      const now = this.now()
      fresh = parseAccountRecord({ reference: { accountId: boundedNativeId(accountId, "account id", 256), provider: flow.preset, label, authMode: flow.authMode, scopes: [], createdAt: now, updatedAt: now }, status: "unconfigured" })
    } catch {
      throw new SignInError("AUTH_INVALID", "account id or label is invalid")
    }
    const existing = await this.accounts.get(fresh.reference.accountId)
    if (existing === undefined) return { record: fresh, created: true }
    if (existing.status === "revoked") return { record: fresh, created: true, previous: existing }
    if (existing.reference.authMode !== flow.authMode || connectionDestination(existing.reference) !== connectionDestination(fresh.reference)) throw new SignInError("AUTH_ACCOUNT_MISMATCH", "this account belongs to another provider or sign-in type")
    return { record: existing, created: false }
  }

  private progress(login: Login, progress: SignInProgress): void {
    if (!active(login)) return
    this.push(login, progress)
    if (progress.type === "finishing") {
      login.state = "finishing"
      login.reader = undefined
    } else if (login.state === "starting") {
      login.state = "waiting"
      this.push(login, { type: "waiting" })
    }
  }

  private push(login: Login, event: SignInProgress | { readonly type: "waiting" } | { readonly type: "done"; readonly accountId: string } | { readonly type: "failed"; readonly code: SignInErrorCode }): void {
    login.seq += 1
    login.events.push(Object.freeze({ seq: login.seq, at: this.now(), ...event }))
    // The oldest go first; a reader behind them still sees the newest, and the outcome is always last.
    if (login.events.length > MAX_SIGN_IN_EVENTS) login.events.splice(0, login.events.length - MAX_SIGN_IN_EVENTS)
    for (const wake of [...login.waiters]) wake()
  }

  private finish(login: Login, state: "done" | "failed" | "cancelled", code: SignInErrorCode | undefined): void {
    if (!active(login)) return
    login.reader = undefined
    login.finishedAt = this.now()
    if (code !== undefined) login.code = code
    // The state changes before the event goes out, so whoever the event wakes sees the final state.
    login.state = state
    this.push(login, code === undefined ? { type: "done", accountId: login.accountId } : { type: "failed", code })
  }

  private abort(login: Login, code: SignInErrorCode): void {
    if (!active(login) || login.abort.signal.aborted) return
    login.abortCode = code
    login.abort.abort()
  }

  /** Aborts a running sign-in and waits until its listener is closed. */
  private async stop(login: Login, code: SignInErrorCode): Promise<void> {
    this.abort(login, code)
    await login.settled
  }

  private require(loginId: string): Login {
    this.prune()
    const login = this.logins.get(loginId)
    if (login === undefined) throw new SignInError("AUTH_LOGIN_NOT_FOUND", "no such sign-in")
    return login
  }

  /** Finished sign-ins stay readable for a while so a client can learn how they ended. */
  private prune(): void {
    const now = this.now()
    const finished = [...this.logins.values()].filter((login) => !active(login)).sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0))
    finished.forEach((login, index) => {
      if (finished.length - index > MAX_FINISHED_SIGN_INS || now - (login.finishedAt ?? 0) > FINISHED_SIGN_IN_TTL_MS) this.logins.delete(login.loginId)
    })
  }
}

function active(login: Login): boolean {
  return login.state === "starting" || login.state === "waiting" || login.state === "finishing"
}

function snapshot(login: Login, afterSeq: number): SignInSnapshot {
  return Object.freeze({
    loginId: login.loginId,
    flow: login.flow.id,
    preset: login.flow.preset,
    accountId: login.accountId,
    state: login.state,
    ...(login.code === undefined ? {} : { code: login.code }),
    acceptsInput: login.reader !== undefined && login.state === "waiting",
    events: Object.freeze(login.events.filter((event) => event.seq > afterSeq)),
    lastSeq: login.seq,
    startedAt: login.startedAt,
    expiresAt: login.expiresAt,
  })
}

function nextEvent(login: Login, waitMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      login.waiters.delete(wake)
      resolve()
    }
    const timer = setTimeout(wake, Math.max(0, waitMs))
    login.waiters.add(wake)
  })
}
