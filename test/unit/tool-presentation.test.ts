import { expect, test } from "bun:test"
import { boundToolInput } from "../../src/harness/tool-input.ts"
import { mapClaudeCodeEvent, mapCodexEvent } from "../../src/harness/mappers.ts"
import type { HarnessEventMappingContext } from "../../src/harness/types.ts"
import { describeToolCall, presentControlEvent, type ToolPresentationIntent } from "../../src/tools/presentation.ts"

test("Codex and Claude agent messages expose bounded text and recipients without spawning agents", () => {
  expect(describeToolCall("collabAgentToolCall", { tool: "sendInput", receiverThreadIds: ["agent-a"], prompt: "Review the parser" })).toMatchObject({ kind: "other", title: "Message agent: agent-a", content: "Review the parser" })
  expect(describeToolCall("SendMessage", { recipient: "Reviewer", content: "Checks passed" })).toMatchObject({ kind: "other", title: "Message agent: Reviewer", content: "Checks passed" })
  const large = describeToolCall("send_message", { target: "Parser", message: "x".repeat(40_000) })
  expect(large.truncated).toBe(true)
  expect(large.content?.length).toBeLessThanOrEqual(16 * 1024)
})

test("classifies native, Claude Code, Codex, pi, and MCP tool calls", () => {
  const cases: readonly [string, unknown, Record<string, unknown>][] = [
    ["read_file", { path: "src/a.ts" }, { kind: "read", path: "src/a.ts", title: "Read src/a.ts" }],
    ["Read", { file_path: "/repo/src/a.ts" }, { kind: "read", path: "/repo/src/a.ts" }],
    ["write_file", { path: "b.ts", content: "x\n" }, { kind: "write", path: "b.ts", content: "x\n" }],
    ["edit_file", { path: "c.ts", oldText: "a", newText: "b" }, { kind: "edit", edits: [{ oldText: "a", newText: "b" }] }],
    ["MultiEdit", { file_path: "d.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] }, { kind: "edit", edits: [{ oldText: "1", newText: "2" }, { oldText: "3", newText: "4" }] }],
    ["apply_patch", { path: "e.ts", content: "y" }, { kind: "patch", path: "e.ts", title: "Patch e.ts" }],
    ["file_change", { type: "fileChange", changes: [{ path: "f.ts", kind: "update" }, { path: "g.ts", kind: "add" }] }, { kind: "patch", paths: ["f.ts", "g.ts"], title: "Patch 2 files" }],
    ["run_command", { program: "bun", args: ["test", "a b"] }, { kind: "shell", command: "bun test 'a b'", title: "Run bun test 'a b'" }],
    ["Bash", { command: "ls -la\nwc -l x" }, { kind: "shell", command: "ls -la wc -l x" }],
    ["bun test", { type: "command_execution", command: "bun test" }, { kind: "shell", command: "bun test" }],
    ["command", { type: "commandExecution", command: ["git", "status"] }, { kind: "shell", command: "git status" }],
    ["Grep", { pattern: "TODO", path: "src" }, { kind: "search", query: "TODO", path: "src", title: "Search TODO in src" }],
    ["find_files", { pattern: "*.ts" }, { kind: "search", query: "*.ts" }],
    ["ls", { path: "src" }, { kind: "list", path: "src" }],
    ["WebFetch", { url: "https://user:pass@example.com/docs?q=1" }, { kind: "web", url: "https://example.com/docs?q=1" }],
    ["WebSearch", { query: "bun spawn" }, { kind: "web", query: "bun spawn", title: "Search web bun spawn" }],
    ["Task", { description: "explore", subagent_type: "Explore" }, { kind: "agent" }],
    ["TodoWrite", { todos: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }, { content: "three" }] }, { kind: "plan", plan: [{ text: "one", status: "completed" }, { text: "two", status: "in_progress" }, { text: "three", status: "pending" }] }],
    ["todo_list", { items: [{ text: "x", completed: true }] }, { kind: "plan", plan: [{ text: "x", status: "completed" }] }],
    ["run_verification", {}, { kind: "verify", title: "Verify" }],
    ["mcp__github__create_issue", { title: "x" }, { kind: "mcp", server: "github", tool: "create_issue", title: "github.create_issue" }],
    ["lookup", { type: "mcpToolCall", server: "docs", tool: "search" }, { kind: "mcp", server: "docs", tool: "search" }],
    ["custom_tool", { anything: 1 }, { kind: "other", title: "custom_tool" }],
    ["AskUserQuestion", { questions: [{ question: "Which library\nshould we use?", header: "Library", options: [] }, { question: "Second?" }] }, { kind: "other", title: "Ask: Which library should we use?" }],
    ["AskUserQuestion", { questions: [] }, { kind: "other", title: "Ask a question" }],
    ["ExitPlanMode", { plan: "# Fix the parser\n\n1. Skip blank lines" }, { kind: "plan", title: "Proposed plan", content: "# Fix the parser\n\n1. Skip blank lines" }],
  ]
  for (const [name, input, expected] of cases) expect({ name, value: describeToolCall(name, input) }).toMatchObject({ name, value: expected })
})

