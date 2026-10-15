import { terminateProcessTree } from "../backend/process-tree.ts"
import { MODELS_SNAPSHOT } from "../providers/models-snapshot.ts"
import { CLAUDE_CODE_EFFORTS, isHarnessModelId } from "./launch.ts"
import type { HarnessModelDescriptor } from "./types.ts"

const MAX_MODELS = 64
const MAX_NAME = 64
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const REQUEST_ID = "runrail-models"
const KNOWN_EFFORTS: ReadonlySet<string> = new Set(CLAUDE_CODE_EFFORTS)

export interface ClaudeCodeModelOptions {
  /** The installed `claude` and any arguments before its own. */
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly timeoutMs: number
}

/**
 * The models Claude Code offers, asked of the installed `claude` itself on its stream-json control
 * channel (the `initialize` request the Agent SDK sends), each with the exact model its alias runs.
 * No prompt is sent, no settings are loaded so no hook runs, and only the `models` field of the
 * answer is read: the rest names the account. `undefined` when Claude Code did not answer in time.
 */
export async function listClaudeCodeModels(options: ClaudeCodeModelOptions): Promise<readonly HarnessModelDescriptor[] | undefined> {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">
  try {
    child = Bun.spawn([...options.argv, "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--setting-sources", ""], { cwd: options.cwd, env: { ...options.env }, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true })
  } catch {
    return undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "initialize" } })}\n`)
    await child.stdin.flush()
    const timedOut = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), options.timeoutMs) })
    return await Promise.race([readModels(child.stdout), timedOut])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    try { child.stdin.end() } catch { /* already closed */ }
    await terminateProcessTree({ pid: child.pid, exited: child.exited, kill: (signal) => void child.kill(signal) }).catch(() => undefined)
  }
}

async function readModels(stdout: ReadableStream<Uint8Array>): Promise<readonly HarnessModelDescriptor[] | undefined> {
  const decoder = new TextDecoder()
  let buffer = ""
  let read = 0
  for await (const chunk of stdout) {
    read += chunk.byteLength
    if (read > MAX_OUTPUT_BYTES) return undefined
    buffer += decoder.decode(chunk, { stream: true })
    let cut: number
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      const answer = controlAnswer(line)
      if (answer !== undefined) return answer.ok ? parseClaudeCodeModels(answer.models) : undefined
    }
  }
  return undefined
}

/** Our `initialize` answer, if this line is it. Only `models` is taken from it. */
function controlAnswer(line: string): { readonly ok: boolean; readonly models?: unknown } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.type !== "control_response" || !isRecord(parsed.response) || parsed.response.request_id !== REQUEST_ID) return undefined
  if (parsed.response.subtype !== "success" || !isRecord(parsed.response.response)) return { ok: false }
  return { ok: true, models: parsed.response.response.models }
}

/**
 * Claude Code's model rows, read as untrusted input. The `default` row is not a model of its own:
 * it marks the model it resolves to. A row is named by the version its description leads with
 * ("Opus 5.5 · ..."), so the menu says which model an alias runs.
 */
export function parseClaudeCodeModels(value: unknown): readonly HarnessModelDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows = value.slice(0, MAX_MODELS * 2).filter(isRecord)
  const fallback = rows.find((row) => row.value === "default")
  const defaultModel = fallback !== undefined && isHarnessModelId(fallback.resolvedModel) ? fallback.resolvedModel : undefined
  const models: HarnessModelDescriptor[] = []
  for (const row of rows) {
    if (row.value === "default" || !isHarnessModelId(row.value) || models.some((model) => model.id === row.value)) continue
    const resolved = isHarnessModelId(row.resolvedModel) ? row.resolvedModel : undefined
    const efforts = Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter((level): level is string => typeof level === "string" && KNOWN_EFFORTS.has(level)) : undefined
    models.push(Object.freeze({
      id: row.value,
      name: modelName(row) ?? row.value,
      ...(resolved === undefined ? {} : { resolved }),
      ...(defaultModel !== undefined && (resolved ?? row.value) === defaultModel ? { default: true } : {}),
      ...(efforts === undefined || efforts.length === 0 ? {} : { efforts: Object.freeze(efforts) }),
      // A model with no effort levels (Haiku) takes none, so no level is offered for it.
      ...(row.supportsEffort === false || efforts === undefined || efforts.length === 0 ? { reasoning: false } : {}),
    }))
    if (models.length >= MAX_MODELS) break
  }
  return models.length === 0 ? undefined : Object.freeze(models)
}

/**
 * Claude Code's own rows, then every other Claude model Runrail's catalog knows, newest first in
 * each family. Claude Code lists only its current aliases but runs any model id it is given; a
 * catalog row is marked `catalog`, since only the first message says whether the account may use it.
 */
export function withClaudeCatalog(listed: readonly HarnessModelDescriptor[], catalog = MODELS_SNAPSHOT.providers.anthropic ?? []): readonly HarnessModelDescriptor[] {
  const covered = new Set(listed.flatMap((model) => [model.id, model.resolved].filter((id): id is string => id !== undefined).map(baseModel)))
  const extra = new Map<string, HarnessModelDescriptor>()
  for (const entry of catalog) {
    if (!isHarnessModelId(entry.id) || !entry.id.startsWith("claude-")) continue
    const id = baseModel(entry.id)
    // Claude 3 models are retired; a dated id is the same model as its undated alias.
    if (id.startsWith("claude-3") || covered.has(id) || extra.has(id)) continue
    const name = (entry.name ?? id).replace(/^Claude /, "").replace(/ \(latest\)$/, "")
    extra.set(id, Object.freeze({ id, name: plainName(name) ? name : id, catalog: true }))
  }
  const ordered = [...extra.values()].sort((left, right) => familyOrder(left.id) - familyOrder(right.id) || right.id.localeCompare(left.id, "en", { numeric: true }))
  return Object.freeze([...listed, ...ordered].slice(0, MAX_MODELS))
}

/** The model without a release date or a context suffix: `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`. */
function baseModel(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "")
}

function familyOrder(id: string): number {
  const at = ["claude-opus", "claude-fable", "claude-sonnet", "claude-haiku"].findIndex((family) => id.startsWith(family))
  return at < 0 ? 4 : at
}

function modelName(row: Record<string, unknown>): string | undefined {
  const lead = typeof row.description === "string" ? row.description.split(" · ")[0]?.trim() : undefined
  // The description leads with the family and version; a lead without a number names no version.
  if (lead !== undefined && /\d/.test(lead) && plainName(lead)) return lead
  return typeof row.displayName === "string" && plainName(row.displayName.trim()) ? row.displayName.trim() : undefined
}

function plainName(text: string): boolean {
  return text.length > 0 && text.length <= MAX_NAME && /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]*$/u.test(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
