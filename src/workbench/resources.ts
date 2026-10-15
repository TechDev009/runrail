import type { ContextResource, ContextResourceSet, PromptAttachment } from "../context/resources.ts"
import type { WorkspacePolicy } from "../workspace/policy.ts"

export type WorkbenchResourceKind = "instruction" | "system" | "template" | "skill" | "theme" | "mcp" | "file"

export interface WorkbenchResourceEntry {
  readonly id: string
  readonly kind: WorkbenchResourceKind
  readonly path?: string
  readonly bytes?: number
}

export interface WorkbenchResourceSelection {
  readonly id: string
  readonly path?: string
  readonly kind: WorkbenchResourceKind
  readonly attachment?: PromptAttachment
}

export type ResourcePickerErrorCode = "RESOURCE_PICKER_INVALID" | "RESOURCE_PICKER_LIMIT" | "RESOURCE_NOT_FOUND"

export class ResourcePickerError extends Error {
  constructor(readonly code: ResourcePickerErrorCode, reason: string) {
    super(`resource picker: ${reason}`)
    this.name = "ResourcePickerError"
  }
}

/** Bounded picker over explicit context resources and policy-authorized workspace files. */
export class WorkbenchResourcePicker {
  private readonly maxEntries: number
  private entries: readonly WorkbenchResourceEntry[] = []

  constructor(
    private readonly policy: WorkspacePolicy,
    private readonly context: ContextResourceSet,
    options: { readonly maxEntries?: number } = {},
  ) {
    this.maxEntries = options.maxEntries ?? 512
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 2_048)
      throw new ResourcePickerError("RESOURCE_PICKER_LIMIT", "maxEntries is invalid")
  }

  async refresh(): Promise<readonly WorkbenchResourceEntry[]> {
    const contextEntries = this.context.list().map(toContextEntry)
    const workspaceEntries = await this.policy.list("", 3, this.maxEntries)
    const files = workspaceEntries
      .filter((entry) => entry.type === "file")
      .map((entry) => Object.freeze({ id: `file:${entry.path}`, kind: "file" as const, path: entry.path, bytes: entry.bytes }))
    const seen = new Set<string>()
    const entries: WorkbenchResourceEntry[] = []
    for (const entry of [...contextEntries, ...files]) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      entries.push(entry)
      if (entries.length >= this.maxEntries) break
    }
    this.entries = Object.freeze(entries)
    return this.entries
  }

  list(query = ""): readonly WorkbenchResourceEntry[] {
    if (typeof query !== "string" || query.length > 256) throw new ResourcePickerError("RESOURCE_PICKER_INVALID", "query is invalid")
    const normalized = query.toLowerCase()
    return Object.freeze(this.entries.filter((entry) => entry.id.toLowerCase().includes(normalized) || entry.path?.toLowerCase().includes(normalized) === true))
  }

  select(id: string): WorkbenchResourceSelection {
    if (typeof id !== "string" || id.length === 0 || id.length > 512) throw new ResourcePickerError("RESOURCE_PICKER_INVALID", "resource id is invalid")
    const entry = this.entries.find((candidate) => candidate.id === id || candidate.path === id)
    if (entry === undefined) throw new ResourcePickerError("RESOURCE_NOT_FOUND", "resource is not available")
    const attachment = entry.path === undefined || entry.kind === "instruction" || entry.kind === "system" || entry.kind === "template" || entry.kind === "skill" || entry.kind === "theme" || entry.kind === "mcp"
      ? undefined
      : Object.freeze({ path: entry.path, kind: isImagePath(entry.path) ? "image" as const : "file" as const })
    return Object.freeze({ ...entry, ...(attachment === undefined ? {} : { attachment }) })
  }

  entriesSnapshot(): readonly WorkbenchResourceEntry[] {
    return this.entries
  }
}

export async function createWorkbenchResourcePicker(
  policy: WorkspacePolicy,
  context: ContextResourceSet,
  options: { readonly maxEntries?: number } = {},
): Promise<WorkbenchResourcePicker> {
  const picker = new WorkbenchResourcePicker(policy, context, options)
  await picker.refresh()
  return picker
}

function toContextEntry(resource: ContextResource): WorkbenchResourceEntry {
  return Object.freeze({ id: `context:${resource.id}`, kind: resource.kind, ...(resource.path === undefined ? {} : { path: resource.path }), bytes: Buffer.byteLength(resource.content, "utf8") })
}

function isImagePath(path: string): boolean {
  return /\.(gif|jpeg|jpg|png|webp)$/i.test(path)
}
