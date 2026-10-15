import { join } from "node:path"
import {
  entries,
  fileAt,
  forEachLine,
  headAndTail,
  ID_PATTERN,
  isInjected,
  isRecord,
  MAX_FILE_BYTES,
  parseArguments,
  readHead,
  TooLarge,
  within,
  type ExternalReader,
  type ListedSession,
  type RecordSink,
  type Workspace,
} from "./common.ts"

/**
 * GitHub Copilot CLI's sessions: `~/.copilot/session-state/<id>/`, with the session's
 * folder, name and branch in `workspace.yaml` and its events in `events.jsonl`. Only those two
 * files are read; `~/.copilot` keeps its sign-in and settings elsewhere.
 */

const MAX_YAML_BYTES = 16 * 1024
const MAX_READS = 1_500

interface Folder {
  readonly id: string
  readonly events: string
  readonly mtime: number
  readonly bytes: number
}

interface Facts {
  readonly cwd?: string
  readonly title?: string
  readonly branch?: string
}

export function copilotReader(root: string): ExternalReader {
  return {
    async list(workspace: Workspace, limit: number) {
      const folders: Folder[] = []
      for (const entry of await entries(root)) {
        if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
        const folder = await folderAt(root, entry.name)
        if (folder !== undefined) folders.push(folder)
      }
      folders.sort((left, right) => right.mtime - left.mtime)
      const sessions: ListedSession[] = []
      let index = 0
      for (; index < folders.length && sessions.length < limit && index < MAX_READS; index += 1) {
        const folder = folders[index]!
        const facts = await factsOf(root, folder).catch(() => undefined)
        if (facts?.cwd !== undefined && within(workspace, facts.cwd)) sessions.push(listed(folder, facts, facts.cwd))
      }
      return { sessions, truncated: index < folders.length }
    },

    async read(id: string, workspace: Workspace, sink: RecordSink) {
      if (!ID_PATTERN.test(id)) return undefined
      const folder = await folderAt(root, id)
      const facts = folder === undefined ? undefined : await factsOf(root, folder)
      if (folder === undefined || facts?.cwd === undefined || !within(workspace, facts.cwd)) return undefined
      if (folder.bytes > MAX_FILE_BYTES) throw new TooLarge()
      await forEachLine(folder.events, (line) => convert(line, sink))
      return listed(folder, facts, facts.cwd)
    },
  }
}

async function folderAt(root: string, id: string): Promise<Folder | undefined> {
  const events = join(root, id, "events.jsonl")
  const info = await fileAt(events)
  return info === undefined ? undefined : { id, events, ...info }
}

function listed(folder: Folder, facts: Facts, cwd: string): ListedSession {
  return { id: folder.id, cwd, ...(facts.title === undefined ? {} : { title: facts.title }), ...(facts.branch === undefined ? {} : { branch: facts.branch }), updatedAt: folder.mtime, bytes: folder.bytes }
}

/** The folder, name and branch from `workspace.yaml`, and what it lacks from the start of the events. */
async function factsOf(root: string, folder: Folder): Promise<Facts> {
  const yaml = join(root, folder.id, "workspace.yaml")
  const info = await fileAt(yaml)
  const fields = info === undefined || info.bytes > MAX_YAML_BYTES ? new Map<string, string>() : scalars(await readHead(yaml, MAX_YAML_BYTES))
  const named = fields.get("user_named") === "true" ? fields.get("name") : undefined
  let cwd = fields.get("cwd")
  let title = named ?? fields.get("summary") ?? fields.get("name")
  if (cwd === undefined || title === undefined) {
    const { head } = await headAndTail(folder.events, folder.bytes)
    for (const line of head) {
      const data = isRecord(line.data) ? line.data : undefined
      if (cwd === undefined && line.type === "session.start" && isRecord(data?.context) && typeof data.context.cwd === "string") cwd = data.context.cwd
      if (title === undefined && line.type === "user.message" && typeof data?.content === "string" && !isInjected(data.content)) title = data.content
    }
  }
  const branch = fields.get("branch")
  return { ...(cwd === undefined ? {} : { cwd }), ...(title === undefined ? {} : { title }), ...(branch === undefined ? {} : { branch }) }
}

/** The top-level `key: value` lines of a YAML file; quoted values are unquoted, and anything nested is ignored. */
function scalars(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of text.split("\n")) {
    const match = /^([a-z_]+):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (match === null || match[2] === undefined || match[2].length === 0) continue
    const raw = match[2]
    const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw)
    let value = raw
    if (quoted?.[1] !== undefined) {
      try {
        value = raw.startsWith('"') ? (JSON.parse(raw) as string) : quoted[1].replace(/''/g, "'")
      } catch {
        value = quoted[1]
      }
    }
    fields.set(match[1]!, value)
  }
  return fields
}

function convert(line: Record<string, unknown>, sink: RecordSink): void {
  const data = isRecord(line.data) ? line.data : undefined
  if (data === undefined) return
  const at = sink.time(line.timestamp)
  if (line.type === "user.message") {
    // `content` is what the person typed; `transformedContent` adds what the CLI injected.
    if (typeof data.content === "string" && !isInjected(data.content)) sink.user(data.content, at)
  } else if (line.type === "assistant.message") {
    if (typeof data.content === "string") sink.assistant(data.content, at)
    if (!Array.isArray(data.toolRequests)) return
    for (const request of data.toolRequests) {
      if (isRecord(request) && typeof request.toolCallId === "string" && typeof request.name === "string") sink.toolStarted(request.toolCallId, request.name, parseArguments(request.arguments), at)
    }
  } else if (line.type === "tool.execution_complete" && typeof data.toolCallId === "string") {
    const result = isRecord(data.result) ? data.result : undefined
    const error = isRecord(data.error) ? data.error : undefined
    const output = typeof result?.content === "string" ? result.content : typeof error?.message === "string" ? error.message : undefined
    sink.toolCompleted(data.toolCallId, undefined, data.success === true, output, at)
  }
}
