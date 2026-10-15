import { ConnectionDirectory, FileAccountStore, FileConnectionSettingsStore, EnvironmentCredentialBroker, InMemoryConnectionSettingsStore, createAccountCredentialResolver, type AccountStore, type ConnectionSettingsStore, type CredentialBroker } from "./accounts/index.ts"
import { SignInManager, VaultCredentialBroker, credentialRefreshersFor, defaultSignInFlows, type CredentialRefresher, type CredentialVault, type SignInFlow } from "./auth/index.ts"
import { FileNativeCommandLedger, FileNativeEventJournal, FileNativeTaskStore, createNativeTaskKernel, openNativeTaskController, type NativeTaskController, type NativeTaskKernel, type NativeTaskStore } from "./task/index.ts"
import type { NativeCommandLedger } from "./native/commands.ts"
import type { NativeEventJournal } from "./native/events.ts"
import { NativeContractError, boundedNativeId } from "./native/errors.ts"
import { FileShareStore, type ShareStore } from "./share/index.ts"
import type { ProviderCredentialResolver } from "./providers/types.ts"
import type { RunrailSessionController } from "./control.ts"
import { NativePackageManager } from "./packages/index.ts"
import { resolveAccountsRoot } from "./accounts/storage.ts"

export interface NativeControlRuntimeOptions {
  readonly stateRoot: string
  readonly workspaceRoot: string
  readonly projectId: string
  readonly ownerId: string
  readonly taskStore?: NativeTaskStore
  readonly eventJournal?: NativeEventJournal
  readonly commandLedger?: NativeCommandLedger
  readonly accountStore?: AccountStore
  /** Switches, chosen models, tool connections, and the default. Defaults to `connections.json` beside the accounts. */
  readonly connectionSettings?: ConnectionSettingsStore
  readonly credentialBroker?: CredentialBroker
  /** User-owned account metadata, connection settings, tool homes, and refresh locks. Defaults to RUNRAIL_ACCOUNTS_DIR or ~/.runrail/accounts across threads and projects. */
  readonly accountsRoot?: string
  /** Where pasted keys and sign-in tokens are kept. Without one, accounts resolve from the environment only. */
  readonly credentialVault?: CredentialVault
  readonly credentialRefreshers?: Readonly<Record<string, CredentialRefresher>>
  /** The sign-ins on offer. Defaults to those vendors document for third-party tools. Needs a credential vault. */
  readonly signInFlows?: readonly SignInFlow[]
  readonly shareStore?: ShareStore
  readonly maxTasks?: number
  readonly maxEventsPerTask?: number
}

export interface NativeControlRuntime {
  readonly projectId: string
  readonly ownerId: string
  readonly taskKernel: NativeTaskKernel
  readonly packageManager: NativePackageManager
  readonly accounts: AccountStore
  /** Where accounts, connection settings, and tool connections' own config folders live. */
  readonly accountsRoot: string
  /** Providers and coding tools the person added, with their switches, models, and the default. */
  readonly connections: ConnectionDirectory
  readonly credentialBroker: CredentialBroker
  /** Present when a credential vault is configured; the only path that stores a secret. */
  readonly vaultBroker?: VaultCredentialBroker
  /** Present with the vault: a sign-in has nowhere else to put its result. */
  readonly signIn?: SignInManager
  readonly signInFlows: readonly SignInFlow[]
  readonly credentialResolver: ProviderCredentialResolver
  readonly shares: ShareStore
  /** Each binding remembers the session controller it drives, so a refreshed session never reuses it. */
  readonly taskControllers: Map<string, { readonly session: RunrailSessionController; readonly sessionId: string; readonly task: NativeTaskController }>
}

