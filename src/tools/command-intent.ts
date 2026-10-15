/**
 * What a shell or verification call is for, read only where the call's exit status is plainly
 * that work's status: one simple command, optionally after `cd <dir> &&`. Chains, pipes,
 * substitutions, background runs, and anything this reader does not follow have no intent.
 */
export const COMMAND_INTENTS = ["test", "build", "lint", "typecheck", "commit", "push", "pr"] as const
export type CommandIntent = (typeof COMMAND_INTENTS)[number]

const MAX_SOURCE = 2_048
// A wrapper's script can be a whole heredoc, longer than any line read for its intent.
const MAX_WRAPPED_SOURCE = 64 * 1024
const MAX_ARGV = 64

/** A shell word, or `null` when expansion decides its value (`$X`, globs, braces). */
type Word = string | null
const AND = Symbol("&&")
type Token = Word | typeof AND

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash"])
const RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx", "uvx"])
const TWO_WORD_RUNNERS: ReadonlySet<string> = new Set([
  "pnpm exec", "pnpm dlx", "npm exec", "yarn exec", "yarn dlx", "bun x",
  "uv run", "poetry run", "pdm run", "pipenv run", "bundle exec", "python -m", "python3 -m",
])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SCRIPT_INTENTS: ReadonlyMap<string, CommandIntent> = new Map([
  ["test", "test"], ["tests", "test"], ["build", "build"], ["lint", "lint"],
  ["typecheck", "typecheck"], ["type-check", "typecheck"], ["check-types", "typecheck"], ["tsc", "typecheck"],
])

export function commandIntent(input: Record<string, unknown>): CommandIntent | undefined {
  // A background run returns once it starts; its status says nothing about the work.
  if (input.background === true || input.run_in_background === true) return undefined
  if (typeof input.command === "string") return shellIntent(input.command, false)
  if (Array.isArray(input.command)) return argvIntent(input.command)
  if (typeof input.cmd === "string") return shellIntent(input.cmd, false)
  if (typeof input.program === "string") return argvIntent([input.program, ...(Array.isArray(input.args) ? input.args : [])])
  return undefined
}

/** The script of a command that is only `sh -c '<script>'` or `/bin/zsh -lc '<script>'`, with its quoting undone. */
export function wrappedScript(command: string): string | undefined {
  const tokens = shellTokens(command, MAX_WRAPPED_SOURCE, false)
  if (tokens === undefined || !tokens.every((token): token is Word => token !== AND)) return undefined
  const script = shellScript(tokens)
  return script === undefined || script.trim().length === 0 ? undefined : script
}

function argvIntent(argv: readonly unknown[]): CommandIntent | undefined {
  if (argv.length === 0 || argv.length > MAX_ARGV) return undefined
  const words: string[] = []
  for (const part of argv) {
    if (typeof part !== "string" || part.length > MAX_SOURCE) return undefined
    words.push(part)
  }
  const script = shellScript(words)
  return script === undefined ? wordsIntent(words) : shellIntent(script, true)
}

function shellIntent(source: string, nested: boolean): CommandIntent | undefined {
  const tokens = shellTokens(source)
  const words = tokens === undefined ? undefined : simpleCommand(tokens)
  if (words === undefined) return undefined
  let start = 0
  while (start < words.length && ASSIGNMENT.test(words[start] ?? "")) start += 1
  const command = words.slice(start)
  const script = nested ? undefined : shellScript(command)
  return script === undefined ? wordsIntent(command) : shellIntent(script, true)
}

/** The words of `<command>` or `cd <dir> && <command>`. */
function simpleCommand(tokens: readonly Token[]): readonly Word[] | undefined {
  const and = tokens.indexOf(AND)
  if (and >= 0 && !(and === 2 && tokens[0] === "cd")) return undefined
  const tail = tokens.slice(and + 1)
  const words = tail.filter((token): token is Word => token !== AND)
  return words.length > 0 && words.length === tail.length ? words : undefined
}

/** `sh -c '<script>'` and `/bin/zsh -lc '<script>'`, the way Codex runs every command. */
function shellScript(words: readonly Word[]): string | undefined {
  if (words.length !== 3) return undefined
  const [shell, flag, script] = words
  if (shell === null || shell === undefined || !SHELLS.has(basename(shell))) return undefined
  return (flag === "-c" || flag === "-lc" || flag === "-cl") && typeof script === "string" ? script : undefined
}

