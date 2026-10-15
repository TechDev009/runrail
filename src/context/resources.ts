import { lstat, open, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { NativeModelPort, NativeModelRequest } from "@nifrajs/coding-agent"
import type { WorkspacePolicy } from "../workspace/policy.ts"
import { SkillRegistry, type SkillDescriptor } from "../skills/registry.ts"
import {
  isImageMediaType,
  type RunrailContentPart,
  type RunrailContentPartInput,
} from "../model/content.ts"

export type ContextResourceKind = "instruction" | "system" | "template" | "skill" | "theme" | "mcp"

export interface ContextResource {
  readonly id: string
  readonly kind: ContextResourceKind
  readonly path?: string
  readonly content: string
}

/** Backward-compatible path attachment accepted by native session callers. */
export interface PromptAttachment {
  readonly path: string
  readonly kind: "file" | "image"
  readonly mediaType?: string
}

export interface RunrailPromptInput {
  readonly text: string
  readonly attachments?: readonly PromptAttachment[]
  readonly parts?: readonly RunrailContentPartInput[]
  /** Ids of skills the user invoked; each one's full instructions go with this prompt. */
  readonly skills?: readonly string[]
}

export interface ContextResourceOptions {
  readonly instructionFiles?: readonly string[]
  readonly systemPrompt?: string
  readonly promptTemplates?: Readonly<Record<string, string>>
  /**
   * Skill files or folders named by the caller, read with the skill registry's rules as strict
   * explicit sources and listed like every other skill. Give them as registry sources instead when
   * a `skillRegistry` is supplied; the two together are refused.
   */
  readonly skillPaths?: readonly string[]
  readonly themePaths?: readonly string[]
  /**
   * Normalized local skills supplied by a caller-owned registry. The context lists them by id and
   * description only; a body is loaded when the model asks for it or the user invokes the skill.
   */
  readonly skillRegistry?: import("../skills/registry.ts").SkillRegistry
  /** Byte budget of the skill listing. Default 16 KiB, 1 KiB to 64 KiB. */
  readonly maxSkillCatalogBytes?: number
  /** Skills named in the listing. Default 256, at most 512. */
  readonly maxSkillCatalogEntries?: number
  /** Additional already-admitted resources supplied by a caller-owned plugin host. */
  readonly additionalResources?: readonly ContextResource[]
  readonly maxResourceBytes?: number
  readonly maxResources?: number
  readonly maxReferenceBytes?: number
  readonly maxReferences?: number
  readonly maxContentParts?: number
}
export type PromptTemplateValues = Readonly<Record<string, string>>

export interface PreparedPrompt {
  readonly text: string
  readonly attachments: readonly PromptAttachment[]
  /** Transient canonical content parts. This field is never persisted as evidence. */
  readonly parts: readonly RunrailContentPart[]
}

export type ContextResourceErrorCode =
  | "CONTEXT_INVALID"
  | "CONTEXT_REFERENCE_NOT_FOUND"
  | "CONTEXT_LIMIT"
  | "CONTEXT_MEDIA_UNSUPPORTED"

const MAX_INVOKED_SKILLS = 8
const SKILL_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/
/** A prompt that opens with `/skill:<id>` invokes that skill, as in Pi. */
const SKILL_INVOCATION = /^\/skill:([A-Za-z][A-Za-z0-9._:-]{0,127})(?=\s|$)/

export class ContextResourceError extends Error {
  constructor(readonly code: ContextResourceErrorCode, reason: string) {
    super(`context resources: ${reason}`)
    this.name = "ContextResourceError"
  }
}

/** Explicit project context loader with bounded, transient content-part preparation. */
export class ContextResourceSet {
  private readonly options: Required<
    Pick<ContextResourceOptions, "maxResourceBytes" | "maxResources" | "maxReferenceBytes" | "maxReferences" | "maxContentParts">
  >
  private resources: readonly ContextResource[]
  private readonly policy: WorkspacePolicy
  private readonly sourceOptions: ContextResourceOptions

  constructor(policy: WorkspacePolicy, resources: readonly ContextResource[], options: ContextResourceOptions = {}) {
    this.policy = policy
    this.sourceOptions = Object.freeze({ ...options })
    this.resources = Object.freeze([...resources])
    this.options = {
      maxResourceBytes: options.maxResourceBytes ?? 256 * 1024,
      maxResources: options.maxResources ?? 64,
      maxReferenceBytes: options.maxReferenceBytes ?? 256 * 1024,
      maxReferences: options.maxReferences ?? 16,
      maxContentParts: options.maxContentParts ?? 32,
    }
    if (
      !Number.isSafeInteger(this.options.maxResourceBytes) ||
      this.options.maxResourceBytes < 1 ||
      this.options.maxResourceBytes > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(this.options.maxResources) ||
      this.options.maxResources < 1 ||
      this.options.maxResources > 256 ||
      !Number.isSafeInteger(this.options.maxReferenceBytes) ||
      this.options.maxReferenceBytes < 1 ||
      this.options.maxReferenceBytes > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(this.options.maxReferences) ||
      this.options.maxReferences < 1 ||
      this.options.maxReferences > 64 ||
      !Number.isSafeInteger(this.options.maxContentParts) ||
      this.options.maxContentParts < 1 ||
      this.options.maxContentParts > 64
    )
      throw new ContextResourceError("CONTEXT_INVALID", "context limits are invalid")
  }

  list(): readonly ContextResource[] {
    return this.resources
  }

  /** The registry behind the skill listing and invocations, for wiring a `skill_read` tool to it. */
  skillRegistry(): SkillRegistry | undefined {
    return this.sourceOptions.skillRegistry
  }

  text(): string {
    return this.resources
      .map((resource) => `[${resource.kind}:${resource.id}]\n${resource.content}`)
      .join("\n\n")
  }

  getTemplate(id: string): string {
    const safeId = validateTemplateId(id)
    const template = this.resources.find((resource) => resource.kind === "template" && resource.id === safeId)
    if (template === undefined) throw new ContextResourceError("CONTEXT_REFERENCE_NOT_FOUND", "prompt template is not available")
    return template.content
  }

  expandTemplate(id: string, values: PromptTemplateValues = {}): string {
    const template = this.getTemplate(id)
    validateTemplateValues(values)
    return template.replace(/\{\{([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g, (placeholder, name: string) => {
      const value = values[name]
      if (value === undefined) throw new ContextResourceError("CONTEXT_INVALID", `template value '${name}' is missing`)
      return value
    })
  }

  async prepareTemplate(id: string, values: PromptTemplateValues = {}): Promise<PreparedPrompt> {
    return this.prepare(this.expandTemplate(id, values))
  }

  async reload(): Promise<readonly ContextResource[]> {
    const refreshed = await createContextResourceSet(this.policy, this.sourceOptions)
    this.resources = refreshed.list()
    return this.resources
  }

  async prepare(input: string | RunrailPromptInput): Promise<PreparedPrompt> {
    const parsed = parsePromptInput(input)
    const references = findReferences(parsed.text)
    if (references.length > this.options.maxReferences)
      throw new ContextResourceError("CONTEXT_LIMIT", "too many @file references")
    const attachments: PromptAttachment[] = []
    const parts: RunrailContentPart[] = [{ kind: "text", text: parsed.text }]
    let text = parsed.text
    for (const reference of references) {
      const path = await this.inlineReference(reference)
      if (path === undefined) continue
      const prepared = await this.preparePathPart(path)
      this.pushPart(parts, prepared)
      if (prepared.kind === "file") {
        attachments.push({ path, kind: "file", ...(prepared.mediaType === undefined ? {} : { mediaType: prepared.mediaType }) })
        text += `\n\n[Runrail file reference: ${path}]\n${prepared.text}\n[End file reference]`
      } else if (prepared.kind === "image") {
        attachments.push({ path, kind: "image", mediaType: prepared.mediaType })
        text += `\n\n[Runrail image reference: ${path}; media type: ${prepared.mediaType}]`
      }
    }
    for (const attachment of parsed.attachments ?? []) {
      const prepared = await this.preparePathPart(attachment.path, attachment.kind, attachment.mediaType)
      this.pushPart(parts, prepared)
      if (prepared.kind === "file") {
        attachments.push({ path: attachment.path, kind: "file", ...(prepared.mediaType === undefined ? {} : { mediaType: prepared.mediaType }) })
        text += `\n\n[Runrail file attachment: ${attachment.path}]\n${prepared.text}\n[End file attachment]`
      } else if (prepared.kind === "image") {
        attachments.push({ path: attachment.path, kind: "image", mediaType: prepared.mediaType })
        text += `\n\n[Runrail image attachment: ${attachment.path}; media type: ${prepared.mediaType}]`
      }
    }
    for (const part of parsed.parts ?? []) {
      const prepared = await this.prepareInputPart(part)
      this.pushPart(parts, prepared)
      if (prepared.kind === "text") text += `\n\n${prepared.text}`
      else if (prepared.kind === "file") text += `\n\n[Runrail file part: ${prepared.path}]\n${prepared.text}\n[End file part]`
      else if (prepared.kind === "image") text += `\n\n[Runrail image part: ${prepared.path ?? "inline"}; media type: ${prepared.mediaType}]`
      else text += `\n\n[Runrail binary part: ${prepared.mediaType}; bytes: ${prepared.bytes}]`
    }
    for (const skill of this.invokedSkills(parsed)) {
      const block = `[Runrail skill: ${skill.id}]\n${skill.content}\n[End skill]`
      this.pushPart(parts, { kind: "text", text: block })
      text += `\n\n${block}`
    }
    return Object.freeze({ text, attachments: Object.freeze(attachments), parts: Object.freeze(parts) })
  }

  /**
   * Skills the user invoked: a leading `/skill:<id>` and the input's `skills`. Without a registry
   * (a coding tool reads skills itself) the text is passed on as written and listed ids are refused.
   */
  private invokedSkills(input: RunrailPromptInput): readonly SkillDescriptor[] {
    const registry = this.sourceOptions.skillRegistry
    const leading = registry === undefined ? undefined : SKILL_INVOCATION.exec(input.text)?.[1]
    const ids = [...new Set([...(leading === undefined ? [] : [leading]), ...(input.skills ?? [])])]
    if (ids.length === 0) return Object.freeze([])
    if (ids.length > MAX_INVOKED_SKILLS) throw new ContextResourceError("CONTEXT_LIMIT", "too many invoked skills")
    if (registry === undefined) throw new ContextResourceError("CONTEXT_REFERENCE_NOT_FOUND", "skills are not available for this session")
    return Object.freeze(ids.map((id) => {
      const skill = registry.get(id)
      if (skill === undefined) throw new ContextResourceError("CONTEXT_REFERENCE_NOT_FOUND", `skill '${id}' is not available`)
      if (Buffer.byteLength(skill.content, "utf8") > this.options.maxReferenceBytes) throw new ContextResourceError("CONTEXT_LIMIT", "invoked skill exceeds byte limit")
      return skill
    }))
  }

  private pushPart(parts: RunrailContentPart[], part: RunrailContentPart): void {
    if (parts.length >= this.options.maxContentParts)
      throw new ContextResourceError("CONTEXT_LIMIT", "too many content parts")
    parts.push(Object.freeze(part))
  }

  private async prepareInputPart(part: RunrailContentPartInput): Promise<RunrailContentPart> {
    if (part.kind === "text") {
      assertContent(part.text, this.options.maxReferenceBytes, "text part")
      return { kind: "text", text: part.text }
    }
    if (part.kind === "file") return this.preparePathPart(part.path, "file", part.mediaType)
    if (part.kind === "image") {
      if (part.path !== undefined) return this.preparePathPart(part.path, "image", part.mediaType)
      if (part.dataBase64 === undefined) throw new ContextResourceError("CONTEXT_INVALID", "image part needs path or data")
      return prepareInlineBinary(part.dataBase64, part.mediaType, "image", this.options.maxReferenceBytes)
    }
    return prepareInlineBinary(part.dataBase64, part.mediaType, "binary", this.options.maxReferenceBytes)
  }

  /**
   * The file an inline `@name` points at, or undefined when it names nothing to attach (a package
   * like `@types/node`, a folder), so the prompt keeps it as plain text. Prose often puts a period
   * after a path, which is tried without it. A path outside the workspace is still refused.
   */
  private async inlineReference(reference: string): Promise<string | undefined> {
    const trimmed = reference.replace(/\.+$/, "")
    for (const candidate of trimmed.length === 0 || trimmed === reference ? [reference] : [reference, trimmed]) {
      let absolute: string
      try {
        absolute = await this.policy.resolveExisting(candidate)
      } catch (error) {
        if (isNotFound(error)) continue
        throw new ContextResourceError("CONTEXT_REFERENCE_NOT_FOUND", error instanceof Error ? error.message : "attachment could not be resolved")
      }
      return (await stat(absolute)).isFile() ? candidate : undefined
    }
    return undefined
  }

  private async preparePathPart(
    path: string,
    requestedKind?: "file" | "image",
    requestedMediaType?: string,
  ): Promise<RunrailContentPart> {
    if (typeof path !== "string" || path.length === 0 || path.length > 512)
      throw new ContextResourceError("CONTEXT_INVALID", "attachment path is invalid")
    let absolute: string
    try {
      absolute = await this.policy.resolveExisting(path)
    } catch (error) {
      throw new ContextResourceError(
        "CONTEXT_REFERENCE_NOT_FOUND",
        error instanceof Error ? error.message : "attachment could not be resolved",
      )
    }
    if ((await stat(absolute)).size > this.options.maxReferenceBytes)
      throw new ContextResourceError("CONTEXT_LIMIT", "attachment exceeds byte limit")
    const bytes = await readFile(absolute)
    if (bytes.length > this.options.maxReferenceBytes)
      throw new ContextResourceError("CONTEXT_LIMIT", "attachment exceeds byte limit")
    const detected = detectImage(bytes)
    const imageRequested = requestedKind === "image" || (requestedKind === undefined && detected !== undefined)
    if (imageRequested) {
      if (detected === undefined) throw new ContextResourceError("CONTEXT_MEDIA_UNSUPPORTED", "image bytes are not recognized")
      if (requestedMediaType !== undefined && requestedMediaType !== detected)
        throw new ContextResourceError("CONTEXT_MEDIA_UNSUPPORTED", "image media type does not match its bytes")
      return {
        kind: "image",
        path,
        mediaType: detected,
        dataBase64: bytes.toString("base64"),
        bytes: bytes.length,
      }
    }
    const text = bytes.toString("utf8")
    if (text.includes("\0")) throw new ContextResourceError("CONTEXT_MEDIA_UNSUPPORTED", "binary file needs an explicit binary part")
    if (requestedMediaType !== undefined && !isTextMediaType(requestedMediaType))
      throw new ContextResourceError("CONTEXT_MEDIA_UNSUPPORTED", "file media type is unsupported")
    return { kind: "file", path, text, ...(requestedMediaType === undefined ? {} : { mediaType: requestedMediaType }) }
  }
}

export async function createContextResourceSet(
  policy: WorkspacePolicy,
  options: ContextResourceOptions = {},
): Promise<ContextResourceSet> {
  const maxResourceBytes = options.maxResourceBytes ?? 256 * 1024
  const maxResources = options.maxResources ?? 64
  const maxSkillCatalogBytes = options.maxSkillCatalogBytes ?? 16 * 1024
  const maxSkillCatalogEntries = options.maxSkillCatalogEntries ?? 256
  if (!Number.isSafeInteger(maxResourceBytes) || maxResourceBytes < 1 || maxResourceBytes > 4 * 1024 * 1024)
    throw new ContextResourceError("CONTEXT_INVALID", "maxResourceBytes is invalid")
  if (!Number.isSafeInteger(maxResources) || maxResources < 1 || maxResources > 256)
    throw new ContextResourceError("CONTEXT_INVALID", "maxResources is invalid")
  if (!Number.isSafeInteger(maxSkillCatalogBytes) || maxSkillCatalogBytes < 1_024 || maxSkillCatalogBytes > 64 * 1024)
    throw new ContextResourceError("CONTEXT_INVALID", "maxSkillCatalogBytes is invalid")
  if (!Number.isSafeInteger(maxSkillCatalogEntries) || maxSkillCatalogEntries < 1 || maxSkillCatalogEntries > 512)
    throw new ContextResourceError("CONTEXT_INVALID", "maxSkillCatalogEntries is invalid")
  const resources: ContextResource[] = []
  const instructionFiles = options.instructionFiles ?? ["AGENTS.md", "CLAUDE.md"]
  for (const path of instructionFiles) {
    const content = await readInstructions(policy, path, maxResourceBytes)
    if (content !== undefined) resources.push({ id: path, kind: "instruction", path, content })
  }
  if (options.systemPrompt !== undefined) {
    assertContent(options.systemPrompt, maxResourceBytes, "system prompt")
    resources.push({ id: "system", kind: "system", content: options.systemPrompt })
  }
  for (const [id, content] of Object.entries(options.promptTemplates ?? {})) {
    assertContent(id, 128, "template id")
    assertContent(content, maxResourceBytes, "prompt template")
    resources.push({ id, kind: "template", content })
  }
  const skillPaths = options.skillPaths ?? []
  if (!Array.isArray(skillPaths) || skillPaths.length > 64 || skillPaths.some((path) => typeof path !== "string" || path.length === 0 || path.length > 512))
    throw new ContextResourceError("CONTEXT_INVALID", "skillPaths are invalid")
  if (skillPaths.length > 0 && options.skillRegistry !== undefined)
    throw new ContextResourceError("CONTEXT_INVALID", "skillPaths cannot be combined with skillRegistry; add them as registry sources")
  const skillRegistry = options.skillRegistry ?? (skillPaths.length === 0 ? undefined : new SkillRegistry(policy, { sources: skillPaths.map((path) => ({ path, scope: "explicit" as const })) }))
  if (skillRegistry !== undefined) {
    await skillRegistry.reload()
    // One bounded listing however many skills are installed, so they never crowd out other context.
    const catalog = skillRegistry.catalog({ maxBytes: maxSkillCatalogBytes, maxEntries: maxSkillCatalogEntries })
    if (catalog !== undefined) {
      resources.push(Object.freeze({ id: "catalog", kind: "skill" as const, content: catalog }))
      if (resources.length > maxResources) throw new ContextResourceError("CONTEXT_LIMIT", "too many context resources")
    }
  }
  await loadDirectories(policy, options.themePaths ?? [], "theme", resources, maxResourceBytes, maxResources)
  for (const resource of options.additionalResources ?? []) {
    validateAdditionalResource(resource, maxResourceBytes)
    resources.push(Object.freeze({ ...resource }))
    if (resources.length > maxResources) throw new ContextResourceError("CONTEXT_LIMIT", "too many context resources")
  }
  if (resources.length > maxResources)
    throw new ContextResourceError("CONTEXT_LIMIT", "too many context resources")
  // The set keeps the registry it built, so a reload rereads the same skills and keeps their toggles.
  const { skillPaths: _named, ...rest } = options
  return new ContextResourceSet(policy, resources, skillRegistry === undefined ? rest : { ...rest, skillRegistry })
}

/** Add explicit project context to transient model text without changing evidence storage. */
export function createContextAwareModelPort(
  inner: NativeModelPort,
  resources: ContextResourceSet,
): NativeModelPort & { takeUsage(): unknown } {
  return {
    complete(request: NativeModelRequest) {
      const preamble = resources.text()
      if (preamble.length === 0) return inner.complete(request)
      const hasContext = request.messages.some(
        (message) => message.role === "user" && message.text.startsWith("[Runrail project context]"),
      )
      if (hasContext) return inner.complete(request)
      const contextMessage = {
        role: "user" as const,
        text: `[Runrail project context]\n${preamble}\n[End Runrail project context]`,
      }
      return inner.complete({ ...request, messages: Object.freeze([contextMessage, ...request.messages]) })
    },
    takeUsage(): unknown {
      const source = inner as unknown
      return isRecord(source) && typeof source.takeUsage === "function" ? source.takeUsage() : undefined
    },
  }
}

/** Longest text a prompt may carry: one event's text, so the turn can show what was asked. */
export const MAX_PROMPT_CHARS = 256 * 1024

function parsePromptInput(value: string | RunrailPromptInput): RunrailPromptInput {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MAX_PROMPT_CHARS)
      throw new ContextResourceError("CONTEXT_INVALID", "prompt text is invalid")
    return { text: value }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ContextResourceError("CONTEXT_INVALID", "prompt input is invalid")
  if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_PROMPT_CHARS)
    throw new ContextResourceError("CONTEXT_INVALID", "prompt text is invalid")
  const attachments = value.attachments ?? []
  if (!Array.isArray(attachments) || attachments.length > 16)
    throw new ContextResourceError("CONTEXT_INVALID", "prompt attachments are invalid")
  for (const attachment of attachments) {
    if (
      attachment === null ||
      typeof attachment !== "object" ||
      typeof attachment.path !== "string" ||
      (attachment.kind !== "file" && attachment.kind !== "image") ||
      (attachment.mediaType !== undefined && typeof attachment.mediaType !== "string")
    )
      throw new ContextResourceError("CONTEXT_INVALID", "prompt attachment is invalid")
  }
  const parts = value.parts ?? []
  if (!Array.isArray(parts) || parts.length > 32)
    throw new ContextResourceError("CONTEXT_INVALID", "prompt content parts are invalid")
  for (const part of parts) validatePartInput(part)
  const skills: unknown = value.skills ?? []
  if (!Array.isArray(skills) || skills.length > MAX_INVOKED_SKILLS || !skills.every(isSkillId))
    throw new ContextResourceError("CONTEXT_INVALID", "prompt skills are invalid")
  return {
    text: value.text,
    attachments: Object.freeze([...attachments]),
    parts: Object.freeze([...parts]),
    ...(skills.length === 0 ? {} : { skills: Object.freeze([...skills]) }),
  }
}

function isSkillId(value: unknown): value is string {
  return typeof value === "string" && SKILL_ID.test(value)
}

function validatePartInput(value: unknown): asserts value is RunrailContentPartInput {
  if (!isRecord(value) || typeof value.kind !== "string")
    throw new ContextResourceError("CONTEXT_INVALID", "prompt content part is invalid")
  if (value.kind === "text") {
    if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > 256 * 1024)
      throw new ContextResourceError("CONTEXT_INVALID", "text part is invalid")
    return
  }
  if (value.kind === "file") {
    if (typeof value.path !== "string" || value.path.length === 0 || value.path.length > 512 || (value.mediaType !== undefined && typeof value.mediaType !== "string"))
      throw new ContextResourceError("CONTEXT_INVALID", "file part is invalid")
    return
  }
  if (value.kind === "image") {
    if ((value.path !== undefined && typeof value.path !== "string") || (value.dataBase64 !== undefined && typeof value.dataBase64 !== "string") || (value.mediaType !== undefined && typeof value.mediaType !== "string"))
      throw new ContextResourceError("CONTEXT_INVALID", "image part is invalid")
    if (value.path === undefined && value.dataBase64 === undefined)
      throw new ContextResourceError("CONTEXT_INVALID", "image part needs path or data")
    return
  }
  if (value.kind !== "binary" || typeof value.mediaType !== "string" || typeof value.dataBase64 !== "string")
    throw new ContextResourceError("CONTEXT_INVALID", "binary part is invalid")
}

function findReferences(text: string): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const pattern = /(?:^|\s)@([A-Za-z0-9_.][A-Za-z0-9_./-]{0,511})/g
  for (const match of text.matchAll(pattern)) {
    const path = match[1]
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return Object.freeze(result)
}

/**
 * Project instructions, following a link that stays inside the workspace (`CLAUDE.md -> AGENTS.md`
 * is common). A file over the limit is cut at it with a note rather than failing the session.
 */
async function readInstructions(policy: WorkspacePolicy, path: string, maxBytes: number): Promise<string | undefined> {
  let absolute: string
  try {
    const candidate = resolve(policy.root, path)
    if ((await lstat(candidate)).isSymbolicLink()) {
      absolute = await realpath(candidate)
      const inside = relative(policy.root, absolute)
      if (inside.startsWith("..") || isAbsolute(inside)) return undefined
      await policy.resolveExisting(inside)
    } else {
      absolute = await policy.resolveExisting(path)
    }
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  const info = await stat(absolute)
  if (!info.isFile()) return undefined
  if (info.size <= maxBytes) return readFile(absolute, "utf8")
  const handle = await open(absolute, "r")
  try {
    const note = `\n\n[Runrail: ${path.slice(0, 128)} is ${info.size} bytes; only the start is included]`
    const keep = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"))
    const buffer = Buffer.alloc(keep)
    const { bytesRead } = await handle.read(buffer, 0, keep, 0)
    return `${new TextDecoder().decode(buffer.subarray(0, bytesRead)).replace(/\uFFFD+$/, "")}${note}`
  } finally {
    await handle.close()
  }
}


async function loadDirectories(
  policy: WorkspacePolicy,
  paths: readonly string[],
  kind: "theme",
  resources: ContextResource[],
  maxResourceBytes: number,
  maxResources: number,
): Promise<void> {
  for (const directory of paths) {
    const entries = await policy.list(directory, 2, maxResources)
    for (const entry of entries) {
      if (entry.type !== "file") continue
      const content = await policy.read(entry.path, maxResourceBytes)
      resources.push({ id: entry.path, kind, path: entry.path, content })
      if (resources.length > maxResources) throw new ContextResourceError("CONTEXT_LIMIT", "too many context resources")
    }
  }
}

function validateAdditionalResource(resource: ContextResource, maxBytes: number): void {
  if (
    resource === null ||
    typeof resource !== "object" ||
    typeof resource.id !== "string" ||
    resource.id.length === 0 ||
    resource.id.length > 256 ||
    !/^(instruction|system|template|skill|theme|mcp)$/.test(resource.kind) ||
    typeof resource.content !== "string"
  )
    throw new ContextResourceError("CONTEXT_INVALID", "additional context resource is invalid")
  assertContent(resource.content, maxBytes, "additional context resource")
  if (resource.path !== undefined && (typeof resource.path !== "string" || resource.path.length === 0 || resource.path.length > 512))
    throw new ContextResourceError("CONTEXT_INVALID", "additional context resource path is invalid")
}
function validateTemplateId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value))
    throw new ContextResourceError("CONTEXT_INVALID", "template id is invalid")
  return value
}
function validateTemplateValues(values: PromptTemplateValues): void {
  if (values === null || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 64)
    throw new ContextResourceError("CONTEXT_LIMIT", "template values are invalid")
  let bytes = 0
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || typeof value !== "string" || value.length > 16 * 1024)
      throw new ContextResourceError("CONTEXT_INVALID", "template values are invalid")
    bytes += Buffer.byteLength(value, "utf8")
    if (bytes > 256 * 1024) throw new ContextResourceError("CONTEXT_LIMIT", "template values exceed the byte limit")
  }
}

