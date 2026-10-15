import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import {
  EVERYWHERE,
  entries,
  fileAt,
  forEachLine,
  HEAD_BYTES,
  ID_PATTERN,
  isInjected,
  isRecord,
  jsonLines,
  MAX_FILE_BYTES,
  readHead,
  TooLarge,
  traceRead,
  within,
  type ExternalReader,
  type ListedSession,
  type RecordSink,
  type Workspace,
} from "./common.ts"

/**
 * Gemini CLI's sessions: `~/.gemini/tmp/<project>/chats/session-*.jsonl`, a header line
 * and then updates that set the message list, or an older single `session-*.json`. The project's
 * folder is in `.project_root` beside `chats`; an older project folder is named for the hash of
 * its path instead. Only those files are read; `~/.gemini` keeps the sign-in elsewhere.
 */

const CHAT_FILE = /^session-.+\.jsonl?$/
const MAX_ROOT_BYTES = 4 * 1024
const MAX_READS = 1_500
/** An older chat is one JSON document, read whole; past this it is skipped. */
const MAX_JSON_BYTES = 32 * 1024 * 1024

interface Chat {
  readonly path: string
  readonly cwd: string
  readonly mtime: number
  readonly bytes: number
}

export function geminiReader(root: string): ExternalReader {
  return {
    async list(workspace: Workspace, limit: number) {
      const chats = (await chatsIn(root, workspace)).sort((left, right) => right.mtime - left.mtime)
      const sessions: ListedSession[] = []
      let index = 0
      for (; index < chats.length && sessions.length < limit && index < MAX_READS; index += 1) {
        const chat = chats[index]!
        const head = await headOf(chat).catch(() => undefined)
        if (head !== undefined) sessions.push({ id: head.id, cwd: chat.cwd, ...(head.title === undefined ? {} : { title: head.title }), updatedAt: chat.mtime, bytes: chat.bytes })
      }
      return { sessions, truncated: index < chats.length }
    },

    async read(id: string, workspace: Workspace, sink: RecordSink) {
      // A chat's file name ends with the start of its session id, so that file is looked at first.
      const chats = (await chatsIn(root, workspace)).sort((left, right) => Number(right.path.includes(id.slice(0, 8))) - Number(left.path.includes(id.slice(0, 8))))
      for (const chat of chats) {
        const head = await headOf(chat).catch(() => undefined)
        if (head?.id !== id) continue
        if (chat.bytes > MAX_FILE_BYTES) throw new TooLarge()
        for (const message of await messagesOf(chat)) convert(message, sink)
        return { id, cwd: chat.cwd, ...(head.title === undefined ? {} : { title: head.title }), updatedAt: chat.mtime, bytes: chat.bytes }
      }
      return undefined
    },
  }
}

async function chatsIn(root: string, workspace: Workspace): Promise<Chat[]> {
  const hashes = new Map(workspace.roots.map((folder) => [createHash("sha256").update(folder).digest("hex"), folder]))
  const result: Chat[] = []
  for (const project of await entries(root)) {
    if (!project.isDirectory()) continue
    const folder = join(root, project.name)
    const cwd = (await projectRoot(folder)) ?? hashes.get(project.name)
    if (cwd === undefined || (workspace !== EVERYWHERE && !within(workspace, cwd))) continue
    for (const file of await entries(join(folder, "chats"))) {
      if (!file.isFile() || !CHAT_FILE.test(file.name)) continue
      const path = join(folder, "chats", file.name)
      const info = await fileAt(path)
      if (info !== undefined) result.push({ path, cwd, ...info })
    }
  }
  return result
}

async function projectRoot(folder: string): Promise<string | undefined> {
  const path = join(folder, ".project_root")
  const info = await fileAt(path)
  if (info === undefined || info.bytes > MAX_ROOT_BYTES) return undefined
  const text = (await readHead(path, MAX_ROOT_BYTES).catch(() => "")).trim()
  return isAbsolute(text) ? text : undefined
}