function wordsIntent(words: readonly Word[]): CommandIntent | undefined {
  const command = withoutRunner(words)
  // A watch run does not end, so its status never says the work passed.
  if (command === undefined || command.some((word) => word?.startsWith("--watch") === true)) return undefined
  const [program, ...args] = command
  return typeof program === "string" ? toolIntent(basename(program), args) : undefined
}

/** `npx vitest` and `uv run pytest` are the tool they run. */
function withoutRunner(words: readonly Word[]): readonly Word[] | undefined {
  const [first, second] = words
  const skip = typeof first !== "string" ? 0 : RUNNERS.has(first) ? 1 : typeof second === "string" && TWO_WORD_RUNNERS.has(`${first} ${second}`) ? 2 : 0
  const rest = words.slice(skip)
  // A runner's own options (`npx -y`, `uv run --with x`) could put anything next.
  return skip > 0 && (typeof rest[0] !== "string" || rest[0].startsWith("-")) ? undefined : rest
}

function toolIntent(name: string, args: readonly Word[]): CommandIntent | undefined {
  const [sub, next] = args
  switch (name) {
    case "npm":
      return sub === "test" || sub === "t" ? "test" : sub === "run" || sub === "run-script" ? scriptIntent(next) : undefined
    case "pnpm":
    case "yarn":
      return scriptIntent(sub === "run" ? next : sub)
    case "bun":
      return sub === "test" ? "test" : sub === "build" ? "build" : scriptIntent(sub === "run" ? next : sub)
    case "deno":
      return sub === "test" ? "test" : sub === "lint" ? "lint" : sub === "check" ? "typecheck" : sub === "task" ? scriptIntent(next) : undefined
    case "make":
    case "just":
      return scriptIntent(sub)
    case "go":
      return sub === "test" ? "test" : sub === "build" ? "build" : sub === "vet" ? "lint" : undefined
    case "cargo":
      return sub === "test" || sub === "t" || (sub === "nextest" && next === "run") ? "test"
        : sub === "build" || sub === "b" ? "build"
        : sub === "check" || sub === "c" ? "typecheck"
        : sub === "clippy" ? "lint"
        : undefined
    case "dotnet":
    case "swift":
    case "gradle":
    case "gradlew":
      return sub === "test" ? "test" : sub === "build" ? "build" : undefined
    case "mvn":
    case "mix":
      return sub === "test" ? "test" : undefined
    case "pytest":
    case "py.test":
    case "unittest":
    case "jest":
    case "mocha":
    case "ava":
    case "rspec":
    case "phpunit":
    case "ctest":
      return "test"
    case "vitest":
      return sub === undefined || (typeof sub === "string" && !["watch", "dev", "bench", "init", "list"].includes(sub)) ? "test" : undefined
    case "playwright":
      return sub === "test" ? "test" : undefined
    case "cypress":
      return sub === "run" ? "test" : undefined
    case "tsc":
    case "vue-tsc":
      return args.some((arg) => arg === "-w" || arg === "--init" || arg === "-v" || arg === "--version" || arg === "-h" || arg === "--help" || arg === "--showConfig") ? undefined : "typecheck"
    case "svelte-check":
    case "mypy":
    case "pyright":
      return "typecheck"
    case "eslint":
    case "oxlint":
    case "flake8":
    case "pylint":
    case "stylelint":
    case "rubocop":
    case "shellcheck":
      return "lint"
    case "biome":
      return sub === "lint" || sub === "check" || sub === "ci" ? "lint" : undefined
    case "ruff":
      return sub === "check" ? "lint" : undefined
    case "golangci-lint":
      return sub === "run" ? "lint" : undefined
    case "vite":
    case "next":
    case "nuxt":
    case "astro":
      return sub === "build" ? "build" : undefined
    case "git":
      return gitIntent(args)
    case "gh":
      return sub === "pr" && next === "create" ? "pr" : undefined
    case "glab":
      return sub === "mr" && next === "create" ? "pr" : undefined
    default:
      return undefined
  }
}

/** A package script or make target by its usual name; `test:unit` counts as `test`. */
function scriptIntent(name: Word | undefined): CommandIntent | undefined {
  if (typeof name !== "string" || name.includes("watch")) return undefined
  return SCRIPT_INTENTS.get(name) ?? SCRIPT_INTENTS.get(name.split(":")[0] ?? "")
}