function assertContent(value: string, maxBytes: number, name: string): void {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes)
    throw new ContextResourceError("CONTEXT_INVALID", `${name} is invalid`)
}

function prepareInlineBinary(
  dataBase64: string,
  requestedMediaType: string | undefined,
  requestedKind: "image" | "binary",
  maxBytes: number,
): RunrailContentPart {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64) || dataBase64.length > Math.ceil(maxBytes / 3) * 4 + 4)
    throw new ContextResourceError("CONTEXT_INVALID", "inline binary encoding is invalid")
  const bytes = Buffer.from(dataBase64, "base64")
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== dataBase64)
    throw new ContextResourceError("CONTEXT_LIMIT", "inline binary exceeds its bounds")
  const detected = detectImage(bytes)
  if (requestedKind === "image") {
    if (detected === undefined || (requestedMediaType !== undefined && requestedMediaType !== detected))
      throw new ContextResourceError("CONTEXT_MEDIA_UNSUPPORTED", "inline image bytes do not match media type")
    return { kind: "image", mediaType: detected, dataBase64, bytes: bytes.length }
  }
  if (requestedMediaType === undefined || !isAllowedBinaryMediaType(requestedMediaType))
    throw new ContextResourceError("CONTEXT_MEDIA_UNSUPPORTED", "binary media type is not allowed")
  return { kind: "binary", mediaType: requestedMediaType, dataBase64, bytes: bytes.length }
}

function detectImage(bytes: Uint8Array): import("../model/content.ts").ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif"
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  return undefined
}

function isTextMediaType(value: string): boolean {
  return value.startsWith("text/") || value === "application/json"
}

function isAllowedBinaryMediaType(value: string): boolean {
  return value === "application/pdf" || value === "application/zip" || value === "application/octet-stream"
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