export function createNativeControlRuntime(options: NativeControlRuntimeOptions): NativeControlRuntime {
  const stateRoot = absoluteRoot(options.stateRoot)
  const workspaceRoot = absoluteRoot(options.workspaceRoot)
  const projectId = boundedNativeId(options.projectId, "project id")
  const ownerId = boundedNativeId(options.ownerId, "owner id", 256)
  const taskKernel = createNativeTaskKernel({
    store: options.taskStore ?? new FileNativeTaskStore({ root: `${stateRoot}/tasks`, maxTasks: options.maxTasks }),
    journal: options.eventJournal ?? new FileNativeEventJournal({ root: `${stateRoot}/tasks`, maxEventsPerTask: options.maxEventsPerTask }),
    ledger: options.commandLedger ?? new FileNativeCommandLedger({ root: `${stateRoot}/tasks` }),
    maxTasks: options.maxTasks,
    maxEventsPerTask: options.maxEventsPerTask,
  })
  const packageManager = new NativePackageManager({ workspaceRoot })
  const accountsRoot = options.accountsRoot === undefined ? resolveAccountsRoot() : absoluteRoot(options.accountsRoot)
  const accounts = options.accountStore ?? new FileAccountStore({ root: accountsRoot })
  // Settings follow the accounts: on disk beside a file store, in memory beside a store the caller gave.
  const connectionSettings = options.connectionSettings ?? (options.accountStore === undefined ? new FileConnectionSettingsStore({ root: accountsRoot }) : new InMemoryConnectionSettingsStore())
  const signInFlows = options.credentialVault === undefined ? Object.freeze([]) : options.signInFlows ?? defaultSignInFlows()
  const vaultBroker = options.credentialVault === undefined
    ? undefined
    : new VaultCredentialBroker({
        vault: options.credentialVault,
        accounts,
        lockRoot: `${accountsRoot}/locks`,
        fallback: options.credentialBroker ?? new EnvironmentCredentialBroker(),
        // A sign-in brings the refresher for the tokens it stores.
        refreshers: { ...credentialRefreshersFor(signInFlows), ...options.credentialRefreshers },
      })
  const signIn = vaultBroker === undefined ? undefined : new SignInManager({ flows: signInFlows, accounts, broker: vaultBroker, stateRoot: accountsRoot })
  const credentialBroker = vaultBroker ?? options.credentialBroker ?? new EnvironmentCredentialBroker()
  const shares = options.shareStore ?? new FileShareStore({ root: `${stateRoot}/shares` })
  return {
    projectId,
    ownerId,
    taskKernel,
    packageManager,
    accounts,
    accountsRoot,
    connections: new ConnectionDirectory(accounts, connectionSettings),
    credentialBroker,
    ...(vaultBroker === undefined ? {} : { vaultBroker }),
    ...(signIn === undefined ? {} : { signIn }),
    signInFlows,
    credentialResolver: createAccountCredentialResolver(accounts, credentialBroker),
    shares,
    taskControllers: new Map(),
  }
}

export async function nativeTaskController(
  runtime: NativeControlRuntime,
  taskId: string,
  controller: RunrailSessionController,
): Promise<NativeTaskController> {
  const id = boundedNativeId(taskId, "task id")
  const sessionId = controller.session.snapshot.id
  const cached = runtime.taskControllers.get(id)
  if (cached !== undefined && cached.session === controller && cached.sessionId === sessionId) return cached.task
  runtime.taskControllers.delete(id)
  const task = await runtime.taskKernel.snapshot(id)
  if (task.projectId !== runtime.projectId) throw new NativeContractError("NATIVE_AUTH_REQUIRED", "task belongs to another project")
  if (task.sessionId !== sessionId) throw new NativeContractError("NATIVE_AUTH_REQUIRED", "task belongs to another session")
  const opened = await openNativeTaskController(id, controller, runtime.taskKernel)
  runtime.taskControllers.set(id, { session: controller, sessionId, task: opened })
  // A controller holds nothing open, so the oldest is dropped and reopened if it is asked for again.
  while (runtime.taskControllers.size > 256) runtime.taskControllers.delete(runtime.taskControllers.keys().next().value as string)
  return opened
}

function absoluteRoot(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !value.startsWith("/")) throw new NativeContractError("NATIVE_INVALID", "native state root is invalid")
  return value.replace(/\/+$/, "") || "/"
}