/** `git commit` and `git push`, also after `-C <dir>`, `-c <key=value>`, or `--no-pager`. */
function gitIntent(args: readonly Word[]): CommandIntent | undefined {
  let index = 0
  while (args[index] === "-C" || args[index] === "-c" || args[index] === "--no-pager") index += args[index] === "--no-pager" ? 1 : 2
  const sub = args[index]
  return sub === "commit" ? "commit" : sub === "push" ? "push" : undefined
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

/**
 * Splits a shell line into words and `&&`. Redirections (`2>&1`, `> out.txt`) are dropped: they
 * do not change the exit status. Any other operator, a substitution, a comment, a heredoc, or
 * an unquoted line break makes the line unreadable here, and so does a redirection when
 * `redirections` is false.
 */
function shellTokens(source: string, max = MAX_SOURCE, redirections = true): readonly Token[] | undefined {
  const line = source.trim()
  if (line.length === 0 || line.length > max) return undefined
  const tokens: Token[] = []
  let word: string | undefined
  let quoted = false
  let dynamic = false
  // The next word names where a redirection goes, not an argument.
  let target = false
  const end = (): void => {
    if (word === undefined) return
    if (target) target = false
    else tokens.push(dynamic ? null : word)
    word = undefined
    quoted = false
    dynamic = false
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    const next = line[index + 1]
    if (char === " " || char === "\t") {
      end()
    } else if (char === "'") {
      const close = line.indexOf("'", index + 1)
      if (close < 0) return undefined
      word = (word ?? "") + line.slice(index + 1, close)
      quoted = true
      index = close
    } else if (char === "\"") {
      const part = doubleQuoted(line, index + 1)
      if (part === undefined) return undefined
      word = (word ?? "") + part.text
      quoted = true
      dynamic ||= part.dynamic
      index = part.close
    } else if (char === "\\") {
      if (next === undefined || next === "\n" || next === "\r") return undefined
      word = (word ?? "") + next
      quoted = true
      index += 1
    } else if (char === "&" && next === "&") {
      end()
      if (target) return undefined
      tokens.push(AND)
      index += 1
    } else if (char === ">" || char === "<" || (char === "&" && next === ">")) {
      if (!redirections) return undefined
      // `2>`: the digits name the stream, not an argument.
      if (word !== undefined && !quoted && !dynamic && char !== "&" && /^\d$/.test(word)) word = undefined
      else end()
      if (target) return undefined
      const close = redirection(line, index)
      if (close === undefined) return undefined
      target = close.target
      index = close.end
    } else if (char === "#" && word === undefined) {
      return undefined
    } else if (";|&()`!\n\r".includes(char) || (char === "$" && next === "(")) {
      return undefined
    } else {
      if ("$*?[]{}~=".includes(char) && (char !== "=" || word === undefined)) dynamic = true
      word = (word ?? "") + char
    }
  }
  end()
  return target ? undefined : tokens
}

/** The text of a double-quoted part starting at `start`, and the index of its closing quote. */
function doubleQuoted(line: string, start: number): { readonly text: string; readonly close: number; readonly dynamic: boolean } | undefined {
  let text = ""
  let dynamic = false
  for (let index = start; index < line.length; index += 1) {
    const char = line[index]!
    const next = line[index + 1]
    if (char === "\"") return { text, close: index, dynamic }
    if (char === "`" || (char === "$" && next === "(")) return undefined
    if (char === "$") dynamic = true
    if (char === "\\" && next !== undefined && "\"\\$`".includes(next)) {
      text += next
      index += 1
      continue
    }
    if (char === "\\" && (next === "\n" || next === "\r")) return undefined
    text += char
  }
  return undefined
}

/**
 * A redirection operator at `start`: where it ends, and whether a target word follows. `>&2` and
 * `2>&1` name a stream; process substitution, heredocs, and `<>` are not read.
 */
function redirection(line: string, start: number): { readonly end: number; readonly target: boolean } | undefined {
  const rest = line.slice(start, start + 3)
  if (rest.startsWith("&>>")) return { end: start + 2, target: true }
  if (rest.startsWith("&>")) return { end: start + 1, target: true }
  if (rest.startsWith(">>")) return line[start + 2] === "(" ? undefined : { end: start + 1, target: true }
  if (rest.startsWith(">&") || rest.startsWith("<&")) {
    const stream = /^(?:\d+|-)/.exec(line.slice(start + 2))
    if (stream !== null) return { end: start + 1 + stream[0].length, target: false }
    return rest.startsWith(">&") ? { end: start + 1, target: true } : undefined
  }
  if (rest.startsWith(">|") || rest.startsWith("<<") || rest.startsWith("<>") || rest.startsWith(">(") || rest.startsWith("<(")) return undefined
  return { end: start, target: true }
}