test("presentation omits previews for credential files and rejects unsafe values", () => {
  const sensitiveWrite = describeToolCall("write_file", { path: "config/.env", content: "TOKEN=secret-value" })
  expect(sensitiveWrite).toMatchObject({ kind: "write", path: "config/.env" })
  expect(sensitiveWrite.content).toBeUndefined()
  expect(describeToolCall("Edit", { file_path: "keys/server.pem", old_string: "a", new_string: "b" }).edits).toBeUndefined()
  expect(describeToolCall("WebFetch", { url: "javascript:alert(1)" }).url).toBeUndefined()
  expect(describeToolCall("WebFetch", { url: "file:///etc/passwd" }).url).toBeUndefined()
  expect(describeToolCall("read_file", { path: "a\nb" }).path).toBeUndefined()
  expect(describeToolCall("read_file", { path: "x".repeat(2_000) }).path).toBeUndefined()
  expect(describeToolCall("read_file", "not an object")).toMatchObject({ kind: "read", title: "Read", truncated: false })
  expect(describeToolCall("read_file", null).path).toBeUndefined()
})

test("presentation bounds previews, lists, commands, and titles", () => {
  const big = describeToolCall("write_file", { path: "big.txt", content: "é".repeat(20_000) })
  expect(big.truncated).toBe(true)
  expect(Buffer.byteLength(big.content ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024)
  const edits = describeToolCall("MultiEdit", { file_path: "m.ts", edits: Array.from({ length: 40 }, (_, index) => ({ old_string: `o${index}`, new_string: `n${index}` })) })
  expect(edits.edits).toHaveLength(16)
  expect(edits.truncated).toBe(true)
  const paths = describeToolCall("file_change", { changes: Array.from({ length: 50 }, (_, index) => ({ path: `f${index}.ts` })) })
  expect(paths.paths).toHaveLength(32)
  expect(paths.truncated).toBe(true)
  const command = describeToolCall("Bash", { command: "echo ".repeat(1_000) })
  expect(command.command?.length).toBeLessThanOrEqual(2_048)
  expect(command.truncated).toBe(true)
  expect(command.title.length).toBeLessThanOrEqual(160)
  const plan = describeToolCall("TodoWrite", { todos: Array.from({ length: 80 }, (_, index) => ({ content: `step ${index}` })) })
  expect(plan.plan).toHaveLength(64)
})

test("presentControlEvent adds presentation to tool starts only and leaves the source event unchanged", () => {
  const started = Object.freeze({ version: 1 as const, sessionId: "s", seq: 1, at: 1, type: "tool.started" as const, turnId: "t", callId: "c", name: "read_file", input: { path: "a.ts" } })
  const presented = presentControlEvent(started)
  expect(presented).toMatchObject({ callId: "c", presentation: { kind: "read", path: "a.ts" } })
  expect("presentation" in started).toBe(false)
  const message = Object.freeze({ version: 1 as const, sessionId: "s", seq: 2, at: 2, type: "assistant.message" as const, turnId: "t", text: "hi" })
  expect(presentControlEvent(message)).toBe(message)
})

test("boundToolInput copies plain JSON within limits", () => {
  expect(boundToolInput({ a: [1, "x", true, null], b: { c: "d" } })).toEqual({ a: [1, "x", true, null], b: { c: "d" } })
  expect(boundToolInput({ f: () => 1, n: Number.NaN, d: new Date(0), ok: 1 })).toEqual({ ok: 1 })
  const long = boundToolInput({ text: "a".repeat(40_000) }) as { text: string }
  expect(long.text.length).toBe(16 * 1024)
  const wide = boundToolInput(Array.from({ length: 500 }, (_, index) => index)) as unknown[]
  expect(wide).toHaveLength(128)
  const deep = boundToolInput({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })
  expect(JSON.stringify(deep)).toBe('{"a":{"b":{"c":{"d":{"e":{}}}}}}')
  const total = boundToolInput(Array.from({ length: 20 }, () => "z".repeat(10_000)))
  expect(Buffer.byteLength(JSON.stringify(total), "utf8")).toBeLessThanOrEqual(64 * 1024 + 256)
  const polluted = boundToolInput(JSON.parse('{"__proto__":{"polluted":true},"ok":1}')) as Record<string, unknown>
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(polluted.ok).toBe(1)
})

test("harness mappers forward bounded tool input", () => {
  const previous = { version: 1 as const, id: "session", backend: "harness", cwd: "/tmp", status: "idle" as const, createdAt: 1, updatedAt: 1, lastSeq: 0, capabilities: [] }
  const context = (): HarnessEventMappingContext => ({ sessionId: "session", cwd: "/tmp", backend: "harness", nextSeq: 1, previous })
  const claude = mapClaudeCodeEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "src/a.ts" } }] } }, context())
  expect(claude).toMatchObject({ type: "tool.started", callId: "tu1", name: "Read", input: { file_path: "src/a.ts" } })
  expect(presentControlEvent(claude as never)).toMatchObject({ presentation: { kind: "read", path: "src/a.ts" } })
  const codex = mapCodexEvent({ type: "item.started", item: { id: "i1", type: "command_execution", command: "bun test" } }, context())
  expect(codex).toMatchObject({ type: "tool.started", callId: "i1", input: { type: "command_execution", command: "bun test" } })
  expect(presentControlEvent(codex as never)).toMatchObject({ presentation: { kind: "shell", command: "bun test" } })
})

