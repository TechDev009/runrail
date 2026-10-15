import type { NativeModelPort, NativeModelRequest } from "@nifrajs/coding-agent"

/**
 * The instructions a model gets when it runs on Runrail's own loop through a provider: who it
 * is here, where it is working, and how to use the tools it was given. Project instruction files
 * and the user's own instructions follow it and take precedence.
 */
export type PromptFamily = "anthropic" | "openai" | "generic"

export interface PromptEnvironment {
  readonly cwd: string
  /** Related folders of the project, reached by absolute path. */
  readonly folders?: readonly string[]
  /** Absent when the folder is not a git work tree, or git could not be asked. */
  readonly git?: { readonly branch?: string; readonly changedFiles?: number }
  readonly platform: string
  /** Local calendar date, `YYYY-MM-DD`. */
  readonly date: string
}

export interface DefaultPromptInput {
  readonly family: PromptFamily
  readonly environment: PromptEnvironment
  /** Names of the tools the model is offered. Rules are written only for tools that are there. */
  readonly tools: readonly string[]
  /** Plan mode offers no tool that changes anything. */
  readonly mode?: "plan" | "ask" | "auto"
}

/** The most the assembled instructions may be. Longer project context is cut at the end, and says so. */
export const MAX_SYSTEM_PROMPT_CHARS = 200_000
const CUT_NOTE = "\n\n[The rest of the project context was cut to fit.]"

export function promptFamily(provider: string, protocol: string | undefined, model: string): PromptFamily {
  const name = model.toLowerCase()
  if (protocol === "messages" || protocol === "anthropic-messages" || provider === "anthropic" || name.includes("claude")) return "anthropic"
  if (provider === "openai" || /(^|[/:._-])(gpt|o[1-9]|codex|chatgpt)([/:._-]|\d|$)/.test(name)) return "openai"
  return "generic"
}

export function defaultCodingPrompt(input: DefaultPromptInput): string {
  const has = (name: string): boolean => input.tools.includes(name)
  const edits = ["edit_file", "apply_patch", "write_file"].filter(has)
  const lines: string[] = [
    "You are Runrail, a coding agent working in the user's project on their own computer. You read code, change files, and run commands through the tools you are given, and you finish the task the user set.",
    "",
    "# How to work",
    "- Look before you change anything: read the files involved and search for where a name is used. Do not guess at file contents, paths, or APIs.",
    "- Keep each change as small as the task allows, and match the conventions of the code around it. Do not reformat, rename, or tidy things you were not asked to touch.",
    "- Finish what you start. If the task needs several steps, carry them out one after another instead of stopping to describe them.",
    "- When something fails, read the error, find the cause, and fix that. Do not repeat the same call hoping for a different answer.",
    "- Never claim a command ran, a test passed, or a file changed unless a tool result in this conversation shows it.",
    "- If the request is unclear in a way that changes what you would do, ask one short question. Otherwise pick the sensible reading and say which one you took.",
  ]
  lines.push("", "# Tools")
  lines.push("- Call one tool at a time and wait for its result. Arguments must be valid JSON that follows the tool's schema.")
  const related = (input.environment.folders?.length ?? 0) > 0
  lines.push(related ? "- Paths are relative to the working folder; a file in one of the related folders listed under Environment is named by its absolute path. You cannot read or write anywhere else." : "- Paths are relative to the working folder. You cannot read or write outside it.")
  if (has("search_files") || has("find_files")) lines.push(`- Find things with ${[has("search_files") ? "`search_files` (text inside files)" : undefined, has("find_files") ? "`find_files` (file names)" : undefined].filter((part) => part !== undefined).join(" and ")} before reading whole files.`)
  if (has("read_file")) lines.push("- Read a file with `read_file` before you edit it, and again if it may have changed since.")
  if (edits.length > 0) {
    const preferred = has("edit_file") ? "`edit_file`" : has("apply_patch") ? "`apply_patch`" : "`write_file`"
    lines.push(`- Change an existing file with ${preferred}${edits.length > 1 && has("write_file") && preferred !== "`write_file`" ? "; use `write_file` for a new file or a full rewrite" : ""}. Never print a file's new contents in your answer instead of writing them.`)
  }
  if (has("run_command")) lines.push("- `run_command` runs one program with its arguments in the working folder" + (related ? " (or in `cwd`, a folder inside a related folder)" : "") + ", with no shell (no pipes, redirects or `&&`). Prefer the project's own scripts. Do not start anything that does not end by itself (servers, watchers), and do not run commands that delete or overwrite work unless the user asked for exactly that.")
  if (has("run_verification")) lines.push("- After changing code, check it with `run_verification`. A change is not done while its check fails.")
  if (has("skill_read")) lines.push("- Installed skills are listed in the project context by id and description only. When the task matches one, load it with `skill_read` before you start and follow it.")
  if (has("update_plan")) lines.push("- For a task with several steps, keep a short plan with `update_plan` and mark steps as you finish them.")
  lines.push("- A tool call may need the user's approval. If one is refused, do not try to reach the same end another way; say what you could not do.")
  if (input.mode === "plan") {
    lines.push("", "# Plan mode", "You are planning, not changing anything. You have no tool that edits files or runs commands. Investigate with the read-only tools, then answer with a concrete plan: the files to change, what changes in each, and how to check the result.")
  }
  lines.push("", "# Answers")
  lines.push("- Be brief and specific. Lead with what you did or found; leave out preamble and praise.")
  lines.push("- Name files by their path, and quote code in fenced blocks with the language.")
  lines.push("- End with what was changed and how it was checked, or with what is still open. Say plainly when something was not verified.")
  if (input.family === "openai") lines.push("- Keep going until the task is fully handled before you end your turn. Do not stop to ask whether to continue with a step that only reads or checks.")
  if (input.family === "generic") lines.push("- Use the tool-calling interface for every tool call. Never write a tool call as text in your answer.")
  lines.push("", "# Environment", ...environmentLines(input.environment))
  lines.push("", "Project instruction files and the user's own instructions, when present below, take precedence over the guidance above.")
  return lines.join("\n")
}

