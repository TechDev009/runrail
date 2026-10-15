import { isAbsolute } from "node:path"
import { PI_RESOURCE_ADAPTER_VERSION } from "./constants.ts"
import { PiResourceCompatibilityError } from "./errors.ts"
import type { PiResourceBundle, PiResourceEntry, PiResourceKind } from "./index.ts"

export const PI_MIGRATION_PLAN_VERSION = 1 as const

export type PiMigrationStepStatus = "ready" | "manual-review"
export type PiMigrationAction = "load-skill" | "map-prompt-template" | "load-theme" | "author-runrail-plugin"
export type PiMigrationNextAction = "load-native-resources" | "author-runrail-plugin-or-use-pi-pass-through"

export interface PiMigrationStep {
  readonly id: string
  readonly kind: PiResourceKind
  readonly path: string
  readonly activation: "native" | "caller-owned"
  readonly status: PiMigrationStepStatus
  readonly action: PiMigrationAction
  readonly target: string
  readonly reason?: string
}

export interface PiMigrationPlan {
  readonly version: typeof PI_MIGRATION_PLAN_VERSION
  readonly packageId: string
  readonly packageVersion: string
  readonly nativeResources: number
  readonly callerOwnedResources: number
  readonly requiresManualMigration: boolean
  readonly nextAction: PiMigrationNextAction
  readonly steps: readonly PiMigrationStep[]
}

/**
 * Creates a read-only migration plan for a discovered Pi package.
 *
 * Resource files are never read here and extension code is never imported. The
 * plan only tells a caller how to wire bounded resource metadata into Runrail
 * and where explicit manual migration or Pi pass-through is still required.
 */
export function createPiMigrationPlan(bundle: PiResourceBundle): PiMigrationPlan {
  if (!isValidBundle(bundle)) throw new PiResourceCompatibilityError("PI_RESOURCE_INVALID", "migration bundle is invalid")
  const steps = bundle.entries.map(createStep).sort((left, right) => left.id.localeCompare(right.id))
  const callerOwnedResources = steps.filter((step) => step.status === "manual-review").length
  const nativeResources = steps.length - callerOwnedResources
  return Object.freeze({
    version: PI_MIGRATION_PLAN_VERSION,
    packageId: bundle.manifest.packageId,
    packageVersion: bundle.manifest.version,
    nativeResources,
    callerOwnedResources,
    requiresManualMigration: callerOwnedResources > 0,
    nextAction: callerOwnedResources > 0 ? "author-runrail-plugin-or-use-pi-pass-through" : "load-native-resources",
    steps: Object.freeze(steps),
  })
}

function createStep(entry: PiResourceEntry): PiMigrationStep {
  if (entry.kind === "skill") {
    return Object.freeze({
      id: `skill:${entry.path}`,
      kind: entry.kind,
      path: entry.path,
      activation: "native",
      status: "ready",
      action: "load-skill",
      target: "context.skills",
    })
  }
  if (entry.kind === "prompt") {
    return Object.freeze({
      id: `prompt:${entry.path}`,
      kind: entry.kind,
      path: entry.path,
      activation: "native",
      status: "ready",
      action: "map-prompt-template",
      target: "context.promptTemplates",
    })
  }
  if (entry.kind === "theme") {
    return Object.freeze({
      id: `theme:${entry.path}`,
      kind: entry.kind,
      path: entry.path,
      activation: "native",
      status: "ready",
      action: "load-theme",
      target: "workbench.themes",
    })
  }
  return Object.freeze({
    id: `extension:${entry.path}`,
    kind: entry.kind,
    path: entry.path,
    activation: "caller-owned",
    status: "manual-review",
    action: "author-runrail-plugin",
    target: "runrail.plugin.json and entry",
    reason: "Pi extension code is not automatically translated or executed; author a Runrail plugin or use runrail pi.",
  })
}

function isValidBundle(value: unknown): value is PiResourceBundle {
  if (!isRecord(value) || !hasKnownKeys(value, ["manifest", "root", "entries"]) || !isRecord(value.manifest) || !Array.isArray(value.entries)) return false
  if (!boundedRoot(value.root) || !isValidManifest(value.manifest) || value.entries.length > 16_384) return false
  const seen = new Set<string>()
  return value.entries.every((entry) => {
    if (!isRecord(entry) || !hasKnownKeys(entry, ["kind", "path", "activation"]) || !isResourceKind(entry.kind) || !boundedPath(entry.path)) return false
    const expectedActivation = entry.kind === "extension" ? "caller-owned" : "native"
    if (entry.activation !== expectedActivation) return false
    const key = `${entry.kind}:${entry.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isValidManifest(value: Record<string, unknown>): boolean {
  return hasKnownKeys(value, ["adapterVersion", "packageId", "version", "extensions", "skills", "prompts", "themes"])
    && value.adapterVersion === PI_RESOURCE_ADAPTER_VERSION
    && boundedIdentifier(value.packageId)
    && boundedText(value.version, 64)
    && validPathList(value.extensions)
    && validPathList(value.skills)
    && validPathList(value.prompts)
    && validPathList(value.themes)
}

function validPathList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 256) return false
  const paths = value.filter((entry): entry is string => boundedPath(entry))
  return paths.length === value.length && new Set(paths).size === paths.length
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isResourceKind(value: unknown): value is PiResourceKind {
  return value === "extension" || value === "skill" || value === "prompt" || value === "theme"
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0") && !/[\r\n]/.test(value)
}

function boundedPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value) && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

function boundedRoot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && isAbsolute(value) && !value.includes("\0") && !/[\r\n]/.test(value)
}

function hasKnownKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(record).every((key) => allowed.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
