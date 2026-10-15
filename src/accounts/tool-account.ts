import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { CredentialVault } from "../auth/vault.ts"
import type { HarnessAccountOptions } from "../harness/account.ts"
import { ConnectionSettingsError, type ToolConnection } from "./connection-settings.ts"

/**
 * The config folder a tool connection signs in from, when it has one of its own. Folders are kept
 * when a connection is removed: removing one never signs the tool out (`connection.vendorSignOut`
 * does that).
 */
export function toolConnectionHome(accountsRoot: string, connection: ToolConnection): string | undefined {
  return connection.homeId === undefined ? undefined : join(accountsRoot, "tool-homes", connection.homeId)
}

/**
 * What the tool's route runs with for this connection: its own folder, and for a key connection
 * the key, read from the vault each time the tool starts. Refuses a key connection with no key.
 */
export async function toolConnectionAccount(connection: ToolConnection, options: { readonly accountsRoot: string; readonly vault?: CredentialVault }): Promise<HarnessAccountOptions | undefined> {
  const configDir = toolConnectionHome(options.accountsRoot, connection)
  if (connection.authMode === "api-key") {
    // Every key connection added since keys were taken has its own folder; one without can only be older.
    if (configDir === undefined) throw new ConnectionSettingsError("CONNECTION_INVALID", "this key connection has no folder of its own; add it again")
    const vault = options.vault
    if (vault === undefined || !(await hasToolConnectionKey(vault, connection.connectionId))) throw new ConnectionSettingsError("CONNECTION_KEY_MISSING", "no key is stored for this connection")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    return Object.freeze({ configDir, apiKey: () => readToolConnectionKey(vault, connection.connectionId) })
  }
  if (configDir === undefined) return undefined
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  return Object.freeze({ configDir })
}

/** Tool connection ids never match an account id, so a connection's key sits under its own id. */
export async function hasToolConnectionKey(vault: CredentialVault, connectionId: string): Promise<boolean> {
  return (await vault.get(connectionId))?.kind === "api-key"
}

async function readToolConnectionKey(vault: CredentialVault, connectionId: string): Promise<string> {
  const stored = await vault.get(connectionId)
  if (stored?.kind !== "api-key") throw new ConnectionSettingsError("CONNECTION_KEY_MISSING", "no key is stored for this connection")
  return stored.secret
}