function environmentLines(environment: PromptEnvironment): string[] {
  const git = environment.git
  const changes = git?.changedFiles === undefined ? "" : git.changedFiles === 0 ? ", no uncommitted changes" : `, ${git.changedFiles} file${git.changedFiles === 1 ? "" : "s"} with uncommitted changes`
  return [
    `- Working folder: ${oneLine(environment.cwd)}`,
    ...((environment.folders ?? []).length === 0 ? [] : [`- Related folders: ${(environment.folders ?? []).map(oneLine).join(", ")}`]),
    git === undefined ? "- Git: not a git repository" : `- Git: ${git.branch === undefined ? "no branch checked out" : `branch ${oneLine(git.branch)}`}${changes} (when this session started)`,
    `- Platform: ${oneLine(environment.platform)}`,
    `- Date: ${environment.date}`,
  ]
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\0]/g, " ").slice(0, 1_024)
}

/** Local calendar date as `YYYY-MM-DD`. */
export function localDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The default prompt, then the project context, within the size bound. */
export function assembleSystemPrompt(prompt: string, context: string): string {
  const text = context.length === 0 ? prompt : `${prompt}\n\n# Project context\n${context}`
  if (text.length <= MAX_SYSTEM_PROMPT_CHARS) return text
  let end = MAX_SYSTEM_PROMPT_CHARS - CUT_NOTE.length
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${text.slice(0, end)}${CUT_NOTE}`
}

export interface SystemPromptSource {
  /** The instructions for a request that offers `tools`. */
  text(tools: readonly string[]): string
}

/**
 * Hands the instructions to a port that takes them as a field of their own (`system`), which a
 * provider sends as its system prompt. The conversation itself is left as it is.
 */
export function createSystemPromptModelPort(inner: NativeModelPort, source: SystemPromptSource): NativeModelPort & { takeUsage(): unknown } {
  return {
    complete(request: NativeModelRequest) {
      const system = source.text(request.tools.map((tool) => tool.name))
      return inner.complete(system.length === 0 ? request : ({ ...request, system } as NativeModelRequest))
    },
    takeUsage(): unknown {
      const port = inner as { takeUsage?: unknown }
      return typeof port.takeUsage === "function" ? (port.takeUsage as () => unknown).call(inner) : undefined
    },
  }
}

/** Builds the instructions once per set of tools, so the text is the same from request to request. */
export function createSystemPromptSource(input: Omit<DefaultPromptInput, "tools">, context: () => string): SystemPromptSource {
  let key: string | undefined
  let prompt = ""
  return {
    text(tools) {
      const next = tools.join("\n")
      if (next !== key) {
        key = next
        prompt = defaultCodingPrompt({ ...input, tools })
      }
      return assembleSystemPrompt(prompt, context())
    },
  }
}