/** The session id and its first prompt, from the head of the file. */
async function headOf(chat: Chat): Promise<{ readonly id: string; readonly title?: string } | undefined> {
  const text = await readHead(chat.path, HEAD_BYTES)
  let id: unknown
  let messages: unknown
  if (chat.path.endsWith(".jsonl")) {
    let list: unknown[] | undefined
    for (const line of jsonLines(text, false, chat.bytes > HEAD_BYTES)) {
      id ??= line.sessionId
      list = applied(line, list) ?? list
    }
    messages = list
  } else if (chat.bytes <= HEAD_BYTES) {
    const record = safeRecord(text)
    id = record?.sessionId
    messages = record?.messages
  } else {
    id = /"sessionId"\s*:\s*"([^"]+)"/.exec(text)?.[1]
  }
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return undefined
  const title = Array.isArray(messages) ? messages.map((message) => (isRecord(message) && message.type === "user" ? textOf(message.content) : undefined)).find((value) => value !== undefined && !isInjected(value)) : undefined
  return { id, ...(title === undefined ? {} : { title }) }
}

/** The message list as the file leaves it: the last update that set it, and any added after. */
async function messagesOf(chat: Chat): Promise<readonly unknown[]> {
  if (!chat.path.endsWith(".jsonl")) {
    if (chat.bytes > MAX_JSON_BYTES) throw new TooLarge()
    traceRead(chat.path, "whole")
    const record = safeRecord(await readFile(chat.path, "utf8"))
    return Array.isArray(record?.messages) ? record.messages : []
  }
  let messages: unknown[] = []
  await forEachLine(chat.path, (line) => {
    messages = applied(line, messages) ?? messages
  })
  return messages
}

/** One update line applied to the message list; undefined when it does not touch it. */
function applied(line: Record<string, unknown>, messages: unknown[] | undefined): unknown[] | undefined {
  const set = isRecord(line.$set) ? line.$set : undefined
  if (set !== undefined) {
    let next = Array.isArray(set.messages) ? [...set.messages] : undefined
    for (const [key, value] of Object.entries(set)) {
      const index = /^messages\.(\d{1,6})$/.exec(key)?.[1]
      if (index === undefined) continue
      next ??= [...(messages ?? [])]
      next[Number(index)] = value
    }
    return next
  }
  const push = isRecord(line.$push) ? line.$push.messages : undefined
  if (push !== undefined) return [...(messages ?? []), ...(Array.isArray(push) ? push : [push])]
  // A message written as a line of its own.
  if (typeof line.type === "string" && typeof line.id === "string" && "content" in line) return [...(messages ?? []), line]
  return undefined
}

function convert(message: unknown, sink: RecordSink): void {
  if (!isRecord(message)) return
  const at = sink.time(message.timestamp)
  if (message.type === "user") {
    const text = textOf(message.content)
    if (text !== undefined && !isInjected(text)) sink.user(text, at)
    return
  }
  if (message.type !== "gemini") return
  const text = textOf(message.content)
  if (text !== undefined) sink.assistant(text, at)
  if (!Array.isArray(message.toolCalls)) return
  for (const call of message.toolCalls) {
    if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string") continue
    const when = sink.time(call.timestamp)
    sink.toolStarted(call.id, call.name, call.args, when)
    if (call.status === "success" || call.status === "error" || call.status === "cancelled")
      sink.toolCompleted(call.id, call.name, call.status === "success", resultOf(call.result) ?? (typeof call.resultDisplay === "string" ? call.resultDisplay : undefined), when)
  }
}

/** A message's text: a string, or its text parts; thoughts are left out. */
function textOf(content: unknown): string | undefined {
  const parts = typeof content === "string" ? [content] : (Array.isArray(content) ? content : [content]).map((part) => (isRecord(part) && part.thought !== true && typeof part.text === "string" ? part.text : undefined))
  const text = parts.filter((part): part is string => part !== undefined).join("\n")
  return text.trim().length === 0 ? undefined : text
}

function resultOf(result: unknown): string | undefined {
  const parts = Array.isArray(result) ? result : [result]
  const texts: string[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (typeof part.text === "string") texts.push(part.text)
    const response = isRecord(part.functionResponse) && isRecord(part.functionResponse.response) ? part.functionResponse.response : undefined
    if (response === undefined) continue
    if (typeof response.output === "string") texts.push(response.output)
    else if (typeof response.error === "string") texts.push(response.error)
    else texts.push(JSON.stringify(response))
  }
  const text = texts.join("\n")
  return text.length === 0 ? undefined : text
}

function safeRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}