test("a coding tool's file changes read relative to the workspace, with line counts and a one-file diff", () => {
  const root = "/work/app"
  const added = describeToolCall("file_change", { type: "fileChange", changes: [{ path: "/work/app/notes/a.txt", kind: { type: "add" }, diff: "one\ntwo\n" }] }, { root })
  expect(added).toMatchObject({ kind: "patch", paths: ["notes/a.txt"], additions: 2, deletions: 0, content: "@@ -0,0 +1,2 @@\n+one\n+two\n" })
  expect(added.title).toBe("Patch notes/a.txt")
  const updated = describeToolCall("file_change", { changes: [{ path: "/work/app/b.ts", kind: { type: "update" }, diff: "--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n" }] }, { root })
  expect(updated).toMatchObject({ paths: ["b.ts"], additions: 1, deletions: 1 })
  expect(updated.content).toContain("@@ -1,2 +1,2 @@")
  const removed = describeToolCall("file_change", { changes: [{ path: "/work/app/c.ts", kind: "delete", diff: "x\n" }] }, { root })
  expect(removed).toMatchObject({ paths: ["c.ts"], additions: 0, deletions: 1, content: "@@ -1,1 +0,0 @@\n-x\n" })
  const several = describeToolCall("file_change", { changes: [{ path: "/work/app/a", kind: { type: "add" }, diff: "1\n" }, { path: "/elsewhere/b", kind: { type: "delete" }, diff: "2\n3\n" }] }, { root })
  expect(several).toMatchObject({ paths: ["a", "/elsewhere/b"], additions: 1, deletions: 2 })
  expect(several.content).toBeUndefined()
})

test("file change counts and previews stay out when the change is unclear or sensitive", () => {
  const root = "/work/app"
  expect(describeToolCall("file_change", { changes: [{ path: "/work/app/a", kind: { type: "rename" }, diff: "1\n" }] }, { root })).not.toHaveProperty("additions")
  expect(describeToolCall("file_change", { changes: [{ path: "/work/app/a", kind: { type: "add" } }] }, { root })).not.toHaveProperty("additions")
  const secret = describeToolCall("file_change", { changes: [{ path: "/work/app/.env", kind: { type: "add" }, diff: "TOKEN=secret-value\n" }] }, { root })
  expect(secret.content).toBeUndefined()
  expect(JSON.stringify(secret)).not.toContain("secret-value")
  expect(describeToolCall("file_change", { changes: [{ path: "/work/application/x", kind: { type: "add" }, diff: "1\n" }] }, { root }).paths).toEqual(["/work/application/x"])
  expect(describeToolCall("read_file", { path: "/work/app" }, { root: "/work/app/" }).path).toBe(".")
  expect(describeToolCall("read_file", { path: "/work/app/x" }).path).toBe("/work/app/x")
})

test("a listing or search of the workspace root names no path in its title", () => {
  expect(describeToolCall("list_files", { path: "." }).title).toBe("List files")
  expect(describeToolCall("list_files", { path: "/work/app" }, { root: "/work/app" }).title).toBe("List files")
  expect(describeToolCall("search_files", { path: ".", query: "TODO" }).title).toBe("Search TODO")
  expect(describeToolCall("list_files", { path: "src" }).title).toBe("List src")
})

