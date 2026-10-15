import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"
import { ConnectorError, createConnectorRegistry, type ConnectorDefinition, type ConnectorRegistry } from "./registry.ts"
import { createGitHubConnector, createJiraConnector, createLinearConnector, createSlackConnector } from "./services.ts"

/**
 * The built-in connectors the person turned on, in `~/.runrail/connectors.json`. The file
 * holds no secret: GitHub answers with the person's own `gh` sign-in, and the other services' keys
 * sit in the credential vault under `connector:<kind>`, read only when a call is made.
 */

export const CONNECTOR_KINDS = ["github", "linear", "slack", "jira"] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

export interface ConnectorSetting {
  readonly on: boolean
  /** Jira only: the site, as `your-team.atlassian.net`. */
  readonly site?: string
  /** Jira only: the account the API token belongs to. */
  readonly email?: string
  readonly updatedAt: number
}

export type ConnectorSettings = Readonly<Partial<Record<ConnectorKind, ConnectorSetting>>>

export const CONNECTOR_NAMES: Readonly<Record<ConnectorKind, string>> = { github: "GitHub", linear: "Linear", slack: "Slack", jira: "Jira" }

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return typeof value === "string" && (CONNECTOR_KINDS as readonly string[]).includes(value)
}

/** Where a connector's key is kept in the credential vault; `isReservedCredentialId` keeps accounts off these ids. */
export function connectorSecretId(kind: ConnectorKind): string {
  return `connector:${kind}`
}

const SITE = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){1,4}$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/

export class ConnectorSetupStore {
  constructor(readonly file: string) {}

  async read(): Promise<ConnectorSettings> {
    let text: string
    try {
      text = await readFile(this.file, "utf8")
    } catch {
      return {}
    }
    try {
      return settingsOf(JSON.parse(text) as unknown)
    } catch {
      return {}
    }
  }

  async save(kind: ConnectorKind, input: { readonly on: boolean; readonly site?: string; readonly email?: string }, now = Date.now()): Promise<ConnectorSetting> {
    if (kind === "jira" && input.on && (input.site === undefined || input.email === undefined)) throw new ConnectorError("CONNECTOR_INVALID", "Jira needs its site and the account's email")
    const setting = settingOf(kind, { ...input, updatedAt: now })
    if (setting === undefined) throw new ConnectorError("CONNECTOR_INVALID", "connector settings are invalid")
    await this.#write({ ...(await this.read()), [kind]: setting })
    return setting
  }

  async remove(kind: ConnectorKind): Promise<void> {
    const { [kind]: _removed, ...rest } = await this.read()
    await this.#write(rest)
  }

  async #write(settings: ConnectorSettings): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, connectors: settings }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }
}

function settingsOf(value: unknown): ConnectorSettings {
  const connectors = isRecord(value) && isRecord(value.connectors) ? value.connectors : {}
  const settings: Partial<Record<ConnectorKind, ConnectorSetting>> = {}
  for (const kind of CONNECTOR_KINDS) {
    const setting = settingOf(kind, connectors[kind])
    if (setting !== undefined) settings[kind] = setting
  }
  return settings
}

function settingOf(kind: ConnectorKind, value: unknown): ConnectorSetting | undefined {
  if (!isRecord(value) || typeof value.on !== "boolean") return undefined
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  if (kind !== "jira") return { on: value.on, updatedAt }
  const site = typeof value.site === "string" ? value.site.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "") : undefined
  const email = typeof value.email === "string" ? value.email.trim() : undefined
  if ((site !== undefined && !SITE.test(site)) || (email !== undefined && !EMAIL.test(email))) return undefined
  return { on: value.on, ...(site === undefined ? {} : { site }), ...(email === undefined ? {} : { email }), updatedAt }
}

export interface ConnectorSecrets {
  /** A key from the vault, or the `gh` sign-in's token for GitHub; read per call, never kept. */
  readonly resolve: (kind: ConnectorKind) => Promise<string>
}

/** The registry of every connector that is on. A key that went missing fails that call, not the session. */
export function buildConnectorRegistry(settings: ConnectorSettings, secrets: ConnectorSecrets): ConnectorRegistry {
  const definitions: ConnectorDefinition[] = []
  for (const kind of CONNECTOR_KINDS) {
    const setting = settings[kind]
    if (setting?.on !== true) continue
    const credential = { reference: { kind: "caller" as const, account: kind }, resolver: { resolve: () => secrets.resolve(kind) } }
    // Each service is reached at its own host and no other.
    const remote = (host: string) => ({ allowRemote: true, allowedHosts: [host] })
    if (kind === "github") definitions.push(createGitHubConnector({ credential, ...remote("api.github.com") }))
    else if (kind === "linear") definitions.push(createLinearConnector({ credential, ...remote("api.linear.app") }))
    else if (kind === "slack") definitions.push(createSlackConnector({ credential, ...remote("slack.com") }))
    else if (setting.site !== undefined && setting.email !== undefined) definitions.push(createJiraConnector({ endpoint: `https://${setting.site}/`, credential: { ...credential, username: setting.email }, ...remote(setting.site) }))
  }
  return createConnectorRegistry(definitions)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