test("browser tools read as page actions on every route, and typed text never shows", () => {
  expect(describeToolCall("browser_open", { url: "http://user:pw@localhost:5173/app" })).toEqual({ kind: "web", url: "http://localhost:5173/app", title: "Open http://localhost:5173/app", truncated: false })
  expect(describeToolCall("mcp__runrail_browser__browser_click", { ref: "e12" })).toMatchObject({ kind: "web", title: "Click e12" })
  expect(describeToolCall("browser_type", { ref: "e3", text: "hunter2" }).title).toBe("Type into e3")
  expect(JSON.stringify(describeToolCall("browser_type", { ref: "e3", text: "hunter2" }))).not.toContain("hunter2")
  expect(describeToolCall("browser_eval", { expression: "document.cookie" })).toMatchObject({ title: "Run script in the page" })
  expect(describeToolCall("browser_open", { url: "javascript:alert(1)" })).toMatchObject({ title: "Open a page" })
  expect(describeToolCall("mcp__runrail_browser__browser_network", {})).toMatchObject({ kind: "web", title: "Read network requests" })
  expect(describeToolCall("browser_screenshot", { width: "phone" })).toMatchObject({ kind: "web", title: "Look at the page on a phone" })
  expect(describeToolCall("browser_screenshot", { width: "<b>" }).title).toBe("Look at the page")
})

test("computer tools name the app they act on, and typed text never shows", () => {
  expect(describeToolCall("computer_click", { app: "Notes", x: 10, y: 20 })).toEqual({ kind: "other", title: "Click in Notes", truncated: false })
  expect(describeToolCall("mcp__runrail_computer__computer_key", { app: "Notes", key: "Return" }).title).toBe("Press Return in Notes")
  expect(JSON.stringify(describeToolCall("computer_type", { app: "Notes", text: "my secret note" }))).not.toContain("secret")
  expect(describeToolCall("computer_screenshot", {}).title).toBe("Look at an app")
  expect(describeToolCall("computer_apps", {}).title).toBe("List the apps it may use")
})

test("shell and verification calls name their intent when the command's status is that work's", () => {
  const cases: readonly [string, unknown, ToolPresentationIntent][] = [
    ["Bash", { command: "bun test" }, "test"],
    ["Bash", { command: "npm test" }, "test"],
    ["Bash", { command: "npm run test" }, "test"],
    ["Bash", { command: "pnpm test" }, "test"],
    ["Bash", { command: "yarn test" }, "test"],
    ["Bash", { command: "pytest -q tests/" }, "test"],
    ["Bash", { command: "go test ./..." }, "test"],
    ["Bash", { command: "cargo test" }, "test"],
    ["Bash", { command: "vitest run src" }, "test"],
    ["Bash", { command: "npx jest --ci" }, "test"],
    ["Bash", { command: "python -m pytest" }, "test"],
    ["Bash", { command: "bun run test:unit" }, "test"],
    ["Bash", { command: "CI=1 bun test 2>&1" }, "test"],
    ["Bash", { command: "bun test > out.txt 2>&1" }, "test"],
    ["Bash", { command: "cd '/work/my app' && bun test" }, "test"],
    ["Bash", { command: "bun run build" }, "build"],
    ["Bash", { command: "cargo build --release" }, "build"],
    ["Bash", { command: "pnpm lint" }, "lint"],
    ["Bash", { command: "npx eslint ." }, "lint"],
    ["Bash", { command: "bun run typecheck" }, "typecheck"],
    ["Bash", { command: "tsc --noEmit" }, "typecheck"],
    ["Bash", { command: "git commit -m 'fix: one thing'" }, "commit"],
    ["Bash", { command: "git -C /work/app push origin main" }, "push"],
    ["Bash", { command: "gh pr create --fill" }, "pr"],
    ["run_command", { program: "bun", args: ["test"] }, "test"],
    ["command", { type: "commandExecution", command: "/bin/zsh -lc 'cd /work/app && bun test'" }, "test"],
    ["command", { type: "commandExecution", command: ["bash", "-lc", "npm run lint"] }, "lint"],
    ["run_verification", { name: "test" }, "test"],
  ]
  for (const [name, input, intent] of cases) expect({ input, intent: describeToolCall(name, input).intent }).toEqual({ input, intent })
})

test("an intent stays out when the status could belong to something else", () => {
  const cases: readonly [string, unknown][] = [
    ["Bash", { command: "echo bun test" }],
    ["Bash", { command: "cat test.log" }],
    ["Bash", { command: "bun test; rm -rf x" }],
    ["Bash", { command: "bun test || true" }],
    ["Bash", { command: "bun test 2>&1 | tail -20" }],
    ["Bash", { command: "bun test && rm -rf x" }],
    ["Bash", { command: "cd app && bun test && echo ok" }],
    ["Bash", { command: "bun test &" }],
    ["Bash", { command: "bun test\nrm -rf x" }],
    ["Bash", { command: "$(echo bun) test" }],
    ["Bash", { command: "`bun test`" }],
    ["Bash", { command: "! bun test" }],
    ["Bash", { command: "(bun test)" }],
    ["Bash", { command: "bun \"$TASK\"" }],
    ["Bash", { command: "bun test <<EOF" }],
    ["Bash", { command: "bun test >" }],
    ["Bash", { command: "bun test 'unterminated" }],
    ["Bash", { command: "bun test --watch" }],
    ["Bash", { command: "npm run test:watch" }],
    ["Bash", { command: "tsc -w" }],
    ["Bash", { command: "test -f package.json" }],
    ["Bash", { command: "git add -A && git commit -m x" }],
    ["Bash", { command: "git commit -m \"$(cat <<'EOF'\nmessage\nEOF\n)\"" }],
    ["Bash", { command: "gh pr view 12" }],
    ["Bash", { command: "npx -y vitest" }],
    ["Bash", { command: `bun test ${"x".repeat(3_000)}` }],
    ["Bash", { command: "bun test", run_in_background: true }],
    ["run_command", { program: "bun", args: ["test"], background: true }],
    ["run_command", { program: "bun", args: ["test; rm -rf x"] }],
    ["command", { command: "bash -c \"bash -c 'bun test'\"" }],
    ["run_verification", { name: "check" }],
    ["run_verification", {}],
    ["Read", { file_path: "bun test" }],
  ]
  for (const [name, input] of cases) expect({ input, intent: describeToolCall(name, input).intent }).toEqual({ input, intent: undefined })
})

test("a harness test run's start carries its intent to control clients", () => {
  const previous = { version: 1 as const, id: "session", backend: "harness", cwd: "/tmp", status: "idle" as const, createdAt: 1, updatedAt: 1, lastSeq: 0, capabilities: [] }
  const codex = mapCodexEvent({ type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc 'bun test'" } }, { sessionId: "session", cwd: "/tmp", backend: "harness", nextSeq: 1, previous })
  expect(presentControlEvent(codex as never)).toMatchObject({ presentation: { kind: "shell", intent: "test" } })
})

test("a command that only wraps a script, as Codex runs every one, is named by its script", () => {
  const curl = `curl -sSI -o /dev/null -w "%{http_code}" https://example.com`
  // A real Codex 0.160 app-server commandExecution item.
  expect(describeToolCall("command", { type: "commandExecution", command: `/bin/zsh -lc '${curl}'` })).toMatchObject({ kind: "shell", command: curl, title: `Run ${curl}` })
  const wrapped: readonly [unknown, string][] = [
    // Codex quotes each stretch of a script the way that stretch allows.
    [`/bin/zsh -lc "python3 -c 'print(\\"hi\\")'"`, `python3 -c 'print("hi")'`],
    [`/bin/zsh -lc "echo '"'$HOME'"'"`, "echo '$HOME'"],
    ["/bin/zsh -lc ls", "ls"],
    ["bash -lc 'bun test'", "bun test"],
    [["/bin/bash", "-c", "it's done"], "it's done"],
  ]
  for (const [command, script] of wrapped) expect({ command, shown: describeToolCall("command", { command }).command }).toEqual({ command, shown: script })
  const heredoc = describeToolCall("command", { command: `/bin/zsh -lc 'cat > notes.md <<EOF\n${"line\n".repeat(600)}EOF'` })
  expect(heredoc.title).toStartWith("Run cat > notes.md <<EOF line line")
  expect(heredoc.truncated).toBe(true)
  const kept = [
    "sh -c 'echo $0' name",
    "bash -c 'bun test' > out.txt",
    "bash -c 'bun test' && rm -rf x",
    "bash -c \"echo $HOME\"",
    "FOO=1 bash -c 'bun test'",
    "bash -c ''",
    "python3 -c 'print(1)'",
  ]
  for (const command of kept) expect(describeToolCall("Bash", { command }).command).toBe(command)
})

test("a tool named like an Object method is described, not thrown on", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    expect(describeToolCall(name, {})).toMatchObject({ kind: "other" })
    expect(describeToolCall("tool", { type: name })).toMatchObject({ kind: "other" })
  }
})
